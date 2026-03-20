import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

async function freshImport<T>(specifier: string): Promise<T> {
  return import(`${specifier}?t=${Date.now()}-${Math.random()}`) as Promise<T>;
}

async function withTempDb(fn: (ctx: { homeDir: string; dbPath: string }) => Promise<void>): Promise<void> {
  const originalHome = process.env.HOME;
  const originalDbPath = process.env.ANTFARM_DB_PATH;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-attempt-home-"));
  const dbPath = path.join(homeDir, ".openclaw", "antfarm", `attempt-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.HOME = homeDir;
  process.env.ANTFARM_DB_PATH = dbPath;

  try {
    await fn({ homeDir, dbPath });
  } finally {
    if (originalDbPath === undefined) delete process.env.ANTFARM_DB_PATH;
    else process.env.ANTFARM_DB_PATH = originalDbPath;
    process.env.HOME = originalHome;
    const dbMod = await import("../dist/db.js");
    dbMod.closeDbForTests?.();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

test("stale attempt cannot overwrite a newer claim", async () => {
  await withTempDb(async () => {
    const { getDb } = await freshImport<typeof import("../dist/db.js")>("../dist/db.js");
    const { claimStep, completeStep } = await freshImport<typeof import("../dist/installer/step-ops.js")>("../dist/installer/step-ops.js");

    const db = getDb();
    const runId = randomUUID();
    const stepId = randomUUID();
    const now = new Date().toISOString();

    db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', ?, ?)").run(runId, now, now);
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'implement', 'wf_dev', 0, 'Ship it', 'STATUS: done', 'pending', ?, ?)").run(stepId, runId, now, now);

    const first = claimStep("wf_dev");
    assert.equal(first.found, true);
    assert.ok(first.attemptId);

    db.prepare("UPDATE steps SET status = 'pending', dispatch_state = 'queued', finalization_state = 'idle', attempt_id = NULL, heartbeat_at = NULL, updated_at = datetime('now') WHERE id = ?").run(stepId);

    const second = claimStep("wf_dev");
    assert.equal(second.found, true);
    assert.ok(second.attemptId);
    assert.notEqual(first.attemptId, second.attemptId);

    const stale = completeStep(stepId, "STATUS: done\nCHANGES: stale worker", { attemptId: first.attemptId! });
    assert.deepEqual(stale, { advanced: false, runCompleted: false });

    const afterStale = db.prepare("SELECT status, output, attempt_id FROM steps WHERE id = ?").get(stepId) as { status: string; output: string | null; attempt_id: string | null };
    assert.equal(afterStale.status, "running");
    assert.equal(afterStale.output, null);
    assert.equal(afterStale.attempt_id, second.attemptId);

    const current = completeStep(stepId, "STATUS: done\nCHANGES: current worker", { attemptId: second.attemptId! });
    assert.deepEqual(current, { advanced: false, runCompleted: true });

    const done = db.prepare("SELECT status, output, attempt_id, finalization_state FROM steps WHERE id = ?").get(stepId) as { status: string; output: string; attempt_id: string | null; finalization_state: string };
    assert.equal(done.status, "done");
    assert.match(done.output, /current worker/);
    assert.equal(done.attempt_id, null);
    assert.equal(done.finalization_state, "done");
  });
});

test("duplicate finalize is harmless and idempotent", async () => {
  await withTempDb(async () => {
    const { getDb } = await freshImport<typeof import("../dist/db.js")>("../dist/db.js");
    const { claimStep, completeStep } = await freshImport<typeof import("../dist/installer/step-ops.js")>("../dist/installer/step-ops.js");

    const db = getDb();
    const runId = randomUUID();
    const stepId = randomUUID();
    const now = new Date().toISOString();

    db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', ?, ?)").run(runId, now, now);
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'implement', 'wf_dev', 0, 'Ship it', 'STATUS: done', 'pending', ?, ?)").run(stepId, runId, now, now);

    const claim = claimStep("wf_dev");
    assert.equal(claim.found, true);

    const first = completeStep(stepId, "STATUS: done\nCHANGES: once", { attemptId: claim.attemptId! });
    const second = completeStep(stepId, "STATUS: done\nCHANGES: twice", { attemptId: claim.attemptId! });

    assert.deepEqual(first, { advanced: false, runCompleted: true });
    assert.deepEqual(second, { advanced: false, runCompleted: false });

    const row = db.prepare("SELECT status, output, finalization_state FROM steps WHERE id = ?").get(stepId) as { status: string; output: string; finalization_state: string };
    assert.equal(row.status, "done");
    assert.match(row.output, /once/);
    assert.equal(row.finalization_state, "done");
  });
});

test("cleanup reclaims false running claimed work with no heartbeat", async () => {
  await withTempDb(async () => {
    const { getDb } = await freshImport<typeof import("../dist/db.js")>("../dist/db.js");
    const { cleanupAbandonedSteps } = await freshImport<typeof import("../dist/installer/step-ops.js")>("../dist/installer/step-ops.js");

    const db = getDb();
    const runId = randomUUID();
    const stepId = randomUUID();
    const now = new Date().toISOString();

    db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', ?, ?)").run(runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, dispatch_state, attempt_id, heartbeat_at, created_at, updated_at)
       VALUES (?, ?, 'implement', 'wf_dev', 0, 'Ship it', 'STATUS: done', 'running', 'claimed', 'attempt-stale', datetime('now', '-3 hours'), ?, ?)`
    ).run(stepId, runId, now, now);

    cleanupAbandonedSteps();

    const row = db.prepare("SELECT status, dispatch_state, attempt_id, heartbeat_at, finalization_state FROM steps WHERE id = ?").get(stepId) as {
      status: string;
      dispatch_state: string;
      attempt_id: string | null;
      heartbeat_at: string | null;
      finalization_state: string;
    };
    assert.equal(row.status, 'pending');
    assert.equal(row.dispatch_state, 'queued');
    assert.equal(row.attempt_id, null);
    assert.equal(row.heartbeat_at, null);
    assert.equal(row.finalization_state, 'idle');
  });
});
