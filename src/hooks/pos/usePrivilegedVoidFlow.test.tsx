// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryReversalStore, type ReversalLocalStore } from '../../lib/pos/offline/reversalLocalStore';
import type { ProjectPrivilegedOfflineActionOutcome } from '../../lib/pos/offline/projectPrivilegedOfflineAction';

let authUser: { id: string } | null = { id: 'staff-1' };
let authBranchId: string | null = 'LDP-001';
let store: ReversalLocalStore = createInMemoryReversalStore();
const projectMock = vi.fn<(input: unknown) => Promise<ProjectPrivilegedOfflineActionOutcome>>();

// RC-E1-002 — counts real D-2 precheck reads, and RC-E1-002/RC-E1-005 —
// counts real localIntentId mints, without changing behavior (both default
// implementations are assigned below, once the actual modules are
// available, and always delegate through to the real functions). Declared
// via `vi.hoisted` so these are safely initialized before the `vi.mock`
// factories below (which reference them) run.
type PrecheckFn = typeof import('../../lib/pos/privilegedVoid/privilegedVoidActiveRow').precheckActiveRowForTarget;
const { precheckMock, mintMock } = vi.hoisted(() => ({
  precheckMock: vi.fn<PrecheckFn>(),
  mintMock: vi.fn<() => string>(),
}));

vi.mock('../../lib/hooks/useAuth', () => ({
  useAuth: () => ({ user: authUser, branchId: authBranchId }),
}));

vi.mock('../../lib/auth/useApproverRoster', () => ({
  useApproverRoster: () => ({
    status: 'ready',
    fromCache: false,
    candidates: [{ userId: 'mgr-1', displayName: 'Manager One', username: 'm1', role: 'manager' }],
  }),
}));

vi.mock('../../lib/pos/offline/reversalLocalStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pos/offline/reversalLocalStore')>();
  return { ...actual, createIndexedDbReversalStore: () => store };
});

vi.mock('../../lib/pos/offline/projectPrivilegedOfflineAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pos/offline/projectPrivilegedOfflineAction')>();
  return { ...actual, projectPrivilegedOfflineAction: (input: unknown) => projectMock(input) };
});

vi.mock('../../lib/pos/privilegedVoid/privilegedVoidActiveRow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pos/privilegedVoid/privilegedVoidActiveRow')>();
  precheckMock.mockImplementation((...args) => actual.precheckActiveRowForTarget(...args));
  return { ...actual, precheckActiveRowForTarget: (...args: Parameters<typeof actual.precheckActiveRowForTarget>) => precheckMock(...args) };
});

vi.mock('../../lib/pos/privilegedVoid/privilegedVoidFlowMachine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pos/privilegedVoid/privilegedVoidFlowMachine')>();
  mintMock.mockImplementation(actual.mintPrivilegedVoidLocalIntentId);
  return { ...actual, mintPrivilegedVoidLocalIntentId: mintMock };
});

import { usePrivilegedVoidFlow } from './usePrivilegedVoidFlow';

const ORDER = {
  actionId: 'VOID_PENDING_SALE' as const,
  targetOrderId: 'order-1',
  targetOrderUtc7Date: '2026-09-07',
  targetBranchId: 'LDP-001',
  operatorStaffId: 'staff-1',
};

function selection(
  over: Partial<{
    orderId: string | null;
    orderBranchId: string | null;
    expectedActionId: 'VOID_PENDING_SALE' | 'VOID_SETTLED_SALE' | null;
    isCurrentlyVoidEligible: () => boolean;
  }> = {},
) {
  return {
    orderId: 'order-1',
    orderBranchId: 'LDP-001',
    expectedActionId: 'VOID_PENDING_SALE' as const,
    isCurrentlyVoidEligible: () => true,
    ...over,
  };
}

function record(): import('../../lib/pos/offline/privilegedEvidenceTypes').PrivilegedEvidenceJournalRecordV1 {
  return {
    schemaVersion: 1,
    adjudicationId: 'a'.repeat(32),
    localIntentId: 'intent-x',
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
  };
}

