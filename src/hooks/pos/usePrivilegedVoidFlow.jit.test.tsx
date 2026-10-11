// @vitest-environment jsdom
/**
 * TPOS-USABLE-POS-VOID-OAC-DECISION-IMPLEMENT-CLAUDE-002 — D-V7 just-in-time
 * manager OAC provisioning inside the privileged void submit episode.
 *
 * Proves: provisioning only for a missing/stale capability of the SELECTED
 * manager while online; exactly one provisioning call and exactly one D-3
 * retry with the same intent/manager/target/PIN; offline fails closed with no
 * provisioning; failed/uncertain provisioning never re-projects; repeated
 * clicks never duplicate the ceremony; a missing operator staff session
 * invalidates the AuthProvider state and never provisions.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryReversalStore, type ReversalLocalStore } from '../../lib/pos/offline/reversalLocalStore';
import type { ProjectPrivilegedOfflineActionOutcome } from '../../lib/pos/offline/projectPrivilegedOfflineAction';
import type { ProvisionManagerOacOutcome } from '../../lib/pos/privilegedVoid/provisionManagerOac';

let store: ReversalLocalStore = createInMemoryReversalStore();
const projectMock = vi.fn<(input: Record<string, unknown>) => Promise<ProjectPrivilegedOfflineActionOutcome>>();
const provisionMock = vi.fn<(input: Record<string, unknown>) => Promise<ProvisionManagerOacOutcome>>();
const invalidateStaffSession = vi.fn();

vi.mock('../../lib/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'staff-1' }, branchId: 'LDP-001', invalidateStaffSession }),
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
  return { ...actual, projectPrivilegedOfflineAction: (input: Record<string, unknown>) => projectMock(input) };
});
vi.mock('../../lib/pos/privilegedVoid/provisionManagerOac', () => ({
  provisionManagerOac: (input: Record<string, unknown>) => provisionMock(input),
}));

import { usePrivilegedVoidFlow } from './usePrivilegedVoidFlow';

const ORDER = {
  actionId: 'VOID_SETTLED_SALE' as const,
  targetOrderId: 'order-1',
  targetOrderUtc7Date: '2026-10-11',
  targetBranchId: 'LDP-001',
  operatorStaffId: 'staff-1',
};

const selection = {
  orderId: 'order-1',
  orderBranchId: 'LDP-001',
  expectedActionId: 'VOID_SETTLED_SALE' as const,
  isCurrentlyVoidEligible: () => true,
};

const projectedRecord = { adjudicationId: 'a'.repeat(32) } as never;
const denied = (errorCode: string): ProjectPrivilegedOfflineActionOutcome => ({ kind: 'not_approved', errorCode });

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });
}

async function driveToPin(result: { current: ReturnType<typeof usePrivilegedVoidFlow> }) {
  act(() => result.current.open(ORDER));
  await waitFor(() => expect(result.current.state.status).toBe('VOID_REASON_ENTRY'));
  act(() => result.current.submitReason('ลูกค้าเปลี่ยนใจ', ''));
  act(() => result.current.chooseManager('mgr-1'));
  await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));
}

beforeEach(() => {
  store = createInMemoryReversalStore();
  projectMock.mockReset();
  provisionMock.mockReset();
  invalidateStaffSession.mockReset();
  setOnline(true);
});
afterEach(() => {
  cleanup();
  setOnline(true);
});

describe('D-V7 JIT manager OAC provisioning', () => {
  it('OAC present and valid: no provisioning, a single D-3 call', async () => {
    projectMock.mockResolvedValue({ kind: 'projected', record: projectedRecord });
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection }));
    await driveToPin(result);
    act(() => result.current.submitPin('1234'));
    await waitFor(() => expect(result.current.state.status).toBe('CAPTURED_PENDING_ADJUDICATION'));
    expect(provisionMock).not.toHaveBeenCalled();
    expect(projectMock).toHaveBeenCalledTimes(1);
  });

  it.each(['DENIED_OAC_MISSING', 'DENIED_OAC_STALE'])(
    '%s + online: provisions the SELECTED manager once, then retries D-3 exactly once with the same intent/PIN',
    async (code) => {
      projectMock
        .mockResolvedValueOnce(denied(code))
        .mockResolvedValueOnce({ kind: 'projected', record: projectedRecord });
      provisionMock.mockResolvedValue({ kind: 'provisioned' });
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection }));
      await driveToPin(result);
      act(() => result.current.submitPin('1234'));
      await waitFor(() => expect(result.current.state.status).toBe('CAPTURED_PENDING_ADJUDICATION'));

      expect(provisionMock).toHaveBeenCalledTimes(1);
      expect(provisionMock).toHaveBeenCalledWith({ managerStaffId: 'mgr-1', branchId: 'LDP-001', pin: '1234' });
      expect(projectMock).toHaveBeenCalledTimes(2);
      const [first, second] = projectMock.mock.calls.map((c) => c[0]);
      expect(second).toEqual(first);
      expect(second!.localIntentId).toBe(first!.localIntentId);
      expect(second!.managerStaffId).toBe('mgr-1');
      expect(second!.targetOrderId).toBe('order-1');
      expect(second!.pin).toBe('1234');
      expect(provisionMock.mock.invocationCallOrder[0]).toBeGreaterThan(projectMock.mock.invocationCallOrder[0]!);
      expect(provisionMock.mock.invocationCallOrder[0]).toBeLessThan(projectMock.mock.invocationCallOrder[1]!);
    },
  );

  it('shows PROVISIONING_APPROVAL while the ceremony runs and is held by the in-flight guard (repeat clicks never duplicate)', async () => {
    projectMock
      .mockResolvedValueOnce(denied('DENIED_OAC_MISSING'))
      .mockResolvedValueOnce({ kind: 'projected', record: projectedRecord });
    let release!: (o: ProvisionManagerOacOutcome) => void;
    provisionMock.mockReturnValue(new Promise((r) => (release = r)));
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection }));
    await driveToPin(result);
    act(() => result.current.submitPin('1234'));
    await waitFor(() => expect(result.current.state.status).toBe('PROVISIONING_APPROVAL'));
    expect(result.current.isSubmitting).toBe(true);

    act(() => {
      result.current.submitPin('1234');
      result.current.submitPin('1234');
    });
    expect(provisionMock).toHaveBeenCalledTimes(1);
    expect(projectMock).toHaveBeenCalledTimes(1);

    await act(async () => release({ kind: 'provisioned' }));
    await waitFor(() => expect(result.current.state.status).toBe('CAPTURED_PENDING_ADJUDICATION'));
    expect(provisionMock).toHaveBeenCalledTimes(1);
    expect(projectMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['DENIED_OAC_MISSING', 'denied_oac_missing'],
    ['DENIED_OAC_STALE', 'denied_oac_stale'],
  ])('%s + offline: fails closed (%s) with NO provisioning and no second D-3 call', async (code, reason) => {
    setOnline(false);
    projectMock.mockResolvedValue(denied(code));
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection }));
    await driveToPin(result);
    act(() => result.current.submitPin('1234'));
    await waitFor(() => expect(result.current.state.status).toBe('LOCAL_FAILURE'));
    expect(result.current.state).toMatchObject({ reasonCode: reason });
    expect(provisionMock).not.toHaveBeenCalled();
    expect(projectMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['uncertain', 'provisioning_uncertain'],
    ['failed', 'provisioning_failed'],
    ['pin_rejected', 'provisioning_pin_rejected'],
    ['not_eligible', 'provisioning_not_eligible'],
    ['device_not_ready', 'provisioning_device_not_ready'],
  ] as const)('provisioning %s: terminal %s, never re-projects (no void submission)', async (kind, reason) => {
    projectMock.mockResolvedValue(denied('DENIED_OAC_MISSING'));
    provisionMock.mockResolvedValue({ kind });
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection }));
    await driveToPin(result);
    act(() => result.current.submitPin('1234'));
    await waitFor(() => expect(result.current.state.status).toBe('LOCAL_FAILURE'));
    expect(result.current.state).toMatchObject({ reasonCode: reason });
    expect(provisionMock).toHaveBeenCalledTimes(1);
    expect(projectMock).toHaveBeenCalledTimes(1);
  });

  it('after successful provisioning the single retry is final: a second missing/stale denial fails closed, no loop', async () => {
    projectMock.mockResolvedValue(denied('DENIED_OAC_STALE'));
    provisionMock.mockResolvedValue({ kind: 'provisioned' });
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection }));
    await driveToPin(result);
    act(() => result.current.submitPin('1234'));
    await waitFor(() => expect(result.current.state.status).toBe('LOCAL_FAILURE'));
    expect(result.current.state).toMatchObject({ reasonCode: 'denied_oac_stale' });
    expect(provisionMock).toHaveBeenCalledTimes(1);
    expect(projectMock).toHaveBeenCalledTimes(2);
  });

  it('after provisioning, a wrong PIN on the native retry is the normal retry-in-place (lockout semantics stay native)', async () => {
    projectMock
      .mockResolvedValueOnce(denied('DENIED_OAC_MISSING'))
      .mockResolvedValueOnce(denied('DENIED_INVALID_PIN'));
    provisionMock.mockResolvedValue({ kind: 'provisioned' });
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection }));
    await driveToPin(result);
    act(() => result.current.submitPin('1234'));
    await waitFor(() => expect(result.current.state.status).toBe('MANAGER_PIN_ENTRY'));
    expect(result.current.state).toMatchObject({ pinErrorCode: 'DENIED_INVALID_PIN' });
  });

  it.each(['DENIED_INVALID_PIN', 'DENIED_LOCKED', 'DENIED_UNVERIFIABLE', 'DENIED_STALE', 'MANAGER_NOT_AUTHORIZED'])(
    '%s never triggers provisioning',
    async (code) => {
      projectMock.mockResolvedValue(denied(code));
      const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection }));
      await driveToPin(result);
      act(() => result.current.submitPin('1234'));
      await waitFor(() => expect(result.current.isSubmitting).toBe(false));
      expect(provisionMock).not.toHaveBeenCalled();
      expect(projectMock).toHaveBeenCalledTimes(1);
    },
  );

  it('DENIED_STAFF_SESSION: distinct failure, no provisioning, and the auth staff session is invalidated', async () => {
    projectMock.mockResolvedValue(denied('DENIED_STAFF_SESSION'));
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection }));
    await driveToPin(result);
    act(() => result.current.submitPin('1234'));
    await waitFor(() => expect(result.current.state.status).toBe('LOCAL_FAILURE'));
    expect(result.current.state).toMatchObject({ reasonCode: 'denied_staff_session' });
    expect(provisionMock).not.toHaveBeenCalled();
    expect(invalidateStaffSession).toHaveBeenCalledTimes(1);
  });

  it('closing the flow while provisioning: the retry never runs for the abandoned intent', async () => {
    projectMock.mockResolvedValue(denied('DENIED_OAC_MISSING'));
    let release!: (o: ProvisionManagerOacOutcome) => void;
    provisionMock.mockReturnValue(new Promise((r) => (release = r)));
    const { result } = renderHook(() => usePrivilegedVoidFlow({ liveSelection: selection }));
    await driveToPin(result);
    act(() => result.current.submitPin('1234'));
    await waitFor(() => expect(result.current.state.status).toBe('PROVISIONING_APPROVAL'));
    act(() => result.current.close());
    await act(async () => release({ kind: 'provisioned' }));
    await waitFor(() => expect(result.current.isSubmitting).toBe(false));
    expect(result.current.state.status).toBe('IDLE');
    expect(projectMock).toHaveBeenCalledTimes(1);
  });
});
