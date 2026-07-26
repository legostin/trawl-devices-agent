import { expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pruneRuns } from "./retention.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "ret-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("keeps the newest N run folders and removes the rest", async () => {
  for (let i = 0; i < 5; i++) {
    const dir = path.join(root, "runs", `r_${i}`);
    await mkdir(dir, { recursive: true });
    const when = new Date(2026, 0, 1 + i);
    await utimes(dir, when, when);
  }
  const removed = await pruneRuns(root, 2);
  expect(removed.sort()).toEqual(["r_0", "r_1", "r_2"]);
  expect((await readdir(path.join(root, "runs"))).sort()).toEqual(["r_3", "r_4"]);
});

it("is a no-op when there is nothing to prune", async () => {
  expect(await pruneRuns(root, 50)).toEqual([]);
});
