/**
 * SEC-001 Packet E / E-1 — the sole production owner of
 * `projectPrivilegedOfflineAction` (PVC-1). No other production file may
 * import or call the D-3 seam; see `privilegedVoidConfinement.test.ts`.
 *
 * Owns all I/O the pure `privilegedVoidFlowMachine.ts` needs fed back to it:
 * the D-2 active-row precheck read (`precheckActiveRowForTarget`) and the
 * D-3 projection call itself. Duplicate-submit is closed at four layers
 * (Section 10): `ManagerPinModal.isSubmitting` (caller-supplied), the flow
 * machine's own state (only `MANAGER_PIN_ENTRY` may enter `PROJECTING`), the
 * `inFlightRef` guard below, and D-2's own atomic target exclusion
 * (`expectNoOpenRowForTarget`, inside `projectPrivilegedOfflineAction`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../lib/hooks/useAuth';
import { useApproverRoster, type ApproverRosterState } from '../../lib/auth/useApproverRoster';
import { createIndexedDbReversalStore } from '../../lib/pos/offline/reversalLocalStore';
import { projectPrivilegedOfflineAction } from '../../lib/pos/offline/projectPrivilegedOfflineAction';
import { precheckActiveRowForTarget } from '../../lib/pos/privilegedVoid/privilegedVoidActiveRow';
import {
  applyActiveRowPrecheck,
  applyProjectionOutcome,
  backToManagerSelect as backToManagerSelectTransition,
  beginProjecting,
  chooseManager as chooseManagerTransition,
  closePrivilegedVoidFlow,
  initialPrivilegedVoidFlowState,
  mintPrivilegedVoidLocalIntentId,
  openPrivilegedVoidFlow,
  submitReason as submitReasonTransition,
  type ChooseManagerExpectedPreconditions,
  type PrivilegedVoidFlowIdentity,
  type PrivilegedVoidFlowState,
  type PrivilegedVoidLiveContext,
  type PrivilegedVoidOrderRef,
} from '../../lib/pos/privilegedVoid/privilegedVoidFlowMachine';
import type { PrivilegedActionId } from '../../lib/auth/privilegedAction/privilegedActionTypes';

export interface PrivilegedVoidLiveSelection {
  orderId: string | null;
  orderBranchId: string | null;
  expectedActionId: PrivilegedActionId | null;
  /**
   * RC-E1-003 — recomputed fresh at the moment of the final pre-D-3 gate
   * (never cached/memoized against render time), so a same-day-window
   * expiry or a row becoming ineligible/voided between modal-open and
   * PIN-submit is caught even with no other re-render in between.
   */
  isCurrentlyVoidEligible: () => boolean;
}

export interface UsePrivilegedVoidFlowParams {
  /** The CURRENTLY selected order in the caller's list, re-read every render — powers GD-E-004 revalidation. */
  liveSelection: PrivilegedVoidLiveSelection;
}

export interface UsePrivilegedVoidFlowResult {
  state: PrivilegedVoidFlowState;
  roster: ApproverRosterState;
  isSubmitting: boolean;
  open: (order: PrivilegedVoidOrderRef) => void;
  submitReason: (reason: string, note: string) => void;
  chooseManager: (managerStaffId: string) => void;
  backToManagerSelect: () => void;
  submitPin: (pin: string) => void;
  close: () => void;
  retryReconciliation: () => void;
}

