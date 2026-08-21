import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, link, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import type { ActorSnapshot, DatabasePort, WriteCommand } from "@agent-voucher/shared-kernel";
import { newId, nowIso, requireRole } from "@agent-voucher/shared-kernel";
import type {
  EvidenceIngestInput, EvidenceIngestPort, EvidenceIngestResult, EvidenceKind, EvidenceObjectReference,
} from "./types.js";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const QUARANTINE_MS = 7 * 24 * 60 * 60_000;
const HEADER_BYTES = 8192;

interface EvidencePaths {
  root: string;
  objects: string;
  staging: string;
  quarantine: string;
}

interface StoredFile {
  hash: string;
  byteSize: number;
  mediaType: string;
  relativePath: string;
  physicalDuplicate: boolean;
}

function evidenceCommand(
  actor: ActorSnapshot,
  action: string,
  objectType: string,
  objectId: string,
  statements: WriteCommand["statements"],
  metadata: Record<string, string | number | boolean | null> = {},
  idempotencyKey?: string,
): WriteCommand {
  return {
    commandId: newId(), commandType: action, commandVersion: 1, correlationId: newId(), actor,
    ...(idempotencyKey ? { idempotencyKey } : {}), statements,
    audit: { action, objectType, objectId, beforeRevision: null, afterRevision: 1, result: "SUCCESS", metadata },
  };
}

function safeOriginalName(value: string): string {
  const name = [...basename(value).normalize("NFC")].map((character) => {
    const code = character.codePointAt(0) ?? 0; return code <= 31 || code === 127 ? "_" : character;
  }).join("").slice(0, 240);
  return name || "unnamed";
}

function allowedExtensions(kind: EvidenceKind): readonly string[] {
  switch (kind) {
    case "BANK_STATEMENT": return [".xls", ".xlsx", ".csv"];
    case "INVOICE": return [".pdf"];
    case "CONTRACT_FILE": return [".pdf", ".docx", ".jpg", ".jpeg", ".png"];
    case "APPROVAL": return [".json"];
  }
}

