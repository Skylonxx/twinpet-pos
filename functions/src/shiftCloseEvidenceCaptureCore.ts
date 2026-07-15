// Packet 5 / P5-C-1 — pure capture planning + transaction decision core.
//
// Pure, deterministic: no Firestore reads/writes, no network. The one
// exception to "no Admin SDK" is the `Timestamp` class import, used only for
// `instanceof`/construction (a plain value type, not a live connection) —
// required by the frozen `closedAt` wrong-type detection (G7) and to produce
// `observedClosedAt`/`lateEventHorizonUntil` as real Timestamp values.
//
// Frozen sources (OneDrive Ai-Report\twinpet-pos, read-only inputs — not
// shipped, referenced for maintainers only):
//   Architect\twinpet-p1-offline-sync-packet-5-p5-c-atomic-capture-readonly-plan{,-remediation-r1,-remediation-r2,-remediation-r3}.md

import { Timestamp } from 'firebase-admin/firestore';
import {
  toNonNegativeTotalMinor,
  foldCashEntriesSnapshot,
  type TotalMinorResult,
} from './shiftCloseValidationCore';
import {
  sha256Hex,
  computeCashEntriesDigests,
  computeCloseHash,
  CANONICAL_ABSENT,
  type CanonicalFieldValue,
} from './shiftCloseValidationHash';
import { isValidAlertProjection, type AlertProjectionDelta } from './shiftCloseValidationState';
import type { ShiftCashEntrySnapshot, CashEntriesSnapshotMeta } from './shiftCloseValidationTypes';

// ---------------------------------------------------------------------------
// Frozen constants.
// ---------------------------------------------------------------------------

/** [FROZEN, P5-C R2 §6.2 / R3 §6.1] Conservative per-shift count ceiling, far below Number.MAX_SAFE_INTEGER. */
export const MAX_SHIFT_TOTAL_BILLS = 100_000;

/** [FROZEN, P5-C R1 §11.1] 900 KiB conservative preflight, headroom below Firestore's 1 MiB doc limit. */
export const PAYLOAD_GUARD_THRESHOLD_BYTES = 943_718;

/** [FROZEN, P5-A §10] All four Packet 5 collections are schemaVersion:1 at this contract freeze. */
export const SCHEMA_VERSION = 1;

const UNIT_SEP = String.fromCharCode(0x1f);
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// G1 — capture-core-local signed/count primitives (Option A: zero P5-B edits).
// ---------------------------------------------------------------------------

/** [FROZEN, P5-C R1 §6.2] Applies ONLY to `variance`. Composed strictly over `toNonNegativeTotalMinor`. */
export function toSignedTotalMinor(x: number): TotalMinorResult {
  if (!Number.isFinite(x)) return { ok: false, reason: 'non_finite_total' };
  if (Object.is(x, -0)) return { ok: true, minor: 0 };
  const sign = x < 0 ? -1 : 1;
  const abs = toNonNegativeTotalMinor(Math.abs(x));
  if (!abs.ok) return { ok: false, reason: abs.reason };
  const minor = sign * abs.minor;
  return { ok: true, minor: Object.is(minor, -0) ? 0 : minor };
}

export type CountIntResult = { ok: true; count: number } | { ok: false };

/** [FROZEN, P5-C R3 §6.1] Accepted domain: safe integer, 0 <= x <= MAX_SHIFT_TOTAL_BILLS. */
export function toNonNegativeCountInt(x: number): CountIntResult {
  if (Number.isSafeInteger(x) && x >= 0 && x <= MAX_SHIFT_TOTAL_BILLS) return { ok: true, count: x };
  return { ok: false };
}

/** [FROZEN, P5-C R1 §6.3] Totals-scoped INV<US>... tag encoder — money fields only (never totalBills under G8 Option A). */
function encodeTotalTag(x: number): string {
  if (Number.isNaN(x)) return `INV${UNIT_SEP}nan`;
  if (x === Number.POSITIVE_INFINITY) return `INV${UNIT_SEP}+inf`;
  if (x === Number.NEGATIVE_INFINITY) return `INV${UNIT_SEP}-inf`;
  return `INV${UNIT_SEP}num${UNIT_SEP}${x.toString(10)}`;
}

