import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobRunner, RuntimeAuditService } from "@agent-voucher/runtime-audit";
import type { ActorSnapshot } from "@agent-voucher/shared-kernel";
import { DbClient } from "../src/infrastructure/db/client.js";
import { GraphClient } from "../src/infrastructure/graph/client.js";
import { prepareDataDir } from "../src/runtime/data-dir.js";

const actor: ActorSnapshot = { userId: "operator", username: "operator", roles: ["OPERATOR"] };

describe("typed job handler registry", () => {
  let root: string; let db: DbClient; let graph: GraphClient; let runtime: RuntimeAuditService;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agent-voucher-jobs-")); const paths = await prepareDataDir(root);
    db = new DbClient(paths.appDb); graph = new GraphClient(paths.graphDb); await db.start(); await graph.start(); runtime = new RuntimeAuditService(db, graph);
  });
  afterEach(async () => { await graph.close(); await db.close(); await rm(root, { recursive: true, force: true }); });

  it("rejects secret-bearing or oversized durable payloads while allowing pagination metadata", async () => {
    await expect(runtime.enqueueJob(actor, { type: "SAFE", lane: "NETWORK", payload: { appSecret: "do-not-store" } })).rejects.toThrow(/JOB_SENSITIVE_FIELD/);
    await expect(runtime.enqueueJob(actor, { type: "SAFE", lane: "NETWORK", payload: { pageToken: "provider-cursor" } })).resolves.toBeTruthy();
    await expect(runtime.enqueueJob(actor, { type: "SAFE", lane: "NETWORK", payload: { value: "x".repeat(17 * 1024) } })).rejects.toThrow(/TOO_LARGE/);
  });

  it("runs one network and one parser handler concurrently and records requested-by provenance", async () => {
    const started: string[] = []; const runner = new JobRunner(runtime, () => Promise.resolve({ healthy: true }));
    for (const [type, lane] of [["TEST_NETWORK", "NETWORK"], ["TEST_PARSER", "PARSER"]] as const) runner.registry.register({
      type, lane, leaseMs: 30_000, parsePayload: (value) => value as Record<string, unknown>,
      handle: async (_payload, context) => { started.push(`${type}:${context.requestedBy.userId}`); await new Promise((resolve) => setTimeout(resolve, 100)); return { ok: true }; },
    });
    await runtime.enqueueJob(actor, { type: "TEST_NETWORK", lane: "NETWORK", payload: {} });
    await runtime.enqueueJob(actor, { type: "TEST_PARSER", lane: "PARSER", payload: {} });
    await runner.start();
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const jobs = await runtime.listJobs(); if (jobs.filter((job) => job.status === "SUCCEEDED").length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(started).toEqual(expect.arrayContaining(["TEST_NETWORK:operator", "TEST_PARSER:operator"]));
      expect((await runtime.listJobs()).filter((job) => job.status === "SUCCEEDED")).toHaveLength(2);
    } finally { await runner.stop(); }
  });

  it("does not reclaim a rate-limited job before Retry-After", async () => {
    await runtime.enqueueJob(actor, { type: "RATE_LIMITED", lane: "NETWORK", payload: {} });
    const claimed = await runtime.claimNextJob(actor, "worker-rate", "NETWORK", 60_000); expect(claimed).toBeTruthy();
    await runtime.failJob(actor, claimed!, "FEISHU_RATE_LIMITED", true, 5_000, "worker-rate");
    await expect(runtime.claimNextJob(actor, "worker-next", "NETWORK", 60_000)).resolves.toBeUndefined();
    const jobs = await runtime.listJobs(); expect(jobs[0]?.next_attempt_at).toBeTruthy();
  });

  it("resolves a cancellation racing with completion without leaving the lease RUNNING", async () => {
    const id = await runtime.enqueueJob(actor, { type: "CANCEL_RACE", lane: "NETWORK", payload: {} });
    const claimed = await runtime.claimNextJob(actor, "worker-cancel", "NETWORK", 60_000); expect(claimed).toBeTruthy();
    await runtime.requestCancellation(actor, id);
    await expect(runtime.completeJob(actor, claimed!, { ok: true }, "worker-cancel")).rejects.toThrow();
    await runtime.cancelClaimedJob(actor, claimed!, "worker-cancel");
    expect((await runtime.listJobs()).find((job) => job.id === id)).toMatchObject({ status: "CANCELLED", lease_owner: null });
  });
});
