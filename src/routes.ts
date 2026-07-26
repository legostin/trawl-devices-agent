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
        });
      },
    },
    { method: "GET", path: "/runs", handler: async (_r, p) => ({ runs: runner.list(Number(p.limit ?? 20)) }) },
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

    { method: "GET", path: "/guide", handler: async () => ({ guide: await readGuide() }) },
  ];
}
