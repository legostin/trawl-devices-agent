import { expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Runner } from "./runner.js";
import { SessionStore } from "./sessions.js";
import { validateDevice } from "./devices.js";
import type { RunReport } from "./types.js";

const device = validateDevice({ id: "t", name: "T", headless: true, proxy: { mode: "none" }, trace: "off" });
const sessions = new SessionStore();
let server: http.Server;
let origin: string;
let runner: Runner;
let root: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<button id="go" onclick="fetch('/api/login',{method:'POST'}).then(()=>document.title='done')">go</button>`,
      );
    } else if (req.url === "/api/login") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"token":"eyJabc"}');
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await sessions.stopAll();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "trf-"));
  runner = new Runner({ sessions, workspace: root, trawlProxyPort: 8080 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const finish = async (code: string): Promise<RunReport> => {
  const started = await runner.start({ code, device, env: {}, secrets: {} });
  for (let i = 0; i < 300; i++) {
    const report = runner.get(started.runId)!;
    if (report.status !== "running") return report;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("run did not finish");
};

it("passes an HTTP assertion and attributes each flow to the step that issued it", async () => {
  const report = await finish(`
    goto('${origin}/')
    click({ css: '#go' })
    expectResponse('POST /api/login', { status: 200, jsonPath: { '$.token': /^eyJ/ } })
  `);
  expect(report.status).toBe("passed");

  // The navigation is unambiguous: goto waits for its own response.
  const gotoStep = report.steps.find((s) => s.action === "goto")!;
  expect(gotoStep.flows.map((f) => f.status)).toEqual([200]);

  // The XHR is fired by the click; it lands on whichever step was running when
  // the request went out, and appears exactly once in the report.
  const loginFlows = report.steps.flatMap((s) => s.flows).filter((f) => f.url.endsWith("/api/login"));
  expect(loginFlows).toHaveLength(1);
  expect(loginFlows[0]).toMatchObject({ method: "POST", status: 200 });
});

it("fails when the expected request never happens", async () => {
  const report = await finish(`
    use({ timeout: 800 })
    goto('${origin}/')
    expectResponse('POST /api/never')
  `);
  expect(report.status).toBe("failed");
  expect(report.steps.at(-1)!.error?.kind).toBe("assertion");
});

it("fails when the status does not match", async () => {
  const report = await finish(`
    goto('${origin}/')
    click({ css: '#go' })
    expectResponse('POST /api/login', { status: 500 })
  `);
  expect(report.status).toBe("failed");
  expect(report.steps.at(-1)!.error?.expected).toBe("500");
  expect(report.steps.at(-1)!.error?.actual).toBe("200");
});

it("expectNoRequest passes when nothing matches", async () => {
  const report = await finish(`
    goto('${origin}/')
    expectNoRequest('POST /api/logout')
  `);
  expect(report.status).toBe("passed");
});

it("marks every request with the run and step headers", async () => {
  const seen: { step: string | undefined; run: string | undefined }[] = [];
  server.on("request", (req) => {
    seen.push({ step: req.headers["x-trawl-step"] as string, run: req.headers["x-trawl-run"] as string });
  });
  const report = await finish(`
    goto('${origin}/')
    click({ css: '#go' })
    expectResponse('POST /api/login')
  `);
  expect(report.status).toBe("passed");
  expect(seen.every((s) => s.run === report.runId)).toBe(true);
  expect(seen.some((s) => s.step === "1")).toBe(true);
});
