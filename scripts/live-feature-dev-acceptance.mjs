#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli", "cli.js");
const workflowId = process.env.ANTFARM_LIVE_WORKFLOW ?? "feature-dev";
const task = process.env.ANTFARM_LIVE_TASK ?? "Add --json output mode to workflow status while preserving current text output and tests.";
const timeoutMs = Number(process.env.ANTFARM_LIVE_TIMEOUT_MS ?? 20 * 60 * 1000);
const pollMs = Number(process.env.ANTFARM_LIVE_POLL_MS ?? 5000);

function run(args, options = {}) {
  return execFileSync("node", [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function tryRun(args) {
  const result = spawnSync("node", [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRunHeader(output) {
  const runMatch = output.match(/Run:\s+#(\d+)\s+\(([^)]+)\)/);
  if (!runMatch) throw new Error(`Could not parse run header from output:\n${output}`);
  return { runNumber: Number(runMatch[1]), runId: runMatch[2] };
}

function parseStatus(output) {
  const statusMatch = output.match(/^Status:\s+(.+)$/m);
  return statusMatch?.[1]?.trim() ?? "unknown";
}

function printSection(title, body) {
  process.stdout.write(`\n=== ${title} ===\n${body.endsWith("\n") ? body : body + "\n"}`);
}

async function main() {
  process.stdout.write(`[live-acceptance] repo=${repoRoot}\n`);
  process.stdout.write(`[live-acceptance] workflow=${workflowId}\n`);
  process.stdout.write(`[live-acceptance] task=${task}\n`);

  run(["workflow", "install", workflowId]);
  const started = run(["workflow", "run", workflowId, task]);
  printSection("workflow run", started);

  const { runNumber, runId } = parseRunHeader(started);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const statusOut = run(["workflow", "status", `#${runNumber}`]);
    const status = parseStatus(statusOut);
    printSection(`status #${runNumber}`, statusOut);

    if (status === "completed") {
      const events = tryRun(["logs", `#${runNumber}`]);
      if (events.status === 0) printSection(`events #${runNumber}`, events.stdout || "");
      process.stdout.write(`\nLIVE_ACCEPTANCE_RESULT=YES run=#${runNumber} id=${runId}\n`);
      return;
    }

    if (status === "failed" || status === "cancelled") {
      const events = tryRun(["logs", `#${runNumber}`]);
      if (events.status === 0) printSection(`events #${runNumber}`, events.stdout || "");
      process.stdout.write(`\nLIVE_ACCEPTANCE_RESULT=NO run=#${runNumber} id=${runId} status=${status}\n`);
      process.exit(1);
    }

    await sleep(pollMs);
  }

  const finalStatus = tryRun(["workflow", "status", `#${runNumber}`]);
  if (finalStatus.status === 0) printSection(`final status #${runNumber}`, finalStatus.stdout || "");
  const events = tryRun(["logs", `#${runNumber}`]);
  if (events.status === 0) printSection(`events #${runNumber}`, events.stdout || "");
  process.stdout.write(`\nLIVE_ACCEPTANCE_RESULT=PARTIAL run=#${runNumber} id=${runId} reason=timeout\n`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
