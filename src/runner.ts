import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Locator } from "playwright";
import { AgentError, type Device, type RunReport, type StepResult, type TargetSpec } from "./types.js";
import { runInSandbox } from "./sandbox.js";
import { describeTarget, isRegExp, resolveTarget, toLocator, toMatcher } from "./targets.js";
import { SessionStore } from "./sessions.js";
import { readScript, runDir, statePath } from "./workspace.js";
import { TrafficBuffer, describeMatcher, parseMatcher, type MatcherObject } from "./traffic.js";
import { interpolate } from "./interpolate.js";
import { makeMasker } from "./mask.js";
import { captureFrames, installCursor, type FrameCapture } from "./frames.js";

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
  /** Overrides the port configured at startup — the plugin knows the live one. */
  trawlProxyPort?: number;
  /** Per-run overrides of the device's own settings. */
  stepDelayMs?: number;
  closeAfterRun?: boolean;
  /** Marks this run's traffic so Trawl rules can scope themselves to it. */
  runTag?: string;
}

interface RunState {
  report: RunReport;
  cancelled: boolean;
}

const DEFAULT_TIMEOUT = 15_000;
const MAX_SCRIPT_MS = 10 * 60_000;
const MAX_RUN_DEPTH = 10;
/** How long to wait on the primary target before trying a fallback. */
const HEAL_PROBE_MS = 3_000;

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
              trawlProxyPort: input.trawlProxyPort ?? this.deps.trawlProxyPort,
              headless: input.headless ?? input.device.headless,
              videoDir: input.device.video ? dir : undefined,
            })
          ).sessionId,
        );

    this.deps.sessions.setState(session.sessionId, "running");
    const page = session.page;
    const traceOn = input.device.trace !== "off";
    if (traceOn) await session.context.tracing.start({ screenshots: true, snapshots: true });

    // A recorded replay is only useful if you can see where the pointer went.
    let frames: FrameCapture | null = null;
    if (input.device.video) {
      await installCursor(session.context).catch(() => {});
      frames = await captureFrames(page, path.join(dir, "frames"), input.device.videoFps ?? 5).catch(
        () => null,
      );
      if (!frames) report.warnings.push("frame capture failed to start");
    }

    let timeout = DEFAULT_TIMEOUT;
    let baseUrl = "";
    const stepDelayMs = Math.max(0, input.stepDelayMs ?? input.device.stepDelayMs ?? 0);
    // Composition can overlay variables for the script it calls, so the set in
    // force is per-frame rather than fixed for the whole run.
    let currentEnv: Record<string, string> = { ...input.env };
    const scriptStack: string[] = input.scriptPath ? [input.scriptPath] : [];
    const closeAfterRun = input.closeAfterRun ?? input.device.closeAfterRun ?? true;
    let current: StepResult | null = null;
    let currentName: string | undefined;

    const traffic = new TrafficBuffer();
    const detachTraffic = await TrafficBuffer.attach(
      session.context,
      report.runId,
      () => (current ? current.index : report.steps.length),
      traffic,
      input.runTag,
    );

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
      async (...rawArgs: A): Promise<R> => {
        const args = rawArgs.map((a) => interpolate(a, currentEnv)) as A;
        const step = beginStep(action, args);
        try {
          const result = await body(...args);
          endStep(step);
          // A deliberate pause makes the replay watchable; it is not a wait —
          // every step already auto-waits for its target.
          if (stepDelayMs) await page.waitForTimeout(stepDelayMs);
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

    /**
     * Resolve a target, falling back to the alternatives the recorder saved.
     * A markup change that only breaks the primary should cost a warning, not
     * the run — but it is written into the report, never swallowed.
     */
    const find = async (target: TargetSpec): Promise<Locator> => {
      const resolved = await resolveTarget(page, target, Math.min(timeout, HEAL_PROBE_MS));
      if (resolved.index > 0) {
        const step = current;
        if (step) {
          step.healed = { used: resolved.used, index: resolved.index };
          report.warnings.push(
            `step ${step.index} (${step.action}): the primary target no longer matches, ` +
              `used the fallback ${describeTarget(resolved.used)}`,
          );
        }
      }
      return resolved.locator;
    };
    const url = (u: string): string => (baseUrl && u.startsWith("/") ? baseUrl.replace(/\/$/, "") + u : u);

    const assertThat = (ok: boolean, message: string, expected: string, actual: string): void => {
      if (!ok) throw new AgentError("assertion", message, { expected, actual });
    };

    const scope: Record<string, unknown> = {
      env: new Proxy(
        {},
        {
          get: (_t, key: string) => currentEnv[key],
          has: (_t, key: string) => key in currentEnv,
          ownKeys: () => Object.keys(currentEnv),
          getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        },
      ),
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
        await (await find(t)).click({ timeout });
      }),
      dblclick: tracked("dblclick", async (t: TargetSpec) => {
        await (await find(t)).dblclick({ timeout });
      }),
      fill: tracked("fill", async (t: TargetSpec, v: string) => {
        await (await find(t)).fill(v, { timeout });
      }),
      type: tracked("type", async (t: TargetSpec, v: string) => {
        await (await find(t)).pressSequentially(v, { timeout });
      }),
      press: tracked("press", async (t: TargetSpec | null, key: string) => {
        if (t) await (await find(t)).press(key, { timeout });
        else await page.keyboard.press(key);
      }),
      check: tracked("check", async (t: TargetSpec) => {
        await (await find(t)).check({ timeout });
      }),
      uncheck: tracked("uncheck", async (t: TargetSpec) => {
        await (await find(t)).uncheck({ timeout });
      }),
      select: tracked("select", async (t: TargetSpec, v: string) => {
        await (await find(t)).selectOption(v, { timeout });
      }),
      hover: tracked("hover", async (t: TargetSpec) => {
        await (await find(t)).hover({ timeout });
      }),
      upload: tracked("upload", async (t: TargetSpec, file: string) => {
        await (await find(t)).setInputFiles(path.resolve(this.deps.workspace, file), { timeout });
      }),
      drag: tracked("drag", async (from: TargetSpec, to: TargetSpec) => {
        await (await find(from)).dragTo((await find(to)), { timeout });
      }),
      scrollTo: tracked("scrollTo", async (t: TargetSpec) => {
        await (await find(t)).scrollIntoViewIfNeeded({ timeout });
      }),

      waitFor: tracked("waitFor", async (t: TargetSpec, stateName: "visible" | "hidden" | "attached" = "visible") => {
        await (await find(t)).waitFor({ state: stateName, timeout });
      }),
      waitForUrl: tracked("waitForUrl", async (pattern: string) => {
        await page.waitForURL(pattern, { timeout });
      }),
      sleep: tracked("sleep", async (ms: number) => {
        await page.waitForTimeout(ms);
      }),

      expectVisible: tracked("expectVisible", async (t: TargetSpec) => {
        await (await find(t)).waitFor({ state: "visible", timeout });
      }),
      expectHidden: tracked("expectHidden", async (t: TargetSpec) => {
        await (await find(t)).waitFor({ state: "hidden", timeout });
      }),
      expectText: tracked("expectText", async (t: TargetSpec, expected: string | RegExp) => {
        const actual = ((await (await find(t)).textContent({ timeout })) ?? "").trim();
        const matcher = toMatcher(expected as never);
        const ok = isRegExp(matcher) ? matcher.test(actual) : actual === matcher;
        assertThat(ok, `text of ${describeTarget(t)} does not match`, String(matcher), actual);
      }),
      expectValue: tracked("expectValue", async (t: TargetSpec, expected: string) => {
        const actual = await (await find(t)).inputValue({ timeout });
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
        const actual = await (await find(t)).count();
        assertThat(actual === expected, `count of ${describeTarget(t)} does not match`, String(expected), String(actual));
      }),
      expectAttr: tracked("expectAttr", async (t: TargetSpec, name: string, expected: string) => {
        const actual = await (await find(t)).getAttribute(name, { timeout });
        assertThat(
          actual === expected,
          `attribute ${name} of ${describeTarget(t)} does not match`,
          expected,
          String(actual),
        );
      }),

      expectRequest: tracked("expectRequest", async (matcher: string | MatcherObject) => {
        await traffic.consume(parseMatcher(matcher), timeout);
      }),
      waitForResponse: tracked("waitForResponse", async (matcher: string | MatcherObject) => {
        await traffic.consume(parseMatcher(matcher), timeout);
      }),
      expectResponse: tracked(
        "expectResponse",
        async (
          matcher: string | MatcherObject,
          options: { status?: number; jsonPath?: Record<string, string | RegExp>; headerContains?: string } = {},
        ) => {
          const hit = await traffic.consume(parseMatcher(matcher), timeout);
          if (options.status !== undefined && hit.status !== options.status) {
            throw new AgentError("assertion", `status of ${describeMatcher(parseMatcher(matcher))} does not match`, {
              expected: String(options.status),
              actual: String(hit.status),
            });
          }
          if (options.jsonPath) {
            const text = (await hit.responseBody()) ?? "";
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              throw new AgentError("assertion", "response body is not JSON", {
                expected: "JSON",
                actual: text.slice(0, 120),
              });
            }
            for (const [pointer, expected] of Object.entries(options.jsonPath)) {
              const actual = readJsonPath(parsed, pointer);
              const matcherValue = toMatcher(expected as never);
              const ok = isRegExp(matcherValue) ? matcherValue.test(String(actual)) : actual === matcherValue;
              if (!ok) {
                throw new AgentError("assertion", `${pointer} does not match`, {
                  expected: String(matcherValue),
                  actual: JSON.stringify(actual),
                });
              }
            }
          }
        },
      ),
      expectNoRequest: tracked("expectNoRequest", async (matcher: string | MatcherObject) => {
        const since = current ? current.index : 0;
        const hits = traffic.seenSince(since, parseMatcher(matcher));
        if (hits.length) {
          throw new AgentError("assertion", `unexpected request ${describeMatcher(parseMatcher(matcher))}`, {
            expected: "no request",
            actual: `${hits.length} request(s)`,
          });
        }
      }),

      getText: tracked("getText", async (t: TargetSpec) => ((await (await find(t)).textContent({ timeout })) ?? "").trim()),
      getValue: tracked("getValue", async (t: TargetSpec) => (await find(t)).inputValue({ timeout })),
      getAttr: tracked("getAttr", async (t: TargetSpec, name: string) => (await find(t)).getAttribute(name, { timeout })),
      getUrl: tracked("getUrl", async () => page.url()),
      count: tracked("count", async (t: TargetSpec) => (await find(t)).count()),

      screenshot: tracked("screenshot", async (name?: string) => {
        const file = `${name ?? `shot-${report.steps.length}`}.png`;
        await page.screenshot({ path: path.join(dir, file) });
      }),
      note: tracked("note", async () => {}),

      /** Sign in once, reuse everywhere: cookies and localStorage to a file. */
      saveState: tracked("saveState", async (name: string = "auth") => {
        const file = statePath(this.deps.workspace, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await session.context.storageState({ path: file });
      }),

      /**
       * Load a saved sign-in into the running browser. Cookies apply at once;
       * localStorage is seeded per origin, which needs a page on that origin —
       * so this is normally the step right after the first goto.
       */
      useState: tracked("useState", async (name: string = "auth") => {
        const file = statePath(this.deps.workspace, name);
        const raw = await fs.readFile(file, "utf8").catch(() => {
          throw new AgentError("script", `no saved state: ${name} — call saveState('${name}') first`);
        });
        const state = JSON.parse(raw) as {
          cookies?: Parameters<typeof session.context.addCookies>[0];
          origins?: { origin: string; localStorage: { name: string; value: string }[] }[];
        };

        if (state.cookies?.length) await session.context.addCookies(state.cookies);

        const current = new URL(page.url() === "about:blank" ? "http://localhost" : page.url()).origin;
        const forHere = state.origins?.find((o) => o.origin === current);
        if (forHere) {
          await page.evaluate((entries) => {
            for (const { name: key, value } of entries) window.localStorage.setItem(key, value);
          }, forHere.localStorage);
        }
      }),

      // Mocks are applied by Trawl's proxy — the rules were created before this
      // run started. Recording the step keeps the report honest about intent.
      mock: tracked("mock", async () => {}),
      unmock: tracked("unmock", async () => {}),

      /** Compose scenarios: record login once, then call it from the rest. */
      run: async (relPath: string, overlay?: Record<string, string>): Promise<void> => {
        const step = beginStep("run", overlay ? [relPath, overlay] : [relPath]);
        endStep(step);

        if (scriptStack.includes(relPath)) {
          throw new AgentError("script", `run cycle: ${[...scriptStack, relPath].join(" → ")}`);
        }
        if (scriptStack.length >= MAX_RUN_DEPTH) {
          throw new AgentError("script", `run nested deeper than ${MAX_RUN_DEPTH}`);
        }

        const code = await readScript(this.deps.workspace, relPath).catch(() => {
          throw new AgentError("script", `no such script: ${relPath}`);
        });

        const previousEnv = currentEnv;
        const previousName = currentName;
        currentEnv = overlay ? { ...currentEnv, ...overlay } : currentEnv;
        currentName = relPath;
        scriptStack.push(relPath);
        try {
          await runInSandbox(code, scope, MAX_SCRIPT_MS);
        } finally {
          scriptStack.pop();
          currentEnv = previousEnv;
          currentName = previousName;
        }
      },
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

    // Kept out of `report` until the artifacts are on disk: a poller that sees
    // a final status must be able to read the report and its screenshots.
    let finalStatus: RunReport["status"] = "running";

    try {
      await runInSandbox(input.code, scope, MAX_SCRIPT_MS);
      finalStatus = "passed";
    } catch (err) {
      const kind = err instanceof AgentError ? err.kind : "script";
      finalStatus = kind === "assertion" || kind === "timeout" ? "failed" : "error";
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
      await detachTraffic();
      for (const observed of traffic.all()) {
        const step = report.steps[observed.step];
        if (step) step.flows.push({ method: observed.method, url: observed.url, status: observed.status });
      }
      if (frames) {
        const { count, fps } = await frames.stop();
        if (count > 0) report.artifacts.frames = { dir: "frames", count, fps };
      }
      if (traceOn) {
        const keep = input.device.trace === "always" || finalStatus !== "passed";
        const tracePath = path.join(dir, "trace.zip");
        await session.context.tracing.stop(keep ? { path: tracePath } : {}).catch(() => {});
        if (keep) report.artifacts.trace = "trace.zip";
      }
      report.durationMs = Date.now() - report.startedAt;
      if (ownSession && closeAfterRun) {
        await this.deps.sessions.stop(session.sessionId);
      } else {
        this.deps.sessions.setState(session.sessionId, "idle");
        report.sessionId = session.sessionId; // the window is still on screen
      }

      const mask = makeMasker(input.secrets);
      const finished = mask({ ...report, status: finalStatus }) as RunReport;
      await fs.writeFile(path.join(dir, "report.json"), JSON.stringify(finished, null, 2), "utf8").catch(() => {});
      state.report = finished;
    }
  }
}

/** Supports the `$.a.b[0]` subset — enough for response assertions. */
function readJsonPath(value: unknown, pointer: string): unknown {
  const parts = pointer.replace(/^\$\.?/, "").split(/[.[\]]+/).filter(Boolean);
  let node: unknown = value;
  for (const part of parts) {
    if (node === null || node === undefined) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}
