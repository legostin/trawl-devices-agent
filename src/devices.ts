import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentError, type Device } from "./types.js";
import { resolveInWorkspace } from "./workspace.js";

export const DEVICE_DEFAULTS = {
  type: "browser",
  browser: "chromium",
  headless: false,
  viewport: { width: 1280, height: 800 },
  proxy: { mode: "trawl" },
  ignoreHTTPSErrors: true,
  trace: "on-failure",
  video: false,
  stepDelayMs: 0,
  closeAfterRun: true,
  closeOnFailure: false,
  videoFps: 5,
  capabilities: ["record", "run", "live", "traffic"],
} satisfies Omit<Device, "id" | "name">;

const BROWSERS = ["chromium", "firefox", "webkit"];
const TRACES = ["off", "on-failure", "always"];
const PROXY_MODES = ["trawl", "none", "custom"];

/** Fill defaults and reject malformed input. Throws AgentError("script"). */
export function validateDevice(input: unknown): Device {
  const raw = (input ?? {}) as Record<string, unknown>;
  const fail = (msg: string): never => {
    throw new AgentError("script", `invalid device: ${msg}`);
  };

  if (typeof raw.id !== "string" || !/^[a-zA-Z0-9._-]+$/.test(raw.id)) fail("id must match [a-zA-Z0-9._-]+");
  if (typeof raw.name !== "string" || !raw.name.trim()) fail("name is required");

  const merged = { ...DEVICE_DEFAULTS, ...raw } as Device;
  if (!BROWSERS.includes(merged.browser)) fail(`browser must be one of ${BROWSERS.join(", ")}`);
  if (!TRACES.includes(merged.trace)) fail(`trace must be one of ${TRACES.join(", ")}`);
  if (!PROXY_MODES.includes(merged.proxy?.mode)) fail(`proxy.mode must be one of ${PROXY_MODES.join(", ")}`);
  if (merged.proxy.mode === "custom" && !merged.proxy.url) fail("proxy.url is required when proxy.mode is custom");
  if (typeof merged.stepDelayMs !== "number" || merged.stepDelayMs < 0 || merged.stepDelayMs > 60_000) {
    fail("stepDelayMs must be between 0 and 60000");
  }
  if (typeof merged.closeAfterRun !== "boolean") fail("closeAfterRun must be a boolean");
  if (typeof merged.closeOnFailure !== "boolean") fail("closeOnFailure must be a boolean");
  if (typeof merged.videoFps !== "number" || merged.videoFps < 1 || merged.videoFps > 30) {
    fail("videoFps must be between 1 and 30");
  }
  merged.type = "browser";
  return merged;
}

const registryPath = (root: string) => resolveInWorkspace(root, "devices.json");

export async function loadDevices(root: string): Promise<Device[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(registryPath(root), "utf8"));
    return Array.isArray(parsed?.devices) ? parsed.devices.map(validateDevice) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function saveDevice(root: string, patch: unknown): Promise<Device> {
  const device = validateDevice(patch);
  const devices = await loadDevices(root);
  const next = devices.filter((d) => d.id !== device.id).concat(device);
  next.sort((a, b) => a.id.localeCompare(b.id));
  const file = registryPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ devices: next }, null, 2) + "\n", "utf8");
  return device;
}

export async function getDevice(root: string, id: string): Promise<Device> {
  const found = (await loadDevices(root)).find((d) => d.id === id);
  if (!found) throw new AgentError("device", `unknown device: ${id}`);
  return found;
}
