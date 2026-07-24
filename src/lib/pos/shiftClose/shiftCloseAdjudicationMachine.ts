/**
 * shiftCloseAdjudicationMachine — pure, React-free state machine for the
 * manager adjudication action surface (Packet 5 / Client-UI-C). NO Firebase
 * imports → node-unit-testable. Consumed by `ShiftCloseAdjudicationPanel.tsx`.
 *
 * Implements the frozen R2 architecture (Architect\...ui-c-asbuilt-
 * architecture-plan-revision-r2-after-codex-rereview.md §7) and the frozen
 * DP1-DP4 product decisions (Gemini
 * TWINPET-P1-OFFLINE-SYNC-PACKET-5-UI-C-DP1-DP4-DECISION-GEMINI-001):
 *
 *   DP1 Option A — admin authority wider than the UI; no fake client security.
 *   DP2 Option A — one merged stale/busy state; no auto-retry; no timer.
 *   DP3 Option A — the manager affirmatively ADOPTS the alert's own frozen
 *     reason as their coded justification; no reason selector.
 *   DP4 R1/N1    — acknowledge is available with figures-not-displayed
 *     wording; resolve requires an unchecked-by-default external-evidence
 *     confirmation checkbox (never sent to the backend); an optional
 *     1000-UTF-16-unit note is available on both outcomes.
 *
 * Two DISTINCT predicates (R2 §7, replacing the withdrawn circular single
 * predicate):
 *   - `baseAvailability`     — pure current-state predicate, NO token. Governs
 *     whether the action panel/controls are offered at all and whether
 *     `idle -> confirming` may occur.
 *   - `decisionSnapshotFresh` — compares live state against an already-
 *     captured token. Never evaluated before a token exists.
 *
 * Final RC-4 adds `sourceScopeBindingValid`/`scopeBoundAvailability`: every
 * offer, dialog open, token capture, mint, freshness check, AND manual retry
 * (`retryAuthorityValid` — the final retry-scope remediation) additionally
 * requires the CURRENT live alert/case identities and alert branch to bind to
 * the CURRENT structured route/branch — stale prior-scope rows (e.g. from a
 * delimiter-colliding upstream reset key) can never act at ANY transport
 * boundary, first submit or retry alike. The request payload's `shiftId`
 * authority is exclusively `token.scopeKey.routeShiftId`.
 */

import {
  ACTIONABLE_ALERT_STATES,
  type AlertReasonCode,
  type AlertState,
  type ShiftCloseReviewRow,
} from './shiftCloseReviewRows';
import { validateRouteShiftId } from './shiftCloseDetailGate';
import type { IntegrityCaution, ProcessingState, SettlementState, ShiftCloseCaseProjection } from './shiftCloseDetailProjection';
import type {
  AdjudicationOutcome,
  AdjudicationRejectCode,
  ResolveShiftCloseAlertAdapterRequest,
  ResolveShiftCloseAlertAdapterResult,
  ValidatedResolveShiftCloseAlertResponse,
} from './resolveShiftCloseAlertAdapter';

export type { AdjudicationOutcome };

/** The processing states `baseAvailability` treats as stable (R2 §7.1 condition 14). */
const STABLE_PROCESSING_STATES: readonly ProcessingState[] = [
  'validated',
  'permanently_unverifiable',
  'requires_operator_review',
];

const RECOGNIZED_SETTLEMENT_STATES: readonly SettlementState[] = [
  'unsettled',
  'provisional_match',
  'manual_review_required',
  'manually_resolved',
];

export const MAX_REASON_NOTE_LENGTH = 1000;

// ---------------------------------------------------------------------------
// baseAvailability — pure current-state predicate, no token (R2 §7.1).
// ---------------------------------------------------------------------------

export type SourceReadiness = {
  status: 'disabled' | 'pending' | 'ready' | 'error';
  fromCache: boolean;
};

export type BaseAvailabilityInput = {
  alertSource: SourceReadiness;
  alertRow: ShiftCloseReviewRow | null;
  caseSource: SourceReadiness;
  caseProjection: ShiftCloseCaseProjection | null;
  integrityCautions: IntegrityCaution[];
};

/**
 * True only if ALL frozen conditions hold. Fails closed on anything unknown,
 * in-progress, cache-derived, malformed, or pairing-ambiguous. No token
 * argument — this predicate alone controls whether the panel is shown, and
 * whether `idle -> confirming` may occur.
 */
