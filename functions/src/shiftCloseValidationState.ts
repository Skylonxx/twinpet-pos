// Packet 5 / P5-B pure core — state transitions and the ordered
// cross-stream dedup / cursor advancement model. Pure, deterministic: no
// Admin SDK, no Firestore, no network, no time-now dependency (all "now"
// values are explicit parameters where relevant). This is model logic only —
// not a worker/scheduler runtime (P5-D scope).

import type { AlertActor, AlertReasonCode, AlertState, ErrorClassification, ProcessingState, SettlementState } from './shiftCloseValidationTypes';

// ---------------------------------------------------------------------------
// Alert projection delta — the exact frozen alert-state / actor / null
// contract (P5-A R4 §8.3, R5 §7.4). Every run/non-run transition returns one
// of these so a downstream caller (P5-C/P5-D) cannot fabricate an impossible
// alert projection.
//
// Frozen per-state null rules (R4 §8.3):
//   none        : reason null, both actors null            (openedAt null)
//   open        : reason non-null, both actors null        (openedAt non-null)
//   acknowledged: reason non-null, acknowledgedByActor = manager, resolvedByActor null
//   resolved    : reason non-null, resolvedByActor = system|manager,
//                 acknowledgedByActor nullable (manager if the alert was ever acknowledged)
// ---------------------------------------------------------------------------

export interface AlertProjectionDelta {
  alertState: AlertState;
  reasonCode: AlertReasonCode | null;
  acknowledgedByActor: AlertActor | null; // manager-only when present (system never acknowledges)
  resolvedByActor: AlertActor | null; // system or manager when present
}

/** Validates the frozen per-state actor/null rules. Impossible combinations return false. */
export function isValidAlertProjection(a: AlertProjectionDelta): boolean {
  switch (a.alertState) {
    case 'none':
      return a.reasonCode === null && a.acknowledgedByActor === null && a.resolvedByActor === null;
    case 'open':
      return a.reasonCode !== null && a.acknowledgedByActor === null && a.resolvedByActor === null;
    case 'acknowledged':
      return (
        a.reasonCode !== null &&
        a.acknowledgedByActor !== null &&
        a.acknowledgedByActor.kind === 'manager' &&
        a.resolvedByActor === null
      );
    case 'resolved':
      return (
        a.reasonCode !== null &&
        a.resolvedByActor !== null &&
        (a.resolvedByActor.kind === 'system' || a.resolvedByActor.kind === 'manager') &&
        (a.acknowledgedByActor === null || a.acknowledgedByActor.kind === 'manager')
      );
    default: {
      const exhaustive: never = a.alertState;
      throw new Error(`unreachable alert state: ${JSON.stringify(exhaustive)}`);
    }
  }
}

const ALERT_NONE: AlertProjectionDelta = {
  alertState: 'none',
  reasonCode: null,
  acknowledgedByActor: null,
  resolvedByActor: null,
};

function alertOpen(reasonCode: AlertReasonCode): AlertProjectionDelta {
  return { alertState: 'open', reasonCode, acknowledgedByActor: null, resolvedByActor: null };
}

// ---------------------------------------------------------------------------
// Verdict + cause -> (processingState, settlementState, errorClassification,
// alert projection) (P5-A R3 §8.2, R4 §8.2, R5 §7.4 reason-domain correction).
// ---------------------------------------------------------------------------

export interface RunTransitionResult {
  processingState: ProcessingState;
  settlementState: SettlementState;
  /** Always mirrors the run's errorClassification — null except for the five insufficient_evidence causes. */
  errorClassification: ErrorClassification | null;
  /** Exact frozen alert projection for this transition. */
  alert: AlertProjectionDelta;
}

/**
 * Prior alert context needed to compute a supersession correctly. A `match`
 * that supersedes a prior open/acknowledged alert resolves it (system actor)
 * while preserving the manager acknowledgement actor (R4 §8.3).
 */
