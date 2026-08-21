import { join } from "node:path";
import { z } from "zod";
import {
  ConnectorRequestError,
  FeishuConnectorAdapter,
  OnlineAcquisitionService,
  OnlineAcquisitionSqlStore,
  asConnectorId,
  asEvidenceRevisionId,
  asSecretReference,
  canonicalInstanceHash,
  createPlatformSecretStore,
  type CanonicalEvidenceEnvelope,
  type EvidenceIngestPort as AcquisitionEvidencePort,
  type SecretStore,
} from "@agent-voucher/online-acquisition";
import { EvidenceVaultService } from "@agent-voucher/evidence-vault";
import { DocumentUnderstandingService, ParserProcessError, type BankMappingProfile, type BankParserResult, type EvidenceRevisionId } from "@agent-voucher/document-understanding";
import type { ActorSnapshot, DatabasePort } from "@agent-voucher/shared-kernel";
import { QueueFullError } from "@agent-voucher/shared-kernel";
import type { JobHandlerRegistry, RuntimeAuditService } from "@agent-voucher/runtime-audit";
import { packageRoot } from "./package-root.js";

const SYSTEM_ACTOR: ActorSnapshot = { userId: "SYSTEM", username: "phase2-scheduler", roles: ["ADMIN"] };
const FeishuJobSchema = z.object({ connectorId: z.string().min(1), trigger: z.enum(["SCHEDULED", "MANUAL", "STARTUP_CATCHUP", "RECONCILIATION"]) });
const BankJobSchema = z.object({ evidenceId: z.string().min(1), mappingRevisionId: z.string().min(1), overrideReason: z.string().min(1).max(500).optional() });
const InvoiceJobSchema = z.object({ evidenceId: z.string().min(1) });

async function* webChunks(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return;
      yield item.value;
    }
  } finally { reader.releaseLock(); }
}

