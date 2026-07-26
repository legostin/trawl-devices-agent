import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { AgentError, type Device, type RunReport } from "./types.js";
import { Runner } from "./runner.js";
import { readScript, resolveInWorkspace } from "./workspace.js";

/**
 * A suite is a list of scenarios run one after another, each in its own browser
 * so one failure cannot poison the next. A scenario that only passes on a retry
 * is reported as flaky rather than quietly green.
 */

export interface SuiteFile {
  name: string;
  scripts: string[];
  /** Extra attempts after a failure. 0 means one attempt. */
  retries?: number;
}

export interface SuiteScenario {
  path: string;
  /** Scopes this scenario's mock rules; the plugin creates them per scenario. */
  tag?: string;
}

export interface SuiteRunInput {
  scenarios: SuiteScenario[];
  device: Device;
  env: Record<string, string>;
  secrets: Record<string, string>;
  retries: number;
  proxyPort?: number;
  stepDelayMs?: number;
  suiteName?: string;
}

export interface ScenarioResult {
  script: string;
  runId: string | null;
  status: "pending" | "running" | "passed" | "failed" | "error";
  attempts: number;
  /** Failed at least once, then passed — the definition worth acting on. */
  flaky: boolean;
  durationMs: number;
  failedStep?: { index: number; action: string; message?: string };
}

export interface SuiteReport {
  suiteId: string;
  name: string;
  status: "running" | "passed" | "failed";
  startedAt: number;
  durationMs: number;
  results: ScenarioResult[];
}

export const suitesDir = (root: string): string => path.join(path.resolve(root), "suites");

export async function listSuites(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(suitesDir(root), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => `suites/${e.name}`)
      .sort();
  } catch {
    return [];
  }
}

export async function readSuite(root: string, rel: string): Promise<SuiteFile> {
  const raw = await fs.readFile(resolveInWorkspace(root, rel), "utf8").catch(() => {
    throw new AgentError("script", `no such suite: ${rel}`);
  });
  const parsed = JSON.parse(raw) as SuiteFile;
  if (!Array.isArray(parsed.scripts)) throw new AgentError("script", `suite ${rel} has no scripts array`);
  return parsed;
}

export async function writeSuite(root: string, rel: string, suite: SuiteFile): Promise<void> {
  const abs = resolveInWorkspace(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(suite, null, 2) + "\n", "utf8");
}

export class SuiteRunner {
  private readonly suites = new Map<string, SuiteReport>();

  constructor(
    private readonly runner: Runner,
    private readonly workspace: string,
  ) {}

  get(suiteId: string): SuiteReport | undefined {
    return this.suites.get(suiteId);
  }

  list(limit = 20): SuiteReport[] {
    return [...this.suites.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  start(input: SuiteRunInput): SuiteReport {
    const report: SuiteReport = {
      suiteId: `s_${randomBytes(4).toString("hex")}`,
      name: input.suiteName ?? "scenarios",
      status: "running",
      startedAt: Date.now(),
      durationMs: 0,
      results: input.scenarios.map((s) => ({
        script: s.path,
        runId: null,
        status: "pending",
        attempts: 0,
        flaky: false,
        durationMs: 0,
      })),
    };
    this.suites.set(report.suiteId, report);
    void this.execute(input, report).catch((err) => {
      report.status = "failed";
      report.durationMs = Date.now() - report.startedAt;
      const pending = report.results.find((r) => r.status === "pending" || r.status === "running");
      if (pending) {
        pending.status = "error";
        pending.failedStep = { index: -1, action: "<suite>", message: (err as Error).message };
      }
    });
    return report;
  }

  private async execute(input: SuiteRunInput, report: SuiteReport): Promise<void> {
    for (const [index, scenario] of input.scenarios.entries()) {
      const result = report.results[index]!;
      result.status = "running";

      for (let attempt = 1; attempt <= input.retries + 1; attempt++) {
        result.attempts = attempt;
        const run = await this.runOnce(scenario, input);
        result.runId = run.runId;
        result.durationMs += run.durationMs;

        if (run.status === "passed") {
          result.status = "passed";
          result.flaky = attempt > 1; // green now, red a moment ago
          break;
        }

        const failed = run.steps.find((s) => s.status === "failed");
        result.status = run.status === "error" ? "error" : "failed";
        result.failedStep = failed
          ? { index: failed.index, action: failed.action, message: failed.error?.message }
          : undefined;
      }
    }

    report.status = report.results.every((r) => r.status === "passed") ? "passed" : "failed";
    report.durationMs = Date.now() - report.startedAt;
  }

  private async runOnce(scenario: SuiteScenario, input: SuiteRunInput): Promise<RunReport> {
    const code = await readScript(this.workspace, scenario.path);
    const started = await this.runner.start({
      code,
      scriptPath: scenario.path,
      device: input.device,
      env: input.env,
      secrets: input.secrets,
      trawlProxyPort: input.proxyPort,
      stepDelayMs: input.stepDelayMs,
      // Every scenario gets a fresh browser: leftovers from the previous one
      // are the classic reason a suite passes alone and fails together.
      closeAfterRun: true,
      runTag: scenario.tag,
    });

    for (;;) {
      const current = this.runner.get(started.runId)!;
      if (current.status !== "running") return current;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
