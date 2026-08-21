import type { ActorSnapshot } from "@agent-voucher/shared-kernel";

export const EvidenceKinds = ["BANK_STATEMENT", "INVOICE", "CONTRACT_FILE", "APPROVAL"] as const;
export type EvidenceKind = typeof EvidenceKinds[number];

export const EvidenceSourceKinds = ["LOCAL_UPLOAD", "FEISHU"] as const;
export type EvidenceSourceKind = typeof EvidenceSourceKinds[number];

export interface EvidenceIngestInput {
  readonly evidenceId?: string;
  readonly kind: EvidenceKind;
  readonly sourceKind: EvidenceSourceKind;
  readonly originalName: string;
  readonly declaredMediaType?: string;
  readonly sourceRef?: string;
  readonly sourceRevision?: string;
  readonly idempotencyKey: string;
  readonly actor: ActorSnapshot;
  readonly chunks: AsyncIterable<Uint8Array>;
}

export type EvidenceIngestResult =
  | {
      readonly status: "STORED" | "PHYSICAL_DUPLICATE";
      readonly evidenceId: string;
      readonly revisionId: string;
      readonly contentHash: string;
      readonly byteSize: number;
      readonly mediaType: string;
      readonly duplicateOfEvidenceId?: string;
    }
  | {
      readonly status: "QUARANTINED";
      readonly quarantineId: string;
      readonly reason: string;
    };

export interface EvidenceIngestPort {
  ingest(input: EvidenceIngestInput): Promise<EvidenceIngestResult>;
}

export interface EvidenceObjectReference {
  readonly hash: string;
  readonly relativePath: string;
  readonly byteSize: number;
  readonly mediaType: string;
}
