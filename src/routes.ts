import type { Route } from "./server.js";
import { SessionStore } from "./sessions.js";
import { Runner } from "./runner.js";
import { getDevice, loadDevices, saveDevice } from "./devices.js";
import { listScripts, readScript, writeScript } from "./workspace.js";
import { collect } from "./sandbox.js";
import { AgentError } from "./types.js";
import { RecorderStore } from "./recorder.js";
import { performAction, snapshot, type ActionInput } from "./control.js";
import { readGuide } from "./guide.js";
import { listArtifacts, listRuns, readArtifact } from "./archive.js";
import { heal } from "./heal.js";
import { listSuites, readSuite, writeSuite, SuiteRunner, type SuiteFile } from "./suites.js";

export interface RouteDeps {
  workspace: string;
  trawlProxyPort?: number;
  sessions?: SessionStore;
  runner?: Runner;
}

export function buildRoutes(deps: RouteDeps): Route[] {
  const workspace = deps.workspace;
  const sessions = deps.sessions ?? new SessionStore();
  const trawlProxyPort = deps.trawlProxyPort ?? 8080;
  const runner = deps.runner ?? new Runner({ sessions, workspace, trawlProxyPort });
  const recorder = new RecorderStore({ sessions, workspace });
  const suites = new SuiteRunner(runner, workspace);

  const body = <T>(value: unknown): T => {
    if (!value || typeof value !== "object") throw new AgentError("script", "a JSON body is required");
    return value as T;
  };

  return [
    {
      method: "GET",
      path: "/devices",
      handler: async () => ({ devices: await loadDevices(workspace), sessions: sessions.list() }),
    },
    { method: "POST", path: "/devices", handler: async (_r, _p, b) => ({ device: await saveDevice(workspace, b) }) },

    {
      method: "POST",
      path: "/sessions",
      handler: async (_r, _p, b) => {
        const { deviceId, headless, proxyPort } = body<{
          deviceId: string;
          headless?: boolean;
          proxyPort?: number;
        }>(b);
        const device = await getDevice(workspace, deviceId);
        return {
          session: await sessions.start(device, { trawlProxyPort: proxyPort ?? trawlProxyPort, headless }),
        };
      },
    },
    { method: "GET", path: "/sessions", handler: async () => ({ sessions: sessions.list() }) },
    {
      method: "DELETE",
      path: "/sessions/:id",
      handler: async (_r, p) => {
        await sessions.stop(p.id!);
        return { ok: true };
      },
    },

    { method: "GET", path: "/scripts", handler: async () => ({ scripts: await listScripts(workspace) }) },
    {
      method: "GET",
      path: "/scripts/read",
      handler: async (_r, p) => ({ code: await readScript(workspace, p.path!) }),
    },
    {
      method: "POST",
      path: "/scripts/write",
      handler: async (_r, _p, b) => {
        const { path: rel, code } = body<{ path: string; code: string }>(b);
        const validation = await collect(code);
        if (validation.errors.length) {
          throw new AgentError("script", `refusing to write: ${validation.errors.map((e) => e.message).join("; ")}`);
        }
        await writeScript(workspace, rel, code);
        return { path: rel, steps: validation.steps.length };
      },
    },
    {
      method: "POST",
      path: "/scripts/validate",
      handler: async (_r, _p, b) => {
        const { code, path: rel } = body<{ code?: string; path?: string }>(b);
        const source = code ?? (await readScript(workspace, rel!));
        return collect(source);
      },
    },

    {
      method: "POST",
      path: "/runs",
      handler: async (_r, _p, b) => {
        const input = body<{
          code?: string;
          path?: string;
          deviceId: string;
          sessionId?: string;
          env?: Record<string, string>;
          secrets?: Record<string, string>;
          headless?: boolean;
          proxyPort?: number;
          stepDelayMs?: number;
          closeAfterRun?: boolean;
          runTag?: string;
        }>(b);
        const code = input.code ?? (await readScript(workspace, input.path!));
        const device = await getDevice(workspace, input.deviceId);
        return runner.start({
          code,
          scriptPath: input.path,
          device,
          sessionId: input.sessionId,
          env: input.env ?? {},
          secrets: input.secrets ?? {},
          headless: input.headless,
          trawlProxyPort: input.proxyPort,
          stepDelayMs: input.stepDelayMs,
          closeAfterRun: input.closeAfterRun,
          runTag: input.runTag,
        });
      },
    },
    {
      method: "GET",
      path: "/runs",
      handler: async (_r, p) => {
        // Disk first (it outlives the process), then whatever is still running.
        const archived = await listRuns(workspace, {
          script: p.script,
          limit: Number(p.limit ?? 50),
        });
        const live = runner
          .list(50)
          .filter((r) => r.status === "running" && (!p.script || r.script === p.script));
        return { runs: [...live, ...archived.filter((a) => !live.some((l) => l.runId === a.runId))] };
      },
    },
    {
      method: "GET",
      path: "/runs/:id/artifacts",
      handler: async (_r, p) => ({ artifacts: await listArtifacts(workspace, p.id!) }),
    },
    {
      method: "GET",
      path: "/runs/:id/artifact",
      handler: async (_r, p) => readArtifact(workspace, p.id!, p.path!),
    },
    {
      method: "GET",
      path: "/runs/:id",
      handler: async (_r, p) => {
        const report = runner.get(p.id!);
        if (!report) throw new AgentError("agent", `unknown run: ${p.id}`);
        return report;
      },
    },
    { method: "DELETE", path: "/runs/:id", handler: async (_r, p) => ({ cancelled: runner.cancel(p.id!) }) },

    {
      method: "POST",
      path: "/record/start",
      handler: async (_r, _p, b) => {
        const { sessionId, deviceId, url, proxyPort } = body<{
          sessionId?: string;
          deviceId?: string;
          url?: string;
          proxyPort?: number;
        }>(b);
        if (!sessionId && !deviceId) throw new AgentError("script", "deviceId or sessionId is required");
        const id =
          sessionId ??
          (
            await sessions.start(await getDevice(workspace, deviceId!), {
              trawlProxyPort: proxyPort ?? trawlProxyPort,
            })
          ).sessionId;
        return recorder.start(id, url);
      },
    },
    { method: "GET", path: "/record/:id", handler: async (_r, p) => recorder.get(p.id!) },
    {
      method: "POST",
      path: "/record/:id/stop",
      handler: async (_r, p, b) =>
        recorder.stop(p.id!, (b ?? {}) as { saveAs?: string; withTraffic?: boolean; closeSession?: boolean }),
    },

    {
      method: "POST",
      path: "/control/snapshot",
      handler: async (_r, _p, b) => {
        const { sessionId } = body<{ sessionId: string }>(b);
        return { nodes: await snapshot(sessions.get(sessionId).page) };
      },
    },
    {
      method: "POST",
      path: "/control/do",
      handler: async (_r, _p, b) => {
        const { sessionId, ...action } = body<{ sessionId: string } & ActionInput>(b);
        return performAction(sessions.get(sessionId).page, action);
      },
    },

    { method: "GET", path: "/suites", handler: async () => ({ suites: await listSuites(workspace) }) },
    {
      method: "GET",
      path: "/suites/read",
      handler: async (_r, p) => readSuite(workspace, p.path!),
    },
    {
      method: "POST",
      path: "/suites/write",
      handler: async (_r, _p, b) => {
        const { path: rel, suite } = body<{ path: string; suite: SuiteFile }>(b);
        await writeSuite(workspace, rel, suite);
        return { path: rel, scripts: suite.scripts.length };
      },
    },
    {
      method: "POST",
      path: "/suites/run",
      handler: async (_r, _p, b) => {
        const input = body<{
          path?: string;
          scenarios?: { path: string; tag?: string }[];
          deviceId: string;
          retries?: number;
          env?: Record<string, string>;
          secrets?: Record<string, string>;
          proxyPort?: number;
          stepDelayMs?: number;
        }>(b);

        const file = input.path ? await readSuite(workspace, input.path) : null;
        const scenarios = input.scenarios ?? (file?.scripts ?? []).map((path) => ({ path }));
        if (scenarios.length === 0) throw new AgentError("script", "the suite has no scenarios");

        return suites.start({
          scenarios,
          device: await getDevice(workspace, input.deviceId),
          env: input.env ?? {},
          secrets: input.secrets ?? {},
          retries: input.retries ?? file?.retries ?? 0,
          proxyPort: input.proxyPort,
          stepDelayMs: input.stepDelayMs,
          suiteName: file?.name ?? input.path ?? "scenarios",
        });
      },
    },
    {
      method: "GET",
      path: "/suites/runs",
      handler: async (_r, p) => ({ suites: suites.list(Number(p.limit ?? 20)) }),
    },
    {
      method: "GET",
      path: "/suites/runs/:id",
      handler: async (_r, p) => {
        const found = suites.get(p.id!);
        if (!found) throw new AgentError("agent", `unknown suite run: ${p.id}`);
        return found;
      },
    },

    {
      method: "POST",
      path: "/heal",
      handler: async (_r, _p, b) => {
        const input = body<{
          runId: string;
          deviceId: string;
          env?: Record<string, string>;
          secrets?: Record<string, string>;
          proxyPort?: number;
        }>(b);
        const report = runner.get(input.runId) ?? (await listRuns(workspace)).find((r) => r.runId === input.runId);
        if (!report) throw new AgentError("agent", `unknown run: ${input.runId}`);
        const code = report.script ? await readScript(workspace, report.script) : null;
        if (!code) throw new AgentError("script", "healing needs a saved script — this run used inline code");
        return heal(sessions, workspace, {
          report,
          code,
          device: await getDevice(workspace, input.deviceId),
          env: input.env ?? {},
          secrets: input.secrets ?? {},
          proxyPort: input.proxyPort,
        });
      },
    },

    { method: "GET", path: "/guide", handler: async () => ({ guide: await readGuide() }) },
  ];
}