export function baseAvailability(input: BaseAvailabilityInput): boolean {
  const { alertSource, alertRow, caseSource, caseProjection, integrityCautions } = input;

  if (alertSource.status !== 'ready') return false;
  if (caseSource.status !== 'ready') return false;
  if (alertSource.fromCache) return false;
  if (caseSource.fromCache) return false;
  if (alertRow === null) return false;
  if (caseProjection === null) return false;
  if (!(ACTIONABLE_ALERT_STATES as readonly string[]).includes(alertRow.alertState)) return false;
  if (caseProjection.caseAlertStateUnknown) return false;
  if (alertRow.alertState !== caseProjection.caseAlertState) return false;
  if (alertRow.reasonCode === null || alertRow.reasonUnknown) return false;
  if (alertRow.caseVersion === null || !Number.isInteger(alertRow.caseVersion) || alertRow.caseVersion < 0) return false;
  if (caseProjection.caseVersion === null || !Number.isInteger(caseProjection.caseVersion) || caseProjection.caseVersion < 0) {
    return false;
  }
  if (alertRow.caseVersion !== caseProjection.caseVersion) return false;
  if (!STABLE_PROCESSING_STATES.includes(caseProjection.processingState as ProcessingState)) return false;
  if (caseProjection.settlementStateUnknown) return false;
  if (!RECOGNIZED_SETTLEMENT_STATES.includes(caseProjection.settlementState as SettlementState)) return false;
  if (integrityCautions.length !== 0) return false;

  return true;
}

/** open -> {acknowledge, resolve}; acknowledged -> {resolve} only. Caller must have already checked baseAvailability. */
export function availableOutcomes(alertState: AlertState | 'unknown'): readonly AdjudicationOutcome[] {
  if (alertState === 'open') return ['acknowledge', 'resolve'];
  if (alertState === 'acknowledged') return ['resolve'];
  return [];
}

// ---------------------------------------------------------------------------
// Source/scope binding — fail-closed live-row-to-current-scope identity check
// (final RC-4). Pure, structured, typed — never parses Firestore paths.
// ---------------------------------------------------------------------------

/**
 * True only when the CURRENT live rows verifiably belong to the CURRENT
 * structured scope (final RC-4). The upstream detail hook's render-reset key
 * is delimiter-concatenated and therefore not injective — two distinct
 * (branchId, routeShiftId) tuples containing `::` can collide and let
 * prior-scope rows survive one render under a newly changed scope. This
 * predicate is the adjudication boundary's own fail-closed rejection of that
 * window; it never trusts that the rows and the scope arrived together.
 *
 * Requires, using only existing typed identities (no path parsing, no
 * invented fields):
 *   - a non-empty, well-formed canonical route shift ID (the exact
 *     `validateRouteShiftId` convention — no re-decoding);
 *   - a non-empty, scoped canonical branch ID (never the `'ALL'` pseudo-branch);
 *   - the alert document ID equals the canonical route shift ID;
 *   - the case document ID equals the canonical route shift ID;
 *   - the alert row's stored branch equals the structured branch ID.
 *
 * (The case projection deliberately carries no branch field in this packet —
 * only typed identities that already exist are compared.)
 */
export function sourceScopeBindingValid(input: BaseAvailabilityInput, scopeKey: ScopeKey): boolean {
  const { alertRow, caseProjection } = input;
  if (!validateRouteShiftId(scopeKey.routeShiftId).ok) return false;
  if (!scopeKey.branchId || scopeKey.branchId === 'ALL') return false;
  if (alertRow === null || caseProjection === null) return false;
  if (alertRow.id !== scopeKey.routeShiftId) return false;
  if (caseProjection.id !== scopeKey.routeShiftId) return false;
  if (alertRow.branchId !== scopeKey.branchId) return false;
  return true;
}

/**
 * The full offer/open gate (final RC-4): frozen conditions 1-17
 * (`baseAvailability`) AND live-source-to-scope binding. This is what decides
 * whether the panel is offered, whether a dialog may open, and whether a
 * token may be captured. `baseAvailability` itself is unchanged (frozen R2
 * §7.1 contract, no scope argument); the binding is layered on top so stale
 * prior-scope rows can never offer, capture, mint, or call.
 */
export function scopeBoundAvailability(input: BaseAvailabilityInput, scopeKey: ScopeKey): boolean {
  return baseAvailability(input) && sourceScopeBindingValid(input, scopeKey);
}

