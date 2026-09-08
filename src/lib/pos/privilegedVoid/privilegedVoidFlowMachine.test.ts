import { describe, expect, it } from 'vitest';
import type { ProjectPrivilegedOfflineActionOutcome } from '../offline/projectPrivilegedOfflineAction';
import type { PrivilegedEvidenceJournalRecordV1 } from '../offline/privilegedEvidenceTypes';
import type { SafeActiveRowSummary } from './privilegedVoidActiveRow';
import {
  applyActiveRowPrecheck,
  applyProjectionOutcome,
  backToManagerSelect,
  beginProjecting,
  chooseManager,
  classifyPinDenial,
  closePrivilegedVoidFlow,
  initialPrivilegedVoidFlowState,
  mintPrivilegedVoidLocalIntentId,
  openPrivilegedVoidFlow,
  submitReason,
  type ChooseManagerExpectedPreconditions,
  type PrivilegedVoidFlowIdentity,
  type PrivilegedVoidFlowState,
  type PrivilegedVoidLiveContext,
  type PrivilegedVoidLocalFailureReason,
  type PrivilegedVoidOrderRef,
} from './privilegedVoidFlowMachine';

let seq = 0;
function mintSeq(): () => string {
  return () => `intent-${++seq}`;
}

/** A single already-minted id value — for the (post RC-E1-002/005) plain-value params. */
function freshId(): string {
  return `intent-${++seq}`;
}

function order(over: Partial<PrivilegedVoidOrderRef> = {}): PrivilegedVoidOrderRef {
  return {
    actionId: 'VOID_PENDING_SALE',
    targetOrderId: 'order-1',
    targetOrderUtc7Date: '2026-09-07',
    targetBranchId: 'LDP-001',
    operatorStaffId: 'staff-1',
    ...over,
  };
}

function liveContext(identity: PrivilegedVoidFlowIdentity, over: Partial<PrivilegedVoidLiveContext> = {}): PrivilegedVoidLiveContext {
  return {
    branchId: identity.targetBranchId,
    operatorStaffId: identity.operatorStaffId,
    authSessionActive: true,
    selectedOrderId: identity.targetOrderId,
    selectedOrderBranchId: identity.targetBranchId,
    expectedActionId: identity.actionId,
    currentVoidEligible: true,
    ...over,
  };
}

function openAndPrecheckClear(over: Partial<PrivilegedVoidOrderRef> = {}): PrivilegedVoidFlowState {
  const opened = openPrivilegedVoidFlow(order(over), mintSeq());
  if (opened.status !== 'PRECHECK') throw new Error('expected PRECHECK');
  return applyActiveRowPrecheck(opened, { kind: 'clear' }, freshId());
}

function toReason(): PrivilegedVoidFlowState {
  const reasonEntry = openAndPrecheckClear();
  return submitReason(reasonEntry, 'ลูกค้าเปลี่ยนใจ', 'note');
}

/** RC-E1-002 §4.1 — mirrors what `usePrivilegedVoidFlow.chooseManager` captures OUTSIDE the updater, from a given (non-stale) state. */
function expectedFrom(state: PrivilegedVoidFlowState): ChooseManagerExpectedPreconditions {
  if (state.status !== 'MANAGER_SELECT' && state.status !== 'MANAGER_PIN_ENTRY') {
    throw new Error('expected MANAGER_SELECT or MANAGER_PIN_ENTRY');
  }
  return {
    expectedStatus: state.status,
    expectedLocalIntentId: state.identity.localIntentId,
    expectedPriorManagerStaffId: state.identity.managerStaffId,
  };
}

/** First pick — no manager was bound yet, so no candidate id is ever needed. */
function toManagerPin(managerId = 'mgr-1'): PrivilegedVoidFlowState {
  const managerSelect = toReason();
  return chooseManager(managerSelect, managerId, null, expectedFrom(managerSelect));
}

const safeRow = (over: Partial<SafeActiveRowSummary> = {}): SafeActiveRowSummary => ({
  targetOrderId: 'order-1',
  classification: 'active_open',
  syncStatus: 'PRIVILEGED_INTENT_QUEUED',
  manualReviewStatus: 'NOT_REQUIRED',
  serverVerdict: null,
  updatedAtMs: 1_000,
  ...over,
});

