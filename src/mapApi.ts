import type { FlowRef } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
const ASSET = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?|map)$/i;

/** Today's advert id is not part of the endpoint's identity. */
export function templatePath(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split("?")[0] ?? url;
  }
  const parts = pathname.split("/").filter(Boolean);
  const templated = parts.map((part) => (/^\d+$/.test(part) || UUID.test(part) || HEX.test(part) ? ":id" : part));
  return "/" + templated.join("/");
}

/**
 * The map learns its API surface by observation: whatever went out while the
 * human was pressing this button is what the button does. Third-party hosts and
 * static assets are noise, and a request with no response proves nothing.
 */
export function bindingsFor(flows: FlowRef[], hosts: string[]): string[] {
  const out: string[] = [];
  for (const flow of flows) {
    if (flow.status === null) continue;
    let host: string;
    try {
      host = new URL(flow.url).host;
    } catch {
      continue;
    }
    if (hosts.length && !hosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    const path = templatePath(flow.url);
    if (ASSET.test(path)) continue;
    const binding = `${flow.method.toUpperCase()} ${path}`;
    if (!out.includes(binding)) out.push(binding);
  }
  return out;
}
