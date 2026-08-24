import { z } from "zod";
import {
  CONNECTOR_STATUS,
  FEISHU_PLATFORM,
  FEISHU_INSTANCE_STATUS,
  asApprovalCode,
  asConnectorId,
  asInstanceCode,
  asSecretReference,
} from "./types.js";

const IdentifierSchema = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
const MillisecondTimestampSchema = z.union([
  z.string().regex(/^\d{10,16}$/),
  z.number().int().nonnegative().transform(String),
]);
const TimeZoneSchema = z.string().trim().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; }
  catch { return false; }
}, "timeZone must be a valid IANA time zone");

export const ConnectorIdSchema = IdentifierSchema.transform(asConnectorId);
export const ApprovalCodeSchema = IdentifierSchema.transform(asApprovalCode);
export const InstanceCodeSchema = IdentifierSchema.transform(asInstanceCode);
export const SecretReferenceSchema = z.string().trim().min(1).max(512).transform(asSecretReference);

export const FeishuConnectionConfigSchema = z.object({
  connectorId: ConnectorIdSchema,
  displayName: z.string().trim().min(1).max(120),
  platform: z.enum(FEISHU_PLATFORM).default(FEISHU_PLATFORM.FEISHU),
  appId: IdentifierSchema,
  secretReference: SecretReferenceSchema,
  approvalCodes: z.array(ApprovalCodeSchema).min(1).max(100).transform((values) => [...new Set(values)]),
  attachmentControlIds: z.record(ApprovalCodeSchema, z.array(IdentifierSchema).max(100).transform((values) => [...new Set(values)])).default({}),
  initialLookbackFrom: z.iso.datetime({ offset: true }),
  dailySyncTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("02:00"),
  timeZone: TimeZoneSchema,
  overlapHours: z.literal(48).default(48),
  revision: z.number().int().positive().default(1),
  status: z.enum(CONNECTOR_STATUS).default(CONNECTOR_STATUS.ACTIVE),
});

export const ConfigureFeishuConnectionSchema = FeishuConnectionConfigSchema.omit({ secretReference: true, revision: true, status: true }).extend({
  appSecret: z.string().min(1).max(4096),
  expectedRevision: z.number().int().positive().optional(),
});

export const DiscoveryRequestSchema = z.object({
  approvalCode: ApprovalCodeSchema,
  startTime: MillisecondTimestampSchema,
  endTime: MillisecondTimestampSchema,
  pageSize: z.number().int().min(1).max(100).default(100),
  pageToken: z.string().min(1).max(4096).optional(),
}).refine((value) => BigInt(value.startTime) <= BigInt(value.endTime), {
  message: "startTime must not be after endTime",
  path: ["startTime"],
});

export const AttachmentDownloadRequestSchema = z.object({
  remotePath: z.string().trim().min(1).max(8192).refine((value) => {
    if (value.startsWith("/")) return value.startsWith("/open-apis/") || value.startsWith("/approval/");
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      return url.protocol === "https:" && url.port === "" && (
        hostname === "open.feishu.cn" || hostname === "open.larksuite.com"
        || hostname.endsWith(".feishucdn.com") || hostname.endsWith(".larksuitecdn.com")
      );
    } catch {
      return false;
    }
  }, "attachment URL must use an approved Feishu/Lark host"),
});

const UnknownRecordSchema = z.record(z.string(), z.unknown());

export const FeishuInstanceApiSchema = z.object({
  instance_code: InstanceCodeSchema,
  approval_code: ApprovalCodeSchema,
  status: z.enum(FEISHU_INSTANCE_STATUS),
  start_time: MillisecondTimestampSchema,
  end_time: MillisecondTimestampSchema.optional(),
  serial_number: z.string().max(256).optional(),
  form: z.string().default("[]"),
  task_list: z.array(UnknownRecordSchema).default([]),
  comment_list: z.array(UnknownRecordSchema).default([]),
  timeline: z.array(UnknownRecordSchema).default([]),
  modified_instance_code: InstanceCodeSchema.optional(),
  reverted_instance_code: InstanceCodeSchema.optional(),
  reverted: z.boolean().default(false),
});

export const TenantTokenApiResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().default(""),
  tenant_access_token: z.string().min(1).optional(),
  expire: z.number().int().positive().optional(),
});

export const InstanceIdPageApiResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().default(""),
  data: z.object({
    instance_code_list: z.array(InstanceCodeSchema).default([]),
    instance_list: z.array(z.object({
      instance: z.object({ code: InstanceCodeSchema }).passthrough(),
    }).passthrough()).default([]),
    page_token: z.string().optional(),
    has_more: z.boolean().default(false),
  }).optional(),
});

export const InstanceDetailApiResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().default(""),
  data: FeishuInstanceApiSchema.optional(),
});

export const ApprovalDetailApiResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().default(""),
  data: z.record(z.string(), z.unknown()).optional(),
});

export type ConfigureFeishuConnectionInput = z.input<typeof ConfigureFeishuConnectionSchema>;
