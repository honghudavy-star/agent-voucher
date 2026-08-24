import type {
  ArchivedSourceItem,
  AttachmentDownloadRequest,
  CanonicalEvidenceEnvelope,
  ConnectionTestResult,
  DiscoveryPage,
  DiscoveryRequest,
  EvidenceRevisionId,
  FeishuConnectionConfig,
  InstanceCode,
  ReconciliationResult,
  RemoteAttachment,
  SecretReference,
} from "./types.js";

export interface SecretStoreAvailability {
  readonly available: boolean;
  readonly persistent: boolean;
  readonly reason?: string;
}

export interface SecretStore {
  availability(): Promise<SecretStoreAvailability>;
  save(reference: SecretReference, secret: string): Promise<void>;
  read(reference: SecretReference): Promise<string | undefined>;
  delete(reference: SecretReference): Promise<void>;
}

export interface ConnectorAdapter {
  testConnection(): Promise<ConnectionTestResult>;
  discoverApproved(request: DiscoveryRequest): Promise<DiscoveryPage>;
  reconcileTrackedInstances(instanceCodes: readonly InstanceCode[]): Promise<readonly ReconciliationResult[]>;
  downloadAttachment(request: AttachmentDownloadRequest): Promise<RemoteAttachment>;
  disable(): Promise<void>;
}

export interface EvidenceIngestPort {
  ingest(envelope: CanonicalEvidenceEnvelope): Promise<EvidenceRevisionId>;
}

export interface ConnectionConfigStore {
  save(config: FeishuConnectionConfig, expectedRevision?: number): Promise<FeishuConnectionConfig>;
  get(connectorId: FeishuConnectionConfig["connectorId"]): Promise<FeishuConnectionConfig | undefined>;
  markDisabled(connectorId: FeishuConnectionConfig["connectorId"]): Promise<void>;
}

export interface SourceArchivePort {
  recordArchived(item: ArchivedSourceItem): Promise<void>;
}