function record(over: Partial<PrivilegedEvidenceJournalRecordV1> = {}): PrivilegedEvidenceJournalRecordV1 {
  return {
    schemaVersion: 1,
    adjudicationId: 'a'.repeat(32),
    localIntentId: 'intent-1',
    paa1Base64: 'PAA1',
    ssa1Base64: 'SSA1',
    oacEnvelopeBytesBase64: 'OAC1',
    evidenceBindingDigest: 'DIGEST1',
    actionId: 'VOID_PENDING_SALE',
    targetOrderId: 'order-1',
    targetOrderUtc7Date: '2026-09-07',
    branchId: 'LDP-001',
    approvingManagerStaffId: 'mgr-1',
    oacId: 'oac-1',
    oacSchemaVersion: 1,
    revocationEpochAtIssue: 0,
    managerAuthVersionAtIssue: 0,
    managerCredentialVersionAtIssue: 0,
    nonce: 'nonce-1',
    approvalProofDigest: 'proof-1',
    attestationAttemptCount: 1,
    approvalResult: 'APPROVED_LOCAL',
    trustedApprovalLowerMs: 1_000,
    trustedApprovalUpperMs: 2_000,
    pendingExecutionExpiresAtMs: 100_000,
    syncStatus: 'PRIVILEGED_INTENT_QUEUED',
    manualReviewStatus: 'NOT_REQUIRED',
    localTerminalReason: null,
    submissionClaims: 0,
    unresolvedClaimCount: 0,
    retryableFailureCount: 0,
    relayDeferrals: 0,
    deferredCycleCount: 0,
    nextAttemptAtMs: 0,
    claimOwner: null,
    claimGeneration: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    lastAttemptAtMs: null,
    lastDispositionKind: null,
    lastRelayCallerStaffId: null,
    lastCallerDependentStaffId: null,
    integrityConflict: false,
    ingestStaffId: 'staff-1',
    ingestDeviceId: 'device-1',
    resultingVoidIntentId: null,
    serverVerdict: null,
    serverReason: null,
    serverAdjudicationId: null,
    serverTargetOrderId: null,
    offlineExecutionId: null,
    outcomeKind: null,
    serverAdjudicatedAtMs: null,
    serverObservedAtMs: null,
    serverIdempotentReplay: null,
    ...over,
  };
}

describe('openPrivilegedVoidFlow', () => {
  it('IDLE -> PRECHECK, minting a fresh localIntentId', () => {
    const mint = mintSeq();
    const state = openPrivilegedVoidFlow(order(), mint);
    expect(state.status).toBe('PRECHECK');
    if (state.status !== 'PRECHECK') throw new Error('unreachable');
    expect(state.identity.localIntentId).toMatch(/^intent-\d+$/);
    expect(state.identity.managerStaffId).toBeNull();
  });

  it('refuses (stays IDLE) for a missing/ALL branch — never opens a flow it cannot scope', () => {
    expect(openPrivilegedVoidFlow(order({ targetBranchId: 'ALL' }), mintSeq())).toEqual(initialPrivilegedVoidFlowState);
    expect(openPrivilegedVoidFlow(order({ targetBranchId: '' }), mintSeq())).toEqual(initialPrivilegedVoidFlowState);
  });

  it('close/reopen mints a NEW localIntentId', () => {
    const first = openPrivilegedVoidFlow(order(), mintSeq());
    const second = openPrivilegedVoidFlow(order(), mintSeq());
    if (first.status !== 'PRECHECK' || second.status !== 'PRECHECK') throw new Error('unreachable');
    expect(first.identity.localIntentId).not.toBe(second.identity.localIntentId);
  });
});

