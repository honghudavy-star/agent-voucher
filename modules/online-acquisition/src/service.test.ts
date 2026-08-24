import { describe, expect, it } from "vitest";
import { ConflictError } from "@agent-voucher/shared-kernel";
import type { ConnectionConfigStore, ConnectorAdapter, EvidenceIngestPort, SecretStore, SourceArchivePort } from "./contracts.js";
import { ConnectorRequestError, createTestFeishuConfig } from "./feishu-adapter.js";
import { InMemorySecretStore } from "./secret-store.js";
import { OnlineAcquisitionService, extractAttachmentPaths } from "./service.js";
import { asEvidenceRevisionId, asInstanceCode, asSecretReference, type ArchivedSourceItem, type FeishuConnectionConfig, type FeishuInstance, type SecretReference } from "./types.js";

describe("OnlineAcquisitionService", () => {
  it("extracts mapped attachments recursively from field-list rows", () => {
    const form = JSON.stringify([{ id: "table", type: "fieldList", value: [[{
      id: "contract", type: "attachmentV2", value: [{ url: "https://lf16-approval-file-sign.larksuitecdn.com/file" }],
    }]] }]);
    expect(extractAttachmentPaths(form, ["contract"])).toEqual([{
      controlId: "contract", index: 0, remotePath: "https://lf16-approval-file-sign.larksuitecdn.com/file",
    }]);
  });

  it("propagates retryable attachment failures so the job honors Retry-After instead of advancing the cursor", async () => {
    const config = createTestFeishuConfig({ attachmentControlIds: { APPROVAL_1: ["contract"] } });
    const configs: ConnectionConfigStore = {
      save: (value) => Promise.resolve(value), get: () => Promise.resolve(config), markDisabled: () => Promise.resolve(),
    };
    const adapter: ConnectorAdapter = {
      testConnection: () => Promise.resolve({ ok: true, checkedApprovalCode: config.approvalCodes[0]! }),
      discoverApproved: () => Promise.resolve({ items: [], hasMore: false, observedInstanceCodes: [] }),
      reconcileTrackedInstances: () => Promise.resolve([]), disable: () => Promise.resolve(),
      downloadAttachment: () => Promise.reject(new ConnectorRequestError("rate limited", {
        category: "RATE_LIMITED", code: "FEISHU_RATE_LIMITED", retryable: true, retryAfterMs: 5_000,
      })),
    };
    const evidence: EvidenceIngestPort = { ingest: () => Promise.resolve(asEvidenceRevisionId("evidence-revision")) };
    let archived: ArchivedSourceItem | undefined;
    const archive: SourceArchivePort = { recordArchived: (item) => { archived = item; return Promise.resolve(); } };
    const service = new OnlineAcquisitionService(configs, new InMemorySecretStore(), () => adapter, evidence, archive);
    const instance: FeishuInstance = {
      instanceCode: asInstanceCode("instance-1"), approvalCode: config.approvalCodes[0]!, status: "APPROVED",
      startTime: "1722470400000", form: JSON.stringify([{ id: "contract", value: ["/open-apis/approval/v4/files/file-code"] }]),
      taskList: [], commentList: [], timeline: [], reverted: false,
    };
    await expect(service.archiveApproved(config.connectorId, instance)).rejects.toMatchObject({ failure: { category: "RATE_LIMITED", retryAfterMs: 5_000 } });
    expect(archived).toBeUndefined();
  });

  it("keeps the winning versioned secret when concurrent connector updates conflict", async () => {
    let current = createTestFeishuConfig({ secretReference: asSecretReference("feishu:default:r1:old"), revision: 1 });
    const initial = current; const values = new Map<string, string>([[String(current.secretReference), "old-secret"]]);
    let secretSaveCount = 0;
    const secrets: SecretStore = {
      availability: () => Promise.resolve({ available: true, persistent: false }),
      save: (reference: SecretReference, secret: string) => { secretSaveCount += 1; values.set(String(reference), secret); return Promise.resolve(); },
      read: (reference: SecretReference) => Promise.resolve(values.get(String(reference))),
      delete: (reference: SecretReference) => { values.delete(String(reference)); return Promise.resolve(); },
    };
    let getCalls = 0; const waiting: Array<(value: FeishuConnectionConfig) => void> = [];
    const configs: ConnectionConfigStore = {
      get: () => {
        getCalls += 1;
        if (getCalls > 2) return Promise.resolve(current);
        return new Promise<FeishuConnectionConfig>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 2) for (const release of waiting.splice(0)) release(initial);
        });
      },
      save: (value, expectedRevision) => {
        if (expectedRevision !== current.revision) return Promise.reject(new ConflictError("FEISHU_CONNECTION_REVISION_CONFLICT"));
        current = { ...value, revision: current.revision + 1 }; return Promise.resolve(current);
      },
      markDisabled: () => Promise.resolve(),
    };
    const service = new OnlineAcquisitionService(configs, secrets, () => { throw new Error("adapter not used"); },
      { ingest: () => Promise.resolve(asEvidenceRevisionId("unused")) }, { recordArchived: () => Promise.resolve() });
    const update = (appSecret: string) => service.configureFeishu({
      connectorId: current.connectorId, displayName: current.displayName, platform: current.platform, appId: current.appId,
      appSecret, approvalCodes: [...current.approvalCodes],
      attachmentControlIds: Object.fromEntries(Object.entries(current.attachmentControlIds).map(([key, values]) => [key, [...values]])),
      initialLookbackFrom: current.initialLookbackFrom, dailySyncTime: current.dailySyncTime,
      timeZone: current.timeZone, overlapHours: 48, expectedRevision: 1,
    });

    const results = await Promise.allSettled([update("secret-a"), update("secret-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(values).toEqual(new Map([[String(current.secretReference), await secrets.read(current.secretReference)]]));
    expect(["secret-a", "secret-b"]).toContain(await secrets.read(current.secretReference));
    expect(await secrets.read(initial.secretReference)).toBeUndefined();

    const savesBeforeStaleAttempt = secretSaveCount;
    await expect(update("stale-secret")).rejects.toMatchObject({ name: "ConflictError" });
    expect(secretSaveCount).toBe(savesBeforeStaleAttempt);
    expect(values.size).toBe(1);
  });

  it("removes only its new secret when the connector CAS write fails", async () => {
    const current = createTestFeishuConfig({ secretReference: asSecretReference("feishu:default:r1:old"), revision: 1 });
    const values = new Map<string, string>([[String(current.secretReference), "old-secret"]]);
    const secrets: SecretStore = {
      availability: () => Promise.resolve({ available: true, persistent: false }),
      save: (reference, secret) => { values.set(String(reference), secret); return Promise.resolve(); },
      read: (reference) => Promise.resolve(values.get(String(reference))),
      delete: (reference) => { values.delete(String(reference)); return Promise.resolve(); },
    };
    const configs: ConnectionConfigStore = {
      get: () => Promise.resolve(current),
      save: () => Promise.reject(new ConflictError("FEISHU_CONNECTION_REVISION_CONFLICT")),
      markDisabled: () => Promise.resolve(),
    };
    const service = new OnlineAcquisitionService(configs, secrets, () => { throw new Error("adapter not used"); },
      { ingest: () => Promise.resolve(asEvidenceRevisionId("unused")) }, { recordArchived: () => Promise.resolve() });

    await expect(service.configureFeishu({
      connectorId: current.connectorId, displayName: current.displayName, platform: current.platform, appId: current.appId,
      appSecret: "replacement", approvalCodes: [...current.approvalCodes],
      attachmentControlIds: Object.fromEntries(Object.entries(current.attachmentControlIds).map(([key, values]) => [key, [...values]])),
      initialLookbackFrom: current.initialLookbackFrom, dailySyncTime: current.dailySyncTime,
      timeZone: current.timeZone, overlapHours: 48, expectedRevision: current.revision,
    })).rejects.toMatchObject({ name: "ConflictError" });
    expect(values).toEqual(new Map([[String(current.secretReference), "old-secret"]]));
  });

  it("keeps the new active secret when cleanup of the superseded reference fails", async () => {
    let current = createTestFeishuConfig({ secretReference: asSecretReference("feishu:default:r1:old"), revision: 1 });
    const oldReference = current.secretReference;
    const values = new Map<string, string>([[String(oldReference), "old-secret"]]);
    const secrets: SecretStore = {
      availability: () => Promise.resolve({ available: true, persistent: false }),
      save: (reference, secret) => { values.set(String(reference), secret); return Promise.resolve(); },
      read: (reference) => Promise.resolve(values.get(String(reference))),
      delete: (reference) => String(reference) === String(oldReference)
        ? Promise.reject(new Error("credential cleanup unavailable"))
        : Promise.resolve(values.delete(String(reference))).then(() => undefined),
    };
    const configs: ConnectionConfigStore = {
      get: () => Promise.resolve(current),
      save: (value, expectedRevision) => {
        if (expectedRevision !== current.revision) return Promise.reject(new ConflictError());
        current = { ...value, revision: current.revision + 1 }; return Promise.resolve(current);
      },
      markDisabled: () => Promise.resolve(),
    };
    const service = new OnlineAcquisitionService(configs, secrets, () => { throw new Error("adapter not used"); },
      { ingest: () => Promise.resolve(asEvidenceRevisionId("unused")) }, { recordArchived: () => Promise.resolve() });
    const saved = await service.configureFeishu({
      connectorId: current.connectorId, displayName: current.displayName, platform: current.platform, appId: current.appId,
      appSecret: "new-secret", approvalCodes: [...current.approvalCodes],
      attachmentControlIds: Object.fromEntries(Object.entries(current.attachmentControlIds).map(([key, values]) => [key, [...values]])),
      initialLookbackFrom: current.initialLookbackFrom, dailySyncTime: current.dailySyncTime,
      timeZone: current.timeZone, overlapHours: 48, expectedRevision: current.revision,
    });
    expect(await secrets.read(saved.secretReference)).toBe("new-secret");
    expect(await secrets.read(oldReference)).toBe("old-secret");
  });
});
