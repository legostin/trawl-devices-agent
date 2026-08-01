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
    match: { url: "https://auto.example.org/a/new/*", marker: { role: "heading", name: "Характеристики" } },
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

  // One file per screen, under the application it belongs to: two products in
  // one workspace must not share a namespace.
  const onDisk = JSON.parse(await readFile(path.join(root, "map/example.org/harakteristiki.json"), "utf8"));
  expect(onDisk).toEqual({ ...screen, domain: "example.org" });
  expect((await store.load()).screens).toEqual([{ ...screen, domain: "example.org" }]);
});

it("keeps the shared pseudo-screen first, so it is always in scope", async () => {
  const store = new MapStore(root);
  await store.saveScreen({ version: 1, id: "zzz", label: "Z", match: { url: "**" }, elements: {} });
  await store.saveScreen({ version: 1, id: SHARED_SCREEN_ID, label: "Общие", match: null, elements: {} });

  expect((await store.load()).screens.map((s) => s.id)).toEqual([SHARED_SCREEN_ID, "zzz"]);
});

it("keeps two applications in two namespaces", async () => {
  const store = new MapStore(root);
  const of = (id: string, url: string): ScreenFile => ({
    version: 1,
    id,
    label: id,
    match: { url },
    elements: {},
  });
  await store.saveScreen(of("main", "https://shop.example.org/"));
  await store.saveScreen(of("main-other", "https://other.test/"));

  // A login on id.example.org belongs with the product on www.example.org —
  // splitting by host would put a flow's two halves in two maps.
  await store.saveScreen(of("login", "https://id.example.org/login/"));

  const byDomain = new Map((await store.load()).screens.map((s) => [s.id, s.domain]));
  expect(byDomain.get("main")).toBe("example.org");
  expect(byDomain.get("login")).toBe("example.org");
  expect(byDomain.get("main-other")).toBe("other.test");
});
