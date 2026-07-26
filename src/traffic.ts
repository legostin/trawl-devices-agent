import type { BrowserContext, Response } from "playwright";
import { AgentError } from "./types.js";

export interface Observed {
  method: string;
  url: string;
  status: number | null;
  /** Index of the step that was running when the request went out. */
  step: number;
  ts: number;
  consumed: boolean;
  responseBody: () => Promise<string | null>;
}

export interface Matcher {
  method?: string;
  urlPart?: string;
  host?: string;
  path?: string;
}

export interface MatcherObject {
  method?: string;
  host?: string;
  path?: string;
  url?: string;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function parseMatcher(input: string | MatcherObject): Matcher {
  if (typeof input !== "string") {
    const { method, host, path, url } = input;
    return {
      ...(method ? { method: method.toUpperCase() } : {}),
      ...(host ? { host } : {}),
      ...(path ? { path } : {}),
      ...(url ? { urlPart: url } : {}),
    };
  }
  const [head, ...rest] = input.trim().split(/\s+/);
  if (head && METHODS.includes(head.toUpperCase()) && rest.length) {
    return { method: head.toUpperCase(), urlPart: rest.join(" ") };
  }
  return { urlPart: input.trim() };
}

export function matchesObserved(o: Observed, m: Matcher): boolean {
  if (m.method && o.method.toUpperCase() !== m.method) return false;
  if (m.urlPart && !o.url.includes(m.urlPart)) return false;
  if (m.host || m.path) {
    let parsed: URL;
    try {
      parsed = new URL(o.url);
    } catch {
      return false;
    }
    if (m.host && parsed.host !== m.host) return false;
    if (m.path && parsed.pathname !== m.path) return false;
  }
  return true;
}

export const describeMatcher = (m: Matcher): string =>
  [m.method, m.urlPart, m.host, m.path].filter(Boolean).join(" ");

export class TrafficBuffer {
  private readonly seen: Observed[] = [];
  private readonly waiters: { matcher: Matcher; resolve: (o: Observed) => void }[] = [];

  observe(o: Observed): void {
    const waiterIndex = this.waiters.findIndex((w) => matchesObserved(o, w.matcher));
    if (waiterIndex >= 0) {
      const [waiter] = this.waiters.splice(waiterIndex, 1);
      o.consumed = true;
      this.seen.push(o);
      waiter!.resolve(o);
      return;
    }
    this.seen.push(o);
  }

  /** First unconsumed match, waiting up to `timeoutMs` for one to arrive. */
  async consume(matcher: Matcher, timeoutMs: number): Promise<Observed> {
    const existing = this.seen.find((o) => !o.consumed && matchesObserved(o, matcher));
    if (existing) {
      existing.consumed = true;
      return existing;
    }
    return new Promise<Observed>((resolve, reject) => {
      const waiter = { matcher, resolve };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at < 0) return;
        this.waiters.splice(at, 1);
        reject(
          new AgentError("assertion", `no request matched ${describeMatcher(matcher)} within ${timeoutMs}ms`, {
            expected: describeMatcher(matcher),
            actual: "no matching request",
          }),
        );
      }, timeoutMs);
      timer.unref?.();
    });
  }

  seenSince(step: number, matcher: Matcher): Observed[] {
    return this.seen.filter((o) => o.step >= step && matchesObserved(o, matcher));
  }

  all(): readonly Observed[] {
    return this.seen;
  }

  /** Marker headers + response observation. Returns a detach function. */
  static async attach(
    context: BrowserContext,
    runId: string,
    getStep: () => number,
    buffer: TrafficBuffer,
  ): Promise<() => Promise<void>> {
    // The step is fixed when the request goes out, not when the response comes
    // back — otherwise attribution would disagree with the marker header the
    // plugin correlates on.
    const stepOfRequest = new WeakMap<object, number>();

    await context.route("**", async (route) => {
      const step = getStep();
      stepOfRequest.set(route.request(), step);
      await route
        .continue({
          headers: { ...route.request().headers(), "x-trawl-run": runId, "x-trawl-step": String(step) },
        })
        .catch(() => {});
    });

    const onResponse = (response: Response): void => {
      buffer.observe({
        method: response.request().method(),
        url: response.url(),
        status: response.status(),
        step: stepOfRequest.get(response.request()) ?? getStep(),
        ts: Date.now(),
        consumed: false,
        responseBody: () => response.text().catch(() => null),
      });
    };
    context.on("response", onResponse);

    return async () => {
      context.off("response", onResponse);
      await context.unroute("**").catch(() => {});
    };
  }
}
