/**
 * SEC-001 Packet E / E-1 — privileged-void flow state machine.
 *
 * Controlling authority: `TWINPET-TRUE-STANDALONE-SEC-001-PACKET-E-ARCHITECTURE-ADJUDICATION-GEMINI-017`.
 * `GD_E_001_DECISION: OPTION_A_ONE_D3_SEAM`, `GD_E_008_DECISION: OPTION_A_E_LEG_A`.
 *
 * Pure, React-free, I/O-free — no Firestore, no durable-store call, no D-3
 * call. All I/O (the D-2 precheck read and the D-3 projection call) is
 * performed by `src/hooks/pos/usePrivilegedVoidFlow.ts`, the sole production
 * owner of `projectPrivilegedOfflineAction`, and fed back through the
 * transitions below. This mirrors the codebase's existing pure-machine
 * convention (`shiftCloseAdjudicationMachine.ts`).
 *
 * GD-E-004 (`IMMUTABLE_CAPTURE_PLUS_PRE_PROJECTION_REVALIDATION`): flow
 * identity is captured once, at `openPrivilegedVoidFlow`, and revalidated
 * immediately before projection (`beginProjecting`). A branch/operator/
 * order/action/manager/auth mismatch NEVER silently retargets — it refuses
 * into `LOCAL_FAILURE` instead.
 *
 * Local-intent lifetime (Section 5, closed by RC-E1-005):
 *   - invalid-PIN retry within the same manager/flow keeps the same
 *     `localIntentId` (`applyProjectionOutcome`'s `not_approved` branch);
 *   - a manager CHANGE — a manager was already bound and a DIFFERENT one is
 *     now chosen, including via `PIN(A) -> back/cancel -> select(B)` —
 *     mints a new `localIntentId` (`chooseManager`); re-picking the SAME
 *     manager (initial pick, or after backing out and reselecting it) keeps
 *     the same one;
 *   - close/reopen mints a new `localIntentId` (`openPrivilegedVoidFlow` is
 *     always called with a fresh mint by the caller);
 *   - after a durable capture (`projected`/`already_projected`), the old
 *     intent is never reused — the flow is already terminal.
 */

import type { PrivilegedActionId } from '../../auth/privilegedAction/privilegedActionTypes';
import type { ProjectPrivilegedOfflineActionOutcome } from '../offline/projectPrivilegedOfflineAction';
import type {
  PrivilegedEvidenceD2SyncStatus,
  PrivilegedEvidenceJournalRecordV1,
} from '../offline/privilegedEvidenceTypes';
import type { PrivilegedManualReviewStatus } from '../../auth/privilegedAction/privilegedActionTypes';
import type { ActiveRowPrecheckOutcome, SafeActiveRowSummary } from './privilegedVoidActiveRow';

// ---------------------------------------------------------------------------
// Identity — immutable capture + revalidation surface (GD-E-004).
// ---------------------------------------------------------------------------

export interface PrivilegedVoidFlowIdentity {
  /** Non-timestamp-only local intent id (see `mintPrivilegedVoidLocalIntentId`). */
  localIntentId: string;
  actionId: PrivilegedActionId;
  targetOrderId: string;
  targetOrderUtc7Date: string;
  targetBranchId: string;
  operatorStaffId: string;
  managerStaffId: string | null;
}

export interface PrivilegedVoidOrderRef {
  actionId: PrivilegedActionId;
  targetOrderId: string;
  targetOrderUtc7Date: string;
  targetBranchId: string;
  operatorStaffId: string;
}

/** The CURRENT live values `beginProjecting` revalidates identity against. */
export interface PrivilegedVoidLiveContext {
  branchId: string | null;
  operatorStaffId: string | null;
  authSessionActive: boolean;
  selectedOrderId: string | null;
  selectedOrderBranchId: string | null;
  expectedActionId: PrivilegedActionId | null;
  /**
   * RC-E1-003 — the CURRENT row's void eligibility (same-day window +
   * pending/settled `decideAction`/`settledVoidEligible` classification),
   * recomputed fresh at the moment of the final pre-D-3 gate. `false` fails
   * closed into `LOCAL_FAILURE`/`stale_context` exactly like any other
   * identity mismatch — it never silently proceeds on a row that became
   * ineligible, voided, or day-expired since the modal opened.
   */
  currentVoidEligible: boolean;
}

