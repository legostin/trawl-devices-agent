import { promises as fs } from "node:fs";
import path from "node:path";
import { runsDir } from "./workspace.js";

/** Delete all but the `keep` most recent run folders. Returns what was removed. */
export async function pruneRuns(root: string, keep: number): Promise<string[]> {
  const dir = runsDir(root);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const dated = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => ({ name: e.name, mtime: (await fs.stat(path.join(dir, e.name))).mtimeMs })),
  );
  const doomed = dated.sort((a, b) => b.mtime - a.mtime).slice(keep);
  await Promise.all(doomed.map((d) => fs.rm(path.join(dir, d.name), { recursive: true, force: true })));
  return doomed.map((d) => d.name);
}
