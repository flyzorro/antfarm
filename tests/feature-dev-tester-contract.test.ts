import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const workflowPath = path.resolve(import.meta.dirname, "../workflows/feature-dev/workflow.yml");
const testerAgentsPath = path.resolve(import.meta.dirname, "../workflows/feature-dev/agents/tester/AGENTS.md");

function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

test("feature-dev tester contract requires RESULTS for PR handoff in workflow and agent instructions", () => {
  const workflow = read(workflowPath);
  const testerAgents = read(testerAgentsPath);

  assert.match(workflow, /RESULTS: What you tested and the outcomes/);
  assert.match(workflow, /downstream PR step consumes `\{\{results\}\}`/);
  assert.match(workflow, /Do not replace `RESULTS:` with generic fields like `CHANGES:` or `TESTS:`/);

  assert.match(testerAgents, /downstream PR step reads `RESULTS`/);
  assert.match(testerAgents, /Keep `RESULTS:` as an exact top-level field name/);
  assert.match(testerAgents, /Do not replace it with generic success fields like `CHANGES:` or `TESTS:`/);
});
