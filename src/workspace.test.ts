import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveInWorkspace, ensureWorkspace, readScript, writeScript, listScripts } from "./workspace.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "ws-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("resolveInWorkspace", () => {
  it("resolves a path inside the workspace", () => {
    expect(resolveInWorkspace(root, "scripts/login.js")).toBe(path.join(root, "scripts/login.js"));
  });

  it("rejects parent traversal", () => {
    expect(() => resolveInWorkspace(root, "../secrets.txt")).toThrow(/escapes workspace/);
    expect(() => resolveInWorkspace(root, "scripts/../../secrets.txt")).toThrow(/escapes workspace/);
  });

  it("rejects an absolute path outside the workspace", () => {
    expect(() => resolveInWorkspace(root, "/etc/passwd")).toThrow(/escapes workspace/);
  });

  it("rejects a path that merely shares a prefix with the root", () => {
    expect(() => resolveInWorkspace(root, `../${path.basename(root)}-evil/x.js`)).toThrow(/escapes workspace/);
  });
});

describe("scripts", () => {
  it("writes, reads and lists scripts", async () => {
    await ensureWorkspace(root);
    await writeScript(root, "scripts/login.js", "goto('/')\n");
    expect(await readScript(root, "scripts/login.js")).toBe("goto('/')\n");
    await mkdir(path.join(root, "scripts/nested"), { recursive: true });
    await writeFile(path.join(root, "scripts/nested/deep.js"), "note('x')\n");
    await writeFile(path.join(root, "scripts/ignore.txt"), "not a script");
    expect((await listScripts(root)).sort()).toEqual(["scripts/login.js", "scripts/nested/deep.js"]);
  });
});