function mediaType(kind: EvidenceKind, name: string, header: Uint8Array): string | undefined {
  const extension = extname(name).toLowerCase();
  if (!allowedExtensions(kind).includes(extension)) return undefined;
  const hex = Buffer.from(header.subarray(0, 8)).toString("hex");
  const text = Buffer.from(header).toString("utf8");
  if (extension === ".pdf" && text.startsWith("%PDF-")) return "application/pdf";
  if (extension === ".xls" && hex.startsWith("d0cf11e0a1b11ae1")) return "application/vnd.ms-excel";
  if ([".xlsx", ".docx"].includes(extension) && hex.startsWith("504b0304")) {
    return extension === ".xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if ([".jpg", ".jpeg"].includes(extension) && hex.startsWith("ffd8ff")) return "image/jpeg";
  if (extension === ".png" && hex.startsWith("89504e470d0a1a0a")) return "image/png";
  if (extension === ".csv" && !header.includes(0)) return "text/csv";
  if (extension === ".json" && ["[", "{"].some((prefix) => text.trimStart().startsWith(prefix))) return "application/json";
  return undefined;
}

function declaredTypeMatches(declared: string | undefined, detected: string): boolean {
  if (!declared) return true;
  const normalized = declared.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (["", "application/octet-stream", detected.toLowerCase()].includes(normalized)) return true;
  return detected === "text/csv" && ["text/plain", "application/csv", "application/vnd.ms-excel"].includes(normalized);
}

function inside(root: string, candidate: string): boolean {
  const relative = resolve(candidate).slice(resolve(root).length);
  return relative === "" || relative.startsWith(sep);
}

export class EvidenceVaultService implements EvidenceIngestPort {
  private readonly paths: EvidencePaths;

  constructor(private readonly db: DatabasePort, dataDir: string) {
    const root = join(resolve(dataDir), "evidence");
    this.paths = { root, objects: join(root, "objects", "sha256"), staging: join(root, "staging"), quarantine: join(root, "quarantine") };
  }

  async start(): Promise<void> {
    await Promise.all([this.paths.root, this.paths.objects, this.paths.staging, this.paths.quarantine]
      .map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  }

  async ingest(input: EvidenceIngestInput): Promise<EvidenceIngestResult> {
    requireRole(input.actor, "ADMIN", "OPERATOR");
    const replay = await this.findOccurrence(input.idempotencyKey);
    if (replay) return replay;
    const originalName = safeOriginalName(input.originalName);
    const staged = join(this.paths.staging, `${randomUUID()}.part`);
    if (!inside(this.paths.staging, staged)) throw new Error("INVALID_STAGING_PATH");
    const file = await open(staged, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0; let header = Buffer.alloc(0);
    try {
      for await (const rawChunk of input.chunks) {
        const chunk = Buffer.from(rawChunk);
        size += chunk.byteLength;
        if (size > MAX_FILE_BYTES) throw new Error("FILE_TOO_LARGE");
        if (header.byteLength < HEADER_BYTES) header = Buffer.concat([header, chunk.subarray(0, HEADER_BYTES - header.byteLength)]);
        hash.update(chunk);
        await file.write(chunk);
      }
      await file.sync();
    } catch (error: unknown) {
      await file.close().catch(() => undefined); await rm(staged, { force: true });
      return this.recordQuarantine(input.actor, input.kind, originalName, undefined, size, error instanceof Error ? error.message : "UPLOAD_FAILED");
    }
    await file.close();
    const detectedMediaType = mediaType(input.kind, originalName, header);
    if (!detectedMediaType) {
      const quarantinePath = join(this.paths.quarantine, `${randomUUID()}.bin`);
      await rename(staged, quarantinePath);
      return this.recordQuarantine(input.actor, input.kind, originalName, quarantinePath, size, "UNSUPPORTED_OR_SPOOFED_FILE_TYPE");
    }
    if (!declaredTypeMatches(input.declaredMediaType, detectedMediaType)) {
      const quarantinePath = join(this.paths.quarantine, `${randomUUID()}.bin`); await rename(staged, quarantinePath);
      return this.recordQuarantine(input.actor, input.kind, originalName, quarantinePath, size, "DECLARED_MEDIA_TYPE_MISMATCH");
    }

    const stored = await this.publish(staged, hash.digest("hex"), size, detectedMediaType);
    return this.recordEvidence(input, originalName, stored);
  }

  async list(limit = 100): Promise<Record<string, unknown>[]> {
    return this.db.read({
      sql: `SELECT e.id, e.kind, e.status, e.revision, e.created_at, r.id AS revision_id, r.original_name,
                   r.media_type, r.byte_size, r.content_hash, r.source_kind, r.source_ref, r.created_at AS revision_created_at
            FROM evd_evidence e JOIN evd_revision r ON r.evidence_id = e.id
            WHERE r.revision_no = (SELECT max(r2.revision_no) FROM evd_revision r2 WHERE r2.evidence_id = e.id)
            ORDER BY e.created_at DESC LIMIT ?`, params: [limit], mode: "all",
    });
  }

  async get(id: string): Promise<Record<string, unknown> | undefined> {
    return this.db.read({
      sql: `SELECT e.*, r.id AS revision_id, r.original_name, r.media_type, r.byte_size, r.content_hash,
                   r.source_kind, r.source_ref, r.source_revision, o.relative_path
            FROM evd_evidence e JOIN evd_revision r ON r.evidence_id = e.id
            JOIN evd_content_object o ON o.hash = r.content_hash
            WHERE e.id = ? ORDER BY r.revision_no DESC LIMIT 1`, params: [id], mode: "get",
    });
  }

  revisionHistory(id: string): Promise<Record<string, unknown>[]> {
    return this.db.read({
      sql: `SELECT r.*, o.relative_path FROM evd_revision r JOIN evd_content_object o ON o.hash = r.content_hash
            WHERE r.evidence_id = ? ORDER BY r.revision_no DESC`, params: [id], mode: "all",
    });
  }

  sourceHistory(id: string): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: "SELECT * FROM evd_source_link WHERE evidence_id = ? ORDER BY observed_at DESC", params: [id], mode: "all" });
  }

  async evidenceIdForSource(sourceKind: "LOCAL_UPLOAD" | "FEISHU", sourceRef: string): Promise<string | undefined> {
    const row = await this.db.read<{ evidence_id: string } | undefined>({
      sql: "SELECT evidence_id FROM evd_source_link WHERE source_kind = ? AND source_ref = ? ORDER BY observed_at LIMIT 1",
      params: [sourceKind, sourceRef], mode: "get",
    });
    return row?.evidence_id;
  }

  async tombstoneSource(actor: ActorSnapshot, sourceRef: string, sourceRevision: string): Promise<string | undefined> {
    const row = await this.db.read<Record<string, unknown> | undefined>({
      sql: `SELECT e.id AS evidence_id, e.revision, r.content_hash, r.original_name, r.media_type, r.byte_size
            FROM evd_evidence e JOIN evd_revision r ON r.evidence_id = e.id
            JOIN evd_source_link l ON l.evidence_id = e.id
            WHERE l.source_kind = 'FEISHU' AND l.source_ref = ? ORDER BY r.revision_no DESC LIMIT 1`,
      params: [sourceRef], mode: "get",
    });
    if (!row) return undefined;
    const revisionId = newId(); const timestamp = nowIso(); const revisionNo = Number(row.revision) + 1;
    await this.db.write(evidenceCommand(actor, "EVIDENCE_TOMBSTONED", "evidence", String(row.evidence_id), [
      { sql: `INSERT INTO evd_revision(id, evidence_id, revision_no, content_hash, source_kind, original_name, media_type,
              byte_size, status, source_ref, source_revision, created_by, created_at)
              VALUES (?, ?, ?, ?, 'FEISHU', ?, ?, ?, 'TOMBSTONE', ?, ?, ?, ?)`, params: [
        revisionId, String(row.evidence_id), revisionNo, String(row.content_hash), String(row.original_name), String(row.media_type),
        Number(row.byte_size), sourceRef, sourceRevision, actor.userId, timestamp,
      ] },
      { sql: "UPDATE evd_evidence SET status = 'TOMBSTONED', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
        params: [timestamp, String(row.evidence_id), Number(row.revision)], expectChanges: 1 },
      { sql: `INSERT OR IGNORE INTO evd_source_link(id, evidence_id, source_kind, source_ref, source_revision, observed_at)
              VALUES (?, ?, 'FEISHU', ?, ?, ?)`, params: [newId(), String(row.evidence_id), sourceRef, sourceRevision, timestamp] },
    ], { sourceKind: "FEISHU", sourceRevision }));
    return revisionId;
  }

  async tombstoneSourceTree(actor: ActorSnapshot, rootSourceRef: string, sourceRevision: string): Promise<number> {
    const rows = await this.db.read<Array<{ source_ref: string }>>({
      sql: `SELECT DISTINCT source_ref FROM evd_source_link WHERE source_kind = 'FEISHU'
            AND (source_ref = ? OR source_ref LIKE ? ESCAPE '\\') ORDER BY source_ref`,
      params: [rootSourceRef, `${rootSourceRef.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}:%`], mode: "all",
    });
    let count = 0;
    for (const row of rows) if (await this.tombstoneSource(actor, row.source_ref, `${sourceRevision}:${row.source_ref}`)) count += 1;
    return count;
  }

  async objectReference(id: string): Promise<EvidenceObjectReference | undefined> {
    const row = await this.get(id);
    if (!row) return undefined;
    return { hash: String(row.content_hash), relativePath: String(row.relative_path), byteSize: Number(row.byte_size), mediaType: String(row.media_type) };
  }

  objectPath(relativePath: string): string {
    const candidate = join(this.paths.root, relativePath);
    if (!inside(this.paths.root, candidate)) throw new Error("EVIDENCE_PATH_ESCAPE");
    return candidate;
  }

  async verifiedObjectPath(id: string): Promise<string> {
    const reference = await this.objectReference(id); if (!reference) throw new Error("EVIDENCE_NOT_FOUND");
    const path = this.objectPath(reference.relativePath); const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    if (hash.digest("hex") !== reference.hash) throw new Error("EVIDENCE_CONTENT_HASH_MISMATCH");
    return path;
  }

  listQuarantine(limit = 100): Promise<Record<string, unknown>[]> {
    return this.db.read({ sql: "SELECT * FROM evd_quarantine ORDER BY created_at DESC LIMIT ?", params: [limit], mode: "all" });
  }

  async purgeExpired(actor: ActorSnapshot, now = new Date()): Promise<number> {
    requireRole(actor, "ADMIN");
    const rows = await this.db.read<Record<string, unknown>[]>({
      sql: "SELECT * FROM evd_quarantine WHERE status = 'ACTIVE' AND expires_at <= ?", params: [now.toISOString()], mode: "all",
    });
    let purged = 0;
    for (const row of rows) {
      const relativePath = typeof row.relative_path === "string" ? row.relative_path : undefined;
      if (relativePath) await rm(this.objectPath(relativePath), { force: true });
      await this.db.write(evidenceCommand(actor, "QUARANTINE_PURGED", "quarantine", String(row.id), [{
        sql: "UPDATE evd_quarantine SET status = 'PURGED', purged_at = ? WHERE id = ? AND status = 'ACTIVE'",
        params: [nowIso(), String(row.id)], expectChanges: 1,
      }]));
      purged += 1;
    }
    return purged;
  }

  async purgeQuarantine(actor: ActorSnapshot, id: string): Promise<void> {
    requireRole(actor, "ADMIN");
    const row = await this.db.read<Record<string, unknown> | undefined>({
      sql: "SELECT * FROM evd_quarantine WHERE id = ? AND status = 'ACTIVE'", params: [id], mode: "get",
    });
    if (!row) throw new Error("QUARANTINE_NOT_FOUND");
    if (typeof row.relative_path === "string") await rm(this.objectPath(row.relative_path), { force: true });
    await this.db.write(evidenceCommand(actor, "QUARANTINE_PURGED", "quarantine", id, [{
      sql: "UPDATE evd_quarantine SET status = 'PURGED', purged_at = ? WHERE id = ? AND status = 'ACTIVE'",
      params: [nowIso(), id], expectChanges: 1,
    }]));
  }

  private async publish(staged: string, contentHash: string, byteSize: number, detectedMediaType: string): Promise<StoredFile> {
    const relativePath = join("objects", "sha256", contentHash.slice(0, 2), contentHash);
    const destination = join(this.paths.root, relativePath);
    await mkdir(join(this.paths.objects, contentHash.slice(0, 2)), { recursive: true, mode: 0o700 });
    let physicalDuplicate = false;
    try { await link(staged, destination); await chmod(destination, 0o400); await rm(staged, { force: true }); }
    catch (error: unknown) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      physicalDuplicate = true; await rm(staged, { force: true });
      const existing = await stat(destination);
      if (existing.size !== byteSize) throw new Error("CONTENT_HASH_COLLISION_SIZE_MISMATCH");
    }
    return { hash: contentHash, byteSize, mediaType: detectedMediaType, relativePath, physicalDuplicate };
  }

  private async findOccurrence(idempotencyKey: string): Promise<EvidenceIngestResult | undefined> {
    const row = await this.db.read<Record<string, unknown> | undefined>({
      sql: `SELECT i.status, i.evidence_id, i.revision_id, i.content_hash, i.duplicate_of_evidence_id,
                   o.byte_size, o.media_type
            FROM evd_import_occurrence i JOIN evd_content_object o ON o.hash = i.content_hash
            WHERE i.idempotency_key = ?`, params: [idempotencyKey], mode: "get",
    });
    if (!row) return undefined;
    return {
      status: String(row.status) === "PHYSICAL_DUPLICATE" ? "PHYSICAL_DUPLICATE" : "STORED",
      evidenceId: String(row.evidence_id), revisionId: String(row.revision_id), contentHash: String(row.content_hash),
      byteSize: Number(row.byte_size), mediaType: String(row.media_type),
      ...(typeof row.duplicate_of_evidence_id === "string" ? { duplicateOfEvidenceId: row.duplicate_of_evidence_id } : {}),
    };
  }

  private async recordEvidence(input: EvidenceIngestInput, originalName: string, stored: StoredFile): Promise<EvidenceIngestResult> {
    const timestamp = nowIso(); const evidenceId = input.evidenceId ?? newId(); const revisionId = newId(); const occurrenceId = newId();
    const current = input.evidenceId ? await this.db.read<{ revision: number } | undefined>({
      sql: "SELECT revision FROM evd_evidence WHERE id = ?", params: [input.evidenceId], mode: "get",
    }) : undefined;
    const duplicate = await this.db.read<{ evidence_id: string } | undefined>({
      sql: "SELECT evidence_id FROM evd_import_occurrence WHERE content_hash = ? ORDER BY created_at LIMIT 1", params: [stored.hash], mode: "get",
    });
    const revisionNo = (current?.revision ?? 0) + 1;
    const occurrenceStatus = duplicate || stored.physicalDuplicate ? "PHYSICAL_DUPLICATE" : "STORED";
    const statements: WriteCommand["statements"] = [
      { sql: "INSERT OR IGNORE INTO evd_content_object(hash, byte_size, media_type, relative_path, created_at) VALUES (?, ?, ?, ?, ?)", params: [stored.hash, stored.byteSize, stored.mediaType, stored.relativePath, timestamp] },
      ...(current
        ? [{ sql: "UPDATE evd_evidence SET status = 'AVAILABLE', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?", params: [timestamp, evidenceId, current.revision], expectChanges: 1 }]
        : [{ sql: "INSERT INTO evd_evidence(id, kind, status, revision, created_at, updated_at) VALUES (?, ?, 'AVAILABLE', 1, ?, ?)", params: [evidenceId, input.kind, timestamp, timestamp] }]),
      { sql: `INSERT INTO evd_revision(id, evidence_id, revision_no, content_hash, source_kind, original_name, media_type,
              byte_size, status, source_ref, source_revision, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, ?, ?, ?)`, params: [
        revisionId, evidenceId, revisionNo, stored.hash, input.sourceKind, originalName, stored.mediaType,
        stored.byteSize, input.sourceRef ?? null, input.sourceRevision ?? null, input.actor.userId, timestamp,
      ] },
      { sql: `INSERT INTO evd_import_occurrence(id, evidence_id, revision_id, content_hash, duplicate_of_evidence_id,
              source_kind, source_ref, idempotency_key, status, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [
        occurrenceId, evidenceId, revisionId, stored.hash, duplicate?.evidence_id ?? null, input.sourceKind,
        input.sourceRef ?? null, input.idempotencyKey, occurrenceStatus, input.actor.userId, timestamp,
      ] },
      ...(input.sourceRef ? [{ sql: `INSERT OR IGNORE INTO evd_source_link(id, evidence_id, source_kind, source_ref, source_revision, observed_at)
        VALUES (?, ?, ?, ?, ?, ?)`, params: [newId(), evidenceId, input.sourceKind, input.sourceRef, input.sourceRevision ?? null, timestamp] }] : []),
    ];
    await this.db.write(evidenceCommand(input.actor, "EVIDENCE_INGESTED", "evidence", evidenceId, statements, {
      kind: input.kind, sourceKind: input.sourceKind, contentHash: stored.hash, byteSize: stored.byteSize,
      physicalDuplicate: occurrenceStatus === "PHYSICAL_DUPLICATE",
    }, `evidence-ingest:${input.idempotencyKey}`));
    return {
      status: occurrenceStatus, evidenceId, revisionId, contentHash: stored.hash, byteSize: stored.byteSize,
      mediaType: stored.mediaType, ...(duplicate ? { duplicateOfEvidenceId: duplicate.evidence_id } : {}),
    };
  }

  private async recordQuarantine(
    actor: ActorSnapshot, kind: EvidenceKind, originalName: string, absolutePath: string | undefined, byteSize: number, reason: string,
  ): Promise<EvidenceIngestResult> {
    const id = newId(); const timestamp = nowIso();
    const relativePath = absolutePath ? absolutePath.slice(this.paths.root.length + 1) : undefined;
    await this.db.write(evidenceCommand(actor, "EVIDENCE_QUARANTINED", "quarantine", id, [{
      sql: `INSERT INTO evd_quarantine(id, kind, original_name, relative_path, reason, byte_size, status, expires_at, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`, params: [
        id, kind, originalName, relativePath ?? null, reason, byteSize,
        new Date(Date.now() + QUARANTINE_MS).toISOString(), actor.userId, timestamp,
      ],
    }], { kind, reason, byteSize }));
    return { status: "QUARANTINED", quarantineId: id, reason };
  }
}
