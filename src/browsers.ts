import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Install a Playwright browser if it is missing. Runs Playwright's own CLI from
 * this package's dependency tree, so it works under `npx` with no global
 * install, and streams progress to our stdout — the plugin shows that log.
 *
 * Already-installed browsers make this a no-op that finishes in about a second.
 */
export async function ensureBrowser(browser: "chromium" | "firefox" | "webkit"): Promise<void> {
  const require = createRequire(import.meta.url);
  let cli: string;
  try {
    // Playwright's `exports` map hides cli.js, so go through package.json + bin.
    const manifestPath = require.resolve("playwright/package.json");
    const manifest = require("playwright/package.json") as { bin?: Record<string, string> };
    const relative = manifest.bin?.playwright ?? "cli.js";
    cli = path.join(path.dirname(manifestPath), relative);
    if (!existsSync(cli)) throw new Error(`not found: ${cli}`);
  } catch (err) {
    console.log(`[browser] cannot locate the Playwright CLI (${(err as Error).message}); skipping ${browser}`);
    return;
  }

  console.log(`[browser] ensuring ${browser} is installed…`);
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [cli, "install", browser], { stdio: ["ignore", "pipe", "pipe"] });
    const echo = (chunk: Buffer): void => {
      const text = chunk.toString().trimEnd();
      if (text) console.log(`[browser] ${text}`);
    };
    child.stdout.on("data", echo);
    child.stderr.on("data", echo);
    child.on("error", (err) => {
      console.log(`[browser] install failed: ${err.message}`);
      resolve();
    });
    child.on("close", (code) => {
      console.log(code === 0 ? `[browser] ${browser} ready` : `[browser] install exited with ${code}`);
      resolve();
    });
  });
}