// ---------------------------------------------------------------------------
// Decision snapshot token — captured ONLY after baseAvailability is true.
// ---------------------------------------------------------------------------

/**
 * Structured scope identity (RC-4) — deliberately NOT a delimiter-joined
 * string. A `::`-joined key is not injective: `branchId: 'A::B', routeShiftId:
 * 'C'` and `branchId: 'A', routeShiftId: 'B::C'` produced the identical
 * string. Every comparison must go through `scopeKeysEqual`'s exact
 * field-for-field equality instead of `===`/string equality.
 */
export interface ScopeKey {
  role: string | null;
  branchId: string;
  routeShiftId: string;
}

export function computeScopeKey(role: string | null | undefined, branchId: string | null | undefined, routeShiftId: string): ScopeKey {
  return { role: role ?? null, branchId: branchId ?? '', routeShiftId };
}

/** Exact structured comparison — never string/delimiter-based (RC-4). */
export function scopeKeysEqual(a: ScopeKey, b: ScopeKey): boolean {
  return a.role === b.role && a.branchId === b.branchId && a.routeShiftId === b.routeShiftId;
}

export interface DecisionSnapshotToken {
  scopeKey: ScopeKey;
  alertId: string;
  /** Final RC-4: the alert row's stored branch, frozen at capture and re-compared on every freshness check. */
  alertBranchId: string;
  alertState: AlertState;
  alertReasonCode: AlertReasonCode;
  alertCaseVersion: number;
  caseId: string;
  caseAlertState: AlertState;
  caseProcessingState: ProcessingState;
  caseSettlementState: SettlementState;
  caseVersion: number;
  integrityCautionFingerprint: string;
}

function cautionFingerprint(cautions: IntegrityCaution[]): string {
  return [...cautions].sort().join(',');
}

/**
 * Captures the immutable decision snapshot from the CURRENT state. Callers
 * must only invoke this once `scopeBoundAvailability(input, scopeKey)` is
 * true — it throws (a programmer-error guard, not a runtime/network
 * condition) otherwise, because a token built from an unavailable state OR
 * from rows not verifiably bound to the current scope (final RC-4) would
 * violate every downstream freshness guarantee.
 */
export function captureDecisionSnapshotToken(input: BaseAvailabilityInput, scopeKey: ScopeKey): DecisionSnapshotToken {
  if (!scopeBoundAvailability(input, scopeKey)) {
    throw new Error('captureDecisionSnapshotToken: scopeBoundAvailability must be true before capture');
  }
  const alertRow = input.alertRow!;
  const caseProjection = input.caseProjection!;
  return {
    scopeKey,
    alertId: alertRow.id,
    alertBranchId: alertRow.branchId,
    alertState: alertRow.alertState as AlertState,
    alertReasonCode: alertRow.reasonCode as AlertReasonCode,
    alertCaseVersion: alertRow.caseVersion as number,
    caseId: caseProjection.id,
    caseAlertState: caseProjection.caseAlertState as AlertState,
    caseProcessingState: caseProjection.processingState as ProcessingState,
    caseSettlementState: caseProjection.settlementState as SettlementState,
    caseVersion: caseProjection.caseVersion as number,
    integrityCautionFingerprint: cautionFingerprint(input.integrityCautions),
  };
}

/**
 * Post-capture freshness ONLY — never evaluated before a token exists.
 * Requires exact field-for-field equality against the live state, scope
 * equality, current `baseAvailability`, AND current live-source-to-scope
 * binding (final RC-4) — a live row that no longer verifiably belongs to the
 * current structured route/branch can never keep an existing token fresh, so
 * a new route authority is never paired with stale row reason/version/state.
 */
export function decisionSnapshotFresh(input: BaseAvailabilityInput, scopeKey: ScopeKey, token: DecisionSnapshotToken): boolean {
  if (!scopeBoundAvailability(input, scopeKey)) return false;
  if (!scopeKeysEqual(scopeKey, token.scopeKey)) return false;
  const alertRow = input.alertRow!;
  const caseProjection = input.caseProjection!;
  return (
    alertRow.id === token.alertId &&
    alertRow.branchId === token.alertBranchId &&
    alertRow.alertState === token.alertState &&
    alertRow.reasonCode === token.alertReasonCode &&
    alertRow.caseVersion === token.alertCaseVersion &&
    caseProjection.id === token.caseId &&
    caseProjection.caseAlertState === token.caseAlertState &&
    caseProjection.processingState === token.caseProcessingState &&
    caseProjection.settlementState === token.caseSettlementState &&
    caseProjection.caseVersion === token.caseVersion &&
    cautionFingerprint(input.integrityCautions) === token.integrityCautionFingerprint
  );
}

