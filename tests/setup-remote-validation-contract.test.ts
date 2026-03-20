import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const sharedSetupPath = path.resolve(import.meta.dirname, "../agents/shared/setup/AGENTS.md");
const featureDevWorkflowPath = path.resolve(import.meta.dirname, "../workflows/feature-dev/workflow.yml");

function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

test("shared setup agent prefers GitHub metadata for remote validation before raw git transport", () => {
  const setupAgent = read(sharedSetupPath);

  assert.match(setupAgent, /prefer GitHub metadata first/i);
  assert.match(setupAgent, /gh repo view --json nameWithOwner,defaultBranchRef/);
  assert.match(setupAgent, /gh api repos\/\{owner\}\/\{repo\}\/git\/ref\/heads\/\{defaultBranch\}/);
  assert.match(setupAgent, /gh api repos\/\{owner\}\/\{repo\}\/git\/ref\/heads\/\{\{branch\}\}/);
  assert.match(setupAgent, /Fall back to `git fetch origin <defaultBranch> --prune` \/ `git ls-remote` only if GitHub metadata is unavailable/);
  assert.match(setupAgent, /If you cannot materialize the validated remote commit locally, stop and report that setup cannot safely continue/);
});

test("feature-dev setup contract requires validated remote HEAD and remote branch-existence checks", () => {
  const workflow = read(featureDevWorkflowPath);

  assert.match(workflow, /Validate the latest remote default branch and target-branch availability without relying only on raw git HTTPS transport/);
  assert.match(workflow, /gh repo view --json nameWithOwner,defaultBranchRef/);
  assert.match(workflow, /gh api repos\/\{owner\}\/\{repo\}\/git\/ref\/heads\/\{defaultBranch\}/);
  assert.match(workflow, /gh api repos\/\{owner\}\/\{repo\}\/git\/ref\/heads\/\{\{branch\}\}/);
  assert.match(workflow, /if the commit is missing locally, fetch just enough to materialize it/i);
  assert.match(workflow, /if you cannot materialize it locally, stop and report that setup cannot safely continue/i);
});
