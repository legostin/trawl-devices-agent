import { expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MapStore, slug } from "./mapStore.js";
import { SHARED_SCREEN_ID, type ScreenFile } from "./mapTypes.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "map-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("transliterates a label into an ascii slug", () => {
  expect(slug("Подача объявления — Характеристики")).toBe("podacha-obyavleniya-harakteristiki");
  expect(slug("Год")).toBe("god");
  expect(slug("  ")).toBe("element");
});

it("an absent map loads as empty rather than failing", async () => {
  const loaded = await new MapStore(root).load();
  expect(loaded.screens).toEqual([]);
  expect(loaded.app).toMatchObject({ version: 1, hosts: [] });
});

it("round-trips a screen through disk", async () => {
  const store = new MapStore(root);
  const screen: ScreenFile = {
    version: 1,
    id: "harakteristiki",
    label: "Характеристики",
    match: { url: "**/a/new/**", marker: { role: "heading", name: "Характеристики" } },
    elements: {
      god: {
        label: "Год",
        kind: "choice",
        group: { label: "Год" },
        option: { role: "radio" },
        source: "recorded",
        status: "accepted",
        updatedAt: "2026-07-27T09:00:00.000Z",
      },
    },
  };
  await store.saveScreen(screen);

  // One file per screen, so two agents editing different screens never collide.
  const onDisk = JSON.parse(await readFile(path.join(root, "map/screens/harakteristiki.json"), "utf8"));
  expect(onDisk).toEqual(screen);
  expect((await store.load()).screens).toEqual([screen]);
});

it("keeps the shared pseudo-screen first, so it is always in scope", async () => {
  const store = new MapStore(root);
  await store.saveScreen({ version: 1, id: "zzz", label: "Z", match: { url: "**" }, elements: {} });
  await store.saveScreen({ version: 1, id: SHARED_SCREEN_ID, label: "Общие", match: null, elements: {} });

  expect((await store.load()).screens.map((s) => s.id)).toEqual([SHARED_SCREEN_ID, "zzz"]);
});
