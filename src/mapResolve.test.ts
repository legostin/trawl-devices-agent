import { expect, it } from "vitest";
import { parseReference, resolveName } from "./mapResolve.js";
import { SHARED_SCREEN_ID, type AppMap, type ElementEntry, type ScreenFile } from "./mapTypes.js";

const entry = (label: string, aliases?: string[]): ElementEntry => ({
  label,
  kind: "control",
  ...(aliases ? { aliases } : {}),
  target: { role: "button", name: label },
  source: "recorded",
  status: "accepted",
  updatedAt: "2026-07-27T09:00:00.000Z",
});

const screen = (id: string, label: string, elements: Record<string, ElementEntry>): ScreenFile => ({
  version: 1,
  id,
  label,
  match: id === SHARED_SCREEN_ID ? null : { url: `**/${id}/**` },
  elements,
});

const map: AppMap = {
  app: { version: 1, hosts: [] },
  screens: [
    screen(SHARED_SCREEN_ID, "Общие", { podat: entry("Подать объявление") }),
    screen("harakteristiki", "Характеристики", {
      prodolzhit: entry("Продолжить"),
      god: entry("Год", ["Год выпуска"]),
    }),
    screen("cena", "Цена", { prodolzhit: entry("Продолжить") }),
  ],
};

it("splits a qualified reference on either separator", () => {
  expect(parseReference("Характеристики › Год")).toEqual({ screen: "Характеристики", element: "Год" });
  expect(parseReference("Характеристики > Год")).toEqual({ screen: "Характеристики", element: "Год" });
  expect(parseReference("Год")).toEqual({ element: "Год" });
});

it("prefers the current screen, then the shared elements", () => {
  expect(resolveName(map, "Продолжить", "harakteristiki").screen.id).toBe("harakteristiki");
  expect(resolveName(map, "Подать объявление", "harakteristiki").screen.id).toBe(SHARED_SCREEN_ID);
});

it("finds an element on another screen when the name is unique", () => {
  expect(resolveName(map, "Год", "cena").entry.label).toBe("Год");
});

it("resolves an old label through its aliases", () => {
  expect(resolveName(map, "Год выпуска", "harakteristiki").entry.label).toBe("Год");
});

it("refuses an ambiguous name and says how to qualify it", () => {
  // "Продолжить" exists on two screens and we are on neither.
  expect(() => resolveName(map, "Продолжить", null)).toThrow(/Характеристики › Продолжить/);
});

it("lists what is near when nothing matches", () => {
  expect(() => resolveName(map, "Годик", "harakteristiki")).toThrow(/Год/);
});

it("ignores case and repeated whitespace", () => {
  expect(resolveName(map, "  подать   объявление ", null).entry.label).toBe("Подать объявление");
});

it("keeps names apart between applications", () => {
  const twoSites: AppMap = {
    app: { version: 1, hosts: [] },
    screens: [
      { ...screen("a-main", "Главная A", { go: entry("Продолжить") }), domain: "a.example" },
      { ...screen("b-main", "Главная B", { go: entry("Продолжить") }), domain: "b.example" },
    ],
  };

  // The same wording on two products is not an ambiguity — it is two names in
  // two namespaces, and calling it ambiguous makes both unusable.
  expect(resolveName(twoSites, "Продолжить", "a-main").screen.id).toBe("a-main");
  expect(resolveName(twoSites, "Продолжить", "b-main").screen.id).toBe("b-main");
});

it("still refuses an ambiguous name inside one application", () => {
  const oneSite: AppMap = {
    app: { version: 1, hosts: [] },
    screens: [
      { ...screen("main", "Главная", { go: entry("Продолжить") }), domain: "a.example" },
      { ...screen("login", "Вход", { go: entry("Продолжить") }), domain: "a.example" },
    ],
  };
  expect(() => resolveName(oneSite, "Продолжить", null)).toThrow(/уточните/);
});
