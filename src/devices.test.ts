import { expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDevices, saveDevice, getDevice, validateDevice } from "./devices.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "dev-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("returns an empty registry when devices.json is missing", async () => {
  expect(await loadDevices(root)).toEqual([]);
});

it("fills defaults on save and round-trips through the file", async () => {
  const saved = await saveDevice(root, { id: "chrome-desktop", name: "Chrome desktop" });
  expect(saved.browser).toBe("chromium");
  expect(saved.proxy).toEqual({ mode: "trawl" });
  expect(saved.trace).toBe("on-failure");
  expect(saved.capabilities).toEqual(["record", "run", "live", "traffic"]);

  const onDisk = JSON.parse(await readFile(path.join(root, "devices.json"), "utf8"));
  expect(onDisk.devices).toHaveLength(1);
  expect(await loadDevices(root)).toEqual([saved]);
});

it("updates an existing device instead of duplicating it", async () => {
  await saveDevice(root, { id: "d1", name: "One" });
  const updated = await saveDevice(root, { id: "d1", name: "One", headless: true });
  expect(updated.headless).toBe(true);
  expect(await loadDevices(root)).toHaveLength(1);
});

it("rejects an unknown browser", () => {
  expect(() => validateDevice({ id: "d", name: "D", browser: "safari" })).toThrow(/browser/);
});

it("rejects a device without an id", () => {
  expect(() => validateDevice({ name: "D" })).toThrow(/id/);
});

it("throws a device error for an unknown id", async () => {
  await expect(getDevice(root, "nope")).rejects.toThrow(/unknown device: nope/);
});
