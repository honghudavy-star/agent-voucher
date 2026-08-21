import { createHash } from "node:crypto";
import type { ConnectionConfigStore, ConnectorAdapter, EvidenceIngestPort, SecretStore, SourceArchivePort } from "./contracts.js";
import { ConfigureFeishuConnectionSchema, FeishuConnectionConfigSchema, type ConfigureFeishuConnectionInput } from "./schemas.js";
import {
  CONNECTOR_STATUS,
  FEISHU_INSTANCE_STATUS,
  asSecretReference,
  type ArchivedSourceItem,
  type ConnectorFailure,
  type DiscoveryPage,
  type DiscoveryRequest,
  type EvidenceRevisionId,
  type FeishuConnectionConfig,
  type FeishuInstance,
  type InstanceCode,
  type ReconciliationResult,
} from "./types.js";

export type ConnectorAdapterFactory = (config: FeishuConnectionConfig) => ConnectorAdapter;

export class OnlineAcquisitionService {
  constructor(
    private readonly configs: ConnectionConfigStore,
    private readonly secrets: SecretStore,
    private readonly adapters: ConnectorAdapterFactory,
    private readonly evidence: EvidenceIngestPort,
    private readonly sourceArchive: SourceArchivePort,
  ) {}

  async configureFeishu(input: ConfigureFeishuConnectionInput): Promise<FeishuConnectionConfig> {
    const parsed = ConfigureFeishuConnectionSchema.parse(input);
    const secretReference = asSecretReference(`feishu:${parsed.connectorId}`);
    const config = FeishuConnectionConfigSchema.parse({
      ...parsed,
      secretReference,
      revision: parsed.expectedRevision === undefined ? 1 : parsed.expectedRevision + 1,
      status: CONNECTOR_STATUS.ACTIVE,
    });
    const previousSecret = await this.secrets.read(secretReference);
    await this.secrets.save(secretReference, parsed.appSecret);
    try {
      return await this.configs.save(config, parsed.expectedRevision);
    } catch (error) {
      if (previousSecret === undefined) await this.secrets.delete(secretReference).catch(() => undefined);
      else await this.secrets.save(secretReference, previousSecret).catch(() => undefined);
      throw error;
    }
  }

  async testConnection(connectorId: FeishuConnectionConfig["connectorId"]): Promise<void> {
    const config = await this.#requireConfig(connectorId);
    await this.adapters(config).testConnection();
  }

  async discoverApproved(connectorId: FeishuConnectionConfig["connectorId"], request: DiscoveryRequest): Promise<DiscoveryPage> {
    const config = await this.#requireActiveConfig(connectorId);
    return this.adapters(config).discoverApproved(request);
  }

  async reconcileTracked(connectorId: FeishuConnectionConfig["connectorId"], instanceCodes: readonly InstanceCode[]): Promise<readonly ReconciliationResult[]> {
    const config = await this.#requireActiveConfig(connectorId);
    return this.adapters(config).reconcileTrackedInstances(instanceCodes);
  }

