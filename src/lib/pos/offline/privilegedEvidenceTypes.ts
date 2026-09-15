/**
 * SEC-001 Packet D / D-2 — durable privileged-evidence journal schema.
 *
 * `PrivilegedEvidenceJournalRecordV1` is the local, device-readable forensic
 * copy of one offline-attested privileged action (manager PIN approval of a
 * void performed while offline) and its D-1B server adjudication lifecycle.
 *
 * Closed schema: exactly 54 keys, any unknown key fails the record closed to
 * `null`. `lastDispositionKind` is a closed 12-member discriminant that gates
 * every server-owned (Class III) field — no field may be inferred, guessed,
 * or backfilled from local state or the wall clock.
 *
 * D-2 never recomputes, re-serializes, or re-signs `paa1Base64` / `ssa1Base64`
 * / `oacEnvelopeBytesBase64`; they are opaque byte strings resubmitted
 * byte-identically on every retry.
 */

import {
  isPrivilegedActionId,
  type PrivilegedActionId,
  type PrivilegedManualReviewStatus,
  type PrivilegedServerVerdict,
  isOfflineAdjudicationAnomalyReason,
  isOfflineAdjudicationManualAttentionReason,
  isOfflineAdjudicationOutcomeKind,
  isOfflineAdjudicationProtocolReason,
  isOfflineAdjudicationRejectionReason,
  OFFLINE_ADJUDICATION_PERMANENT_BYTE_REASONS,
  type OfflineAdjudicationOutcomeKind,
} from '../../auth/privilegedAction/privilegedActionTypes';

// ─── Constants ──────────────────────────────────────────────────────────────

export const PRIVILEGED_EVIDENCE_JOURNAL_SCHEMA_VERSION = 1 as const;

/** Sole automatic-retry ceiling. Reuses SYNC_ORCHESTRATOR_MAX_ATTEMPTS's value. */
export const PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES = 8;

/** Starvation-freedom force-admission threshold, in withheld sweep counts. */
export const PRIVILEGED_EVIDENCE_S_MAX = 8;

/** Reuses SYNC_ORCHESTRATOR_PER_CHANNEL_ITEM_CAP's value. */
export const PRIVILEGED_EVIDENCE_PER_CYCLE_CAP = 25;

/** Durable monotone sweep-generation fencing key. Never a journal record key. */
export const PRIVILEGED_EVIDENCE_CLAIM_GENERATION_KEY = '__privileged_claim_generation__';

/** Reserved store keys excluded from row parsing and from `unreadableCount`. */
export const PRIVILEGED_EVIDENCE_RESERVED_KEYS: readonly string[] = [
  PRIVILEGED_EVIDENCE_CLAIM_GENERATION_KEY,
];

/** Whole privileged-evidence phase reserved budget, out of the 20s cycle budget. */
export const PRIVILEGED_EVIDENCE_PHASE_BUDGET_MS = 10_000;

/** Per-submission local liveness/transport-classification timeout. */
export const PRIVILEGED_EVIDENCE_SUBMISSION_TIMEOUT_MS = 8_000;

/** Derivation input only (not a runtime clock comparand). */
export const PRIVILEGED_EVIDENCE_MIN_SUBMISSION_WINDOW_MS = 2_000;

/** = PHASE_BUDGET_MS - MIN_SUBMISSION_WINDOW_MS. Second armed phase signal (F09). */
export const PRIVILEGED_EVIDENCE_PHASE_ADMISSION_WINDOW_MS =
  PRIVILEGED_EVIDENCE_PHASE_BUDGET_MS - PRIVILEGED_EVIDENCE_MIN_SUBMISSION_WINDOW_MS;

/** Per-durable-store-operation timeout (OP-1..OP-4). Matches deviceId.ts's IDB_ALLOCATE_TIMEOUT_MS precedent. */
export const PRIVILEGED_EVIDENCE_DURABLE_OP_TIMEOUT_MS = 2_000;

// ─── Disposition discriminant (12, closed) ─────────────────────────────────