export interface PriorAlert {
  alertState: AlertState;
  /** The manager acknowledgement actor, if the prior alert was acknowledged; else null. */
  acknowledgedByActor: AlertActor | null;
}

/**
 * `match` clears a prior open/acknowledged alert to `resolved` (system actor,
 * reason `superseding_match`, no fabricated manager UID), preserving the prior
 * manager acknowledgement actor if the alert had been acknowledged. With no
 * prior open/acknowledged alert, the alert is `none`.
 */
export function computeMatchTransition(prior: PriorAlert): RunTransitionResult {
  const superseding = prior.alertState === 'open' || prior.alertState === 'acknowledged';
  const alert: AlertProjectionDelta = superseding
    ? {
        alertState: 'resolved',
        reasonCode: 'superseding_match',
        acknowledgedByActor: prior.alertState === 'acknowledged' ? prior.acknowledgedByActor : null,
        resolvedByActor: { kind: 'system' },
      }
    : ALERT_NONE;
  return {
    processingState: 'validated',
    settlementState: 'provisional_match',
    errorClassification: null,
    alert,
  };
}

export function computeDiscrepancyTransition(): RunTransitionResult {
  return {
    processingState: 'validated',
    settlementState: 'manual_review_required',
    errorClassification: null,
    alert: alertOpen('drawer_discrepancy'),
  };
}

export function computeIdentityMismatchTransition(): RunTransitionResult {
  return {
    processingState: 'validated',
    settlementState: 'manual_review_required',
    errorClassification: null,
    alert: alertOpen('identity_mismatch'),
  };
}

/** `invalid_payload` — errorClassification MUST stay null; never widen it to include invalid_payload. */
export function computeInvalidPayloadTransition(): RunTransitionResult {
  return {
    processingState: 'permanently_unverifiable',
    settlementState: 'manual_review_required',
    errorClassification: null,
    alert: alertOpen('invalid_payload'),
  };
}

/**
 * `insufficient_evidence` dispatches on cause (P5-A R4 §8.2): structural
 * causes (evidence itself malformed/legacy-incomplete) -> permanently
 * unverifiable; operator/environment causes -> requires operator review.
 */
export function computeInsufficientEvidenceTransition(cause: ErrorClassification): RunTransitionResult {
  const structural: ReadonlySet<ErrorClassification> = new Set(['cash_entry_malformed', 'legacy_missing_required_field']);
  const processingState: ProcessingState = structural.has(cause) ? 'permanently_unverifiable' : 'requires_operator_review';
  return {
    processingState,
    settlementState: 'manual_review_required',
    errorClassification: cause,
    alert: alertOpen(cause),
  };
}

export type RunVerdictInput =
  | { verdict: 'match'; prior: PriorAlert }
  | { verdict: 'discrepancy' }
  | { verdict: 'identity_mismatch' }
  | { verdict: 'invalid_payload' }
  | { verdict: 'insufficient_evidence'; cause: ErrorClassification };

