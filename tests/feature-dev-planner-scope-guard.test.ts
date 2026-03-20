import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const workflowPath = path.resolve(import.meta.dirname, "../workflows/feature-dev/workflow.yml");
const plannerAgentsPath = path.resolve(import.meta.dirname, "../workflows/feature-dev/agents/planner/AGENTS.md");

function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

test("feature-dev planner contract guards single-story clean reruns from scope drift", () => {
  const workflow = read(workflowPath);
  const plannerAgents = read(plannerAgentsPath);

  assert.match(workflow, /If the task explicitly says exactly one story \/ only US-001 \/ backend-only, preserve that scope exactly/);
  assert.match(workflow, /Do NOT invent follow-up stories \(for example US-002\) unless the task explicitly asks for additional scope/);

  assert.match(plannerAgents, /If the task asks for exactly one story, output exactly ONE story in `STORIES_JSON`\./);
  assert.match(plannerAgents, /Do NOT invent follow-up stories such as `US-002` unless the task explicitly asks for additional scope\./);
  assert.match(plannerAgents, /If the task is backend-only, do NOT add frontend, UI, polish, follow-up, or integration stories outside that backend scope\./);
  assert.ok(!/"id": "US-002"/.test(plannerAgents), "planner example should not prime a second story with US-002");
});
