/**
 * Which application a screen belongs to.
 *
 * Not the host: a login that lives on `main-id.example.org` while the rest of
 * the product is on `desktop-main-kl.example.org` is the same application, and
 * splitting them would put a flow's two halves in two maps. Not the workspace
 * either — then two different sites share one namespace and every "Продолжить"
 * collides with every other.
 *
 * The registrable domain is the line that matches how people think about it.
 */

/** Second-level suffixes that are really part of the public suffix. */
const COMPOUND = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne"]);

export function domainOf(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // A pattern rather than a url: take what looks like the host out of it.
    const cleaned = url.replace(/^[a-z]+:\/\//i, "").replace(/^\*+\.?/, "");
    host = cleaned.split("/")[0] ?? "";
  }
  host = host.replace(/^www\./, "").toLowerCase();
  if (!host || host === "localhost") return host || "local";
  // An address is its own domain; there is nothing to shorten.
  if (/^\d+(\.\d+)*$/.test(host)) return host;

  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");

  const [last, secondLast] = [labels[labels.length - 1]!, labels[labels.length - 2]!];
  // example.co.uk keeps three labels; example.org keeps two.
  const keep = COMPOUND.has(secondLast) && last.length <= 3 ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** A domain as a directory name — hosts are already filename-safe but for dots. */
export const domainSlug = (domain: string): string => domain.replace(/[^a-z0-9.-]/gi, "_") || "local";
