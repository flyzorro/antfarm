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

test("feature-dev emits realtime dispatches across the whole 7-step pipeline", async () => {
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-feature-dev-home-"));
  process.env.HOME = homeDir;
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

    const spawnCalls = calls.filter((call) => call.tool === "sessions_spawn");
    assert.equal(spawnCalls.length, 7, "expected one realtime dispatch per feature-dev step");
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
    process.env.HOME = originalHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
