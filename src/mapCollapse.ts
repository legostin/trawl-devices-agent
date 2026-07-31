import type { TargetSpec } from "./types.js";

export interface GroupInfo {
  key: string;
  label: string;
  targets: TargetSpec[];
}

export interface CollapsedStep {
  ts: number;
  action: string;
  args: unknown[];
  group?: GroupInfo;
  /** Where the page was; the recording is cut into sections on it. */
  url?: string;
  /** What named the screen at that moment: its heading, else the document title. */
  title?: string;
  /** The modal it happened in — a screen of its own. */
  dialog?: { label: string; marker: TargetSpec | null };
}

const OPTION_ACTIONS = new Set(["check", "uncheck", "click"]);

/** The wording that identifies the chosen option, if it has any. */
const optionName = (target: unknown): string | null => {
  const spec = target as TargetSpec | undefined;
  const value = spec?.name ?? spec?.label ?? spec?.text;
  return typeof value === "string" && value ? value : null;
};

/**
 * A year is one question with one answer, not seven radio buttons pinned by
 * index. Picking an option becomes `select(group, value)`, and changing your
 * mind mid-recording collapses to the answer you settled on.
 */
export function collapse(steps: CollapsedStep[]): CollapsedStep[] {
  const out: CollapsedStep[] = [];

  for (const step of steps) {
    const name = step.group && OPTION_ACTIONS.has(step.action) ? optionName(step.args[0]) : null;
    if (!step.group || name === null) {
      out.push(step);
      continue;
    }

    // Spread rather than rebuild: the caller hangs its own fields on a step,
    // and losing them here is invisible.
    const converted: CollapsedStep = {
      ...step,
      action: "select",
      args: [step.group.label || step.group.key, name],
    };

    const last = out[out.length - 1];
    if (last && last.action === "select" && last.group?.key === step.group.key) out[out.length - 1] = converted;
    else out.push(converted);
  }

  return out;
}