export const PRIVILEGED_EVIDENCE_DISPOSITION_KINDS = [
  'ACCEPTED',
  'REJECTED',
  'MANUAL_ATTENTION_REQUIRED',
  'ADJUDICATION_ANOMALY',
  'RETRYABLE',
  'PROTOCOL_REJECTED_PERMANENT',
  'PROTOCOL_REJECTED_STATE_DEPENDENT',
  'PROTOCOL_REJECTED_CALLER_DEPENDENT',
  'PROTOCOL_RETRYABLE',
  'TRANSPORT_FAILURE',
  'LOCAL_TERMINAL',
  'LOCAL_SUBMISSION_TIMEOUT',
] as const;
export type PrivilegedEvidenceDispositionKind = (typeof PRIVILEGED_EVIDENCE_DISPOSITION_KINDS)[number];

function isDispositionKind(v: unknown): v is PrivilegedEvidenceDispositionKind {
  return (PRIVILEGED_EVIDENCE_DISPOSITION_KINDS as readonly string[]).includes(v as string);
}

/** Retryable dispositions: the sole set that increments `retryableFailureCount`. */
export const PRIVILEGED_EVIDENCE_RETRYABLE_DISPOSITION_KINDS: readonly PrivilegedEvidenceDispositionKind[] = [
  'RETRYABLE',
  'PROTOCOL_RETRYABLE',
  'PROTOCOL_REJECTED_STATE_DEPENDENT',
  'TRANSPORT_FAILURE',
  'LOCAL_SUBMISSION_TIMEOUT',
];

// ─── D-2 sync lifecycle — subset of the landed D-1A 7-member vocabulary ────

export const PRIVILEGED_EVIDENCE_D2_SYNC_STATUSES = [
  'PRIVILEGED_INTENT_QUEUED',
  'SYNCING',
  'SERVER_ACCEPTED',
  'SERVER_REJECTED',
  'MANUAL_ATTENTION',
] as const;
export type PrivilegedEvidenceD2SyncStatus = (typeof PRIVILEGED_EVIDENCE_D2_SYNC_STATUSES)[number];

function isD2SyncStatus(v: unknown): v is PrivilegedEvidenceD2SyncStatus {
  return (PRIVILEGED_EVIDENCE_D2_SYNC_STATUSES as readonly string[]).includes(v as string);
}

const TERMINAL_SYNC_STATUSES: readonly PrivilegedEvidenceD2SyncStatus[] = [
  'SERVER_ACCEPTED',
  'SERVER_REJECTED',
  'MANUAL_ATTENTION',
];

export function isPrivilegedEvidenceTerminalStatus(status: PrivilegedEvidenceD2SyncStatus): boolean {
  return TERMINAL_SYNC_STATUSES.includes(status);
}

// ─── Local terminal reasons — closed, disjoint from every server enum ─────

export const PRIVILEGED_EVIDENCE_LOCAL_TERMINAL_REASONS = [
  'attempt_ceiling_reached',
  'evidence_binding_digest_mismatch',
  'journal_record_unreadable',
  'journal_binding_conflict',
] as const;
export type PrivilegedEvidenceLocalTerminalReason = (typeof PRIVILEGED_EVIDENCE_LOCAL_TERMINAL_REASONS)[number];

function isLocalTerminalReason(v: unknown): v is PrivilegedEvidenceLocalTerminalReason {
  return (PRIVILEGED_EVIDENCE_LOCAL_TERMINAL_REASONS as readonly string[]).includes(v as string);
}

// ─── The journal record — exactly 54 keys ──────────────────────────────────

export interface PrivilegedEvidenceJournalRecordV1 {
  // identity + schema (3)
  schemaVersion: 1;
  adjudicationId: string; // 32 lowercase hex, non-zero; = attestationIdHex
  localIntentId: string;

  // Class I — immutable authority bytes + binding (4)
  paa1Base64: string;
  ssa1Base64: string;
  oacEnvelopeBytesBase64: string;
  evidenceBindingDigest: string;

  // Class II — immutable signed provenance (17)
  actionId: PrivilegedActionId;
  targetOrderId: string;
  targetOrderUtc7Date: string;
  branchId: string;
  approvingManagerStaffId: string;
  oacId: string;
  oacSchemaVersion: 1;
  revocationEpochAtIssue: number;
  managerAuthVersionAtIssue: number;
  managerCredentialVersionAtIssue: number;
  nonce: string;
  approvalProofDigest: string;
  attestationAttemptCount: number;
  approvalResult: 'APPROVED_LOCAL';
  trustedApprovalLowerMs: number;
  trustedApprovalUpperMs: number;
  pendingExecutionExpiresAtMs: number;

