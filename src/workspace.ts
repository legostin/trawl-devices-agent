import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentError } from "./types.js";

/** Resolve `rel` under `root`, refusing anything that escapes it. */
export function resolveInWorkspace(root: string, rel: string): string {
  const normRoot = path.resolve(root);
  const abs = path.resolve(normRoot, rel);
  if (abs !== normRoot && !abs.startsWith(normRoot + path.sep)) {
    throw new AgentError("script", `path escapes workspace: ${rel}`);
  }
  return abs;
}

export const scriptsDir = (root: string) => path.join(path.resolve(root), "scripts");
export const runsDir = (root: string) => path.join(path.resolve(root), "runs");
export const stateDir = (root: string) => path.join(path.resolve(root), "state");

/** `auth` and `state/auth.json` both mean the same file. */
export const statePath = (root: string, name: string): string => {
  const rel = name.includes("/") ? name : `state/${name}`;
  return resolveInWorkspace(root, rel.endsWith(".json") ? rel : `${rel}.json`);
};
export const runDir = (root: string, runId: string) => path.join(runsDir(root), runId);

export async function ensureWorkspace(root: string): Promise<void> {
  await fs.mkdir(scriptsDir(root), { recursive: true });
  await fs.mkdir(runsDir(root), { recursive: true });
}

export async function readScript(root: string, rel: string): Promise<string> {
  return fs.readFile(resolveInWorkspace(root, rel), "utf8");
}

export async function writeScript(root: string, rel: string, code: string): Promise<void> {
  const abs = resolveInWorkspace(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, code, "utf8");
}

/** Every `.js` under scripts/, as workspace-relative paths. */
export async function listScripts(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.name.endsWith(".js")) out.push(path.relative(path.resolve(root), abs));
    }
  };
  await walk(scriptsDir(root));
  return out;
}
