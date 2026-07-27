import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_VERSION } from "./version.js";

/**
 * Two places hold the version and only one of them is what the plugin reads.
 * Bumping package.json alone shipped an agent that ran new code and reported
 * the old number, which is worse than not bumping at all.
 */
it("reports the version that was published", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };
  expect(AGENT_VERSION).toBe(pkg.version);
});
