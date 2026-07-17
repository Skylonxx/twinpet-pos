// Packet 5 / P5-D-1 — pure validation-worker decision core. Pure,
// deterministic: no Admin SDK network calls, no Firestore, no real
// clock/time-now reads (all "now" values are explicit parameters). The one
// exception is the `Timestamp` class import (a value type, `instanceof`-only
// use), the same precedent `shiftCloseEvidenceCaptureCore.ts` already uses.
//
// This module holds every P5-D-1 DECISION: what to write, never how/when to
// write it (that is `shiftCloseValidationWorker.ts`'s I/O-shell scope).
//
// Governing contracts (OneDrive Ai-Report\twinpet-pos\Architect, read-only):
//   ...-p5-d-worker-sweep-readonly-architecture-plan.md
//   ...-p5-d-worker-sweep-architecture-remediation-addendum.md            (B1-B7, GD9)
//   ...-p5-d-final-architecture-exactification-addendum.md                (Q7, B4, B8)
//   ...-p5-d-b1-lease-ownership-final-exactification-addendum.md          (Option A)
//   ...-p5-d-b1-t1-release-boundary-final-exactification-addendum.md      (F1 T1, F2 same-T3 release)
//   ...-p5-d-gate1-cursor-durability-final-exactification-addendum.md     (STOP_STREAM_UNOWNED)

import { Timestamp } from 'firebase-admin/firestore';
import {
  sha256Hex,
  encodeCanonicalStruct,
  computeInputsDigest,
  type CanonicalFieldValue,
} from './shiftCloseValidationHash';
import { orderManifestDocs, computeManifestDocsDigest } from './shiftCloseValidationManifest';
import {
  computeRunTransition,
  computeRetryExhaustionTransition,
  isValidAlertProjection,
  type AlertProjectionDelta,
  type PriorAlert,
  type RunVerdictInput,
} from './shiftCloseValidationState';
import {
  isRetryableFirestoreError,
  describeErrorCode,
  SCHEMA_VERSION,
} from './shiftCloseEvidenceCaptureCore';
import type {
  AlertReasonCode,
  AlertState,
  ErrorClassification,
  ProcessingState,
  SettlementState,
  ValidationVerdict,
  SourceManifest,
  SourceManifestDoc,
  SourceManifestCapReachedBySource,
  CashPairClassificationEntry,
} from './shiftCloseValidationTypes';

export type { ProcessingState };
import type { DeviceScopedFoldSummary } from './shiftCloseValidationDrawerFold';

export { isRetryableFirestoreError, describeErrorCode };

/**
 * [FROZEN, BF-4] Narrower than `isRetryableFirestoreError`: true ONLY for
 * the specific ABORTED contention signal (numeric 10 or string
 * `'aborted'`). Q7 recovery diagnostics must not mislabel
 * `deadline-exceeded` / `resource-exhausted` / `unavailable` — all also
 * members of the broader transient set — as CAS loss; only ABORTED is an
 * actual transaction-conflict signal.
 */
export function isCasContentionError(error: unknown): boolean {
  const code = describeErrorCode(error);
  if (typeof code === 'number') return code === 10;
  if (typeof code === 'string') return code.toLowerCase() === 'aborted';
  return false;
}

// ---------------------------------------------------------------------------
// Frozen constants.
// ---------------------------------------------------------------------------

export const VALIDATION_SCHEMA_VERSION = 1;
export const LEASE_DURATION_MS = 5 * 60 * 1000;
/** GD9 (Gemini-accepted): also reused as PERMANENT_ERROR_DEFER (Category-D). */
export const RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PERMANENT_ERROR_DEFER_MS = RECHECK_INTERVAL_MS;
export const MAX_REVALIDATION_ATTEMPTS = 10;
export const DEBOUNCE_MS = 60 * 1000;
/** [FROZEN, B2] 768 KiB — deliberately tighter than P5-C's 900 KiB evidence guard. */
export const RUN_PAYLOAD_GUARD_BYTES = 786_432;
export const MAX_SOURCE_DOCS = { asyncOrders: 500, orders: 500, cashTransactions: 200, creditPayments: 200 } as const;
export const WORST_CASE_CASE_READS = 1412;
export const READ_ADMISSION_CEILING = 17_000;
export const READ_TOTAL_CEILING = 20_000;
export const MAX_CASES_PER_INVOCATION = 25;

