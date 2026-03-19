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
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-claim-home-"));
  process.env.HOME = homeDir;

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
    process.env.HOME = originalHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
