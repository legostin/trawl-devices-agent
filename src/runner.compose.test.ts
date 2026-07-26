import { expect, it, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Runner } from "./runner.js";
import { SessionStore } from "./sessions.js";
import { validateDevice } from "./devices.js";
import { writeScript } from "./workspace.js";
import type { RunReport } from "./types.js";

const fixture = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/form.html"),
).href;

const device = validateDevice({ id: "t", name: "T", headless: true, proxy: { mode: "none" }, trace: "off" });
const sessions = new SessionStore();
let runner: Runner;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "compose-"));
  runner = new Runner({ sessions, workspace: root, trawlProxyPort: 8080 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
afterAll(async () => { await sessions.stopAll(); });

const finish = async (code: string, env: Record<string, string> = {}): Promise<RunReport> => {
  const started = await runner.start({ code, device, env, secrets: {} });
  for (let i = 0; i < 300; i++) {
    const report = runner.get(started.runId)!;
    if (report.status !== "running") return report;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("run did not finish");
};

it("runs another scenario inline, in the same browser", async () => {
  await writeScript(root, "scripts/login.js", `goto('${fixture}')\nfill({ label: 'Email' }, '{{USER}}')\n`);

  const report = await finish(
    `run('scripts/login.js')\nclick({ testId: 'submit' })\nexpectVisible({ testId: 'greeting' })`,
    { USER: "composed@example.com" },
  );

  expect(report.status).toBe("passed");
  // The called script's steps are listed under its path.
  expect(report.steps.map((s) => [s.action, s.name])).toEqual([
    ["run", undefined],
    ["goto", "scripts/login.js"],
    ["fill", "scripts/login.js"],
    ["click", undefined],
    ["expectVisible", undefined],
  ]);
  expect(report.steps[2]!.args[1]).toBe("composed@example.com");
});

it("overlays variables for the scenario it calls, then restores them", async () => {
  await writeScript(root, "scripts/who.js", `goto('${fixture}')\nfill({ label: 'Email' }, '{{USER}}')\n`);

  const report = await finish(
    `run('scripts/who.js', { USER: 'inner@example.com' })\nfill({ label: 'Email' }, '{{USER}}')`,
    { USER: "outer@example.com" },
  );

  expect(report.status).toBe("passed");
  const fills = report.steps.filter((s) => s.action === "fill");
  expect(fills[0]!.args[1]).toBe("inner@example.com");
  expect(fills[1]!.args[1]).toBe("outer@example.com");
});

it("refuses a cycle instead of recursing forever", async () => {
  await writeScript(root, "scripts/a.js", `run('scripts/b.js')`);
  await writeScript(root, "scripts/b.js", `run('scripts/a.js')`);

  const report = await finish(`run('scripts/a.js')`);
  expect(report.status).toBe("error");
  expect(report.steps.at(-1)!.error?.message).toMatch(/run cycle/);
});

it("names the missing script when it cannot be found", async () => {
  const report = await finish(`run('scripts/nope.js')`);
  expect(report.status).toBe("error");
  expect(report.steps.at(-1)!.error?.message).toContain("no such script: scripts/nope.js");
});
