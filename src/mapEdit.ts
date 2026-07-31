import { AgentError } from "./types.js";
import { MapStore } from "./mapStore.js";
import type { ScreenFile } from "./mapTypes.js";

export interface EditInput {
  screenId: string;
  /** Omitted when the edit is to the screen itself. */
  elementKey?: string;
  /** New human label. The old one is kept as an alias so scenarios keep working. */
  label?: string;
  /** Accept a proposed entry, or send an accepted one back for review. */
  status?: "proposed" | "accepted";
  /** Drop the entry, or the whole screen when no element is named. */
  remove?: boolean;
  /** Screen only: what url this screen is, and how to get back to it. */
  match?: { url?: string; hash?: string };
  open?: { url?: string; flow?: string };
  /** Element only: the screen it really belongs to. */
  moveTo?: string;
}

const findScreen = (screens: ScreenFile[], id: string): ScreenFile => {
  const screen = screens.find((s) => s.id === id);
  if (!screen) throw new AgentError("script", `экран «${id}» не найден в карте`);
  return screen;
};

/**
 * Rename, accept or drop one entry. Renaming keeps the old label as an alias:
 * a scenario written against the old wording must not break because someone
 * tidied up the map.
 */
export async function editMap(workspace: string, input: EditInput): Promise<{ screen: ScreenFile | null }> {
  const store = new MapStore(workspace);
  const map = await store.load();
  const screen = findScreen(map.screens, input.screenId);

  if (!input.elementKey) {
    if (input.remove) {
      await store.removeScreen(screen.id);
      return { screen: null };
    }
    if (input.label && input.label !== screen.label) screen.label = input.label;
    // Fixing a screen by hand is the way out of a map recorded badly: a pattern
    // that claimed the whole site is repaired here rather than by re-recording,
    // which would only inherit it.
    if (input.match) screen.match = { ...(screen.match ?? {}), ...input.match };
    if (input.open) screen.open = { ...(screen.open ?? {}), ...input.open };
    await store.saveScreen(screen);
    return { screen };
  }

  const entry = screen.elements[input.elementKey];
  if (!entry) {
    throw new AgentError("script", `на экране «${screen.label}» нет элемента «${input.elementKey}»`);
  }

  if (input.remove) {
    delete screen.elements[input.elementKey];
  } else if (input.moveTo) {
    // Everything piling onto one screen is what a too-broad pattern produces;
    // moving elements back is the other half of repairing that by hand.
    const target = findScreen(map.screens, input.moveTo);
    if (target.id === screen.id) return { screen };
    let key = input.elementKey;
    for (let n = 2; target.elements[key]; n++) key = `${input.elementKey}-${n}`;
    target.elements[key] = entry;
    delete screen.elements[input.elementKey];
    await store.saveScreen(target);
  } else {
    if (input.label && input.label !== entry.label) {
      const aliases = new Set([...(entry.aliases ?? []), entry.label]);
      aliases.delete(input.label);
      entry.aliases = [...aliases];
      entry.label = input.label;
      // A name given by a human is a decision, not a guess.
      entry.source = "human";
      entry.status = "accepted";
    }
    if (input.status) entry.status = input.status;
    entry.updatedAt = new Date().toISOString();
  }

  await store.saveScreen(screen);
  return { screen };
}
