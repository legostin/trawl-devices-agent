import type { TargetSpec } from "./types.js";

/**
 * The map describes the application; scenarios describe the test. Locators live
 * here and nowhere else, so a markup change is one edit rather than N.
 */

export type ElementKind = "control" | "choice";

export interface ElementEntry {
  /** What a human reads and a scenario writes. */
  label: string;
  kind: ElementKind;
  /** Previous labels, so a rename never breaks a scenario. */
  aliases?: string[];
  /** kind: "control" — the element itself, with its fallback ladder. */
  target?: TargetSpec;
  /** kind: "choice" — the container that holds the options. */
  group?: TargetSpec;
  /** kind: "choice" — how an option inside the group is shaped. */
  option?: TargetSpec;
  /** Requests this element is expected to cause, e.g. "POST /api/adverts". */
  api?: string[];
  /** A thumbnail of the element, relative to map/ — what it actually looks like. */
  shot?: string;
  source: "recorded" | "ai" | "human";
  /** A proposed entry works in a run but fails CI: unverified is not accepted. */
  status: "proposed" | "accepted";
  updatedAt: string;
  lastVerifiedRun?: string;
}

export interface ScreenMatch {
  /** Glob over the url without the hash: `*` inside a segment, `**` across. */
  url?: string;
  /** Glob over the hash, including the leading `#`. */
  hash?: string;
  /** Checked only when several screens match the url. */
  marker?: TargetSpec;
}

export interface ScreenFile {
  version: 1;
  /** ASCII slug; also the file name. */
  id: string;
  label: string;
  /** null on the shared pseudo-screen, which is always in scope. */
  match: ScreenMatch | null;
  /** How to get here. `match` has wildcards and is not navigable. */
  open?: { url?: string; flow?: string };
  baseline?: { runId: string; digest: string; capturedAt: string };
  elements: Record<string, ElementEntry>;
}

export interface AppFile {
  version: 1;
  baseUrl?: string;
  /** Hosts that belong to the application; used when binding API calls. */
  hosts: string[];
}

export interface AppMap {
  app: AppFile;
  screens: ScreenFile[];
}

export const SHARED_SCREEN_ID = "_shared";

export const EMPTY_APP: AppFile = { version: 1, hosts: [] };
