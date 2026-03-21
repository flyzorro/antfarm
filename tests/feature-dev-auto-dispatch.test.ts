import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const repoRoot = path.resolve(import.meta.dirname, "..");

type Sandbox = {
  tmpHome: string;
  stateDir: string;
  workflowRoot: string;
  featureDevDest: string;
  configPath: string;
  eventsPath: string;
  dbPath: string;
};

function createSandbox(): Sandbox {
  const tmpHome = path.join(os.tmpdir(), `antfarm-auto-dispatch-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  const stateDir = path.join(tmpHome, ".openclaw");
  return {
    tmpHome,
    stateDir,
    workflowRoot: path.join(stateDir, "antfarm", "workflows"),
    featureDevDest: path.join(stateDir, "antfarm", "workflows", "feature-dev"),
    configPath: path.join(stateDir, "openclaw.json"),
    eventsPath: path.join(stateDir, "antfarm", "events.jsonl"),
    dbPath: path.join(stateDir, "antfarm", "antfarm.db"),
  };
}

function applySandboxEnv(sandbox: Sandbox) {
  const previous = {
    HOME: process.env.HOME,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    ANTFARM_DB_PATH: process.env.ANTFARM_DB_PATH,
    OPENCLAW_BIN: process.env.OPENCLAW_BIN,
    PATH: process.env.PATH,
    fetch: globalThis.fetch,
  };

  process.env.HOME = sandbox.tmpHome;
  process.env.OPENCLAW_STATE_DIR = sandbox.stateDir;
  process.env.OPENCLAW_CONFIG_PATH = sandbox.configPath;
  process.env.ANTFARM_DB_PATH = sandbox.dbPath;

  return async () => {
    globalThis.fetch = previous.fetch;
    if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
    if (previous.OPENCLAW_STATE_DIR === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previous.OPENCLAW_STATE_DIR;
    if (previous.OPENCLAW_CONFIG_PATH === undefined) delete process.env.OPENCLAW_CONFIG_PATH; else process.env.OPENCLAW_CONFIG_PATH = previous.OPENCLAW_CONFIG_PATH;
    if (previous.ANTFARM_DB_PATH === undefined) delete process.env.ANTFARM_DB_PATH; else process.env.ANTFARM_DB_PATH = previous.ANTFARM_DB_PATH;
    if (previous.OPENCLAW_BIN === undefined) delete process.env.OPENCLAW_BIN; else process.env.OPENCLAW_BIN = previous.OPENCLAW_BIN;
    if (previous.PATH === undefined) delete process.env.PATH; else process.env.PATH = previous.PATH;

    const dbMod = await import("../dist/db.js");
    dbMod.closeDbForTests?.();
    await fs.rm(sandbox.tmpHome, { recursive: true, force: true });
  };
}

async function resetSandbox(sandbox: Sandbox) {
  await fs.rm(sandbox.tmpHome, { recursive: true, force: true });
  await fs.mkdir(sandbox.featureDevDest, { recursive: true });
  await fs.cp(path.join(repoRoot, "workflows", "feature-dev"), sandbox.featureDevDest, { recursive: true });
  await fs.mkdir(sandbox.stateDir, { recursive: true });
  await fs.writeFile(
    sandbox.configPath,
    JSON.stringify({
      agents: {
        defaults: { model: "default" },
        list: [
          { id: "feature-dev_planner", workspace: path.join(sandbox.stateDir, "workspaces", "planner") },
          { id: "feature-dev_setup", workspace: path.join(sandbox.stateDir, "workspaces", "setup") },
          { id: "feature-dev_developer", workspace: path.join(sandbox.stateDir, "workspaces", "developer") },
          { id: "feature-dev_verifier", workspace: path.join(sandbox.stateDir, "workspaces", "verifier") },
          { id: "feature-dev_tester", workspace: path.join(sandbox.stateDir, "workspaces", "tester") },
          { id: "feature-dev_reviewer", workspace: path.join(sandbox.stateDir, "workspaces", "reviewer") },
        ],
      },
      gateway: {
        port: 18789,
        auth: { mode: "token", token: "test-token" },
      },
    }),
    "utf-8"
  );
}

async function loadModules() {
  const nonce = `?t=${Date.now()}-${Math.random()}`;
  const runMod = await import(`../dist/installer/run.js${nonce}`);
  const stepOps = await import(`../dist/installer/step-ops.js${nonce}`);
  const statusMod = await import(`../dist/installer/status.js${nonce}`);
  const eventsMod = await import(`../dist/installer/events.js${nonce}`);
  // Import db.js without a query so it shares the same module instance used by run/step/status.
  const dbMod = await import("../dist/db.js");
  return { ...runMod, ...stepOps, ...statusMod, ...eventsMod, ...dbMod };
}

function makeFetchCronMock() {
  const jobs: Array<{ id: string; name: string; agentId: string }> = [];

  globalThis.fetch = (async (_url: string | URL | globalThis.Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const action = body?.args?.action;

    if (action === "list") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { jobs } }),
        text: async () => JSON.stringify({ ok: true, result: { jobs } }),
      } as Response;
    }

    if (action === "add") {
      const job = body.args.job;
      const record = {
        id: `job-${jobs.length + 1}`,
        name: job.name,
        agentId: job.agentId,
      };
      jobs.push(record);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { id: record.id } }),
        text: async () => JSON.stringify({ ok: true, result: { id: record.id } }),
      } as Response;
    }

    if (action === "remove") {
      const idx = jobs.findIndex((job) => job.id === body.args.id);
      if (idx !== -1) jobs.splice(idx, 1);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => JSON.stringify({ ok: true }),
      } as Response;
    }

    throw new Error(`Unexpected cron action: ${action}`);
  }) as typeof fetch;

  return jobs;
}

function makeStepOutput(stepId: string): string {
  switch (stepId) {
    case "plan":
      return [
        "STATUS: done",
        "REPO: /tmp/fake-feature-dev-repo",
        "STORIES_JSON: [",
        '  {"id":"story-1","title":"Build API","description":"Add backend behavior","acceptance_criteria":["API works","Typecheck passes"]},',
        '  {"id":"story-2","title":"Polish UI","description":"Add frontend behavior","acceptance_criteria":["UI works","Typecheck passes"]}',
        "]",
      ].join("\n");
    case "setup":
      return [
        "STATUS: done",
        "BUILD_CMD: npm run build",
        "TEST_CMD: node --test",
        "CI_NOTES: baseline green",
        "BASELINE: clean",
      ].join("\n");
    case "implement":
      return [
        "STATUS: done",
        `CHANGES: implemented ${crypto.randomUUID().slice(0, 8)}`,
        "TESTS: added focused coverage",
      ].join("\n");
    case "verify":
      return [
        "STATUS: done",
        "VERIFIED: acceptance criteria and tests passed",
      ].join("\n");
    case "test":
      return [
        "STATUS: done",
        "RESULTS: integration suite passed",
      ].join("\n");
    case "pr":
      return [
        "STATUS: done",
        "PR: https://example.test/pr/123",
      ].join("\n");
    case "review":
      return [
        "STATUS: done",
        "DECISION: approved",
      ].join("\n");
    default:
      throw new Error(`Unhandled step output for ${stepId}`);
  }
}

test("feature-dev run self-advances through all seven steps via agent cron polling", async () => {
  const sandbox = createSandbox();
  const restore = applySandboxEnv(sandbox);
  await resetSandbox(sandbox);
  const jobs = makeFetchCronMock();

  try {
    const { runWorkflow, claimStep, peekStep, completeStep, getWorkflowStatus, getRunEvents, getDb } = await loadModules();

    const run = await runWorkflow({ workflowId: "feature-dev", taskTitle: "Ship auto-dispatch proof", workBranch: "feat/auto-dispatch" });
  assert.equal(run.status, "running");
  assert.equal(jobs.length, 6, "feature-dev provisions one cron per unique agent");

  const db = getDb();
  const claimOrder: string[] = [];

  for (let guard = 0; guard < 20; guard++) {
    const status = getWorkflowStatus(run.id);
    assert.equal(status.status, "ok");
    if (status.run.status === "completed") break;

    let progressed = false;
    for (const job of jobs) {
      if (peekStep(job.agentId) !== "HAS_WORK") continue;

      const claim = claimStep(job.agentId);
      if (!claim.found || !claim.stepId) continue;

      const row = db.prepare("SELECT step_id FROM steps WHERE id = ?").get(claim.stepId) as { step_id: string };
      claimOrder.push(row.step_id);
      completeStep(claim.stepId, makeStepOutput(row.step_id));
      progressed = true;
    }

    if (!progressed) {
      assert.fail("cron polling made no progress before the run completed");
    }
  }

    const finalStatus = getWorkflowStatus(run.id);
    assert.equal(finalStatus.status, "ok");
    assert.equal(finalStatus.run.status, "completed");
    assert.deepEqual(
      finalStatus.steps.map((step) => [step.step_id, step.status]),
      [
        ["plan", "done"],
        ["setup", "done"],
        ["implement", "done"],
        ["verify", "done"],
        ["test", "done"],
        ["pr", "done"],
        ["review", "done"],
      ],
      "all seven pipeline steps should finish without manual triggering"
    );

    const storyRows = (db.prepare(
      "SELECT story_id, status FROM stories WHERE run_id = ? ORDER BY story_index ASC"
    ).all(run.id) as Array<{ story_id: string; status: string }>).map((row) => ({ ...row }));
    assert.deepEqual(storyRows, [
      { story_id: "story-1", status: "done" },
      { story_id: "story-2", status: "done" },
    ]);

    assert.deepEqual(
      claimOrder,
      ["plan", "setup", "implement", "verify", "implement", "verify", "test", "pr", "review"],
      "cron-driven claims should follow the intended feature-dev pipeline order"
    );

    const events = getRunEvents(run.id);
    assert.ok(events.some((evt) => evt.event === "run.started"), "run.started emitted");
    assert.ok(events.some((evt) => evt.event === "story.verified"), "verify_each path executed");
    assert.ok(events.some((evt) => evt.event === "run.completed"), "run.completed emitted");
  } finally {
    await restore();
  }
});

test("runWorkflow can start via CLI cron fallback when gateway cron HTTP is unavailable", async () => {
  const sandbox = createSandbox();
  const restore = applySandboxEnv(sandbox);
  await resetSandbox(sandbox);

  const binDir = path.join(sandbox.tmpHome, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const cliLog = path.join(sandbox.tmpHome, "openclaw-cli.log");
  const openclawBin = path.join(binDir, "openclaw");
  await fs.writeFile(
    openclawBin,
    `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(cliLog)}
if [ "$1" = "cron" ] && [ "$2" = "list" ]; then
  printf '[]\n'
  exit 0
fi
if [ "$1" = "cron" ] && [ "$2" = "add" ]; then
  printf '{"id":"cli-job"}\n'
  exit 0
fi
if [ "$1" = "cron" ] && [ "$2" = "rm" ]; then
  printf '{"ok":true}\n'
  exit 0
fi
exit 1
`,
    { mode: 0o755 }
  );
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.OPENCLAW_BIN = openclawBin;

  globalThis.fetch = (async () => ({
    ok: false,
    status: 404,
    json: async () => ({ ok: false }),
    text: async () => "not found",
  })) as typeof fetch;

  try {
    const { runWorkflow, getWorkflowStatus } = await loadModules();
    const run = await runWorkflow({ workflowId: "feature-dev", taskTitle: "CLI fallback boot" });

    const status = getWorkflowStatus(run.id);
    assert.equal(status.status, "ok");
    assert.equal(status.run.status, "running", "run starts even when cron setup needs CLI fallback");

    const cliCalls = await fs.readFile(cliLog, "utf-8");
    assert.match(cliCalls, /cron list --json/, "preflight/list used CLI fallback");
    assert.match(cliCalls, /cron add --json(?: --timeout 30000)? --name antfarm\/feature-dev\/planner/, "cron creation used CLI fallback");
  } finally {
    await restore();
  }
});
