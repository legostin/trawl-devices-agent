import { expect, it } from "vitest";
import { interpolate } from "./interpolate.js";

it("substitutes {{VAR}} in strings and nested structures", () => {
  const env = { BASE_URL: "https://app.test", USER: "u@e.co" };
  expect(interpolate("{{BASE_URL}}/login", env)).toBe("https://app.test/login");
  expect(interpolate({ label: "{{USER}}" }, env)).toEqual({ label: "u@e.co" });
  expect(interpolate(["{{USER}}", 42], env)).toEqual(["u@e.co", 42]);
});

it("throws a script error naming an unknown variable", () => {
  expect(() => interpolate("{{NOPE}}/x", {})).toThrow(/unknown variable: NOPE/);
});

it("leaves regexes and non-strings alone", () => {
  const re = /abc/i;
  expect(interpolate(re, {})).toBe(re);
  expect(interpolate(7, {})).toBe(7);
});
