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

  // Sections come from where the recording changed screen. They are printed as
  // step() blocks because the DSL already has one and the report already groups
  // by it — no new syntax buys the same thing.
  const body: string[] = [];
  let section: string | undefined;
  for (const s of steps) {
    if (SETUP.has(s.action)) continue;
    if (s.section !== section) {
      if (section !== undefined) body.push("})");
      section = s.section;
      if (section !== undefined) body.push(`step(${formatArg(section)}, () => {`);
    }
    body.push(section === undefined ? line(s) : `  ${line(s)}`);
  }
  if (section !== undefined) body.push("})");

  const chunks: string[] = [];
  if (options.header) chunks.push(`// ${options.header}`);
  if (setup.length) chunks.push(setup.join("\n"), "");
  chunks.push(body.join("\n"));
  return chunks.join("\n").replace(/\n+$/, "") + "\n";
}