  // Class IV — local lifecycle, D-2-owned, never transmitted (21)
  syncStatus: PrivilegedEvidenceD2SyncStatus;
  manualReviewStatus: PrivilegedManualReviewStatus;
  localTerminalReason: PrivilegedEvidenceLocalTerminalReason | null;
  submissionClaims: number;
  unresolvedClaimCount: number;
  retryableFailureCount: number;
  relayDeferrals: number;
  deferredCycleCount: number;
  nextAttemptAtMs: number;
  claimOwner: string | null;
  claimGeneration: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  lastAttemptAtMs: number | null;
  lastDispositionKind: PrivilegedEvidenceDispositionKind | null;
  lastRelayCallerStaffId: string | null;
  lastCallerDependentStaffId: string | null;
  integrityConflict: boolean;
  ingestStaffId: string;
  ingestDeviceId: string;
  resultingVoidIntentId: null;

  // Class III — server-owned, write-once, terminal dispositions only (9)
  serverVerdict: PrivilegedServerVerdict | null;
  serverReason: string | null;
  serverAdjudicationId: string | null;
  serverTargetOrderId: string | null;
  offlineExecutionId: string | null;
  outcomeKind: OfflineAdjudicationOutcomeKind | null;
  serverAdjudicatedAtMs: number | null;
  serverObservedAtMs: number | null;
  serverIdempotentReplay: boolean | null;
}

const RECORD_KEYS: readonly (keyof PrivilegedEvidenceJournalRecordV1)[] = [
  'schemaVersion',
  'adjudicationId',
  'localIntentId',
  'paa1Base64',
  'ssa1Base64',
  'oacEnvelopeBytesBase64',
  'evidenceBindingDigest',
  'actionId',
  'targetOrderId',
  'targetOrderUtc7Date',
  'branchId',
  'approvingManagerStaffId',
  'oacId',
  'oacSchemaVersion',
  'revocationEpochAtIssue',
  'managerAuthVersionAtIssue',
  'managerCredentialVersionAtIssue',
  'nonce',
  'approvalProofDigest',
  'attestationAttemptCount',
  'approvalResult',
  'trustedApprovalLowerMs',
  'trustedApprovalUpperMs',
  'pendingExecutionExpiresAtMs',
  'syncStatus',
  'manualReviewStatus',
  'localTerminalReason',
  'submissionClaims',
  'unresolvedClaimCount',
  'retryableFailureCount',
  'relayDeferrals',
  'deferredCycleCount',
  'nextAttemptAtMs',
  'claimOwner',
  'claimGeneration',
  'createdAtMs',
  'updatedAtMs',
  'lastAttemptAtMs',
  'lastDispositionKind',
  'lastRelayCallerStaffId',
  'lastCallerDependentStaffId',
  'integrityConflict',
  'ingestStaffId',
  'ingestDeviceId',
  'resultingVoidIntentId',
  'serverVerdict',
  'serverReason',
  'serverAdjudicationId',
  'serverTargetOrderId',
  'offlineExecutionId',
  'outcomeKind',
  'serverAdjudicatedAtMs',
  'serverObservedAtMs',
  'serverIdempotentReplay',
];

export const PRIVILEGED_EVIDENCE_JOURNAL_RECORD_KEY_COUNT = 54;

if (RECORD_KEYS.length !== PRIVILEGED_EVIDENCE_JOURNAL_RECORD_KEY_COUNT) {
  // Guards against future edits silently drifting the key list out of sync
  // with the frozen 54-key architecture contract.
  throw new Error(
    `privilegedEvidenceTypes: RECORD_KEYS has ${RECORD_KEYS.length} entries, expected ${PRIVILEGED_EVIDENCE_JOURNAL_RECORD_KEY_COUNT}`,
  );
}

// ─── Legal transition set ───────────────────────────────────────────────────

const LEGAL_TRANSITIONS: readonly (readonly [PrivilegedEvidenceD2SyncStatus | null, PrivilegedEvidenceD2SyncStatus])[] =
  [
    [null, 'PRIVILEGED_INTENT_QUEUED'],
    ['PRIVILEGED_INTENT_QUEUED', 'SYNCING'],
    ['SYNCING', 'PRIVILEGED_INTENT_QUEUED'],
    ['SYNCING', 'SERVER_ACCEPTED'],
    ['SYNCING', 'SERVER_REJECTED'],
    ['SYNCING', 'MANUAL_ATTENTION'],
    ['PRIVILEGED_INTENT_QUEUED', 'MANUAL_ATTENTION'],
  ];

