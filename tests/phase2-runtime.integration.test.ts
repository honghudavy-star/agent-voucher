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
      const batchId = await firstStore.startBatch(configured.connectorId, "MANUAL", "1", "2");
      const instance = (code: string): FeishuInstance => ({
        instanceCode: asInstanceCode(code), approvalCode: asApprovalCode("APPROVAL_1"), status: "APPROVED", startTime: "1",
        form: "[]", taskList: [], commentList: [], timeline: [], reverted: false,
      });
      await firstStore.recordDiscovered(batchId, configured.connectorId, instance("approved-1"), "hash-1");
      await firstStore.recordArchived({
        instanceCode: asInstanceCode("approved-1"), formEvidenceRevisionId: asEvidenceRevisionId("form-1"), attachmentEvidenceRevisionIds: [],
        remoteRevisionHash: "hash-1", status: "ARCHIVED", failures: [], attachmentOutcomes: [],
      });
      await firstStore.recordDiscovered(batchId, configured.connectorId, instance("partial-1"), "hash-2");
      await firstStore.recordArchived({
        instanceCode: asInstanceCode("partial-1"), formEvidenceRevisionId: asEvidenceRevisionId("form-2"), attachmentEvidenceRevisionIds: [],
        remoteRevisionHash: "hash-2", status: "PARTIAL", failures: [{ category: "PERMANENT", code: "ATTACHMENT_REJECTED", retryable: false }], attachmentOutcomes: [],
      });
      await firstStore.savePageCheckpoint(configured.connectorId, batchId, "APPROVAL_1", "next-page");
      expect(await firstStore.batchCounts(batchId)).toEqual({ archived: 1, failed: 1 });
      first.stop();

      const resumed = new Phase2Runtime(db, root, secrets); await resumed.start(); const resumedStore = resumed.acquisition(admin).store;
      expect(await resumedStore.findRunningBatch(configured.connectorId)).toMatchObject({ id: batchId });
      const counts = await resumedStore.batchCounts(batchId); expect(counts).toEqual({ archived: 1, failed: 1 });
      await resumedStore.completeBatch(batchId, counts.failed === 0 ? "SUCCEEDED" : "PARTIAL", counts);
      expect((await resumedStore.listSyncBatches()).find((row) => row.id === batchId)).toMatchObject({ status: "PARTIAL", archived_count: 1, failed_count: 1 });
      resumed.stop();
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
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
      const batchId = await store.startBatch(configured.connectorId, "MANUAL", "1785542400000", "1785628800000");
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
      await expect(runtime.syncFeishu(admin, configured.connectorId, "MANUAL")).resolves.toMatchObject({ batchId, status: "SUCCEEDED" });
      expect(observedTokens).toEqual(["expired-page-token", null]);
      expect((await store.getSyncState(configured.connectorId))?.inFlightPageToken).toBeUndefined();
      runtime.stop();
    } finally { vi.unstubAllGlobals(); await db.close(); await rm(root, { recursive: true, force: true }); }
  });
});
