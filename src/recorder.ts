import { randomBytes } from "node:crypto";
import { AgentError, type StepRecord, type TargetSpec } from "./types.js";
import { SessionStore, type LiveSession } from "./sessions.js";
import { generate } from "./codegen.js";
import { writeScript } from "./workspace.js";
import { RECORDER_SOURCE } from "./recorderInject.js";
import { MapStore, slug } from "./mapStore.js";
import { isTooBroad, matchesScreen, screenPatternFor } from "./mapScreens.js";
import { collapse, type CollapsedStep, type GroupInfo } from "./mapCollapse.js";
import { reconcile, type Observation } from "./mapReconcile.js";
import { refParts, shortestRef } from "./mapRef.js";
import type { AppMap } from "./mapTypes.js";

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
  /** Clicks are being ignored, but the recording is still open. */
  paused: boolean;
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

export interface MapSummary {
  screens: number;
  elements: number;
  strengthened: number;
  /** What a human should look at; everything else was accepted silently. */
  review: string[];
}

interface RecorderDeps {
  sessions: SessionStore;
  workspace: string;
}

interface RawEvent {
  action: string;
  /** Verified in the page, best first — see recorderInject. */
  targets: TargetSpec[];
  /** Set when the element is one option of a fixed set — see mapCollapse. */
  group?: GroupInfo | null;
  /** What named the screen when this happened: its heading, else the title. */
  title?: string;
  /** Set when the element was inside a modal — a screen of its own. */
  dialog?: { label: string; marker: TargetSpec | null } | null;
  /** Where it sat on screen, for the thumbnail. */
  rect?: { x: number; y: number; width: number; height: number } | null;
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
  group?: GroupInfo;
  /** The page url when the step happened — sections are cut on it. */
  url?: string;
  /** What named the screen at that moment. */
  title?: string;
  /** The modal it happened in, if any. */
  dialog?: { label: string; marker: TargetSpec | null };
  /** A png of the element, taken while it was still on screen. */
  shot?: Buffer;
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

/** The screen a url belongs to: an existing one, or a candidate named after the page. */
const screenFor = (
  map: AppMap,
  url: string,
  title: string,
  dialog?: { label: string; marker: TargetSpec | null },
): { id: string; label: string; match: { url: string; marker?: TargetSpec }; open: { url: string } } => {
  // A modal is its own screen: it shares its url with the page underneath, and
  // the marker is what tells them apart. Found by id, because matching on the
  // url alone would hand it that page.
  if (dialog) {
    const id = slug(dialog.label);
    const seen = map.screens.find((s) => s.id === id);
    return {
      id,
      label: seen?.label ?? dialog.label,
      match: {
        url: (seen?.match?.url as string) ?? screenPatternFor(url),
        ...(dialog.marker ? { marker: dialog.marker } : {}),
      },
      open: { url: seen?.open?.url ?? url },
    };
  }
  // A screen whose pattern cannot pin a host is not reused: early recordings
  // derived `**` plus the pathname, and that screen then swallowed every screen
  // recorded after it. Re-recording must be able to fix a map, not inherit it.
  const known = map.screens.find((s) => matchesScreen(s, url) && !isTooBroad(s.match?.url ?? ""));
  if (known) {
    return {
      id: known.id,
      label: known.label,
      match: known.match as { url: string },
      open: known.open?.url ? { url: known.open.url } : { url },
    };
  }
  const label = title.trim() || screenPatternFor(url);
  // The address that was actually open is how to get back here — without it
  // open('Экран') has nothing to navigate to, and a fragment recording, which
  // starts wherever the human already was, can never replay on its own.
  return { id: slug(label), label, match: { url: screenPatternFor(url) }, open: { url } };
};

/**
 * The wording that names an element, taken off the ladder the page verified.
 * The whole ladder, not just its head: a testId wins as a locator and carries
 * no wording, while the fallback beneath it is exactly the accessible name.
 */
const labelOf = (targets: TargetSpec[]): string => {
  for (const target of targets) {
    for (const value of [target?.name, target?.label, target?.text, target?.placeholder]) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
};

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
      paused: false,
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

  /**
   * Stop taking clicks without ending the recording. What happens while paused
   * — a detour, a captcha, fixing a typo — is not part of the scenario, and
   * having to end the recording to do it is what makes people re-record.
   */
  async setPaused(id: string, paused: boolean): Promise<{ paused: boolean }> {
    const recording = this.get(id);
    const session = this.deps.sessions.get(recording.sessionId);
    const state = await session.page.evaluate((command) => {
      const control = (window as unknown as { __trawlRecorderControl?: (c: string) => { paused: boolean } })
        .__trawlRecorderControl;
      return control ? control(command) : null;
    }, paused ? "pause" : "resume");
    recording.paused = state?.paused ?? paused;
    return { paused: recording.paused };
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

      // Taken now, not at stop: a click that navigates takes the page away, and
      // then there is nothing left to photograph.
      const shot = raw.rect
        ? await session.page
            .screenshot({ clip: raw.rect, timeout: 1500 })
            .catch(() => undefined)
        : undefined;

      this.record(recording, {
        ts: raw.ts,
        action: raw.action,
        args: [target, ...raw.args],
        ...(shot ? { shot } : {}),
        url: session.page.url(),
        ...(raw.title ? { title: raw.title } : {}),
        ...(raw.dialog ? { dialog: raw.dialog } : {}),
        ...(raw.group ? { group: raw.group } : {}),
      });
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
  ): Promise<{ steps: StepRecord[]; code: string; warnings: string[]; scriptPath?: string; map: MapSummary }> {
    const recording = this.get(id);
    const session = this.deps.sessions.get(recording.sessionId);
    await session.page
      .evaluate(() =>
        (window as unknown as { __trawlRecorderControl?: (c: string) => void }).__trawlRecorderControl?.("flush"),
      )
      .catch(() => {});
    await session.page.waitForTimeout(150);
    const title = await session.page.title().catch(() => "");

    this.recordings.delete(id);
    this.active.delete(recording.sessionId);
    // The window stays open on purpose: you often want to keep clicking around
    // after stopping, and a run decides for itself whether to close it.
    if (options.closeSession === true) await this.deps.sessions.stop(recording.sessionId);
    else this.deps.sessions.setState(recording.sessionId, "idle");

    const store = new MapStore(this.deps.workspace);
    const map = await store.load();
    const summary: MapSummary = { screens: 0, elements: 0, strengthened: 0, review: [] };
    const now = new Date().toISOString();

    const collapsed = collapse(recording.pending as CollapsedStep[]);
    const steps: StepRecord[] = [];

    for (const step of collapsed) {
      // Navigation is not an element; it keeps its literal argument, and it sits
      // outside any section because it is what moves between them.
      if (step.action === "goto") {
        steps.push({ index: steps.length, action: step.action, args: step.args });
        continue;
      }

      const where = screenFor(map, step.url ?? session.page.url(), step.title ?? title, step.dialog);
      const before = map.screens.length;

      const isChoice = step.action === "select" && Boolean(step.group);
      const primary = step.args[0] as TargetSpec;
      // The ladder the page verified: the primary first, then its fallbacks.
      const targets = isChoice
        ? step.group!.targets
        : [{ ...primary, or: undefined }, ...(primary.or ?? [])];
      const observation: Observation = {
        screenId: where.id,
        screenLabel: where.label,
        screenMatch: where.match,
        screenOpen: where.open.url,
        label: isChoice ? String(step.args[0]) : labelOf(targets),
        kind: isChoice ? "choice" : "control",
        targets,
        ...(isChoice ? { option: { role: "radio" } } : {}),
      };
      const outcome = reconcile(map, observation, now);

      // The picture belongs to the entry that was just created or reused, so it
      // is attached after reconciliation decided which one that is.
      if (step.shot) {
        const screen = map.screens.find((s) => s.id === where.id);
        const found = screen && Object.entries(screen.elements).find(([, e]) => e.label === refParts(outcome.ref).element);
        if (screen && found) {
          found[1].shot = await store.saveShot(`${screen.id}-${found[0]}`, step.shot);
        }
      }
      if (map.screens.length > before) summary.screens++;
      if (outcome.created) summary.elements++;
      if (outcome.strengthened) summary.strengthened++;
      if (outcome.review) summary.review.push(outcome.review);

      steps.push({
        index: steps.length,
        action: step.action,
        // Qualified for now; shortened below, once the whole map is known and
        // it is possible to tell which names are ambiguous.
        args: [outcome.ref, ...step.args.slice(1)],
        // Sections are cut where the screen changed; codegen prints the runs.
        section: where.label,
      });
    }

    for (const screen of map.screens) await store.saveScreen(screen);

    // Now that the map is complete, drop the screen from every reference that
    // does not need one. Qualifying a unique name costs a screen's worth of
    // words to say nothing, and on a page whose heading is a marketing line it
    // costs the whole width of the row.
    for (const step of steps) {
      const reference = step.args[0];
      if (typeof reference !== "string") continue;
      const { screen, element } = refParts(reference);
      if (screen) step.args = [shortestRef(map, screen, element), ...step.args.slice(1)];
    }

    recording.steps = steps;
    const code = generate(steps, { header: "recorded by trawl-devices-agent" });
    if (options.saveAs) await writeScript(this.deps.workspace, options.saveAs, code);
    return {
      steps,
      code,
      warnings: recording.warnings,
      map: summary,
      ...(options.saveAs ? { scriptPath: options.saveAs } : {}),
    };
  }
}
