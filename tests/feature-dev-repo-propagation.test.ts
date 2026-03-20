import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(repoRoot, "workflows", "feature-dev", "workflow.yml");
const plannerAgentsPath = path.join(repoRoot, "workflows", "feature-dev", "agents", "planner", "AGENTS.md");
const developerAgentsPath = path.join(repoRoot, "workflows", "feature-dev", "agents", "developer", "AGENTS.md");

type Sandbox = {
  tmpHome: string;
  stateDir: string;
  featureDevDest: string;
  configPath: string;
  dbPath: string;
};

function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createSandbox(): Sandbox {
  const tmpHome = path.join(
    os.tmpdir(),
    `antfarm-feature-dev-repo-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  );
  const stateDir = path.join(tmpHome, ".openclaw");
  return {
    tmpHome,
    stateDir,
    featureDevDest: path.join(stateDir, "antfarm", "workflows", "feature-dev"),
    configPath: path.join(stateDir, "openclaw.json"),
    dbPath: path.join(stateDir, "antfarm", "antfarm.db"),
  };
}

function applySandboxEnv(sandbox: Sandbox) {
  const previous = {
    HOME: process.env.HOME,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    ANTFARM_DB_PATH: process.env.ANTFARM_DB_PATH,
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

    const dbMod = await import("../dist/db.js");
    dbMod.closeDbForTests?.();
    await fsp.rm(sandbox.tmpHome, { recursive: true, force: true });
  };
}

async function resetSandbox(sandbox: Sandbox) {
  await fsp.rm(sandbox.tmpHome, { recursive: true, force: true });
  await fsp.mkdir(sandbox.featureDevDest, { recursive: true });
  await fsp.cp(path.join(repoRoot, "workflows", "feature-dev"), sandbox.featureDevDest, { recursive: true });
  await fsp.mkdir(sandbox.stateDir, { recursive: true });
  await fsp.writeFile(
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
    }),
    "utf-8"
  );
}

async function loadModules() {
  const nonce = `?t=${Date.now()}-${Math.random()}`;
  const runMod = await import(`../dist/installer/run.js${nonce}`);
  const stepOps = await import(`../dist/installer/step-ops.js${nonce}`);
  const dbMod = await import("../dist/db.js");
  return { ...runMod, ...stepOps, ...dbMod };
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
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => JSON.stringify({ ok: true }),
      } as Response;
    }

    throw new Error(`Unexpected cron action: ${action}`);
  }) as typeof fetch;
}

test("feature-dev repo propagation contract requires planner and developer to preserve the provided repo", () => {
  const workflow = read(workflowPath);
  const plannerAgents = read(plannerAgentsPath);
  const developerAgents = read(developerAgentsPath);

  assert.match(workflow, /REPO:\n\s+\{\{repo\}\}/);
  assert.match(workflow, /If the REPO above is non-empty, preserve that exact path in your reply's REPO field/);
  assert.match(workflow, /Do NOT guess a different repo, switch to another checkout\/worktree, or rewrite the provided REPO path/);

  assert.match(plannerAgents, /Echo that exact path in your `REPO:` line\./);
  assert.match(plannerAgents, /Do NOT guess a different repo, substitute another checkout\/worktree, or rewrite the provided path\./);
  assert.match(developerAgents, /Use the `REPO:` path from the step input exactly as provided/);
  assert.match(developerAgents, /Do not guess or switch to a different repo, checkout, or worktree/);
});

test("feature-dev seeds the planner input with the current git worktree repo", async () => {
  const sandbox = createSandbox();
  const restore = applySandboxEnv(sandbox);
  await resetSandbox(sandbox);
  makeFetchCronMock();

  const previousCwd = process.cwd();
  process.chdir(repoRoot);

  try {
    const { runWorkflow, claimStep } = await loadModules();

    const run = await runWorkflow({ workflowId: "feature-dev", taskTitle: "Use the current worktree repo" });
    assert.equal(run.status, "running");

    const planner = claimStep("feature-dev_planner");
    assert.ok(planner.found, "planner step should be claimable");
    assert.ok(planner.resolvedInput, "planner should receive resolved input");
    assert.match(planner.resolvedInput, new RegExp(`REPO:\\s+${escapeRegExp(repoRoot)}`));
  } finally {
    process.chdir(previousCwd);
    await restore();
  }
});

test("feature-dev preserves the seeded repo when the planner echoes a different path", async () => {
  const sandbox = createSandbox();
  const restore = applySandboxEnv(sandbox);
  await resetSandbox(sandbox);
  makeFetchCronMock();

  try {
    const { runWorkflow, claimStep, completeStep, getDb } = await loadModules();
    const providedRepo = "/tmp/feature-dev-explicit-repo";
    const guessedRepo = "/tmp/guessed-feature-dev-repo";

    const run = await runWorkflow({
      workflowId: "feature-dev",
      taskTitle: "Preserve the explicit repo path",
      repo: providedRepo,
    });

    const planner = claimStep("feature-dev_planner");
    assert.ok(planner.found, "planner step should be claimable");
    assert.ok(planner.stepId, "planner step should have an id");
    assert.ok(planner.resolvedInput, "planner should receive resolved input");
    assert.match(planner.resolvedInput, new RegExp(`REPO:\\s+${escapeRegExp(providedRepo)}`));

    completeStep(
      planner.stepId,
      [
        "STATUS: done",
        `REPO: ${guessedRepo}`,
        "BRANCH: feat/preserve-repo",
        'STORIES_JSON: [{"id":"US-001","title":"Keep repo stable","description":"Implement the requested fix","acceptance_criteria":["Tests for repo propagation pass","Typecheck passes"]}]',
      ].join("\n")
    );

    const db = getDb();
    const runRow = db.prepare("SELECT context FROM runs WHERE id = ?").get(run.id) as { context: string };
    const context = JSON.parse(runRow.context) as Record<string, string>;
    assert.equal(context.repo, providedRepo, "run context should keep the seeded repo");

    const setup = claimStep("feature-dev_setup");
    assert.ok(setup.found, "setup step should be claimable after planning");
    assert.ok(setup.resolvedInput, "setup should receive resolved input");
    assert.match(setup.resolvedInput, new RegExp(`REPO:\\s+${escapeRegExp(providedRepo)}`));
    assert.doesNotMatch(setup.resolvedInput, new RegExp(escapeRegExp(guessedRepo)));
  } finally {
    await restore();
  }
});
