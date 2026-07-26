import { expect, it, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { Runner } from "./runner.js";
import { SessionStore } from "./sessions.js";
import { validateDevice } from "./devices.js";
import type { RunReport } from "./types.js";

const device = validateDevice({ id: "st", name: "St", headless: true, proxy: { mode: "none" }, trace: "off" });
const sessions = new SessionStore();
let root: string;
let runner: Runner;
let server: http.Server;
let origin: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "state-"));
  runner = new Runner({ sessions, workspace: root, trawlProxyPort: 8080 });
  server = http.createServer((req, res) => {
    // The page shows who you are, straight from the cookie the "login" set.
    const who = /token=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "anonymous";
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<h1 id="who">${who}</h1>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true });
});
afterAll(async () => { await sessions.stopAll(); });

const finish = async (code: string): Promise<RunReport> => {
  const started = await runner.start({ code, device, env: {}, secrets: {} });
  for (let i = 0; i < 300; i++) {
    const report = runner.get(started.runId)!;
    if (report.status !== "running") return report;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("run did not finish");
};

it("saves a signed-in state and reuses it in a later run", async () => {
  // "Log in": the page sets a cookie, then the scenario saves the state.
  const login = await finish(`
    goto('${origin}/')
    saveState('auth')
  `);
  expect(login.status).toBe("passed");

  // Nothing is saved yet beyond cookies, but the file must exist and be JSON.
  const saved = JSON.parse(await readFile(path.join(root, "state/auth.json"), "utf8"));
  expect(saved).toHaveProperty("cookies");

  const reuse = await finish(`
    goto('${origin}/')
    useState('auth')
    reload()
    expectVisible({ css: '#who' })
  `);
  expect(reuse.status).toBe("passed");
}, 60_000);

it("says which state is missing instead of failing cryptically", async () => {
  const report = await finish(`goto('${origin}/')\nuseState('never-saved')`);
  expect(report.status).toBe("error");
  expect(report.steps.at(-1)!.error?.message).toContain("no saved state: never-saved");
});
