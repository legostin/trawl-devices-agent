/** The DSL vocabulary — the single source of truth. Bump DSL_VERSION when it changes. */
export const STEP_NAMES = [
  // setup
  "device", "use",
  // navigation
  "goto", "back", "forward", "reload",
  // actions
  "click", "dblclick", "fill", "type", "press", "check", "uncheck",
  "select", "hover", "upload", "drag", "scrollTo",
  // waits
  "waitFor", "waitForUrl", "waitForResponse", "sleep",
  // UI assertions
  "expectVisible", "expectHidden", "expectText", "expectValue",
  "expectUrl", "expectCount", "expectAttr",
  // HTTP assertions
  "expectRequest", "expectResponse", "expectNoRequest",
  // reads
  "getText", "getValue", "getAttr", "getUrl", "count",
  // composition
  "run",
  // misc
  "step", "screenshot", "note",
] as const;

export type StepName = (typeof STEP_NAMES)[number];

/** Globals a script may call that are not steps. `secret` and `env` come from the run scope. */
export const ALLOWED_GLOBALS = [
  "console", "JSON", "Math", "Number", "String", "Boolean", "Array", "Object",
  "Date", "RegExp", "parseInt", "parseFloat", "isNaN", "secret",
] as const;
