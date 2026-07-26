import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolved relative to this module, so it works from src/ under vitest and from
 * dist/ in the published package — `skills/` sits at the package root in both.
 */
const GUIDE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills/writing-device-scripts/SKILL.md",
);

/** The DSL reference, frontmatter stripped. Single source shared with the Claude Code skill. */
export async function readGuide(): Promise<string> {
  const raw = await fs.readFile(GUIDE_PATH, "utf8");
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim() + "\n";
}
