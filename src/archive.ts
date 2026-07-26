import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentError, type RunReport } from "./types.js";
import { runDir, runsDir } from "./workspace.js";

/**
 * Past runs live on disk as `runs/<id>/report.json`, so the archive survives an
 * agent restart — the in-memory list only knows about the current process.
 */

export interface ArchiveQuery {
  /** Only runs of this script. */
  script?: string;
  limit?: number;
}

export async function listRuns(workspace: string, query: ArchiveQuery = {}): Promise<RunReport[]> {
  const dir = runsDir(workspace);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const reports: RunReport[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name, "report.json"), "utf8");
      const report = JSON.parse(raw) as RunReport;
      if (query.script && report.script !== query.script) continue;
      reports.push(report);
    } catch {
      // A run still in flight has no report yet.
    }
  }

  reports.sort((a, b) => b.startedAt - a.startedAt);
  return reports.slice(0, query.limit ?? 50);
}

export interface ArtifactEntry {
  path: string;
  size: number;
}

/** Every file a run produced, as run-relative paths. */
export async function listArtifacts(workspace: string, runId: string): Promise<ArtifactEntry[]> {
  const root = runDir(workspace, runId);
  const out: ArtifactEntry[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.push({ path: path.relative(root, abs), size: (await fs.stat(abs)).size });
    }
  };

  await walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".json": "application/json",
};

/** One artifact, base64-encoded: the plugin has no filesystem of its own. */
export async function readArtifact(
  workspace: string,
  runId: string,
  relative: string,
): Promise<{ mime: string; base64: string; size: number }> {
  const root = runDir(workspace, runId);
  const abs = path.resolve(root, relative);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new AgentError("script", `path escapes the run folder: ${relative}`);
  }

  const data = await fs.readFile(abs).catch(() => {
    throw new AgentError("agent", `no such artifact: ${relative}`);
  });
  return {
    mime: MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
    base64: data.toString("base64"),
    size: data.length,
  };
}
