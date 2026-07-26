import { describe, expect, it } from "vitest";
import { parseMatcher, matchesObserved, TrafficBuffer, type Observed } from "./traffic.js";

const observed = (over: Partial<Observed> = {}): Observed => ({
  method: "POST",
  url: "https://api.example.com/v4/login",
  status: 200,
  step: 0,
  ts: 1,
  consumed: false,
  responseBody: async () => '{"token":"eyJ"}',
  ...over,
});

describe("matchers", () => {
  it("parses the string form", () => {
    expect(parseMatcher("POST /v4/login")).toEqual({ method: "POST", urlPart: "/v4/login" });
    expect(parseMatcher("api/login")).toEqual({ urlPart: "api/login" });
  });

  it("matches on method and url substring", () => {
    expect(matchesObserved(observed(), parseMatcher("POST api.example.com/v4/login"))).toBe(true);
    expect(matchesObserved(observed(), parseMatcher("GET api/login"))).toBe(false);
    expect(matchesObserved(observed(), parseMatcher("POST other"))).toBe(false);
  });

  it("matches the object form on host and path", () => {
    expect(matchesObserved(observed(), parseMatcher({ host: "api.example.com", path: "/v4/login" }))).toBe(true);
    expect(matchesObserved(observed(), parseMatcher({ host: "other.example.com" }))).toBe(false);
  });
});

describe("TrafficBuffer", () => {
  it("consumes a match that already happened, once", async () => {
    const buffer = new TrafficBuffer();
    buffer.observe(observed());
    expect((await buffer.consume(parseMatcher("POST /v4/login"), 100)).status).toBe(200);
    await expect(buffer.consume(parseMatcher("POST /v4/login"), 100)).rejects.toThrow(/no request matched/);
  });

  it("waits for a match that arrives later", async () => {
    const buffer = new TrafficBuffer();
    setTimeout(() => buffer.observe(observed()), 50);
    expect((await buffer.consume(parseMatcher("POST /v4/login"), 1000)).status).toBe(200);
  });

  it("lists everything seen since a step", () => {
    const buffer = new TrafficBuffer();
    buffer.observe(observed({ step: 0 }));
    buffer.observe(observed({ step: 2, url: "https://api.example.com/v4/orders" }));
    expect(buffer.seenSince(2, parseMatcher("/v4/orders"))).toHaveLength(1);
    expect(buffer.seenSince(2, parseMatcher("/v4/login"))).toHaveLength(0);
  });
});
