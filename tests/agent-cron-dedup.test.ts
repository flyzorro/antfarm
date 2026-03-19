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
  dbPath: string;
};

function createSandbox(): Sandbox {
  const tmpHome = path.join(os.tmpdir(), `antfarm-cron-dedup-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  const stateDir = path.join(tmpHome, ".openclaw");
  return {
    tmpHome,
    stateDir,
    workflowRoot: path.join(stateDir, "antfarm", "workflows"),
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
    OPENCLAW_BIN: process.env.OPENCLAW_BIN,
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

function makeFetchCronMock() {
  const jobs: Array<{ id: string; name: string; enabled: boolean }> = [];
  let addCalls = 0;
  let removeCalls = 0;
  let listSawIncludeDisabled = false;

  globalThis.fetch = (async (_url: string | URL | globalThis.Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const action = body?.args?.action;

    if (action === "list") {
      if (body?.args?.includeDisabled === true) listSawIncludeDisabled = true;
      const includeDisabled = body?.args?.includeDisabled === true;
      const visibleJobs = (includeDisabled ? jobs : jobs.filter((job) => job.enabled !== false)).map((job) => ({ ...job }));
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { jobs: visibleJobs } }),
        text: async () => JSON.stringify({ ok: true, result: { jobs: visibleJobs } }),
      } as Response;
    }

    if (action === "add") {
      const job = body.args.job;
      addCalls += 1;
      jobs.push({ id: `job-${addCalls}`, name: job.name, enabled: job.enabled !== false });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { id: `job-${addCalls}` } }),
        text: async () => JSON.stringify({ ok: true, result: { id: `job-${addCalls}` } }),
      } as Response;
    }

    if (action === "remove") {
      removeCalls += 1;
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

  return {
    jobs,
    get addCalls() { return addCalls; },
    get removeCalls() { return removeCalls; },
    get listSawIncludeDisabled() { return listSawIncludeDisabled; },
  };
}

test("ensureWorkflowCrons recreates disabled antfarm jobs instead of accumulating duplicates", async () => {
  const sandbox = createSandbox();
  const restore = applySandboxEnv(sandbox);
  await resetSandbox(sandbox);
  const cron = makeFetchCronMock();

  try {
    const nonce = `?t=${Date.now()}-${Math.random()}`;
    const { ensureWorkflowCrons } = await import(`../dist/installer/agent-cron.js${nonce}`);
    const { loadWorkflowSpec } = await import(`../dist/installer/workflow-spec.js${nonce}`);
    const { resolveWorkflowDir } = await import(`../dist/installer/paths.js${nonce}`);

    const workflow = await loadWorkflowSpec(resolveWorkflowDir("feature-dev"));

    await ensureWorkflowCrons(workflow);
    assert.equal(cron.jobs.length, 6, "initial setup creates one cron per unique feature-dev agent");
    assert.equal(cron.addCalls, 6);

    for (const job of cron.jobs) job.enabled = false;

    await ensureWorkflowCrons(workflow);

    assert.equal(cron.jobs.length, 6, "second ensure should replace disabled jobs, not append another 6");
    assert.equal(cron.removeCalls, 6, "disabled jobs should be removed before recreation");
    assert.equal(cron.addCalls, 12, "fresh replacement jobs should be created after teardown");
    assert.ok(cron.jobs.every((job) => job.enabled), "replacement jobs should be enabled");
    assert.equal(cron.listSawIncludeDisabled, true, "cron listing must include disabled jobs so stale jobs are visible");
  } finally {
    await restore();
  }
});
