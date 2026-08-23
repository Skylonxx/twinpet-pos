// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryReversalStore } from '../../lib/pos/offline/reversalLocalStore';
import {
  type ActiveSyncScope,
  type SyncCenterReadResult,
} from '../../lib/pos/offline/syncCenterModel';
import {
  __resetCanonicalSyncContextForTests,
  __setCanonicalSyncContextForTests,
} from '../../lib/pos/offline/canonicalSyncContext';
import { enqueueVoidIntent } from '../../lib/pos/offline/voidIntentStore';
import { useSyncCenterState } from './useSyncCenterState';

const auth = vi.hoisted(() => ({
  user: { role: 'manager' as 'manager' | 'staff' | 'admin' },
  session: {},
  branchId: 'A' as string | null,
  firebaseUser: { uid: 'u1' },
  deviceId: 'X',
}));

vi.mock('../../lib/hooks/useAuth', () => ({
  useAuth: () => ({
    user: auth.user,
    session: auth.session,
    branchId: auth.branchId,
    firebaseUser: auth.firebaseUser,
  }),
}));

vi.mock('../../lib/pos/deviceId', () => ({
  getDeviceId: () => auth.deviceId,
}));

const NOW = 1_700_000_000_000;

function emptyRead(scope: ActiveSyncScope, over: Partial<SyncCenterReadResult> = {}): SyncCenterReadResult {
  return {
    scope,
    reversal: { ok: true, rows: [] },
    voidIntent: { ok: true, rows: [] },
    shiftClose: { ok: true, rows: [] },
    shiftOpen: { ok: true, rows: [] },
    saleIntent: { ok: true, rows: [] },
    orchestrator: { lastCycle: null, webLocksAvailable: true, ch4AttemptExhaustedIds: [] },
    isOnline: true,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  __resetCanonicalSyncContextForTests();
  auth.user = { role: 'manager' };
  auth.branchId = 'A';
  auth.deviceId = 'X';
});

describe('useSyncCenterState', () => {
  beforeEach(() => {
    __setCanonicalSyncContextForTests('A', 'X');
  });

  it('N-S1 a void-store notification refreshes without remount', async () => {
    const read = vi.fn(async (scope: ActiveSyncScope) => emptyRead(scope));
    const store = createInMemoryReversalStore();
    const { result } = renderHook(() =>
      useSyncCenterState({
        read,
        reversalStore: store,
        now: () => NOW,
        intervalMs: 60_000,
        navigatorRef: { onLine: true },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const afterMount = read.mock.calls.length;
    await enqueueVoidIntent(
      store,
      'ord-live',
      { branchId: 'A', deviceId: 'X', reason: 'x', voidedBy: 's' },
      NOW,
    );
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(afterMount));
    expect(result.current.view.status).toBe('scoped');
  });

  it('N-S2 / N-S5 pending count tracks unifiedPending and survives offline', async () => {
    const nav = { onLine: false };
    const read = vi.fn(async (scope: ActiveSyncScope) =>
      emptyRead(scope, {
        isOnline: false,
        reversal: {
          ok: true,
          rows: [
            {
              id: 'r1',
              businessId: 'biz',
              sourceType: 'receiving',
              sourceId: 'src',
              action: 'void',
              branchId: 'A',
              reasonCode: 'x',
              createdAt: new Date(NOW).toISOString(),
              createdByStaffId: 's1',
              createdByRole: 'manager',
              idempotencyKey: 'k',
              localMutationId: 'm',
              localCorrection: { applied: true, reversed: false, stockDelta: [] },
              status: 'queued',
            },
          ],
        },
      }),
    );
    const { result } = renderHook(() =>
      useSyncCenterState({
        read,
        reversalStore: createInMemoryReversalStore(),
        now: () => NOW,
        intervalMs: 60_000,
        navigatorRef: nav,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.isOnline).toBe(false);
    expect(result.current.view.status).toBe('scoped');
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.unifiedPending).toBe(1);
    }
  });

  it('N-S6 unavailable channel forbids a clean last-check', async () => {
    const read = vi.fn(async (scope: ActiveSyncScope) =>
      emptyRead(scope, { saleIntent: { ok: false, reason: 'unavailable' } }),
    );
    const { result } = renderHook(() =>
      useSyncCenterState({
        read,
        reversalStore: createInMemoryReversalStore(),
        now: () => NOW,
        intervalMs: 60_000,
        navigatorRef: { onLine: true },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.view.status).toBe('scoped');
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.unavailableChannelCount).toBeGreaterThan(0);
      expect(result.current.view.aggregate.lastSyncCheckAtMs).toBeNull();
    }
  });

  it('N-S7 unmount releases the interval and ignores later reads', async () => {
    let readCount = 0;
    const read = vi.fn(async (scope: ActiveSyncScope) => {
      readCount += 1;
      return emptyRead(scope);
    });
    const { unmount } = renderHook(() =>
      useSyncCenterState({
        read,
        reversalStore: createInMemoryReversalStore(),
        now: () => NOW,
        intervalMs: 60_000,
        navigatorRef: { onLine: true },
      }),
    );
    await waitFor(() => expect(readCount).toBeGreaterThan(0));
    const before = readCount;
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(readCount).toBe(before);
  });

  it('ALL branch fails closed with counts absent', async () => {
    auth.branchId = 'ALL';
    const read = vi.fn(async (scope: ActiveSyncScope) => emptyRead(scope));
    const { result } = renderHook(() =>
      useSyncCenterState({
        read,
        reversalStore: createInMemoryReversalStore(),
        now: () => NOW,
        intervalMs: 60_000,
        navigatorRef: { onLine: true },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.view).toEqual({ status: 'scope_unavailable', reason: 'branch_all' });
    expect(read).not.toHaveBeenCalled();
  });

  it('strips lastCycle from a previous branch', async () => {
    const read = vi.fn(async (scope: ActiveSyncScope) =>
      emptyRead(scope, {
        orchestrator: {
          lastCycle: {
            trigger: 'MANUAL_INVOCATION',
            startedAtMs: 1,
            durationMs: 5,
            completed: true,
            gateOutcome: 'ran',
            channels: [{ channel: 'sale_intent', status: 'ok' }],
          },
          webLocksAvailable: true,
          ch4AttemptExhaustedIds: [],
        },
      }),
    );
    let now = 10;
    const { result, rerender } = renderHook(() =>
      useSyncCenterState({
        read,
        reversalStore: createInMemoryReversalStore(),
        now: () => now,
        intervalMs: 60_000,
        navigatorRef: { onLine: true },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    now = 50;
    auth.branchId = 'B';
    rerender();
    await waitFor(() => {
      expect(result.current.scope?.branchId).toBe('B');
    });
    await waitFor(() => {
      if (result.current.view.status === 'scoped') {
        expect(result.current.view.aggregate.lastSyncCheckAtMs).toBeNull();
      }
    });
  });
});
