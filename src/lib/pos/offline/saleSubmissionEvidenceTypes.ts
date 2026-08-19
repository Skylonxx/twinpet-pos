/**
 * PK-2B / R7 sale-submission evidence types.
 *
 * Compile-time opacity for `ProvenEvidenceAbsence` and `ProvenEvidencePresence`
 * lives here (type-only unique symbols). Runtime authenticity is owned
 * exclusively by `saleSubmissionEvidenceStore.ts` (module-private WeakSet).
 * This module emits no runtime exports.
 */

declare const ProvenEvidenceAbsenceBrand: unique symbol;
declare const AcquiredResumeFenceAuthorizationBrand: unique symbol;

export type ProvenEvidenceAbsence = {
  readonly [ProvenEvidenceAbsenceBrand]: true;
  kind: 'evidence_proven_absent';
  branchId: string;
  deviceId: string;
  generationId: string;
  generationSeq: number;
  storeEpochId: string;
  asyncOrderId: string;
  billId: string;
  barrierFenceSeq: number;
  barrierFenceNonce: string;
};

export type AcquiredResumeFenceAuthorization = {
  readonly [AcquiredResumeFenceAuthorizationBrand]: true;
  branchId: string;
  deviceId: string;
  generationId: string;
  generationSeq: number;
  storeEpochId: string;
  asyncOrderId: string;
  billId: string;
  fenceSeq: number;
  fenceNonce: string;
};

export type AbsenceSealAuthorityV1 = {
  kind: 'absence_seal';
  schemaVersion: 1;
  generationKey: string;
  storeEpochId: string;
  generationId: string;
  generationSeq: number;
  asyncOrderId: string;
  billId: string;
  branchId: string;
  deviceId: string;
  createdAtLocal: number;
  barrierFenceSeq: number;
  barrierFenceNonce: string;
};

declare const ProvenEvidencePresenceBrand: unique symbol;

export type ProvenEvidencePresence = {
  readonly [ProvenEvidencePresenceBrand]: true;
  kind: 'evidence_present';
  branchId: string;
  deviceId: string;
  generationId: string;
  generationSeq: number;
  storeEpochId: string;
  asyncOrderId: string;
  billId: string;
  barrierFenceSeq: number;
  barrierFenceNonce: string;
};

export type SaleSubmissionEvidenceEntryV1 = {
  kind: 'submission_evidence';
  schemaVersion: 1;
  entryKey: string;
  branchId: string;
  deviceId: string;
  generationId: string;
  generationSeq: number;
  storeEpochId: string;
  asyncOrderId: string;
  billId: string;
  createdAtLocal: number;
  barrierFenceSeq: number;
  barrierFenceNonce: string;
};

export type CommitSaleSubmissionAbsenceSealResult =
  | { ok: true; proof: ProvenEvidenceAbsence }
  | { ok: false };

export type CommitSaleSubmissionEvidenceEntryResult =
  | { ok: true; proof: ProvenEvidencePresence }
  | { ok: false };

export type ProveSaleSubmissionEvidencePresenceResult =
  | { ok: true; proof: ProvenEvidencePresence }
  | { ok: false };

export type ReleaseSaleSubmissionResumeFenceResult = { ok: true } | { ok: false };

export type ActiveCartSnapshotRecord = {
  schemaVersion: 1;
  branchId: string;
  deviceId: string;
  generationId: string;
  generationSeq: number;
  storeEpochId: string;
  asyncOrderId: string;
  billId: string;
  resumeFence: {
    held: boolean;
    fenceSeq: number;
    fenceNonce: string;
  };
  resumeAttempts: number;
  marker: 'S2';
};
