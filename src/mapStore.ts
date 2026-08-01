import { promises as fs } from "node:fs";
import path from "node:path";
import { domainOf, domainSlug } from "./mapDomain.js";
import { EMPTY_APP, SHARED_SCREEN_ID, type AppFile, type AppMap, type ScreenFile } from "./mapTypes.js";

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};

/**
 * Ids are ASCII so file names stay portable across machines and archives; the
 * label keeps the original wording and is what a scenario actually writes.
 */
export function slug(label: string): string {
  const ascii = [...label.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join("");
  const cleaned = ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "element";
}

export const mapDir = (root: string) => path.join(path.resolve(root), "map");
const screensDir = (root: string) => path.join(mapDir(root), "screens");
const appFile = (root: string) => path.join(mapDir(root), "app.json");

const readJson = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
};

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
};

export class MapStore {
  constructor(private readonly root: string) {}

  /** An absent map is an empty map: the agent works fine without one. */
  async load(): Promise<AppMap> {
    const app = (await readJson<AppFile>(appFile(this.root))) ?? EMPTY_APP;
    const screens: ScreenFile[] = [];

    // One directory per application. Screens written before this lived in a
    // single `screens/`, so they are read too and given their domain from the
    // pattern they already carry — nobody has to migrate anything by hand.
    for (const dir of await this.screenDirs()) {
      let names: string[] = [];
      try {
        names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        const screen = await readJson<ScreenFile>(path.join(dir, name));
        if (screen) screens.push({ ...screen, domain: screen.domain ?? domainOf(screen.match?.url ?? "") });
      }
    }

    // Shared first: name resolution walks the list in order and the shared
    // elements must never be shadowed by an accident of alphabet.
    screens.sort((a, b) => Number(b.id === SHARED_SCREEN_ID) - Number(a.id === SHARED_SCREEN_ID));
    return { app, screens };
  }

  /** Where screens live: the legacy flat directory, plus one per domain. */
  private async screenDirs(): Promise<string[]> {
    const dirs = [screensDir(this.root)];
    try {
      for (const entry of await fs.readdir(mapDir(this.root), { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== "screens" && entry.name !== "shots" && entry.name !== "flows") {
          dirs.push(path.join(mapDir(this.root), entry.name));
        }
      }
    } catch {
      // no map yet
    }
    return dirs;
  }

  async saveScreen(screen: ScreenFile): Promise<void> {
    const domain = screen.domain ?? domainOf(screen.match?.url ?? "");
    const dir = domain ? path.join(mapDir(this.root), domainSlug(domain)) : screensDir(this.root);
    await writeJson(path.join(dir, `${screen.id}.json`), { ...screen, domain });
    // A screen that has moved into its domain must not be left behind in the
    // flat directory, or it comes back as a duplicate on the next read.
    if (dir !== screensDir(this.root)) {
      await fs.rm(path.join(screensDir(this.root), `${screen.id}.json`), { force: true });
    }
  }

  /**
   * A picture of one element, beside the map. A catalogue of words cannot tell
   * you which "Без названия" is which icon; a thumbnail can.
   */
  async saveShot(name: string, data: Buffer): Promise<string> {
    const dir = path.join(mapDir(this.root), "shots");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${name}.png`), data);
    return `shots/${name}.png`;
  }

  async readShot(rel: string): Promise<Buffer> {
    // Confined to the map directory: this path arrives over HTTP.
    const file = path.resolve(mapDir(this.root), rel);
    if (!file.startsWith(mapDir(this.root) + path.sep)) throw new Error("path escapes the map");
    return fs.readFile(file);
  }

  async removeScreen(id: string): Promise<void> {
    for (const dir of await this.screenDirs()) {
      await fs.rm(path.join(dir, `${id}.json`), { force: true });
    }
  }

  async saveApp(app: AppFile): Promise<void> {
    await writeJson(appFile(this.root), app);
  }
}
