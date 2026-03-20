import { getDb } from "../db.js";
import { logger } from "../lib/logger.js";
import { buildAgentPrompt } from "./agent-cron.js";
import { spawnAgentSession } from "./gateway-api.js";
import { cleanupAbandonedSteps, checkSessionAbortEvents } from "./step-ops.js";

const inflightDispatches = new Set<string>();

function getDispatchKey(runId: string, stepId: string): string {
  return `${runId}:${stepId}`;
}

function buildTask(step: { agent_id: string; workflow_id: string }): string {
  const prefix = `${step.workflow_id}_`;
  const localAgentId = step.agent_id.startsWith(prefix) ? step.agent_id.slice(prefix.length) : step.agent_id;
  return buildAgentPrompt(step.workflow_id, localAgentId);
}

export async function dispatchPendingStepNow(params: { runId: string; stepId: string }): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
  const key = getDispatchKey(params.runId, params.stepId);
  if (inflightDispatches.has(key)) {
    return { ok: true, skipped: true, reason: "dispatch already in flight" };
  }

  // Clean up any abandoned steps before dispatching - this handles cases where
  // previous agent attempts were aborted without reporting completion/failure
  cleanupAbandonedSteps();
  // Check session files for real-time abort detection
  checkSessionAbortEvents();

  inflightDispatches.add(key);
  try {
    const db = getDb();
    const step = db.prepare(
      `SELECT s.id, s.run_id, s.step_id, s.agent_id, r.workflow_id
       FROM steps s
       JOIN runs r ON r.id = s.run_id
       WHERE s.run_id = ? AND s.step_id = ? AND s.status = 'pending' AND r.status = 'running'
       LIMIT 1`
    ).get(params.runId, params.stepId) as {
      id: string;
      run_id: string;
      step_id: string;
      agent_id: string;
      workflow_id: string;
    } | undefined;

    if (!step) {
      return { ok: true, skipped: true, reason: "step no longer pending" };
    }

    const task = buildTask(step);
    const result = await spawnAgentSession({ agentId: step.agent_id, task, model: undefined });
    if (!result.ok) {
      logger.warn(`Realtime dispatch failed: ${result.error ?? "unknown error"}`, {
        runId: step.run_id,
        stepId: step.step_id,
      });
      return { ok: false, reason: result.error };
    }

    logger.info(`Realtime dispatch started for ${step.agent_id}`, {
      runId: step.run_id,
      stepId: step.step_id,
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Realtime dispatch crashed: ${message}`, {
      runId: params.runId,
      stepId: params.stepId,
    });
    return { ok: false, reason: message };
  } finally {
    inflightDispatches.delete(key);
  }
}

export function scheduleRealtimeDispatch(params: { runId: string; stepId: string }): void {
  queueMicrotask(() => {
    dispatchPendingStepNow(params).catch(() => {});
  });
}
