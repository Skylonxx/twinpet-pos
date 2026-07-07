import type { SaleIntentEntry, SaleIntentJournalStatus } from './saleIntentJournalTypes';

/** Statuses the sweep may inspect and potentially transition. */
export const SWEEP_CANDIDATE_STATUSES: readonly SaleIntentJournalStatus[] = [
  'queued',
  'flushed_to_cache',
  'exception_observed',
];

/** Statuses the sweep may count/report on but never auto-transitions. */
export const SWEEP_REPORT_ONLY_STATUSES: readonly SaleIntentJournalStatus[] = [
  'rejected_by_rules',
  'manual_review',
];

/** Age since `updatedAtLocal` before an entry is eligible for a server lookup. */
export const SWEEP_STALE_THRESHOLD_MS = 10 * 60 * 1000;

/** Bounded batch size so a single sweep pass can never scan unbounded history. */
export const SWEEP_DEFAULT_BATCH_LIMIT = 50;

export function isSweepCandidateStatus(status: SaleIntentJournalStatus): boolean {
  return SWEEP_CANDIDATE_STATUSES.includes(status);
}

export function isSweepReportOnlyStatus(status: SaleIntentJournalStatus): boolean {
  return SWEEP_REPORT_ONLY_STATUSES.includes(status);
}

export function isEntryStale(
  entry: Readonly<Pick<SaleIntentEntry, 'updatedAtLocal'>>,
  nowMs: number,
  thresholdMs: number = SWEEP_STALE_THRESHOLD_MS,
): boolean {
  const updatedMs = Date.parse(entry.updatedAtLocal);
  if (!Number.isFinite(updatedMs)) return false;
  return nowMs - updatedMs >= thresholdMs;
}

/** Classification of a candidate entry before any server lookup is attempted. */
export type SweepClassification = 'skip_status' | 'skip_fresh' | 'lookup_required';

export function classifyEntryForSweep(
  entry: Readonly<Pick<SaleIntentEntry, 'status' | 'updatedAtLocal'>>,
  nowMs: number,
  thresholdMs: number = SWEEP_STALE_THRESHOLD_MS,
): SweepClassification {
  if (!isSweepCandidateStatus(entry.status)) return 'skip_status';
  if (!isEntryStale(entry, nowMs, thresholdMs)) return 'skip_fresh';
  return 'lookup_required';
}

export type SelectSweepCandidatesOptions = {
  nowMs?: number;
  thresholdMs?: number;
  batchLimit?: number;
};

/** Deterministic, bounded selection of entries requiring a server lookup this pass. */
export function selectSweepCandidates(
  entries: readonly SaleIntentEntry[],
  options?: SelectSweepCandidatesOptions,
): SaleIntentEntry[] {
  const nowMs = options?.nowMs ?? Date.now();
  const thresholdMs = options?.thresholdMs ?? SWEEP_STALE_THRESHOLD_MS;
  const batchLimit = options?.batchLimit ?? SWEEP_DEFAULT_BATCH_LIMIT;

  const eligible = entries
    .filter((entry) => classifyEntryForSweep(entry, nowMs, thresholdMs) === 'lookup_required')
    .sort(
      (a, b) => a.createdAtLocal - b.createdAtLocal || a.asyncOrderId.localeCompare(b.asyncOrderId),
    );

  return eligible.slice(0, Math.max(0, batchLimit));
}

/** Normalized outcome of an asyncOrders server lookup, independent of the data source. */
export type SweepLookupOutcome =
  | { kind: 'exists' }
  | { kind: 'missing' }
  | { kind: 'error'; reason: string };

/** Recommended action after a lookup has resolved for a stale candidate. */
export type SweepDecision =
  | 'acknowledge_server_exists'
  | 'no_transition_exception_observed_server_exists'
  | 'no_transition_missing_ambiguous'
  | 'no_transition_lookup_error';

/**
 * Turns a normalized lookup outcome into a bounded, matrix-safe decision.
 * Ambiguity (missing docs, lookup errors) never resolves to an automatic
 * rejected_by_rules or server_acknowledged verdict, and exception_observed
 * never auto-transitions to server_acknowledged (not a legal matrix edge).
 */
export function decideSweepAction(
  entry: Readonly<Pick<SaleIntentEntry, 'status'>>,
  outcome: SweepLookupOutcome,
): SweepDecision {
  if (outcome.kind === 'error') return 'no_transition_lookup_error';
  if (outcome.kind === 'missing') return 'no_transition_missing_ambiguous';

  if (entry.status === 'exception_observed') {
    return 'no_transition_exception_observed_server_exists';
  }
  return 'acknowledge_server_exists';
}

const KNOWN_LOOKUP_ERROR_REASONS = new Set(['permission-denied', 'unauthenticated', 'unavailable']);

function extractErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'unknown';
}

/** Normalizes a thrown/rejected lookup error into a safe, ambiguous outcome. */
export function normalizeLookupError(err: unknown): SweepLookupOutcome {
  const code = extractErrorCode(err);
  return { kind: 'error', reason: KNOWN_LOOKUP_ERROR_REASONS.has(code) ? code : 'unknown' };
}

export type SweepReportOnlyCounts = {
  rejectedByRules: number;
  manualReview: number;
};

/** Read-only diagnostic counts; never used to drive a transition. */
export function countReportOnlyEntries(entries: readonly SaleIntentEntry[]): SweepReportOnlyCounts {
  let rejectedByRules = 0;
  let manualReview = 0;
  for (const entry of entries) {
    if (entry.status === 'rejected_by_rules') rejectedByRules += 1;
    else if (entry.status === 'manual_review') manualReview += 1;
  }
  return { rejectedByRules, manualReview };
}
