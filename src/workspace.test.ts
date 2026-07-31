import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveInWorkspace, ensureWorkspace, readScript, writeScript, listScripts, callersOf, deleteScript } from "./workspace.js";

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

it("names the scenarios that call one before it is deleted", async () => {
  await writeScript(root, "scripts/login.js", "click('Войти')\n");
  await writeScript(root, "scripts/search.js", "run('scripts/login.js')\nclick('Найти')\n");
  await writeScript(root, "scripts/post.js", "run('login.js')\n");
  await writeScript(root, "scripts/alone.js", "click('X')\n");

  // Both spellings reach the same file, and the runner accepts either.
  expect((await callersOf(root, "scripts/login.js")).sort()).toEqual(["scripts/post.js", "scripts/search.js"]);
  expect(await callersOf(root, "scripts/alone.js")).toEqual([]);
});

it("deletes a scenario", async () => {
  await writeScript(root, "scripts/gone.js", "click('X')\n");
  await deleteScript(root, "scripts/gone.js");
  expect(await listScripts(root)).not.toContain("scripts/gone.js");
});
