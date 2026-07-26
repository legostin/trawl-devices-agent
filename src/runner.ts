import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Locator } from "playwright";
import { AgentError, type Device, type RunReport, type StepResult, type TargetSpec } from "./types.js";
import { runInSandbox } from "./sandbox.js";
import { describeTarget, isRegExp, toLocator, toMatcher } from "./targets.js";
import { SessionStore } from "./sessions.js";
import { runDir } from "./workspace.js";

export interface RunnerDeps {
  sessions: SessionStore;
  workspace: string;
  trawlProxyPort: number;
}

export interface StartRunInput {
  code: string;
  scriptPath?: string;
  device: Device;
  /** Reuse an open session instead of launching a fresh context. */
  sessionId?: string;
  env: Record<string, string>;
  secrets: Record<string, string>;
  headless?: boolean;
}

interface RunState {
  report: RunReport;
  cancelled: boolean;
}

const DEFAULT_TIMEOUT = 15_000;
const MAX_SCRIPT_MS = 10 * 60_000;

export class Runner {
  private readonly runs = new Map<string, RunState>();

  constructor(private readonly deps: RunnerDeps) {}

  get(runId: string): RunReport | undefined {
    return this.runs.get(runId)?.report;
  }

  list(limit = 20): RunReport[] {
    return [...this.runs.values()]
      .map((r) => r.report)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  cancel(runId: string): boolean {
    const state = this.runs.get(runId);
    if (!state || state.report.status !== "running") return false;
    state.cancelled = true;
    return true;
  }

  /** Starts the run in the background and returns the initial report. */
  async start(input: StartRunInput): Promise<RunReport> {
    const runId = `r_${randomBytes(4).toString("hex")}`;
    const report: RunReport = {
      runId,
      script: input.scriptPath ?? null,
      device: input.device.id,
      status: "running",
      startedAt: Date.now(),
      durationMs: 0,
      steps: [],
      artifacts: { trace: null, video: null },
      warnings: [],
    };
    const state: RunState = { report, cancelled: false };
    this.runs.set(runId, state);
    void this.execute(input, state).catch((err) => {
      state.report.status = "error";
      state.report.warnings.push(`runner crashed: ${(err as Error).message}`);
    });
    return report;
  }

  private async execute(input: StartRunInput, state: RunState): Promise<void> {
    const { report } = state;
    const dir = runDir(this.deps.workspace, report.runId);
    await fs.mkdir(dir, { recursive: true });

    const ownSession = !input.sessionId;
    const session = input.sessionId
      ? this.deps.sessions.get(input.sessionId)
      : this.deps.sessions.get(
          (
            await this.deps.sessions.start(input.device, {
              trawlProxyPort: this.deps.trawlProxyPort,
              headless: input.headless ?? input.device.headless,
              videoDir: input.device.video ? dir : undefined,
            })
          ).sessionId,
        );

    this.deps.sessions.setState(session.sessionId, "running");
    const page = session.page;
    const traceOn = input.device.trace !== "off";
    if (traceOn) await session.context.tracing.start({ screenshots: true, snapshots: true });

    let timeout = DEFAULT_TIMEOUT;
    let baseUrl = "";
    let current: StepResult | null = null;
    let currentName: string | undefined;

    const beginStep = (action: string, args: unknown[]): StepResult => {
      if (state.cancelled) throw new AgentError("script", "run cancelled");
      const step: StepResult = {
        index: report.steps.length,
        action,
        args,
        ...(currentName ? { name: currentName } : {}),
        status: "passed",
        startedAt: Date.now(),
        durationMs: 0,
        flows: [],
      };
      report.steps.push(step);
      current = step;
      return step;
    };

    const endStep = (step: StepResult): void => {
      step.durationMs = Date.now() - step.startedAt;
    };

    /** Wraps a step body: timing, failure classification, screenshot on failure. */
    const tracked =
      <A extends unknown[], R>(action: string, body: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        const step = beginStep(action, args);
        try {
          const result = await body(...args);
          endStep(step);
          return result;
        } catch (err) {
          const agentErr =
            err instanceof AgentError
              ? err
              : new AgentError(
                  /Timeout .* exceeded/i.test((err as Error).message) ? "timeout" : "script",
                  (err as Error).message,
                );
          step.status = "failed";
          step.error = { kind: agentErr.kind, message: agentErr.message, ...(agentErr.detail ?? {}) };
          const shot = `step-${String(step.index).padStart(2, "0")}.png`;
          await page.screenshot({ path: path.join(dir, shot) }).then(
            () => {
              step.screenshot = shot;
            },
            () => {
              report.warnings.push(`screenshot failed for step ${step.index}`);
            },
          );
          endStep(step);
          throw agentErr;
        }
      };

    const locate = (target: TargetSpec): Locator => toLocator(page, target);
    const url = (u: string): string => (baseUrl && u.startsWith("/") ? baseUrl.replace(/\/$/, "") + u : u);

    const assertThat = (ok: boolean, message: string, expected: string, actual: string): void => {
      if (!ok) throw new AgentError("assertion", message, { expected, actual });
    };

    const scope: Record<string, unknown> = {
      env: input.env,
      secret: (name: string): string => {
        const value = input.secrets[name];
        if (value === undefined) throw new AgentError("script", `secret not provided: ${name}`);
        return value;
      },

      device: tracked("device", async () => {}),
      use: tracked("use", async (options: { baseUrl?: string; timeout?: number }) => {
        if (options?.baseUrl) baseUrl = options.baseUrl;
        if (options?.timeout) timeout = options.timeout;
      }),

      goto: tracked("goto", async (u: string) => {
        await page.goto(url(u), { timeout });
      }),
      back: tracked("back", async () => {
        await page.goBack({ timeout });
      }),
      forward: tracked("forward", async () => {
        await page.goForward({ timeout });
      }),
      reload: tracked("reload", async () => {
        await page.reload({ timeout });
      }),

      click: tracked("click", async (t: TargetSpec) => {
        await locate(t).click({ timeout });
      }),
      dblclick: tracked("dblclick", async (t: TargetSpec) => {
        await locate(t).dblclick({ timeout });
      }),
      fill: tracked("fill", async (t: TargetSpec, v: string) => {
        await locate(t).fill(v, { timeout });
      }),
      type: tracked("type", async (t: TargetSpec, v: string) => {
        await locate(t).pressSequentially(v, { timeout });
      }),
      press: tracked("press", async (t: TargetSpec | null, key: string) => {
        if (t) await locate(t).press(key, { timeout });
        else await page.keyboard.press(key);
      }),
      check: tracked("check", async (t: TargetSpec) => {
        await locate(t).check({ timeout });
      }),
      uncheck: tracked("uncheck", async (t: TargetSpec) => {
        await locate(t).uncheck({ timeout });
      }),
      select: tracked("select", async (t: TargetSpec, v: string) => {
        await locate(t).selectOption(v, { timeout });
      }),
      hover: tracked("hover", async (t: TargetSpec) => {
        await locate(t).hover({ timeout });
      }),
      upload: tracked("upload", async (t: TargetSpec, file: string) => {
        await locate(t).setInputFiles(path.resolve(this.deps.workspace, file), { timeout });
      }),
      drag: tracked("drag", async (from: TargetSpec, to: TargetSpec) => {
        await locate(from).dragTo(locate(to), { timeout });
      }),
      scrollTo: tracked("scrollTo", async (t: TargetSpec) => {
        await locate(t).scrollIntoViewIfNeeded({ timeout });
      }),

      waitFor: tracked("waitFor", async (t: TargetSpec, stateName: "visible" | "hidden" | "attached" = "visible") => {
        await locate(t).waitFor({ state: stateName, timeout });
      }),
      waitForUrl: tracked("waitForUrl", async (pattern: string) => {
        await page.waitForURL(pattern, { timeout });
      }),
      sleep: tracked("sleep", async (ms: number) => {
        await page.waitForTimeout(ms);
      }),

      expectVisible: tracked("expectVisible", async (t: TargetSpec) => {
        await locate(t).waitFor({ state: "visible", timeout });
      }),
      expectHidden: tracked("expectHidden", async (t: TargetSpec) => {
        await locate(t).waitFor({ state: "hidden", timeout });
      }),
      expectText: tracked("expectText", async (t: TargetSpec, expected: string | RegExp) => {
        const actual = ((await locate(t).textContent({ timeout })) ?? "").trim();
        const matcher = toMatcher(expected as never);
        const ok = isRegExp(matcher) ? matcher.test(actual) : actual === matcher;
        assertThat(ok, `text of ${describeTarget(t)} does not match`, String(matcher), actual);
      }),
      expectValue: tracked("expectValue", async (t: TargetSpec, expected: string) => {
        const actual = await locate(t).inputValue({ timeout });
        assertThat(actual === expected, `value of ${describeTarget(t)} does not match`, expected, actual);
      }),
      expectUrl: tracked("expectUrl", async (pattern: string) => {
        try {
          await page.waitForURL(pattern, { timeout });
        } catch {
          throw new AgentError("assertion", "url does not match", { expected: pattern, actual: page.url() });
        }
      }),
      expectCount: tracked("expectCount", async (t: TargetSpec, expected: number) => {
        const actual = await locate(t).count();
        assertThat(actual === expected, `count of ${describeTarget(t)} does not match`, String(expected), String(actual));
      }),
      expectAttr: tracked("expectAttr", async (t: TargetSpec, name: string, expected: string) => {
        const actual = await locate(t).getAttribute(name, { timeout });
        assertThat(
          actual === expected,
          `attribute ${name} of ${describeTarget(t)} does not match`,
          expected,
          String(actual),
        );
      }),

      getText: tracked("getText", async (t: TargetSpec) => ((await locate(t).textContent({ timeout })) ?? "").trim()),
      getValue: tracked("getValue", async (t: TargetSpec) => locate(t).inputValue({ timeout })),
      getAttr: tracked("getAttr", async (t: TargetSpec, name: string) => locate(t).getAttribute(name, { timeout })),
      getUrl: tracked("getUrl", async () => page.url()),
      count: tracked("count", async (t: TargetSpec) => locate(t).count()),

      screenshot: tracked("screenshot", async (name?: string) => {
        const file = `${name ?? `shot-${report.steps.length}`}.png`;
        await page.screenshot({ path: path.join(dir, file) });
      }),
      note: tracked("note", async () => {}),
      step: async (name: string, fn?: () => Promise<void>): Promise<void> => {
        const step = beginStep("step", [name]);
        endStep(step);
        const previous = currentName;
        currentName = name;
        try {
          await fn?.();
        } finally {
          currentName = previous;
        }
      },
    };

    try {
      await runInSandbox(input.code, scope, MAX_SCRIPT_MS);
      report.status = "passed";
    } catch (err) {
      const kind = err instanceof AgentError ? err.kind : "script";
      report.status = kind === "assertion" || kind === "timeout" ? "failed" : "error";
      if (!report.steps.some((s) => s.status === "failed")) {
        // The script threw outside a step (e.g. a bare `throw`).
        report.steps.push({
          index: report.steps.length,
          action: "<script>",
          args: [],
          status: "failed",
          startedAt: Date.now(),
          durationMs: 0,
          flows: [],
          error: { kind, message: (err as Error).message },
        });
      }
    } finally {
      // Steps after a failure were never executed, so they are simply absent:
      // guessing them would be a lie for any script that branches.
      if (traceOn) {
        const keep = input.device.trace === "always" || report.status !== "passed";
        const tracePath = path.join(dir, "trace.zip");
        await session.context.tracing.stop(keep ? { path: tracePath } : {}).catch(() => {});
        if (keep) report.artifacts.trace = "trace.zip";
      }
      report.durationMs = Date.now() - report.startedAt;
      if (ownSession) await this.deps.sessions.stop(session.sessionId);
      else this.deps.sessions.setState(session.sessionId, "idle");
      await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(report, null, 2), "utf8").catch(() => {});
    }
  }
}
