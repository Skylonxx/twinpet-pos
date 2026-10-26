// @vitest-environment jsdom

// Return/Refund V1 packet 022 — the terminal's ledger hook says whether its
// list is the listener's answer for THIS branch (`loaded`) or nothing has been
// heard yet / the listener failed. The server-authoritative close attests the
// list it is handed, so a not-yet-loaded `[]` must never be mistaken for "no
// sales". The list itself (what the legacy drawer folds) is unchanged.
//
// Provenance: on the parent (6376403) the hook returns the bare array — there is
// no loaded signal at all, so every case fails on the missing contract.

import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { AsyncOrder } from '../types';

type Sub = {
  constraints: Array<{ field: string; op: string; value: unknown }>;
  next: (snap: { docs: Array<{ id: string; data: () => unknown }> }) => void;
  error: (err: unknown) => void;
  unsub: ReturnType<typeof vi.fn>;
};

const fx = vi.hoisted(() => ({ subs: [] as Sub[] }));

vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, name: string) => ({ name }),
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  query: (_coll: unknown, ...constraints: unknown[]) => ({ constraints }),
  onSnapshot: (q: { constraints: Sub['constraints'] }, next: Sub['next'], error: Sub['error']) => {
    const unsub = vi.fn();
    fx.subs.push({ constraints: q.constraints, next, error, unsub });
    return unsub;
  },
}));
vi.mock('../firebase', () => ({ db: {}, isFirebaseConfigured: true }));
vi.mock('../pos/deviceId', () => ({ getDeviceId: () => 'DEV-1' }));

import { useLocalLedger } from './useLocalLedger';

function order(id: string, shiftId: string, branchId = 'B1'): AsyncOrder {
  return {
    id,
    billId: `bill-${id}`,
    deviceId: 'DEV-1',
    branchId,
    shiftId,
    staffId: 'U1',
    staffName: 'Test User',
    customerId: null,
    status: 'completed',
    reconcileStatus: 'pending_reconcile',
    total: 100,
    paidAmt: 100,
    changeAmt: 0,
    creditAmt: 0,
    payments: [{ method: 'cash', amount: 100 }],
    serverCreatedAt: null,
    clientCreatedAt: 1,
  } as unknown as AsyncOrder;
}

function snap(...orders: AsyncOrder[]) {
  return { docs: orders.map((o) => ({ id: o.id, data: () => o })) };
}

type LedgerState = { sales: Array<{ id: string; shiftId: string }>; loaded: boolean };
const state = (r: { current: unknown }) => r.current as LedgerState;

afterEach(() => {
  cleanup();
  fx.subs.length = 0;
});

describe('022 — useLocalLedger loaded signal', () => {
  test('[RED-parent] before the first snapshot: not loaded (the empty list is "unknown", not "no sales")', () => {
    const { result } = renderHook(() => useLocalLedger('B1'));
    expect(state(result)).toEqual({ sales: [], loaded: false });
  });

  test('[RED-parent] the listener is scoped to this branch + this device; its snapshot marks the list loaded', () => {
    const { result } = renderHook(() => useLocalLedger('B1'));
    expect(fx.subs).toHaveLength(1);
    expect(fx.subs[0]!.constraints).toEqual([
      { field: 'branchId', op: '==', value: 'B1' },
      { field: 'deviceId', op: '==', value: 'DEV-1' },
    ]);
    act(() => fx.subs[0]!.next(snap(order('DEV-1-1', 'shift-1'), order('DEV-1-2', 'shift-1'))));
    expect(state(result).loaded).toBe(true);
    expect(state(result).sales.map((s) => s.id)).toEqual(['DEV-1-1', 'DEV-1-2']);
  });

  test('[RED-parent] an EMPTY snapshot is a loaded empty list (a genuine "no sales")', () => {
    const { result } = renderHook(() => useLocalLedger('B1'));
    act(() => fx.subs[0]!.next(snap()));
    expect(state(result)).toEqual({ sales: [], loaded: true });
  });

  test('[RED-parent] a listener error un-loads the list (the dead listener no longer tracks new sales); the list itself is kept', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result } = renderHook(() => useLocalLedger('B1'));
    act(() => fx.subs[0]!.next(snap(order('DEV-1-1', 'shift-1'))));
    expect(state(result).loaded).toBe(true);
    act(() => fx.subs[0]!.error(new Error('permission-denied')));
    expect(state(result).loaded).toBe(false);
    expect(state(result).sales.map((s) => s.id)).toEqual(['DEV-1-1']);
    vi.restoreAllMocks();
  });

  test('[RED-parent] a branch change is not loaded until the NEW branch answers — the old branch never counts as loaded', () => {
    const { result, rerender } = renderHook(({ b }) => useLocalLedger(b), { initialProps: { b: 'B1' as string | null } });
    act(() => fx.subs[0]!.next(snap(order('DEV-1-1', 'shift-B1'))));
    expect(state(result).loaded).toBe(true);
    rerender({ b: 'B2' });
    expect(fx.subs[0]!.unsub).toHaveBeenCalledTimes(1);
    expect(fx.subs[1]!.constraints[0]).toEqual({ field: 'branchId', op: '==', value: 'B2' });
    expect(state(result).loaded).toBe(false);
    act(() => fx.subs[1]!.next(snap(order('DEV-1-9', 'shift-B2', 'B2'))));
    expect(state(result).loaded).toBe(true);
    expect(state(result).sales.map((s) => s.shiftId)).toEqual(['shift-B2']);
  });

  test('[RED-parent] a late snapshot of the OLD branch listener cannot mark the new branch loaded', () => {
    const { result, rerender } = renderHook(({ b }) => useLocalLedger(b), { initialProps: { b: 'B1' as string | null } });
    rerender({ b: 'B2' });
    act(() => fx.subs[0]!.next(snap(order('DEV-1-1', 'shift-B1'))));
    expect(state(result).loaded).toBe(false);
  });

  test('[RED-parent] no branch: empty and never loaded; no listener', () => {
    const { result } = renderHook(() => useLocalLedger(null));
    expect(state(result)).toEqual({ sales: [], loaded: false });
    expect(fx.subs).toHaveLength(0);
  });
});
