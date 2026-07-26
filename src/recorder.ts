import { randomBytes } from "node:crypto";
import type { ElementHandle, Page } from "playwright";
import { AgentError, type StepRecord, type TargetSpec } from "./types.js";
import { SessionStore } from "./sessions.js";
import { toLocator } from "./targets.js";
import { generate } from "./codegen.js";
import { writeScript } from "./workspace.js";
import { RECORDER_SOURCE } from "./recorderInject.js";

export interface Recording {
  id: string;
  sessionId: string;
  steps: StepRecord[];
  warnings: string[];
  startedAt: number;
}

export interface StopOptions {
  saveAs?: string;
  withTraffic?: boolean;
}

interface RecorderDeps {
  sessions: SessionStore;
  workspace: string;
}

interface RawEvent {
  action: string;
  candidates: TargetSpec[];
  args: unknown[];
}

const MARK = "data-trawl-rec-el";

export class RecorderStore {
  private readonly recordings = new Map<string, Recording>();

  constructor(private readonly deps: RecorderDeps) {}

  get(id: string): Recording {
    const found = this.recordings.get(id);
    if (!found) throw new AgentError("agent", `unknown recording: ${id}`);
    return found;
  }

  async start(sessionId: string, url?: string): Promise<Recording> {
    const session = this.deps.sessions.get(sessionId);
    const recording: Recording = {
      id: `rec_${randomBytes(4).toString("hex")}`,
      sessionId,
      steps: [],
      warnings: [],
      startedAt: Date.now(),
    };

    await session.context.exposeBinding("__trawlRec", async ({ page }, raw: RawEvent) => {
      try {
        const target = await this.pickTarget(page, raw.candidates, recording);
        recording.steps.push({
          index: recording.steps.length,
          action: raw.action,
          args: [target, ...raw.args],
        });
      } catch (err) {
        recording.warnings.push(`dropped ${raw.action}: ${(err as Error).message}`);
      }
    });
    await session.context.addInitScript(RECORDER_SOURCE);

    this.deps.sessions.setState(sessionId, "recording");
    if (url) await session.page.goto(url);
    else await session.page.reload();

    this.recordings.set(recording.id, recording);
    return recording;
  }

  /**
   * Playwright's own locator engine is the arbiter: the first candidate that
   * resolves to exactly one element, and to *the* marked element, wins.
   */
  private async pickTarget(page: Page, candidates: TargetSpec[], recording: Recording): Promise<TargetSpec> {
    for (const candidate of candidates) {
      try {
        const locator = toLocator(page, candidate);
        if ((await locator.count()) !== 1) continue;
        const handle = (await locator.elementHandle({ timeout: 1000 })) as ElementHandle | null;
        if (!handle) continue;
        const isMarked = await handle.evaluate((el, mark) => (el as Element).hasAttribute(mark), MARK);
        await handle.dispose();
        if (isMarked) return candidate;
      } catch {
        // try the next candidate
      }
    }
    const fallback = candidates.at(-1);
    if (!fallback) throw new AgentError("script", "no candidate target");
    recording.warnings.push(`no verified target; fell back to ${JSON.stringify(fallback)}`);
    return fallback;
  }

  async stop(
    id: string,
    options: StopOptions,
  ): Promise<{ steps: StepRecord[]; code: string; warnings: string[]; scriptPath?: string }> {
    const recording = this.get(id);
    const session = this.deps.sessions.get(recording.sessionId);
    await session.page
      .evaluate(() =>
        (window as unknown as { __trawlRecorderControl?: (c: string) => void }).__trawlRecorderControl?.("flush"),
      )
      .catch(() => {});
    await session.page.waitForTimeout(150);

    this.recordings.delete(id);
    this.deps.sessions.setState(recording.sessionId, "idle");

    const code = generate(recording.steps, { header: "recorded by trawl-devices-agent" });
    if (options.saveAs) await writeScript(this.deps.workspace, options.saveAs, code);
    return {
      steps: recording.steps,
      code,
      warnings: recording.warnings,
      ...(options.saveAs ? { scriptPath: options.saveAs } : {}),
    };
  }
}