// ---------------------------------------------------------------------------
// Field-level canonicalization.
// ---------------------------------------------------------------------------

export type MoneyFieldOutcome =
  | { kind: 'absent'; stored: null; hash: typeof CANONICAL_ABSENT }
  | { kind: 'null'; stored: null; hash: null }
  | { kind: 'valid'; stored: number; hash: number }
  | { kind: 'invalid_numeric'; stored: number; hash: string }
  | { kind: 'wrong_type' };

/** [FROZEN, P5-C R1 §6.1] Feeds the RAW value directly — never pre-rounded via roundMoneyKernel. */
export function canonicalizeMoneyField(raw: unknown, signed: boolean): MoneyFieldOutcome {
  if (raw === undefined) return { kind: 'absent', stored: null, hash: CANONICAL_ABSENT };
  if (raw === null) return { kind: 'null', stored: null, hash: null };
  if (typeof raw === 'number') {
    const result = signed ? toSignedTotalMinor(raw) : toNonNegativeTotalMinor(raw);
    if (result.ok) return { kind: 'valid', stored: raw, hash: result.minor };
    return { kind: 'invalid_numeric', stored: raw, hash: encodeTotalTag(raw) };
  }
  return { kind: 'wrong_type' };
}

export type TotalBillsOutcome =
  | { kind: 'absent'; stored: null; hash: typeof CANONICAL_ABSENT }
  | { kind: 'null'; stored: null; hash: null }
  | { kind: 'valid'; stored: number; hash: number }
  | { kind: 'invalid_numeric' }
  | { kind: 'wrong_type' };

/** [FROZEN, P5-C R3 §6.1 / G8 Option A] Invalid numeric is a structural capture refusal — never INV-tagged, never stored. */
export function canonicalizeTotalBills(raw: unknown): TotalBillsOutcome {
  if (raw === undefined) return { kind: 'absent', stored: null, hash: CANONICAL_ABSENT };
  if (raw === null) return { kind: 'null', stored: null, hash: null };
  if (typeof raw === 'number') {
    const result = toNonNegativeCountInt(raw);
    if (result.ok) return { kind: 'valid', stored: result.count, hash: result.count };
    return { kind: 'invalid_numeric' };
  }
  return { kind: 'wrong_type' };
}

export type NoteOutcome =
  | { kind: 'absent'; stored: null; hash: typeof CANONICAL_ABSENT }
  | { kind: 'null'; stored: null; hash: null }
  | { kind: 'valid'; stored: string; hash: string }
  | { kind: 'wrong_type' };

export function canonicalizeNote(raw: unknown): NoteOutcome {
  if (raw === undefined) return { kind: 'absent', stored: null, hash: CANONICAL_ABSENT };
  if (raw === null) return { kind: 'null', stored: null, hash: null };
  if (typeof raw === 'string') return { kind: 'valid', stored: raw, hash: raw };
  return { kind: 'wrong_type' };
}

export type IdentityOutcome =
  | { ok: true; branchId: string; staffId: string; deviceId: string }
  | { ok: false; missingField: 'shiftId' | 'branchId' | 'staffId' | 'deviceId' };

/** [FROZEN, P5-C R1 §8.1 / R3 §8.4] branchId/staffId/deviceId/shiftId: present-non-empty-string required. */
export function canonicalizeIdentity(params: {
  shiftId: unknown;
  branchId: unknown;
  staffId: unknown;
  deviceId: unknown;
}): IdentityOutcome {
  if (typeof params.shiftId !== 'string' || params.shiftId.length === 0) return { ok: false, missingField: 'shiftId' };
  if (typeof params.branchId !== 'string' || params.branchId.length === 0) return { ok: false, missingField: 'branchId' };
  if (typeof params.staffId !== 'string' || params.staffId.length === 0) return { ok: false, missingField: 'staffId' };
  if (typeof params.deviceId !== 'string' || params.deviceId.length === 0) return { ok: false, missingField: 'deviceId' };
  return { ok: true, branchId: params.branchId, staffId: params.staffId, deviceId: params.deviceId };
}

