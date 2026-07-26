import { expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listRuns, listArtifacts, readArtifact } from "./archive.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "arch-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const writeRun = async (id: string, report: Record<string, unknown>): Promise<void> => {
  const dir = path.join(root, "runs", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "report.json"), JSON.stringify(report), "utf8");
};

it("lists runs newest first and filters by script", async () => {
  await writeRun("r_1", { runId: "r_1", script: "scripts/login.js", startedAt: 100, status: "passed" });
  await writeRun("r_2", { runId: "r_2", script: "scripts/search.js", startedAt: 300, status: "failed" });
  await writeRun("r_3", { runId: "r_3", script: "scripts/login.js", startedAt: 200, status: "passed" });

  expect((await listRuns(root)).map((r) => r.runId)).toEqual(["r_2", "r_3", "r_1"]);
  expect((await listRuns(root, { script: "scripts/login.js" })).map((r) => r.runId)).toEqual(["r_3", "r_1"]);
  expect(await listRuns(root, { limit: 1 })).toHaveLength(1);
});

it("ignores a run folder without a report", async () => {
  await mkdir(path.join(root, "runs", "r_partial"), { recursive: true });
  expect(await listRuns(root)).toEqual([]);
});

it("lists and reads artifacts, refusing paths outside the run", async () => {
  await writeRun("r_1", { runId: "r_1", startedAt: 1 });
  await mkdir(path.join(root, "runs/r_1/frames"), { recursive: true });
  await writeFile(path.join(root, "runs/r_1/frames/00000.jpg"), Buffer.from([0xff, 0xd8, 0xff]));

  const artifacts = await listArtifacts(root, "r_1");
  expect(artifacts.map((a) => a.path)).toEqual(["frames/00000.jpg", "report.json"]);

  const frame = await readArtifact(root, "r_1", "frames/00000.jpg");
  expect(frame.mime).toBe("image/jpeg");
  expect(Buffer.from(frame.base64, "base64")).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

  await expect(readArtifact(root, "r_1", "../../../etc/passwd")).rejects.toThrow(/escapes the run folder/);
  await expect(readArtifact(root, "r_1", "nope.png")).rejects.toThrow(/no such artifact/);
});
