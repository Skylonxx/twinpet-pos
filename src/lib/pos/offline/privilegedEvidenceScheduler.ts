/**
 * SEC-001 Packet D / D-2 — pure privileged-evidence admission scheduler.
 *
 * No I/O, no store access. Every function is deterministic given its inputs;
 * the only wall-clock input (`nowMs`) is a scheduling hint bounded by
 * `PRIVILEGED_EVIDENCE_S_MAX` (rule 7) — it can never gate eligibility
 * unboundedly, and it never decides deadline truth, fencing, or server
 * authority (WC-D2).
 */

import {
  PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES,
  PRIVILEGED_EVIDENCE_PER_CYCLE_CAP,
  PRIVILEGED_EVIDENCE_S_MAX,
  isPrivilegedEvidenceClaimFenced,
  type PrivilegedEvidenceJournalRecordV1,
} from './privilegedEvidenceTypes';

export interface PrivilegedEvidenceAdmissionInput {
  branchId: string;
  staffId: string;
  nowMs: number;
  /** The generation allocated by the CURRENT sweep (OP-1). */
  sweepGeneration: number;
}

/** Malformed/extreme stored values (non-finite, negative, beyond the clamp) read as 0. */
export function sanitizeNextAttemptAtMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

/**
 * The 7 final admission rules (Gemini 009 / Claude 004 §7.3). Rule 4 and the
 * F1 fencing half of rule 3 are NOT overridable by `S_MAX` — a row at the
 * retry ceiling, or a row legitimately fenced by a higher generation, is
 * outside the theorem's scope by construction, not merely withheld.
 */
export function isPrivilegedEvidenceRowAdmissible(
  row: PrivilegedEvidenceJournalRecordV1,
  input: PrivilegedEvidenceAdmissionInput,
): boolean {
  // rule 2 (parse + integrity are proven by the caller having a parsed row)
  if (row.integrityConflict) return false;
  // rule 3
  const statusAdmissible =
    row.syncStatus === 'PRIVILEGED_INTENT_QUEUED' ||
    (row.syncStatus === 'SYNCING' && isPrivilegedEvidenceClaimFenced(row.claimGeneration, input.sweepGeneration));
  if (!statusAdmissible) return false;
  // rule 4 — not overridable
  if (row.retryableFailureCount >= PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES) return false;
  // rule 5
  if (row.branchId !== input.branchId) return false;
  // rule 6, overridden by S_MAX (rule 7)
  const relaySuppressed = row.lastCallerDependentStaffId !== null && row.lastCallerDependentStaffId === input.staffId;
  // rule 7
  const forcedByStarvationGuard = row.deferredCycleCount >= PRIVILEGED_EVIDENCE_S_MAX;
  if (forcedByStarvationGuard) return true;
  if (relaySuppressed) return false;
  return sanitizeNextAttemptAtMs(row.nextAttemptAtMs) <= input.nowMs;
}

function compareNumeric(a: number, b: number): number {
  // Garbage (NaN) fields must fall through to the next tiebreaker rather
  // than short-circuiting the comparator into an inconsistent order: NaN is
  // never === itself, so a naive `!==` check would treat two NaN fields as
  // "different" while the subtraction that follows also yields NaN.
  const diff = a - b;
  return Number.isNaN(diff) ? 0 : diff;
}

/** `(deferredCycleCount desc, retryableFailureCount asc, createdAtMs asc, adjudicationId asc)`. */
export function comparePrivilegedEvidenceRows(
  a: PrivilegedEvidenceJournalRecordV1,
  b: PrivilegedEvidenceJournalRecordV1,
): number {
  const deferred = compareNumeric(b.deferredCycleCount, a.deferredCycleCount);
  if (deferred !== 0) return deferred;
  const retryable = compareNumeric(a.retryableFailureCount, b.retryableFailureCount);
  if (retryable !== 0) return retryable;
  const created = compareNumeric(a.createdAtMs, b.createdAtMs);
  if (created !== 0) return created;
  return a.adjudicationId < b.adjudicationId ? -1 : a.adjudicationId > b.adjudicationId ? 1 : 0;
}

export interface PrivilegedEvidenceSelection {
  admitted: PrivilegedEvidenceJournalRecordV1[];
  withheld: PrivilegedEvidenceJournalRecordV1[];
}

/** Filters + sorts + caps at `PRIVILEGED_EVIDENCE_PER_CYCLE_CAP`. Rows failing admission are `withheld`. */
export function selectAdmittedPrivilegedEvidenceRows(
  rows: readonly PrivilegedEvidenceJournalRecordV1[],
  input: PrivilegedEvidenceAdmissionInput,
): PrivilegedEvidenceSelection {
  const eligible = rows.filter((r) => isPrivilegedEvidenceRowAdmissible(r, input)).sort(comparePrivilegedEvidenceRows);
  const admitted = eligible.slice(0, PRIVILEGED_EVIDENCE_PER_CYCLE_CAP);
  const admittedIds = new Set(admitted.map((r) => r.adjudicationId));
  // "withheld" = every scanned non-terminal row that was NOT admitted this sweep,
  // including a non-reclaimable SYNCING row and rows cut by the per-cycle cap.
  const withheld = rows.filter((r) => !admittedIds.has(r.adjudicationId) && !isTerminal(r));
  return { admitted, withheld };
}

function isTerminal(row: PrivilegedEvidenceJournalRecordV1): boolean {
  return row.syncStatus === 'SERVER_ACCEPTED' || row.syncStatus === 'SERVER_REJECTED' || row.syncStatus === 'MANUAL_ATTENTION';
}

// ─── Backoff — mirrors syncOrchestrator's computeBackoffDelayMs formula ────
// Duplicated (not imported) to avoid a syncOrchestrator.ts <-> syncPrivilegedEvidence.ts
// module cycle; channel-adjacent modules never import the orchestrator (see
// syncOfflineReversals.ts). Values are identical to SYNC_ORCHESTRATOR_BACKOFF_*.

export const PRIVILEGED_EVIDENCE_BACKOFF_BASE_MS = 5_000;
export const PRIVILEGED_EVIDENCE_BACKOFF_MULTIPLIER = 2;
export const PRIVILEGED_EVIDENCE_BACKOFF_CAP_MS = 300_000;
export const PRIVILEGED_EVIDENCE_BACKOFF_JITTER_PERCENT = 20;

export function computePrivilegedEvidenceBackoffDelayMs(attemptNumber: number, random: () => number = Math.random): number {
  const exp = Math.min(
    PRIVILEGED_EVIDENCE_BACKOFF_BASE_MS * PRIVILEGED_EVIDENCE_BACKOFF_MULTIPLIER ** Math.max(0, attemptNumber - 1),
    PRIVILEGED_EVIDENCE_BACKOFF_CAP_MS,
  );
  const jitter = 1 + (random() * 2 - 1) * (PRIVILEGED_EVIDENCE_BACKOFF_JITTER_PERCENT / 100);
  return Math.max(0, Math.round(exp * jitter));
}
