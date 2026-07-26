import { expect, it, beforeAll, afterAll } from "vitest";
import http, { type Server } from "node:http";
import { createServer } from "./server.js";
import { AGENT_VERSION } from "./version.js";

const TOKEN = "test-token-0123456789abcdefghij";
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer({
    token: TOKEN,
    getPort: () => port,
    routes: [
      { method: "GET", path: "/echo", handler: async (_req, _params, body) => ({ echoed: body ?? null }) },
      { method: "GET", path: "/boom", handler: async () => { throw new Error("kaboom"); } },
      { method: "GET", path: "/runs/:id", handler: async (_req, params) => ({ id: params.id }) },
    ],
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = (p: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${p}`, { headers: { authorization: `Bearer ${TOKEN}`, ...headers } });

it("rejects a missing or wrong token with 401", async () => {
  expect((await fetch(`http://127.0.0.1:${port}/echo`)).status).toBe(401);
  expect((await call("/echo", { authorization: "Bearer nope" })).status).toBe(401);
});

/** fetch() refuses to set Host (a forbidden header), so this one goes raw. */
const rawCall = (headers: Record<string, string>): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/echo", method: "GET", headers: { authorization: `Bearer ${TOKEN}`, ...headers } },
      (res) => { res.resume(); resolve(res.statusCode ?? 0); },
    );
    req.on("error", reject);
    req.end();
  });

it("rejects a foreign Host header with 403", async () => {
  expect(await rawCall({ host: "evil.example.com" })).toBe(403);
});

it("accepts localhost as well as 127.0.0.1 in Host", async () => {
  expect(await rawCall({ host: `localhost:${port}` })).toBe(200);
});

it("rejects a request carrying an Origin with 403", async () => {
  expect((await call("/echo", { origin: "https://evil.example.com" })).status).toBe(403);
});

it("serves /health without a token, with a reduced payload", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, agent: AGENT_VERSION });
  expect(body.steps).toBeUndefined();
});

it("extracts path params", async () => {
  expect(await (await call("/runs/r_42")).json()).toEqual({ id: "r_42" });
});

it("turns a thrown error into 500 with a kind", async () => {
  const res = await call("/boom");
  expect(res.status).toBe(500);
  expect(await res.json()).toMatchObject({ error: { kind: "agent", message: "kaboom" } });
});

it("404s an unknown route", async () => {
  expect((await call("/nope")).status).toBe(404);
});
