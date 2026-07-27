import { randomBytes } from "node:crypto";
import { AgentError, type StepRecord, type TargetSpec } from "./types.js";
import { SessionStore, type LiveSession } from "./sessions.js";
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
  /** Steps kept in page-event order; `steps` is rebuilt from this. */
  pending: PendingStep[];
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
  /** Verified in the page, best first — see recorderInject. */
  targets: TargetSpec[];
  /** Used only when nothing verified: better a brittle path than no step. */
  fallbackCss: string;
  args: unknown[];
  /** When the event happened in the page, and its order among page events. */
  ts: number;
  seq: number;
}

interface PendingStep {
  ts: number;
  action: string;
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
  /** Sessions already wired for recording: a binding can only be exposed once
   *  per context, so a second recording must reuse it, not re-register it. */
  private readonly wired = new Set<string>();
  /** Which recording a session's events belong to right now. */
  private readonly active = new Map<string, Recording>();

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
      pending: [],
    };

    this.active.set(sessionId, recording);

    if (!this.wired.has(sessionId)) {
      this.wired.add(sessionId);
      await this.wire(sessionId, session);
    }

    this.deps.sessions.setState(sessionId, "recording");
    if (url) {
      await session.page.goto(url);
    } else {
      // Recording a fragment of a session already in progress: install into the
      // live page instead of reloading, which would throw away where the human
      // has got to — the whole point of starting here rather than at the login.
      await session.page.evaluate(RECORDER_SOURCE).catch(async () => {
        await session.page.reload();
      });
    }

    this.recordings.set(recording.id, recording);
    return recording;
  }

  /** Binding and listeners, installed once per session. */
  private async wire(sessionId: string, session: LiveSession): Promise<void> {
    await session.context.exposeBinding("__trawlRec", async (_source, raw: RawEvent) => {
      const recording = this.active.get(sessionId);
      if (!recording) return; // events after a stop belong to nobody
      const [primary, ...rest] = raw.targets ?? [];
      if (!primary) {
        recording.warnings.push(
          `no verified target for ${raw.action}; fell back to a css path — check that step`,
        );
      }
      const alternatives = rest.slice(0, MAX_ALTERNATIVES);
      const target: TargetSpec = primary
        ? alternatives.length
          ? { ...primary, or: alternatives }
          : primary
        : { css: raw.fallbackCss };

      // Only the primary matters here: a fallback pinned by position is fine,
      // it is only reached once the primary stops matching.
      if (primary?.nth !== undefined) {
        recording.warnings.push(
          `matched by position: ${JSON.stringify(primary ?? target)} — check it if the list can reorder`,
        );
      }

      this.record(recording, { ts: raw.ts, action: raw.action, args: [target, ...raw.args] });
    });
    await session.context.addInitScript(RECORDER_SOURCE);

    // Addresses the human opens are steps too: without them a replay has no
    // idea where to start.
    session.page.on("framenavigated", (frame) => {
      const recording = this.active.get(sessionId);
      if (!recording) return;
      if (frame !== session.page.mainFrame()) return;
      const url = frame.url();
      if (!isRecordableUrl(url) || url === recording.lastUrl) return;
      recording.lastUrl = url;
      // A click we already recorded is what caused this navigation — recording
      // a goto as well would replay the click and then jump past its result.
      if (Date.now() - recording.lastStepAt < NAVIGATION_GRACE_MS) return;
      this.record(recording, { ts: Date.now(), action: "goto", args: [url] });
    });
  }

  /**
   * Steps are kept in the order things happened in the page. A click that
   * navigates is reported after its own navigation event otherwise, and the
   * replay then looks for the link on the page the click led to.
   */
  private record(recording: Recording, step: PendingStep): void {
    const at = recording.pending.findIndex((s) => s.ts > step.ts);
    if (at < 0) recording.pending.push(step);
    else recording.pending.splice(at, 0, step);
    recording.lastStepAt = Math.max(recording.lastStepAt, step.ts);

    recording.steps = recording.pending.map((s, index) => ({
      index,
      action: s.action,
      args: s.args,
    }));
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
    this.active.delete(recording.sessionId);
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