  async archiveApproved(connectorId: FeishuConnectionConfig["connectorId"], instance: FeishuInstance): Promise<ArchivedSourceItem> {
    const config = await this.#requireActiveConfig(connectorId);
    if (instance.status !== FEISHU_INSTANCE_STATUS.APPROVED) throw new Error("Only approved Feishu instances may be archived");
    if (!config.approvalCodes.includes(instance.approvalCode)) throw new Error("Approval code is not whitelisted");
    const remoteRevisionHash = canonicalInstanceHash(instance);
    const formBytes = new TextEncoder().encode(canonicalJson({
      instance_code: instance.instanceCode,
      approval_code: instance.approvalCode,
      status: instance.status,
      start_time: instance.startTime,
      end_time: instance.endTime ?? null,
      serial_number: instance.serialNumber ?? null,
      form: safeParseJson(instance.form),
      task_list: instance.taskList,
      comment_list: instance.commentList,
      timeline: instance.timeline,
      modified_instance_code: instance.modifiedInstanceCode ?? null,
      reverted_instance_code: instance.revertedInstanceCode ?? null,
      reverted: instance.reverted,
    }));
    const formEvidenceRevisionId = await this.evidence.ingest({
      sourceSystem: "FEISHU_APPROVAL",
      connectorId,
      externalId: instance.instanceCode,
      remoteRevisionHash,
      originalFileName: `${instance.instanceCode}.json`,
      declaredMediaType: "application/json",
      idempotencyKey: `feishu:${connectorId}:${instance.instanceCode}:${remoteRevisionHash}:form`,
      content: bytesToStream(formBytes),
      metadata: {
        approvalCode: instance.approvalCode,
        instanceStatus: instance.status,
        serialNumber: instance.serialNumber ?? null,
      },
    });

    const attachmentIds: EvidenceRevisionId[] = [];
    const attachmentOutcomes: ArchivedSourceItem["attachmentOutcomes"][number][] = [];
    const failures: ConnectorFailure[] = [];
    const adapter = this.adapters(config);
    for (const attachment of extractAttachmentPaths(instance.form, config.attachmentControlIds[instance.approvalCode] ?? [])) {
      const remotePathHash = createHash("sha256").update(attachment.remotePath).digest("hex");
      try {
        const download = await adapter.downloadAttachment({ remotePath: attachment.remotePath });
        const evidenceId = await this.evidence.ingest({
          sourceSystem: "FEISHU_APPROVAL",
          connectorId,
          externalId: `${instance.instanceCode}:${attachment.controlId}:${attachment.index}`,
          remoteRevisionHash,
          originalFileName: download.suggestedFilename ?? `${instance.instanceCode}-${attachment.controlId}-${String(attachment.index)}`,
          declaredMediaType: download.mediaType,
          idempotencyKey: `feishu:${connectorId}:${instance.instanceCode}:${remoteRevisionHash}:${attachment.controlId}:${String(attachment.index)}`,
          content: download.stream,
          metadata: { approvalCode: instance.approvalCode, controlId: attachment.controlId },
        });
        attachmentIds.push(evidenceId);
        attachmentOutcomes.push({ controlId: attachment.controlId, index: attachment.index, remotePathHash, status: "ARCHIVED", evidenceRevisionId: evidenceId });
      } catch (error) {
        const failure = error instanceof Error && "failure" in error
          ? (error as { readonly failure: ConnectorFailure }).failure
          : { category: "PERMANENT", code: "FEISHU_ATTACHMENT_FAILED", retryable: false } as const;
        if (failure.retryable || failure.category === "REAUTH_REQUIRED") throw error;
        failures.push(failure);
        attachmentOutcomes.push({ controlId: attachment.controlId, index: attachment.index, remotePathHash, status: "FAILED", errorCode: failure.code });
      }
    }
    const archived = {
      instanceCode: instance.instanceCode,
      formEvidenceRevisionId,
      attachmentEvidenceRevisionIds: attachmentIds,
      remoteRevisionHash,
      status: failures.length === 0 ? "ARCHIVED" : "PARTIAL",
      failures,
      attachmentOutcomes,
    } satisfies ArchivedSourceItem;
    await this.sourceArchive.recordArchived(archived);
    return archived;
  }

  async disable(connectorId: FeishuConnectionConfig["connectorId"]): Promise<void> {
    const config = await this.#requireConfig(connectorId);
    await this.adapters(config).disable();
    await this.configs.markDisabled(connectorId);
  }

  async #requireConfig(connectorId: FeishuConnectionConfig["connectorId"]): Promise<FeishuConnectionConfig> {
    const config = await this.configs.get(connectorId);
    if (!config) throw new Error(`Connector not found: ${connectorId}`);
    return config;
  }

  async #requireActiveConfig(connectorId: FeishuConnectionConfig["connectorId"]): Promise<FeishuConnectionConfig> {
    const config = await this.#requireConfig(connectorId);
    if (config.status !== CONNECTOR_STATUS.ACTIVE) throw new Error(`Connector is not active: ${config.status}`);
    return config;
  }
}

function safeParseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function canonicalInstanceHash(instance: FeishuInstance): string {
  return createHash("sha256").update(canonicalJson(instance)).digest("hex");
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

interface ExtractedAttachmentPath { readonly controlId: string; readonly index: number; readonly remotePath: string }

export function extractAttachmentPaths(form: string, allowedControlIds: readonly string[]): readonly ExtractedAttachmentPath[] {
  const allowed = new Set(allowedControlIds);
  if (allowed.size === 0) return [];
  const parsed = safeParseJson(form);
  const result: ExtractedAttachmentPath[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node === null || typeof node !== "object") return;
    const item = node as Readonly<Record<string, unknown>>;
    const controlId = [item.id, item.custom_id, item.widget_id, item.field_id].find((value): value is string => typeof value === "string");
    if (controlId && allowed.has(controlId)) {
      const values = Array.isArray(item.value) ? item.value : [item.value];
      values.forEach((value, index) => {
        const remotePath = typeof value === "string"
          ? value
          : value !== null && typeof value === "object" && typeof (value as Readonly<Record<string, unknown>>).url === "string"
            ? String((value as Readonly<Record<string, unknown>>).url)
            : undefined;
        if (remotePath) result.push({ controlId, index, remotePath });
      });
    }
    for (const key of ["children", "items", "widgets", "fields", "form", "form_content", "value"]) {
      const child = item[key]; if (Array.isArray(child) || (child !== null && typeof child === "object")) visit(child);
    }
  };
  visit(parsed);
  return result;
}
