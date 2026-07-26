import type { Locator, Page } from "playwright";
import { AgentError, type RegexSpec, type TargetSpec } from "./types.js";

export const isRegexSpec = (v: unknown): v is RegexSpec =>
  typeof v === "object" && v !== null && "__regex" in v;

/**
 * `instanceof RegExp` lies across realms, and scripts run inside `node:vm` —
 * their regexes come from a different realm than ours.
 */
export const isRegExp = (v: unknown): v is RegExp => Object.prototype.toString.call(v) === "[object RegExp]";

/**
 * A script may pass a RegExp; JSON transport passes {__regex:{source,flags}}.
 * Foreign-realm regexes are rebuilt here so Playwright's own `instanceof`
 * checks recognise them.
 */
export function toMatcher(value: string | RegExp | RegexSpec): string | RegExp {
  if (isRegexSpec(value)) return new RegExp(value.__regex.source, value.__regex.flags);
  if (isRegExp(value)) {
    // Rebuild only when it comes from another realm; TS cannot see that
    // distinction, so the source/flags are read off a plain alias.
    const foreign = value as { source: string; flags: string };
    return value instanceof RegExp ? value : new RegExp(foreign.source, foreign.flags);
  }
  return value;
}

export function toLocator(scope: Page | Locator, target: TargetSpec): Locator {
  const base: Page | Locator = target.within ? toLocator(scope, target.within) : scope;
  let loc: Locator;

  if (target.testId !== undefined) loc = base.getByTestId(target.testId);
  else if (target.role !== undefined) {
    loc = base.getByRole(
      target.role as Parameters<Page["getByRole"]>[0],
      target.name === undefined ? undefined : { name: toMatcher(target.name) },
    );
  } else if (target.label !== undefined) loc = base.getByLabel(toMatcher(target.label));
  else if (target.placeholder !== undefined) loc = base.getByPlaceholder(toMatcher(target.placeholder));
  else if (target.text !== undefined) loc = base.getByText(toMatcher(target.text));
  else if (target.css !== undefined) loc = base.locator(target.css);
  else throw new AgentError("script", `empty target: ${JSON.stringify(target)}`);

  return target.nth === undefined ? loc : loc.nth(target.nth);
}

const show = (v: unknown): string =>
  isRegexSpec(v) ? `/${v.__regex.source}/${v.__regex.flags}` : isRegExp(v) ? String(v) : JSON.stringify(v);

/** Human-readable target, used in assertion and timeout messages. */
export function describeTarget(target: TargetSpec): string {
  const parts: string[] = [];
  if (target.testId !== undefined) parts.push(`testId=${target.testId}`);
  if (target.role !== undefined) parts.push(`role=${target.role}`);
  if (target.name !== undefined) parts.push(`name=${show(target.name)}`);
  if (target.label !== undefined) parts.push(`label=${show(target.label)}`);
  if (target.placeholder !== undefined) parts.push(`placeholder=${show(target.placeholder)}`);
  if (target.text !== undefined) parts.push(`text=${show(target.text)}`);
  if (target.css !== undefined) parts.push(`css=${target.css}`);
  if (target.within !== undefined) parts.push(`in(${describeTarget(target.within)})`);
  if (target.nth !== undefined) parts.push(`[${target.nth}]`);
  return parts.join(" ");
}

export interface Resolved {
  locator: Locator;
  /** 0 = the primary target, 1+ = the fallback that worked. */
  index: number;
  used: TargetSpec;
}

/**
 * The primary target, or the first fallback that still finds exactly one
 * element. A cosmetic markup change should cost a warning, not a red run —
 * but a silent switch would hide real drift, so the caller reports it.
 */
export async function resolveTarget(
  scope: Page | Locator,
  target: TargetSpec,
  probeTimeoutMs: number,
): Promise<Resolved> {
  const candidates: TargetSpec[] = [{ ...target, or: undefined }, ...(target.or ?? [])];

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    const locator = toLocator(scope, candidate);
    // The last candidate is returned even if it looks empty: letting the step
    // fail on it produces Playwright's own, far more useful error message.
    if (index === candidates.length - 1) return { locator, index, used: candidate };
    try {
      await locator.first().waitFor({ state: "attached", timeout: probeTimeoutMs });
      return { locator, index, used: candidate };
    } catch {
      // try the next one
    }
  }
  throw new AgentError("script", `empty target: ${JSON.stringify(target)}`);
}