// ---------------------------------------------------------------------------
// P5-D-local sentinel (Gate-1 cursor/durability final addendum §11). Never a
// P5-B model, never persisted, never inserted into InvocationResultCache,
// caught only at the P5-D stream-drain adapter boundary.
// ---------------------------------------------------------------------------

export class StopStreamUnowned extends Error {
  readonly streamId: string;
  readonly caseId: string;
  readonly observedOwner: string | null;

  constructor(streamId: string, caseId: string, observedOwner: string | null) {
    super('StopStreamUnowned');
    this.name = 'StopStreamUnowned';
    this.streamId = streamId;
    this.caseId = caseId;
    this.observedOwner = observedOwner;
  }
}

// ---------------------------------------------------------------------------
// T1 — lease acquisition (pre-ownership; F1 final exactification). Pure
// decision over a freshly-read case snapshot: the caller supplies the
// snapshot read inside its own T1 Firestore transaction and applies the
// returned `caseUpdate` in that SAME transaction — no I/O happens here.
// ---------------------------------------------------------------------------

export interface T1CaseSnapshot {
  pendingRevalidation: boolean;
  selectedCloseHash: string | null;
  latestCloseHash: string;
  leaseOwner: string | null;
  /** null when no lease is held. */
  leaseExpiryMillis: number | null;
  nextEligibleAtMillis: number;
  caseVersion: number;
  sourceRevision: number;
  /** GD9 sweep-recheck admission: true while the case is within its 7-day late-event horizon. */
  sweepEligible: boolean;
  /** GD9 sweep-recheck admission: a resting selection to recheck (null before any selection exists). */
  selectedRunId: string | null;
}

export type T1Decision =
  | {
      kind: 'acquire';
      /** True iff this admission has no pending work and exists solely for the GD9/B3 periodic safety-net recheck of a resting selection. */
      isRecheck: boolean;
      caseUpdate: { leaseOwner: string; leaseExpiryMillis: number; processingState: 'validating'; caseVersion: number };
      expectedCaseVersion: number;
      targetSourceRevision: number;
      targetCloseHash: string;
      selectedRunId: string | null;
    }
  | { kind: 'skip_live_owner' }
  | { kind: 'not_admissible' };

/** Pending-work predicate (P5-D admission, plan §11.1). */
export function hasPendingWork(c: Pick<T1CaseSnapshot, 'pendingRevalidation' | 'selectedCloseHash' | 'latestCloseHash'>): boolean {
  return c.pendingRevalidation === true || c.selectedCloseHash !== c.latestCloseHash;
}

/**
 * GD9/B3 recheck-eligibility predicate: a case with NO pending work is still
 * admissible when it carries a resting selection within its late-event
 * horizon — this is the periodic safety-net recheck the sweep stream (Q6,
 * `sweepEligible == true`) exists to drive. Distinct from `hasPendingWork`:
 * the two predicates are mutually exclusive by construction (a case with
 * pending work is never treated as a recheck-only admission).
 */
export function isRecheckEligible(c: Pick<T1CaseSnapshot, 'pendingRevalidation' | 'selectedCloseHash' | 'latestCloseHash' | 'sweepEligible' | 'selectedRunId'>): boolean {
  return !hasPendingWork(c) && c.sweepEligible === true && c.selectedRunId !== null;
}

/**
 * T1 lease-acquisition decision (F1 final exactification §10-§11, extended
 * by the B3/GD9 sweep-recheck wiring). Before a successful commit the
 * invocation has no case-attempt accounting authority — this function's only
 * "failure" outputs are `skip_live_owner` / `not_admissible`, both zero-write,
 * zero-count by construction (the caller simply does not write on those
 * branches). A case is admitted either because it has pending work (normal
 * validation) or, with no pending work, because it is due for its periodic
 * GD9 safety-net recheck (`isRecheck: true`) — never both at once.
 */
export function decideT1Lease(params: { case: T1CaseSnapshot; nowMillis: number; invocationId: string }): T1Decision {
  const { case: c, nowMillis, invocationId } = params;
  const pendingWork = hasPendingWork(c);
  const recheckEligible = !pendingWork && isRecheckEligible(c);
  if ((!pendingWork && !recheckEligible) || c.nextEligibleAtMillis > nowMillis) return { kind: 'not_admissible' };
  const leaseFree = c.leaseOwner === null || (c.leaseExpiryMillis !== null && c.leaseExpiryMillis <= nowMillis);
  if (!leaseFree) return { kind: 'skip_live_owner' };
  const nextCaseVersion = c.caseVersion + 1;
  return {
    kind: 'acquire',
    isRecheck: recheckEligible,
    caseUpdate: {
      leaseOwner: invocationId,
      leaseExpiryMillis: nowMillis + LEASE_DURATION_MS,
      processingState: 'validating',
      caseVersion: nextCaseVersion,
    },
    expectedCaseVersion: nextCaseVersion,
    targetSourceRevision: c.sourceRevision,
    targetCloseHash: c.latestCloseHash,
    selectedRunId: c.selectedRunId,
  };
}

