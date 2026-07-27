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
