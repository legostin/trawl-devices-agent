import { expect, it } from "vitest";
import { shortestRef, refParts } from "./mapRef.js";
import type { AppMap, ElementEntry, ScreenFile } from "./mapTypes.js";

const entry = (label: string): ElementEntry => ({
  label,
  kind: "control",
  target: { role: "button", name: label },
  source: "recorded",
  status: "accepted",
  updatedAt: "2026-07-31T09:00:00.000Z",
});

const screen = (id: string, label: string, labels: string[]): ScreenFile => ({
  version: 1,
  id,
  label,
  match: { url: `**/${id}` },
  elements: Object.fromEntries(labels.map((l, i) => [`e${i}`, entry(l)])),
});

const map: AppMap = {
  app: { version: 1, hosts: [] },
  screens: [
    screen("main", "Горячие предложения по продаже авто в Казахстане", ["Вход и регистрация", "Продолжить"]),
    screen("login", "Вход в личный кабинет", ["Пароль", "Продолжить"]),
  ],
};

it("names a unique element by itself", () => {
  // The screen adds nothing here but width — and this screen is a whole line.
  expect(shortestRef(map, "Горячие предложения по продаже авто в Казахстане", "Пароль")).toBe("Пароль");
});

it("keeps the screen when the name means two things", () => {
  expect(shortestRef(map, "Вход в личный кабинет", "Продолжить")).toBe("Вход в личный кабинет › Продолжить");
});

it("splits a reference back into its parts", () => {
  expect(refParts("Вход › Пароль")).toEqual({ screen: "Вход", element: "Пароль" });
  expect(refParts("Пароль")).toEqual({ element: "Пароль" });
});
