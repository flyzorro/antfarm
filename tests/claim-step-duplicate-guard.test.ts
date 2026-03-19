import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

async function freshImport<T>(specifier: string): Promise<T> {
  return import(`${specifier}?t=${Date.now()}-${Math.random()}`) as Promise<T>;
}

test("claimStep only hands out a pending step once even if called twice back-to-back", async () => {
  const originalHome = process.env.HOME;
  const originalDbPath = process.env.ANTFARM_DB_PATH;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-claim-home-"));
  const dbPath = path.join(homeDir, ".openclaw", "antfarm", `claim-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  process.env.HOME = homeDir;
  process.env.ANTFARM_DB_PATH = dbPath;

  try {
    const { getDb } = await freshImport<typeof import("../dist/db.js")>("../dist/db.js");
    const { claimStep } = await freshImport<typeof import("../dist/installer/step-ops.js")>("../dist/installer/step-ops.js");

    const db = getDb();
    const runId = randomUUID();
    const stepRowId = randomUUID();
    const now = new Date().toISOString();

    db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', ?, ?)").run(runId, now, now);
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'implement', 'wf_dev', 0, 'Ship it', 'STATUS', 'pending', ?, ?)").run(stepRowId, runId, now, now);

    const first = claimStep("wf_dev");
    const second = claimStep("wf_dev");

    assert.equal(first.found, true);
    assert.equal(second.found, false);

    const row = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepRowId) as { status: string };
    assert.equal(row.status, "running");
  } finally {
    if (originalDbPath === undefined) delete process.env.ANTFARM_DB_PATH;
    else process.env.ANTFARM_DB_PATH = originalDbPath;
    process.env.HOME = originalHome;
    const dbMod = await import("../dist/db.js");
    dbMod.closeDbForTests?.();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