// ---------------------------------------------------------------------------
// T3 Gate 1/Gate 2/Gate 3 — the ownership + stale-revision branches (Gate-1
// cursor/durability final addendum §10, T1/release-boundary addendum §13).
// Evaluated INSIDE the flat T3 transaction, using values read in that same
// transaction. Gate 1 returns a pure internal result (never throws inside
// the callback); the adapter throws `StopStreamUnowned` only AFTER
// `runTransaction` resolves (Gate-1 addendum §10.1).
// ---------------------------------------------------------------------------

export interface T3CaseSnapshot {
  leaseOwner: string | null;
  caseVersion: number;
  sourceRevision: number;
}

export type T3GateResult =
  | { kind: 'OWNER_MISMATCH'; observedOwner: string | null }
  | {
      kind: 'STALE_REVISION_RELEASED';
      caseUpdate: { leaseOwner: null; leaseExpiryMillis: null; processingState: 'queued'; caseVersion: number };
    }
  | { kind: 'PROCEED' };

/** Gate 1 (ownership) then Gate 2 (stale revision, same-T3 four-field release, no nested transaction). */
export function evaluateT3Gates(params: {
  case: T3CaseSnapshot;
  self: string;
  expectedCaseVersion: number;
  targetSourceRevision: number;
}): T3GateResult {
  const { case: c, self, expectedCaseVersion, targetSourceRevision } = params;
  if (c.leaseOwner !== self) {
    return { kind: 'OWNER_MISMATCH', observedOwner: c.leaseOwner };
  }
  if (c.caseVersion !== expectedCaseVersion || c.sourceRevision !== targetSourceRevision) {
    return {
      kind: 'STALE_REVISION_RELEASED',
      caseUpdate: { leaseOwner: null, leaseExpiryMillis: null, processingState: 'queued', caseVersion: c.caseVersion + 1 },
    };
  }
  return { kind: 'PROCEED' };
}

/** Gate-1 cursor/durability addendum §16.2 — Gate-1 own-head consumption is a stream stop, never a DurableOutcome. */
export interface StreamStopState {
  stoppedStreams: Set<string>;
}

export function createStreamStopState(): StreamStopState {
  return { stoppedStreams: new Set() };
}

// ---------------------------------------------------------------------------
// Q7 — cause-agnostic, non-counting expired-lease recovery (final
// architecture addendum §9, unchanged by every later addendum).
// ---------------------------------------------------------------------------

export interface Q7CaseSnapshot {
  processingState: ProcessingState | string;
  leaseOwner: string | null;
  leaseExpiryMillis: number | null;
  caseVersion: number;
}

export type Q7Decision =
  | { kind: 'recover'; caseUpdate: { leaseOwner: null; leaseExpiryMillis: null; processingState: 'queued'; caseVersion: number } }
  | { kind: 'not_eligible' };

export function decideQ7Recovery(params: { case: Q7CaseSnapshot; nowMillis: number }): Q7Decision {
  const { case: c, nowMillis } = params;
  const eligible = c.processingState === 'validating' && c.leaseOwner !== null && c.leaseExpiryMillis !== null && c.leaseExpiryMillis <= nowMillis;
  if (!eligible) return { kind: 'not_eligible' };
  return {
    kind: 'recover',
    caseUpdate: { leaseOwner: null, leaseExpiryMillis: null, processingState: 'queued', caseVersion: c.caseVersion + 1 },
  };
}

// ---------------------------------------------------------------------------
// Retry / Category taxonomy (B1 final lease-ownership exactification §9-§11;
// classifier reused verbatim from the shipped P5-C module, no new taxonomy).
// ---------------------------------------------------------------------------

export type FailureCategory = 'A' | 'B' | 'D';

/** `isBudgetStop` must be decided by the caller (pre-admission / mid-case ceiling — not a Firestore error shape). */
export function classifyWorkerFailure(error: unknown, isBudgetStop: boolean): FailureCategory {
  if (isBudgetStop) return 'B';
  return isRetryableFirestoreError(error) ? 'A' : 'D';
}

