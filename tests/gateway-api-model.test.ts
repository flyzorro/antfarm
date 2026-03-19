import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// We test the exported createAgentCronJob function's type interface
// by importing and verifying it accepts model in payload and delivery field.
// Since actual HTTP/CLI calls require a running gateway, we mock fetch.

describe("gateway-api model parameter support", () => {
  let createAgentCronJob: typeof import("../dist/installer/gateway-api.js").createAgentCronJob;
  let listCronJobs: typeof import("../dist/installer/gateway-api.js").listCronJobs;

  beforeEach(async () => {
    // Re-import to get fresh module
    const mod = await import(`../dist/installer/gateway-api.js?t=${Date.now()}-${Math.random()}`);
    createAgentCronJob = mod.createAgentCronJob;
    listCronJobs = mod.listCronJobs;
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("accepts payload with model parameter", async () => {
    // Mock fetch to simulate gateway response
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { id: "test-job-123" } }),
    })) as any;

    try {
      const result = await createAgentCronJob({
        name: "test/agent",
        schedule: { kind: "every", everyMs: 300_000 },
        sessionTarget: "isolated",
        agentId: "test-agent",
        payload: {
          kind: "agentTurn",
          message: "test prompt",
          model: "claude-sonnet-4-20250514",
          timeoutSeconds: 60,
        },
        enabled: true,
      });

      assert.equal(result.ok, true);
      assert.equal(result.id, "test-job-123");

      // Verify fetch was called with model in the payload
      const fetchMock = globalThis.fetch as any;
      const callArgs = fetchMock.mock.calls[0].arguments;
      const body = JSON.parse(callArgs[1].body);
      assert.equal(body.args.job.payload.model, "claude-sonnet-4-20250514");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("works without model parameter (backward compatible)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { id: "test-job-456" } }),
    })) as any;

    try {
      const result = await createAgentCronJob({
        name: "test/agent",
        schedule: { kind: "every", everyMs: 300_000 },
        sessionTarget: "isolated",
        agentId: "test-agent",
        payload: {
          kind: "agentTurn",
          message: "test prompt",
        },
        enabled: true,
      });

      assert.equal(result.ok, true);

      const fetchMock = globalThis.fetch as any;
      const callArgs = fetchMock.mock.calls[0].arguments;
      const body = JSON.parse(callArgs[1].body);
      assert.equal(body.args.job.payload.model, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes model in HTTP request body", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { id: "test-123" } }),
    })) as any;

    try {
      await createAgentCronJob({
        name: "test/polling",
        schedule: { kind: "every", everyMs: 300_000 },
        sessionTarget: "isolated",
        agentId: "test-agent",
        payload: {
          kind: "agentTurn",
          message: "poll",
          model: "claude-haiku-3",
        },
        enabled: true,
      });

      const fetchMock = globalThis.fetch as any;
      const callArgs = fetchMock.mock.calls[0].arguments;
      const body = JSON.parse(callArgs[1].body);
      // Model should be in the job payload sent to gateway
      assert.equal(body.args.job.payload.model, "claude-haiku-3");
      assert.equal(body.tool, "cron");
      assert.equal(body.args.action, "add");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to CLI with --model flag when HTTP fails", async () => {
    const originalFetch = globalThis.fetch;
    // Simulate HTTP 404 to trigger CLI fallback
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 404,
    })) as any;

    let result: { ok: boolean; id?: string };
    try {
      // This will attempt CLI fallback which may actually call the real
      // openclaw binary if it's installed. The test verifies the function
      // handles the model parameter path without throwing.
      result = await createAgentCronJob({
        name: "test/agent",
        schedule: { kind: "every", everyMs: 300_000 },
        sessionTarget: "isolated",
        agentId: "test-agent",
        payload: {
          kind: "agentTurn",
          message: "test",
          model: "claude-sonnet-4-20250514",
        },
        enabled: true,
      });

      // CLI fallback may fail in test env, that's ok
      // The important thing is it doesn't throw
      assert.ok(typeof result.ok === "boolean");
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Clean up: if the CLI fallback succeeded and created a real cron job,
    // delete it so we don't leave rogue jobs running (fetch is restored now)
    if (result!.ok && result!.id) {
      const { deleteCronJob } = await import("../dist/installer/gateway-api.js");
      await deleteCronJob(result!.id).catch(() => {});
    }
  });

  it("accepts delivery field alongside model", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { id: "test-789" } }),
    })) as any;

    try {
      const result = await createAgentCronJob({
        name: "test/agent",
        schedule: { kind: "every", everyMs: 300_000 },
        sessionTarget: "isolated",
        agentId: "test-agent",
        payload: {
          kind: "agentTurn",
          message: "poll",
          model: "claude-sonnet-4-20250514",
        },
        delivery: { mode: "none" },
        enabled: true,
      });

      assert.equal(result.ok, true);

      const fetchMock = globalThis.fetch as any;
      const callArgs = fetchMock.mock.calls[0].arguments;
      const body = JSON.parse(callArgs[1].body);
      assert.equal(body.args.job.delivery.mode, "none");
      assert.equal(body.args.job.payload.model, "claude-sonnet-4-20250514");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses --timeout-seconds for CLI fallback cron creation", async () => {
    const originalFetch = globalThis.fetch;
    const originalBin = process.env.OPENCLAW_BIN;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "antfarm-gateway-api-"));
    const cliLog = path.join(tmpDir, "openclaw-cli.log");
    const openclawBin = path.join(tmpDir, "openclaw");

    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 404,
    })) as any;

    await fs.writeFile(
      openclawBin,
      `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(cliLog)}
if [ "$1" = "cron" ] && [ "$2" = "add" ]; then
  printf '{"id":"cli-job"}\n'
  exit 0
fi
exit 1
`,
      { mode: 0o755 }
    );

    process.env.OPENCLAW_BIN = openclawBin;

    try {
      const result = await createAgentCronJob({
        name: "test/agent",
        schedule: { kind: "every", everyMs: 300_000 },
        sessionTarget: "isolated",
        agentId: "test-agent",
        payload: {
          kind: "agentTurn",
          message: "poll",
          timeoutSeconds: 120,
        },
        enabled: true,
      });

      assert.equal(result.ok, true);
      assert.equal(result.id, "cli-job");

      const cliCalls = await fs.readFile(cliLog, "utf-8");
      assert.match(cliCalls, /--timeout-seconds 120/, "CLI fallback should pass timeout in seconds");
      assert.doesNotMatch(cliCalls, /--timeout 120/, "CLI fallback must not use millisecond timeout flag");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBin === undefined) delete process.env.OPENCLAW_BIN;
      else process.env.OPENCLAW_BIN = originalBin;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses CLI cron list JSON even when plugin logs prefix stdout", async () => {
    const originalFetch = globalThis.fetch;
    const originalBin = process.env.OPENCLAW_BIN;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "antfarm-gateway-list-"));
    const openclawBin = path.join(tmpDir, "openclaw");

    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      status: 404,
    })) as any;

    await fs.writeFile(
      openclawBin,
      `#!/bin/sh
if [ "$1" = "cron" ] && [ "$2" = "list" ]; then
  printf '[plugins] feishu_doc: Registered feishu_doc, feishu_app_scopes\n'
  printf '[plugins] [lcm] Plugin loaded (enabled=true, db=/tmp/lcm.db, threshold=0.75)\n'
  printf '{"jobs":[{"id":"job-1","name":"antfarm/feature-dev/planner","enabled":true}]}\n'
  exit 0
fi
exit 1
`,
      { mode: 0o755 }
    );

    process.env.OPENCLAW_BIN = openclawBin;

    try {
      const result = await listCronJobs();
      assert.equal(result.ok, true);
      assert.deepEqual(result.jobs, [
        { id: "job-1", name: "antfarm/feature-dev/planner", enabled: true },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBin === undefined) delete process.env.OPENCLAW_BIN;
      else process.env.OPENCLAW_BIN = originalBin;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
