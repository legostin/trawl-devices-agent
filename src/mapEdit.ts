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
    await store.saveScreen(screen);
    return { screen };
  }

  const entry = screen.elements[input.elementKey];
  if (!entry) {
    throw new AgentError("script", `на экране «${screen.label}» нет элемента «${input.elementKey}»`);
  }

  if (input.remove) {
    delete screen.elements[input.elementKey];
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
