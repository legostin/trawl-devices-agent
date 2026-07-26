import { AgentError } from "./types.js";

const PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Replace {{VAR}} from `env`, deeply. Unknown variables are a script error. */
export function interpolate(value: unknown, env: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(PATTERN, (_match, name: string) => {
      const replacement = env[name];
      if (replacement === undefined) throw new AgentError("script", `unknown variable: ${name}`);
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env));
  if (value && typeof value === "object" && Object.prototype.toString.call(value) !== "[object RegExp]") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolate(v, env)]));
  }
  return value;
}
