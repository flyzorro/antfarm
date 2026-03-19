import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function freshImport<T>(specifier: string): Promise<T> {
  return import(`${specifier}?t=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void, attempts = 50): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await tick();
    }
  }
  throw lastError;
}

test("feature-dev emits realtime dispatches across the whole 7-step pipeline", async () => {
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  const originalDbPath = process.env.ANTFARM_DB_PATH;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-feature-dev-home-"));
  const dbPath = path.join(homeDir, ".openclaw", "antfarm", `feature-dev-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.HOME = homeDir;
  process.env.ANTFARM_DB_PATH = dbPath;
  fs.mkdirSync(path.join(homeDir, ".openclaw"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".openclaw", "openclaw.json"), JSON.stringify({ agents: { list: [] } }, null, 2));

  const calls: Array<{ tool: string; body: any }> = [];
  globalThis.fetch = mock.fn(async (_url: string, init?: any) => {
    const body = JSON.parse(init.body);
    calls.push({ tool: body.tool, body });

    if (body.tool === "cron") {
      if (body.args.action === "list") {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) } as any;
      }
      if (body.args.action === "add") {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: `cron-${calls.length}` } }) } as any;
      }
    }

    if (body.tool === "sessions_spawn") {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { sessionId: `sess-${calls.length}` } }) } as any;
    }

    throw new Error(`unexpected tool ${body.tool}`);
  }) as any;

  try {
    const { installWorkflow } = await freshImport<typeof import("../dist/installer/install.js")>("../dist/installer/install.js");
    const { runWorkflow } = await freshImport<typeof import("../dist/installer/run.js")>("../dist/installer/run.js");
    const { claimStep, completeStep } = await freshImport<typeof import("../dist/installer/step-ops.js")>("../dist/installer/step-ops.js");

    await installWorkflow({ workflowId: "feature-dev" });
    const run = await runWorkflow({ workflowId: "feature-dev", taskTitle: "Add realtime dispatch" });
    await tick();

    const planner = claimStep("feature-dev_planner");
    assert.equal(planner.found, true);
    completeStep(planner.stepId!, `STATUS: done\nREPO: /tmp/repo\nBRANCH: feat/realtime\nSTORIES_JSON: [{"id":"story-1","title":"Implement feature","description":"do it","acceptance_criteria":["Tests for feature pass","Typecheck passes"]}]`);
    await tick();

    const setup = claimStep("feature-dev_setup");
    assert.equal(setup.found, true);
    completeStep(setup.stepId!, `STATUS: done\nBUILD_CMD: npm run build\nTEST_CMD: npm test\nCI_NOTES: none\nBASELINE: green`);
    await tick();

    const implement = claimStep("feature-dev_developer");
    assert.equal(implement.found, true);
    completeStep(implement.stepId!, `STATUS: done\nCHANGES: implemented story\nTESTS: npm test`);
    await tick();

    const verify = claimStep("feature-dev_verifier");
    assert.equal(verify.found, true);
    completeStep(verify.stepId!, `STATUS: done\nCHANGES: verified story`);
    await tick();

    const tester = claimStep("feature-dev_tester");
    assert.equal(tester.found, true);
    completeStep(tester.stepId!, `STATUS: done\nRESULTS: all integration tests passed`);
    await tick();

    const pr = claimStep("feature-dev_developer");
    assert.equal(pr.found, true);
    completeStep(pr.stepId!, `STATUS: done\nPR: https://example.test/pr/1`);
    await tick();

    const review = claimStep("feature-dev_reviewer");
    assert.equal(review.found, true);
    completeStep(review.stepId!, `STATUS: done\nREVIEW: approved`);
    await tick();

    await waitFor(() => {
      const spawnCalls = calls.filter((call) => call.tool === "sessions_spawn");
      assert.equal(spawnCalls.length, 7, "expected one realtime dispatch per feature-dev step");
    });

    const spawnCalls = calls.filter((call) => call.tool === "sessions_spawn");
    assert.deepEqual(
      spawnCalls.map((call) => call.body.args.agentId),
      [
        "feature-dev_planner",
        "feature-dev_setup",
        "feature-dev_developer",
        "feature-dev_verifier",
        "feature-dev_tester",
        "feature-dev_developer",
        "feature-dev_reviewer",
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDbPath === undefined) delete process.env.ANTFARM_DB_PATH;
    else process.env.ANTFARM_DB_PATH = originalDbPath;
    process.env.HOME = originalHome;
    const dbMod = await import("../dist/db.js");
    dbMod.closeDbForTests?.();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("feature-dev tester step claims even though its instructions mention downstream RESULTS handoff", async () => {
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  const originalDbPath = process.env.ANTFARM_DB_PATH;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-feature-dev-home-"));
  const dbPath = path.join(homeDir, ".openclaw", "antfarm", `feature-dev-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.HOME = homeDir;
  process.env.ANTFARM_DB_PATH = dbPath;
  fs.mkdirSync(path.join(homeDir, ".openclaw"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".openclaw", "openclaw.json"), JSON.stringify({ agents: { list: [] } }, null, 2));

  globalThis.fetch = mock.fn(async (_url: string, init?: any) => {
    const body = JSON.parse(init.body);
    if (body.tool === "cron") {
      if (body.args.action === "list") {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) } as any;
      }
      if (body.args.action === "add") {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: `cron-${Date.now()}` } }) } as any;
      }
    }
    if (body.tool === "sessions_spawn") {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { sessionId: `sess-${Date.now()}` } }) } as any;
    }
    throw new Error(`unexpected tool ${body.tool}`);
  }) as any;

  try {
    const { installWorkflow } = await freshImport<typeof import("../dist/installer/install.js")>("../dist/installer/install.js");
    const { runWorkflow } = await freshImport<typeof import("../dist/installer/run.js")>("../dist/installer/run.js");
    const { claimStep, completeStep } = await freshImport<typeof import("../dist/installer/step-ops.js")>("../dist/installer/step-ops.js");

    await installWorkflow({ workflowId: "feature-dev" });
    await runWorkflow({ workflowId: "feature-dev", taskTitle: "Keep tester claimable before RESULTS exist" });
    await tick();

    completeStep(claimStep("feature-dev_planner").stepId!, `STATUS: done\nREPO: /tmp/repo\nBRANCH: feat/realtime\nSTORIES_JSON: [{"id":"story-1","title":"Implement feature","description":"do it","acceptance_criteria":["Tests for feature pass","Typecheck passes"]}]`);
    await tick();
    completeStep(claimStep("feature-dev_setup").stepId!, `STATUS: done\nBUILD_CMD: npm run build\nTEST_CMD: npm test\nCI_NOTES: none\nBASELINE: green`);
    await tick();
    completeStep(claimStep("feature-dev_developer").stepId!, `STATUS: done\nCHANGES: implemented story\nTESTS: npm test`);
    await tick();
    completeStep(claimStep("feature-dev_verifier").stepId!, `STATUS: done\nVERIFIED: story looks good`);
    await tick();

    const tester = claimStep("feature-dev_tester");
    assert.equal(tester.found, true, "tester step should remain claimable before tester has produced RESULTS");
    assert.doesNotMatch(tester.resolvedInput ?? "", /\[missing: results\]/i);
    assert.match(tester.resolvedInput ?? "", /downstream PR step consumes the tester `RESULTS` field/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDbPath === undefined) delete process.env.ANTFARM_DB_PATH;
    else process.env.ANTFARM_DB_PATH = originalDbPath;
    process.env.HOME = originalHome;
    const dbMod = await import("../dist/db.js");
    dbMod.closeDbForTests?.();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("feature-dev PR step still claims when tester outputs mixed-case markdown keys", async () => {
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  const originalDbPath = process.env.ANTFARM_DB_PATH;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-feature-dev-home-"));
  const dbPath = path.join(homeDir, ".openclaw", "antfarm", `feature-dev-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.HOME = homeDir;
  process.env.ANTFARM_DB_PATH = dbPath;
  fs.mkdirSync(path.join(homeDir, ".openclaw"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".openclaw", "openclaw.json"), JSON.stringify({ agents: { list: [] } }, null, 2));

  globalThis.fetch = mock.fn(async (_url: string, init?: any) => {
    const body = JSON.parse(init.body);
    if (body.tool === "cron") {
      if (body.args.action === "list") {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) } as any;
      }
      if (body.args.action === "add") {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: `cron-${Date.now()}` } }) } as any;
      }
    }
    if (body.tool === "sessions_spawn") {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { sessionId: `sess-${Date.now()}` } }) } as any;
    }
    throw new Error(`unexpected tool ${body.tool}`);
  }) as any;

  try {
    const { installWorkflow } = await freshImport<typeof import("../dist/installer/install.js")>("../dist/installer/install.js");
    const { runWorkflow } = await freshImport<typeof import("../dist/installer/run.js")>("../dist/installer/run.js");
    const { claimStep, completeStep } = await freshImport<typeof import("../dist/installer/step-ops.js")>("../dist/installer/step-ops.js");

    await installWorkflow({ workflowId: "feature-dev" });
    await runWorkflow({ workflowId: "feature-dev", taskTitle: "Preserve PR handoff" });
    await tick();

    completeStep(claimStep("feature-dev_planner").stepId!, `STATUS: done\nREPO: /tmp/repo\nBRANCH: feat/realtime\nSTORIES_JSON: [{"id":"story-1","title":"Implement feature","description":"do it","acceptance_criteria":["Tests for feature pass","Typecheck passes"]}]`);
    await tick();
    completeStep(claimStep("feature-dev_setup").stepId!, `STATUS: done\nBUILD_CMD: npm run build\nTEST_CMD: npm test\nCI_NOTES: none\nBASELINE: green`);
    await tick();
    completeStep(claimStep("feature-dev_developer").stepId!, `STATUS: done\nCHANGES: implemented story\nTESTS: npm test`);
    await tick();
    completeStep(claimStep("feature-dev_verifier").stepId!, `STATUS: done\nVERIFIED: story looks good`);
    await tick();

    const tester = claimStep("feature-dev_tester");
    assert.equal(tester.found, true);
    completeStep(tester.stepId!, `**Status:** done\n- **Results:** integration suite passed`);
    await tick();

    const pr = claimStep("feature-dev_developer");
    assert.equal(pr.found, true, "PR step should remain claimable when tester uses mixed-case markdown keys");
    assert.match(pr.resolvedInput ?? "", /RESULTS: integration suite passed/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDbPath === undefined) delete process.env.ANTFARM_DB_PATH;
    else process.env.ANTFARM_DB_PATH = originalDbPath;
    process.env.HOME = originalHome;
    const dbMod = await import("../dist/db.js");
    dbMod.closeDbForTests?.();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});


