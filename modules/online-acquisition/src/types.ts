export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type ConnectorId = Brand<string, "ConnectorId">;
export type ApprovalCode = Brand<string, "ApprovalCode">;
export type InstanceCode = Brand<string, "InstanceCode">;
export type SecretReference = Brand<string, "SecretReference">;
export type EvidenceRevisionId = Brand<string, "EvidenceRevisionId">;

export const asConnectorId = (value: string): ConnectorId => value as ConnectorId;
export const asApprovalCode = (value: string): ApprovalCode => value as ApprovalCode;
export const asInstanceCode = (value: string): InstanceCode => value as InstanceCode;
export const asSecretReference = (value: string): SecretReference => value as SecretReference;
export const asEvidenceRevisionId = (value: string): EvidenceRevisionId => value as EvidenceRevisionId;

export const CONNECTOR_STATUS = {
  ACTIVE: "ACTIVE",
  DISABLED: "DISABLED",
  REAUTH_REQUIRED: "REAUTH_REQUIRED",
} as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUS)[keyof typeof CONNECTOR_STATUS];

export const FEISHU_PLATFORM = { FEISHU: "FEISHU", LARK: "LARK" } as const;
export type FeishuPlatform = (typeof FEISHU_PLATFORM)[keyof typeof FEISHU_PLATFORM];

export const SOURCE_ITEM_STATUS = {
  DISCOVERED: "DISCOVERED",
  FETCHING: "FETCHING",
  ARCHIVED: "ARCHIVED",
  PARTIAL: "PARTIAL",
  REAUTH_REQUIRED: "REAUTH_REQUIRED",
  FAILED: "FAILED",
} as const;
export type SourceItemStatus = (typeof SOURCE_ITEM_STATUS)[keyof typeof SOURCE_ITEM_STATUS];

export const FEISHU_INSTANCE_STATUS = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  CANCELED: "CANCELED",
  DELETED: "DELETED",
  REVERTED: "REVERTED",
} as const;
export type FeishuInstanceStatus = (typeof FEISHU_INSTANCE_STATUS)[keyof typeof FEISHU_INSTANCE_STATUS];

export interface FeishuConnectionConfig {
  readonly connectorId: ConnectorId;
  readonly displayName: string;
  readonly platform: FeishuPlatform;
  readonly appId: string;
  readonly secretReference: SecretReference;
  readonly approvalCodes: readonly ApprovalCode[];
  readonly attachmentControlIds: Readonly<Record<string, readonly string[]>>;
  readonly initialLookbackFrom: string;
  readonly dailySyncTime: string;
  readonly timeZone: string;
  readonly overlapHours: 48;
  readonly revision: number;
  readonly status: ConnectorStatus;
}

export interface FeishuInstance {
  readonly instanceCode: InstanceCode;
  readonly approvalCode: ApprovalCode;
  readonly status: FeishuInstanceStatus;
  readonly startTime: string;
  readonly endTime?: string;
  readonly serialNumber?: string;
  readonly form: string;
  readonly taskList: readonly Readonly<Record<string, unknown>>[];
  readonly commentList: readonly Readonly<Record<string, unknown>>[];
  readonly timeline: readonly Readonly<Record<string, unknown>>[];
  readonly modifiedInstanceCode?: InstanceCode;
  readonly revertedInstanceCode?: InstanceCode;
  readonly reverted: boolean;
}

export interface DiscoveryRequest {
  readonly approvalCode: ApprovalCode;
  readonly startTime: string;
  readonly endTime: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface DiscoveryPage {
  readonly items: readonly FeishuInstance[];
  readonly hasMore: boolean;
  readonly nextPageToken?: string;
  readonly observedInstanceCodes: readonly InstanceCode[];
}

export interface ReconciliationResult {
  readonly instanceCode: InstanceCode;
  readonly status: FeishuInstanceStatus;
  readonly instance?: FeishuInstance;
  readonly tombstone: boolean;
}

export interface AttachmentDownloadRequest {
  /** Relative OpenAPI path or a signed attachment URL on an approved Feishu/Lark host. */
  readonly remotePath: string;
}

export interface RemoteAttachment {
  readonly stream: ReadableStream<Uint8Array>;
  readonly mediaType: string;
  readonly contentLength?: number;
  readonly suggestedFilename?: string;
}

export type ConnectorFailure =
  | { readonly category: "REAUTH_REQUIRED"; readonly code: string; readonly retryable: false }
  | { readonly category: "RATE_LIMITED"; readonly code: string; readonly retryable: true; readonly retryAfterMs: number }
  | { readonly category: "TRANSIENT"; readonly code: string; readonly retryable: true }
  | { readonly category: "PERMANENT"; readonly code: string; readonly retryable: false };

export interface ConnectionTestResult {
  readonly ok: true;
  readonly checkedApprovalCode: ApprovalCode;
}

export interface CanonicalEvidenceEnvelope {
  readonly sourceSystem: "FEISHU_APPROVAL";
  readonly connectorId: ConnectorId;
  readonly externalId: string;
  readonly remoteRevisionHash: string;
  readonly originalFileName: string;
  readonly declaredMediaType: string;
  readonly idempotencyKey: string;
  readonly content: ReadableStream<Uint8Array>;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ArchivedSourceItem {
  readonly instanceCode: InstanceCode;
  readonly formEvidenceRevisionId: EvidenceRevisionId;
  readonly attachmentEvidenceRevisionIds: readonly EvidenceRevisionId[];
  readonly remoteRevisionHash: string;
  readonly status: "ARCHIVED" | "PARTIAL";
  readonly failures: readonly ConnectorFailure[];
  readonly attachmentOutcomes: readonly {
    controlId: string;
    index: number;
    remotePathHash: string;
    status: "ARCHIVED" | "FAILED";
    evidenceRevisionId?: EvidenceRevisionId;
    errorCode?: string;
  }[];
}