export function computeBackoffMillis(attemptsAfterIncrement: number): number {
  return Math.min(60_000 * 2 ** attemptsAfterIncrement, 60 * 60 * 1000);
}

export interface CategoryAOutcome {
  caseUpdate: Record<string, unknown>;
  exhausted: boolean;
  alertTransition?: { projection: AlertProjectionDelta; reasonCode: AlertReasonCode };
}

/** Category A (coded transient / bounded CAS exhaustion), ownership-gated by the caller (only ever invoked while self-owned). */
export function buildCategoryAOutcome(params: { currentCaseVersion: number; attemptsBefore: number; nowMillis: number }): CategoryAOutcome {
  const attempts = params.attemptsBefore + 1;
  const exhausted = attempts >= MAX_REVALIDATION_ATTEMPTS;
  if (!exhausted) {
    return {
      exhausted: false,
      caseUpdate: {
        leaseOwner: null,
        leaseExpiry: null,
        processingState: 'retryable_error',
        revalidationAttempts: attempts,
        nextEligibleAtMillis: params.nowMillis + computeBackoffMillis(attempts),
        caseVersion: params.currentCaseVersion + 1,
      },
    };
  }
  const transition = computeRetryExhaustionTransition();
  return {
    exhausted: true,
    caseUpdate: {
      leaseOwner: null,
      leaseExpiry: null,
      processingState: transition.processingState,
      revalidationAttempts: attempts,
      nextEligibleAtMillis: params.nowMillis + PERMANENT_ERROR_DEFER_MS,
      caseVersion: params.currentCaseVersion + 1,
    },
    alertTransition: { projection: transition.alert, reasonCode: 'retry_exhausted' },
  };
}

/** Category D (permanent/local/programmer/unknown) — non-counting, `queued`, 24h defer, no alert/audit/run. */
export function buildCategoryDOutcome(params: { currentCaseVersion: number; nowMillis: number }): { caseUpdate: Record<string, unknown> } {
  return {
    caseUpdate: {
      leaseOwner: null,
      leaseExpiry: null,
      processingState: 'queued',
      nextEligibleAtMillis: params.nowMillis + PERMANENT_ERROR_DEFER_MS,
      caseVersion: params.currentCaseVersion + 1,
      // revalidationAttempts, pendingRevalidation: UNCHANGED — deliberately omitted.
    },
  };
}

// ---------------------------------------------------------------------------
// B3 — revision-consistent sweep-recheck comparison (equal / changed R->R+1).
// ---------------------------------------------------------------------------

export type RecheckComparison = { kind: 'equal' } | { kind: 'changed'; nextSourceRevision: number };

export function compareRecheckDigest(params: {
  candidateDigest: string;
  selectedRunInputsDigest: string;
  currentSourceRevision: number;
}): RecheckComparison {
  if (params.candidateDigest === params.selectedRunInputsDigest) return { kind: 'equal' };
  return { kind: 'changed', nextSourceRevision: params.currentSourceRevision + 1 };
}

/**
 * `priorProcessingState` MUST be the case's processing state as read at T1,
 * BEFORE T1's own acquisition write overwrote it to `'validating'` — the
 * equal path fully preserves the resting selection (Codex BF-6): an
 * unchanged `permanently_unverifiable`/`requires_operator_review` selection
 * must stay exactly that, never be silently normalized to `'validated'`.
 */
export function buildRecheckEqualCaseUpdate(params: {
  currentCaseVersion: number;
  lateEventHorizonUntilMillis: number;
  nowMillis: number;
  priorProcessingState: ProcessingState;
}): Record<string, unknown> {
  const sweepEligible = params.lateEventHorizonUntilMillis >= params.nowMillis;
  return {
    leaseOwner: null,
    leaseExpiry: null,
    processingState: params.priorProcessingState,
    nextEligibleAtMillis: params.nowMillis + RECHECK_INTERVAL_MS,
    sweepEligible,
    caseVersion: params.currentCaseVersion + 1,
  };
}

// ---------------------------------------------------------------------------
// GD7 — worker-core-local pure digest primitives over exported P5-B encoders
// (G1 Option A precedent; zero P5-B edits).
// ---------------------------------------------------------------------------

