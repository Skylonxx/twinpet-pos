// Packet 5 / P5-B pure core — frozen contract types only.
//
// Server-owned, pure, deterministic types for the shift-close validation
// contract frozen across the P5-A architecture report and its R1-R5
// remediation addenda. This module declares no runtime behavior: no
// Firebase Admin SDK, no Firestore, no network, no environment reads.
//
// Frozen sources (OneDrive Ai-Report\twinpet-pos, read-only inputs to this
// implementation — not shipped, referenced for maintainers only):
//   Architect\twinpet-p1-offline-sync-packet-5-p5-a-contract-remediation-architecture-report.md
//   Architect\twinpet-p1-offline-sync-packet-5-p5-a{,-r2,-r3,-r4,-r5}-contract-remediation-addendum.md

// ---------------------------------------------------------------------------
// Contract F — four independent state dimensions (P5-A §13, restored
// verbatim by R3 §8.1 after R2's incompatible rewrite; `requires_operator_review`
// added by R1 §10.5 / R3 §8.1; no resting `superseded` value anywhere).
// ---------------------------------------------------------------------------

export type ProcessingState =
  | 'queued'
  | 'awaiting_dependencies'
  | 'validating'
  | 'validated'
  | 'retryable_error'
  | 'permanently_unverifiable'
  | 'requires_operator_review';

export const PROCESSING_STATES: readonly ProcessingState[] = [
  'queued',
  'awaiting_dependencies',
  'validating',
  'validated',
  'retryable_error',
  'permanently_unverifiable',
  'requires_operator_review',
];

export type ValidationVerdict =
  | 'match'
  | 'discrepancy'
  | 'identity_mismatch'
  | 'insufficient_evidence'
  | 'invalid_payload';

export const VALIDATION_VERDICTS: readonly ValidationVerdict[] = [
  'match',
  'discrepancy',
  'identity_mismatch',
  'insufficient_evidence',
  'invalid_payload',
];

export type SettlementState =
  | 'unsettled'
  | 'provisional_match'
  | 'manual_review_required'
  | 'manually_resolved';

export const SETTLEMENT_STATES: readonly SettlementState[] = [
  'unsettled',
  'provisional_match',
  'manual_review_required',
  'manually_resolved',
];

export type AlertState = 'none' | 'open' | 'acknowledged' | 'resolved';

export const ALERT_STATES: readonly AlertState[] = ['none', 'open', 'acknowledged', 'resolved'];

// ---------------------------------------------------------------------------
// errorClassification — narrow 5-value run cause enum (P5-A R3 §8.1 / R4 §8.1).
// Non-null iff validationVerdict === 'insufficient_evidence'; ALWAYS null for
// 'invalid_payload', 'match', 'discrepancy', 'identity_mismatch'. This enum is
// never widened to include 'invalid_payload' (P5-A R5 §7.1 — the alert/audit
// reason union is a separate, wider type: AlertReasonCode below).
// ---------------------------------------------------------------------------

export type ErrorClassification =
  | 'source_limit_exceeded'
  | 'cash_entry_malformed'
  | 'legacy_missing_required_field'
  | 'dependency_unavailable'
  | 'cash_pair_value_mismatch';

export const ERROR_CLASSIFICATIONS: readonly ErrorClassification[] = [
  'source_limit_exceeded',
  'cash_entry_malformed',
  'legacy_missing_required_field',
  'dependency_unavailable',
  'cash_pair_value_mismatch',
];

