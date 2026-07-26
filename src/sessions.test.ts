import { expect, it, afterEach } from "vitest";
import { SessionStore, contextOptionsFor } from "./sessions.js";
import { validateDevice } from "./devices.js";

const device = validateDevice({ id: "test", name: "Test", headless: true, proxy: { mode: "none" } });
const store = new SessionStore();
afterEach(async () => { await store.stopAll(); });

it("builds context options from the device", () => {
  const trawl = validateDevice({ id: "t", name: "T", locale: "ru-RU" });
  const opts = contextOptionsFor(trawl, 8080);
  expect(opts.proxy).toEqual({ server: "http://127.0.0.1:8080" });
  expect(opts.ignoreHTTPSErrors).toBe(true);
  expect(opts.viewport).toEqual({ width: 1280, height: 800 });
  expect(opts.locale).toBe("ru-RU");

  expect(contextOptionsFor(device, 8080).proxy).toBeUndefined();
  const custom = validateDevice({ id: "c", name: "C", proxy: { mode: "custom", url: "http://10.0.0.1:3128" } });
  expect(contextOptionsFor(custom, 8080).proxy).toEqual({ server: "http://10.0.0.1:3128" });
});

it("starts a session, exposes it, and stops it", async () => {
  const session = await store.start(device);
  expect(session.state).toBe("idle");
  expect(store.list()).toHaveLength(1);

  const live = store.get(session.sessionId);
  await live.page.goto("data:text/html,<h1>hi</h1>");
  expect(await live.page.locator("h1").textContent()).toBe("hi");

  await store.stop(session.sessionId);
  expect(store.list()).toHaveLength(0);
});

it("throws a device error for an unknown session", () => {
  expect(() => store.get("nope")).toThrow(/unknown session: nope/);
});
