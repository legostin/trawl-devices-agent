export type ErrorKind = "assertion" | "timeout" | "script" | "device" | "agent";

/** An error with a kind the plugin and the report can branch on. */
export class AgentError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly detail?: { expected?: string; actual?: string },
  ) {
    super(message);
    this.name = "AgentError";
  }
}

/** JSON-transportable regular expression (scripts may also use a real RegExp). */
export interface RegexSpec {
  __regex: { source: string; flags: string };
}

export interface TargetSpec {
  testId?: string;
  role?: string;
  name?: string | RegexSpec | RegExp;
  label?: string | RegexSpec | RegExp;
  placeholder?: string | RegexSpec | RegExp;
  text?: string | RegexSpec | RegExp;
  css?: string;
  within?: TargetSpec;
  nth?: number;
  /** Fallbacks tried in order when the primary no longer resolves. */
  or?: TargetSpec[];
}

export interface Device {
  id: string;
  name: string;
  type: "browser";
  browser: "chromium" | "firefox" | "webkit";
  headless: boolean;
  viewport: { width: number; height: number };
  userAgent?: string;
  locale?: string;
  timezone?: string;
  storageStateFile?: string;
  proxy: { mode: "trawl" | "none" | "custom"; url?: string };
  ignoreHTTPSErrors: boolean;
  trace: "off" | "on-failure" | "always";
  video: boolean;
  /** Pause after each step, ms — makes a replay watchable. */
  stepDelayMs: number;
  /** Frames per second when video is on. Playwright's own video cannot be
   *  slowed down, so frames are captured instead. */
  videoFps: number;
  /** Close the browser when a run ends. Off leaves it open for inspection. */
  closeAfterRun: boolean;
  /** What this device type supports: "record" | "run" | "live" | "traffic". */
  capabilities: string[];
}

export interface Session {
  sessionId: string;
  deviceId: string;
  state: "starting" | "idle" | "recording" | "running" | "closed";
  startedAt: number;
  currentUrl: string | null;
}

/** A step as written in the script: a flat call with serialisable arguments. */
export interface StepRecord {
  index: number;
  action: string;
  args: unknown[];
  /** Set by step(name, fn) for the steps nested inside it. */
  name?: string;
}

export interface FlowRef {
  method: string;
  url: string;
  status: number | null;
}

export interface StepResult extends StepRecord {
  status: "passed" | "failed" | "skipped";
  startedAt: number;
  durationMs: number;
  error?: { kind: ErrorKind; message: string; expected?: string; actual?: string };
  /** Set when a fallback target had to be used instead of the primary. */
  healed?: { used: TargetSpec; index: number };
  screenshot?: string;
  flows: FlowRef[];
}

export interface RunReport {
  runId: string;
  /** Set when the browser was left open after the run. */
  sessionId?: string;
  script: string | null;
  device: string;
  status: "running" | "passed" | "failed" | "error";
  startedAt: number;
  durationMs: number;
  steps: StepResult[];
  artifacts: {
    trace: string | null;
    video: string | null;
    /** Directory of JPEG frames plus how to play them back. */
    frames?: { dir: string; count: number; fps: number };
  };
  warnings: string[];
}