export function usePrivilegedVoidFlow(params: UsePrivilegedVoidFlowParams): UsePrivilegedVoidFlowResult {
  const { user, branchId } = useAuth();
  const [state, setState] = useState<PrivilegedVoidFlowState>(initialPrivilegedVoidFlowState);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inFlightRef = useRef(false);
  // RC-E1-002 — the `localIntentId` a D-2 precheck read is currently running
  // for, or `null` when none is in flight. Acquired/released OUTSIDE any
  // `setState` updater (see `runPrecheck`), so it collapses duplicate
  // reconciliation requests for the same intent into one durable read
  // regardless of how many times a caller asks (manual retry double-clicks,
  // the post-`duplicate_target` effect, StrictMode's double effect-fire).
  const reconciliationInFlightRef = useRef<string | null>(null);

  // RC-E1-002-FRESH-001 / RC-E1-005-FRESH-001 — synchronous authority
  // epoch/generation gate. `authorityEpochRef` is the single source of
  // truth for "which authority attempt is current"; `epochAtRender` is the
  // value every callback created THIS render closes over. A callback proves
  // it still belongs to the current authority attempt by checking its
  // captured epoch against the ref BEFORE any mint / submit-guard
  // acquisition / state mutation / D-3 launch — a mismatch means either a
  // same-render sibling call, or a retained call from an earlier render,
  // already consumed the authority this callback was captured for, so it is
  // a full no-op. Every accepted (non-stale) call that actually performs an
  // authority-bearing action consumes the epoch synchronously, in the
  // callback body, OUTSIDE any `setState` updater (matching the file's
  // established purity pattern) — never for a call that turns out to be a
  // true no-op (e.g. re-picking an already-bound manager), since that would
  // falsely stale-out this render's OTHER, still-current callbacks even
  // though nothing actually happened.
  const authorityEpochRef = useRef(0);
  const epochAtRender = authorityEpochRef.current;
  const tryAcquireAuthorityEpoch = useCallback((): boolean => {
    if (authorityEpochRef.current !== epochAtRender) return false;
    authorityEpochRef.current = epochAtRender + 1;
    return true;
  }, [epochAtRender]);

  const {
    orderId: selectedOrderId,
    orderBranchId: selectedOrderBranchId,
    expectedActionId,
    isCurrentlyVoidEligible,
  } = params.liveSelection;

  const currentLiveContext = useCallback((): PrivilegedVoidLiveContext => {
    return {
      branchId: branchId ?? null,
      operatorStaffId: user?.id ?? null,
      authSessionActive: !!user,
      selectedOrderId,
      selectedOrderBranchId,
      expectedActionId,
      currentVoidEligible: isCurrentlyVoidEligible(),
    };
  }, [branchId, user, selectedOrderId, selectedOrderBranchId, expectedActionId, isCurrentlyVoidEligible]);

  // RC-E1-002 — every side effect here (the in-flight guard, the durable
  // store construction, the D-2 read launch, and the `.then()`'s own mint)
  // runs OUTSIDE the `setState` updater below. The updater itself only
  // compares `cur` against the captured `outcome`/`freshLocalIntentId` and
  // returns a deterministic next state — a StrictMode replay of just that
  // updater can never re-launch the read or re-mint anything.
  const runPrecheck = useCallback((identity: PrivilegedVoidFlowIdentity) => {
    if (reconciliationInFlightRef.current === identity.localIntentId) return;
    reconciliationInFlightRef.current = identity.localIntentId;
    const store = createIndexedDbReversalStore();
    void precheckActiveRowForTarget(store, identity.targetBranchId, identity.targetOrderId)
      .then((outcome) => {
        // Minted once per resolved read, outside the updater — used by
        // `applyActiveRowPrecheck` only if its LOCAL_UNCERTAIN-clears-fresh
        // branch actually applies; otherwise simply unused.
        const freshLocalIntentId = mintPrivilegedVoidLocalIntentId();
        setState((cur) => {
          if (cur.status !== 'PRECHECK' && cur.status !== 'RECOVERED_ACTIVE' && cur.status !== 'LOCAL_UNCERTAIN') {
            return cur;
          }
          // Stale-response guard: discard a precheck answer for an intent the
          // flow has already moved on from (closed/reopened/manager-changed).
          if (cur.identity.localIntentId !== identity.localIntentId) return cur;
          return applyActiveRowPrecheck(cur, outcome, freshLocalIntentId);
        });
      })
      .finally(() => {
        if (reconciliationInFlightRef.current === identity.localIntentId) {
          reconciliationInFlightRef.current = null;
        }
      });
  }, []);

  const open = useCallback(
    (order: PrivilegedVoidOrderRef) => {
      const next = openPrivilegedVoidFlow(order, mintPrivilegedVoidLocalIntentId);
      // Authority-epoch boundary: a genuinely opened flow starts a new
      // authority attempt, invalidating every callback retained from a
      // prior attempt (including one from before a close/reopen cycle). A
      // malformed order (no-op, stays IDLE) never advances the epoch.
      if (next.status === 'PRECHECK') authorityEpochRef.current += 1;
      setState(next);
      if (next.status === 'PRECHECK') runPrecheck(next.identity);
    },
    [runPrecheck],
  );

  const submitReason = useCallback((reason: string, note: string) => {
    setState((cur) => submitReasonTransition(cur, reason, note));
  }, []);

  // RC-E1-002/RC-E1-005 — the decision to mint (and the mint itself) happen
  // HERE, in the callback body, reading the latest rendered `state` (mirrors
  // `submitPin`'s established read-state-directly pattern below) — never
  // inside the `setState` updater. A real manager CHANGE (one was already
  // bound and a DIFFERENT one is now chosen) mints exactly one new
  // `localIntentId`; re-selecting the same manager, or an initial/unbound
  // selection, mints nothing. A StrictMode replay of `chooseManagerTransition`
  // (the updater) can never trigger a second mint — none happens in there.
  //
  // RC-E1-002 §4.1 — `expected` below is the exact pre-transition snapshot
  // this decision was computed against (status/localIntentId/prior manager),
  // captured from this same closure. The pure updater (§4.2) refuses to
  // apply the decision unless the machine's CURRENT state still matches it
  // — so a STALE, retained copy of this callback (closed over an older
  // render's `state`) can no longer write a mismatched manager/intent pair
  // onto state a newer, non-stale call has since committed.
  const chooseManager = useCallback(
    (managerStaffId: string) => {
      if (!managerStaffId) return;
      if (state.status !== 'MANAGER_SELECT' && state.status !== 'MANAGER_PIN_ENTRY') return;

      const priorManagerStaffId = state.identity.managerStaffId;
      const isManagerChange = priorManagerStaffId !== null && priorManagerStaffId !== managerStaffId;

      // Re-picking the SAME already-bound manager is a true no-op (mirrors
      // `chooseManagerTransition`'s own no-op branch) — it must never
      // consume the authority epoch, since nothing is about to happen.
      if (state.status === 'MANAGER_PIN_ENTRY' && !isManagerChange) return;

      // RC-E1-002-FRESH-001 gate: prove this callback still owns the
      // current authority attempt BEFORE minting anything. A same-render
      // sibling call (two callbacks captured from one render) or a
      // retained call from an earlier render that already lost the race
      // fails here and mints nothing.
      if (!tryAcquireAuthorityEpoch()) return;

      const expected: ChooseManagerExpectedPreconditions = {
        expectedStatus: state.status,
        expectedLocalIntentId: state.identity.localIntentId,
        expectedPriorManagerStaffId: priorManagerStaffId,
      };
      const newLocalIntentId = isManagerChange ? mintPrivilegedVoidLocalIntentId() : null;
      setState((cur) => chooseManagerTransition(cur, managerStaffId, newLocalIntentId, expected));
    },
    [state, tryAcquireAuthorityEpoch],
  );

  // RC-E1-006-FRESH-001 — retained-Back epoch gate, same two-step shape as
  // `chooseManager`/`submitPin`: (1) a true no-op call (captured state isn't
  // MANAGER_PIN_ENTRY) never touches the epoch/state at all; (2) only once
  // that's ruled out do we prove the captured epoch is still current via
  // `tryAcquireAuthorityEpoch` BEFORE consuming it. A retained callback from
  // an already-abandoned PIN attempt — either because its own prior
  // invocation already consumed the epoch (a stale re-invoke of the same
  // retained Back), or because a newer attempt (new manager, fresh PIN
  // entry) has since consumed it — fails the epoch check and is a full
  // no-op: no epoch advance, no `setState`, no mutation of the live
  // MANAGER_PIN_ENTRY the current render is showing.
  const backToManagerSelect = useCallback(() => {
    if (state.status !== 'MANAGER_PIN_ENTRY') return;
    if (!tryAcquireAuthorityEpoch()) return;
    setState((cur) => backToManagerSelectTransition(cur));
  }, [state, tryAcquireAuthorityEpoch]);

  const close = useCallback(() => {
    // Authority-epoch boundary: closing always abandons the current
    // authority attempt, regardless of which state it was in.
    authorityEpochRef.current += 1;
    setState(closePrivilegedVoidFlow());
  }, []);

  // RC-E1-002 — reads `state` directly (same established pattern as
  // `chooseManager`/`submitPin`) and launches `runPrecheck` in the callback
  // body, OUTSIDE any `setState` updater. No functional-updater form is used
  // here at all, so nothing in this callback can be double-invoked by a
  // StrictMode updater-purity replay (React only replays updater functions,
  // never event-handler callbacks); `runPrecheck`'s own in-flight guard
  // additionally collapses any duplicate calls for the same intent (e.g. a
  // fast double-click) into a single D-2 read.
  const retryReconciliation = useCallback(() => {
    if (state.status === 'RECOVERED_ACTIVE' || state.status === 'LOCAL_UNCERTAIN') {
      runPrecheck(state.identity);
    }
  }, [state, runPrecheck]);

  // RC-E1-002 — once-only submit episode. Every side effect below (the
  // `inFlightRef`/`isSubmitting` guard and the D-3 launch itself) runs in
  // this callback's own body, OUTSIDE any function passed to `setState`.
  // React/StrictMode may replay a functional state updater to prove it is
  // pure, but it never replays the event-handler callback itself — so
  // nothing here can be double-invoked by that replay. The only functional
  // updater left (below, in the `.then`) is a pure stale-response guard: it
  // reads `latest` and returns a computed next state — no ref mutation, no
  // I/O, no other `setState` call — so a StrictMode replay of THAT updater
  // is a no-op difference, never a duplicate side effect.
  const submitPin = useCallback(
    (pin: string) => {
      if (inFlightRef.current) return;
      if (state.status !== 'MANAGER_PIN_ENTRY') return;

      // RC-E1-005-FRESH-001 gate: prove this callback still owns the
      // current authority attempt BEFORE `beginProjecting`, the
      // `inFlightRef`/`isSubmitting` guard, the PROJECTING transition, or
      // the D-3 launch. A retained callback from an abandoned PIN attempt
      // (e.g. A -> Back -> B) fails here and performs zero authority side
      // effects — it cannot resurrect the old manager/intent or reach D-3.
      if (!tryAcquireAuthorityEpoch()) return;

      const projecting = beginProjecting(state, currentLiveContext());
      if (projecting.status !== 'PROJECTING') {
        setState(projecting);
        return;
      }

      const identity = projecting.identity;
      const managerStaffId = identity.managerStaffId;
      if (!managerStaffId) {
        // Unreachable in practice — beginProjecting's revalidation already
        // requires a non-null managerStaffId — but never trust a PIN
        // submission toward an unbound manager.
        setState({ status: 'LOCAL_FAILURE', identity, reasonCode: 'stale_context' });
        return;
      }

      // Guard acquired synchronously, before the async D-3 launch — this is
      // the ONE place a submit episode can start, and it cannot run twice
      // for the same user action.
      inFlightRef.current = true;
      setIsSubmitting(true);
      setState(projecting);

      void projectPrivilegedOfflineAction({
        actionId: identity.actionId,
        targetOrderId: identity.targetOrderId,
        targetOrderUtc7Date: identity.targetOrderUtc7Date,
        managerStaffId,
        pin,
        localIntentId: identity.localIntentId,
        initiatingStaffId: identity.operatorStaffId,
      })
        .then((outcome) => {
          setState((latest) => {
            // Stale-response guard, preserved exactly: discard an outcome
            // for an intent the flow has already moved on from.
            if (latest.status !== 'PROJECTING' || latest.identity.localIntentId !== identity.localIntentId) {
              return latest;
            }
            return applyProjectionOutcome(latest, outcome);
          });
        })
        .finally(() => {
          inFlightRef.current = false;
          setIsSubmitting(false);
        });
    },
    [state, currentLiveContext, tryAcquireAuthorityEpoch],
  );

  // A `duplicate_target` D-3 outcome resolves to RECOVERED_ACTIVE with
  // `row: null`, which requires a follow-up D-2 precheck re-read to refine
  // it. Driving that re-read from an effect (rather than from inside the
  // `.then` above) keeps the submit path's only functional updater pure —
  // this effect only fires when `state` actually transitions into that
  // exact combination, which happens at most once per such outcome.
  useEffect(() => {
    if (state.status === 'RECOVERED_ACTIVE' && state.row === null) {
      runPrecheck(state.identity);
    }
  }, [state, runPrecheck]);

  const roster = useApproverRoster({
    enabled: state.status === 'MANAGER_SELECT',
    branchId: branchId ?? null,
    requesterStaffId: user?.id ?? null,
  });

  return {
    state,
    roster,
    isSubmitting,
    open,
    submitReason,
    chooseManager,
    backToManagerSelect,
    submitPin,
    close,
    retryReconciliation,
  };
}
