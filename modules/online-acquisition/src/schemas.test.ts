import { describe, expect, it } from "vitest";
import {
  AttachmentDownloadRequestSchema,
  DiscoveryRequestSchema,
  FeishuConnectionConfigSchema,
} from "./schemas.js";
import { ONLINE_ACQUISITION_MIGRATION_V1 } from "./migrations.js";

describe("online acquisition schemas", () => {
  it("normalizes defaults and removes duplicate approval codes", () => {
    const result = FeishuConnectionConfigSchema.parse({
      connectorId: "feishu-primary",
      displayName: " 飞书审批 ",
      appId: "cli_123",
      secretReference: "feishu:primary",
      approvalCodes: ["APPROVAL_1", "APPROVAL_1", "APPROVAL_2"],
      initialLookbackFrom: "2026-08-01T00:00:00.000Z",
      timeZone: "Asia/Shanghai",
    });

    expect(result.displayName).toBe("飞书审批");
    expect(result.approvalCodes).toEqual(["APPROVAL_1", "APPROVAL_2"]);
    expect(result.dailySyncTime).toBe("02:00");
    expect(result.platform).toBe("FEISHU");
    expect(result.overlapHours).toBe(48);
  });

  it("rejects reversed discovery windows", () => {
    expect(() => DiscoveryRequestSchema.parse({
      approvalCode: "APPROVAL_1",
      startTime: "2000000000000",
      endTime: "1000000000000",
    })).toThrow(/startTime/);
  });

  it("rejects invalid scheduler time zones", () => {
    expect(() => FeishuConnectionConfigSchema.parse({
      connectorId: "feishu", displayName: "飞书", appId: "cli_1", secretReference: "secret",
      approvalCodes: ["APPROVAL_1"], initialLookbackFrom: "2026-08-01T00:00:00.000Z", timeZone: "Mars/Olympus",
    })).toThrow(/timeZone/);
  });

  it("allows only approved Feishu/Lark attachment hosts or OpenAPI paths", () => {
    expect(AttachmentDownloadRequestSchema.parse({ remotePath: "/open-apis/drive/v1/files/file/download" }).remotePath)
      .toBe("/open-apis/drive/v1/files/file/download");
    expect(AttachmentDownloadRequestSchema.parse({ remotePath: "https://lf16-approval-file-sign.larksuitecdn.com/file" }).remotePath)
      .toContain("larksuitecdn.com");
    expect(() => AttachmentDownloadRequestSchema.parse({ remotePath: "https://attacker.example/file" })).toThrow(/approved Feishu/);
    expect(() => AttachmentDownloadRequestSchema.parse({ remotePath: "http://open.feishu.cn/file" })).toThrow(/approved Feishu/);
  });

  it("publishes deterministic conn_ and src_ migration SQL", () => {
    expect(ONLINE_ACQUISITION_MIGRATION_V1.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(ONLINE_ACQUISITION_MIGRATION_V1.upSql.join("\n")).toContain("conn_connector");
    expect(ONLINE_ACQUISITION_MIGRATION_V1.upSql.join("\n")).toContain("src_source_item");
    expect(ONLINE_ACQUISITION_MIGRATION_V1.upSql.join("\n")).not.toMatch(/CREATE TABLE IF NOT EXISTS (?!conn_|src_)/);
  });
});