export function computeFoldSummaryDigest(fold: DeviceScopedFoldSummary, payInMinor: number, payOutMinor: number): string {
  const fields: ReadonlyArray<readonly [string, CanonicalFieldValue]> = [
    ['expectedCashMinor', fold.expectedCashMinor],
    ['expectedQrMinor', fold.expectedQrMinor],
    ['expectedKbankMinor', fold.expectedKbankMinor],
    ['expectedCardMinor', fold.expectedCardMinor],
    ['expectedCreditMinor', fold.expectedCreditMinor],
    ['payInMinor', payInMinor],
    ['payOutMinor', payOutMinor],
    ['totalBills', fold.totalBills],
    ['saleCount', fold.saleCount],
    ['foldBlocked', fold.foldBlocked],
    ['foldBlockReason', fold.foldBlockReason ?? null],
  ];
  return sha256Hex(encodeCanonicalStruct(fields));
}

export interface CreditDebtReceiptsObserved {
  cashTotalMinor: number;
  transferTotalMinor: number;
  count: number;
  linkedShiftIdCount: number;
  observedAsOfSourceRevision: number;
  classification: 'financially_relevant_not_in_frozen_expected';
}

export function computeCreditDebtReceiptsObservedDigest(o: CreditDebtReceiptsObserved): string {
  return sha256Hex(
    encodeCanonicalStruct([
      ['cashTotalMinor', o.cashTotalMinor],
      ['transferTotalMinor', o.transferTotalMinor],
      ['count', o.count],
      ['linkedShiftIdCount', o.linkedShiftIdCount],
      ['observedAsOfSourceRevision', o.observedAsOfSourceRevision],
      ['classification', o.classification],
    ]),
  );
}

export { computeInputsDigest };

export interface InputsDigestSnapshotComponents {
  tenderFold: DeviceScopedFoldSummary;
  payInMinor: number;
  payOutMinor: number;
  creditDebtReceiptsObserved: CreditDebtReceiptsObserved;
  sourceManifestFullDigest: string;
  /** Copied verbatim from the immutable evidence doc (P5-C-computed at capture) — never re-derived. */
  cashEntriesDigest: string;
  cashEntriesFullDigest: string;
  sourceEntryCount: number;
}

/**
 * Composes the full `inputsDigest` at an explicit source revision (B3 §11.1
 * DIFFERENT PATH step 3: "Recompute IN MEMORY every revision-bearing value
 * at R+1 ... pure recomputation — the non-revision components are unchanged
 * ... no Firestore re-read is needed"). Every component except
 * `sourceRevision` itself and `creditDebtReceiptsObserved.
 * observedAsOfSourceRevision` is revision-independent, so the caller reuses
 * one `InputsDigestSnapshotComponents` snapshot for both the sweep-recheck
 * comparison at the case's current revision R and the persisted run at R (a
 * normal attempt) or R+1 (a changed-digest recheck) — never re-reading
 * Firestore between the two calls.
 */
export function computeInputsDigestAtRevision(components: InputsDigestSnapshotComponents, sourceRevision: number): string {
  const foldSummaryDigest = computeFoldSummaryDigest(components.tenderFold, components.payInMinor, components.payOutMinor);
  const creditDebtReceiptsObservedDigest = computeCreditDebtReceiptsObservedDigest({
    ...components.creditDebtReceiptsObserved,
    observedAsOfSourceRevision: sourceRevision,
  });
  return computeInputsDigest({
    sourceManifestDigest: components.sourceManifestFullDigest,
    foldSummaryDigest,
    cashEntriesDigest: components.cashEntriesDigest,
    cashEntriesFullDigest: components.cashEntriesFullDigest,
    sourceEntryCount: components.sourceEntryCount,
    creditDebtReceiptsObservedDigest,
    sourceRevision,
  });
}

// ---------------------------------------------------------------------------
// B2 — truthful manifest size truncation (deterministic canonical prefix,
// dual digest, exact byte accounting, fail-closed).
// ---------------------------------------------------------------------------

export interface ManifestTruncationResult {
  storedDocs: readonly SourceManifestDoc[];
  manifestSizeTruncated: boolean;
  sourceManifestFullDigest: string;
  sourceManifestObservedDocsCount: number;
  sourceManifestStoredDocsCount: number;
}

/**
 * `runPayloadWithEmptyDocs` is the assembled run field map with
 * `sourceManifest.docs` set to `[]` — the caller measures the true baseline
 * so the prefix rule is exact accounting, not an average (B2 §10.1).
 */
