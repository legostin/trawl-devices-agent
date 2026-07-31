import type { Page } from "playwright";
import { toLocator } from "./targets.js";
import type { ScreenFile } from "./mapTypes.js";

const ESCAPE = /[.+^${}()|[\]\\]/g;

/** `*` stays inside a path segment, `**` crosses them — the shape people expect. */
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

/**
 * The pattern that recognises the screen this url belongs to: host and path
 * exactly, with identifiers in the path turned into wildcards. `/a/new/87031015`
 * and `/a/new/87031016` are one screen, not two.
 */
export function screenPatternFor(url: string): string {
  const { path } = splitUrl(url);
  const at = path.indexOf("://");
  const head = at < 0 ? "" : path.slice(0, at + 3);
  const rest = at < 0 ? path : path.slice(at + 3);
  const [host, ...segments] = rest.split("/");
  const templated = segments.map((s) => (ID_SEGMENT.test(s) ? "*" : s));
  return head + [host, ...templated].join("/");
}

export function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(ESCAPE, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*")
    .replace(/\?/g, "\\?");
  return new RegExp(`^${body}$`);
}

/**
 * The query belongs to the data, not to the identity of the screen: the same
 * form is the same form whether or not it carries `?destination=…`. The hash is
 * kept apart because in an SPA it often *is* the route.
 */
const splitUrl = (url: string): { path: string; hash: string } => {
  const hashAt = url.indexOf("#");
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  const head = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = head.indexOf("?");
  return { path: queryAt < 0 ? head : head.slice(0, queryAt), hash };
};

/**
 * URL only. A screen whose `match` is null is the shared pseudo-screen: always
 * in scope for name resolution, never the answer to "where am I".
 */
/**
 * A pattern that would also claim a different host is not describing a screen,
 * it is claiming the whole web. Early recordings derived `**` plus the pathname,
 * so the site root became `**​/` — which matches every url ending in a slash,
 * and the first screen recorded then swallowed every screen after it.
 *
 * Reuse beats creation everywhere else in the map, which is exactly why one bad
 * pattern poisons everything downstream: re-recording inherits it instead of
 * fixing it.
 *
 * Only the recorder asks this, when deciding whether to reuse a screen. Matching
 * itself stays literal: a hand-written `**​/a/new/**` means what it says.
 */
export function isTooBroad(pattern: string): boolean {
  // A pattern that does not start with a scheme cannot pin a host, and a screen
  // that does not name its host is not a screen. Every pattern derived today
  // begins with one; only the early ones do not.
  return !/^[a-z]+:\/\//i.test(pattern.trim());
}

export function matchesScreen(screen: ScreenFile, url: string): boolean {
  if (!screen.match) return false;
  const { path, hash } = splitUrl(url);
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