export function isLegalPrivilegedEvidenceTransition(
  from: PrivilegedEvidenceD2SyncStatus | null,
  to: PrivilegedEvidenceD2SyncStatus,
): boolean {
  return LEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/** F1 — the sole reclaim/fencing predicate. Pure; no owner term, no clock term. */
export function isPrivilegedEvidenceClaimFenced(
  claimGeneration: number | null,
  currentSweepGeneration: number,
): boolean {
  return claimGeneration === null || currentSweepGeneration > claimGeneration;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isPlainNumber(v: unknown): v is number {
  return typeof v === 'number';
}
function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}
function isNullableString(v: unknown): v is string | null {
  return v === null || isNonEmptyString(v);
}

const UTC7_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ADJUDICATION_ID_RE = /^[0-9a-f]{32}$/;
const ZERO_ADJUDICATION_ID = '0'.repeat(32);

function isNonZeroHex32(v: unknown): v is string {
  return typeof v === 'string' && ADJUDICATION_ID_RE.test(v) && v !== ZERO_ADJUDICATION_ID;
}

/**
 * Fail-closed parse. Returns `null` — never a repaired default — on any
 * schema, vocabulary, or cross-invariant violation.
 */
export function parsePrivilegedEvidenceJournalRecordV1(raw: unknown): PrivilegedEvidenceJournalRecordV1 | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const actualKeys = Object.keys(r);
  if (actualKeys.length !== PRIVILEGED_EVIDENCE_JOURNAL_RECORD_KEY_COUNT) return null;
  const known = new Set<string>(RECORD_KEYS as readonly string[]);
  for (const k of actualKeys) {
    if (!known.has(k)) return null;
  }

  if (r.schemaVersion !== PRIVILEGED_EVIDENCE_JOURNAL_SCHEMA_VERSION) return null;

  if (!isNonZeroHex32(r.adjudicationId)) return null;
  if (!isNonEmptyString(r.localIntentId)) return null;

  if (!isNonEmptyString(r.paa1Base64)) return null;
  if (!isNonEmptyString(r.ssa1Base64)) return null;
  if (!isNonEmptyString(r.oacEnvelopeBytesBase64)) return null;
  if (!isNonEmptyString(r.evidenceBindingDigest)) return null;

  if (!isPrivilegedActionId(r.actionId)) return null;
  if (!isNonEmptyString(r.targetOrderId)) return null;
  if (typeof r.targetOrderUtc7Date !== 'string' || !UTC7_DATE_RE.test(r.targetOrderUtc7Date)) return null;
  if (!isNonEmptyString(r.branchId) || r.branchId === 'ALL') return null;
  if (!isNonEmptyString(r.approvingManagerStaffId)) return null;
  if (!isNonEmptyString(r.oacId)) return null;
  if (r.oacSchemaVersion !== 1) return null;
  if (!isNonNegativeInt(r.revocationEpochAtIssue)) return null;
  if (!isNonNegativeInt(r.managerAuthVersionAtIssue)) return null;
  if (!isNonNegativeInt(r.managerCredentialVersionAtIssue)) return null;
  if (!isNonEmptyString(r.nonce)) return null;
  if (!isNonEmptyString(r.approvalProofDigest)) return null;
  if (!isNonNegativeInt(r.attestationAttemptCount)) return null;
  if (r.approvalResult !== 'APPROVED_LOCAL') return null;
  if (!isFiniteNumber(r.trustedApprovalLowerMs)) return null;
  if (!isFiniteNumber(r.trustedApprovalUpperMs)) return null;
  if ((r.trustedApprovalUpperMs as number) < (r.trustedApprovalLowerMs as number)) return null;
  if (!isFiniteNumber(r.pendingExecutionExpiresAtMs)) return null;

  if (!isD2SyncStatus(r.syncStatus)) return null;
  const syncStatus = r.syncStatus;
  if (r.manualReviewStatus !== 'NOT_REQUIRED' && r.manualReviewStatus !== 'REQUIRED' && r.manualReviewStatus !== 'RESOLVED') {
    return null;
  }
  if (r.localTerminalReason !== null && !isLocalTerminalReason(r.localTerminalReason)) return null;

  if (!isNonNegativeInt(r.submissionClaims)) return null;
  if (!isNonNegativeInt(r.unresolvedClaimCount)) return null;
  if (!isNonNegativeInt(r.retryableFailureCount) || (r.retryableFailureCount as number) > PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES) {
    return null;
  }
  if (!isNonNegativeInt(r.relayDeferrals)) return null;
  if (!isNonNegativeInt(r.deferredCycleCount)) return null;
  if (!isPlainNumber(r.nextAttemptAtMs)) return null;

  if (r.claimOwner !== null && !isNonEmptyString(r.claimOwner)) return null;
  if (r.claimGeneration !== null && !isNonNegativeInt(r.claimGeneration)) return null;
  // Claim-field totality: SYNCING <=> both non-null.
  const claimTotalityOk =
    syncStatus === 'SYNCING'
      ? r.claimOwner !== null && r.claimGeneration !== null
      : r.claimOwner === null && r.claimGeneration === null;
  if (!claimTotalityOk) return null;

  if (!isFiniteNumber(r.createdAtMs) || (r.createdAtMs as number) <= 0) return null;
  if (!isFiniteNumber(r.updatedAtMs) || (r.updatedAtMs as number) <= 0) return null;
  if (r.lastAttemptAtMs !== null && !isFiniteNumber(r.lastAttemptAtMs)) return null;

  if (r.lastDispositionKind !== null && !isDispositionKind(r.lastDispositionKind)) return null;
  const lastDispositionKind = r.lastDispositionKind as PrivilegedEvidenceDispositionKind | null;

  if (!isNullableString(r.lastRelayCallerStaffId)) return null;
  if (!isNullableString(r.lastCallerDependentStaffId)) return null;
  if (!isBoolean(r.integrityConflict)) return null;
  if (!isNonEmptyString(r.ingestStaffId)) return null;
  if (!isNonEmptyString(r.ingestDeviceId)) return null;
  if (r.resultingVoidIntentId !== null) return null;

  if (r.serverVerdict !== null && r.serverVerdict !== 'ACCEPTED' && r.serverVerdict !== 'REJECTED') return null;
  if (r.serverReason !== null && !isNonEmptyString(r.serverReason)) return null;
  if (!isNullableString(r.serverAdjudicationId)) return null;
  if (!isNullableString(r.serverTargetOrderId)) return null;
  if (!isNullableString(r.offlineExecutionId)) return null;
  if (r.outcomeKind !== null && !isOfflineAdjudicationOutcomeKind(r.outcomeKind)) return null;
  if (r.serverAdjudicatedAtMs !== null && !isFiniteNumber(r.serverAdjudicatedAtMs)) return null;
  if (r.serverObservedAtMs !== null && !isFiniteNumber(r.serverObservedAtMs)) return null;
  if (r.serverIdempotentReplay !== null && !isBoolean(r.serverIdempotentReplay)) return null;

  // ── Cross-invariant: localTerminalReason <=> lastDispositionKind === 'LOCAL_TERMINAL'
  if ((r.localTerminalReason !== null) !== (lastDispositionKind === 'LOCAL_TERMINAL')) return null;

  // ── Cross-invariant: serverVerdict non-null only under ACCEPTED / REJECTED
  if (r.serverVerdict !== null && lastDispositionKind !== 'ACCEPTED' && lastDispositionKind !== 'REJECTED') return null;

  // ── Cross-invariant: a queued row carries no manual-review state. Every
  // writer that can yield PRIVILEGED_INTENT_QUEUED emits 'NOT_REQUIRED' — the
  // classifier's four retryable dispositions, TRANSPORT_FAILURE_DISPOSITION,
  // and the fresh-ingest record — so a queued row holding 'REQUIRED' or
  // 'RESOLVED' is contradictory, not a lifecycle state. Keyed on syncStatus
  // rather than on a disposition kind so it also covers a row no disposition
  // has been applied to yet; the per-kind matrix below stays the sole owner of
  // the Class III field shape.
  if (syncStatus === 'PRIVILEGED_INTENT_QUEUED' && r.manualReviewStatus !== 'NOT_REQUIRED') return null;

  // ── Cross-invariant: no disposition ever applied => queued/syncing, everything else null
  if (lastDispositionKind === null) {
    if (syncStatus !== 'PRIVILEGED_INTENT_QUEUED' && syncStatus !== 'SYNCING') return null;
    if (
      r.serverVerdict !== null ||
      r.serverReason !== null ||
      r.serverAdjudicationId !== null ||
      r.serverTargetOrderId !== null ||
      r.offlineExecutionId !== null ||
      r.outcomeKind !== null ||
      r.serverAdjudicatedAtMs !== null ||
      r.serverObservedAtMs !== null ||
      r.serverIdempotentReplay !== null
    ) {
      return null;
    }
  }

  // ── Cross-invariant: exact per-kind field matrix
  if (lastDispositionKind !== null && !matchesDispositionMatrix(lastDispositionKind, r)) return null;

  // ── Conservation invariant
  const submissionClaims = r.submissionClaims as number;
  const retryableFailureCount = r.retryableFailureCount as number;
  const relayDeferrals = r.relayDeferrals as number;
  const unresolvedClaimCount = r.unresolvedClaimCount as number;
  if (submissionClaims < retryableFailureCount + relayDeferrals + unresolvedClaimCount) return null;

  return {
    schemaVersion: 1,
    adjudicationId: r.adjudicationId as string,
    localIntentId: r.localIntentId as string,
    paa1Base64: r.paa1Base64 as string,
    ssa1Base64: r.ssa1Base64 as string,
    oacEnvelopeBytesBase64: r.oacEnvelopeBytesBase64 as string,
    evidenceBindingDigest: r.evidenceBindingDigest as string,
    actionId: r.actionId as PrivilegedActionId,
    targetOrderId: r.targetOrderId as string,
    targetOrderUtc7Date: r.targetOrderUtc7Date as string,
    branchId: r.branchId as string,
    approvingManagerStaffId: r.approvingManagerStaffId as string,
    oacId: r.oacId as string,
    oacSchemaVersion: 1,
    revocationEpochAtIssue: r.revocationEpochAtIssue as number,
    managerAuthVersionAtIssue: r.managerAuthVersionAtIssue as number,
    managerCredentialVersionAtIssue: r.managerCredentialVersionAtIssue as number,
    nonce: r.nonce as string,
    approvalProofDigest: r.approvalProofDigest as string,
    attestationAttemptCount: r.attestationAttemptCount as number,
    approvalResult: 'APPROVED_LOCAL',
    trustedApprovalLowerMs: r.trustedApprovalLowerMs as number,
    trustedApprovalUpperMs: r.trustedApprovalUpperMs as number,
    pendingExecutionExpiresAtMs: r.pendingExecutionExpiresAtMs as number,
    syncStatus,
    manualReviewStatus: r.manualReviewStatus as PrivilegedManualReviewStatus,
    localTerminalReason: r.localTerminalReason as PrivilegedEvidenceLocalTerminalReason | null,
    submissionClaims,
    unresolvedClaimCount,
    retryableFailureCount,
    relayDeferrals,
    deferredCycleCount: r.deferredCycleCount as number,
    nextAttemptAtMs: r.nextAttemptAtMs as number,
    claimOwner: r.claimOwner as string | null,
    claimGeneration: r.claimGeneration as number | null,
    createdAtMs: r.createdAtMs as number,
    updatedAtMs: r.updatedAtMs as number,
    lastAttemptAtMs: r.lastAttemptAtMs as number | null,
    lastDispositionKind,
    lastRelayCallerStaffId: r.lastRelayCallerStaffId as string | null,
    lastCallerDependentStaffId: r.lastCallerDependentStaffId as string | null,
    integrityConflict: r.integrityConflict as boolean,
    ingestStaffId: r.ingestStaffId as string,
    ingestDeviceId: r.ingestDeviceId as string,
    resultingVoidIntentId: null,
    serverVerdict: r.serverVerdict as PrivilegedServerVerdict | null,
    serverReason: r.serverReason as string | null,
    serverAdjudicationId: r.serverAdjudicationId as string | null,
    serverTargetOrderId: r.serverTargetOrderId as string | null,
    offlineExecutionId: r.offlineExecutionId as string | null,
    outcomeKind: r.outcomeKind as OfflineAdjudicationOutcomeKind | null,
    serverAdjudicatedAtMs: r.serverAdjudicatedAtMs as number | null,
    serverObservedAtMs: r.serverObservedAtMs as number | null,
    serverIdempotentReplay: r.serverIdempotentReplay as boolean | null,
  };
}

