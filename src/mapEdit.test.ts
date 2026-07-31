import { expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MapStore } from "./mapStore.js";
import { editMap } from "./mapEdit.js";
import type { ScreenFile } from "./mapTypes.js";

let root: string;
const screen = (): ScreenFile => ({
  version: 1,
  id: "vhod",
  label: "Вход",
  match: { url: "https://id.example.org/login/" },
  elements: {
    bez: {
      label: "Без названия (button)",
      kind: "control",
      target: { role: "button", nth: 3 },
      source: "recorded",
      status: "proposed",
      updatedAt: "2026-07-27T09:00:00.000Z",
    },
  },
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mapedit-"));
  await new MapStore(root).saveScreen(screen());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("renaming keeps the old label as an alias", async () => {
  await editMap(root, { screenId: "vhod", elementKey: "bez", label: "Войти" });

  const entry = (await new MapStore(root).load()).screens[0]!.elements.bez!;
  expect(entry.label).toBe("Войти");
  // A scenario written against the old wording must not break because someone
  // tidied up the map.
  expect(entry.aliases).toContain("Без названия (button)");
  // And a name given by a human is a decision, not a guess.
  expect(entry).toMatchObject({ source: "human", status: "accepted" });
});

it("accepts a proposed entry without touching its name", async () => {
  await editMap(root, { screenId: "vhod", elementKey: "bez", status: "accepted" });

  const entry = (await new MapStore(root).load()).screens[0]!.elements.bez!;
  expect(entry.status).toBe("accepted");
  expect(entry.label).toBe("Без названия (button)");
  expect(entry.source).toBe("recorded");
});

it("drops an element, and a whole screen", async () => {
  await editMap(root, { screenId: "vhod", elementKey: "bez", remove: true });
  expect(Object.keys((await new MapStore(root).load()).screens[0]!.elements)).toEqual([]);

  await editMap(root, { screenId: "vhod", remove: true });
  expect((await new MapStore(root).load()).screens).toEqual([]);
});

it("renames the screen itself", async () => {
  await editMap(root, { screenId: "vhod", label: "Вход в личный кабинет" });
  expect((await new MapStore(root).load()).screens[0]!.label).toBe("Вход в личный кабинет");
});

it("says which screen or element is missing", async () => {
  await expect(editMap(root, { screenId: "nope" })).rejects.toThrow(/экран «nope» не найден/);
  await expect(editMap(root, { screenId: "vhod", elementKey: "nope" })).rejects.toThrow(/нет элемента/);
});

it("repairs a screen's pattern by hand, which re-recording cannot do", async () => {
  // The way out of a map recorded with a pattern that claimed the whole site.
  await editMap(root, { screenId: "vhod", match: { url: "https://id.example.org/login/" } });

  const screen = (await new MapStore(root).load()).screens[0]!;
  expect(screen.match).toEqual({ url: "https://id.example.org/login/" });
});

it("records how to get back to a screen", async () => {
  await editMap(root, { screenId: "vhod", open: { url: "https://id.example.org/login/" } });
  expect((await new MapStore(root).load()).screens[0]!.open).toEqual({ url: "https://id.example.org/login/" });
});

it("moves an element to the screen it really belongs to", async () => {
  const store = new MapStore(root);
  await store.saveScreen({
    version: 1,
    id: "glavnaya",
    label: "Главная",
    match: { url: "https://example.org/" },
    elements: {},
  });

  await editMap(root, { screenId: "vhod", elementKey: "bez", moveTo: "glavnaya" });

  const map = await store.load();
  const from = map.screens.find((s) => s.id === "vhod")!;
  const to = map.screens.find((s) => s.id === "glavnaya")!;
  expect(Object.keys(from.elements)).toEqual([]);
  expect(Object.values(to.elements).map((e) => e.label)).toEqual(["Без названия (button)"]);
});