function zonedDateTime(date: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${value("year")}-${value("month")}-${value("day")}`, time: `${value("hour")}:${value("minute")}` };
}

function classifyDocumentJobError(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof ParserProcessError) {
    return { code: error.code, retryable: error.code === "PARSER_TIMEOUT" || error.code === "PARSER_CRASHED" || error.code === "PARSER_CANCELED" };
  }
  if (error instanceof z.ZodError) return { code: "DOCUMENT_SCHEMA_INVALID", retryable: false };
  if (error instanceof QueueFullError) return { code: "DATABASE_QUEUE_FULL", retryable: true };
  const message = error instanceof Error ? error.message : "DOCUMENT_JOB_FAILED";
  if (["BANK_MAPPING_NOT_FOUND", "EVIDENCE_NOT_AVAILABLE", "EVIDENCE_CONTENT_HASH_MISMATCH"].includes(message)) return { code: message, retryable: false };
  return { code: "DOCUMENT_PERSISTENCE_TRANSIENT", retryable: true };
}

class FeishuEvidenceAdapter implements AcquisitionEvidencePort {
  constructor(private readonly evidence: EvidenceVaultService, private readonly actor: ActorSnapshot) {}

  async ingest(envelope: CanonicalEvidenceEnvelope): Promise<ReturnType<typeof asEvidenceRevisionId>> {
    const existingEvidenceId = await this.evidence.evidenceIdForSource("FEISHU", envelope.externalId);
    const result = await this.evidence.ingest({
      ...(existingEvidenceId ? { evidenceId: existingEvidenceId } : {}),
      kind: envelope.originalFileName.endsWith(".json") ? "APPROVAL" : "CONTRACT_FILE",
      sourceKind: "FEISHU", originalName: envelope.originalFileName, declaredMediaType: envelope.declaredMediaType,
      sourceRef: envelope.externalId, sourceRevision: envelope.remoteRevisionHash, idempotencyKey: envelope.idempotencyKey,
      actor: this.actor, chunks: webChunks(envelope.content),
    });
    if (result.status === "QUARANTINED") throw new Error(`FEISHU_EVIDENCE_QUARANTINED:${result.reason}`);
    return asEvidenceRevisionId(result.revisionId);
  }
}

export class Phase2Runtime {
  readonly evidence: EvidenceVaultService;
  readonly documents: DocumentUnderstandingService;
  readonly secretStore: SecretStore;
  private scheduler: NodeJS.Timeout | undefined;
  private schedulerRunning = false;
  private parserTail: Promise<void> = Promise.resolve();

  constructor(private readonly db: DatabasePort, dataDir: string, secretStore?: SecretStore) {
    this.evidence = new EvidenceVaultService(db, dataDir);
    this.documents = new DocumentUnderstandingService(db, {
      entryPath: join(packageRoot, "dist", "parser-worker.js"),
    });
    this.secretStore = secretStore ?? createPlatformSecretStore({ testFallback: process.env.NODE_ENV === "test" });
  }

  async start(): Promise<void> {
    await this.evidence.start();
    const { store } = this.acquisition(SYSTEM_ACTOR);
    for (const connection of await store.list()) {
      if (String(connection.status) !== "ACTIVE" || typeof connection.secret_ref !== "string") continue;
      try {
        if (!await this.secretStore.read(asSecretReference(connection.secret_ref))) await store.markReauthRequired(String(connection.id), "FEISHU_SECRET_MISSING");
      } catch { await store.markReauthRequired(String(connection.id), "FEISHU_SECRET_STORE_UNAVAILABLE"); }
    }
  }
  stop(): void { if (this.scheduler) clearInterval(this.scheduler); this.scheduler = undefined; }

  async previewBank(context: { evidenceRevisionId: EvidenceRevisionId; filePath: string; contentSha256: string }, profile: BankMappingProfile, signal?: AbortSignal): Promise<BankParserResult> {
    return this.inParserLane(() => this.documents.parseBank(context, profile, signal));
  }

  acquisition(actor: ActorSnapshot, signal?: AbortSignal): { service: OnlineAcquisitionService; store: OnlineAcquisitionSqlStore } {
    const store = new OnlineAcquisitionSqlStore(this.db, actor);
    const adapters = new Map<string, { revision: number; adapter: FeishuConnectorAdapter }>();
    const service = new OnlineAcquisitionService(
      store, this.secretStore,
      (config) => {
        const cached = adapters.get(config.connectorId);
        if (cached?.revision === config.revision) return cached.adapter;
        const adapter = new FeishuConnectorAdapter(config, this.secretStore, { ...(signal ? { signal } : {}) });
        adapters.set(config.connectorId, { revision: config.revision, adapter }); return adapter;
      },
      new FeishuEvidenceAdapter(this.evidence, actor), store,
    );
    return { service, store };
  }

  registerHandlers(registry: JobHandlerRegistry): void {
    registry.register({
      type: "FEISHU_SYNC", lane: "NETWORK", leaseMs: 300_000, parsePayload: (value) => FeishuJobSchema.parse(value),
      handle: (payload, context) => this.syncFeishu(context.requestedBy, payload.connectorId, payload.trigger, context.signal),
      classifyError: (error) => error instanceof ConnectorRequestError
        ? { code: error.failure.code, retryable: error.failure.retryable, ...(error.failure.category === "RATE_LIMITED" ? { retryAfterMs: error.failure.retryAfterMs } : {}) }
        : { code: "FEISHU_SYNC_FAILED", retryable: true },
    });
    registry.register({
      type: "BANK_PARSE", lane: "PARSER", leaseMs: 90_000, parsePayload: (value) => BankJobSchema.parse(value),
      handle: async (payload, context) => {
        const mapping = await this.documents.getMappingRevision(payload.mappingRevisionId);
        if (!mapping) throw new Error("BANK_MAPPING_NOT_FOUND");
        const evidence = await this.requireEvidence(payload.evidenceId, "BANK_STATEMENT");
        const filePath = await this.evidence.verifiedObjectPath(payload.evidenceId);
        const result = await this.inParserLane(() => this.documents.parseBank({
          evidenceRevisionId: String(evidence.revision_id) as EvidenceRevisionId,
          filePath, contentSha256: String(evidence.content_hash),
        }, mapping.profile, context.signal));
        const importId = await this.documents.persistBankImport(context.requestedBy, String(evidence.revision_id) as EvidenceRevisionId, payload.mappingRevisionId, result);
        if (!result.validation.valid && payload.overrideReason) await this.documents.overrideBankImport(context.requestedBy, importId, payload.overrideReason);
        return { importId, rowCount: result.rows.length, valid: result.validation.valid };
      },
      classifyError: classifyDocumentJobError,
    });
    registry.register({
      type: "INVOICE_PARSE", lane: "PARSER", leaseMs: 90_000, parsePayload: (value) => InvoiceJobSchema.parse(value),
      handle: async (payload, context) => {
        const evidence = await this.requireEvidence(payload.evidenceId, "INVOICE");
        const filePath = await this.evidence.verifiedObjectPath(payload.evidenceId);
        const result = await this.inParserLane(() => this.documents.parseInvoice({
          evidenceRevisionId: String(evidence.revision_id) as EvidenceRevisionId,
          filePath, contentSha256: String(evidence.content_hash),
        }, context.signal));
        const extractionId = await this.documents.persistInvoiceExtraction(context.requestedBy, String(evidence.revision_id) as EvidenceRevisionId, result);
        return { extractionId, status: result.status, fieldCount: result.fields.length };
      },
      classifyError: classifyDocumentJobError,
    });
    registry.register({
      type: "QUARANTINE_PURGE", lane: "MAINTENANCE", leaseMs: 60_000,
      parsePayload: () => ({}), handle: async (_payload, context) => ({ purged: await this.evidence.purgeExpired(context.requestedBy) }),
    });
  }

  startScheduler(runtime: RuntimeAuditService): void {
    const check = async (): Promise<void> => {
      const { store } = this.acquisition(SYSTEM_ACTOR);
      const connections = await store.list(); const now = new Date(); const maintenanceDate = now.toISOString().slice(0, 10);
      await runtime.enqueueJob(SYSTEM_ACTOR, {
        type: "QUARANTINE_PURGE", lane: "MAINTENANCE", payload: {}, dedupeKey: `quarantine-purge:${maintenanceDate}`,
      }).catch(() => undefined);
      for (const connection of connections) {
        const connectionTimeZone = typeof connection.time_zone === "string" ? connection.time_zone : "Asia/Shanghai";
        const local = zonedDateTime(now, connectionTimeZone);
        const connectionStatus = typeof connection.status === "string" ? connection.status : "";
        const dailySyncTime = typeof connection.daily_sync_time === "string" ? connection.daily_sync_time : "02:00";
        if (connectionStatus !== "ACTIVE" || local.time < dailySyncTime) continue;
        const state = await store.getSyncState(String(connection.id));
        if (state?.lastScheduledLocalDate === local.date) continue;
        await runtime.enqueueJob(SYSTEM_ACTOR, {
          type: "FEISHU_SYNC", lane: "NETWORK", payload: { connectorId: String(connection.id), trigger: state?.lastSuccessAt ? "SCHEDULED" : "STARTUP_CATCHUP" },
          dedupeKey: `feishu-daily:${String(connection.id)}:${local.date}`,
        }).catch(() => undefined);
      }
    };
    const safeCheck = (): void => {
      if (this.schedulerRunning) return; this.schedulerRunning = true;
      void check().catch((error: unknown) => {
        console.error(`Phase 2 scheduler failed: ${error instanceof Error ? error.name : "UnknownError"}`);
      }).finally(() => { this.schedulerRunning = false; });
    };
    safeCheck(); this.scheduler = setInterval(safeCheck, 60_000);
  }

  async syncFeishu(actor: ActorSnapshot, connectorId: string, trigger: "SCHEDULED" | "MANUAL" | "STARTUP_CATCHUP" | "RECONCILIATION", signal?: AbortSignal, allowCursorRestart = true): Promise<Record<string, unknown>> {
    const { service, store } = this.acquisition(actor, signal); const connector = asConnectorId(connectorId);
    const config = await store.get(connector); if (!config) throw new Error("FEISHU_CONNECTION_NOT_FOUND");
    const state = await store.getSyncState(connectorId); const nowMs = Date.now();
    const initial = Date.parse(config.initialLookbackFrom); const high = state?.highWatermarkMs ? Number(state.highWatermarkMs) : initial;
    const runningBatch = await store.findRunningBatch(connectorId);
    const startMs = runningBatch?.windowStartMs ?? String(Math.max(initial, high - config.overlapHours * 60 * 60_000));
    const endMs = runningBatch?.windowEndMs ?? String(nowMs);
    const batchId = runningBatch?.id ?? await store.startBatch(connectorId, trigger, startMs, endMs);
    try {
      const configuredResumeIndex = state?.inFlightApprovalCode
        ? config.approvalCodes.findIndex((code) => code === state.inFlightApprovalCode) : -1;
      const resumeIndex = Math.max(0, configuredResumeIndex);
      for (let approvalIndex = resumeIndex; approvalIndex < config.approvalCodes.length; approvalIndex += 1) {
        const approvalCode = config.approvalCodes[approvalIndex]!;
        let pageToken = state?.inFlightApprovalCode === approvalCode ? state.inFlightPageToken : undefined;
        await store.savePageCheckpoint(connectorId, batchId, approvalCode, pageToken);
        do {
          const page = await service.discoverApproved(connector, { approvalCode, startTime: startMs, endTime: endMs, pageSize: 100, ...(pageToken ? { pageToken } : {}) });
          for (const instance of page.items) {
            const remoteHash = canonicalInstanceHash(instance);
            await store.recordDiscovered(batchId, connectorId, instance, remoteHash);
            await service.archiveApproved(connector, instance);
          }
          pageToken = page.nextPageToken;
          const nextApprovalCode = pageToken ? approvalCode : config.approvalCodes[approvalIndex + 1];
          await store.savePageCheckpoint(connectorId, batchId, nextApprovalCode, pageToken);
        } while (pageToken);
      }
      const tracked = await store.trackedInstanceCodes(connectorId, state?.reconciliationCursor);
      const reconciled = await service.reconcileTracked(connector, tracked);
      for (const result of reconciled) {
        await store.recordReconciliation(connectorId, result);
        if (result.tombstone) await this.evidence.tombstoneSourceTree(actor, result.instanceCode, `${result.status}:${endMs}`);
      }
      const lastTracked = tracked.at(-1); if (lastTracked) await store.advanceReconciliationCursor(connectorId, lastTracked);
      const counts = await store.batchCounts(batchId); const status = counts.failed === 0 ? "SUCCEEDED" : "PARTIAL";
      await store.completeBatch(batchId, status, counts);
      await store.advanceSyncState(connectorId, endMs, zonedDateTime(new Date(), config.timeZone).date);
      return { batchId, status, ...counts, reconciled: reconciled.length };
    } catch (error: unknown) {
      const cursorMayBeExpired = allowCursorRestart && Boolean(state?.inFlightPageToken) && error instanceof ConnectorRequestError
        && error.failure.category === "PERMANENT" && (error.failure.code === "FEISHU_HTTP_400" || error.failure.code.startsWith("FEISHU_API_"));
      if (cursorMayBeExpired) {
        await store.savePageCheckpoint(connectorId, batchId, config.approvalCodes[0], undefined);
        return this.syncFeishu(actor, connectorId, trigger, signal, false);
      }
      const counts = await store.batchCounts(batchId);
      if (error instanceof ConnectorRequestError && error.failure.category === "REAUTH_REQUIRED") {
        await store.markReauthRequired(connectorId, error.failure.code);
        await store.completeBatch(batchId, "REAUTH_REQUIRED", { archived: counts.archived, failed: counts.failed + 1 }, undefined, error.failure.code);
      } else if (!(error instanceof ConnectorRequestError && error.failure.retryable)) {
        await store.completeBatch(batchId, "FAILED", { archived: counts.archived, failed: counts.failed + 1 }, undefined, error instanceof Error ? error.message.slice(0, 120) : "FEISHU_SYNC_FAILED").catch(() => undefined);
      }
      throw error;
    }
  }

  private async requireEvidence(id: string, kind: "BANK_STATEMENT" | "INVOICE"): Promise<Record<string, unknown>> {
    const evidence = await this.evidence.get(id);
    if (!evidence || String(evidence.kind) !== kind || String(evidence.status) !== "AVAILABLE") throw new Error("EVIDENCE_NOT_AVAILABLE");
    return evidence;
  }

  private async inParserLane<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.parserTail; let release!: () => void;
    this.parserTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); }
    finally { release(); }
  }
}
