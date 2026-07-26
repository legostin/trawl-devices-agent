import { expect, it, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionStore } from "./sessions.js";
import { validateDevice } from "./devices.js";
import { snapshot, performAction } from "./control.js";

const fixture = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/form.html"),
).href;
const device = validateDevice({ id: "t", name: "T", headless: true, proxy: { mode: "none" } });
const sessions = new SessionStore();
let sessionId: string;

beforeAll(async () => {
  sessionId = (await sessions.start(device, { headless: true })).sessionId;
  await sessions.get(sessionId).page.goto(fixture);
});
afterAll(async () => { await sessions.stopAll(); });

it("returns interactive nodes with refs, roles and names", async () => {
  const nodes = await snapshot(sessions.get(sessionId).page);
  const submit = nodes.find((n) => n.name === "Войти");
  expect(submit).toMatchObject({ role: "button" });
  expect(submit!.ref).toMatch(/^e\d+$/);
  expect(nodes.some((n) => n.role === "textbox")).toBe(true);
});

it("acts on a ref and reports the delta", async () => {
  const page = sessions.get(sessionId).page;
  const nodes = await snapshot(page);
  const email = nodes.find((n) => n.label === "Email" && n.role === "textbox")!;
  await performAction(page, { action: "fill", ref: email.ref, value: "a@b.co" });
  expect(await page.getByLabel("Email").inputValue()).toBe("a@b.co");

  const submit = (await snapshot(page)).find((n) => n.name === "Войти")!;
  const delta = await performAction(page, { action: "click", ref: submit.ref });
  expect(delta.url).toContain("form.html");
  expect(delta.consoleErrors).toEqual([]);
});

it("acts on a declarative target too", async () => {
  const page = sessions.get(sessionId).page;
  const delta = await performAction(page, { action: "click", target: { testId: "submit" } });
  expect(delta.url).toContain("form.html");
});

it("rejects an unknown ref with a clear message", async () => {
  await expect(performAction(sessions.get(sessionId).page, { action: "click", ref: "e9999" })).rejects.toThrow(
    /unknown ref: e9999/,
  );
});