async function driveToManagerPin(result: { current: ReturnType<typeof usePrivilegedVoidFlow> }) {
  act(() => result.current.open(ORDER));
  await waitFor(() => expect(result.current.state.status).toBe('VOID_REASON_ENTRY'));
  act(() => result.current.submitReason('ลูกค้าเปลี่ยนใจ', ''));
  act(() => result.current.chooseManager('mgr-1'));
  await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));
}

beforeEach(() => {
  authUser = { id: 'staff-1' };
  authBranchId = 'LDP-001';
  store = createInMemoryReversalStore();
  projectMock.mockReset();
  precheckMock.mockClear();
  mintMock.mockClear();
});

afterEach(cleanup);

describe('usePrivilegedVoidFlow', () => {
  it('open() runs the D-2 precheck and lands on VOID_REASON_ENTRY when the target is clear', async () => {
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
    act(() => result.current.open(ORDER));
    expect(result.current.state.status).toBe('PRECHECK');
    await waitFor(() => expect(result.current.state.status).toBe('VOID_REASON_ENTRY'));
  });

  it('full reason -> manager -> PIN sequencing calls D-3 exactly once and reaches CAPTURED_PENDING_ADJUDICATION on projected', async () => {
    projectMock.mockResolvedValue({ kind: 'projected', record: record() });
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
    await driveToManagerPin(result);

    act(() => result.current.submitPin('123456'));
    expect(result.current.state.status).toBe('PROJECTING');
    await waitFor(() => expect(result.current.state.status).toBe('CAPTURED_PENDING_ADJUDICATION'));
    expect(projectMock).toHaveBeenCalledTimes(1);
    const call = projectMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.managerStaffId).toBe('mgr-1');
    expect(call.pin).toBe('123456');
    expect(call.initiatingStaffId).toBe('staff-1');
  });

  it('duplicate submit while already projecting results in exactly one D-3 call', async () => {
    let resolveProjection!: (o: ProjectPrivilegedOfflineActionOutcome) => void;
    projectMock.mockReturnValue(new Promise((resolve) => (resolveProjection = resolve)));
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
    await driveToManagerPin(result);

    act(() => {
      result.current.submitPin('123456');
      result.current.submitPin('123456');
      result.current.submitPin('123456');
    });
    expect(projectMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveProjection({ kind: 'projected', record: record() });
    });
    await waitFor(() => expect(result.current.state.status).toBe('CAPTURED_PENDING_ADJUDICATION'));
  });

  it('not_approved with DENIED_INVALID_PIN returns to MANAGER_PIN_ENTRY with the SAME localIntentId (invalid-PIN retry)', async () => {
    projectMock.mockResolvedValue({ kind: 'not_approved', errorCode: 'DENIED_INVALID_PIN' });
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
    await driveToManagerPin(result);
    const before = result.current.state.status === 'MANAGER_PIN_ENTRY' ? result.current.state.identity.localIntentId : null;

    act(() => result.current.submitPin('000000'));
    await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));
    if (result.current.state.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
    expect(result.current.state.identity.localIntentId).toBe(before);
    expect(result.current.state.pinErrorCode).toBe('DENIED_INVALID_PIN');
    expect(result.current.isSubmitting).toBe(false);
  });

  it('RC-E1-004: a structural denial (e.g. DENIED_LOCKED) terminates into LOCAL_FAILURE — never re-prompts the same PIN, never leaves MANAGER_PIN_ENTRY reachable for this intent', async () => {
    projectMock.mockResolvedValue({ kind: 'not_approved', errorCode: 'DENIED_LOCKED' });
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
    await driveToManagerPin(result);

    act(() => result.current.submitPin('123456'));
    await waitFor(() => expect(result.current.state.status).toBe('LOCAL_FAILURE'));
    if (result.current.state.status !== 'LOCAL_FAILURE') throw new Error('unreachable');
    expect(result.current.state.reasonCode).toBe('denied_locked');
    expect(result.current.isSubmitting).toBe(false);
  });

  it('RC-E1-003: void eligibility flipping false since capture (row voided/ineligible/day-expired) refuses into LOCAL_FAILURE with ZERO D-3 calls, even with identity otherwise unchanged', async () => {
    let eligible = true;
    const { result } = renderHook(() =>
      usePrivilegedVoidFlow({ liveSelection: selection({ isCurrentlyVoidEligible: () => eligible }) }),
    );
    await driveToManagerPin(result);
    eligible = false;

    act(() => result.current.submitPin('123456'));
    expect(result.current.state.status).toBe('LOCAL_FAILURE');
    expect(projectMock).not.toHaveBeenCalled();
  });

  it('StrictMode: one accepted PIN submit calls D-3 exactly once even when React replays the submit updater (RC-E1-002)', async () => {
    projectMock.mockResolvedValue({ kind: 'projected', record: record() });
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }), {
      wrapper: StrictMode,
    });
    await driveToManagerPin(result);

    act(() => result.current.submitPin('123456'));
    await waitFor(() => expect(result.current.state.status).toBe('CAPTURED_PENDING_ADJUDICATION'));
    expect(projectMock).toHaveBeenCalledTimes(1);
    const call = projectMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.pin).toBe('123456');
  });

  it('uncertain outcome lands on LOCAL_UNCERTAIN and forbids a new flow until reconciliation clears', async () => {
    projectMock.mockResolvedValue({ kind: 'uncertain' });
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
    await driveToManagerPin(result);
    act(() => result.current.submitPin('123456'));
    await waitFor(() => expect(result.current.state.status).toBe('LOCAL_UNCERTAIN'));

    act(() => result.current.retryReconciliation());
    await waitFor(() => expect(result.current.state.status).toBe('VOID_REASON_ENTRY'));
    const identityAfter = result.current.state.status === 'VOID_REASON_ENTRY' ? result.current.state.identity.localIntentId : null;
    const identityBefore = 'intent-x';
    expect(identityAfter).not.toBe(identityBefore);
  });

  it('a branch switch since capture refuses the submit into LOCAL_FAILURE instead of retargeting', async () => {
    const { result, rerender } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
    await driveToManagerPin(result);
    authBranchId = 'LDP-999';
    rerender();

    act(() => result.current.submitPin('123456'));
    expect(result.current.state.status).toBe('LOCAL_FAILURE');
    expect(projectMock).not.toHaveBeenCalled();
  });

  it('restart recovery: opening on a target with an existing active row recovers into RECOVERED_ACTIVE without offering manager controls', async () => {
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', 'b'.repeat(32), {
        ...record(),
        adjudicationId: 'b'.repeat(32),
      });
    });
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
    act(() => result.current.open(ORDER));
    await waitFor(() => expect(result.current.state.status).toBe('RECOVERED_ACTIVE'));
  });

  it('wrong-branch D-2 rows never block this branch\'s target', async () => {
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', 'c'.repeat(32), {
        ...record(),
        adjudicationId: 'c'.repeat(32),
        branchId: 'LDP-002',
      });
    });
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
    act(() => result.current.open(ORDER));
    await waitFor(() => expect(result.current.state.status).toBe('VOID_REASON_ENTRY'));
  });

  describe('RC-E1-002 — functional-updater purity: reconciliation I/O never starts inside a setState updater', () => {
    it('StrictMode: one manual reconciliation action causes exactly one D-2 precheck', async () => {
      projectMock.mockResolvedValue({ kind: 'uncertain' });
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }), {
        wrapper: StrictMode,
      });
      await driveToManagerPin(result);
      act(() => result.current.submitPin('123456'));
      await waitFor(() => expect(result.current.state.status).toBe('LOCAL_UNCERTAIN'));
      precheckMock.mockClear();

      act(() => result.current.retryReconciliation());
      await waitFor(() => expect(result.current.state.status).toBe('VOID_REASON_ENTRY'));
      expect(precheckMock).toHaveBeenCalledTimes(1);
    });

    it('repeated reconciliation clicks while the same D-2 read is active collapse into ONE precheck', async () => {
      projectMock.mockResolvedValue({ kind: 'uncertain' });
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
      await driveToManagerPin(result);
      act(() => result.current.submitPin('123456'));
      await waitFor(() => expect(result.current.state.status).toBe('LOCAL_UNCERTAIN'));
      precheckMock.mockClear();

      act(() => {
        result.current.retryReconciliation();
        result.current.retryReconciliation();
        result.current.retryReconciliation();
      });
      expect(precheckMock).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(result.current.state.status).toBe('VOID_REASON_ENTRY'));
    });

    it('a stale reconciliation result is ignored once the flow has moved on (closed/reopened) before the precheck resolves', async () => {
      projectMock.mockResolvedValue({ kind: 'uncertain' });
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
      await driveToManagerPin(result);
      act(() => result.current.submitPin('123456'));
      await waitFor(() => expect(result.current.state.status).toBe('LOCAL_UNCERTAIN'));
      const staleIdentity =
        result.current.state.status === 'LOCAL_UNCERTAIN' ? result.current.state.identity : null;
      precheckMock.mockClear();

      let resolveStale!: (o: Awaited<ReturnType<typeof precheckMock>>) => void;
      precheckMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStale = resolve;
          }),
      );

      act(() => result.current.retryReconciliation());
      expect(precheckMock).toHaveBeenCalledTimes(1);

      // The flow moves on (close + reopen) BEFORE the stale precheck resolves.
      act(() => result.current.close());
      act(() => result.current.open(ORDER));
      await waitFor(() => expect(result.current.state.status).toBe('VOID_REASON_ENTRY'));
      const freshIdentity =
        result.current.state.status === 'VOID_REASON_ENTRY' ? result.current.state.identity : null;
      expect(freshIdentity?.localIntentId).not.toBe(staleIdentity?.localIntentId);

      await act(async () => {
        resolveStale({ kind: 'clear' });
      });
      // The stale outcome must never touch the now-fresh flow.
      expect(result.current.state.status).toBe('VOID_REASON_ENTRY');
      expect(
        result.current.state.status === 'VOID_REASON_ENTRY' ? result.current.state.identity.localIntentId : null,
      ).toBe(freshIdentity?.localIntentId);
    });
  });

  describe('RC-E1-002/RC-E1-005 — manager-change minting happens outside any functional updater', () => {
    it('StrictMode: a real manager CHANGE mints the new localIntentId exactly once', async () => {
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }), {
        wrapper: StrictMode,
      });
      await driveToManagerPin(result); // ends on MANAGER_PIN_ENTRY bound to mgr-1

      act(() => result.current.backToManagerSelect());
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_SELECT'));
      mintMock.mockClear();

      act(() => result.current.chooseManager('mgr-2'));
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));
      expect(mintMock).toHaveBeenCalledTimes(1);
      expect(
        result.current.state.status === 'MANAGER_PIN_ENTRY' ? result.current.state.identity.managerStaffId : null,
      ).toBe('mgr-2');
    });

    it('StrictMode: re-selecting the SAME already-bound manager mints nothing', async () => {
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }), {
        wrapper: StrictMode,
      });
      await driveToManagerPin(result); // ends on MANAGER_PIN_ENTRY bound to mgr-1

      act(() => result.current.backToManagerSelect());
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_SELECT'));
      mintMock.mockClear();

      act(() => result.current.chooseManager('mgr-1'));
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));
      expect(mintMock).not.toHaveBeenCalled();
    });

    it('RC-E1-005: PIN(A) -> back -> select(A) preserves the SAME localIntentId', async () => {
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
      await driveToManagerPin(result);
      const before =
        result.current.state.status === 'MANAGER_PIN_ENTRY' ? result.current.state.identity.localIntentId : null;

      act(() => result.current.backToManagerSelect());
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_SELECT'));
      act(() => result.current.chooseManager('mgr-1'));
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));

      expect(
        result.current.state.status === 'MANAGER_PIN_ENTRY' ? result.current.state.identity.localIntentId : null,
      ).toBe(before);
    });

    it('RC-E1-005: PIN(A) -> back -> select(B) commits a NEW localIntentId — B never inherits A\'s intent', async () => {
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
      await driveToManagerPin(result);
      const before =
        result.current.state.status === 'MANAGER_PIN_ENTRY' ? result.current.state.identity.localIntentId : null;

      act(() => result.current.backToManagerSelect());
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_SELECT'));
      act(() => result.current.chooseManager('mgr-2'));
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));

      if (result.current.state.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
      expect(result.current.state.identity.managerStaffId).toBe('mgr-2');
      expect(result.current.state.identity.localIntentId).not.toBe(before);
    });
  });

  describe('RC-E1-002/RC-E1-005 — stale manager-callback coherence (Gemini-021 remediation)', () => {
    it('two manager selections issued from the SAME render (before rerender) never commit a mismatched manager/intent pair', async () => {
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
      act(() => result.current.open(ORDER));
      await waitFor(() => expect(result.current.state.status).toBe('VOID_REASON_ENTRY'));
      act(() => result.current.submitReason('ลูกค้าเปลี่ยนใจ', ''));
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_SELECT'));

      // Both calls below read `result.current.chooseManager` from the SAME
      // render (React has not flushed a re-render between them inside one
      // `act`), mirroring a rapid double-click/two-handlers-same-render race.
      act(() => {
        result.current.chooseManager('mgr-1');
        result.current.chooseManager('mgr-2');
      });
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));

      if (result.current.state.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
      // Coherent pair required either way — never a mix of one call's manager
      // with the other's (would-be) intent.
      expect(result.current.state.identity.managerStaffId).toBe('mgr-1');
      expect(projectMock).not.toHaveBeenCalled();
    });

    it('a retained (stale) chooseManager callback, invoked after a newer manager/intent has already committed, is a full no-op', async () => {
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
      await driveToManagerPin(result); // MANAGER_PIN_ENTRY, bound to mgr-1
      const staleChooseManager = result.current.chooseManager; // retained across the transitions below
      const staleIdentity =
        result.current.state.status === 'MANAGER_PIN_ENTRY' ? result.current.state.identity : null;

      act(() => result.current.backToManagerSelect());
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_SELECT'));
      act(() => result.current.chooseManager('mgr-2')); // fresh, non-stale callback — legitimate manager change
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));
      if (result.current.state.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
      expect(result.current.state.identity.managerStaffId).toBe('mgr-2');
      const committedIntentId = result.current.state.identity.localIntentId;
      expect(committedIntentId).not.toBe(staleIdentity?.localIntentId);

      mintMock.mockClear();
      // The stale callback fires now, re-requesting its OWN (stale) manager.
      act(() => staleChooseManager('mgr-1'));

      // No-op: no extra mint, no D-3 side effect, and the committed
      // manager/intent pair from the newer selection is untouched — never
      // mgr-1 (stale request) paired with the newer intent, and never mgr-2
      // paired with the stale intent.
      expect(mintMock).not.toHaveBeenCalled();
      expect(projectMock).not.toHaveBeenCalled();
      if (result.current.state.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
      expect(result.current.state.identity.managerStaffId).toBe('mgr-2');
      expect(result.current.state.identity.localIntentId).toBe(committedIntentId);
    });
  });

  describe('RC-E1-002-FRESH-001 / RC-E1-005-FRESH-001 — authority epoch/generation gate (Gemini-023 remediation)', () => {
    it('two manager CHANGES issued from the SAME render (both different from the already-bound prior manager) mint exactly once — the second is a full no-op before mint', async () => {
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
      await driveToManagerPin(result); // MANAGER_PIN_ENTRY, bound to mgr-1
      act(() => result.current.backToManagerSelect());
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_SELECT'));
      mintMock.mockClear();

      // Both calls read `chooseManager` from the SAME render (no rerender
      // flushed between them inside this one `act`). Both compute a real
      // manager CHANGE from the identical bound-to-mgr-1 snapshot — B then
      // C — which is the exact double-mint race RC-E1-002-FRESH-001 closes:
      // pre-remediation, C also minted (and discarded) a second
      // `localIntentId` before the machine's own freshness check rejected
      // its state write.
      act(() => {
        result.current.chooseManager('mgr-2');
        result.current.chooseManager('mgr-3');
      });
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));

      expect(mintMock).toHaveBeenCalledTimes(1);
      if (result.current.state.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
      expect(result.current.state.identity.managerStaffId).toBe('mgr-2');
      expect(projectMock).not.toHaveBeenCalled();
    });

    it('a retained manager-selection callback requesting a DIFFERENT manager, invoked after a newer selection already committed, mints nothing and no-ops', async () => {
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
      await driveToManagerPin(result); // MANAGER_PIN_ENTRY, bound to mgr-1
      act(() => result.current.backToManagerSelect());
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_SELECT'));
      // Retained BEFORE mgr-2 commits — from this closure's perspective the
      // prior manager is still mgr-1, so requesting mgr-3 below is a real
      // manager CHANGE (unlike the same-manager stale case already covered
      // above), which is what actually exercises the mint gate.
      const staleChooseManager = result.current.chooseManager;

      act(() => result.current.chooseManager('mgr-2'));
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));
      if (result.current.state.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
      expect(result.current.state.identity.managerStaffId).toBe('mgr-2');
      const committedIntentId = result.current.state.identity.localIntentId;

      mintMock.mockClear();
      act(() => staleChooseManager('mgr-3'));

      expect(mintMock).not.toHaveBeenCalled();
      expect(projectMock).not.toHaveBeenCalled();
      if (result.current.state.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
      expect(result.current.state.identity.managerStaffId).toBe('mgr-2');
      expect(result.current.state.identity.localIntentId).toBe(committedIntentId);
    });

    it('a retained submitPin from an abandoned PIN attempt (A -> Back -> B) is a full no-op: zero D-3, isSubmitting never flips, B/intent-B untouched', async () => {
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
      await driveToManagerPin(result); // MANAGER_PIN_ENTRY, bound to mgr-1 / intent-A
      const staleSubmitPin = result.current.submitPin; // retained from the A-era render

      act(() => result.current.backToManagerSelect());
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_SELECT'));
      act(() => result.current.chooseManager('mgr-2'));
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));
      if (result.current.state.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
      expect(result.current.state.identity.managerStaffId).toBe('mgr-2');
      const intentB = result.current.state.identity.localIntentId;

      act(() => staleSubmitPin('123456'));

      expect(projectMock).not.toHaveBeenCalled();
      expect(result.current.isSubmitting).toBe(false);
      if (result.current.state.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
      expect(result.current.state.identity.managerStaffId).toBe('mgr-2');
      expect(result.current.state.identity.localIntentId).toBe(intentB);

      // The retained callback must not even have been able to resurrect
      // MANAGER_PIN_ENTRY/A — proven by never seeing intent-A's state again
      // and never touching D-3 above.
    });

    it('a retained submitPin from before close/reopen is a full no-op after reopen', async () => {
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
      await driveToManagerPin(result);
      const staleSubmitPin = result.current.submitPin;

      act(() => result.current.close());
      act(() => result.current.open(ORDER));
      await waitFor(() => expect(result.current.state.status).toBe('VOID_REASON_ENTRY'));

      act(() => staleSubmitPin('123456'));

      expect(projectMock).not.toHaveBeenCalled();
      expect(result.current.isSubmitting).toBe(false);
      expect(result.current.state.status).toBe('VOID_REASON_ENTRY');
    });

    it('invalid-PIN retry within the SAME manager/flow still works after the epoch gate (same-intent retry unaffected)', async () => {
      projectMock.mockResolvedValue({ kind: 'not_approved', errorCode: 'DENIED_INVALID_PIN' });
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
      await driveToManagerPin(result);
      const before =
        result.current.state.status === 'MANAGER_PIN_ENTRY' ? result.current.state.identity.localIntentId : null;

      act(() => result.current.submitPin('000000'));
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));

      projectMock.mockResolvedValue({ kind: 'projected', record: record() });
      act(() => result.current.submitPin('123456'));
      await waitFor(() => expect(result.current.state.status).toBe('CAPTURED_PENDING_ADJUDICATION'));
      expect(projectMock).toHaveBeenCalledTimes(2);
      if (result.current.state.status !== 'CAPTURED_PENDING_ADJUDICATION') throw new Error('unreachable');
      expect(result.current.state.identity.localIntentId).toBe(before);
    });
  });

  describe('RC-E1-006-FRESH-001 — retained Back cannot consume the live authority epoch (Gemini-024 remediation)', () => {
    it('TEST A: a retained Back invoked after the current Back is a full no-op and does not stale-out the current manager-selection callback', async () => {
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
      await driveToManagerPin(result); // MANAGER_PIN_ENTRY, bound to mgr-1 (manager A)
      const staleBack = result.current.backToManagerSelect; // retained A-era Back

      act(() => result.current.backToManagerSelect()); // current Back -> MANAGER_SELECT, consumes the epoch once
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_SELECT'));
      // Captured from THIS render, i.e. the render the current (post-Back)
      // epoch belongs to — this is "the current manager-selection callback"
      // the RC requires to remain usable after the stale Back fires below.
      const currentChooseManager = result.current.chooseManager;
      mintMock.mockClear();

      // Retained A-era Back fires AFTER the epoch it was captured against
      // has already been consumed by the current Back above. Pre-remediation
      // this unconditionally advanced the epoch a second time, falsely
      // staling out `currentChooseManager` before it was ever used.
      act(() => staleBack());
      expect(result.current.state.status).toBe('MANAGER_SELECT');
      expect(mintMock).not.toHaveBeenCalled();
      expect(projectMock).not.toHaveBeenCalled();

      act(() => currentChooseManager('mgr-2')); // legitimate manager B selection
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));

      // Exactly one mint for the real A -> B manager change; the stale Back
      // above must not have consumed the epoch this selection needed.
      expect(mintMock).toHaveBeenCalledTimes(1);
      if (result.current.state.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
      expect(result.current.state.identity.managerStaffId).toBe('mgr-2');
      expect(projectMock).not.toHaveBeenCalled();
    });

    it('TEST B: a retained A-era Back invoked after manager B has reached PIN entry is a full no-op — B/intent-B untouched', async () => {
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection() }));
      await driveToManagerPin(result); // MANAGER_PIN_ENTRY, bound to mgr-1 (manager A)
      const staleBack = result.current.backToManagerSelect; // retained A-era Back

      act(() => result.current.backToManagerSelect()); // current Back -> MANAGER_SELECT
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_SELECT'));
      act(() => result.current.chooseManager('mgr-2')); // fresh selection -> manager B
      await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));
      if (result.current.state.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
      expect(result.current.state.identity.managerStaffId).toBe('mgr-2');
      const intentB = result.current.state.identity.localIntentId;

      precheckMock.mockClear();
      mintMock.mockClear();
      // The stale A-era Back, retained since before the current Back even
      // ran, fires now that a NEWER authority attempt (B's PIN entry) is
      // live. It must not be able to back B's live flow out to
      // MANAGER_SELECT.
      act(() => staleBack());

      expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY');
      if (result.current.state.status !== 'MANAGER_PIN_ENTRY') throw new Error('unreachable');
      expect(result.current.state.identity.managerStaffId).toBe('mgr-2');
      expect(result.current.state.identity.localIntentId).toBe(intentB);
      expect(mintMock).not.toHaveBeenCalled();
      expect(projectMock).not.toHaveBeenCalled();
      expect(precheckMock).not.toHaveBeenCalled();
      expect(result.current.isSubmitting).toBe(false);
    });
  });
});
