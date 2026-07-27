import type { TargetSpec } from "./types.js";
import { slug } from "./mapStore.js";
import type { AppMap, ElementEntry, ElementKind, ScreenFile, ScreenMatch } from "./mapTypes.js";

export interface Observation {
  screenId: string;
  screenLabel: string;
  screenMatch: ScreenMatch;
  /** Empty when the element had no readable name — that goes to review. */
  label: string;
  kind: ElementKind;
  /** Best first: the primary and its fallbacks, as verified in the page. */
  targets: TargetSpec[];
  /** kind: "choice" — the shape of an option inside the group. */
  option?: TargetSpec;
  api?: string[];
}

export interface ReconcileOutcome {
  /** `Экран › Элемент`, the reference a scenario writes. */
  ref: string;
  created: boolean;
  strengthened: boolean;
  /** Set when a human should look at this one. */
  review?: string;
}

/** How many fallbacks an entry keeps before older ones stop earning their place. */
const MAX_FALLBACKS = 3;

const sameTarget = (a: TargetSpec, b: TargetSpec): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Certain, then almost certain, then probable. */
const looksLikeSame = (entry: ElementEntry, candidate: TargetSpec): boolean => {
  const ladder = [entry.target, entry.group, ...(entry.target?.or ?? []), ...(entry.group?.or ?? [])].filter(
    (t): t is TargetSpec => Boolean(t),
  );
  for (const known of ladder) {
    if (candidate.testId && known.testId === candidate.testId) return true;
    if (candidate.role && known.role === candidate.role && candidate.name && known.name === candidate.name) return true;
    if (candidate.css && known.css === candidate.css) return true;
  }
  return false;
};

const ensureScreen = (map: AppMap, observation: Observation): ScreenFile => {
  const existing = map.screens.find((s) => s.id === observation.screenId);
  if (existing) return existing;
  const screen: ScreenFile = {
    version: 1,
    id: observation.screenId,
    label: observation.screenLabel,
    match: observation.screenMatch,
    elements: {},
  };
  map.screens.push(screen);
  return screen;
};

const freshKey = (screen: ScreenFile, label: string): string => {
  const base = slug(label);
  if (!screen.elements[base]) return base;
  for (let n = 2; ; n++) {
    if (!screen.elements[`${base}-${n}`]) return `${base}-${n}`;
  }
};

/**
 * One observed interaction, folded into the map. Reuse beats creation: forty
 * entries for one button is the failure mode that makes a map worthless.
 */
export function reconcile(map: AppMap, observation: Observation, now: string): ReconcileOutcome {
  const screen = ensureScreen(map, observation);
  const [primary, ...fallbacks] = observation.targets;
  const ladder: TargetSpec = primary
    ? fallbacks.length
      ? { ...primary, or: fallbacks.slice(0, MAX_FALLBACKS) }
      : { ...primary }
    : {};

  const found = Object.entries(screen.elements).find(([, entry]) =>
    observation.targets.some((candidate) => looksLikeSame(entry, candidate)),
  );

  if (found) {
    const [, entry] = found;
    const anchor = entry.kind === "choice" ? entry.group : entry.target;
    let strengthened = false;
    if (anchor && primary && !sameTarget(anchor, primary) && !(anchor.or ?? []).some((t) => sameTarget(t, primary))) {
      // What still works stays primary; what was just seen becomes a fallback.
      anchor.or = [...(anchor.or ?? []), primary].slice(0, MAX_FALLBACKS);
      strengthened = true;
    }
    if (observation.api?.length) {
      entry.api = [...new Set([...(entry.api ?? []), ...observation.api])];
      strengthened = true;
    }
    entry.updatedAt = now;
    return { ref: `${screen.label} › ${entry.label}`, created: false, strengthened };
  }

  const unnamed = !observation.label.trim();
  const label = unnamed ? `Без названия (${primary?.role ?? "элемент"})` : observation.label.trim();
  const key = freshKey(screen, label);
  const entry: ElementEntry = {
    label,
    kind: observation.kind,
    ...(observation.kind === "choice"
      ? { group: ladder, option: observation.option ?? { role: "option" } }
      : { target: ladder }),
    ...(observation.api?.length ? { api: observation.api } : {}),
    source: "recorded",
    status: unnamed ? "proposed" : "accepted",
    updatedAt: now,
  };
  screen.elements[key] = entry;

  return {
    ref: `${screen.label} › ${label}`,
    created: true,
    strengthened: false,
    ...(unnamed ? { review: `элемент без названия на экране «${screen.label}» — дайте ему имя` } : {}),
  };
}
