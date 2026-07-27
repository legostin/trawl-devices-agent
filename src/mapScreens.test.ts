import { expect, it } from "vitest";
import { globToRegExp, matchesScreen } from "./mapScreens.js";
import type { ScreenFile } from "./mapTypes.js";

const screen = (match: ScreenFile["match"]): ScreenFile => ({
  version: 1,
  id: "s",
  label: "S",
  match,
  elements: {},
});

it("treats * as one segment and ** as any number of them", () => {
  expect(globToRegExp("**/a/new/**").test("https://example.org/a/new/?cat=auto")).toBe(true);
  expect(globToRegExp("**/a/new/**").test("https://example.org/a/edit/1")).toBe(false);
  expect(globToRegExp("/api/*/list").test("/api/cars/list")).toBe(true);
  expect(globToRegExp("/api/*/list").test("/api/cars/new/list")).toBe(false);
});

it("matches the hash separately from the path", () => {
  const wizard = screen({ url: "**/a/new/**", hash: "#/info?step=*" });
  expect(matchesScreen(wizard, "https://example.org/a/new/?advertId=87#/info?step=health")).toBe(true);
  expect(matchesScreen(wizard, "https://example.org/a/new/?advertId=87#/photos")).toBe(false);
});

it("the shared pseudo-screen never matches a url on its own", () => {
  expect(matchesScreen(screen(null), "https://example.org/anything")).toBe(false);
});
