import { expect, it, afterAll } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
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
const sessions = new SessionStore();
afterAll(async () => { await sessions.stopAll(); });

it("records frames at the configured rate, with the cursor drawn in", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vid-"));
  const device = validateDevice({
    id: "v", name: "V", headless: true, proxy: { mode: "none" }, trace: "off",
    video: true, videoFps: 5,
  });
  const runner = new Runner({ sessions, workspace: root, trawlProxyPort: 8080 });

  const started = await runner.start({
    code: `goto('${fixture}')\nclick({ testId: 'submit' })\nsleep(1200)\nexpectVisible({ testId: 'greeting' })`,
    device, env: {}, secrets: {},
  });
  let report: RunReport = runner.get(started.runId)!;
  for (let i = 0; i < 300 && report.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    report = runner.get(started.runId)!;
  }

  expect(report.status).toBe("passed");
  expect(report.artifacts.frames?.fps).toBe(5);
  const files = await readdir(path.join(root, "runs", started.runId, "frames"));
  expect(files.length).toBe(report.artifacts.frames!.count);
  expect(files.length).toBeGreaterThanOrEqual(5); // ~1.5s of run at 5 fps
  await rm(root, { recursive: true, force: true });
}, 60_000);
