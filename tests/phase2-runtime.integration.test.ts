import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { asApprovalCode, asEvidenceRevisionId, asInstanceCode, InMemorySecretStore, type FeishuInstance } from "@agent-voucher/online-acquisition";
import type { ActorSnapshot } from "@agent-voucher/shared-kernel";
import { DbClient } from "../src/infrastructure/db/client.js";
import { prepareDataDir } from "../src/runtime/data-dir.js";
import { Phase2Runtime } from "../src/runtime/phase2.js";

const admin: ActorSnapshot = { userId: "admin", username: "admin", roles: ["ADMIN"] };

describe("Phase2Runtime recovery", () => {
  it("marks restored Feishu connections REAUTH_REQUIRED when the credential store no longer has the secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-voucher-phase2-runtime-")); const paths = await prepareDataDir(root); const db = new DbClient(paths.appDb); await db.start();
    try {
      const secrets = new InMemorySecretStore(); const first = new Phase2Runtime(db, root, secrets); await first.start();
      const configured = await first.acquisition(admin).service.configureFeishu({
        connectorId: "feishu-default", displayName: "飞书审批", appId: "cli_test", appSecret: "secret",
        approvalCodes: ["APPROVAL_1"], attachmentControlIds: {}, initialLookbackFrom: "2026-08-01T00:00:00.000+08:00",
        dailySyncTime: "02:00", timeZone: "Asia/Shanghai", overlapHours: 48,
      });
      await expect(first.acquisition(admin).store.startBatch(
        configured.connectorId, configured.revision + 1, "MANUAL", "1", "2",
      )).rejects.toMatchObject({ name: "ConflictError" });
      first.stop(); await secrets.delete(configured.secretReference);
      const restored = new Phase2Runtime(db, root, secrets); await restored.start();
      expect(await restored.acquisition(admin).store.get(configured.connectorId)).toMatchObject({ status: "REAUTH_REQUIRED" }); restored.stop();
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("retains archived and failed page counts when a running Feishu batch resumes after a crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-voucher-phase2-resume-")); const paths = await prepareDataDir(root); const db = new DbClient(paths.appDb); await db.start();
    try {
      const secrets = new InMemorySecretStore(); const first = new Phase2Runtime(db, root, secrets); await first.start();
      const configured = await first.acquisition(admin).service.configureFeishu({
        connectorId: "feishu-default", displayName: "飞书审批", appId: "cli_test", appSecret: "secret",
        approvalCodes: ["APPROVAL_1"], attachmentControlIds: {}, initialLookbackFrom: "2026-08-01T00:00:00.000+08:00",
        dailySyncTime: "02:00", timeZone: "Asia/Shanghai", overlapHours: 48,
      });
      const firstStore = first.acquisition(admin).store;
      const batchId = await firstStore.startBatch(configured.connectorId, configured.revision, "MANUAL", "1", "2");
      const instance = (code: string): FeishuInstance => ({
        instanceCode: asInstanceCode(code), approvalCode: asApprovalCode("APPROVAL_1"), status: "APPROVED", startTime: "1",
        form: "[]", taskList: [], commentList: [], timeline: [], reverted: false,
      });
      await firstStore.recordDiscovered(batchId, configured.connectorId, configured.revision, instance("approved-1"), "hash-1");
      await firstStore.recordArchived({
        connectorId: configured.connectorId, instanceCode: asInstanceCode("approved-1"), configRevision: configured.revision,
        formEvidenceRevisionId: asEvidenceRevisionId("form-1"), attachmentEvidenceRevisionIds: [],
        remoteRevisionHash: "hash-1", status: "ARCHIVED", failures: [], attachmentOutcomes: [],
      });
      await firstStore.recordDiscovered(batchId, configured.connectorId, configured.revision, instance("partial-1"), "hash-2");
      await firstStore.recordArchived({
        connectorId: configured.connectorId, instanceCode: asInstanceCode("partial-1"), configRevision: configured.revision,
        formEvidenceRevisionId: asEvidenceRevisionId("form-2"), attachmentEvidenceRevisionIds: [],
        remoteRevisionHash: "hash-2", status: "PARTIAL", failures: [{ category: "PERMANENT", code: "ATTACHMENT_REJECTED", retryable: false }], attachmentOutcomes: [],
      });
      await firstStore.savePageCheckpoint(configured.connectorId, batchId, "APPROVAL_1", "next-page");
      expect(await firstStore.batchCounts(batchId)).toEqual({ archived: 1, failed: 1 });
      await expect(first.acquisition(admin).service.configureFeishu({
        connectorId: "feishu-default", displayName: "并发修改", appId: "cli_test", appSecret: "replacement",
        approvalCodes: ["APPROVAL_1"], attachmentControlIds: {}, initialLookbackFrom: "2026-08-01T00:00:00.000+08:00",
        dailySyncTime: "02:00", timeZone: "Asia/Shanghai", overlapHours: 48, expectedRevision: configured.revision,
      })).rejects.toMatchObject({ name: "ConflictError", message: "FEISHU_SYNC_IN_PROGRESS" });
      expect(await secrets.read(configured.secretReference)).toBe("secret");
      expect(await firstStore.get(configured.connectorId)).toMatchObject({ revision: configured.revision, secretReference: configured.secretReference });
      first.stop();

      const resumed = new Phase2Runtime(db, root, secrets); await resumed.start(); const resumedStore = resumed.acquisition(admin).store;
      expect(await resumedStore.findRunningBatch(configured.connectorId)).toMatchObject({ id: batchId });
      const counts = await resumedStore.batchCounts(batchId); expect(counts).toEqual({ archived: 1, failed: 1 });
      await resumedStore.completeBatch(batchId, counts.failed === 0 ? "SUCCEEDED" : "PARTIAL", counts);
      expect((await resumedStore.listSyncBatches()).find((row) => row.id === batchId)).toMatchObject({ status: "PARTIAL", archived_count: 1, failed_count: 1 });
      resumed.stop();
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("cancels a running sync batch when the connector is disabled and then permits reconfiguration", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-voucher-phase2-disable-")); const paths = await prepareDataDir(root); const db = new DbClient(paths.appDb); await db.start();
    try {
      const secrets = new InMemorySecretStore(); const runtime = new Phase2Runtime(db, root, secrets); await runtime.start();
      const acquisition = runtime.acquisition(admin);
      const configured = await acquisition.service.configureFeishu({
        connectorId: "feishu-default", displayName: "飞书审批", appId: "cli_test", appSecret: "secret",
        approvalCodes: ["APPROVAL_1"], attachmentControlIds: {}, initialLookbackFrom: "2026-08-01T00:00:00.000+08:00",
        dailySyncTime: "02:00", timeZone: "Asia/Shanghai", overlapHours: 48,
      });
      const batchId = await acquisition.store.startBatch(configured.connectorId, configured.revision, "MANUAL", "1", "2");
      await acquisition.service.disable(configured.connectorId);
      expect(await acquisition.store.findRunningBatch(configured.connectorId)).toBeUndefined();
      expect((await acquisition.store.listSyncBatches()).find((batch) => batch.id === batchId)).toMatchObject({
        status: "CANCELED", last_error_code: "CONNECTOR_DISABLED",
      });
      const disabled = await acquisition.store.get(configured.connectorId);
      expect(disabled).toMatchObject({ status: "DISABLED", revision: 2 });
      const reconfigured = await acquisition.service.configureFeishu({
        connectorId: "feishu-default", displayName: "重新启用", appId: "cli_test", appSecret: "replacement",
        approvalCodes: ["APPROVAL_1"], attachmentControlIds: {}, initialLookbackFrom: "2026-08-01T00:00:00.000+08:00",
        dailySyncTime: "02:00", timeZone: "Asia/Shanghai", overlapHours: 48, expectedRevision: 2,
      });
      expect(reconfigured).toMatchObject({ status: "ACTIVE", revision: 3 });
      await expect(runtime.syncFeishu(
        admin, reconfigured.connectorId, "MANUAL", undefined, true, Date.now(), undefined, configured.revision,
      )).rejects.toMatchObject({ name: "ConflictError", message: "FEISHU_CONFIG_CHANGED_DURING_SYNC" });
      runtime.stop();
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("cancels the active sync batch when a running Feishu job is explicitly canceled", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-voucher-phase2-job-cancel-")); const paths = await prepareDataDir(root); const db = new DbClient(paths.appDb); await db.start();
    try {
      const secrets = new InMemorySecretStore(); const runtime = new Phase2Runtime(db, root, secrets); await runtime.start();
      const configured = await runtime.acquisition(admin).service.configureFeishu({
        connectorId: "feishu-default", displayName: "飞书审批", appId: "cli_test", appSecret: "secret",
        approvalCodes: ["APPROVAL_1"], attachmentControlIds: {}, initialLookbackFrom: "2026-08-01T00:00:00.000+08:00",
        dailySyncTime: "02:00", timeZone: "Asia/Shanghai", overlapHours: 48,
      });
      let markQueryStarted!: () => void;
      const queryStarted = new Promise<void>((resolve) => { markQueryStarted = resolve; });
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname.endsWith("/tenant_access_token/internal")) {
          return Promise.resolve(new Response(JSON.stringify({ code: 0, msg: "success", tenant_access_token: "test-token", expire: 7200 }), { status: 200, headers: { "content-type": "application/json" } }));
        }
        if (url.pathname.endsWith("/instances/query")) {
          markQueryStarted();
          return new Promise<Response>((_resolve, reject) => {
            if (!init?.signal) { reject(new Error("Expected abort signal")); return; }
            init.signal.addEventListener("abort", () => {
              reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error("Request aborted"));
            }, { once: true });
          });
        }
        return Promise.reject(new Error(`Unexpected Feishu URL: ${url.pathname}`));
      });
      const controller = new AbortController();
      const syncing = runtime.syncFeishu(admin, configured.connectorId, "MANUAL", controller.signal);
      await queryStarted;
      controller.abort(new Error("JOB_CANCEL_REQUESTED"));
      await expect(syncing).rejects.toThrow("JOB_CANCEL_REQUESTED");
      expect(await runtime.acquisition(admin).store.findRunningBatch(configured.connectorId)).toBeUndefined();
      expect((await runtime.acquisition(admin).store.listSyncBatches())[0]).toMatchObject({
        status: "CANCELED", last_error_code: "JOB_CANCEL_REQUESTED", page_token: null,
      });
      expect((await runtime.acquisition(admin).store.getSyncState(configured.connectorId))?.inFlightPageToken).toBeUndefined();
      runtime.stop();
    } finally { vi.unstubAllGlobals(); await db.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("clears an expired Feishu page token and restarts the overlap window only once", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-voucher-phase2-cursor-")); const paths = await prepareDataDir(root); const db = new DbClient(paths.appDb); await db.start();
    try {
      const secrets = new InMemorySecretStore(); const runtime = new Phase2Runtime(db, root, secrets); await runtime.start();
      const configured = await runtime.acquisition(admin).service.configureFeishu({
        connectorId: "feishu-default", displayName: "飞书审批", appId: "cli_test", appSecret: "secret",
        approvalCodes: ["APPROVAL_1"], attachmentControlIds: {}, initialLookbackFrom: "2026-08-01T00:00:00.000+08:00",
        dailySyncTime: "02:00", timeZone: "Asia/Shanghai", overlapHours: 48,
      });
      const store = runtime.acquisition(admin).store;
      const batchId = await store.startBatch(configured.connectorId, configured.revision, "MANUAL", "1785542400000", "1785628800000");
      await store.savePageCheckpoint(configured.connectorId, batchId, "APPROVAL_1", "expired-page-token");
      const observedTokens: Array<string | null> = [];
      vi.stubGlobal("fetch", (input: string | URL | Request): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname.endsWith("/tenant_access_token/internal")) {
          return Promise.resolve(new Response(JSON.stringify({ code: 0, msg: "success", tenant_access_token: "test-token", expire: 7200 }), { status: 200, headers: { "content-type": "application/json" } }));
        }
        if (url.pathname.endsWith("/instances/query")) {
          const token = url.searchParams.get("page_token"); observedTokens.push(token);
          if (token === "expired-page-token") return Promise.resolve(new Response(null, { status: 400 }));
          return Promise.resolve(new Response(JSON.stringify({ code: 0, msg: "success", data: { instance_code_list: [], has_more: false } }), { status: 200, headers: { "content-type": "application/json" } }));
        }
        return Promise.reject(new Error(`Unexpected Feishu URL: ${url.pathname}`));
      });
      await expect(runtime.syncFeishu(admin, configured.connectorId, "MANUAL", undefined, true, 1_785_628_800_000)).resolves.toMatchObject({ batchId, status: "SUCCEEDED" });
      expect(observedTokens).toEqual(["expired-page-token", null]);
      expect((await store.getSyncState(configured.connectorId))?.inFlightPageToken).toBeUndefined();
      runtime.stop();
    } finally { vi.unstubAllGlobals(); await db.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("rescans long-running approvals in bounded windows and reprocesses them after attachment mapping changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-voucher-phase2-long-approval-")); const paths = await prepareDataDir(root); const db = new DbClient(paths.appDb); await db.start();
    try {
      const secrets = new InMemorySecretStore(); const runtime = new Phase2Runtime(db, root, secrets); await runtime.start();
      const initialLookbackFrom = "2026-07-01T00:00:00.000+08:00";
      const approvalStartMs = Date.parse(initialLookbackFrom);
      const cycleEndMs = Date.parse("2026-08-20T23:59:59.000+08:00");
      const configured = await runtime.acquisition(admin).service.configureFeishu({
        connectorId: "feishu-default", displayName: "飞书审批", appId: "cli_test", appSecret: "secret",
        approvalCodes: ["APPROVAL_1"], attachmentControlIds: { APPROVAL_1: ["contract"] }, initialLookbackFrom,
        dailySyncTime: "02:00", timeZone: "Asia/Shanghai", overlapHours: 48,
      });
      const store = runtime.acquisition(admin).store;
      const queryWindows: Array<{ start: number; end: number }> = [];
      let attachmentAttempts = 0; let failNextAttachment = false;
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname.endsWith("/tenant_access_token/internal")) {
          return Promise.resolve(new Response(JSON.stringify({ code: 0, msg: "success", tenant_access_token: "test-token", expire: 7200 }), { status: 200, headers: { "content-type": "application/json" } }));
        }
        if (url.pathname.endsWith("/instances/query")) {
          if (typeof init?.body !== "string") return Promise.reject(new Error("Expected JSON request body"));
          const body = JSON.parse(init.body) as { instance_start_time_from: string; instance_start_time_to: string };
          const window = { start: Number(body.instance_start_time_from), end: Number(body.instance_start_time_to) };
          queryWindows.push(window);
          const includesApproval = window.start <= approvalStartMs && approvalStartMs <= window.end;
          return Promise.resolve(new Response(JSON.stringify({
            code: 0, msg: "success", data: { instance_code_list: includesApproval ? ["long-running"] : [], has_more: false },
          }), { status: 200, headers: { "content-type": "application/json" } }));
        }
        if (url.pathname.endsWith("/instances/long-running")) {
          return Promise.resolve(new Response(JSON.stringify({
            code: 0, msg: "success", data: {
              instance_code: "long-running", approval_code: "APPROVAL_1", status: "APPROVED",
              start_time: String(approvalStartMs), end_time: String(Date.parse("2026-08-20T12:00:00.000+08:00")),
              form: JSON.stringify([{ id: "contract", value: ["/open-apis/approval/v4/files/file-code"] }]),
              task_list: [], comment_list: [], timeline: [], reverted: false,
            },
          }), { status: 200, headers: { "content-type": "application/json" } }));
        }
        if (url.pathname.endsWith("/files/file-code")) {
          attachmentAttempts += 1;
          if (attachmentAttempts === 1 || failNextAttachment) {
            failNextAttachment = false; return Promise.resolve(new Response("missing", { status: 404 }));
          }
          return Promise.resolve(new Response("%PDF-1.4\n%%EOF\n", { status: 200, headers: { "content-type": "application/pdf" } }));
        }
        return Promise.reject(new Error(`Unexpected Feishu URL: ${url.pathname}`));
      });

      await expect(runtime.syncFeishu(admin, configured.connectorId, "MANUAL", undefined, true, cycleEndMs)).resolves.toMatchObject({ status: "PARTIAL", failed: 1 });
      const firstCycleLength = queryWindows.length;
      await expect(runtime.syncFeishu(admin, configured.connectorId, "MANUAL", undefined, true, cycleEndMs)).resolves.toMatchObject({ status: "SUCCEEDED", archived: 0 });
      expect(attachmentAttempts).toBe(1);
      const firstCycle = queryWindows.slice(0, firstCycleLength);
      const secondCycle = queryWindows.slice(firstCycleLength);
      for (const cycle of [firstCycle, secondCycle]) {
        expect(cycle[0]?.start).toBe(approvalStartMs);
        expect(cycle.at(-1)?.end).toBe(cycleEndMs);
        expect(cycle.every((window) => window.end - window.start <= 29 * 24 * 60 * 60_000)).toBe(true);
        for (let index = 1; index < cycle.length; index += 1) expect(cycle[index]?.start).toBe(cycle[index - 1]?.end);
      }
      expect((await runtime.evidence.list()).filter((item) => item.kind === "APPROVAL")).toHaveLength(1);

      const revised = await runtime.acquisition(admin).service.configureFeishu({
        connectorId: "feishu-default", displayName: "飞书审批", appId: "cli_test", appSecret: "secret",
        approvalCodes: ["APPROVAL_1"], attachmentControlIds: { APPROVAL_1: ["contract"] }, initialLookbackFrom,
        dailySyncTime: "02:00", timeZone: "Asia/Shanghai", overlapHours: 48, expectedRevision: configured.revision,
      });
      const mapped = await runtime.syncFeishu(admin, revised.connectorId, "MANUAL", undefined, true, cycleEndMs);
      expect(mapped).toMatchObject({ status: "SUCCEEDED", archived: 1 });
      expect(attachmentAttempts).toBe(2);
      const mappedBatchIds = Array.isArray(mapped.batchIds) ? mapped.batchIds.map(String) : [];
      expect(await store.listBatchAttachments(mappedBatchIds[0]!)).toEqual([
        expect.objectContaining({ status: "ARCHIVED", last_error_code: null }),
      ]);

      failNextAttachment = true;
      const thirdRevision = await runtime.acquisition(admin).service.configureFeishu({
        connectorId: "feishu-default", displayName: "飞书审批", appId: "cli_test", appSecret: "secret",
        approvalCodes: ["APPROVAL_1"], attachmentControlIds: { APPROVAL_1: ["contract"] }, initialLookbackFrom,
        dailySyncTime: "02:00", timeZone: "Asia/Shanghai", overlapHours: 48, expectedRevision: revised.revision,
      });
      const regressedAttempt = await runtime.syncFeishu(admin, thirdRevision.connectorId, "MANUAL", undefined, true, cycleEndMs);
      expect(regressedAttempt).toMatchObject({ status: "PARTIAL", failed: 1 });
      const regressedBatchIds = Array.isArray(regressedAttempt.batchIds) ? regressedAttempt.batchIds.map(String) : [];
      expect(await store.listBatchAttachments(regressedBatchIds[0]!)).toEqual([
        expect.objectContaining({ status: "ARCHIVED", last_error_code: null }),
      ]);
      expect(await store.listBatchItems(regressedBatchIds[0]!)).toEqual([
        expect.objectContaining({ source_status: "ARCHIVED", last_error_code: null }),
      ]);
      runtime.stop();
    } finally { vi.unstubAllGlobals(); await db.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("resumes a failed middle start-time window and finishes the remaining windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-voucher-phase2-window-resume-")); const paths = await prepareDataDir(root); const db = new DbClient(paths.appDb); await db.start();
    try {
      const secrets = new InMemorySecretStore(); const runtime = new Phase2Runtime(db, root, secrets); await runtime.start();
      const initialMs = Date.parse("2026-07-01T00:00:00.000+08:00");
      const secondWindowMs = initialMs + 29 * 24 * 60 * 60_000;
      const thirdWindowMs = secondWindowMs + 29 * 24 * 60 * 60_000;
      const cycleEndMs = initialMs + 65 * 24 * 60 * 60_000;
      const configured = await runtime.acquisition(admin).service.configureFeishu({
        connectorId: "feishu-default", displayName: "飞书审批", appId: "cli_test", appSecret: "secret",
        approvalCodes: ["APPROVAL_1"], attachmentControlIds: {}, initialLookbackFrom: new Date(initialMs).toISOString(),
        dailySyncTime: "02:00", timeZone: "Asia/Shanghai", overlapHours: 48,
      });
      const observedStarts: number[] = []; let middleFailed = false;
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname.endsWith("/tenant_access_token/internal")) {
          return Promise.resolve(new Response(JSON.stringify({ code: 0, msg: "success", tenant_access_token: "test-token", expire: 7200 }), { status: 200, headers: { "content-type": "application/json" } }));
        }
        if (url.pathname.endsWith("/instances/query")) {
          if (typeof init?.body !== "string") return Promise.reject(new Error("Expected JSON request body"));
          const body = JSON.parse(init.body) as { instance_start_time_from: string };
          const start = Number(body.instance_start_time_from); observedStarts.push(start);
          if (start === secondWindowMs && !middleFailed) {
            middleFailed = true; return Promise.resolve(new Response("temporary", { status: 503 }));
          }
          return Promise.resolve(new Response(JSON.stringify({ code: 0, msg: "success", data: { instance_code_list: [], has_more: false } }), { status: 200, headers: { "content-type": "application/json" } }));
        }
        return Promise.reject(new Error(`Unexpected Feishu URL: ${url.pathname}`));
      });

      await expect(runtime.syncFeishu(admin, configured.connectorId, "SCHEDULED", undefined, true, cycleEndMs)).rejects.toThrow(/Feishu HTTP request failed/);
      const interrupted = await runtime.acquisition(admin).store.getSyncState(configured.connectorId);
      expect(interrupted?.highWatermarkMs).toBe(String(secondWindowMs));
      expect(interrupted?.lastScheduledLocalDate).toBeUndefined();
      await expect(runtime.syncFeishu(admin, configured.connectorId, "SCHEDULED", undefined, true, cycleEndMs)).resolves.toMatchObject({ status: "SUCCEEDED" });
      expect(observedStarts).toEqual([initialMs, secondWindowMs, secondWindowMs, thirdWindowMs]);
      const completed = await runtime.acquisition(admin).store.getSyncState(configured.connectorId);
      expect(completed?.highWatermarkMs).toBe(String(cycleEndMs));
      expect(completed?.lastScheduledLocalDate).toBe("2026-09-04");
      runtime.stop();
    } finally { vi.unstubAllGlobals(); await db.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("walks every approval code and page token inside the same start-time window", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-voucher-phase2-multi-code-")); const paths = await prepareDataDir(root); const db = new DbClient(paths.appDb); await db.start();
    try {
      const secrets = new InMemorySecretStore(); const runtime = new Phase2Runtime(db, root, secrets); await runtime.start();
      const cycleEndMs = Date.parse("2026-08-20T23:59:59.000+08:00");
      const configured = await runtime.acquisition(admin).service.configureFeishu({
        connectorId: "feishu-default", displayName: "飞书审批", appId: "cli_test", appSecret: "secret",
        approvalCodes: ["APPROVAL_1", "APPROVAL_2"], attachmentControlIds: {},
        initialLookbackFrom: "2026-08-20T00:00:00.000+08:00",
        dailySyncTime: "02:00", timeZone: "Asia/Shanghai", overlapHours: 48,
      });
      const calls: Array<{ approvalCode: string; pageToken: string | null }> = [];
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname.endsWith("/tenant_access_token/internal")) {
          return Promise.resolve(new Response(JSON.stringify({ code: 0, msg: "success", tenant_access_token: "test-token", expire: 7200 }), { status: 200, headers: { "content-type": "application/json" } }));
        }
        if (url.pathname.endsWith("/instances/query")) {
          if (typeof init?.body !== "string") return Promise.reject(new Error("Expected JSON request body"));
          const body = JSON.parse(init.body) as { approval_code: string };
          const pageToken = url.searchParams.get("page_token"); calls.push({ approvalCode: body.approval_code, pageToken });
          const firstPage = body.approval_code === "APPROVAL_1" && pageToken === null;
          return Promise.resolve(new Response(JSON.stringify({
            code: 0, msg: "success", data: {
              instance_code_list: [], has_more: firstPage, ...(firstPage ? { page_token: "page-2" } : {}),
            },
          }), { status: 200, headers: { "content-type": "application/json" } }));
        }
        return Promise.reject(new Error(`Unexpected Feishu URL: ${url.pathname}`));
      });

      await expect(runtime.syncFeishu(admin, configured.connectorId, "MANUAL", undefined, true, cycleEndMs)).resolves.toMatchObject({ status: "SUCCEEDED" });
      expect(calls).toEqual([
        { approvalCode: "APPROVAL_1", pageToken: null },
        { approvalCode: "APPROVAL_1", pageToken: "page-2" },
        { approvalCode: "APPROVAL_2", pageToken: null },
      ]);
      runtime.stop();
    } finally { vi.unstubAllGlobals(); await db.close(); await rm(root, { recursive: true, force: true }); }
  });
});
