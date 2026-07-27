import { promises as fs } from "node:fs";
import path from "node:path";
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
    let names: string[] = [];
    try {
      names = (await fs.readdir(screensDir(this.root))).filter((n) => n.endsWith(".json"));
    } catch {
      return { app, screens: [] };
    }
    const screens: ScreenFile[] = [];
    for (const name of names.sort()) {
      const screen = await readJson<ScreenFile>(path.join(screensDir(this.root), name));
      if (screen) screens.push(screen);
    }
    // Shared first: name resolution walks the list in order and the shared
    // elements must never be shadowed by an accident of alphabet.
    screens.sort((a, b) => Number(b.id === SHARED_SCREEN_ID) - Number(a.id === SHARED_SCREEN_ID));
    return { app, screens };
  }

  async saveScreen(screen: ScreenFile): Promise<void> {
    await writeJson(path.join(screensDir(this.root), `${screen.id}.json`), screen);
  }

  async removeScreen(id: string): Promise<void> {
    await fs.rm(path.join(screensDir(this.root), `${id}.json`), { force: true });
  }

  async saveApp(app: AppFile): Promise<void> {
    await writeJson(appFile(this.root), app);
  }
}
