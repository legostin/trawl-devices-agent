import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const configDir = (): string => path.join(os.homedir(), ".trawl-devices");

/** Read the bearer token, creating a 0600 file with a fresh one if absent. */
export async function loadOrCreateToken(dir: string = configDir()): Promise<string> {
  const file = path.join(dir, "agent.json");
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (typeof parsed?.token === "string" && parsed.token.length >= 32) return parsed.token;
  } catch {
    // missing or corrupt — fall through and mint a new one
  }
  const token = randomBytes(24).toString("base64url"); // 32 chars
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify({ token }, null, 2) + "\n", { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return token;
}
