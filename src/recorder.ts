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
  /** When the last step landed — used to tell a typed address from the
   *  navigation an already-recorded click caused. */
  lastStepAt: number;
  lastUrl: string | null;
}

/** A navigation this soon after a recorded action is that action's consequence. */
const NAVIGATION_GRACE_MS = 1500;

const isRecordableUrl = (url: string): boolean =>
  Boolean(url) && url !== "about:blank" && !url.startsWith("chrome-error://") && !url.startsWith("devtools://");

export interface StopOptions {
  saveAs?: string;
  withTraffic?: boolean;
  /** Close the browser window when the recording ends (default: keep it open). */
  closeSession?: boolean;
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

/** The in-page recorder flags candidates whose wording looks like data. */
const isDynamic = (target: TargetSpec): boolean => (target as { __dyn?: boolean }).__dyn === true;

/** Strip the flag before the target reaches a script. */
const clean = (target: TargetSpec): TargetSpec => {
  const { __dyn: _drop, ...rest } = target as TargetSpec & { __dyn?: boolean };
  return rest;
};

/** Past this, a candidate is too vague to pin down by index. */
const MAX_AMBIGUOUS_MATCHES = 30;
/** How many fallbacks to keep beside the primary target. */
const MAX_ALTERNATIVES = 2;

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
      lastStepAt: 0,
      lastUrl: null,
    };

    await session.context.exposeBinding("__trawlRec", async ({ page }, raw: RawEvent) => {
      try {
        const target = await this.pickTarget(page, raw.candidates, recording);
        recording.steps.push({
          index: recording.steps.length,
          action: raw.action,
          args: [target, ...raw.args],
        });
        recording.lastStepAt = Date.now();
      } catch (err) {
        recording.warnings.push(`dropped ${raw.action}: ${(err as Error).message}`);
      }
    });
    await session.context.addInitScript(RECORDER_SOURCE);

    // Addresses the human opens are steps too: without them a replay has no
    // idea where to start.
    session.page.on("framenavigated", (frame) => {
      if (frame !== session.page.mainFrame()) return;
      const url = frame.url();
      if (!isRecordableUrl(url) || url === recording.lastUrl) return;
      recording.lastUrl = url;
      // A click we already recorded is what caused this navigation — recording
      // a goto as well would replay the click and then jump past its result.
      if (Date.now() - recording.lastStepAt < NAVIGATION_GRACE_MS) return;
      recording.steps.push({ index: recording.steps.length, action: "goto", args: [url] });
      recording.lastStepAt = Date.now();
    });

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
    const verified = await this.verifyCandidates(page, candidates, recording);
    if (verified.length === 0) {
      const fallback = candidates.at(-1);
      if (!fallback) throw new AgentError("script", "no candidate target");
      recording.warnings.push(`no verified target; fell back to ${JSON.stringify(fallback)}`);
      return fallback;
    }
    // Keep a couple of alternatives: the replay uses them when a refactor
    // breaks the primary, instead of failing on a cosmetic change. Wording that
    // looks like data is never kept — a fallback pinned to today's order number
    // would put that number back into the scenario.
    const [primary, ...rest] = verified;
    const alternatives = rest.filter((c) => !isDynamic(c)).slice(0, MAX_ALTERNATIVES).map(clean);
    const chosen = clean(primary!);
    return alternatives.length ? { ...chosen, or: alternatives } : chosen;
  }

  /** Every candidate that resolves to the clicked element, best first. */
  private async verifyCandidates(
    page: Page,
    candidates: TargetSpec[],
    recording: Recording,
  ): Promise<TargetSpec[]> {
    const verified: TargetSpec[] = [];
    for (const candidate of candidates) {
      try {
        const locator = toLocator(page, candidate);
        const count = await locator.count();
        if (count === 0) continue;
        if (count === 1) {
          if (await this.isMarked(locator)) verified.push(candidate);
          continue;
        }
        // Ambiguous on its own, but still usable: pin it to the element that was
        // actually clicked. Recording it bare would fail the replay with a
        // strict-mode violation the moment the page has siblings like it.
        if (count > MAX_AMBIGUOUS_MATCHES) continue;
        for (let i = 0; i < count; i++) {
          if (await this.isMarked(locator.nth(i))) {
            if (verified.length === 0) {
              recording.warnings.push(
                `matched by position: ${JSON.stringify(candidate)} [${i}] — check it if the list can reorder`,
              );
            }
            verified.push({ ...candidate, nth: i });
            break;
          }
        }
      } catch {
        // try the next candidate
      }
      if (verified.length > MAX_ALTERNATIVES) break; // enough to heal with
    }
    return verified;
  }

  private async isMarked(locator: ReturnType<typeof toLocator>): Promise<boolean> {
    const handle = (await locator.elementHandle({ timeout: 1000 })) as ElementHandle | null;
    if (!handle) return false;
    try {
      return await handle.evaluate((el, mark) => (el as Element).hasAttribute(mark), MARK);
    } finally {
      await handle.dispose();
    }
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
    // The window stays open on purpose: you often want to keep clicking around
    // after stopping, and a run decides for itself whether to close it.
    if (options.closeSession === true) await this.deps.sessions.stop(recording.sessionId);
    else this.deps.sessions.setState(recording.sessionId, "idle");

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
