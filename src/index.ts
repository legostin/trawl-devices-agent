#!/usr/bin/env node
import { createServer } from "./server.js";
import { loadOrCreateToken } from "./auth.js";
import { ensureWorkspace } from "./workspace.js";
import { pruneRuns } from "./retention.js";
import { AGENT_VERSION, DSL_VERSION } from "./version.js";
import { STEP_NAMES } from "./steps.js";
import { buildRoutes } from "./routes.js";

const arg = (name: string, fallback: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const workspace = arg("workspace", process.cwd());
const wanted = Number(arg("port", "8787"));
const trawlProxyPort = Number(arg("proxy-port", "8080"));

const listen = (server: ReturnType<typeof createServer>, candidate: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => (err.code === "EADDRINUSE" ? resolve(-1) : reject(err)));
    server.listen(candidate, "127.0.0.1", () => resolve(candidate));
  });

const token = await loadOrCreateToken();
await ensureWorkspace(workspace);

const pruned = await pruneRuns(workspace, Number(arg("keep-runs", "50")));
if (pruned.length) console.log(`pruned ${pruned.length} old run(s)`);

let port = -1;
for (let candidate = wanted; candidate < wanted + 20 && port < 0; candidate++) {
  const server = createServer({
    token,
    getPort: () => port,
    routes: buildRoutes({ workspace, trawlProxyPort }),
    health: () => ({ dsl: DSL_VERSION, steps: [...STEP_NAMES], workspace }),
  });
  port = await listen(server, candidate);
}
if (port < 0) throw new Error(`no free port in ${wanted}..${wanted + 20}`);

console.log(`trawl-devices-agent ${AGENT_VERSION} listening on http://127.0.0.1:${port}`);
console.log(`workspace: ${workspace}`);
console.log(`token: ${token}`);