describe('applyActiveRowPrecheck', () => {
  it('clear from PRECHECK -> VOID_REASON_ENTRY, same localIntentId', () => {
    const opened = openPrivilegedVoidFlow(order(), mintSeq());
    if (opened.status !== 'PRECHECK') throw new Error('unreachable');
    const next = applyActiveRowPrecheck(opened, { kind: 'clear' }, freshId());
    expect(next.status).toBe('VOID_REASON_ENTRY');
    if (next.status !== 'VOID_REASON_ENTRY') throw new Error('unreachable');
    expect(next.identity.localIntentId).toBe(opened.identity.localIntentId);
  });

  it('active_open -> RECOVERED_ACTIVE with the row, no manager controls offered', () => {
    const opened = openPrivilegedVoidFlow(order(), mintSeq());
    if (opened.status !== 'PRECHECK') throw new Error('unreachable');
    const row = safeRow();
    const next = applyActiveRowPrecheck(opened, { kind: 'active_open', row }, freshId());
    expect(next).toEqual({ status: 'RECOVERED_ACTIVE', identity: opened.identity, row });
  });

  it('manual_attention -> MANUAL_ATTENTION', () => {
    const opened = openPrivilegedVoidFlow(order(), mintSeq());
    if (opened.status !== 'PRECHECK') throw new Error('unreachable');
    const row = safeRow({ classification: 'manual_attention', syncStatus: 'MANUAL_ATTENTION', manualReviewStatus: 'REQUIRED' });
    const next = applyActiveRowPrecheck(opened, { kind: 'manual_attention', row }, freshId());
    expect(next.status).toBe('MANUAL_ATTENTION');
  });

  it('terminal_accepted -> TERMINAL_SERVER_ACCEPTED', () => {
    const opened = openPrivilegedVoidFlow(order(), mintSeq());
    if (opened.status !== 'PRECHECK') throw new Error('unreachable');
    const row = safeRow({ classification: 'terminal_accepted', syncStatus: 'SERVER_ACCEPTED' });
    const next = applyActiveRowPrecheck(opened, { kind: 'terminal_accepted', row }, freshId());
    expect(next.status).toBe('TERMINAL_SERVER_ACCEPTED');
  });

  it('terminal_rejected from initial PRECHECK does not block — proceeds to VOID_REASON_ENTRY (mirrors D-3 pre-guard)', () => {
    const opened = openPrivilegedVoidFlow(order(), mintSeq());
    if (opened.status !== 'PRECHECK') throw new Error('unreachable');
    const row = safeRow({ classification: 'terminal_rejected', syncStatus: 'SERVER_REJECTED' });
    const next = applyActiveRowPrecheck(opened, { kind: 'terminal_rejected', row }, freshId());
    expect(next.status).toBe('VOID_REASON_ENTRY');
  });

  it('terminal_rejected while reconciling a duplicate_target race -> TERMINAL_SERVER_REJECTED', () => {
    const recovered: PrivilegedVoidFlowState = {
      status: 'RECOVERED_ACTIVE',
      identity: (openPrivilegedVoidFlow(order(), mintSeq()) as { identity: PrivilegedVoidFlowIdentity }).identity,
      row: null,
    };
    const row = safeRow({ classification: 'terminal_rejected', syncStatus: 'SERVER_REJECTED' });
    const next = applyActiveRowPrecheck(recovered, { kind: 'terminal_rejected', row }, freshId());
    expect(next).toEqual({ status: 'TERMINAL_SERVER_REJECTED', identity: recovered.identity, row });
  });

  it('integrity_fault -> LOCAL_FAILURE regardless of originating state', () => {
    const opened = openPrivilegedVoidFlow(order(), mintSeq());
    if (opened.status !== 'PRECHECK') throw new Error('unreachable');
    const next = applyActiveRowPrecheck(opened, { kind: 'integrity_fault' }, freshId());
    expect(next).toEqual({ status: 'LOCAL_FAILURE', identity: opened.identity, reasonCode: 'integrity_conflict' });
  });

  it('uncertain reconciliation: clear mints a NEW localIntentId and starts a fresh flow', () => {
    const identity = (openPrivilegedVoidFlow(order(), mintSeq()) as { identity: PrivilegedVoidFlowIdentity }).identity;
    const uncertain: PrivilegedVoidFlowState = { status: 'LOCAL_UNCERTAIN', identity };
    const next = applyActiveRowPrecheck(uncertain, { kind: 'clear' }, freshId());
    expect(next.status).toBe('VOID_REASON_ENTRY');
    if (next.status !== 'VOID_REASON_ENTRY') throw new Error('unreachable');
    expect(next.identity.localIntentId).not.toBe(identity.localIntentId);
  });

  it('applyActiveRowPrecheck purity: the LOCAL_UNCERTAIN-clears-fresh branch uses the supplied id VERBATIM — it never mints its own (RC-E1-002)', () => {
    const identity = (openPrivilegedVoidFlow(order(), mintSeq()) as { identity: PrivilegedVoidFlowIdentity }).identity;
    const uncertain: PrivilegedVoidFlowState = { status: 'LOCAL_UNCERTAIN', identity };
    const supplied = 'caller-minted-id-1';
    const next = applyActiveRowPrecheck(uncertain, { kind: 'clear' }, supplied);
    if (next.status !== 'VOID_REASON_ENTRY') throw new Error('unreachable');
    expect(next.identity.localIntentId).toBe(supplied);
  });

  it('uncertain reconciliation: an open row still forbids a new flow (LOCAL_UNCERTAIN stays gated, not silently cleared)', () => {
    const identity = (openPrivilegedVoidFlow(order(), mintSeq()) as { identity: PrivilegedVoidFlowIdentity }).identity;
    const uncertain: PrivilegedVoidFlowState = { status: 'LOCAL_UNCERTAIN', identity };
    const row = safeRow();
    const next = applyActiveRowPrecheck(uncertain, { kind: 'active_open', row }, freshId());
    expect(next.status).toBe('RECOVERED_ACTIVE');
  });

  it('is a no-op from an unrelated state (e.g. IDLE)', () => {
    expect(applyActiveRowPrecheck(initialPrivilegedVoidFlowState, { kind: 'clear' }, freshId())).toEqual(
      initialPrivilegedVoidFlowState,
    );
  });
});

