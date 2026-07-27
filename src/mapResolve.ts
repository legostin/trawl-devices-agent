import { AgentError } from "./types.js";
import { SHARED_SCREEN_ID, type AppMap, type ElementEntry, type ScreenFile } from "./mapTypes.js";

export interface ResolvedEntry {
  screen: ScreenFile;
  key: string;
  entry: ElementEntry;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** `Экран › Элемент`. `>` is accepted too, because `›` is awkward to type. */
export function parseReference(reference: string): { screen?: string; element: string } {
  const at = reference.search(/[›>]/);
  if (at < 0) return { element: reference.trim() };
  return {
    screen: reference.slice(0, at).trim(),
    element: reference.slice(at + 1).trim(),
  };
}

const names = (entry: ElementEntry): string[] => [entry.label, ...(entry.aliases ?? [])].map(norm);

const lookup = (screen: ScreenFile, element: string): ResolvedEntry | null => {
  const wanted = norm(element);
  for (const [key, entry] of Object.entries(screen.elements)) {
    if (names(entry).includes(wanted)) return { screen, key, entry };
  }
  return null;
};

export function findScreen(map: AppMap, label: string): ScreenFile {
  const wanted = norm(label);
  const hit = map.screens.find((s) => norm(s.label) === wanted || s.id === label);
  if (!hit) {
    const known = map.screens.filter((s) => s.match).map((s) => `«${s.label}»`).join(", ");
    throw new AgentError("script", `экран «${label}» не найден в карте. Известные экраны: ${known || "нет"}`);
  }
  return hit;
}

/**
 * Current screen first, then the shared elements, then — only if the name is
 * unique in the whole map — anywhere. Ambiguity is an error here rather than a
 * surprise at run time, and it names the qualified form that would fix it.
 */
export function resolveName(map: AppMap, reference: string, currentScreenId: string | null): ResolvedEntry {
  const { screen: screenLabel, element } = parseReference(reference);

  if (screenLabel) {
    const screen = findScreen(map, screenLabel);
    const hit = lookup(screen, element);
    if (hit) return hit;
    throw new AgentError("script", `на экране «${screen.label}» нет элемента «${element}»${nearby(map, element)}`);
  }

  const here = currentScreenId ? map.screens.find((s) => s.id === currentScreenId) : undefined;
  if (here) {
    const hit = lookup(here, element);
    if (hit) return hit;
  }

  const shared = map.screens.find((s) => s.id === SHARED_SCREEN_ID);
  if (shared) {
    const hit = lookup(shared, element);
    if (hit) return hit;
  }

  const everywhere = map.screens
    .map((screen) => lookup(screen, element))
    .filter((hit): hit is ResolvedEntry => hit !== null);
  if (everywhere.length === 1) return everywhere[0]!;
  if (everywhere.length > 1) {
    const options = everywhere.map((hit) => `«${hit.screen.label} › ${hit.entry.label}»`).join(", ");
    throw new AgentError("script", `«${element}» есть на нескольких экранах — уточните: ${options}`);
  }

  throw new AgentError("script", `элемента «${element}» нет в карте${nearby(map, element)}`);
}

/** A short "did you mean" built from substring overlap — no fuzzy matching. */
function nearby(map: AppMap, element: string): string {
  const wanted = norm(element);
  const close = map.screens
    .flatMap((screen) => Object.values(screen.elements).map((entry) => ({ screen, entry })))
    .filter(({ entry }) => names(entry).some((n) => n.includes(wanted) || wanted.includes(n)))
    .slice(0, 5)
    .map(({ screen, entry }) => `«${screen.label} › ${entry.label}»`);
  return close.length ? `. Похожее: ${close.join(", ")}` : "";
}
