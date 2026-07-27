import { expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RecorderStore } from "./recorder.js";
import { SessionStore } from "./sessions.js";
import { MapStore } from "./mapStore.js";
import { validateDevice } from "./devices.js";

const choices = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/choices.html"),
).href;

const device = validateDevice({ id: "t", name: "T", headless: true, proxy: { mode: "none" }, trace: "off" });
let sessions: SessionStore;
let recorder: RecorderStore;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "recmap-"));
  sessions = new SessionStore();
  recorder = new RecorderStore({ sessions, workspace: root });
});
afterEach(async () => {
  await sessions.stopAll();
  await rm(root, { recursive: true, force: true });
});

it("writes what it saw into the map and scripts it by name", async () => {
  const session = await sessions.start(device, { headless: true });
  const recording = await recorder.start(session.sessionId, choices);
  const page = sessions.get(session.sessionId).page;

  await page.getByRole("radio", { name: "2010" }).click();
  await page.getByRole("button", { name: "Подать объявление" }).click();
  await page.waitForTimeout(300);

  const result = await recorder.stop(recording.id, {});

  // The script carries intent, not locators.
  expect(result.code).toContain("select('Характеристики › Год', '2010')");
  expect(result.code).toContain("click('Характеристики › Подать объявление')");
  expect(result.code).not.toContain("nth");
  expect(result.code).not.toContain("css");

  // And the map carries the locators.
  const map = await new MapStore(root).load();
  const screen = map.screens[0]!;
  expect(Object.values(screen.elements).map((e) => e.label).sort()).toEqual(["Год", "Подать объявление"]);
  expect(Object.values(screen.elements).find((e) => e.label === "Год")!.kind).toBe("choice");
  expect(result.map).toMatchObject({ screens: 1, elements: 2 });
});

it("a second recording reuses the entries the first one made", async () => {
  const session = await sessions.start(device, { headless: true });
  const first = await recorder.start(session.sessionId, choices);
  const page = sessions.get(session.sessionId).page;
  await page.getByRole("button", { name: "Подать объявление" }).click();
  await page.waitForTimeout(300);
  await recorder.stop(first.id, {});

  const second = await recorder.start(session.sessionId, choices);
  await page.getByRole("button", { name: "Подать объявление" }).click();
  await page.waitForTimeout(300);
  const result = await recorder.stop(second.id, {});

  const map = await new MapStore(root).load();
  expect(Object.keys(map.screens[0]!.elements)).toHaveLength(1);
  expect(result.map.elements).toBe(0);
});