/** Required-null / required-non-null field matrix, keyed by `lastDispositionKind`. */
function matchesDispositionMatrix(
  kind: PrivilegedEvidenceDispositionKind,
  r: Record<string, unknown>,
): boolean {
  const notNull = (...keys: string[]) => keys.every((k) => r[k] !== null);
  const isNull = (...keys: string[]) => keys.every((k) => r[k] === null);
  const ALL_SERVER_FIELDS = [
    'serverVerdict',
    'serverReason',
    'serverAdjudicationId',
    'serverTargetOrderId',
    'offlineExecutionId',
    'outcomeKind',
    'serverAdjudicatedAtMs',
    'serverObservedAtMs',
    'serverIdempotentReplay',
  ];

  switch (kind) {
    case 'ACCEPTED':
      return (
        r.syncStatus === 'SERVER_ACCEPTED' &&
        r.serverVerdict === 'ACCEPTED' &&
        notNull('serverAdjudicatedAtMs', 'serverAdjudicationId', 'serverTargetOrderId', 'offlineExecutionId', 'outcomeKind', 'serverIdempotentReplay') &&
        isNull('serverReason', 'serverObservedAtMs')
      );
    case 'REJECTED':
      return (
        r.syncStatus === 'SERVER_REJECTED' &&
        r.serverVerdict === 'REJECTED' &&
        typeof r.serverReason === 'string' &&
        isOfflineAdjudicationRejectionReason(r.serverReason) &&
        notNull('serverAdjudicatedAtMs', 'serverAdjudicationId', 'serverTargetOrderId', 'serverIdempotentReplay') &&
        isNull('offlineExecutionId', 'outcomeKind', 'serverObservedAtMs')
      );
    case 'MANUAL_ATTENTION_REQUIRED':
      return (
        r.syncStatus === 'MANUAL_ATTENTION' &&
        r.manualReviewStatus === 'REQUIRED' &&
        typeof r.serverReason === 'string' &&
        isOfflineAdjudicationManualAttentionReason(r.serverReason) &&
        notNull('serverAdjudicatedAtMs', 'serverAdjudicationId', 'serverTargetOrderId', 'serverIdempotentReplay') &&
        isNull('serverVerdict', 'offlineExecutionId', 'outcomeKind', 'serverObservedAtMs')
      );
    case 'ADJUDICATION_ANOMALY':
      return (
        r.syncStatus === 'MANUAL_ATTENTION' &&
        r.manualReviewStatus === 'REQUIRED' &&
        typeof r.serverReason === 'string' &&
        isOfflineAdjudicationAnomalyReason(r.serverReason) &&
        notNull('serverObservedAtMs', 'serverAdjudicationId', 'serverTargetOrderId') &&
        isNull('serverVerdict', 'serverAdjudicatedAtMs', 'offlineExecutionId', 'outcomeKind', 'serverIdempotentReplay')
      );
    case 'PROTOCOL_REJECTED_PERMANENT':
      return (
        r.syncStatus === 'MANUAL_ATTENTION' &&
        r.manualReviewStatus === 'REQUIRED' &&
        typeof r.serverReason === 'string' &&
        (OFFLINE_ADJUDICATION_PERMANENT_BYTE_REASONS as readonly string[]).includes(r.serverReason) &&
        isNull('serverVerdict', 'serverAdjudicatedAtMs', 'serverAdjudicationId', 'serverTargetOrderId', 'offlineExecutionId', 'outcomeKind', 'serverIdempotentReplay') &&
        // serverObservedAtMs is required-non-null (the response carries it even pre-authentication)
        r.serverObservedAtMs !== null
      );
    case 'PROTOCOL_REJECTED_STATE_DEPENDENT':
    case 'PROTOCOL_REJECTED_CALLER_DEPENDENT':
    case 'RETRYABLE':
    case 'PROTOCOL_RETRYABLE':
    case 'TRANSPORT_FAILURE':
      return r.syncStatus === 'PRIVILEGED_INTENT_QUEUED' && isNull(...ALL_SERVER_FIELDS);
    case 'LOCAL_SUBMISSION_TIMEOUT':
      return r.syncStatus === 'PRIVILEGED_INTENT_QUEUED' && isNull(...ALL_SERVER_FIELDS) && r.localTerminalReason === null;
    case 'LOCAL_TERMINAL':
      return (
        r.syncStatus === 'MANUAL_ATTENTION' &&
        r.manualReviewStatus === 'REQUIRED' &&
        isNull(...ALL_SERVER_FIELDS) &&
        typeof r.localTerminalReason === 'string' &&
        isLocalTerminalReason(r.localTerminalReason)
      );
    default:
      return false;
  }
}

// Re-export helpers other D-2 modules need without reaching into D-1B/D-1A directly.
export { isOfflineAdjudicationProtocolReason };