export type ClosedAtOutcome =
  | { ok: true; observedClosedAt: Timestamp | null; lateEventHorizonUntil: Timestamp }
  | { ok: false };

/** [FROZEN, P5-C R1 §10.3 / G7] missing/null -> event.time+7d fallback; real Timestamp -> closedAt+7d; else refusal. */
export function canonicalizeClosedAt(raw: unknown, eventTimeIso: string): ClosedAtOutcome {
  if (raw === undefined || raw === null) {
    const eventMillis = new Date(eventTimeIso).getTime();
    return { ok: true, observedClosedAt: null, lateEventHorizonUntil: Timestamp.fromMillis(eventMillis + SEVEN_DAYS_MS) };
  }
  if (raw instanceof Timestamp) {
    return { ok: true, observedClosedAt: raw, lateEventHorizonUntil: Timestamp.fromMillis(raw.toMillis() + SEVEN_DAYS_MS) };
  }
  return { ok: false };
}

function normalizeRawEntries(raw: unknown): ShiftCashEntrySnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => (entry !== null && typeof entry === 'object' ? (entry as ShiftCashEntrySnapshot) : ({} as ShiftCashEntrySnapshot)));
}

// ---------------------------------------------------------------------------
// Close-transition gating.
// ---------------------------------------------------------------------------

/** Only the FIRST server-visible transition to closed enters the capture flow. */
export function isCloseTransition(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): boolean {
  if (!after) return false;
  if (after.status !== 'closed') return false;
  return before?.status !== 'closed';
}

// ---------------------------------------------------------------------------
// Incoming capture — the frozen canonical payload for one close event.
// ---------------------------------------------------------------------------

export interface IncomingCapture {
  shiftId: string;
  branchId: string;
  staffId: string;
  deviceId: string;
  closeHash: string;
  evidenceId: string;
  startingCash: number | null;
  actualCashCount: number | null;
  variance: number | null;
  expectedCash: number | null;
  expectedQr: number | null;
  expectedKbank: number | null;
  expectedCard: number | null;
  expectedCredit: number | null;
  payInTotal: number | null;
  payOutTotal: number | null;
  totalBills: number | null;
  note: string | null;
  cashEntriesSnapshot: readonly ShiftCashEntrySnapshot[];
  cashEntriesSnapshotMeta: CashEntriesSnapshotMeta;
  cashEntriesDigest: string;
  cashEntriesFullDigest: string;
  sourceEntryCount: number;
  sourceCloseDocPath: string;
  observedClosedAt: Timestamp | null;
  lateEventHorizonUntil: Timestamp;
}

export type CapturePlanResult =
  | { kind: 'not_close_transition' }
  | { kind: 'refused'; code: string; fields: Record<string, unknown> }
  | { kind: 'capture'; capture: IncomingCapture };

const MONEY_FIELD_DEFS = [
  { name: 'startingCash', signed: false },
  { name: 'actualCashCount', signed: false },
  { name: 'variance', signed: true },
  { name: 'expectedCash', signed: false },
  { name: 'expectedQr', signed: false },
  { name: 'expectedKbank', signed: false },
  { name: 'expectedCard', signed: false },
  { name: 'expectedCredit', signed: false },
  { name: 'payInTotal', signed: false },
  { name: 'payOutTotal', signed: false },
] as const;

