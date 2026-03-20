import { createAgentCronJob, deleteAgentCronJobs, deleteCronJob, listCronJobs, checkCronToolAvailable } from "./gateway-api.js";
import type { WorkflowSpec } from "./types.js";
import { resolveAntfarmCli } from "./paths.js";
import { getDb } from "../db.js";
import { readOpenClawConfig } from "./openclaw-config.js";

const DEFAULT_EVERY_MS = 300_000; // 5 minutes
const DEFAULT_AGENT_TIMEOUT_SECONDS = 30 * 60; // 30 minutes

export function buildAgentPrompt(workflowId: string, agentId: string): string {
  const fullAgentId = `${workflowId}_${agentId}`;
  const cli = resolveAntfarmCli();

  return `You are an Antfarm workflow agent. Check for pending work and execute it.

⚠️ CRITICAL: You MUST call "step complete" or "step fail" before ending your session. If you don't, the workflow will be stuck forever. This is non-negotiable.

Step 1 — Check for pending work:
\`\`\`
node ${cli} step claim "${fullAgentId}"
\`\`\`

If output is "NO_WORK", reply HEARTBEAT_OK and stop.

Step 2 — If JSON is returned, it contains: {"stepId": "...", "runId": "...", "attemptId": "...", "input": "..."}
Save both the stepId and attemptId — you'll need them to report completion.
The "input" field contains your FULLY RESOLVED task instructions. Read it carefully and DO the work.

Step 3 — Do the work described in the input. Format your output with KEY: value lines as specified.

Step 4 — MANDATORY: Report completion (do this IMMEDIATELY after finishing the work):
\`\`\`
cat <<'ANTFARM_EOF' > /tmp/antfarm-step-output.txt
STATUS: done
CHANGES: what you did
TESTS: what tests you ran
ANTFARM_EOF
cat /tmp/antfarm-step-output.txt | node ${cli} step complete "<stepId>" --attempt-id "<attemptId>"
\`\`\`

If the work FAILED:
\`\`\`
node ${cli} step fail "<stepId>" "description of what went wrong" --attempt-id "<attemptId>"
\`\`\`

RULES:
1. NEVER end your session without calling step complete or step fail
2. Write output to a file first, then pipe via stdin (shell escaping breaks direct args)
3. If you're unsure whether to complete or fail, call step fail with an explanation

The workflow cannot advance until you report. Your session ending without reporting = broken pipeline.`;
}

export function buildWorkPrompt(workflowId: string, agentId: string): string {
  const fullAgentId = `${workflowId}_${agentId}`;
  const cli = resolveAntfarmCli();

  return `You are an Antfarm workflow agent. Execute the pending work below.

⚠️ CRITICAL: You MUST call "step complete" or "step fail" before ending your session. If you don't, the workflow will be stuck forever. This is non-negotiable.

The claimed step JSON is provided below. It contains: {"stepId": "...", "runId": "...", "attemptId": "...", "input": "..."}
Save both the stepId and attemptId — you'll need them to report completion.
The "input" field contains your FULLY RESOLVED task instructions. Read it carefully and DO the work.

Do the work described in the input. Format your output with KEY: value lines as specified.

MANDATORY: Report completion (do this IMMEDIATELY after finishing the work):
\`\`\`
cat <<'ANTFARM_EOF' > /tmp/antfarm-step-output.txt
STATUS: done
CHANGES: what you did
TESTS: what tests you ran
ANTFARM_EOF
cat /tmp/antfarm-step-output.txt | node ${cli} step complete "<stepId>"
\`\`\`

If the work FAILED:
\`\`\`
node ${cli} step fail "<stepId>" "description of what went wrong"
\`\`\`

RULES:
1. NEVER end your session without calling step complete or step fail
2. Write output to a file first, then pipe via stdin (shell escaping breaks direct args)
3. If you're unsure whether to complete or fail, call step fail with an explanation

The workflow cannot advance until you report. Your session ending without reporting = broken pipeline.`;
}

const DEFAULT_POLLING_TIMEOUT_SECONDS = 120;
const DEFAULT_POLLING_MODEL = "default";

function extractModel(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const primary = (value as { primary?: unknown }).primary;
    if (typeof primary === "string") return primary;
  }
  return undefined;
}

async function resolveAgentCronModel(agentId: string, requestedModel?: string): Promise<string | undefined> {
  if (requestedModel && requestedModel !== "default") {
    return requestedModel;
  }

  try {
    const { config } = await readOpenClawConfig();
    const agents = config.agents?.list;
    if (Array.isArray(agents)) {
      const entry = agents.find((a: any) => a?.id === agentId);
      const configured = extractModel(entry?.model);
      if (configured) return configured;
    }

    const defaults = config.agents?.defaults;
    const fallback = extractModel(defaults?.model);
    if (fallback) return fallback;
  } catch {
    // best-effort — fallback below
  }

  return requestedModel;
}

export function buildPollingPrompt(workflowId: string, agentId: string, workModel?: string): string {
  const fullAgentId = `${workflowId}_${agentId}`;
  const cli = resolveAntfarmCli();
  const model = workModel ?? "default";
  const workPrompt = buildWorkPrompt(workflowId, agentId);

  return `Step 1 — Quick check for pending work (lightweight, no side effects):
\`\`\`
node ${cli} step peek "${fullAgentId}"
\`\`\`
If output is "NO_WORK", reply HEARTBEAT_OK and stop immediately. Do NOT run step claim.

Step 2 — If "HAS_WORK", claim the step:
\`\`\`
node ${cli} step claim "${fullAgentId}"
\`\`\`
If output is "NO_WORK", reply HEARTBEAT_OK and stop.

If JSON is returned, parse it to extract stepId, runId, and input fields.
Then call sessions_spawn with these parameters:
- agentId: "${fullAgentId}"
- model: "${model}"
- task: The full work prompt below, followed by "\\n\\nCLAIMED STEP JSON:\\n" and the exact JSON output from step claim.

Full work prompt to include in the spawned task:
---START WORK PROMPT---
${workPrompt}
---END WORK PROMPT---

Reply with a short summary of what you spawned.`;
}