export function truncateManifestForPayloadGuard(
  observedDocs: readonly SourceManifestDoc[],
  runPayloadWithEmptyDocs: unknown,
): ManifestTruncationResult {
  const ordered = orderManifestDocs(observedDocs);
  const sourceManifestFullDigest = computeManifestDocsDigest(observedDocs);
  const baselineBytes = Buffer.byteLength(JSON.stringify(runPayloadWithEmptyDocs), 'utf8');

  if (baselineBytes > RUN_PAYLOAD_GUARD_BYTES) {
    return {
      storedDocs: [],
      manifestSizeTruncated: true,
      sourceManifestFullDigest,
      sourceManifestObservedDocsCount: observedDocs.length,
      sourceManifestStoredDocsCount: 0,
    };
  }

  let budget = RUN_PAYLOAD_GUARD_BYTES - baselineBytes;
  const stored: SourceManifestDoc[] = [];
  for (const doc of ordered) {
    const cost = Buffer.byteLength(JSON.stringify(doc), 'utf8') + 1;
    if (cost > budget) break;
    stored.push(doc);
    budget -= cost;
  }

  return {
    storedDocs: stored,
    manifestSizeTruncated: stored.length < ordered.length,
    sourceManifestFullDigest,
    sourceManifestObservedDocsCount: observedDocs.length,
    sourceManifestStoredDocsCount: stored.length,
  };
}

export function buildSourceManifest(params: {
  storedDocs: readonly SourceManifestDoc[];
  capReachedBySource: SourceManifestCapReachedBySource;
  manifestSizeTruncated: boolean;
  computedAtCommitMicros: string;
}): SourceManifest {
  const anyCapReached = Object.values(params.capReachedBySource).some(Boolean);
  return {
    docs: params.storedDocs,
    pages: 1,
    truncated: anyCapReached || params.manifestSizeTruncated,
    capReachedBySource: params.capReachedBySource,
    snapshotConsistency: 'txn',
    computedAtCommitMicros: params.computedAtCommitMicros,
  };
}

// ---------------------------------------------------------------------------
// V1-V8 ordered verdict decision (B5-corrected: V6 -> invalid_payload).
// ---------------------------------------------------------------------------

export interface VerdictInputs {
  evidenceExists: boolean;
  evidenceIdentityMatches: boolean;
  legacyMissingRequiredField: boolean;
  capReachedAnySource: boolean;
  cashEntriesOverflowed: boolean;
  manifestSizeTruncated: boolean;
  cashEntriesFoldBlockingCount: number;
  tenderFoldBlocked: boolean;
  cashPairHasValueMismatch: boolean;
  drawerCashVerdict: 'match' | 'discrepancy' | 'insufficient_evidence';
  perFieldDeltasAllZero: boolean;
}

export type VerdictResult =
  | { verdict: 'insufficient_evidence'; cause: ErrorClassification }
  | { verdict: 'identity_mismatch' }
  | { verdict: 'invalid_payload' }
  | { verdict: 'match' }
  | { verdict: 'discrepancy' };

/** Ordered top-to-bottom, first match wins (plan §21.3-§21.6, corrected by first addendum §13). */
export function decideValidationVerdict(inputs: VerdictInputs): VerdictResult {
  if (!inputs.evidenceExists) return { verdict: 'insufficient_evidence', cause: 'dependency_unavailable' }; // V1
  if (!inputs.evidenceIdentityMatches) return { verdict: 'identity_mismatch' }; // V2
  if (inputs.legacyMissingRequiredField) return { verdict: 'insufficient_evidence', cause: 'legacy_missing_required_field' }; // V3
  if (inputs.capReachedAnySource || inputs.cashEntriesOverflowed || inputs.manifestSizeTruncated) {
    return { verdict: 'insufficient_evidence', cause: 'source_limit_exceeded' }; // V4
  }
  if (inputs.cashEntriesFoldBlockingCount > 0) return { verdict: 'insufficient_evidence', cause: 'cash_entry_malformed' }; // V5
  if (inputs.tenderFoldBlocked) return { verdict: 'invalid_payload' }; // V6 [B5-corrected]
  if (inputs.cashPairHasValueMismatch) return { verdict: 'insufficient_evidence', cause: 'cash_pair_value_mismatch' }; // V7
  if (inputs.drawerCashVerdict === 'match' && inputs.perFieldDeltasAllZero) return { verdict: 'match' }; // V8
  return { verdict: 'discrepancy' }; // V8
}

// ---------------------------------------------------------------------------
// B4 final — alert invariants (7 original + independent openedAt shape, #8)
// and the openedAt write rule (fresh on ->open, preserved on ->resolved,
// cleared on ->none). P5-B transition functions already return `open`
// regardless of prior state, so `resolved -> open` needs no extra P5-D
// transition logic — only this read-time invariant + write-time openedAt rule.
// ---------------------------------------------------------------------------

