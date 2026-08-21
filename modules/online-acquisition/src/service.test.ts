import { describe, expect, it } from "vitest";
import type { ConnectionConfigStore, ConnectorAdapter, EvidenceIngestPort, SourceArchivePort } from "./contracts.js";
import { ConnectorRequestError, createTestFeishuConfig } from "./feishu-adapter.js";
import { InMemorySecretStore } from "./secret-store.js";
import { OnlineAcquisitionService, extractAttachmentPaths } from "./service.js";
import { asEvidenceRevisionId, asInstanceCode, type ArchivedSourceItem, type FeishuInstance } from "./types.js";

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
});