/** Builds the frozen literal `shiftCloseEvidence` field set (excluding server-timestamp sentinels). */
export function buildEvidenceFields(capture: IncomingCapture): Record<string, unknown> {
  return {
    evidenceId: capture.evidenceId,
    shiftId: capture.shiftId,
    closeHash: capture.closeHash,
    branchId: capture.branchId,
    staffId: capture.staffId,
    deviceId: capture.deviceId,
    startingCash: capture.startingCash,
    actualCashCount: capture.actualCashCount,
    variance: capture.variance,
    expectedCash: capture.expectedCash,
    expectedQr: capture.expectedQr,
    expectedKbank: capture.expectedKbank,
    expectedCard: capture.expectedCard,
    expectedCredit: capture.expectedCredit,
    payInTotal: capture.payInTotal,
    payOutTotal: capture.payOutTotal,
    totalBills: capture.totalBills,
    note: capture.note,
    cashEntriesSnapshot: capture.cashEntriesSnapshot,
    cashEntriesSnapshotMeta: capture.cashEntriesSnapshotMeta,
    cashEntriesDigest: capture.cashEntriesDigest,
    cashEntriesFullDigest: capture.cashEntriesFullDigest,
    sourceEntryCount: capture.sourceEntryCount,
    sourceCloseDocPath: capture.sourceCloseDocPath,
    observedShiftStatus: 'closed' as const,
    observedClosedAt: capture.observedClosedAt,
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * Plans one capture attempt from a trigger's before/after after-images. Pure:
 * given the same inputs it always returns the same plan. Never touches
 * Firestore. `eventTimeIso` is the CloudEvent envelope's own `event.time`
 * (ISO-8601), used ONLY as the `lateEventHorizonUntil` fallback source when
 * `closedAt` is absent — never a same-transaction serverTimestamp() sentinel.
 */
export function planCapture(params: {
  shiftId: string;
  before: Record<string, unknown> | undefined;
  after: Record<string, unknown> | undefined;
  eventTimeIso: string;
}): CapturePlanResult {
  const { shiftId, before, after, eventTimeIso } = params;
  if (!isCloseTransition(before, after)) return { kind: 'not_close_transition' };
  const data = after as Record<string, unknown>;

  const identity = canonicalizeIdentity({ shiftId, branchId: data.branchId, staffId: data.staffId, deviceId: data.deviceId });
  if (!identity.ok) {
    return { kind: 'refused', code: 'capture_refused_invalid_shift', fields: { shiftId, missingField: identity.missingField } };
  }

  const closedAtResult = canonicalizeClosedAt(data.closedAt, eventTimeIso);
  if (!closedAtResult.ok) {
    return { kind: 'refused', code: 'capture_refused_malformed_closed_at', fields: { shiftId, branchId: identity.branchId } };
  }

  type NonWrongTypeMoney = Exclude<MoneyFieldOutcome, { kind: 'wrong_type' }>;
  const moneyResults: Record<string, NonWrongTypeMoney> = {};
  for (const def of MONEY_FIELD_DEFS) {
    const outcome = canonicalizeMoneyField(data[def.name], def.signed);
    if (outcome.kind === 'wrong_type') {
      return { kind: 'refused', code: 'capture_refused_malformed_mirror_field', fields: { shiftId, fieldName: def.name } };
    }
    moneyResults[def.name] = outcome;
  }

  const totalBillsResult = canonicalizeTotalBills(data.totalBills);
  if (totalBillsResult.kind === 'wrong_type') {
    return { kind: 'refused', code: 'capture_refused_malformed_mirror_field', fields: { shiftId, fieldName: 'totalBills' } };
  }
  if (totalBillsResult.kind === 'invalid_numeric') {
    return { kind: 'refused', code: 'capture_refused_invalid_total_bills', fields: { shiftId, branchId: identity.branchId } };
  }

  const noteResult = canonicalizeNote(data.note);
  if (noteResult.kind === 'wrong_type') {
    return { kind: 'refused', code: 'capture_refused_malformed_mirror_field', fields: { shiftId, fieldName: 'note' } };
  }

  const rawEntries = normalizeRawEntries(data.cashEntries);
  const digests = computeCashEntriesDigests(rawEntries);
  const fold = foldCashEntriesSnapshot(rawEntries);
  const cashEntriesSnapshot = fold.storedSubset.map((e) => e.raw);

  const moneyHash = (name: (typeof MONEY_FIELD_DEFS)[number]['name']): CanonicalFieldValue => moneyResults[name].hash as CanonicalFieldValue;

  const closeHash = computeCloseHash({
    branchId: identity.branchId,
    staffId: identity.staffId,
    deviceId: identity.deviceId,
    startingCash: moneyHash('startingCash'),
    actualCashCount: moneyHash('actualCashCount'),
    variance: moneyHash('variance'),
    expectedCash: moneyHash('expectedCash'),
    expectedQr: moneyHash('expectedQr'),
    expectedKbank: moneyHash('expectedKbank'),
    expectedCard: moneyHash('expectedCard'),
    expectedCredit: moneyHash('expectedCredit'),
    payInTotal: moneyHash('payInTotal'),
    payOutTotal: moneyHash('payOutTotal'),
    totalBills: totalBillsResult.hash,
    note: noteResult.hash,
    cashEntriesDigest: digests.cashEntriesDigest,
    cashEntriesFullDigest: digests.cashEntriesFullDigest,
    sourceEntryCount: digests.sourceEntryCount,
  });

  const evidenceId = `${shiftId}_${closeHash}`;

  const capture: IncomingCapture = {
    shiftId,
    branchId: identity.branchId,
    staffId: identity.staffId,
    deviceId: identity.deviceId,
    closeHash,
    evidenceId,
    startingCash: moneyResults.startingCash.stored,
    actualCashCount: moneyResults.actualCashCount.stored,
    variance: moneyResults.variance.stored,
    expectedCash: moneyResults.expectedCash.stored,
    expectedQr: moneyResults.expectedQr.stored,
    expectedKbank: moneyResults.expectedKbank.stored,
    expectedCard: moneyResults.expectedCard.stored,
    expectedCredit: moneyResults.expectedCredit.stored,
    payInTotal: moneyResults.payInTotal.stored,
    payOutTotal: moneyResults.payOutTotal.stored,
    totalBills: totalBillsResult.kind === 'valid' ? totalBillsResult.stored : null,
    note: noteResult.kind === 'valid' ? noteResult.stored : null,
    cashEntriesSnapshot,
    cashEntriesSnapshotMeta: fold.meta,
    cashEntriesDigest: digests.cashEntriesDigest,
    cashEntriesFullDigest: digests.cashEntriesFullDigest,
    sourceEntryCount: digests.sourceEntryCount,
    sourceCloseDocPath: `shifts/${shiftId}`,
    observedClosedAt: closedAtResult.observedClosedAt,
    lateEventHorizonUntil: closedAtResult.lateEventHorizonUntil,
  };

  const evidenceFields = buildEvidenceFields(capture);
  const estimatedBytes = Buffer.byteLength(JSON.stringify(evidenceFields), 'utf8');
  if (estimatedBytes > PAYLOAD_GUARD_THRESHOLD_BYTES) {
    return {
      kind: 'refused',
      code: 'capture_refused_payload_limit',
      fields: { shiftId, branchId: identity.branchId, estimatedBytes },
    };
  }

  return { kind: 'capture', capture };
}

// ---------------------------------------------------------------------------
// Transaction decision — disjoint ordered algorithm (P5-C R3 §8.1).
// ---------------------------------------------------------------------------

export interface ExistingEvidenceView {
  exists: boolean;
  id?: unknown;
  evidenceId?: unknown;
  shiftId?: unknown;
  closeHash?: unknown;
  sourceCloseDocPath?: unknown;
  branchId?: unknown;
  staffId?: unknown;
  deviceId?: unknown;
  schemaVersion?: unknown;
}

export interface ExistingCaseView {
  exists: boolean;
  shiftId?: unknown;
  branchId?: unknown;
  staffId?: unknown;
  deviceId?: unknown;
  schemaVersion?: unknown;
  caseVersion?: unknown;
  sourceRevision?: unknown;
}

export type CaptureDecision =
  | { kind: 'anomaly'; code: 'capture_anomaly_evidence_identity_mismatch'; fields: { shiftId: string; evidenceId: string } }
  | { kind: 'anomaly'; code: 'capture_anomaly_case_identity_mismatch'; fields: { shiftId: string } }
  | { kind: 'anomaly'; code: 'capture_anomaly_evidence_without_case'; fields: { shiftId: string; evidenceId: string } }
  | { kind: 'noop' }
  | { kind: 'init' }
  | { kind: 'conflict'; nextCaseVersion: number; nextSourceRevision: number };

/** [FROZEN, R3 §7.1] Full immutable evidence identity/path invariant — checked BEFORE trusting any replay. */
function evidenceInvariantHolds(existing: ExistingEvidenceView, incoming: IncomingCapture): boolean {
  return (
    existing.id === incoming.evidenceId &&
    existing.evidenceId === incoming.evidenceId &&
    existing.shiftId === incoming.shiftId &&
    existing.closeHash === incoming.closeHash &&
    existing.sourceCloseDocPath === incoming.sourceCloseDocPath &&
    existing.branchId === incoming.branchId &&
    existing.staffId === incoming.staffId &&
    existing.deviceId === incoming.deviceId &&
    existing.schemaVersion === SCHEMA_VERSION
  );
}

/** [FROZEN, R3 §7.2] Case immutable identity invariant — checked BEFORE either no-op or conflict-close. */
function caseInvariantHolds(existing: ExistingCaseView, incoming: IncomingCapture): boolean {
  return (
    existing.shiftId === incoming.shiftId &&
    existing.branchId === incoming.branchId &&
    existing.staffId === incoming.staffId &&
    existing.deviceId === incoming.deviceId &&
    existing.schemaVersion === SCHEMA_VERSION
  );
}

/**
 * [FROZEN, R3 §8.1] Disjoint ordered decision algorithm, evaluated top to
 * bottom — the first matching rule fires and stops. Evidence-identity checks
 * take precedence over every case-state branch, including
 * evidence_without_case when the case is absent. Case-identity mismatch
 * prevents both the no-op and the conflict-close. Only evidence-absent states
 * may write.
 */
export function decideCapture(
  incoming: IncomingCapture,
  existingEvidence: ExistingEvidenceView,
  existingCase: ExistingCaseView,
): CaptureDecision {
  if (existingEvidence.exists && !evidenceInvariantHolds(existingEvidence, incoming)) {
    return {
      kind: 'anomaly',
      code: 'capture_anomaly_evidence_identity_mismatch',
      fields: { shiftId: incoming.shiftId, evidenceId: incoming.evidenceId },
    };
  }

  if (existingCase.exists && !caseInvariantHolds(existingCase, incoming)) {
    return { kind: 'anomaly', code: 'capture_anomaly_case_identity_mismatch', fields: { shiftId: incoming.shiftId } };
  }

  if (existingEvidence.exists && !existingCase.exists) {
    return {
      kind: 'anomaly',
      code: 'capture_anomaly_evidence_without_case',
      fields: { shiftId: incoming.shiftId, evidenceId: incoming.evidenceId },
    };
  }

  if (existingEvidence.exists && existingCase.exists) {
    return { kind: 'noop' };
  }

  if (!existingEvidence.exists && !existingCase.exists) {
    return { kind: 'init' };
  }

  const nextCaseVersion = (typeof existingCase.caseVersion === 'number' ? existingCase.caseVersion : 0) + 1;
  const nextSourceRevision = (typeof existingCase.sourceRevision === 'number' ? existingCase.sourceRevision : 0) + 1;
  return { kind: 'conflict', nextCaseVersion, nextSourceRevision };
}

// ---------------------------------------------------------------------------
// Write-set builders (literal field sets, excluding server-timestamp
// sentinels — the adapter merges those in at commit time).
// ---------------------------------------------------------------------------

/** eventId = SHA-256("shiftCloseAuditEvent" US schemaVersion US shiftId US evidenceId US 'evidence_captured' US caseVersion). */
function computeAuditEventId(shiftId: string, evidenceId: string, caseVersion: number): string {
  return sha256Hex(
    ['shiftCloseAuditEvent', String(SCHEMA_VERSION), shiftId, evidenceId, 'evidence_captured', String(caseVersion)].join(UNIT_SEP),
  );
}

export interface InitWriteSet {
  evidenceFields: Record<string, unknown>;
  caseFields: Record<string, unknown>;
  auditFields: Record<string, unknown>;
  alertFields: Record<string, unknown>;
  auditEventId: string;
}

/** [FROZEN, R1 §9.1 / R3 §8.1 Step 6] Four-write init shape. */
export function buildInitWrites(capture: IncomingCapture): InitWriteSet {
  const evidenceFields = buildEvidenceFields(capture);
  const auditEventId = computeAuditEventId(capture.shiftId, capture.evidenceId, 1);

  const auditFields: Record<string, unknown> = {
    eventId: auditEventId,
    shiftId: capture.shiftId,
    caseVersion: 1,
    runId: null,
    transitionType: 'evidence_captured',
    actor: { kind: 'system' },
    reasonCode: null,
    note: null,
    branchId: capture.branchId,
    schemaVersion: SCHEMA_VERSION,
  };

  const alertProjection: AlertProjectionDelta = {
    alertState: 'none',
    reasonCode: null,
    acknowledgedByActor: null,
    resolvedByActor: null,
  };
  if (!isValidAlertProjection(alertProjection)) {
    throw new Error('invariant violation: init alert projection failed isValidAlertProjection');
  }
  const alertFields: Record<string, unknown> = {
    alertState: alertProjection.alertState,
    reasonCode: alertProjection.reasonCode,
    openedAt: null,
    acknowledgedByActor: alertProjection.acknowledgedByActor,
    resolvedByActor: alertProjection.resolvedByActor,
    caseVersion: 1,
    branchId: capture.branchId,
    schemaVersion: SCHEMA_VERSION,
  };

  const caseFields: Record<string, unknown> = {
    shiftId: capture.shiftId,
    branchId: capture.branchId,
    staffId: capture.staffId,
    deviceId: capture.deviceId,
    selectedRunId: null,
    selectedCloseHash: null,
    priorSelectedRunId: null,
    latestEvidenceId: capture.evidenceId,
    latestCloseHash: capture.closeHash,
    processingState: 'queued',
    settlementState: 'unsettled',
    alertState: 'none',
    caseVersion: 1,
    sourceRevision: 1,
    pendingRevalidation: true,
    lastObservedCommitMicros: '0',
    commitBoundaryDocKeys: [],
    lastEnqueuedSourceEventId: null,
    revalidationAttempts: 0,
    leaseOwner: null,
    leaseExpiry: null,
    lateEventHorizonUntil: capture.lateEventHorizonUntil,
    sweepEligible: true,
    schemaVersion: SCHEMA_VERSION,
  };

  return { evidenceFields, caseFields, auditFields, alertFields, auditEventId };
}

export interface ConflictWriteSet {
  evidenceFields: Record<string, unknown>;
  auditFields: Record<string, unknown>;
  caseUpdateFields: Record<string, unknown>;
  auditEventId: string;
}

/** [FROZEN, R1 §9.1 / R3 §8.1 Step 7] Conflict-close write set — evidence create, audit append, case CAS-bump. */
export function buildConflictWrites(capture: IncomingCapture, nextCaseVersion: number, nextSourceRevision: number): ConflictWriteSet {
  const evidenceFields = buildEvidenceFields(capture);
  const auditEventId = computeAuditEventId(capture.shiftId, capture.evidenceId, nextCaseVersion);

  const auditFields: Record<string, unknown> = {
    eventId: auditEventId,
    shiftId: capture.shiftId,
    caseVersion: nextCaseVersion,
    runId: null,
    transitionType: 'evidence_captured',
    actor: { kind: 'system' },
    reasonCode: null,
    note: null,
    branchId: capture.branchId,
    schemaVersion: SCHEMA_VERSION,
  };

  const caseUpdateFields: Record<string, unknown> = {
    caseVersion: nextCaseVersion,
    sourceRevision: nextSourceRevision,
    latestEvidenceId: capture.evidenceId,
    latestCloseHash: capture.closeHash,
    pendingRevalidation: true,
  };

  return { evidenceFields, auditFields, caseUpdateFields, auditEventId };
}

// ---------------------------------------------------------------------------
// Retry/throw taxonomy — stable coded Firestore/gRPC classifier (Codex B1).
//
// The Firestore Admin SDK (`@google-cloud/firestore`, via `google-gax`)
// surfaces transport failures as `GoogleError`-shaped objects whose `code` is
// a NUMERIC gRPC status (see `google-gax`'s `Status` enum: DEADLINE_EXCEEDED=4,
// RESOURCE_EXHAUSTED=8, ABORTED=10, UNAVAILABLE=14). Some call paths (e.g. an
// error wrapped by a higher-level SDK, or a nested nested `cause`) may instead
// carry a lower-cased hyphenated STRING code (the `firebase-functions`
// `HttpsError`-style convention: 'deadline-exceeded', 'unavailable', etc.).
// Both are supported. A plain, un-coded `Error` (including every local
// invariant/schema/programmer assertion thrown while constructing a write
// shape) has NEITHER and is therefore, by construction, classified as
// non-transient — retryability is NEVER inferred from `error.message` text.
// ---------------------------------------------------------------------------

/** [FROZEN] Numeric gRPC status codes treated as transient (google-gax `Status` enum). */
const TRANSIENT_NUMERIC_GRPC_CODES: ReadonlySet<number> = new Set([
  4, // DEADLINE_EXCEEDED
  8, // RESOURCE_EXHAUSTED
  10, // ABORTED
  14, // UNAVAILABLE
]);

/** [FROZEN] String status codes treated as transient (HttpsError-style convention, defense in depth). */
const TRANSIENT_STRING_CODES: ReadonlySet<string> = new Set(['deadline-exceeded', 'resource-exhausted', 'aborted', 'unavailable']);

/** A stable code value, if `value` carries one directly (`value.code`) — never derived from `.message`. */
function extractStableCode(value: unknown): string | number | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const code = (value as { code?: unknown }).code;
  if (typeof code === 'number' || typeof code === 'string') return code;
  return undefined;
}

function isTransientCode(code: string | number): boolean {
  return typeof code === 'number' ? TRANSIENT_NUMERIC_GRPC_CODES.has(code) : TRANSIENT_STRING_CODES.has(code.toLowerCase());
}

/**
 * [FROZEN, Codex B1] Classifies a `db.runTransaction(...)` rejection.
 * `true` -> stable coded transient Firestore/gRPC failure -> rethrow so
 * `retry:true` can redeliver. `false` -> structural/permanent/local/
 * schema/programmer/unknown-non-coded error -> ACK, do not throw. Checks the
 * error's own `code` first, then one level of `error.cause.code` (Node's
 * standard `Error#cause` chaining) — never message text, never a `details`
 * field (not a stable convention in this SDK's error shape).
 */
export function isRetryableFirestoreError(error: unknown): boolean {
  const directCode = extractStableCode(error);
  if (directCode !== undefined) return isTransientCode(directCode);

  if (error !== null && typeof error === 'object') {
    const cause = (error as { cause?: unknown }).cause;
    const causeCode = extractStableCode(cause);
    if (causeCode !== undefined) return isTransientCode(causeCode);
  }

  return false;
}

/** Normalized code for structured logging only (never logs `.message`/payload values). */
export function describeErrorCode(error: unknown): string | number {
  const directCode = extractStableCode(error);
  if (directCode !== undefined) return directCode;
  if (error !== null && typeof error === 'object') {
    const causeCode = extractStableCode((error as { cause?: unknown }).cause);
    if (causeCode !== undefined) return causeCode;
  }
  return 'unknown';
}