test("feature-dev fails closed before re-claiming a verify_each story that already exhausted retries", async () => {
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  const originalDbPath = process.env.ANTFARM_DB_PATH;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-feature-dev-home-"));
  const dbPath = path.join(homeDir, ".openclaw", "antfarm", `feature-dev-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.HOME = homeDir;
  process.env.ANTFARM_DB_PATH = dbPath;
  fs.mkdirSync(path.join(homeDir, ".openclaw"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".openclaw", "openclaw.json"), JSON.stringify({ agents: { list: [] } }, null, 2));

  globalThis.fetch = mock.fn(async (_url: string, init?: any) => {
    const body = JSON.parse(init.body);
    if (body.tool === "cron") {
      if (body.args.action === "list") {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) } as any;
      }
      if (body.args.action === "add") {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: `cron-${Date.now()}` } }) } as any;
      }
    }
    if (body.tool === "sessions_spawn") {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { sessionId: `sess-${Date.now()}` } }) } as any;
    }
    throw new Error(`unexpected tool ${body.tool}`);
  }) as any;

  try {
    const { installWorkflow } = await freshImport<typeof import("../dist/installer/install.js")>("../dist/installer/install.js");
    const { runWorkflow } = await freshImport<typeof import("../dist/installer/run.js")>("../dist/installer/run.js");
    const { claimStep, completeStep } = await freshImport<typeof import("../dist/installer/step-ops.js")>("../dist/installer/step-ops.js");
    const dbMod = await import("../dist/db.js");

    await installWorkflow({ workflowId: "feature-dev" });
    const run = await runWorkflow({ workflowId: "feature-dev", taskTitle: "Stop before exhausted verify_each re-claim" });
    await tick();

    completeStep(claimStep("feature-dev_planner").stepId!, `STATUS: done
REPO: /tmp/repo
BRANCH: feat/retry-guard
STORIES_JSON: [{"id":"story-1","title":"Implement feature","description":"do it","acceptance_criteria":["Tests for feature pass","Typecheck passes"]}]`);
    await tick();
    completeStep(claimStep("feature-dev_setup").stepId!, `STATUS: done
BUILD_CMD: npm run build
TEST_CMD: npm test
CI_NOTES: none
BASELINE: green`);
    await tick();

    completeStep(claimStep("feature-dev_developer").stepId!, `STATUS: done
CHANGES: implemented story
TESTS: npm test`);
    await tick();
    completeStep(claimStep("feature-dev_verifier").stepId!, `STATUS: retry
ISSUES: first verification failure`);
    await tick();

    completeStep(claimStep("feature-dev_developer").stepId!, `STATUS: done
CHANGES: retried implementation
TESTS: npm test`);
    await tick();
    completeStep(claimStep("feature-dev_verifier").stepId!, `STATUS: retry
ISSUES: second verification failure`);
    await tick();

    const thirdImplement = claimStep("feature-dev_developer");
    assert.equal(thirdImplement.found, false, "developer must not reclaim a story that already used all retries");

    const db = dbMod.getDb();
    const runRow = db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id) as { status: string };
    const implementRow = db.prepare("SELECT status, output FROM steps WHERE run_id = ? AND step_id = 'implement'").get(run.id) as { status: string; output: string };
    const verifyRow = db.prepare("SELECT status FROM steps WHERE run_id = ? AND step_id = 'verify'").get(run.id) as { status: string };
    const storyRow = db.prepare("SELECT status, retry_count, max_retries FROM stories WHERE run_id = ? ORDER BY story_index ASC LIMIT 1").get(run.id) as { status: string; retry_count: number; max_retries: number };

    assert.equal(runRow.status, "failed");
    assert.equal(implementRow.status, "failed");
    assert.match(implementRow.output, /exhausted retries/i);
    assert.equal(verifyRow.status, "waiting");
    assert.equal(storyRow.status, "failed");
    assert.equal(storyRow.retry_count, 2);
    assert.equal(storyRow.max_retries, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDbPath === undefined) delete process.env.ANTFARM_DB_PATH;
    else process.env.ANTFARM_DB_PATH = originalDbPath;
    process.env.HOME = originalHome;
    const dbMod = await import("../dist/db.js");
    dbMod.closeDbForTests?.();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});


test("feature-dev fails closed when tester reports retry instead of done", async () => {
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  const originalDbPath = process.env.ANTFARM_DB_PATH;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-feature-dev-home-"));
  const dbPath = path.join(homeDir, ".openclaw", "antfarm", `feature-dev-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.HOME = homeDir;
  process.env.ANTFARM_DB_PATH = dbPath;
  fs.mkdirSync(path.join(homeDir, ".openclaw"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".openclaw", "openclaw.json"), JSON.stringify({ agents: { list: [] } }, null, 2));

  globalThis.fetch = mock.fn(async (_url: string, init?: any) => {
    const body = JSON.parse(init.body);
    if (body.tool === "cron") {
      if (body.args.action === "list") {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) } as any;
      }
      if (body.args.action === "add") {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: `cron-${Date.now()}` } }) } as any;
      }
    }
    if (body.tool === "sessions_spawn") {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { sessionId: `sess-${Date.now()}` } }) } as any;
    }
    throw new Error(`unexpected tool ${body.tool}`);
  }) as any;

  try {
    const { installWorkflow } = await freshImport<typeof import("../dist/installer/install.js")>("../dist/installer/install.js");
    const { runWorkflow } = await freshImport<typeof import("../dist/installer/run.js")>("../dist/installer/run.js");
    const { claimStep, completeStep } = await freshImport<typeof import("../dist/installer/step-ops.js")>("../dist/installer/step-ops.js");
    const dbMod = await import("../dist/db.js");

    await installWorkflow({ workflowId: "feature-dev" });
    const run = await runWorkflow({ workflowId: "feature-dev", taskTitle: "Fail closed on tester retry" });
    await tick();

    completeStep(claimStep("feature-dev_planner").stepId!, `STATUS: done
REPO: /tmp/repo
BRANCH: feat/realtime
STORIES_JSON: [{"id":"story-1","title":"Implement feature","description":"do it","acceptance_criteria":["Tests for feature pass","Typecheck passes"]}]`);
    await tick();
    completeStep(claimStep("feature-dev_setup").stepId!, `STATUS: done
BUILD_CMD: npm run build
TEST_CMD: npm test
CI_NOTES: none
BASELINE: green`);
    await tick();
    completeStep(claimStep("feature-dev_developer").stepId!, `STATUS: done
CHANGES: implemented story
TESTS: npm test`);
    await tick();
    completeStep(claimStep("feature-dev_verifier").stepId!, `STATUS: done
VERIFIED: story looks good`);
    await tick();

    const tester = claimStep("feature-dev_tester");
    assert.equal(tester.found, true);
    completeStep(tester.stepId!, `STATUS: retry
FAILURES: integration regression found`);
    await tick();

    const db = dbMod.getDb();
    const runRow = db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id) as { status: string };
    const testRow = db.prepare("SELECT step_index, status, output FROM steps WHERE run_id = ? AND step_id = 'test'").get(run.id) as { step_index: number; status: string; output: string };
    const prRow = db.prepare("SELECT status FROM steps WHERE run_id = ? AND step_id = 'pr'").get(run.id) as { status: string };
    const downstreamActive = db.prepare(
      "SELECT step_id, status FROM steps WHERE run_id = ? AND step_index > ? AND status IN ('pending', 'running') ORDER BY step_index ASC"
    ).all(run.id, testRow.step_index) as Array<{ step_id: string; status: string }>;

    assert.equal(runRow.status, "failed", "run should fail closed instead of advancing to PR on tester retry");
    assert.equal(testRow.status, "failed", "tester step should not be recorded as done");
    assert.match(testRow.output, /STATUS: retry/i);
    assert.equal(prRow.status, "waiting", "PR step must stay unclaimed when tester reports retry");
    assert.deepEqual(downstreamActive, [], "no downstream step should become pending or running after tester retry");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDbPath === undefined) delete process.env.ANTFARM_DB_PATH;
    else process.env.ANTFARM_DB_PATH = originalDbPath;
    process.env.HOME = originalHome;
    const dbMod = await import("../dist/db.js");
    dbMod.closeDbForTests?.();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
