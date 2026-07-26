import { isRegExp, isRegexSpec } from "./targets.js";
import type { StepRecord } from "./types.js";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const quote = (s: string): string =>
  `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;

export function formatArg(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return quote(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isRegExp(value)) return String(value);
  if (isRegexSpec(value)) return `/${value.__regex.source}/${value.__regex.flags}`;
  if (Array.isArray(value)) return `[${value.map(formatArg).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${IDENT.test(k) ? k : quote(k)}: ${formatArg(v)}`);
    return entries.length ? `{ ${entries.join(", ")} }` : "{}";
  }
  return "null";
}

const SETUP = new Set(["device", "use"]);

export interface GenerateOptions {
  header?: string;
}

/** Steps → a runnable DSL script. Setup calls are grouped and separated by a blank line. */
export function generate(steps: StepRecord[], options: GenerateOptions = {}): string {
  const line = (s: StepRecord) => `${s.action}(${s.args.map(formatArg).join(", ")})`;
  const setup = steps.filter((s) => SETUP.has(s.action)).map(line);
  const body = steps.filter((s) => !SETUP.has(s.action)).map(line);

  const chunks: string[] = [];
  if (options.header) chunks.push(`// ${options.header}`);
  if (setup.length) chunks.push(setup.join("\n"), "");
  chunks.push(body.join("\n"));
  return chunks.join("\n").replace(/\n+$/, "") + "\n";
}
