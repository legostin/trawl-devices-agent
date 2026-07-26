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

const device = validateDevice({ id: "h", name: "H", headless: true, proxy: { mode: "none" }, trace: "off" });
const sessions = new SessionStore();
let runner: Runner;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "heal-"));
  runner = new Runner({ sessions, workspace: root, trawlProxyPort: 8080 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
afterAll(async () => { await sessions.stopAll(); });

const finish = async (code: string): Promise<RunReport> => {
  const started = await runner.start({ code, device, env: {}, secrets: {} });
  for (let i = 0; i < 300; i++) {
    const report = runner.get(started.runId)!;
    if (report.status !== "running") return report;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("run did not finish");
};

it("falls back to an alternative target and says so", async () => {
  const report = await finish(`
    use({ timeout: 4000 })
    goto('${fixture}')
    click({ testId: 'renamed-in-a-refactor', or: [{ role: 'button', name: 'Войти' }] })
    expectVisible({ testId: 'greeting' })
  `);

  expect(report.status).toBe("passed");
  const click = report.steps.find((s) => s.action === "click")!;
  expect(click.healed).toEqual({ used: { role: "button", name: "Войти" }, index: 1 });
  expect(report.warnings.some((w) => w.includes("used the fallback"))).toBe(true);
});

it("keeps using the primary while it still matches", async () => {
  const report = await finish(`
    goto('${fixture}')
    click({ testId: 'submit', or: [{ role: 'button', name: 'Войти' }] })
  `);
  expect(report.status).toBe("passed");
  expect(report.steps.find((s) => s.action === "click")!.healed).toBeUndefined();
  expect(report.warnings).toEqual([]);
});

it("still fails, with Playwright's own message, when nothing matches", async () => {
  const report = await finish(`
    use({ timeout: 1500 })
    goto('${fixture}')
    click({ testId: 'gone', or: [{ testId: 'also-gone' }] })
  `);
  expect(report.status).toBe("failed");
  const click = report.steps.find((s) => s.action === "click")!;
  expect(click.error?.kind).toBe("timeout");
  expect(click.error?.message).toContain("also-gone");
});

it("replays up to the failure and reports what the page really offers", async () => {
  const { writeScript } = await import("./workspace.js");
  const { heal } = await import("./heal.js");

  // A scenario whose last step points at something that no longer exists.
  await writeScript(
    root,
    "scripts/broken.js",
    `goto('${fixture}')\nfill({ label: 'Email' }, 'a@b.co')\nclick({ testId: 'renamed-away' })\n`,
  );
  const started = await runner.start({
    code: `goto('${fixture}')\nfill({ label: 'Email' }, 'a@b.co')\nuse({ timeout: 1500 })\nclick({ testId: 'renamed-away' })\n`,
    scriptPath: "scripts/broken.js",
    device,
    env: {},
    secrets: {},
  });
  let report = runner.get(started.runId)!;
  for (let i = 0; i < 300 && report.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    report = runner.get(started.runId)!;
  }
  expect(report.status).toBe("failed");

  const result = await heal(sessions, root, { report, code: "", device, env: {}, secrets: {} });

  expect(result.step).toMatchObject({ action: "click", target: { testId: "renamed-away" } });
  // The prefix stops before the failing step, so it can be re-run as is.
  expect(result.prefix).toContain("goto(");
  expect(result.prefix).not.toContain("renamed-away");
  // And the page's real controls are offered, the submit button among them.
  expect(result.candidates.some((c) => c.name === "Войти")).toBe(true);
}, 60_000);
