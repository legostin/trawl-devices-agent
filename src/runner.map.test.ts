import { expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Runner } from "./runner.js";
import { SessionStore } from "./sessions.js";
import { MapStore } from "./mapStore.js";
import { validateDevice } from "./devices.js";
import type { RunReport } from "./types.js";

const choices = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/choices.html"),
).href;

const device = validateDevice({ id: "t", name: "T", headless: true, proxy: { mode: "none" }, trace: "off" });
let sessions: SessionStore;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "runmap-"));
  sessions = new SessionStore();
  const store = new MapStore(root);
  await store.saveScreen({
    version: 1,
    id: "harakteristiki",
    label: "Характеристики",
    match: { url: "**/choices.html" },
    elements: {
      god: {
        label: "Год",
        kind: "choice",
        group: { css: "#years" },
        option: { role: "radio" },
        source: "recorded",
        status: "accepted",
        updatedAt: "2026-07-27T09:00:00.000Z",
      },
      podat: {
        label: "Подать объявление",
        kind: "control",
        target: { role: "button", name: "Подать объявление" },
        source: "recorded",
        status: "accepted",
        updatedAt: "2026-07-27T09:00:00.000Z",
      },
    },
  });
});
afterEach(async () => {
  await sessions.stopAll();
  await rm(root, { recursive: true, force: true });
});

async function runToCompletion(code: string): Promise<RunReport> {
  const runner = new Runner({ sessions, workspace: root, trawlProxyPort: 8080 });
  const started = await runner.start({ code, device, env: {}, secrets: {} });
  let report = runner.get(started.runId)!;
  for (let i = 0; i < 300 && report.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    report = runner.get(started.runId)!;
  }
  return report;
}

it("runs a scenario written entirely in names", async () => {
  const report = await runToCompletion(
    `goto('${choices}')\nselect('Год', '2010')\nclick('Подать объявление')\n`,
  );
  expect(report.steps.find((s) => s.status === "failed")?.error).toBeUndefined();
  expect(report.status).toBe("passed");
});

it("reports which screen each step ran on", async () => {
  const report = await runToCompletion(`goto('${choices}')\nclick('Подать объявление')\n`);
  expect(report.steps.at(-1)!.screen).toBe("Характеристики");
});

it("a literal target still works next to a name", async () => {
  const report = await runToCompletion(
    `goto('${choices}')\nclick({ role: 'button', name: 'Подать объявление' })\nclick('Подать объявление')\n`,
  );
  expect(report.status).toBe("passed");
});

it("an unknown name fails as a script error, naming what is near", async () => {
  const report = await runToCompletion(`goto('${choices}')\nclick('Годик')\n`);
  expect(report.status).toBe("error");
  expect(report.steps.at(-1)!.error?.kind).toBe("script");
  expect(report.steps.at(-1)!.error?.message).toContain("Год");
});

it("opens a screen by name", async () => {
  const store = new MapStore(root);
  await store.saveScreen({
    version: 1,
    id: "harakteristiki",
    label: "Характеристики",
    match: { url: "**/choices.html" },
    open: { url: choices },
    elements: {
      podat: {
        label: "Подать объявление",
        kind: "control",
        target: { role: "button", name: "Подать объявление" },
        source: "recorded",
        status: "accepted",
        updatedAt: "2026-07-27T09:00:00.000Z",
      },
    },
  });

  const report = await runToCompletion(`open('Характеристики')\nclick('Подать объявление')\n`);
  expect(report.status).toBe("passed");
  expect(report.steps[0]!.action).toBe("open");
});

it("says so when a screen has no way in", async () => {
  const report = await runToCompletion(`open('Характеристики')\n`);
  expect(report.steps.at(-1)!.error?.message).toMatch(/не задано, как на него попасть/);
});
