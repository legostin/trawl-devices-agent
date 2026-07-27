import type { Page } from "playwright";
import { toLocator } from "./targets.js";
import type { ScreenFile } from "./mapTypes.js";

const ESCAPE = /[.+^${}()|[\]\\]/g;

/** `*` stays inside a path segment, `**` crosses them — the shape people expect. */
export function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(ESCAPE, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*")
    .replace(/\?/g, "\\?");
  return new RegExp(`^${body}$`);
}

const splitHash = (url: string): { path: string; hash: string } => {
  const at = url.indexOf("#");
  return at < 0 ? { path: url, hash: "" } : { path: url.slice(0, at), hash: url.slice(at) };
};

/**
 * URL only. A screen whose `match` is null is the shared pseudo-screen: always
 * in scope for name resolution, never the answer to "where am I".
 */
export function matchesScreen(screen: ScreenFile, url: string): boolean {
  if (!screen.match) return false;
  const { path, hash } = splitHash(url);
  if (screen.match.url && !globToRegExp(screen.match.url).test(path)) return false;
  if (screen.match.hash && !globToRegExp(screen.match.hash).test(hash)) return false;
  return Boolean(screen.match.url || screen.match.hash);
}

/**
 * The url decides; the marker only breaks a tie. An SPA route that keeps the
 * same path is exactly why the marker exists, and probing it costs a round trip,
 * so it is not paid unless the url was ambiguous.
 */
export async function currentScreen(
  page: Page,
  screens: ScreenFile[],
  probeMs: number,
): Promise<ScreenFile | null> {
  const url = page.url();
  const candidates = screens.filter((s) => matchesScreen(s, url));
  if (candidates.length <= 1) return candidates[0] ?? null;

  for (const candidate of candidates) {
    if (!candidate.match?.marker) continue;
    try {
      await toLocator(page, candidate.match.marker).first().waitFor({ state: "attached", timeout: probeMs });
      return candidate;
    } catch {
      // not this one
    }
  }
  // Several urls matched and no marker resolved: guessing would scope names to
  // the wrong screen, and an unqualified name is better left unresolved.
  return null;
}
