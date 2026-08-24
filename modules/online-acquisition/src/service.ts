import { createHash, randomUUID } from "node:crypto";
import { ConflictError } from "@agent-voucher/shared-kernel";
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

function attachmentFallbackName(instanceCode: string, controlId: string, index: number, mediaType: string): string {
  const extension = new Map([
    ["application/pdf", ".pdf"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
    ["image/png", ".png"],
    ["image/jpeg", ".jpg"],
  ]).get(mediaType.toLowerCase().split(";", 1)[0] ?? "") ?? "";
  return `${instanceCode}-${controlId}-${String(index)}${extension}`;
}

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
    const previous = await this.configs.get(parsed.connectorId);
    if (previous && parsed.expectedRevision !== previous.revision) throw new ConflictError("FEISHU_CONNECTION_REVISION_CONFLICT");
    if (!previous && parsed.expectedRevision !== undefined) throw new ConflictError("FEISHU_CONNECTION_NOT_FOUND");
    const nextRevision = (previous?.revision ?? 0) + 1;
    const secretReference = asSecretReference(`feishu:${parsed.connectorId}:r${String(nextRevision)}:${randomUUID()}`);
    const config = FeishuConnectionConfigSchema.parse({
      ...parsed,
      secretReference,
      revision: nextRevision,
      status: CONNECTOR_STATUS.ACTIVE,
    });
    await this.secrets.save(secretReference, parsed.appSecret);
    try {
      const saved = await this.configs.save(config, parsed.expectedRevision);
      if (previous && previous.secretReference !== saved.secretReference) {
        await this.secrets.delete(previous.secretReference).catch(() => undefined);
      }
      return saved;
    } catch (error) {
      await this.secrets.delete(secretReference).catch(() => undefined);
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
          originalFileName: download.suggestedFilename
            ?? attachmentFallbackName(instance.instanceCode, attachment.controlId, attachment.index, download.mediaType),
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
      connectorId,
      instanceCode: instance.instanceCode,
      configRevision: config.revision,
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