export async function setupAgentCrons(workflow: WorkflowSpec): Promise<void> {
  const agents = workflow.agents;
  // Allow per-workflow cron interval via cron.interval_ms in workflow.yml
  const everyMs = (workflow as any).cron?.interval_ms ?? DEFAULT_EVERY_MS;

  // Resolve polling model: per-agent > workflow-level > default
  const workflowPollingModel = workflow.polling?.model ?? DEFAULT_POLLING_MODEL;
  const workflowPollingTimeout = workflow.polling?.timeoutSeconds ?? DEFAULT_POLLING_TIMEOUT_SECONDS;
  const cronPrefix = `antfarm/${workflow.id}/`;
  const existingResult = await listCronJobs();
  if (!existingResult.ok || !existingResult.jobs) {
    throw new Error(`Failed to inspect existing cron jobs before setup: ${existingResult.error ?? "unknown error"}`);
  }
  const existingJobs = existingResult.jobs.filter((job) => job.name.startsWith(cronPrefix));
  const existingByName = new Map<string, Array<{ id: string; name: string }>>();

  for (const job of existingJobs) {
    const bucket = existingByName.get(job.name) ?? [];
    bucket.push(job);
    existingByName.set(job.name, bucket);
  }

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const anchorMs = i * 60_000; // stagger by 1 minute each
    const cronName = `antfarm/${workflow.id}/${agent.id}`;
    const agentId = `${workflow.id}_${agent.id}`;
    const matchingJobs = existingByName.get(cronName) ?? [];

    // Keep at most one existing cron per agent name.
    // If duplicates already exist from older buggy runs, prune the extras.
    if (matchingJobs.length > 1) {
      for (const duplicate of matchingJobs.slice(1)) {
        await deleteCronJob(duplicate.id);
      }
    }
    if (matchingJobs.length > 0) continue;

    // Two-phase: Phase 1 uses cheap polling model + minimal prompt
    const requestedPollingModel = agent.pollingModel ?? workflowPollingModel;
    const pollingModel = await resolveAgentCronModel(agentId, requestedPollingModel);
    const requestedWorkModel = agent.model ?? workflowPollingModel;
    const workModel = await resolveAgentCronModel(agentId, requestedWorkModel);
    const prompt = buildPollingPrompt(workflow.id, agent.id, workModel);
    const timeoutSeconds = workflowPollingTimeout;

    const result = await createAgentCronJob({
      name: cronName,
      schedule: { kind: "every", everyMs, anchorMs },
      sessionTarget: "isolated",
      agentId,
      payload: { kind: "agentTurn", message: prompt, model: pollingModel, timeoutSeconds },
      delivery: { mode: "none" },
      enabled: true,
    });

    if (!result.ok) {
      throw new Error(`Failed to create cron job for agent "${agent.id}": ${result.error}`);
    }
  }
}

export async function removeAgentCrons(workflowId: string): Promise<void> {
  await deleteAgentCronJobs(`antfarm/${workflowId}/`);
}

// ── Run-scoped cron lifecycle ───────────────────────────────────────

/**
 * Count active (running) runs for a given workflow.
 */
function countActiveRuns(workflowId: string): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM runs WHERE workflow_id = ? AND status = 'running'"
  ).get(workflowId) as { cnt: number };
  return row.cnt;
}

/**
 * Inspect current cron jobs for a workflow.
 */
async function getWorkflowCronState(workflow: WorkflowSpec): Promise<{
  matchingJobs: Array<{ id: string; name: string; enabled?: boolean }>;
  expectedCount: number;
  healthy: boolean;
}> {
  const result = await listCronJobs();
  if (!result.ok || !result.jobs) {
    throw new Error(`Failed to inspect cron jobs: ${result.error ?? "unknown error"}`);
  }

  const prefix = `antfarm/${workflow.id}/`;
  const matchingJobs = result.jobs.filter((j) => j.name.startsWith(prefix));
  const enabledJobs = matchingJobs.filter((j) => j.enabled !== false);
  const healthy = matchingJobs.length === workflow.agents.length && enabledJobs.length === workflow.agents.length;
  return { matchingJobs, expectedCount: workflow.agents.length, healthy };
}

/**
 * Start crons for a workflow when a run begins.
 * Reuses a healthy existing set; otherwise tears down stale/disabled duplicates and recreates.
 */
export async function ensureWorkflowCrons(workflow: WorkflowSpec): Promise<void> {
  const state = await getWorkflowCronState(workflow);
  if (state.healthy) return;

  // Preflight: verify cron tool is accessible before attempting to create jobs
  const preflight = await checkCronToolAvailable();
  if (!preflight.ok) {
    throw new Error(preflight.error!);
  }

  if (state.matchingJobs.length > 0) {
    await removeAgentCrons(workflow.id);
  }

  await setupAgentCrons(workflow);
}

/**
 * Tear down crons for a workflow when a run ends.
 * Only removes if no other active runs exist for this workflow.
 */
export async function teardownWorkflowCronsIfIdle(workflowId: string): Promise<void> {
  const active = countActiveRuns(workflowId);
  if (active > 0) return;
  await removeAgentCrons(workflowId);
}
