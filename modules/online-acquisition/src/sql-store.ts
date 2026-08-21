import type { ActorSnapshot, DatabasePort, SqlStatement, WriteCommand } from "@agent-voucher/shared-kernel";
import { newId, nowIso } from "@agent-voucher/shared-kernel";
import type { ConnectionConfigStore, SourceArchivePort } from "./contracts.js";
import { FeishuConnectionConfigSchema } from "./schemas.js";
import type { ArchivedSourceItem, FeishuConnectionConfig, FeishuInstance, InstanceCode, ReconciliationResult } from "./types.js";

function command(actor: ActorSnapshot, action: string, objectType: string, objectId: string, statements: readonly SqlStatement[], metadata: Record<string, string | number | boolean | null> = {}): WriteCommand {
  return {
    commandId: newId(), commandType: action, commandVersion: 1, correlationId: newId(), actor, statements,
    audit: { action, objectType, objectId, beforeRevision: null, afterRevision: null, result: "SUCCESS", metadata },
  };
}

export class OnlineAcquisitionSqlStore implements ConnectionConfigStore, SourceArchivePort {
  constructor(private readonly db: DatabasePort, private readonly actor: ActorSnapshot) {}

  async save(config: FeishuConnectionConfig, expectedRevision?: number): Promise<FeishuConnectionConfig> {
    const parsed = FeishuConnectionConfigSchema.parse(config); const timestamp = nowIso();
    const exists = await this.db.read<{ revision: number } | undefined>({ sql: "SELECT revision FROM conn_connector WHERE id = ?", params: [parsed.connectorId], mode: "get" });
    const statements: SqlStatement[] = exists ? [
      { sql: `UPDATE conn_connector SET display_name = ?, status = ?, secret_ref = ?, revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ?`, params: [parsed.displayName, parsed.status, parsed.secretReference, timestamp, parsed.connectorId, expectedRevision ?? exists.revision], expectChanges: 1 },
      { sql: `UPDATE conn_feishu_config SET app_id = ?, approval_codes_json = ?, attachment_control_ids_json = ?,
              initial_lookback_from = ?, daily_sync_time = ?, time_zone = ?, overlap_hours = ?, platform = ? WHERE connector_id = ?`, params: [
        parsed.appId, JSON.stringify(parsed.approvalCodes), JSON.stringify(parsed.attachmentControlIds), parsed.initialLookbackFrom,
        parsed.dailySyncTime, parsed.timeZone, parsed.overlapHours, parsed.platform, parsed.connectorId,
      ], expectChanges: 1 },
    ] : [
      { sql: `INSERT INTO conn_connector(id, type, display_name, status, secret_ref, revision, created_at, updated_at)
              VALUES (?, 'FEISHU', ?, ?, ?, 1, ?, ?)`, params: [parsed.connectorId, parsed.displayName, parsed.status, parsed.secretReference, timestamp, timestamp] },
      { sql: `INSERT INTO conn_feishu_config(connector_id, app_id, approval_codes_json, attachment_control_ids_json,
              initial_lookback_from, daily_sync_time, time_zone, overlap_hours, platform) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [
        parsed.connectorId, parsed.appId, JSON.stringify(parsed.approvalCodes), JSON.stringify(parsed.attachmentControlIds),
        parsed.initialLookbackFrom, parsed.dailySyncTime, parsed.timeZone, parsed.overlapHours, parsed.platform,
      ] },
    ];
    await this.db.write(command(this.actor, "FEISHU_CONNECTION_SAVED", "connector", parsed.connectorId, statements, { approvalCodeCount: parsed.approvalCodes.length }));
    return { ...parsed, revision: exists ? exists.revision + 1 : 1 };
  }

  async get(connectorId: FeishuConnectionConfig["connectorId"]): Promise<FeishuConnectionConfig | undefined> {
    const row = await this.db.read<Record<string, unknown> | undefined>({
      sql: `SELECT c.id, c.display_name, c.status, c.secret_ref, c.revision, f.* FROM conn_connector c
            JOIN conn_feishu_config f ON f.connector_id = c.id WHERE c.id = ?`, params: [connectorId], mode: "get",
    });
    if (!row) return undefined;
    return FeishuConnectionConfigSchema.parse({
      connectorId: row.id, displayName: row.display_name, platform: row.platform, appId: row.app_id, secretReference: row.secret_ref,
      approvalCodes: JSON.parse(String(row.approval_codes_json)) as unknown,
      attachmentControlIds: JSON.parse(String(row.attachment_control_ids_json)) as unknown,
      initialLookbackFrom: row.initial_lookback_from, dailySyncTime: row.daily_sync_time, timeZone: row.time_zone,
      overlapHours: row.overlap_hours, revision: row.revision, status: row.status,
    });
  }

  list(): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: `SELECT c.id, c.display_name, c.status, c.secret_ref, c.revision, c.created_at, c.updated_at,
      f.app_id, f.approval_codes_json, f.attachment_control_ids_json, f.initial_lookback_from, f.daily_sync_time,
      f.time_zone, f.platform, f.last_success_at FROM conn_connector c JOIN conn_feishu_config f ON f.connector_id = c.id
      ORDER BY c.created_at`, mode: "all" });
  }

  listSyncBatches(limit = 100): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: "SELECT * FROM src_sync_batch ORDER BY started_at DESC LIMIT ?", params: [limit], mode: "all" });
  }

  listBatchItems(batchId: string): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: "SELECT * FROM src_source_item WHERE sync_batch_id = ? ORDER BY observed_at", params: [batchId], mode: "all" });
  }

  listBatchAttachments(batchId: string): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: `SELECT a.*, i.external_id FROM src_source_attachment a JOIN src_source_item i ON i.id = a.source_item_id
      WHERE i.sync_batch_id = ? ORDER BY i.external_id, a.control_id`, params: [batchId], mode: "all" });
  }

  getSyncState(connectorId: string): Promise<{ highWatermarkMs?: string; lastScheduledLocalDate?: string; lastSuccessAt?: string; reconciliationCursor?: string; inFlightApprovalCode?: string; inFlightPageToken?: string } | undefined> {
    return this.db.read<{ high_watermark_ms: string | null; last_scheduled_local_date: string | null; last_success_at: string | null; reconciliation_cursor_external_id: string | null; in_flight_approval_code: string | null; in_flight_page_token: string | null } | undefined>({
      sql: `SELECT high_watermark_ms, last_scheduled_local_date, last_success_at, reconciliation_cursor_external_id,
            in_flight_approval_code, in_flight_page_token FROM conn_feishu_config WHERE connector_id = ?`,
      params: [connectorId], mode: "get",
    }).then((row) => row ? {
      ...(row.high_watermark_ms ? { highWatermarkMs: row.high_watermark_ms } : {}),
      ...(row.last_scheduled_local_date ? { lastScheduledLocalDate: row.last_scheduled_local_date } : {}),
      ...(row.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
      ...(row.reconciliation_cursor_external_id ? { reconciliationCursor: row.reconciliation_cursor_external_id } : {}),
      ...(row.in_flight_approval_code ? { inFlightApprovalCode: row.in_flight_approval_code } : {}),
      ...(row.in_flight_page_token ? { inFlightPageToken: row.in_flight_page_token } : {}),
    } : undefined);
  }

  async advanceSyncState(connectorId: string, highWatermarkMs: string, localDate: string): Promise<void> {
    const timestamp = nowIso();
    await this.db.write(command(this.actor, "SOURCE_CURSOR_ADVANCED", "connector", connectorId, [{
      sql: `UPDATE conn_feishu_config SET high_watermark_ms = ?, in_flight_page_token = NULL, in_flight_approval_code = NULL,
            last_scheduled_local_date = ?, last_success_at = ? WHERE connector_id = ?`,
      params: [highWatermarkMs, localDate, timestamp, connectorId], expectChanges: 1,
    }], { localDate }));
  }

  async savePageCheckpoint(connectorId: string, batchId: string, approvalCode: string | undefined, pageToken: string | undefined): Promise<void> {
    await this.db.write(command(this.actor, "SOURCE_PAGE_CHECKPOINT_SAVED", "sync_batch", batchId, [
      { sql: "UPDATE conn_feishu_config SET in_flight_approval_code = ?, in_flight_page_token = ? WHERE connector_id = ?",
        params: [approvalCode ?? null, pageToken ?? null, connectorId], expectChanges: 1 },
      { sql: "UPDATE src_sync_batch SET page_token = ? WHERE id = ? AND status = 'RUNNING'", params: [pageToken ?? null, batchId], expectChanges: 1 },
    ], { approvalCode: approvalCode ?? null, hasPageToken: Boolean(pageToken) }));
  }

  async markDisabled(connectorId: FeishuConnectionConfig["connectorId"]): Promise<void> {
    await this.db.write(command(this.actor, "FEISHU_CONNECTION_DISABLED", "connector", connectorId, [{
      sql: "UPDATE conn_connector SET status = 'DISABLED', revision = revision + 1, updated_at = ? WHERE id = ? AND status != 'DISABLED'",
      params: [nowIso(), connectorId], expectChanges: 1,
    }]));
  }

  async markReauthRequired(connectorId: string, code: string): Promise<void> {
    await this.db.write(command(this.actor, "FEISHU_REAUTH_REQUIRED", "connector", connectorId, [{
      sql: "UPDATE conn_connector SET status = 'REAUTH_REQUIRED', revision = revision + 1, updated_at = ? WHERE id = ?",
      params: [nowIso(), connectorId], expectChanges: 1,
    }], { code }));
  }

  async startBatch(connectorId: string, triggerType: "SCHEDULED" | "MANUAL" | "STARTUP_CATCHUP" | "RECONCILIATION", startMs: string, endMs: string): Promise<string> {
    const id = newId(); await this.db.write(command(this.actor, "SOURCE_SYNC_STARTED", "sync_batch", id, [{
      sql: `INSERT INTO src_sync_batch(id, connector_id, trigger_type, status, window_start_ms, window_end_ms, started_at)
            VALUES (?, ?, ?, 'RUNNING', ?, ?, ?)`, params: [id, connectorId, triggerType, startMs, endMs, nowIso()],
    }], { triggerType })); return id;
  }

  findRunningBatch(connectorId: string): Promise<{ id: string; windowStartMs: string; windowEndMs: string } | undefined> {
    return this.db.read<{ id: string; window_start_ms: string; window_end_ms: string } | undefined>({
      sql: `SELECT id, window_start_ms, window_end_ms FROM src_sync_batch WHERE connector_id = ? AND status = 'RUNNING'
            ORDER BY started_at DESC LIMIT 1`, params: [connectorId], mode: "get",
    }).then((row) => row ? { id: row.id, windowStartMs: row.window_start_ms, windowEndMs: row.window_end_ms } : undefined);
  }

  async recordDiscovered(batchId: string, connectorId: string, instance: FeishuInstance, remoteRevisionHash: string): Promise<string> {
    const existing = await this.db.read<{ id: string; sync_batch_id: string | null; source_status: string } | undefined>({
      sql: "SELECT id, sync_batch_id, source_status FROM src_source_item WHERE connector_id = ? AND external_id = ? AND remote_revision_hash = ?",
      params: [connectorId, instance.instanceCode, remoteRevisionHash], mode: "get",
    });
    if (existing) {
      if (existing.sync_batch_id !== batchId && !["ARCHIVED", "PARTIAL"].includes(existing.source_status)) {
        await this.db.write(command(this.actor, "SOURCE_ITEM_REATTACHED", "source_item", existing.id, [
          { sql: "UPDATE src_source_item SET sync_batch_id = ? WHERE id = ?", params: [batchId, existing.id], expectChanges: 1 },
          { sql: "UPDATE src_sync_batch SET discovered_count = discovered_count + 1 WHERE id = ? AND status = 'RUNNING'", params: [batchId], expectChanges: 1 },
        ], { previousBatchId: existing.sync_batch_id }));
      }
      return existing.id;
    }
    const id = newId(); await this.db.write(command(this.actor, "SOURCE_ITEM_DISCOVERED", "source_item", id, [{
      sql: `INSERT INTO src_source_item(id, connector_id, sync_batch_id, external_id, approval_code, remote_status,
              remote_revision_hash, source_status, revision, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'DISCOVERED', 1, ?)`, params: [
        id, connectorId, batchId, instance.instanceCode, instance.approvalCode, instance.status, remoteRevisionHash, nowIso(),
      ] },
      { sql: "UPDATE src_sync_batch SET discovered_count = discovered_count + 1 WHERE id = ?", params: [batchId], expectChanges: 1 },
    ], { approvalCode: instance.approvalCode })); return id;
  }

  async recordArchived(item: ArchivedSourceItem): Promise<void> {
    const timestamp = nowIso();
    const sourceItem = await this.db.read<{ id: string; sync_batch_id: string | null; source_status: string }>({
      sql: "SELECT id, sync_batch_id, source_status FROM src_source_item WHERE external_id = ? AND remote_revision_hash = ?", params: [item.instanceCode, item.remoteRevisionHash], mode: "get",
    });
    const statements: SqlStatement[] = [];
    if (sourceItem.sync_batch_id && !["ARCHIVED", "PARTIAL"].includes(sourceItem.source_status)) statements.push({
      sql: `UPDATE src_sync_batch SET archived_count = archived_count + ?, failed_count = failed_count + ?
            WHERE id = ? AND status = 'RUNNING'`,
      params: [item.status === "ARCHIVED" ? 1 : 0, item.status === "PARTIAL" ? 1 : 0, sourceItem.sync_batch_id], expectChanges: 1,
    });
    statements.push({
      sql: `UPDATE src_source_item SET source_status = ?, form_evidence_revision_id = ?, archived_at = ?, revision = revision + 1
            , last_error_code = ? WHERE external_id = ? AND remote_revision_hash = ?`, params: [item.status, item.formEvidenceRevisionId, timestamp, item.failures.map((failure) => failure.code).join(",").slice(0, 500) || null, item.instanceCode, item.remoteRevisionHash], expectChanges: 1 },
    );
    for (const attachment of item.attachmentOutcomes) statements.push({
      sql: `INSERT OR IGNORE INTO src_source_attachment(id, source_item_id, control_id, remote_path_hash,
            evidence_revision_id, status, last_error_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [newId(), sourceItem.id, `${attachment.controlId}:${String(attachment.index)}`, attachment.remotePathHash,
        attachment.evidenceRevisionId ?? null, attachment.status, attachment.errorCode ?? null, timestamp],
    });
    await this.db.write(command(this.actor, "SOURCE_ITEM_ARCHIVED", "source_item", item.instanceCode, statements,
      { attachmentCount: item.attachmentEvidenceRevisionIds.length, failureCount: item.failures.length }));
  }

  async completeBatch(batchId: string, status: "SUCCEEDED" | "PARTIAL" | "REAUTH_REQUIRED" | "FAILED" | "CANCELED", counts: { archived: number; failed: number }, pageToken?: string, errorCode?: string): Promise<void> {
    await this.db.write(command(this.actor, "SOURCE_SYNC_COMPLETED", "sync_batch", batchId, [{
      sql: `UPDATE src_sync_batch SET status = ?, archived_count = ?, failed_count = ?, page_token = ?, last_error_code = ?, completed_at = ?
            WHERE id = ? AND status = 'RUNNING'`, params: [status, counts.archived, counts.failed, pageToken ?? null, errorCode ?? null, nowIso(), batchId], expectChanges: 1 },
    ], { status, archived: counts.archived, failed: counts.failed }));
  }

  async batchCounts(batchId: string): Promise<{ archived: number; failed: number }> {
    const row = await this.db.read<{ archived_count: number; failed_count: number }>({
      sql: "SELECT archived_count, failed_count FROM src_sync_batch WHERE id = ?", params: [batchId], mode: "get",
    });
    return { archived: row.archived_count, failed: row.failed_count };
  }

  async trackedInstanceCodes(connectorId: string, afterExternalId?: string, limit = 200): Promise<InstanceCode[]> {
    const query = async (after: string): Promise<Record<string, unknown>[]> => this.db.read({
      sql: `SELECT external_id FROM src_source_item WHERE connector_id = ? AND source_status IN ('ARCHIVED','PARTIAL')
            AND external_id > ? GROUP BY external_id ORDER BY external_id LIMIT ?`, params: [connectorId, after, limit], mode: "all",
    });
    let rows = await query(afterExternalId ?? "");
    if (rows.length === 0 && afterExternalId) rows = await query("");
    return rows.map((row) => String(row.external_id) as InstanceCode);
  }

  async advanceReconciliationCursor(connectorId: string, externalId: string): Promise<void> {
    await this.db.write(command(this.actor, "SOURCE_RECONCILIATION_CURSOR_ADVANCED", "connector", connectorId, [{
      sql: "UPDATE conn_feishu_config SET reconciliation_cursor_external_id = ? WHERE connector_id = ?",
      params: [externalId, connectorId], expectChanges: 1,
    }]));
  }

  async recordReconciliation(connectorId: string, result: ReconciliationResult): Promise<void> {
    if (!result.tombstone) return;
    await this.db.write(command(this.actor, "SOURCE_TOMBSTONED", "source_item", result.instanceCode, [{
      sql: `INSERT OR IGNORE INTO src_tombstone(id, connector_id, external_id, remote_status, observed_at)
            VALUES (?, ?, ?, ?, ?)`, params: [newId(), connectorId, result.instanceCode, result.status, nowIso()] },
      { sql: `UPDATE src_source_item SET remote_status = ?, revision = revision + 1, observed_at = ?
              WHERE connector_id = ? AND external_id = ?`, params: [result.status, nowIso(), connectorId, result.instanceCode] },
    ], { remoteStatus: result.status }));
  }
}