function mintUuidLike(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Non-timestamp-only fallback: includes randomness, not just Date.now().
  return `pvi-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** Single source of truth for minting a `localIntentId`. Never timestamp-only. */
export function mintPrivilegedVoidLocalIntentId(): string {
  return mintUuidLike();
}

function revalidateIdentity(identity: PrivilegedVoidFlowIdentity, live: PrivilegedVoidLiveContext): boolean {
  if (!live.authSessionActive) return false;
  if (!live.branchId || live.branchId === 'ALL') return false;
  if (identity.targetBranchId !== live.branchId) return false;
  if (!live.operatorStaffId || identity.operatorStaffId !== live.operatorStaffId) return false;
  if (!live.selectedOrderId || identity.targetOrderId !== live.selectedOrderId) return false;
  if (!live.selectedOrderBranchId || identity.targetBranchId !== live.selectedOrderBranchId) return false;
  if (!live.expectedActionId || identity.actionId !== live.expectedActionId) return false;
  if (!identity.managerStaffId) return false;
  if (!live.currentVoidEligible) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Safe (non-sensitive) captured-record projection (Section 14).
// ---------------------------------------------------------------------------

export interface SafeCapturedRecordSummary {
  adjudicationId: string;
  localIntentId: string;
  actionId: PrivilegedActionId;
  targetOrderId: string;
  targetOrderUtc7Date: string;
  branchId: string;
  approvingManagerStaffId: string;
  syncStatus: PrivilegedEvidenceD2SyncStatus;
  manualReviewStatus: PrivilegedManualReviewStatus;
  createdAtMs: number;
  updatedAtMs: number;
}

function safeRecordSummary(record: PrivilegedEvidenceJournalRecordV1): SafeCapturedRecordSummary {
  return {
    adjudicationId: record.adjudicationId,
    localIntentId: record.localIntentId,
    actionId: record.actionId,
    targetOrderId: record.targetOrderId,
    targetOrderUtc7Date: record.targetOrderUtc7Date,
    branchId: record.branchId,
    approvingManagerStaffId: record.approvingManagerStaffId,
    syncStatus: record.syncStatus,
    manualReviewStatus: record.manualReviewStatus,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
  };
}

// ---------------------------------------------------------------------------
// Machine state.
// ---------------------------------------------------------------------------

export type PrivilegedVoidLocalFailureReason =
  | 'unavailable'
  | 'durable_unavailable'
  | 'integrity_conflict'
  | 'stale_context'
  | 'denied_locked'
  | 'denied_stale'
  | 'denied_unverifiable'
  | 'denied_unknown';

// ---------------------------------------------------------------------------
// RC-E1-004 — closed D-1B denial classifier.
// ---------------------------------------------------------------------------

/** The landed D-1B/native invalid-PIN code — the ONLY denial retryable in the same PIN step/same `localIntentId`. */
const DENIED_INVALID_PIN_CODE = 'DENIED_INVALID_PIN';
const LOCKED_DENIAL_CODES: ReadonlySet<string> = new Set(['DENIED_LOCKED', 'TOO_MANY_ATTEMPTS']);
const STALE_DENIAL_CODES: ReadonlySet<string> = new Set(['DENIED_STALE', 'CREDENTIAL_STALE']);
const UNVERIFIABLE_DENIAL_CODES: ReadonlySet<string> = new Set(['DENIED_UNVERIFIABLE', 'APPROVAL_UNAVAILABLE']);

export type PrivilegedVoidPinDenialClass = 'retry_same_intent' | 'locked' | 'stale' | 'unverifiable' | 'unknown';

/**
 * RC-E1-004 — closed classifier over the landed D-1B `errorCode` vocabulary.
 * Only `DENIED_INVALID_PIN` is safely retryable in place. Every other known
 * code (locked/attempt-ceiling, stale/credential-stale, unverifiable/native
 * absent, or any structural denial such as `MANAGER_NOT_AUTHORIZED`,
 * `SERVER_REJECTED`, or the legacy-PIN4 codes) plus any unrecognized/unknown/
 * null code falls into the generic terminal fail-closed bucket. This is a
 * CLOSED classification — the default is always terminal, never retryable.
 */
export function classifyPinDenial(errorCode: string | null): PrivilegedVoidPinDenialClass {
  if (errorCode === DENIED_INVALID_PIN_CODE) return 'retry_same_intent';
  if (errorCode != null && LOCKED_DENIAL_CODES.has(errorCode)) return 'locked';
  if (errorCode != null && STALE_DENIAL_CODES.has(errorCode)) return 'stale';
  if (errorCode != null && UNVERIFIABLE_DENIAL_CODES.has(errorCode)) return 'unverifiable';
  return 'unknown';
}

export type PrivilegedVoidFlowState =
  | { status: 'IDLE' }
  | { status: 'PRECHECK'; identity: PrivilegedVoidFlowIdentity }
  | { status: 'VOID_REASON_ENTRY'; identity: PrivilegedVoidFlowIdentity; reason: string; note: string }
  | { status: 'MANAGER_SELECT'; identity: PrivilegedVoidFlowIdentity; reason: string; note: string }
  | {
      status: 'MANAGER_PIN_ENTRY';
      identity: PrivilegedVoidFlowIdentity;
      reason: string;
      note: string;
      pinErrorCode: string | null;
    }
  | { status: 'PROJECTING'; identity: PrivilegedVoidFlowIdentity; reason: string; note: string }
  | { status: 'CAPTURED_PENDING_ADJUDICATION'; identity: PrivilegedVoidFlowIdentity; record: SafeCapturedRecordSummary }
  | { status: 'TERMINAL_SERVER_ACCEPTED'; identity: PrivilegedVoidFlowIdentity; row: SafeActiveRowSummary }
  | { status: 'TERMINAL_SERVER_REJECTED'; identity: PrivilegedVoidFlowIdentity; row: SafeActiveRowSummary }
  | { status: 'MANUAL_ATTENTION'; identity: PrivilegedVoidFlowIdentity; row: SafeActiveRowSummary }
  | { status: 'LOCAL_FAILURE'; identity: PrivilegedVoidFlowIdentity; reasonCode: PrivilegedVoidLocalFailureReason }
  | { status: 'LOCAL_UNCERTAIN'; identity: PrivilegedVoidFlowIdentity }
  | { status: 'RECOVERED_ACTIVE'; identity: PrivilegedVoidFlowIdentity; row: SafeActiveRowSummary | null };

export const initialPrivilegedVoidFlowState: PrivilegedVoidFlowState = { status: 'IDLE' };

// ---------------------------------------------------------------------------
// Transitions.
// ---------------------------------------------------------------------------

/** IDLE -> PRECHECK. Mints a fresh `localIntentId` via the caller-supplied minter. No-op (stays IDLE) on a malformed order ref. */
export function openPrivilegedVoidFlow(
  order: PrivilegedVoidOrderRef,
  mintLocalIntentId: () => string,
): PrivilegedVoidFlowState {
  if (!order.targetBranchId || order.targetBranchId === 'ALL') return { status: 'IDLE' };
  if (!order.targetOrderId || !order.operatorStaffId || !order.targetOrderUtc7Date) return { status: 'IDLE' };
  const identity: PrivilegedVoidFlowIdentity = {
    localIntentId: mintLocalIntentId(),
    actionId: order.actionId,
    targetOrderId: order.targetOrderId,
    targetOrderUtc7Date: order.targetOrderUtc7Date,
    targetBranchId: order.targetBranchId,
    operatorStaffId: order.operatorStaffId,
    managerStaffId: null,
  };
  return { status: 'PRECHECK', identity };
}

/**
 * Applies a D-2 active-row precheck result. Valid from `PRECHECK` (initial
 * open), `RECOVERED_ACTIVE` (reconciling a `duplicate_target` race — see
 * `applyProjectionOutcome`), and `LOCAL_UNCERTAIN` (Section 7 reconciliation
 * gate). No-op from any other state.
 *
 * RC-E1-002 purity: this function never mints anything itself. `freshLocalIntentId`
 * is an ALREADY-MINTED value the caller (`usePrivilegedVoidFlow.runPrecheck`)
 * produces once per resolved precheck, outside any `setState` updater —
 * this function only decides, deterministically, whether the LOCAL_UNCERTAIN
 * -> fresh-flow branch below actually needs it. When that branch is not
 * taken the value is simply unused; no I/O or randomness happens in here.
 */
export function applyActiveRowPrecheck(
  state: PrivilegedVoidFlowState,
  outcome: ActiveRowPrecheckOutcome,
  freshLocalIntentId: string,
): PrivilegedVoidFlowState {
  if (state.status !== 'PRECHECK' && state.status !== 'RECOVERED_ACTIVE' && state.status !== 'LOCAL_UNCERTAIN') {
    return state;
  }
  const { identity } = state;

  if (outcome.kind === 'integrity_fault') {
    return { status: 'LOCAL_FAILURE', identity, reasonCode: 'integrity_conflict' };
  }

  // Section 7 — reconciliation from LOCAL_UNCERTAIN may resume ONLY once the
  // durable read succeeds, unreadableCount is 0, AND no open target row
  // exists; a fresh flow then gets a NEW localIntentId, never the old one.
  const freshFlowFromUncertain = (): PrivilegedVoidFlowState => ({
    status: 'VOID_REASON_ENTRY',
    identity: { ...identity, localIntentId: freshLocalIntentId, managerStaffId: null },
    reason: '',
    note: '',
  });

  if (outcome.kind === 'clear') {
    if (state.status === 'LOCAL_UNCERTAIN') return freshFlowFromUncertain();
    return { status: 'VOID_REASON_ENTRY', identity, reason: '', note: '' };
  }
  if (outcome.kind === 'active_open') {
    return { status: 'RECOVERED_ACTIVE', identity, row: outcome.row };
  }
  if (outcome.kind === 'terminal_accepted') {
    return { status: 'TERMINAL_SERVER_ACCEPTED', identity, row: outcome.row };
  }
  if (outcome.kind === 'manual_attention') {
    return { status: 'MANUAL_ATTENTION', identity, row: outcome.row };
  }
  // outcome.kind === 'terminal_rejected' — never blocks a fresh attempt
  // (mirrors D-3's own S1 pre-guard), but is surfaced as a real outcome when
  // this exact target was already being watched (post-duplicate/uncertain
  // reconciliation) rather than silently discarded.
  if (state.status === 'PRECHECK') {
    return { status: 'VOID_REASON_ENTRY', identity, reason: '', note: '' };
  }
  if (state.status === 'LOCAL_UNCERTAIN') return freshFlowFromUncertain();
  return { status: 'TERMINAL_SERVER_REJECTED', identity, row: outcome.row };
}

/** VOID_REASON_ENTRY -> MANAGER_SELECT. Guard: non-empty reason. */
export function submitReason(
  state: PrivilegedVoidFlowState,
  reason: string,
  note: string,
): PrivilegedVoidFlowState {
  if (state.status !== 'VOID_REASON_ENTRY') return state;
  if (!reason.trim()) return state;
  return { status: 'MANAGER_SELECT', identity: state.identity, reason: reason.trim(), note: note.trim() };
}

/**
 * RC-E1-002 §4.1 — the exact pre-transition preconditions the caller
 * captured OUTSIDE the updater (from the render/closure that decided
 * `newLocalIntentId`, if any) before invoking `chooseManager`. The updater
 * below refuses to apply a decision computed against a state the machine has
 * since moved past.
 */
export interface ChooseManagerExpectedPreconditions {
  expectedStatus: 'MANAGER_SELECT' | 'MANAGER_PIN_ENTRY';
  expectedLocalIntentId: string;
  expectedPriorManagerStaffId: string | null;
}

/**
 * MANAGER_SELECT -> MANAGER_PIN_ENTRY. Binds `managerStaffId` into `identity`.
 *
 * RC-E1-005 — what decides whether a NEW `localIntentId` is needed is
 * whether a manager was ALREADY bound on this flow's identity and is now
 * being replaced by a DIFFERENT one — never which status (`MANAGER_SELECT`
 * vs `MANAGER_PIN_ENTRY`) the call came from. This is what makes the real UI
 * path `PIN(A) -> back/cancel -> MANAGER_SELECT -> select(B)` mint a new
 * intent: `backToManagerSelect` returns to `MANAGER_SELECT` WITHOUT clearing
 * `identity.managerStaffId`, so this function still sees the prior binding
 * and can tell "B is a change from A" apart from "no manager bound yet":
 *   - unbound -> A (first pick): same intent.
 *   - A -> back -> A (re-pick the SAME manager): same intent.
 *   - A -> back -> B (a DIFFERENT manager): a new intent.
 * Guard: non-empty `managerStaffId`; only ever chosen from the roster, never
 * free-text (enforced by the caller/UI, not this pure function).
 *
 * RC-E1-002/RC-E1-005 purity: this function never mints anything itself.
 * `newLocalIntentId` is decided and (if needed) minted by the caller
 * (`usePrivilegedVoidFlow.chooseManager`) from state read OUTSIDE any
 * functional updater, then passed in already-minted.
 *
 * RC-E1-002 §4.2 — stale-decision guard. `expected` is the state the caller
 * captured at the moment it decided `newLocalIntentId`. If the machine's
 * CURRENT status, `localIntentId`, or prior `managerStaffId` no longer match
 * that captured snapshot, the decision was computed against state this
 * machine has already moved past — the whole call is a no-op (`cur`
 * returned unchanged), never partially applied. This is what stops a
 * retained/stale callback (closed over an old manager/intent pair) from
 * writing a mismatched `{managerStaffId, localIntentId}` pair onto NEWER
 * state committed by a later, non-stale call.
 *
 * RC-E1-002 §4.3 — machine-level defensive invariant, independent of the
 * guard above: a real manager change (one already bound, a DIFFERENT one
 * requested) with no candidate `newLocalIntentId` supplied must never switch
 * managers — it would silently retain the OLD `localIntentId` under the NEW
 * `managerStaffId`, exactly the mismatched pair RC-E1-005 forbids. Fail
 * closed (no-op) instead.
 */
export function chooseManager(
  state: PrivilegedVoidFlowState,
  managerStaffId: string,
  newLocalIntentId: string | null,
  expected: ChooseManagerExpectedPreconditions,
): PrivilegedVoidFlowState {
  if (!managerStaffId) return state;
  if (state.status !== 'MANAGER_SELECT' && state.status !== 'MANAGER_PIN_ENTRY') return state;

  if (state.status !== expected.expectedStatus) return state;
  if (state.identity.localIntentId !== expected.expectedLocalIntentId) return state;
  if (state.identity.managerStaffId !== expected.expectedPriorManagerStaffId) return state;

  const priorManagerStaffId = state.identity.managerStaffId;
  const isManagerChange = priorManagerStaffId !== null && priorManagerStaffId !== managerStaffId;

  // Re-picking the same manager while already in MANAGER_PIN_ENTRY is a no-op.
  if (state.status === 'MANAGER_PIN_ENTRY' && !isManagerChange) return state;

  // §4.3 — never switch managers on a real change with no candidate intent.
  if (isManagerChange && !newLocalIntentId) return state;

  const localIntentId = isManagerChange ? newLocalIntentId! : state.identity.localIntentId;

  return {
    status: 'MANAGER_PIN_ENTRY',
    identity: { ...state.identity, managerStaffId, localIntentId },
    reason: state.reason,
    note: state.note,
    pinErrorCode: null,
  };
}

/** MANAGER_PIN_ENTRY -> MANAGER_SELECT. Cancel PIN entry without discarding the manager binding's `localIntentId` — a later re-pick of the SAME manager keeps it. */
export function backToManagerSelect(state: PrivilegedVoidFlowState): PrivilegedVoidFlowState {
  if (state.status !== 'MANAGER_PIN_ENTRY') return state;
  return { status: 'MANAGER_SELECT', identity: state.identity, reason: state.reason, note: state.note };
}

/**
 * MANAGER_PIN_ENTRY -> PROJECTING, gated by GD-E-004 revalidation against the
 * CURRENT live context. A staleness mismatch fails closed into
 * `LOCAL_FAILURE` (`stale_context`) — it never silently retargets the
 * in-flight identity to the new live values.
 */
export function beginProjecting(
  state: PrivilegedVoidFlowState,
  live: PrivilegedVoidLiveContext,
): PrivilegedVoidFlowState {
  if (state.status !== 'MANAGER_PIN_ENTRY') return state;
  if (!revalidateIdentity(state.identity, live)) {
    return { status: 'LOCAL_FAILURE', identity: state.identity, reasonCode: 'stale_context' };
  }
  return { status: 'PROJECTING', identity: state.identity, reason: state.reason, note: state.note };
}

/**
 * Applies the D-3 `projectPrivilegedOfflineAction` outcome (Section 8's
 * closed 8-member mapping). `duplicate_target` resolves to `RECOVERED_ACTIVE`
 * with `row: null` — the caller must re-run `precheckActiveRowForTarget` and
 * feed the result back through `applyActiveRowPrecheck` to refine it.
 */
export function applyProjectionOutcome(
  state: PrivilegedVoidFlowState,
  outcome: ProjectPrivilegedOfflineActionOutcome,
): PrivilegedVoidFlowState {
  if (state.status !== 'PROJECTING') return state;
  const { identity } = state;
  switch (outcome.kind) {
    case 'projected':
    case 'already_projected':
      return { status: 'CAPTURED_PENDING_ADJUDICATION', identity, record: safeRecordSummary(outcome.record) };
    case 'duplicate_target':
      return { status: 'RECOVERED_ACTIVE', identity, row: null };
    case 'not_approved': {
      const denialClass = classifyPinDenial(outcome.errorCode ?? null);
      if (denialClass === 'retry_same_intent') {
        // Same local intent retained — an invalid-PIN retry within the same
        // manager/flow must not mint a new one.
        return {
          status: 'MANAGER_PIN_ENTRY',
          identity,
          reason: state.reason,
          note: state.note,
          pinErrorCode: outcome.errorCode ?? 'not_approved',
        };
      }
      // RC-E1-004 — every other denial class (locked, stale, unverifiable,
      // or unknown/unrecognized) is terminal/fail-closed for THIS attempt:
      // it never re-prompts the same PIN in place and never routes to a
      // legacy/online fallback. A fresh flow is required.
      const reasonCode: PrivilegedVoidLocalFailureReason =
        denialClass === 'locked'
          ? 'denied_locked'
          : denialClass === 'stale'
            ? 'denied_stale'
            : denialClass === 'unverifiable'
              ? 'denied_unverifiable'
              : 'denied_unknown';
      return { status: 'LOCAL_FAILURE', identity, reasonCode };
    }
    case 'unavailable':
      return { status: 'LOCAL_FAILURE', identity, reasonCode: 'unavailable' };
    case 'durable_unavailable':
      return { status: 'LOCAL_FAILURE', identity, reasonCode: 'durable_unavailable' };
    case 'integrity_conflict':
      return { status: 'LOCAL_FAILURE', identity, reasonCode: 'integrity_conflict' };
    case 'uncertain':
      return { status: 'LOCAL_UNCERTAIN', identity };
  }
}

/** Always resets to IDLE. Reopening mints a brand new `localIntentId` (Section 5 — close/reopen => new local intent). */
export function closePrivilegedVoidFlow(): PrivilegedVoidFlowState {
  return { status: 'IDLE' };
}