export interface AlertInvariantCaseView {
  branchId: string;
  caseVersion: number;
  alertState: AlertState;
}

export interface AlertInvariantAlertView {
  id: string;
  shiftId: string;
  branchId: unknown;
  schemaVersion: unknown;
  caseVersion: unknown;
  alertState: AlertState;
  reasonCode: unknown;
  acknowledgedByActor: unknown;
  resolvedByActor: unknown;
  openedAt: unknown;
}

export type AlertInvariantViolation =
  | 'doc_id_mismatch'
  | 'branch_mismatch'
  | 'schema_version_mismatch'
  | 'case_version_ahead'
  | 'invalid_projection_shape'
  | 'state_disagreement'
  | 'openedAt_invalid';

function isValidStoredTimestamp(value: unknown): value is Timestamp {
  if (!(value instanceof Timestamp)) return false;
  return Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds) && value.nanoseconds >= 0 && value.nanoseconds <= 999_999_999;
}

/** Independent worker-side openedAt invariant (final architecture addendum §11) — NOT `isValidAlertProjection`'s job. */
export function validateStoredOpenedAt(alertState: AlertState, openedAt: unknown): boolean {
  if (alertState === 'none') return openedAt === null;
  return isValidStoredTimestamp(openedAt);
}

export function validateAlertInvariants(
  caseView: AlertInvariantCaseView,
  alert: AlertInvariantAlertView,
): { ok: true } | { ok: false; violation: AlertInvariantViolation } {
  if (alert.id !== alert.shiftId) return { ok: false, violation: 'doc_id_mismatch' };
  if (alert.branchId !== caseView.branchId) return { ok: false, violation: 'branch_mismatch' };
  if (alert.schemaVersion !== SCHEMA_VERSION) return { ok: false, violation: 'schema_version_mismatch' };
  if (typeof alert.caseVersion !== 'number' || alert.caseVersion > caseView.caseVersion) {
    return { ok: false, violation: 'case_version_ahead' };
  }
  const projection: AlertProjectionDelta = {
    alertState: alert.alertState,
    reasonCode: (alert.reasonCode ?? null) as AlertProjectionDelta['reasonCode'],
    acknowledgedByActor: (alert.acknowledgedByActor ?? null) as AlertProjectionDelta['acknowledgedByActor'],
    resolvedByActor: (alert.resolvedByActor ?? null) as AlertProjectionDelta['resolvedByActor'],
  };
  if (!isValidAlertProjection(projection)) return { ok: false, violation: 'invalid_projection_shape' };
  if (caseView.alertState !== alert.alertState) return { ok: false, violation: 'state_disagreement' };
  if (!validateStoredOpenedAt(alert.alertState, alert.openedAt)) return { ok: false, violation: 'openedAt_invalid' };
  return { ok: true };
}

export type OpenedAtWrite = { kind: 'fresh' } | { kind: 'preserve' } | { kind: 'clear' };

/** New alertState solely determines the openedAt write (B4 final exactification §10). */
export function computeOpenedAtWrite(newAlertState: AlertState): OpenedAtWrite {
  if (newAlertState === 'open') return { kind: 'fresh' };
  if (newAlertState === 'none') return { kind: 'clear' };
  return { kind: 'preserve' };
}

export { computeRunTransition, computeRetryExhaustionTransition, type RunVerdictInput, type PriorAlert };

// ---------------------------------------------------------------------------
// Run / audit id builders + write-set assembly (Gate 3 normal selection).
// ---------------------------------------------------------------------------

const AUDIT_UNIT_SEP = String.fromCharCode(0x1f);

/** Shipped P5-C raw 0x1F join encoding (P5-D follows it verbatim — first addendum §14). */
export function computeP5DAuditEventId(params: { shiftId: string; eventKey: string; transitionType: string; targetCaseVersion: number }): string {
  return sha256Hex(
    ['shiftCloseAuditEvent', String(SCHEMA_VERSION), params.shiftId, params.eventKey, params.transitionType, String(params.targetCaseVersion)].join(
      AUDIT_UNIT_SEP,
    ),
  );
}

export function buildRunId(params: { shiftId: string; closeHash: string; sourceRevision: number }): string {
  return `${params.shiftId}_${params.closeHash}_${VALIDATION_SCHEMA_VERSION}_${params.sourceRevision}`;
}