// ---------------------------------------------------------------------------
// Note validation (N1) — trim/omit semantics, 1000 UTF-16 code unit cap.
// ---------------------------------------------------------------------------

/** Trims whitespace; a post-trim empty string becomes `null` (omitted from the request). */
export function normalizeReasonNote(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Exactly MAX_REASON_NOTE_LENGTH (1000) UTF-16 code units is valid; 1001+ is rejected. */
export function isReasonNoteWithinLimit(raw: string): boolean {
  return raw.length <= MAX_REASON_NOTE_LENGTH;
}

// ---------------------------------------------------------------------------
// Command id minting — non-deterministic (real randomness), never re-used.
// ---------------------------------------------------------------------------

function mintCommandId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Machine state.
// ---------------------------------------------------------------------------

export type RetryableFailureKind = 'transport' | 'malformed' | 'server_error';

export type AdjudicationMachineState =
  | { status: 'idle' }
  | {
      status: 'confirming';
      outcome: AdjudicationOutcome;
      token: DecisionSnapshotToken;
      note: string;
      evidenceChecked: boolean;
    }
  | {
      status: 'submitting';
      outcome: AdjudicationOutcome;
      token: DecisionSnapshotToken;
      commandId: string;
      payload: ResolveShiftCloseAlertAdapterRequest;
    }
  | {
      status: 'retryable';
      outcome: AdjudicationOutcome;
      token: DecisionSnapshotToken;
      commandId: string;
      payload: ResolveShiftCloseAlertAdapterRequest;
      failureKind: RetryableFailureKind;
    }
  | { status: 'stale_or_busy' }
  | { status: 'terminal_conflict' }
  | {
      status: 'success';
      outcome: AdjudicationOutcome;
      adjudicationStatus: 'confirmed' | 'duplicate_confirmed';
      response: ValidatedResolveShiftCloseAlertResponse;
    }
  | { status: 'terminal_rejected'; outcome: AdjudicationOutcome; rejectCode: AdjudicationRejectCode };

export const initialAdjudicationMachineState: AdjudicationMachineState = { status: 'idle' };

// ---------------------------------------------------------------------------
// Transitions.
// ---------------------------------------------------------------------------

/**
 * idle -> confirming. Guard: `scopeBoundAvailability(live, scopeKey)` (final
 * RC-4 — frozen conditions 1-17 AND live-source-to-scope binding). No-op
 * (returns the same idle state) when unavailable — callers should not expose
 * the trigger when the panel is hidden, but the guard is defensive.
 */
export function openAdjudicationDialog(
  outcome: AdjudicationOutcome,
  live: BaseAvailabilityInput,
  scopeKey: ScopeKey,
): AdjudicationMachineState {
  if (!scopeBoundAvailability(live, scopeKey)) return { status: 'idle' };
  const token = captureDecisionSnapshotToken(live, scopeKey);
  return { status: 'confirming', outcome, token, note: '', evidenceChecked: false };
}

/** Update the draft note/checkbox while confirming. No-op outside `confirming`. */
export function updateAdjudicationDraft(
  state: AdjudicationMachineState,
  patch: { note?: string; evidenceChecked?: boolean },
): AdjudicationMachineState {
  if (state.status !== 'confirming') return state;
  return {
    ...state,
    note: patch.note ?? state.note,
    evidenceChecked: patch.evidenceChecked ?? state.evidenceChecked,
  };
}

/**
 * Re-checks the live state while `confirming` OR `retryable`.
 *
 * `confirming`: any listener/scope change that breaks availability or
 * freshness invalidates the dialog — discard the draft, return to `idle`.
 * No commandId was ever minted at this point, so there is nothing else to
 * abandon. (Unchanged behavior — not weakened by the retry extension.)
 *
 * `retryable` (final retry-scope remediation): a role/branch/route change or
 * a live source-binding break abandons the retry chain BEFORE any user
 * interaction — no actionable stale Retry control may survive a scope/source
 * change. Availability regressions that keep the same verified scope/rows
 * (e.g. a transient cache flip or a new integrity caution) deliberately do
 * NOT silently close the ambiguity dialog mid-read; the guarded retry
 * transition (`retryAuthorityValid`) still refuses transport for them.
 *
 * `submitting` stays untouched — the in-flight command is protected, and a
 * late result is scope-checked by `applyAdjudicationResult`.
 */
export function checkAdjudicationLiveInvalidation(
  state: AdjudicationMachineState,
  live: BaseAvailabilityInput,
  scopeKey: ScopeKey,
): AdjudicationMachineState {
  if (state.status === 'confirming') {
    if (!decisionSnapshotFresh(live, scopeKey, state.token)) return { status: 'idle' };
    return state;
  }
  if (state.status === 'retryable') {
    if (!scopeKeysEqual(scopeKey, state.token.scopeKey)) return { status: 'idle' };
    if (!sourceScopeBindingValid(live, scopeKey)) return { status: 'idle' };
    return state;
  }
  return state;
}

export type SubmitGuardFailure = 'not_confirming' | 'note_too_long' | 'evidence_not_checked' | 'stale_or_unavailable';

/**
 * First validated submit. Guard: input valid (note within 1000 UTF-16 units;
 * resolve requires the evidence checkbox) AND baseAvailability AND
 * decisionSnapshotFresh. Effect: mint commandId, freeze the payload FROM THE
 * TOKEN (never from possibly-drifted live state) -> submitting. No-op
 * (returns unchanged `confirming` state) on any guard failure — the caller
 * may inspect `validateAdjudicationSubmit` separately for the failure reason.
 */
export function validateAdjudicationSubmit(
  state: AdjudicationMachineState,
  live: BaseAvailabilityInput,
  scopeKey: ScopeKey,
): SubmitGuardFailure | null {
  if (state.status !== 'confirming') return 'not_confirming';
  if (!isReasonNoteWithinLimit(state.note)) return 'note_too_long';
  if (state.outcome === 'resolve' && !state.evidenceChecked) return 'evidence_not_checked';
  if (!decisionSnapshotFresh(live, scopeKey, state.token)) return 'stale_or_unavailable';
  return null;
}

/**
 * Mints the payload FROM THE TOKEN ONLY (RC-4, final): `shiftId` is read
 * EXCLUSIVELY from `state.token.scopeKey.routeShiftId` (the frozen canonical
 * route identity — never the alert document ID, which is a source identity,
 * not a route authority) and `branchId` from `state.token.scopeKey.branchId`.
 * Both are frozen at dialog-open time; no live caller-supplied route/branch
 * input can reach the payload after capture.
 */
export function submitAdjudication(
  state: AdjudicationMachineState,
  live: BaseAvailabilityInput,
  scopeKey: ScopeKey,
): AdjudicationMachineState {
  const failure = validateAdjudicationSubmit(state, live, scopeKey);
  if (failure !== null || state.status !== 'confirming') return state;

  const commandId = mintCommandId();
  const trimmedNote = normalizeReasonNote(state.note);
  const payload: ResolveShiftCloseAlertAdapterRequest = {
    commandId,
    shiftId: state.token.scopeKey.routeShiftId,
    branchId: state.token.scopeKey.branchId,
    expectedCaseVersion: state.token.caseVersion,
    requestedOutcome: state.outcome,
    reasonCode: state.token.alertReasonCode,
    // RC-1: omit the property entirely for an empty/whitespace-only note —
    // the deployed contract's `reasonNote?: string` rejects a present `null`.
    ...(trimmedNote !== null ? { reasonNote: trimmedNote } : {}),
  };
  return { status: 'submitting', outcome: state.outcome, token: state.token, commandId, payload };
}

/**
 * Applies a transport/adapter outcome to `submitting` or `retryable`. A
 * scope change since submission (role/branch/route/unmount) drops the late
 * result silently -> idle, never displaying a receipt for a scope the user
 * has already left. No-op outside `submitting`/`retryable`.
 */
export function applyAdjudicationResult(
  state: AdjudicationMachineState,
  result: ResolveShiftCloseAlertAdapterResult,
  currentScopeKey: ScopeKey,
): AdjudicationMachineState {
  if (state.status !== 'submitting' && state.status !== 'retryable') return state;
  if (!scopeKeysEqual(currentScopeKey, state.token.scopeKey)) return { status: 'idle' };

  if (result.kind === 'transport_failure') {
    return { status: 'retryable', outcome: state.outcome, token: state.token, commandId: state.commandId, payload: state.payload, failureKind: 'transport' };
  }
  if (result.kind === 'malformed_response') {
    return { status: 'retryable', outcome: state.outcome, token: state.token, commandId: state.commandId, payload: state.payload, failureKind: 'malformed' };
  }

  const { response } = result;
  if (response.status === 'confirmed' || response.status === 'duplicate_confirmed') {
    return { status: 'success', outcome: state.outcome, adjudicationStatus: response.status, response };
  }
  if (response.status === 'conflict_requires_manual_review') {
    // RC-3: only a genuine stale case version is data-drift "stale/busy".
    // `invalid_payload` here means the command/payload itself collided —
    // that is a distinct terminal state with no retry and no stale/busy copy.
    if (response.rejectCode === 'stale_case_version') {
      return { status: 'stale_or_busy' };
    }
    return { status: 'terminal_conflict' };
  }
  // response.status === 'rejected'
  if (response.rejectCode === 'server_error') {
    return { status: 'retryable', outcome: state.outcome, token: state.token, commandId: state.commandId, payload: state.payload, failureKind: 'server_error' };
  }
  return { status: 'terminal_rejected', outcome: state.outcome, rejectCode: response.rejectCode as AdjudicationRejectCode };
}

/**
 * Retry authority (final retry-scope remediation) — a manual same-command
 * retry may transport ONLY when:
 *   (a) the machine is actually in `retryable`;
 *   (b) the CURRENT structured scope exactly equals the retryable command's
 *       frozen scope (`scopeKeysEqual` — structured/injective, never a
 *       string join); and
 *   (c) the CURRENT live rows still pass the full scope-bound availability
 *       gate (frozen conditions 1-17 AND source/scope binding) — stale
 *       prior-scope rows, cache-derived sources, cautioned or unavailable
 *       states all fail closed.
 *
 * Decision-field freshness against the token is deliberately NOT required
 * here: the command is already minted, frozen, and idempotent, and manual
 * retry exists precisely to disambiguate a first attempt that may have
 * already changed server state. What retry must never do is leave its frozen
 * scope or act on rows that no longer verifiably belong to it.
 */
export function retryAuthorityValid(
  state: AdjudicationMachineState,
  live: BaseAvailabilityInput,
  scopeKey: ScopeKey,
): boolean {
  if (state.status !== 'retryable') return false;
  if (!scopeKeysEqual(scopeKey, state.token.scopeKey)) return false;
  if (!scopeBoundAvailability(live, scopeKey)) return false;
  return true;
}

/**
 * Manual, exact-command retry — SAME commandId, SAME payload (byte-for-byte,
 * no mutation, no re-mint). Only valid from `retryable`, and ONLY while
 * `retryAuthorityValid` holds for the CURRENT live state and CURRENT
 * structured scope (final retry-scope remediation): any role/branch/route
 * change or source-binding break since the command was frozen ABANDONS the
 * retry chain (-> `idle`) instead of transporting — never a silent rebase,
 * never a new commandId. No auto-retry exists anywhere in this module; this
 * is always an explicit caller-triggered action.
 */
export function retrySameAdjudicationCommand(
  state: AdjudicationMachineState,
  live: BaseAvailabilityInput,
  scopeKey: ScopeKey,
): AdjudicationMachineState {
  if (state.status !== 'retryable') return state;
  if (!retryAuthorityValid(state, live, scopeKey)) return { status: 'idle' };
  return { status: 'submitting', outcome: state.outcome, token: state.token, commandId: state.commandId, payload: state.payload };
}

/**
 * Explicit edit/new-decision: abandons any prior commandId and, if the live
 * state still permits it, recaptures a FRESH token and returns to
 * `confirming` with a blank draft. Valid from `retryable`, `terminal_rejected`,
 * `stale_or_busy`, or `success` (starting a new decision after seeing a
 * receipt). Falls back to `idle` if the live state no longer permits it.
 */
export function startNewAdjudicationDecision(
  state: AdjudicationMachineState,
  outcome: AdjudicationOutcome,
  live: BaseAvailabilityInput,
  scopeKey: ScopeKey,
): AdjudicationMachineState {
  if (state.status === 'confirming' || state.status === 'submitting') return state;
  return openAdjudicationDialog(outcome, live, scopeKey);
}

/** Close/dismiss/cancel — always abandons everything and returns to idle. */
export function closeAdjudicationDialog(): AdjudicationMachineState {
  return { status: 'idle' };
}
