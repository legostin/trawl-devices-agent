import vm from "node:vm";
import { AgentError, type StepRecord } from "./types.js";
import { addAwaits, hasBranching, unknownCalls } from "./transform.js";
import { ALLOWED_GLOBALS, STEP_NAMES } from "./steps.js";

export interface CollectError {
  kind: "syntax" | "unknown-step" | "runtime";
  message: string;
}

export interface CollectResult {
  steps: StepRecord[];
  approximate: boolean;
  errors: CollectError[];
}

const MAX_COLLECTED_STEPS = 5000;

/** Execute `code` with `scope` as its only globals. Steps are awaited automatically. */
export async function runInSandbox(
  code: string,
  scope: Record<string, unknown>,
  timeoutMs: number,
): Promise<void> {
  const transformed = addAwaits(code, STEP_NAMES);
  const context = vm.createContext({ ...scope, console });
  const wrapped = `(async () => {\n${transformed}\n})()`;
  try {
    await vm.runInContext(wrapped, context, { timeout: timeoutMs, displayErrors: true });
  } catch (err) {
    if (err instanceof AgentError) throw err;
    const message = (err as Error).message;
    if (/Script execution timed out/i.test(message)) {
      throw new AgentError("timeout", `script exceeded ${timeoutMs}ms`);
    }
    throw new AgentError("script", message);
  }
}

/**
 * Run the script with no-op steps to learn its structure without a browser.
 *
 * Async because the transform awaits every step: the recorded steps only land
 * once the microtask queue drains. A synchronous runaway loop is cut by the vm
 * timeout, an asynchronous one by MAX_COLLECTED_STEPS.
 */
export async function collect(code: string): Promise<CollectResult> {
  const errors: CollectError[] = [];
  const steps: StepRecord[] = [];

  let approximate = false;
  try {
    approximate = hasBranching(code);
    for (const name of unknownCalls(code, STEP_NAMES, ALLOWED_GLOBALS)) {
      errors.push({ kind: "unknown-step", message: `unknown step: ${name}` });
    }
  } catch (err) {
    return { steps, approximate: false, errors: [{ kind: "syntax", message: (err as Error).message }] };
  }
  if (errors.length) return { steps, approximate, errors };

  let currentName: string | undefined;
  const record =
    (action: string) =>
    async (...args: unknown[]): Promise<unknown> => {
      if (steps.length >= MAX_COLLECTED_STEPS) throw new AgentError("script", "too many steps");
      steps.push({ index: steps.length, action, args, ...(currentName ? { name: currentName } : {}) });
      return action.startsWith("get") ? "" : action === "count" ? 0 : undefined;
    };

  const scope: Record<string, unknown> = {};
  for (const name of STEP_NAMES) scope[name] = record(name);
  scope.step = async (name: string, fn?: () => unknown): Promise<void> => {
    steps.push({ index: steps.length, action: "step", args: [name] });
    const previous = currentName;
    currentName = name;
    try {
      await fn?.();
    } finally {
      currentName = previous;
    }
  };
  scope.secret = (name: string) => `«${name}»`;
  scope.env = new Proxy({}, { get: () => "" });

  try {
    const transformed = addAwaits(code, STEP_NAMES);
    const context = vm.createContext(scope);
    // The timeout only covers synchronous execution; the step cap covers the rest.
    await vm.runInContext(`(async () => {\n${transformed}\n})()`, context, { timeout: 1000 });
  } catch (err) {
    errors.push({ kind: "runtime", message: (err as Error).message });
  }

  return { steps, approximate, errors };
}