export interface RunBuildInput {
  shiftId: string;
  branchId: string;
  closeHash: string;
  sourceRevision: number;
  validationVerdict: ValidationVerdict;
  errorClassification: ErrorClassification | null;
  drawerCashVerdict: 'match' | 'discrepancy' | 'insufficient_evidence';
  serverComputedDrawer: Record<string, number | null>;
  perFieldDeltas: Record<string, number | null>;
  creditDebtReceiptsObserved: CreditDebtReceiptsObserved;
  crossDeviceSalesObserved: { observed: boolean; count: number };
  cashPairClassification: readonly CashPairClassificationEntry[];
  sourceManifest: SourceManifest;
  manifestSizeTruncated: boolean;
  sourceManifestFullDigest: string;
  sourceManifestObservedDocsCount: number;
  sourceManifestStoredDocsCount: number;
  inputsDigest: string;
}

export function buildRunFields(input: RunBuildInput): { runId: string; evidenceId: string; fields: Record<string, unknown> } {
  const runId = buildRunId(input);
  const evidenceId = `${input.shiftId}_${input.closeHash}`;
  return {
    runId,
    evidenceId,
    fields: {
      runId,
      shiftId: input.shiftId,
      evidenceId,
      closeHash: input.closeHash,
      validationSchemaVersion: VALIDATION_SCHEMA_VERSION,
      sourceRevision: input.sourceRevision,
      completenessPosture: 'provisional',
      validationVerdict: input.validationVerdict,
      drawerCashVerdict: input.drawerCashVerdict,
      serverComputedDrawer: input.serverComputedDrawer,
      perFieldDeltas: input.perFieldDeltas,
      creditDebtReceiptsObserved: input.creditDebtReceiptsObserved,
      unlinkedCreditReceipts: { supported: false, reason: 'unlinked_credit_receipts_not_attributed' },
      crossDeviceSalesObserved: input.crossDeviceSalesObserved,
      cashPairClassification: input.cashPairClassification,
      sourceManifest: input.sourceManifest,
      manifestSizeTruncated: input.manifestSizeTruncated,
      sourceManifestFullDigest: input.sourceManifestFullDigest,
      sourceManifestObservedDocsCount: input.sourceManifestObservedDocsCount,
      sourceManifestStoredDocsCount: input.sourceManifestStoredDocsCount,
      inputsDigest: input.inputsDigest,
      errorClassification: input.errorClassification,
      mode: 'live',
      branchId: input.branchId,
      schemaVersion: SCHEMA_VERSION,
    },
  };
}

function bigIntMaxDecimal(a: string, b: string): string {
  const x = BigInt(a);
  const y = BigInt(b);
  return (x > y ? x : y).toString();
}

export function buildSelectionCaseUpdate(params: {
  runId: string;
  closeHash: string;
  sourceRevision: number;
  priorSelectedRunId: string | null;
  processingState: ProcessingState;
  settlementState: SettlementState;
  alertState: AlertState;
  computedAtCommitMicros: string;
  currentLastObservedCommitMicros: string;
  commitBoundaryDocKeys: readonly string[];
  currentCaseVersion: number;
  lateEventHorizonUntilMillis: number;
  nowMillis: number;
}): Record<string, unknown> {
  const sweepEligible = params.lateEventHorizonUntilMillis >= params.nowMillis;
  return {
    selectedRunId: params.runId,
    selectedCloseHash: params.closeHash,
    sourceRevision: params.sourceRevision,
    priorSelectedRunId: params.priorSelectedRunId,
    processingState: params.processingState,
    settlementState: params.settlementState,
    alertState: params.alertState,
    pendingRevalidation: false,
    revalidationAttempts: 0,
    lastObservedCommitMicros: bigIntMaxDecimal(params.currentLastObservedCommitMicros, params.computedAtCommitMicros),
    commitBoundaryDocKeys: params.commitBoundaryDocKeys,
    leaseOwner: null,
    leaseExpiry: null,
    nextEligibleAtMillis: sweepEligible ? params.nowMillis + RECHECK_INTERVAL_MS : params.nowMillis,
    sweepEligible,
    caseVersion: params.currentCaseVersion + 1,
  };
}

// ---------------------------------------------------------------------------
// Budget accounting (plan §20 — FROZEN bounds).
// ---------------------------------------------------------------------------

export function canAdmitAnotherCase(params: { consumedReads: number; admittedCases: number }): boolean {
  if (params.admittedCases >= MAX_CASES_PER_INVOCATION) return false;
  return params.consumedReads + WORST_CASE_CASE_READS <= READ_ADMISSION_CEILING;
}
