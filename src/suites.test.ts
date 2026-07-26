import { expect, it, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Runner } from "./runner.js";
import { SessionStore } from "./sessions.js";
import { validateDevice } from "./devices.js";
import { writeScript } from "./workspace.js";
import { SuiteRunner, listSuites, readSuite, writeSuite, type SuiteReport } from "./suites.js";

const fixture = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/form.html"),
).href;

const device = validateDevice({ id: "s", name: "S", headless: true, proxy: { mode: "none" }, trace: "off" });
const sessions = new SessionStore();
let root: string;
let suites: SuiteRunner;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "suite-"));
  suites = new SuiteRunner(new Runner({ sessions, workspace: root, trawlProxyPort: 8080 }), root);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
afterAll(async () => { await sessions.stopAll(); });

const finish = async (report: SuiteReport): Promise<SuiteReport> => {
  for (let i = 0; i < 600; i++) {
    const current = suites.get(report.suiteId)!;
    if (current.status !== "running") return current;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("suite did not finish");
};

it("runs every scenario even when one fails, and summarises", async () => {
  await writeScript(root, "scripts/ok.js", `goto('${fixture}')\nexpectVisible({ css: '#title' })\n`);
  await writeScript(root, "scripts/bad.js", `use({ timeout: 1000 })\ngoto('${fixture}')\nclick({ testId: 'gone' })\n`);
  await writeScript(root, "scripts/after.js", `goto('${fixture}')\nexpectText({ css: '#title' }, 'Sign in')\n`);

  const report = await finish(
    suites.start({
      scenarios: [{ path: "scripts/ok.js" }, { path: "scripts/bad.js" }, { path: "scripts/after.js" }],
      device, env: {}, secrets: {}, retries: 0,
    }),
  );

  expect(report.status).toBe("failed");
  expect(report.results.map((r) => [r.script, r.status])).toEqual([
    ["scripts/ok.js", "passed"],
    ["scripts/bad.js", "failed"],
    // The scenario after the failure still ran — that is the point of a suite.
    ["scripts/after.js", "passed"],
  ]);
  expect(report.results[1]!.failedStep).toMatchObject({ action: "click" });
  expect(report.results.every((r) => r.runId)).toBe(true);
}, 120_000);

it("retries a failure and marks a scenario flaky when the retry passes", async () => {
  // A page that is broken exactly once: the first visit lacks the element the
  // scenario waits for, later visits have it. That is what flaky looks like.
  const http = await import("node:http");
  let visits = 0;
  const server = http.createServer((_req, res) => {
    visits += 1;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(visits === 1 ? "<h1>warming up</h1>" : "<h1 id='ready'>ready</h1>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    await writeScript(root, "scripts/steady.js", `goto('${fixture}')\nexpectVisible({ css: '#title' })\n`);
    await writeScript(root, "scripts/flaky.js", `use({ timeout: 1200 })\ngoto('${origin}/')\nexpectVisible({ css: '#ready' })\n`);
    await writeScript(root, "scripts/broken.js", `use({ timeout: 800 })\ngoto('${fixture}')\nclick({ testId: 'nope' })\n`);

    const report = await finish(
      suites.start({
        scenarios: [{ path: "scripts/steady.js" }, { path: "scripts/flaky.js" }, { path: "scripts/broken.js" }],
        device, env: {}, secrets: {}, retries: 2,
      }),
    );

    expect(report.results[0]).toMatchObject({ status: "passed", attempts: 1, flaky: false });
    // Failed once, passed on the retry — green, but flagged.
    expect(report.results[1]).toMatchObject({ status: "passed", attempts: 2, flaky: true });
    // Genuinely broken: every attempt burned, still red, not "flaky".
    expect(report.results[2]).toMatchObject({ status: "failed", attempts: 3, flaky: false });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}, 180_000);

it("stores and reads a suite file", async () => {
  await writeSuite(root, "suites/regression.json", { name: "regression", scripts: ["scripts/a.js"], retries: 1 });
  expect(await listSuites(root)).toEqual(["suites/regression.json"]);
  expect(await readSuite(root, "suites/regression.json")).toEqual({
    name: "regression",
    scripts: ["scripts/a.js"],
    retries: 1,
  });
  await expect(readSuite(root, "suites/nope.json")).rejects.toThrow(/no such suite/);
});
