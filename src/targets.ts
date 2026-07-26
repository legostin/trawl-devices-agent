import type { Locator, Page } from "playwright";
import { AgentError, type RegexSpec, type TargetSpec } from "./types.js";

export const isRegexSpec = (v: unknown): v is RegexSpec =>
  typeof v === "object" && v !== null && "__regex" in v;

/** A script may pass a RegExp; JSON transport passes {__regex:{source,flags}}. */
export function toMatcher(value: string | RegExp | RegexSpec): string | RegExp {
  if (isRegexSpec(value)) return new RegExp(value.__regex.source, value.__regex.flags);
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
  isRegexSpec(v) ? `/${v.__regex.source}/${v.__regex.flags}` : v instanceof RegExp ? String(v) : JSON.stringify(v);

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
