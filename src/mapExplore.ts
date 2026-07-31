import type { Page } from "playwright";
import { snapshot, type SnapshotNode } from "./control.js";
import { matchesScreen, screenPatternFor } from "./mapScreens.js";
import { resolveTarget } from "./targets.js";
import { slug } from "./mapStore.js";
import type { AppMap, ElementEntry, ScreenFile } from "./mapTypes.js";
import type { TargetSpec } from "./types.js";

export interface Candidate {
  label: string;
  kind: "control" | "choice";
  role: string;
  target: TargetSpec;
  /** Already in the map under this label — offered so nothing is created twice. */
  known?: string;
}

export interface Exploration {
  screen: { id: string; label: string; match: { url: string }; open: { url: string }; known: boolean };
  candidates: Candidate[];
}

/** Roles worth an entry: things a scenario acts on or asserts about. */
const WORTH_NAMING = new Set(["button", "link", "textbox", "checkbox", "radio", "combobox", "tab", "option"]);

const OPTIONS = new Set(["radio", "checkbox", "option"]);

/**
 * Look at a screen and say what a map for it would contain — without writing
 * anything. Recording learns one element per click, which is why a map built
 * that way is a pile; a screen read in one go can be named as a whole.
 */
export async function explore(page: Page, map: AppMap, title: string): Promise<Exploration> {
  const url = page.url();
  const known = map.screens.find((s) => matchesScreen(s, url));
  const label = known?.label ?? title.trim() ?? screenPatternFor(url);

  const nodes = await snapshot(page);
  const seen = new Map<string, ElementEntry>();
  for (const screen of map.screens) {
    for (const entry of Object.values(screen.elements)) seen.set(entry.label, entry);
  }

  const candidates: Candidate[] = [];
  const used = new Set<string>();
  for (const node of nodes) {
    const name = (node.name ?? "").trim();
    if (!name || !WORTH_NAMING.has(node.role)) continue;
    // One entry per wording: a screen full of "Купить" buttons is a list, and a
    // list is one element with a value, not forty entries.
    if (used.has(name)) continue;
    used.add(name);

    candidates.push({
      label: name,
      kind: OPTIONS.has(node.role) ? "choice" : "control",
      role: node.role,
      target: { role: node.role, name },
      ...(seen.has(name) ? { known: seen.get(name)!.label } : {}),
    });
  }

  return {
    screen: {
      id: known?.id ?? slug(label),
      label,
      match: (known?.match as { url: string }) ?? { url: screenPatternFor(url) },
      open: { url: known?.open?.url ?? url },
      known: Boolean(known),
    },
    candidates,
  };
}

export interface VerifiedEntry {
  screen: string;
  element: string;
  ok: boolean;
  matches: number;
  detail?: string;
}

/**
 * Resolve a screen's entries against the page in front of us. This is what
 * turns "the map says so" into "the map is still true", and it is the signal
 * drift detection is built on.
 */
export async function verify(page: Page, screen: ScreenFile, probeMs: number): Promise<VerifiedEntry[]> {
  const out: VerifiedEntry[] = [];
  for (const entry of Object.values(screen.elements)) {
    const target = entry.kind === "choice" ? entry.group : entry.target;
    if (!target) {
      out.push({ screen: screen.label, element: entry.label, ok: false, matches: 0, detail: "нет локатора" });
      continue;
    }
    try {
      const resolved = await resolveTarget(page, target, probeMs);
      const matches = await resolved.locator.count();
      out.push({
        screen: screen.label,
        element: entry.label,
        ok: matches === 1,
        matches,
        // A fallback that had to be used is drift that has not broken yet.
        ...(resolved.index > 0 ? { detail: "сработал запасной локатор" } : {}),
      });
    } catch (err) {
      out.push({
        screen: screen.label,
        element: entry.label,
        ok: false,
        matches: 0,
        detail: (err as Error).message.slice(0, 120),
      });
    }
  }
  return out;
}

export type { SnapshotNode };