export function isValidErrorClassification(value: unknown): value is ErrorClassification {
  return typeof value === 'string' && (ERROR_CLASSIFICATIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// AlertReasonCode — standalone 10-value alert/audit reason union (P5-A R5
// §7.1). A strict superset of ErrorClassification's five values, PLUS five
// reasons that are never a run errorClassification: 'invalid_payload' (whose
// run errorClassification stays null) and the four non-insufficient_evidence
// alert reasons. This is a deliberately separate type — never derive it from
// ErrorClassification, never widen ErrorClassification to include it.
// ---------------------------------------------------------------------------

export type AlertReasonCode =
  | ErrorClassification
  | 'invalid_payload'
  | 'drawer_discrepancy'
  | 'identity_mismatch'
  | 'retry_exhausted'
  | 'superseding_match';

export const ALERT_REASON_CODES: readonly AlertReasonCode[] = [
  'source_limit_exceeded',
  'cash_entry_malformed',
  'legacy_missing_required_field',
  'dependency_unavailable',
  'cash_pair_value_mismatch',
  'invalid_payload',
  'drawer_discrepancy',
  'identity_mismatch',
  'retry_exhausted',
  'superseding_match',
];

export function isValidAlertReasonCode(value: unknown): value is AlertReasonCode {
  return typeof value === 'string' && (ALERT_REASON_CODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Alert actor (P5-A R4 §8.3) — discriminated, no fabricated manager UID for
// system actions. Acknowledgement is always manager; resolution is system or
// manager.
// ---------------------------------------------------------------------------

export type AlertActor = { kind: 'system' } | { kind: 'manager'; managerUid: string };

// ---------------------------------------------------------------------------
// Cash-entry snapshot types (P5-A Blocker 1 / R2 §7.1 / R3 §7.1-§7.4).
// `amount` is the raw Baht `number` verbatim from `ShiftCashEntry`
// (types.ts:806-815) — never transformed at rest. Canonical minor-unit
// amounts are derived only by shiftCloseValidationCore's conversion helpers.
// ---------------------------------------------------------------------------

export type CashEntryType = 'pay_in' | 'pay_out';

export interface ShiftCashEntrySnapshot {
  id: unknown; // verbatim from the shift doc — validated by classifyCashEntry, may be malformed
  type: unknown;
  amount: unknown;
  note: unknown;
  staffId: unknown;
  staffName: unknown;
  at: unknown;
}

// Class A — fold-blocking (any occurrence forces the run to
// `insufficient_evidence`; never `match`, never an independent `discrepancy`).
export type CashEntryFoldBlockingReason =
  | 'id_missing'
  | 'id_duplicate'
  | 'type_unknown'
  | 'non_finite_amount'
  | 'non_positive_amount'
  | 'amount_over_bound'
  | 'amount_precision';

export const CASH_ENTRY_FOLD_BLOCKING_REASONS: readonly CashEntryFoldBlockingReason[] = [
  'id_missing',
  'id_duplicate',
  'type_unknown',
  'non_finite_amount',
  'non_positive_amount',
  'amount_over_bound',
  'amount_precision',
];

export interface CashEntriesSnapshotMeta {
  count: number; // STORED snapshot length == min(sourceEntryCount, CAP_SNAPSHOT_ENTRIES)
  capturedFrom: 'shifts.cashEntries';
  foldBlockingCount: number;
  softFlagCount: number;
  firstFoldBlockingReason: CashEntryFoldBlockingReason | null;
  sourceEntryCount: number; // [P5-A R4-D1] full raw array length at capture
  // [P5-A R4 §7.1] `cashEntriesOverflowed` REPLACES the superseded bare `truncated` name
  // (== sourceEntryCount > CAP_SNAPSHOT_ENTRIES). The old `truncated` field is not carried.
  cashEntriesOverflowed: boolean;
}

// ---------------------------------------------------------------------------
// Cash-pair classification (P5-A R4-D6 / R5 preserved).
// ---------------------------------------------------------------------------

export type CashPairClass = 'paired_equal' | 'paired_value_mismatch' | 'missing_cashTransaction' | 'missing_cashEntry';

export type CashPairMismatchField = 'type' | 'amount';

export interface CashPairClassificationEntry {
  id: string;
  class: CashPairClass;
  mismatchFields?: readonly CashPairMismatchField[]; // present iff class === 'paired_value_mismatch'
}

// ---------------------------------------------------------------------------
// Source manifest types (P5-A R1 §9.5 / R2 §8.2-§8.3 / R3 §8.3).
// ---------------------------------------------------------------------------

export type ManifestCollection = 'asyncOrders' | 'cashTransactions' | 'creditPayments' | 'orders';

// Frozen collection enum order for manifest doc sorting (R2 §8.2).
export const MANIFEST_COLLECTION_ORDER: readonly ManifestCollection[] = [
  'asyncOrders',
  'cashTransactions',
  'creditPayments',
  'orders',
];

export interface SourceManifestDoc {
  collection: ManifestCollection;
  docId: string;
  updateTimeMicros: string; // decimal string, BigInt-compared
  relevantFieldsDigest: string; // sha256 hex
}

export interface SourceManifestCapReachedBySource {
  asyncOrders: boolean;
  cashTransactions: boolean;
  creditPayments: boolean;
  orders: boolean;
}

export interface SourceManifest {
  docs: readonly SourceManifestDoc[];
  pages: number;
  truncated: boolean;
  capReachedBySource: SourceManifestCapReachedBySource;
  snapshotConsistency: 'txn' | 'paged';
  computedAtCommitMicros: string;
}

// ---------------------------------------------------------------------------
// Envelope constants (P5-A R3 §7.2).
// ---------------------------------------------------------------------------

export const CAP_SNAPSHOT_ENTRIES = 1000;
export const MAX_ENTRY_BAHT = 10_000_000;
export const MAX_TOTAL_BAHT = 10_000_000_000;

// No `complete_proven` / final-settlement type is declared anywhere in this
// module by design — Packet 5 pure core never represents final settlement.
