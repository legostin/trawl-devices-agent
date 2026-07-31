import type { AppMap } from "./mapTypes.js";

/**
 * How a scenario should name an element.
 *
 * Resolution already looks on the current screen, then among the shared
 * elements, then anywhere the name is unique — so qualifying every reference
 * spends a screen's worth of words to say nothing. On a page whose heading is a
 * marketing line, that is the whole width of the row.
 *
 * So: the bare label when the map has exactly one element by that name, and
 * `Экран › Элемент` only when it genuinely could mean two things.
 */
export function shortestRef(map: AppMap, screenLabel: string, elementLabel: string): string {
  let seen = 0;
  for (const screen of map.screens) {
    for (const entry of Object.values(screen.elements)) {
      if (entry.label === elementLabel) seen++;
      if (seen > 1) return `${screenLabel} › ${elementLabel}`;
    }
  }
  return elementLabel;
}

/** Split a reference back into its parts, for display. */
export function refParts(reference: string): { screen?: string; element: string } {
  const at = reference.search(/[›>]/);
  return at < 0
    ? { element: reference.trim() }
    : { screen: reference.slice(0, at).trim(), element: reference.slice(at + 1).trim() };
}
