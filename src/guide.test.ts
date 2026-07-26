import { expect, it } from "vitest";
import { readGuide } from "./guide.js";

it("returns the guide body without frontmatter", async () => {
  const guide = await readGuide();
  expect(guide.startsWith("---")).toBe(false);
  expect(guide).toContain("# Writing device scripts");
  expect(guide).toContain("expectResponse");
});
