import { expect, it } from "vitest";
import { globToRegExp, isTooBroad, matchesScreen, screenPatternFor } from "./mapScreens.js";
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

it("ignores the query when deciding which screen this is", () => {
  const login = screen({ url: "https://id.example.org/login/" });
  // The same form is the same form whether or not it carries ?destination=…
  expect(matchesScreen(login, "https://id.example.org/login/?destination=%2Fa%2Fnew")).toBe(true);
  expect(matchesScreen(login, "https://id.example.org/signin/")).toBe(false);
});

it("derives a pattern that is the host and path, with ids wildcarded", () => {
  // The root used to become "**/", which matches every url ending in a slash —
  // including the login page, so both screens claimed every address.
  expect(screenPatternFor("https://desktop.example.org/?utm=x")).toBe("https://desktop.example.org/");
  expect(screenPatternFor("https://desktop.example.org/a/new/87031015")).toBe(
    "https://desktop.example.org/a/new/*",
  );
  expect(screenPatternFor("https://x.org/a/c0369630-d1e2-49e2-b4f9-a25bae8ba3fc/edit")).toBe(
    "https://x.org/a/*/edit",
  );
  expect(matchesScreen(screen({ url: screenPatternFor("https://desktop.example.org/") }), "https://desktop.example.org/login/")).toBe(false);
});

it("refuses a pattern that would claim any host at all", () => {
  // What early recordings produced for the site root, and what then swallowed
  // every screen recorded after it.
  expect(isTooBroad("**/")).toBe(true);
  expect(isTooBroad("**")).toBe(true);
  expect(isTooBroad("**/login/")).toBe(true);

  expect(isTooBroad("https://desktop.example.org/")).toBe(false);
  expect(isTooBroad("https://desktop.example.org/a/new/*")).toBe(false);
});

it("matching stays literal — the recorder is what refuses to reuse such a screen", () => {
  // A hand-written pattern means what it says, so matching must not second-guess
  // it; only the reuse decision in the recorder consults isTooBroad.
  const legacy = screen({ url: "**/" });
  expect(matchesScreen(legacy, "https://example.org/")).toBe(true);
  expect(isTooBroad(legacy.match!.url!)).toBe(true);
});