describe('submitReason', () => {
  it('VOID_REASON_ENTRY -> MANAGER_SELECT with a trimmed reason/note', () => {
    const reasonEntry = openAndPrecheckClear();
    const next = submitReason(reasonEntry, '  ลูกค้าเปลี่ยนใจ  ', '  note  ');
    expect(next.status).toBe('MANAGER_SELECT');
    if (next.status !== 'MANAGER_SELECT') throw new Error('unreachable');
    expect(next.reason).toBe('ลูกค้าเปลี่ยนใจ');
    expect(next.note).toBe('note');
  });

  it('rejects an empty reason (stays in VOID_REASON_ENTRY)', () => {
    const reasonEntry = openAndPrecheckClear();
    const next = submitReason(reasonEntry, '   ', '');
    expect(next).toEqual(reasonEntry);
  });
});

describe('chooseManager', () => {
  it('first pick from MANAGER_SELECT keeps the same localIntentId (even if a candidate id is supplied — no manager was bound yet)', () => {
    const managerSelect = toReason();
    const before = (managerSelect as { identity: PrivilegedVoidFlowIdentity }).identity.localIntentId;
    const next = chooseManager(managerSelect, 'mgr-1', freshId(), expectedFrom(managerSelect));
    expect(next.status).toBe('MANAGER_PIN_ENTRY');
    if (next.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
    expect(next.identity.localIntentId).toBe(before);
    expect(next.identity.managerStaffId).toBe('mgr-1');
  });

  it('re-picking the SAME manager while already in MANAGER_PIN_ENTRY is a no-op', () => {
    const pinEntry = toManagerPin('mgr-1');
    const next = chooseManager(pinEntry, 'mgr-1', freshId(), expectedFrom(pinEntry));
    expect(next).toEqual(pinEntry);
  });

  it('picking a DIFFERENT manager directly from MANAGER_PIN_ENTRY uses the supplied NEW localIntentId', () => {
    const pinEntry = toManagerPin('mgr-1');
    const before = (pinEntry as { identity: PrivilegedVoidFlowIdentity }).identity.localIntentId;
    const newId = freshId();
    const next = chooseManager(pinEntry, 'mgr-2', newId, expectedFrom(pinEntry));
    expect(next.status).toBe('MANAGER_PIN_ENTRY');
    if (next.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
    expect(next.identity.managerStaffId).toBe('mgr-2');
    expect(next.identity.localIntentId).toBe(newId);
    expect(next.identity.localIntentId).not.toBe(before);
  });

  it('rejects an empty managerStaffId (no free-text fallback)', () => {
    const managerSelect = toReason();
    expect(chooseManager(managerSelect, '', freshId(), expectedFrom(managerSelect))).toEqual(managerSelect);
  });

  it('purity (RC-E1-002): a real manager change never mints on its own — it uses the caller-supplied id verbatim', () => {
    const pinEntry = toManagerPin('mgr-1');
    const suppliedId = 'caller-minted-id-2';
    const next = chooseManager(pinEntry, 'mgr-2', suppliedId, expectedFrom(pinEntry));
    if (next.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
    expect(next.identity.localIntentId).toBe(suppliedId);
  });

  it('RC-E1-002 §4.3: a real manager change with NO candidate localIntentId is a hard no-op — never switches managers (would otherwise retain the OLD intent under the NEW manager)', () => {
    const pinEntryA = toManagerPin('mgr-1');
    const next = chooseManager(pinEntryA, 'mgr-2', null, expectedFrom(pinEntryA));
    expect(next).toEqual(pinEntryA);
    if (next.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
    expect(next.identity.managerStaffId).toBe('mgr-1');
  });

  it('RC-E1-002 §4.2: stale expected preconditions (captured before a newer manager/intent commit) no-op — never applied to newer state', () => {
    // Simulates a RETAINED callback: preconditions captured against the
    // ORIGINAL manager-A/intent-A state, before a newer, non-stale selection
    // has since committed manager B / a fresh intent.
    const pinEntryA = toManagerPin('mgr-1');
    const staleExpected = expectedFrom(pinEntryA);

    const backAtSelect = backToManagerSelect(pinEntryA);
    const newId = freshId();
    const committedB = chooseManager(backAtSelect, 'mgr-2', newId, expectedFrom(backAtSelect));
    if (committedB.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
    expect(committedB.identity.managerStaffId).toBe('mgr-2');
    expect(committedB.identity.localIntentId).toBe(newId);

    // The stale callback now fires, deciding (from its OLD closure) "same
    // manager A, no candidate needed" — applied against the CURRENT state.
    const staleResult = chooseManager(committedB, 'mgr-1', null, staleExpected);
    expect(staleResult).toEqual(committedB);
    if (staleResult.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
    // No mismatched pair: manager stays B, intent stays newId — never B+staleA-intent or A+newId.
    expect(staleResult.identity.managerStaffId).toBe('mgr-2');
    expect(staleResult.identity.localIntentId).toBe(newId);
  });

  it('RC-E1-002 §4.2: a stale localIntentId precondition alone (status/prior-manager still matching) is enough to reject the decision', () => {
    const pinEntryA = toManagerPin('mgr-1');
    if (pinEntryA.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
    const staleExpected = expectedFrom(pinEntryA);
    // A same-manager reconciliation-driven intent refresh could change
    // `identity.localIntentId` while manager/status stay put; simulate that
    // directly by supplying an expected localIntentId that no longer matches.
    const mutatedIntentState: PrivilegedVoidFlowState = {
      ...pinEntryA,
      identity: { ...pinEntryA.identity, localIntentId: freshId() },
    };
    const result = chooseManager(mutatedIntentState, 'mgr-2', freshId(), staleExpected);
    expect(result).toEqual(mutatedIntentState);
  });

  describe('RC-E1-005 — real manager-change lifetime semantics via the actual back-then-reselect UI path', () => {
    it('PIN(A) -> back -> select(A) preserves the SAME localIntentId (same manager, same authority-attempt identity)', () => {
      const pinEntryA = toManagerPin('mgr-1');
      const before = (pinEntryA as { identity: PrivilegedVoidFlowIdentity }).identity.localIntentId;
      const backAtSelect = backToManagerSelect(pinEntryA);
      expect(backAtSelect.status).toBe('MANAGER_SELECT');

      const next = chooseManager(backAtSelect, 'mgr-1', freshId(), expectedFrom(backAtSelect));
      expect(next.status).toBe('MANAGER_PIN_ENTRY');
      if (next.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
      expect(next.identity.managerStaffId).toBe('mgr-1');
      expect(next.identity.localIntentId).toBe(before);
    });

    it('PIN(A) -> back -> select(B) mints/commits a NEW localIntentId — B never inherits A\'s intent', () => {
      const pinEntryA = toManagerPin('mgr-1');
      const before = (pinEntryA as { identity: PrivilegedVoidFlowIdentity }).identity.localIntentId;
      const backAtSelect = backToManagerSelect(pinEntryA);
      expect(backAtSelect.status).toBe('MANAGER_SELECT');

      const newId = freshId();
      const next = chooseManager(backAtSelect, 'mgr-2', newId, expectedFrom(backAtSelect));
      expect(next.status).toBe('MANAGER_PIN_ENTRY');
      if (next.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
      expect(next.identity.managerStaffId).toBe('mgr-2');
      expect(next.identity.localIntentId).toBe(newId);
      expect(next.identity.localIntentId).not.toBe(before);
    });

    it('regression: an invalid-PIN retry (applyProjectionOutcome, SAME manager) is unaffected by the manager-change fix and still keeps the same intent', () => {
      const pinEntry = toManagerPin('mgr-1');
      const identity = (pinEntry as { identity: PrivilegedVoidFlowIdentity }).identity;
      const projecting = beginProjecting(pinEntry, liveContext(identity));
      const retried = applyProjectionOutcome(projecting, { kind: 'not_approved', errorCode: 'DENIED_INVALID_PIN' });
      if (retried.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
      expect(retried.identity.managerStaffId).toBe('mgr-1');
      expect(retried.identity.localIntentId).toBe(identity.localIntentId);
    });
  });
});

describe('backToManagerSelect', () => {
  it('MANAGER_PIN_ENTRY -> MANAGER_SELECT, preserving the identity', () => {
    const pinEntry = toManagerPin();
    const next = backToManagerSelect(pinEntry);
    expect(next.status).toBe('MANAGER_SELECT');
    if (next.status !== 'MANAGER_SELECT') throw new Error('unreachable');
    expect(next.identity).toEqual((pinEntry as { identity: PrivilegedVoidFlowIdentity }).identity);
  });
});

describe('beginProjecting — GD-E-004 revalidation', () => {
  it('transitions to PROJECTING when the live context matches the captured identity', () => {
    const pinEntry = toManagerPin();
    const identity = (pinEntry as { identity: PrivilegedVoidFlowIdentity }).identity;
    const next = beginProjecting(pinEntry, liveContext(identity));
    expect(next.status).toBe('PROJECTING');
  });

  it('refuses into LOCAL_FAILURE on a branch switch since capture (never silently retargets)', () => {
    const pinEntry = toManagerPin();
    const identity = (pinEntry as { identity: PrivilegedVoidFlowIdentity }).identity;
    const next = beginProjecting(pinEntry, liveContext(identity, { branchId: 'LDP-999' }));
    expect(next).toEqual({ status: 'LOCAL_FAILURE', identity, reasonCode: 'stale_context' });
  });

  it('refuses on a selected-order change since capture', () => {
    const pinEntry = toManagerPin();
    const identity = (pinEntry as { identity: PrivilegedVoidFlowIdentity }).identity;
    const next = beginProjecting(pinEntry, liveContext(identity, { selectedOrderId: 'order-2' }));
    expect(next).toEqual({ status: 'LOCAL_FAILURE', identity, reasonCode: 'stale_context' });
  });

  it('refuses on operator/auth staleness', () => {
    const pinEntry = toManagerPin();
    const identity = (pinEntry as { identity: PrivilegedVoidFlowIdentity }).identity;
    expect(beginProjecting(pinEntry, liveContext(identity, { authSessionActive: false })).status).toBe('LOCAL_FAILURE');
    expect(beginProjecting(pinEntry, liveContext(identity, { operatorStaffId: 'someone-else' })).status).toBe(
      'LOCAL_FAILURE',
    );
  });

  it('refuses on action staleness (order classification changed since capture)', () => {
    const pinEntry = toManagerPin();
    const identity = (pinEntry as { identity: PrivilegedVoidFlowIdentity }).identity;
    const next = beginProjecting(pinEntry, liveContext(identity, { expectedActionId: 'VOID_SETTLED_SALE' }));
    expect(next.status).toBe('LOCAL_FAILURE');
  });

  it('RC-E1-003: refuses into LOCAL_FAILURE/stale_context when the current row is no longer void-eligible (voided, ineligible, or same-day window expired) — zero D-3 call results from this, since PROJECTING is never entered', () => {
    const pinEntry = toManagerPin();
    const identity = (pinEntry as { identity: PrivilegedVoidFlowIdentity }).identity;
    const next = beginProjecting(pinEntry, liveContext(identity, { currentVoidEligible: false }));
    expect(next).toEqual({ status: 'LOCAL_FAILURE', identity, reasonCode: 'stale_context' });
  });

  it('RC-E1-003: an eligibility change with NO identity change still refuses (id/branch/action all match, only eligibility flipped)', () => {
    const pinEntry = toManagerPin();
    const identity = (pinEntry as { identity: PrivilegedVoidFlowIdentity }).identity;
    const live = liveContext(identity, { currentVoidEligible: false });
    expect(live.selectedOrderId).toBe(identity.targetOrderId);
    expect(live.selectedOrderBranchId).toBe(identity.targetBranchId);
    expect(live.expectedActionId).toBe(identity.actionId);
    expect(beginProjecting(pinEntry, live).status).toBe('LOCAL_FAILURE');
  });

  it('is a no-op from any state other than MANAGER_PIN_ENTRY', () => {
    const managerSelect = toReason();
    const identity = (managerSelect as { identity: PrivilegedVoidFlowIdentity }).identity;
    expect(beginProjecting(managerSelect, liveContext(identity))).toEqual(managerSelect);
  });
});

describe('applyProjectionOutcome — the closed 8-outcome D-3 mapping', () => {
  function projecting(): PrivilegedVoidFlowState {
    const pinEntry = toManagerPin();
    const identity = (pinEntry as { identity: PrivilegedVoidFlowIdentity }).identity;
    return beginProjecting(pinEntry, liveContext(identity));
  }

  const OUTCOMES: Array<{ outcome: ProjectPrivilegedOfflineActionOutcome; expectStatus: PrivilegedVoidFlowState['status'] }> = [
    { outcome: { kind: 'projected', record: record() }, expectStatus: 'CAPTURED_PENDING_ADJUDICATION' },
    { outcome: { kind: 'already_projected', record: record() }, expectStatus: 'CAPTURED_PENDING_ADJUDICATION' },
    { outcome: { kind: 'duplicate_target' }, expectStatus: 'RECOVERED_ACTIVE' },
    { outcome: { kind: 'not_approved', errorCode: 'DENIED_INVALID_PIN' }, expectStatus: 'MANAGER_PIN_ENTRY' },
    { outcome: { kind: 'unavailable' }, expectStatus: 'LOCAL_FAILURE' },
    { outcome: { kind: 'integrity_conflict' }, expectStatus: 'LOCAL_FAILURE' },
    { outcome: { kind: 'durable_unavailable' }, expectStatus: 'LOCAL_FAILURE' },
    { outcome: { kind: 'uncertain' }, expectStatus: 'LOCAL_UNCERTAIN' },
  ];

  for (const { outcome, expectStatus } of OUTCOMES) {
    it(`${outcome.kind} -> ${expectStatus}`, () => {
      const next = applyProjectionOutcome(projecting(), outcome);
      expect(next.status).toBe(expectStatus);
    });
  }

  it('not_approved with DENIED_INVALID_PIN keeps the SAME localIntentId (invalid-PIN retry, same manager/flow)', () => {
    const state = projecting();
    const identity = (state as { identity: PrivilegedVoidFlowIdentity }).identity;
    const next = applyProjectionOutcome(state, { kind: 'not_approved', errorCode: 'DENIED_INVALID_PIN' });
    if (next.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
    expect(next.identity.localIntentId).toBe(identity.localIntentId);
    expect(next.pinErrorCode).toBe('DENIED_INVALID_PIN');
  });

  it('duplicate_target resolves with row: null, requiring a follow-up precheck re-read', () => {
    const next = applyProjectionOutcome(projecting(), { kind: 'duplicate_target' });
    expect(next).toMatchObject({ status: 'RECOVERED_ACTIVE', row: null });
  });

  it('is a no-op from any state other than PROJECTING', () => {
    const pinEntry = toManagerPin();
    expect(applyProjectionOutcome(pinEntry, { kind: 'uncertain' })).toEqual(pinEntry);
  });
});

describe('classifyPinDenial — RC-E1-004 closed D-1B denial classifier', () => {
  it('DENIED_INVALID_PIN is the ONLY retryable-in-place code', () => {
    expect(classifyPinDenial('DENIED_INVALID_PIN')).toBe('retry_same_intent');
  });

  const LOCKED_CODES = ['DENIED_LOCKED', 'TOO_MANY_ATTEMPTS'];
  const STALE_CODES = ['DENIED_STALE', 'CREDENTIAL_STALE'];
  const UNVERIFIABLE_CODES = ['DENIED_UNVERIFIABLE', 'APPROVAL_UNAVAILABLE'];
  const OTHER_STRUCTURAL_CODES = [
    'MANAGER_NOT_AUTHORIZED',
    'SERVER_REJECTED',
    'LEGACY_PIN4_REQUIRES_ROTATION',
    'OAC_PROVISION_FORBIDDEN_LEGACY_PIN4',
  ];

  for (const code of LOCKED_CODES) {
    it(`${code} classifies as 'locked' (terminal — no further PIN attempt)`, () => {
      expect(classifyPinDenial(code)).toBe('locked');
    });
  }

  for (const code of STALE_CODES) {
    it(`${code} classifies as 'stale' (terminal — fresh/system reconnection path)`, () => {
      expect(classifyPinDenial(code)).toBe('stale');
    });
  }

  for (const code of UNVERIFIABLE_CODES) {
    it(`${code} classifies as 'unverifiable' (terminal — action unavailable under privileged-only CTA)`, () => {
      expect(classifyPinDenial(code)).toBe('unverifiable');
    });
  }

  for (const code of OTHER_STRUCTURAL_CODES) {
    it(`${code} classifies as the generic terminal fail-closed bucket ('unknown')`, () => {
      expect(classifyPinDenial(code)).toBe('unknown');
    });
  }

  it('null classifies as the generic terminal fail-closed bucket', () => {
    expect(classifyPinDenial(null)).toBe('unknown');
  });

  it('an unrecognized/synthetic code classifies as the generic terminal fail-closed bucket', () => {
    expect(classifyPinDenial('SOME_FUTURE_UNKNOWN_CODE')).toBe('unknown');
  });

  it('every class except retry_same_intent is terminal — exactly one class is in-place retryable', () => {
    const allCodes = [
      'DENIED_INVALID_PIN',
      ...LOCKED_CODES,
      ...STALE_CODES,
      ...UNVERIFIABLE_CODES,
      ...OTHER_STRUCTURAL_CODES,
      'SOME_UNKNOWN_CODE',
    ];
    const retryable = allCodes.filter((c) => classifyPinDenial(c) === 'retry_same_intent');
    expect(retryable).toEqual(['DENIED_INVALID_PIN']);
  });
});

describe('applyProjectionOutcome — RC-E1-004 exhaustive not_approved denial-code matrix', () => {
  function projectingState(): PrivilegedVoidFlowState {
    const pinEntry = toManagerPin();
    const identity = (pinEntry as { identity: PrivilegedVoidFlowIdentity }).identity;
    return beginProjecting(pinEntry, liveContext(identity));
  }

  const TERMINAL_CODES: Array<{ code: string | null; reasonCode: PrivilegedVoidLocalFailureReason }> = [
    { code: 'DENIED_LOCKED', reasonCode: 'denied_locked' },
    { code: 'TOO_MANY_ATTEMPTS', reasonCode: 'denied_locked' },
    { code: 'DENIED_STALE', reasonCode: 'denied_stale' },
    { code: 'CREDENTIAL_STALE', reasonCode: 'denied_stale' },
    { code: 'DENIED_UNVERIFIABLE', reasonCode: 'denied_unverifiable' },
    { code: 'APPROVAL_UNAVAILABLE', reasonCode: 'denied_unverifiable' },
    { code: 'MANAGER_NOT_AUTHORIZED', reasonCode: 'denied_unknown' },
    { code: 'SERVER_REJECTED', reasonCode: 'denied_unknown' },
    { code: 'LEGACY_PIN4_REQUIRES_ROTATION', reasonCode: 'denied_unknown' },
    { code: 'OAC_PROVISION_FORBIDDEN_LEGACY_PIN4', reasonCode: 'denied_unknown' },
    { code: 'SOME_UNRECOGNIZED_CODE', reasonCode: 'denied_unknown' },
    { code: null, reasonCode: 'denied_unknown' },
  ];

  it('DENIED_INVALID_PIN is the only code that returns to MANAGER_PIN_ENTRY (in-place retry), preserving the SAME localIntentId', () => {
    const state = projectingState();
    const identity = (state as { identity: PrivilegedVoidFlowIdentity }).identity;
    const next = applyProjectionOutcome(state, { kind: 'not_approved', errorCode: 'DENIED_INVALID_PIN' });
    expect(next.status).toBe('MANAGER_PIN_ENTRY');
    if (next.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
    expect(next.identity.localIntentId).toBe(identity.localIntentId);
  });

  for (const { code, reasonCode } of TERMINAL_CODES) {
    it(`${code ?? 'null'} -> LOCAL_FAILURE/${reasonCode} (terminal, fails closed, never re-prompts the same PIN)`, () => {
      const next = applyProjectionOutcome(projectingState(), { kind: 'not_approved', errorCode: code });
      expect(next).toMatchObject({ status: 'LOCAL_FAILURE', reasonCode });
      // A structural denial can never leave the flow able to accept a second
      // PIN attempt against the same intent.
      expect(next.status).not.toBe('MANAGER_PIN_ENTRY');
    });
  }

  it('no raw errorCode string ever appears on the resulting LOCAL_FAILURE state', () => {
    for (const { code } of TERMINAL_CODES) {
      const next = applyProjectionOutcome(projectingState(), { kind: 'not_approved', errorCode: code });
      expect(JSON.stringify(next)).not.toContain('SOME_UNRECOGNIZED_CODE');
      if (code) expect(JSON.stringify(next)).not.toContain(code);
    }
  });
});

describe('closePrivilegedVoidFlow', () => {
  it('always resets to IDLE', () => {
    expect(closePrivilegedVoidFlow()).toEqual(initialPrivilegedVoidFlowState);
  });
});

describe('mintPrivilegedVoidLocalIntentId', () => {
  it('is never timestamp-only — two calls in the same millisecond still differ', () => {
    const a = mintPrivilegedVoidLocalIntentId();
    const b = mintPrivilegedVoidLocalIntentId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(8);
  });
});