/** Single dispatch point over the frozen run-verdict transition table. */
export function computeRunTransition(input: RunVerdictInput): RunTransitionResult {
  switch (input.verdict) {
    case 'match':
      return computeMatchTransition(input.prior);
    case 'discrepancy':
      return computeDiscrepancyTransition();
    case 'identity_mismatch':
      return computeIdentityMismatchTransition();
    case 'invalid_payload':
      return computeInvalidPayloadTransition();
    case 'insufficient_evidence':
      return computeInsufficientEvidenceTransition(input.cause);
    default: {
      const exhaustive: never = input;
      throw new Error(`unreachable run verdict: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Transient-retry exhaustion (non-run event, P5-A R1 §10.5 / R3 §8.2):
 * `requires_operator_review` with an `open` alert (reason `retry_exhausted`)
 * and settlement explicitly UNCHANGED (the frozen "settlement unchanged" row).
 */
export interface NonRunTransitionResult {
  processingState: ProcessingState;
  /** Explicit marker: this non-run event does not change the case's settlementState. */
  settlementUnchanged: true;
  alert: AlertProjectionDelta;
}

export function computeRetryExhaustionTransition(): NonRunTransitionResult {
  return {
    processingState: 'requires_operator_review',
    settlementUnchanged: true,
    alert: alertOpen('retry_exhausted'),
  };
}

/**
 * Manager adjudication (P5-E contract, modeled here for actor/null
 * completeness): resolves the alert with a manager actor, preserving the
 * original open reason (caller-supplied — not a hardcoded reason, since a
 * manager resolves the pre-existing alert cause) and any prior manager
 * acknowledgement actor. Provided so a downstream caller reuses the same
 * validated projection shape rather than hand-building a resolved-by-manager
 * alert.
 */
export function computeManagerResolution(
  managerUid: string,
  originalReasonCode: AlertReasonCode,
  priorAcknowledged: AlertActor | null,
): AlertProjectionDelta {
  return {
    alertState: 'resolved',
    reasonCode: originalReasonCode,
    acknowledgedByActor: priorAcknowledged,
    resolvedByActor: { kind: 'manager', managerUid },
  };
}

// ---------------------------------------------------------------------------
// Ordered cross-stream dedup / cursor advancement model
// (P5-A R5 Defect 2 / Blocker B remediation, §8).
//
// "Cross-stream dedup" means no duplicate WORKER PROCESSING of the same case
// within one invocation — it never means cursor jumping. Each stream's
// cursor advances only through rows actually consumed at that stream's own
// ordered head. Processing a case via one stream never advances the other
// stream's cursor.
// ---------------------------------------------------------------------------

export type CaseId = string;

export type DurableOutcome = { kind: 'completed' } | { kind: 'deferred'; nextEligibleAt: number };

/** Per-invocation only — never persisted, never reused across invocations. */
export type InvocationResultCache = Map<CaseId, DurableOutcome>;

export function createInvocationResultCache(): InvocationResultCache {
  return new Map();
}

/** A stream's own fixed ordered universe of case ids for this step/cycle. */
export interface StreamOrder {
  orderedCaseIds: readonly CaseId[];
}

/**
 * Durable per-stream cursor (P5-A R5 §8.1/§8.3). Identified by the KEY of the
 * last row this stream actually returned-and-consumed, NOT by an index that
 * counts over skipped rows. `null` == cycle start (nothing consumed yet). The
 * cursor advances only TO a consumed row's key and never past a row the query
 * did not return — a removed/ineligible row causes no synthetic advance.
 */
export interface StreamCursor {
  lastConsumedCaseId: CaseId | null;
}

export interface EligibilityCheck {
  /** Mirrors a live Firestore query predicate: is this case still returned by THIS stream's query right now? */
  isEligible(caseId: CaseId): boolean;
}

export interface StepStreamParams {
  order: StreamOrder;
  cursor: StreamCursor;
  eligibility: EligibilityCheck;
  cache: InvocationResultCache;
  /** false => a budget/read-ceiling stop this invocation; the step must be a no-op. */
  budgetAvailable: boolean;
  /** Real processing work; called ONLY on a genuine cache miss for an eligible case. */
  process: (caseId: CaseId) => DurableOutcome;
}

export interface StepStreamResult {
  cursor: StreamCursor;
  processedCaseId: CaseId | null;
  outcome: DurableOutcome | null;
  /** true iff the result came from the per-invocation cache instead of a fresh `process` call. */
  fromCache: boolean;
  /** true iff the stream returned no eligible row after the cursor (exhaustion this step). */
  exhausted: boolean;
}

function indexAfterCursor(order: StreamOrder, cursor: StreamCursor): number {
  if (cursor.lastConsumedCaseId === null) return 0;
  const idx = order.orderedCaseIds.indexOf(cursor.lastConsumedCaseId);
  // A cursor whose key is no longer in the stream's ordered universe should not
  // reset traversal to the front; but within one fixed cycle the consumed key is
  // always present. Guard defensively: an unknown cursor key -> start of stream.
  return idx < 0 ? 0 : idx + 1;
}

/**
 * Advances exactly one stream by one step, honoring the frozen R5 §8.1/§8.3
 * invariants:
 *  - own-head-only advancement: only ever walks THIS stream's own
 *    `orderedCaseIds`/`cursor` — it cannot observe or mutate another stream's
 *    cursor (there is no shared state in the parameters).
 *  - cache reuse without reprocessing: if the next eligible row was already
 *    durably processed this invocation (cache hit), the cached outcome is
 *    reused and `process` is NOT called again (dedup); the cursor advances to
 *    that consumed row (it IS this stream's own returned head).
 *  - NO synthetic advancement on disappearance: a case no longer eligible for
 *    THIS stream (its durable completion cleared its query flag) is simply not
 *    returned. The cursor advances ONLY to the key of the row actually
 *    returned/consumed; skipped ineligible rows never become a persisted
 *    cursor value. If no eligible row remains after the cursor, the cursor is
 *    returned UNCHANGED (exhaustion) — never manufactured past absent rows.
 *  - budget stop: neither the cursor advances nor the cache is written; the
 *    same query is offered again, unchanged, next call.
 */
export function stepStream(params: StepStreamParams): StepStreamResult {
  const { order, cursor, eligibility, cache, budgetAvailable, process } = params;

  if (!budgetAvailable) {
    return { cursor, processedCaseId: null, outcome: null, fromCache: false, exhausted: false };
  }

  // The live query returns rows after the cursor that still match this stream's
  // predicate. Locally scanning past ineligible rows models the query's own
  // filtering — it does NOT persist any position; only the consumed row's key
  // is ever written back to the cursor.
  let index = indexAfterCursor(order, cursor);
  while (index < order.orderedCaseIds.length && !eligibility.isEligible(order.orderedCaseIds[index])) {
    index += 1;
  }

  if (index >= order.orderedCaseIds.length) {
    // No row returned by the query -> exhaustion. Cursor is returned UNCHANGED
    // (no synthetic advance past the removed/absent rows).
    return { cursor, processedCaseId: null, outcome: null, fromCache: false, exhausted: true };
  }

  const caseId = order.orderedCaseIds[index];
  const cached = cache.get(caseId);
  const outcome = cached ?? process(caseId);
  if (!cached) {
    cache.set(caseId, outcome);
  }

  return {
    cursor: { lastConsumedCaseId: caseId },
    processedCaseId: caseId,
    outcome,
    fromCache: Boolean(cached),
    exhausted: false,
  };
}

/** A fresh cycle-start cursor (nothing consumed yet). */
export function initialStreamCursor(): StreamCursor {
  return { lastConsumedCaseId: null };
}

/** Drains a stream to exhaustion (or budget stop) for test convenience — repeated `stepStream` calls. */
export function drainStream(
  order: StreamOrder,
  startCursor: StreamCursor,
  eligibility: EligibilityCheck,
  cache: InvocationResultCache,
  process: (caseId: CaseId) => DurableOutcome,
  budgetAvailable: (stepIndex: number) => boolean = () => true,
): { finalCursor: StreamCursor; steps: StepStreamResult[] } {
  let cursor = startCursor;
  const steps: StepStreamResult[] = [];
  let stepIndex = 0;
  for (;;) {
    const result = stepStream({
      order,
      cursor,
      eligibility,
      cache,
      budgetAvailable: budgetAvailable(stepIndex),
      process,
    });
    steps.push(result);
    if (result.processedCaseId === null) break;
    cursor = result.cursor;
    stepIndex += 1;
  }
  return { finalCursor: cursor, steps };
}
