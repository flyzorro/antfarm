import { beforeEach, afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;

async function freshImport<T>(specifier: string): Promise<T> {
  return import(`${specifier}?t=${Date.now()}-${Math.random()}`) as Promise<T>;
}

describe("realtime dispatcher", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-rt-home-"));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.HOME = originalHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("spawns the matching agent session as soon as a step becomes pending", async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { sessionId: "sess-1" } }),
    })) as any;
    globalThis.fetch = fetchMock;

    const { getDb } = await freshImport<typeof import("../dist/db.js")>("../dist/db.js");
    const { dispatchPendingStepNow } = await freshImport<typeof import("../dist/installer/realtime-dispatcher.js")>("../dist/installer/realtime-dispatcher.js");

    const db = getDb();
    const runId = randomUUID();
    const stepRowId = randomUUID();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'feature-dev', 'ship it', 'running', '{}', ?, ?)").run(runId, now, now);
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'plan', 'feature-dev_planner', 0, 'Do planning', 'STATUS', 'pending', ?, ?)").run(stepRowId, runId, now, now);

    const result = await dispatchPendingStepNow({ runId, stepId: "plan" });
    assert.equal(result.ok, true);
    assert.equal(fetchMock.mock.calls.length, 1);

    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.equal(body.tool, "sessions_spawn");
    assert.equal(body.args.agentId, "feature-dev_planner");
    assert.match(body.args.task, /step claim "feature-dev_planner"/);
  });

  it("skips cleanly when the step was already claimed by a duplicate dispatch", async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new Error("should not be called");
    }) as any;

    const { getDb } = await freshImport<typeof import("../dist/db.js")>("../dist/db.js");
    const { dispatchPendingStepNow } = await freshImport<typeof import("../dist/installer/realtime-dispatcher.js")>("../dist/installer/realtime-dispatcher.js");

    const db = getDb();
    const runId = randomUUID();
    const stepRowId = randomUUID();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'feature-dev', 'ship it', 'running', '{}', ?, ?)").run(runId, now, now);
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'plan', 'feature-dev_planner', 0, 'Do planning', 'STATUS', 'running', ?, ?)").run(stepRowId, runId, now, now);

    const result = await dispatchPendingStepNow({ runId, stepId: "plan" });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
  });
});
