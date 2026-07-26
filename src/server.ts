import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { AgentError } from "./types.js";
import { AGENT_VERSION } from "./version.js";

export type RouteHandler = (
  req: IncomingMessage,
  params: Record<string, string>,
  body: unknown,
) => Promise<unknown>;

export interface Route {
  method: "GET" | "POST" | "DELETE";
  /** `/runs/:id` — `:name` segments become params. */
  path: string;
  handler: RouteHandler;
}

export interface ServerOptions {
  token: string;
  /** Read lazily: the port is only known after listen(0) in tests. */
  getPort: () => number;
  routes: Route[];
  /** Extra fields for the authenticated /health payload. */
  health?: () => Record<string, unknown>;
  /** Applied to every response body — masks secrets. */
  mask?: (value: unknown) => unknown;
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/** Token + Host + Origin. Returns a status/message when the request must be refused. */
export function guard(
  req: IncomingMessage,
  token: string,
  port: number,
): { ok: true } | { ok: false; status: number; message: string } {
  const host = req.headers.host ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { ok: false, status: 403, message: "unexpected Host header" };
  }
  if (req.headers.origin) return { ok: false, status: 403, message: "cross-origin requests are not allowed" };
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), token)) {
    return { ok: false, status: 401, message: "invalid token" };
  }
  return { ok: true };
}

const matchRoute = (routes: Route[], method: string, pathname: string) => {
  for (const route of routes) {
    if (route.method !== method) continue;
    const want = route.path.split("/");
    const got = pathname.split("/");
    if (want.length !== got.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      const w = want[i]!;
      const g = got[i]!;
      if (w.startsWith(":")) params[w.slice(1)] = decodeURIComponent(g);
      else if (w !== g) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
};

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AgentError("script", "request body is not valid JSON");
  }
};

export function createServer(opts: ServerOptions): http.Server {
  const mask = opts.mask ?? ((v: unknown) => v);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${opts.getPort()}`);
    const hostHeader = req.headers.host ?? "";
    const hostOk =
      hostHeader === `127.0.0.1:${opts.getPort()}` || hostHeader === `localhost:${opts.getPort()}`;

    // /health skips the token check so the UI can detect a running agent.
    if (req.method === "GET" && url.pathname === "/health") {
      if (!hostOk || req.headers.origin) return json(res, 403, { error: { kind: "agent", message: "refused" } });
      const authed = guard(req, opts.token, opts.getPort()).ok;
      return json(
        res,
        200,
        authed ? { ok: true, agent: AGENT_VERSION, ...(opts.health?.() ?? {}) } : { ok: true, agent: AGENT_VERSION },
      );
    }

    const verdict = guard(req, opts.token, opts.getPort());
    if (!verdict.ok) return json(res, verdict.status, { error: { kind: "agent", message: verdict.message } });

    const hit = matchRoute(opts.routes, req.method ?? "GET", url.pathname);
    if (!hit) {
      return json(res, 404, { error: { kind: "agent", message: `no route for ${req.method} ${url.pathname}` } });
    }

    try {
      const body = await readBody(req);
      const query = Object.fromEntries(url.searchParams.entries());
      const result = await hit.route.handler(req, { ...query, ...hit.params }, body);
      json(res, 200, mask(result));
    } catch (err) {
      const kind = err instanceof AgentError ? err.kind : "agent";
      const status = kind === "script" || kind === "assertion" ? 400 : kind === "device" ? 409 : 500;
      json(res, status, { error: { kind, message: (err as Error).message } });
    }
  });
}
