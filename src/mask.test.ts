import { expect, it } from "vitest";
import { makeMasker } from "./mask.js";

it("masks secret values anywhere in the structure", () => {
  const mask = makeMasker({ PWD: "hunter2secret", TOKEN: "abcd1234efgh" });
  expect(mask("logged in with hunter2secret")).toBe("logged in with ***");
  expect(mask({ steps: [{ args: ["hunter2secret"] }] })).toEqual({ steps: [{ args: ["***"] }] });
  expect(mask({ nested: { header: "Bearer abcd1234efgh" } })).toEqual({ nested: { header: "Bearer ***" } });
});

it("ignores short secrets so common words are not blanked", () => {
  const mask = makeMasker({ SHORT: "ab" });
  expect(mask("about")).toBe("about");
});

it("leaves non-strings untouched", () => {
  const mask = makeMasker({ PWD: "hunter2secret" });
  expect(mask({ n: 42, b: true, nil: null })).toEqual({ n: 42, b: true, nil: null });
});
