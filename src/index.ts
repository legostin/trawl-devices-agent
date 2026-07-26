#!/usr/bin/env node
import { createServer } from "./server.js";
import { loadOrCreateToken } from "./auth.js";
import { ensureWorkspace } from "./workspace.js";
import { pruneRuns } from "./retention.js";
import { ensureBrowser } from "./browsers.js";
import { AGENT_VERSION, DSL_VERSION } from "./version.js";
import { STEP_NAMES } from "./steps.js";
import { buildRoutes } from "./routes.js";
import { SessionStore } from "./sessions.js";
import os from "node:os";
import path from "node:path";

const arg = (name: string, fallback: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

// Default to a stable folder in $HOME: a GUI-spawned agent inherits a useless cwd.
const workspace = arg("workspace", path.join(os.homedir(), "trawl-devices"));
const wanted = Number(arg("port", "8787"));
const trawlProxyPort = Number(arg("proxy-port", "8080"));

const listen = (server: ReturnType<typeof createServer>, candidate: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(-1) : reject(err)));
    server.listen(candidate, "127.0.0.1", () => resolve(candidate));
  });

const token = await loadOrCreateToken();
await ensureWorkspace(workspace);

if (process.argv.includes("--ensure-browser")) {
  await ensureBrowser(arg("browser", "chromium") as "chromium" | "firefox" | "webkit");
}

const pruned = await pruneRuns(workspace, Number(arg("keep-runs", "50")));
if (pruned.length) console.log(`pruned ${pruned.length} old run(s)`);

// Owned here so the shutdown path can close every browser: a killed agent that
// leaves Chromium behind is exactly what "the browser won't close" looks like.
const sessions = new SessionStore();

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[agent] ${signal} — closing browsers`);
  await sessions.stopAll().catch(() => {});
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => void shutdown(signal));
}

let port = -1;
for (let candidate = wanted; candidate < wanted + 20 && port < 0; candidate++) {
  const server = createServer({
    token,
    getPort: () => port,
    routes: buildRoutes({ workspace, trawlProxyPort, sessions }),
    health: () => ({ dsl: DSL_VERSION, steps: [...STEP_NAMES], workspace, proxyPort: trawlProxyPort }),
  });
  port = await listen(server, candidate);
}
if (port < 0) throw new Error(`no free port in ${wanted}..${wanted + 20}`);

console.log(`trawl-devices-agent ${AGENT_VERSION} listening on http://127.0.0.1:${port}`);
console.log(`workspace: ${workspace}`);
console.log(`token: ${token}`);
