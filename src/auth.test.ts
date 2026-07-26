import { expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadOrCreateToken } from "./auth.js";

let dir: string;
beforeEach(async () => { dir = path.join(await mkdtemp(path.join(tmpdir(), "auth-")), "cfg"); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("creates a token file with 0600 and reuses the token", async () => {
  const first = await loadOrCreateToken(dir);
  expect(first).toHaveLength(32);

  const mode = (await stat(path.join(dir, "agent.json"))).mode & 0o777;
  expect(mode).toBe(0o600);
  expect(JSON.parse(await readFile(path.join(dir, "agent.json"), "utf8")).token).toBe(first);

  expect(await loadOrCreateToken(dir)).toBe(first);
});
