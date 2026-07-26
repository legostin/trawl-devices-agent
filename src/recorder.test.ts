import { expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RecorderStore } from "./recorder.js";
import { SessionStore } from "./sessions.js";
import { Runner } from "./runner.js";
import { validateDevice } from "./devices.js";
import type { RunReport } from "./types.js";

const fixture = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/form.html"),
).href;

const device = validateDevice({ id: "t", name: "T", headless: true, proxy: { mode: "none" }, trace: "off" });
let sessions: SessionStore;
let recorder: RecorderStore;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rec-"));
  sessions = new SessionStore();
  recorder = new RecorderStore({ sessions, workspace: root });
});
afterEach(async () => {
  await sessions.stopAll();
  await rm(root, { recursive: true, force: true });
});

it("records clicks and typing as declarative steps", async () => {
  const session = await sessions.start(device, { headless: true });
  const recording = await recorder.start(session.sessionId, fixture);

  const page = sessions.get(session.sessionId).page;
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByTestId("submit").click();
  await page.waitForTimeout(300);

  const result = await recorder.stop(recording.id, {});
  const actions = result.steps.map((s) => s.action);
  expect(actions).toContain("fill");
  expect(actions).toContain("click");

  // The ladder prefers role+name over label, and testId over everything.
  const fillStep = result.steps.find((s) => s.action === "fill")!;
  expect(fillStep.args[0]).toEqual({ role: "textbox", name: "Email" });
  expect(fillStep.args[1]).toBe("user@example.com");

  const clickStep = result.steps.find((s) => s.action === "click")!;
  expect(clickStep.args[0]).toEqual({ testId: "submit" });
  expect(result.warnings).toEqual([]);
});

it("round-trips: recorded clicks replay green", async () => {
  const session = await sessions.start(device, { headless: true });
  const recording = await recorder.start(session.sessionId, fixture);
  const page = sessions.get(session.sessionId).page;
  await page.getByLabel("Email").fill("user@example.com");
  await page.getByTestId("submit").click();
  await page.waitForTimeout(300);
  const result = await recorder.stop(recording.id, { saveAs: "scripts/recorded.js" });

  expect(await readFile(path.join(root, "scripts/recorded.js"), "utf8")).toBe(result.code);

  const runner = new Runner({ sessions, workspace: root, trawlProxyPort: 8080 });
  const started = await runner.start({
    code: `goto('${fixture}')\n` + result.code,
    device,
    env: {},
    secrets: {},
  });
  let report: RunReport = runner.get(started.runId)!;
  for (let i = 0; i < 300 && report.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    report = runner.get(started.runId)!;
  }
  expect(report.steps.find((s) => s.status === "failed")?.error).toBeUndefined();
  expect(report.status).toBe("passed");
});
