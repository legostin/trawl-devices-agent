import { expect, it, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Runner } from "./runner.js";
import { SessionStore } from "./sessions.js";
import { validateDevice } from "./devices.js";
import type { RunReport } from "./types.js";

const fixture = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/form.html"),
).href;

const device = validateDevice({
  id: "test",
  name: "Test",
  headless: true,
  proxy: { mode: "none" },
  trace: "off",
});
const sessions = new SessionStore();
let runner: Runner;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "run-"));
  runner = new Runner({ sessions, workspace: root, trawlProxyPort: 8080 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
afterAll(async () => { await sessions.stopAll(); });

const finish = async (code: string, secrets: Record<string, string> = {}): Promise<RunReport> => {
  const started = await runner.start({ code, device, env: {}, secrets });
  for (let i = 0; i < 300; i++) {
    const report = runner.get(started.runId)!;
    if (report.status !== "running") return report;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("run did not finish");
};

it("replays actions and passes its assertions", async () => {
  const report = await finish(`
    goto('${fixture}')
    fill({ label: 'Email' }, 'user@example.com')
    fill({ label: 'Пароль' }, 'hunter2')
    check({ css: '#remember' })
    select({ css: '#plan' }, 'pro')
    click({ testId: 'submit' })
    expectVisible({ testId: 'greeting' })
    expectText({ testId: 'greeting' }, /Привет/)
    expectValue({ label: 'Email' }, 'user@example.com')
    expectCount({ role: 'row', within: { css: '#orders' } }, 2)
  `);
  expect(report.status).toBe("passed");
  expect(report.steps.every((s) => s.status === "passed")).toBe(true);
  expect(report.steps).toHaveLength(10);
});

it("fails on a false assertion, screenshots it, and stops there", async () => {
  const report = await finish(`
    goto('${fixture}')
    expectText({ css: '#title' }, 'Wrong title')
    note('never runs')
  `);
  expect(report.status).toBe("failed");
  const failed = report.steps[1]!;
  expect(failed.error?.kind).toBe("assertion");
  expect(failed.error?.expected).toBe("Wrong title");
  expect(failed.error?.actual).toBe("Sign in");
  expect(failed.screenshot).toBe("step-01.png");
  // Steps after the failure never ran, so the report ends at the failing one.
  expect(report.steps).toHaveLength(2);
});

it("reports a missing element as a timeout, not an assertion", async () => {
  const report = await finish(`
    use({ timeout: 500 })
    goto('${fixture}')
    click({ testId: 'nope' })
  `);
  expect(report.status).toBe("failed");
  expect(report.steps[2]!.error?.kind).toBe("timeout");
  expect(report.steps[2]!.error?.message).toContain("nope");
});

it("reports a thrown script error as status error", async () => {
  const report = await finish("goto('about:blank'); throw new Error('boom')");
  expect(report.status).toBe("error");
  expect(report.steps.at(-1)?.error?.kind).toBe("script");
});

it("supports reads and branching", async () => {
  const report = await finish(`
    goto('${fixture}')
    const title = getText({ css: '#title' })
    if (title === 'Sign in') { note('branch taken') }
  `);
  expect(report.status).toBe("passed");
  expect(report.steps.map((s) => s.action)).toEqual(["goto", "getText", "note"]);
});

it("never leaks a secret into the report", async () => {
  const report = await finish(
    `goto('${fixture}')\nfill({ label: 'Пароль' }, secret('PWD'))\nexpectValue({ label: 'Email' }, 'wrong')`,
    { PWD: "hunter2secret" },
  );
  expect(report.status).toBe("failed");
  expect(JSON.stringify(report)).not.toContain("hunter2secret");
  expect(JSON.stringify(report)).toContain("***");
});

it("substitutes project variables and fails loudly on an unknown one", async () => {
  const started = await runner.start({
    code: `goto('{{FIXTURE}}')\nexpectText({ css: '#title' }, 'Sign in')`,
    device,
    env: { FIXTURE: fixture },
    secrets: {},
  });
  let report = runner.get(started.runId)!;
  for (let i = 0; i < 300 && report.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    report = runner.get(started.runId)!;
  }
  expect(report.status).toBe("passed");
  expect(report.steps[0]!.args[0]).toBe(fixture);

  const bad = await finish(`goto('{{NOPE}}')`);
  expect(bad.status).toBe("error");
  expect(bad.steps.at(-1)!.error?.message).toContain("unknown variable: NOPE");
});

it("groups nested steps under step(name)", async () => {
  const report = await finish(`
    step('open', () => {
      goto('${fixture}')
      expectVisible({ css: '#title' })
    })
  `);
  expect(report.status).toBe("passed");
  expect(report.steps.map((s) => [s.action, s.name])).toEqual([
    ["step", undefined],
    ["goto", "open"],
    ["expectVisible", "open"],
  ]);
});

it("holds a run between steps and carries on where it stopped", async () => {
  const runner = new Runner({ sessions, workspace: root, trawlProxyPort: 8080 });
  const started = await runner.start({
    code: `goto('data:text/html,<h1>one</h1>')\nsleep(200)\nsleep(200)\nsleep(200)\nexpectText({ css: 'h1' }, 'one')\n`,
    device,
    env: {},
    secrets: {},
  });

  // The browser is reachable while the run holds it — that is the point of
  // pausing: to look, to click by hand, to record what was missing. It appears
  // once the browser is actually up, which is not instant.
  for (let i = 0; i < 100 && !runner.get(started.runId)!.sessionId; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(runner.get(started.runId)!.sessionId).toBeTruthy();
  expect(runner.setPaused(started.runId, true)).toBe(true);

  await new Promise((r) => setTimeout(r, 600));
  const held = runner.get(started.runId)!;
  expect(held.status).toBe("running");
  expect(held.paused).toBe(true);
  const stepsWhileHeld = held.steps.length;
  await new Promise((r) => setTimeout(r, 500));
  expect(runner.get(started.runId)!.steps.length).toBe(stepsWhileHeld);

  runner.setPaused(started.runId, false);
  let report = runner.get(started.runId)!;
  for (let i = 0; i < 100 && report.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    report = runner.get(started.runId)!;
  }
  expect(report.status).toBe("passed");
});
