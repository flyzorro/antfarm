import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const fakeWorkflow = {
  id: "feature-dev",
  name: "Feature Dev",
  version: 1,
  polling: { model: "default", timeoutSeconds: 120 },
  agents: [
    { id: "planner", name: "Planner", workspace: { baseDir: "agents/planner", files: {} } },
    { id: "developer", name: "Developer", workspace: { baseDir: "agents/developer", files: {} } },
  ],
  steps: [
    { id: "plan", agent: "planner", input: "plan", expects: "STATUS" },
    { id: "implement", agent: "developer", input: "build", expects: "STATUS" },
  ],
};

describe("cron setup stays bounded", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("setupAgentCrons is idempotent and prunes duplicate jobs by name", async () => {
    const jobs = [
      { id: "job-1", name: "antfarm/feature-dev/planner" },
      { id: "job-2", name: "antfarm/feature-dev/planner" },
      { id: "job-3", name: "antfarm/feature-dev/developer" },
    ];
    const added: string[] = [];
    const removed: string[] = [];

    globalThis.fetch = mock.fn(async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.tool !== "cron") throw new Error(`Unexpected tool ${body.tool}`);

      if (body.args?.action === "list") {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { jobs } }) } as any;
      }

      if (body.args?.action === "remove") {
        const id = body.args.id;
        removed.push(id);
        const idx = jobs.findIndex((job) => job.id === id);
        if (idx !== -1) jobs.splice(idx, 1);
        return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) } as any;
      }

      if (body.args?.action === "add") {
        const name = body.args.job.name;
        added.push(name);
        jobs.push({ id: `job-${jobs.length + 1}`, name });
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: `job-${jobs.length}` } }) } as any;
      }

      throw new Error(`Unexpected action ${body.args?.action}`);
    }) as any;

    const { setupAgentCrons } = await import("../dist/installer/agent-cron.js");
    await setupAgentCrons(fakeWorkflow as any);

    assert.deepEqual(removed, ["job-2"], "should remove only the extra duplicate cron job");
    assert.deepEqual(added, [], "should not create more jobs when one healthy job already exists per agent");
    assert.equal(jobs.filter((job) => job.name === "antfarm/feature-dev/planner").length, 1);
    assert.equal(jobs.filter((job) => job.name === "antfarm/feature-dev/developer").length, 1);
  });

  it("ensureWorkflowCrons fails closed when cron listing is unavailable", async () => {
    const added: string[] = [];

    globalThis.fetch = mock.fn(async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.tool !== "cron") throw new Error(`Unexpected tool ${body.tool}`);

      if (body.args?.action === "list") {
        return { ok: false, status: 500, text: async () => "boom" } as any;
      }

      if (body.args?.action === "add") {
        added.push(body.args.job.name);
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: "job-new" } }) } as any;
      }

      throw new Error(`Unexpected action ${body.args?.action}`);
    }) as any;

    const { ensureWorkflowCrons } = await import("../dist/installer/agent-cron.js");

    await assert.rejects(
      ensureWorkflowCrons(fakeWorkflow as any),
      /Failed to inspect cron jobs:/
    );
    assert.deepEqual(added, [], "must not create new cron jobs when existing cron state cannot be verified");
  });
});
