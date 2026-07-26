import { AgentError, type RunReport, type TargetSpec } from "./types.js";
import { SessionStore } from "./sessions.js";
import { Runner } from "./runner.js";
import { snapshot, type SnapshotNode } from "./control.js";
import { similarity } from "./archive.js";
import { generate } from "./codegen.js";
import { describeTarget } from "./targets.js";

export interface HealRequest {
  report: RunReport;
  code: string;
  device: Parameters<Runner["start"]>[0]["device"];
  env: Record<string, string>;
  secrets: Record<string, string>;
  proxyPort?: number;
}

export interface HealResult {
  step: { index: number; action: string; target: TargetSpec | null; error?: string };
  /** Nodes the page actually offers, closest to the failed target first. */
  candidates: (SnapshotNode & { score: number })[];
  /** The scenario truncated to just before the failing step, for a re-run. */
  prefix: string;
}

const targetOf = (args: unknown[]): TargetSpec | null =>
  typeof args[0] === "object" && args[0] !== null ? (args[0] as TargetSpec) : null;

/**
 * Replays a scenario up to the step before the failure, then reports what the
 * page offers — the missing half of a failed run, since by the time anyone
 * looks the browser is long closed.
 */
export async function heal(
  sessions: SessionStore,
  workspace: string,
  request: HealRequest,
): Promise<HealResult> {
  const failed = request.report.steps.find((s) => s.status === "failed");
  if (!failed) throw new AgentError("script", `run ${request.report.runId} has no failed step`);

  const prefix = generate(
    request.report.steps.filter((s) => s.index < failed.index).map((s) => ({
      index: s.index,
      action: s.action,
      args: s.args,
      ...(s.name ? { name: s.name } : {}),
    })),
  );

  const runner = new Runner({ sessions, workspace, trawlProxyPort: request.proxyPort ?? 8080 });
  const started = await runner.start({
    code: prefix,
    device: { ...request.device, closeAfterRun: false },
    env: request.env,
    secrets: request.secrets,
  });

  let report = runner.get(started.runId)!;
  for (let i = 0; i < 600 && report.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    report = runner.get(started.runId)!;
  }
  if (!report.sessionId) {
    throw new AgentError("agent", `could not reach step ${failed.index}: the prefix run ended ${report.status}`);
  }

  try {
    const target = targetOf(failed.args);
    const wanted = target ? describeTarget(target) : failed.action;
    const nodes = await snapshot(sessions.get(report.sessionId).page);
    const candidates = nodes
      .filter((n) => n.visible && (n.name || n.label))
      .map((n) => ({ ...n, score: Math.max(similarity(wanted, n.name), similarity(wanted, n.label ?? "")) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);

    return {
      step: { index: failed.index, action: failed.action, target, error: failed.error?.message },
      candidates,
      prefix,
    };
  } finally {
    await sessions.stop(report.sessionId);
  }
}
