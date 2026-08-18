// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const whereSpy = vi.fn((field: string, op: string, value: unknown) => ({ __where: [field, op, value] }));
const orderBySpy = vi.fn((field: string, dir: string) => ({ __orderBy: [field, dir] }));
const limitSpy = vi.fn((n: number) => ({ __limit: n }));
const collectionSpy = vi.fn((_db: unknown, name: string) => ({ __col: name }));
const querySpy = vi.fn((...args: unknown[]) => ({ __query: args }));
const unsubs: Array<ReturnType<typeof vi.fn>> = [];
const onSnapshotSpy = vi.fn((...args: unknown[]) => {
  void args;
  const unsub = vi.fn();
  unsubs.push(unsub);
  return unsub;
});

vi.mock('firebase/firestore', () => ({
  collection: (...args: [unknown, string]) => collectionSpy(...args),
  query: (...args: unknown[]) => querySpy(...args),
  where: (...args: [string, string, unknown]) => whereSpy(...args),
  orderBy: (...args: [string, string]) => orderBySpy(...args),
  limit: (n: number) => limitSpy(n),
  onSnapshot: (a: unknown, b?: unknown, c?: unknown, d?: unknown) => onSnapshotSpy(a, b, c, d),
}));

vi.mock('../firebase', () => ({
  db: {},
  isFirebaseConfigured: true,
}));

vi.mock('./adminGate', () => ({
  shouldStartExceptionsQuery: (enabled: boolean, ready: boolean, db: boolean) => enabled && ready && db,
  canViewReconciliationExceptions: (role: string | null | undefined) => role === 'admin',
}));

import { useReconciliationExceptions } from './useReconciliationExceptions';
import { canViewReconciliationExceptions } from './adminGate';
import { V9_FAULT_LIMIT } from './exceptionRows';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  unsubs.length = 0;
});

beforeEach(() => {
  whereSpy.mockClear();
  orderBySpy.mockClear();
  limitSpy.mockClear();
  onSnapshotSpy.mockClear();
  querySpy.mockClear();
});

describe('useReconciliationExceptions V9 query contract', () => {
  test('N01 GLOBAL query uses voidRevisionFaultAt desc + limit and no branch where', () => {
    renderHook(() => useReconciliationExceptions(true, ['ALL']));
    expect(orderBySpy).toHaveBeenCalledWith('voidRevisionFaultAt', 'desc');
    expect(limitSpy).toHaveBeenCalledWith(V9_FAULT_LIMIT);
    const branchWheres = whereSpy.mock.calls.filter((c) => c[0] === 'branchId');
    expect(branchWheres).toHaveLength(0);
  });

  test('N02 SCOPED query constrains branchId per accessible branch', () => {
    renderHook(() => useReconciliationExceptions(true, ['LDP-001', 'BKK-002']));
    const branchWheres = whereSpy.mock.calls.filter((c) => c[0] === 'branchId' && c[1] === '==');
    expect(branchWheres.map((c) => c[2]).sort()).toEqual(['BKK-002', 'LDP-001']);
  });

  test('N04 manager/non-admin starts no V9 subscription', () => {
    expect(canViewReconciliationExceptions('manager')).toBe(false);
    renderHook(() => useReconciliationExceptions(false, ['ALL']));
    expect(onSnapshotSpy).not.toHaveBeenCalled();
  });

  test('N05 includeMetadataChanges is required', () => {
    renderHook(() => useReconciliationExceptions(true, ['ALL']));
    expect(onSnapshotSpy.mock.calls.some((c) => JSON.stringify(c).includes('includeMetadataChanges'))).toBe(true);
  });

  test('N11 fan-out exactly at cap 10 is accepted', () => {
    const branches = Array.from({ length: 10 }, (_, i) => `B${i}`);
    const { result } = renderHook(() => useReconciliationExceptions(true, branches));
    const branchWheres = whereSpy.mock.calls.filter((c) => c[0] === 'branchId');
    expect(branchWheres).toHaveLength(10);
    expect(result.current.overCap).toBe(false);
  });

  test('N12 fan-out over cap exposes overCap and does not start an 11th scoped listener', async () => {
    const branches = Array.from({ length: 11 }, (_, i) => `B${i}`);
    const { result } = renderHook(() => useReconciliationExceptions(true, branches));
    await act(async () => {});
    const branchWheres = whereSpy.mock.calls.filter((c) => c[0] === 'branchId');
    expect(branchWheres).toHaveLength(10);
    expect(result.current.overCap).toBe(true);
    expect(result.current.scopedListenerCount).toBe(10);
  });

  test('N03 client filter drops out-of-scope branch rows', () => {
    const { result } = renderHook(() => useReconciliationExceptions(true, ['LDP-001']));
    const exceptionNext = onSnapshotSpy.mock.calls[0]?.[2] as
      | ((snap: {
          docs: Array<{ id: string; data: () => Record<string, unknown> }>;
          metadata: { fromCache: boolean };
        }) => void)
      | undefined;
    expect(typeof exceptionNext).toBe('function');
    act(() => {
      exceptionNext?.({
        metadata: { fromCache: false },
        docs: [
          { id: 'in-scope', data: () => ({ branchId: 'LDP-001', billId: 'A', total: 10 }) },
          { id: 'out-of-scope', data: () => ({ branchId: 'BKK-002', billId: 'B', total: 20 }) },
        ],
      });
    });
    expect(result.current.rows.map((r) => r.id)).toEqual(['in-scope']);
    expect(result.current.rows.some((r) => r.branchId === 'BKK-002')).toBe(false);
  });

  function listenerNext(index: number) {
    return onSnapshotSpy.mock.calls[index]?.[2] as
      | ((snap: { docs: Array<{ id: string; data: () => Record<string, unknown> }>; metadata: { fromCache: boolean } }) => void)
      | undefined;
  }

  function listenerErr(index: number) {
    return onSnapshotSpy.mock.calls[index]?.[3] as ((err: Error) => void) | undefined;
  }

  const v9Doc = (id: string, branchId: string) => ({
    id,
    data: () => ({
      branchId,
      billId: id,
      total: 1,
      voidRevisionFault: 'revision_malformed',
      voidRevisionFaultAt: { toMillis: () => 1 },
    }),
  });

  test('N multi-listener: first ready second pending keeps aggregate loading', () => {
    const { result } = renderHook(() => useReconciliationExceptions(true, ['LDP-001', 'BKK-002']));
    expect(result.current.loading).toBe(true);
    act(() => {
      listenerNext(0)?.({ metadata: { fromCache: false }, docs: [] });
      listenerNext(1)?.({ metadata: { fromCache: false }, docs: [v9Doc('a', 'LDP-001')] });
    });
    expect(result.current.loading).toBe(true);
    act(() => {
      listenerNext(2)?.({ metadata: { fromCache: false }, docs: [v9Doc('b', 'BKK-002')] });
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.fromCache).toBe(false);
  });

  test('N multi-listener: cache then server recovers to server-confirmed', () => {
    const { result } = renderHook(() => useReconciliationExceptions(true, ['LDP-001', 'BKK-002']));
    act(() => {
      listenerNext(0)?.({ metadata: { fromCache: true }, docs: [] });
      listenerNext(1)?.({ metadata: { fromCache: true }, docs: [v9Doc('a', 'LDP-001')] });
      listenerNext(2)?.({ metadata: { fromCache: false }, docs: [v9Doc('b', 'BKK-002')] });
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.fromCache).toBe(true);
    act(() => {
      listenerNext(0)?.({ metadata: { fromCache: false }, docs: [] });
      listenerNext(1)?.({ metadata: { fromCache: false }, docs: [v9Doc('a', 'LDP-001')] });
    });
    expect(result.current.fromCache).toBe(false);
  });

  test('N multi-listener: source A error is not cleared by source B success', () => {
    const { result } = renderHook(() => useReconciliationExceptions(true, ['LDP-001', 'BKK-002']));
    act(() => {
      listenerErr(1)?.(new Error('permission-denied-A'));
      listenerNext(0)?.({ metadata: { fromCache: false }, docs: [] });
      listenerNext(2)?.({ metadata: { fromCache: false }, docs: [v9Doc('b', 'BKK-002')] });
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toMatch(/permission-denied-A/);
    act(() => {
      listenerNext(1)?.({ metadata: { fromCache: false }, docs: [v9Doc('a', 'LDP-001')] });
    });
    expect(result.current.error).toBeNull();
  });

  test('N13 exactly-at-limit 50 participating V9 docs sets atLimit; 49 does not', () => {
    expect(V9_FAULT_LIMIT).toBe(50);
    const { result } = renderHook(() => useReconciliationExceptions(true, ['ALL']));
    const exceptionNext = listenerNext(0);
    const v9Next = listenerNext(1);
    const docs50 = Array.from({ length: 50 }, (_, i) => v9Doc(`v${i}`, 'LDP-001'));
    act(() => {
      exceptionNext?.({ metadata: { fromCache: false }, docs: [] });
      v9Next?.({ metadata: { fromCache: false }, docs: docs50 });
    });
    expect(result.current.atLimit).toBe(true);
    const docs49 = docs50.slice(0, 49);
    expect(docs49).toHaveLength(49);
    act(() => {
      v9Next?.({ metadata: { fromCache: false }, docs: docs49 });
    });
    expect(result.current.atLimit).toBe(false);
  });

  test('N request identity change does not leak prior readiness', () => {
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useReconciliationExceptions(true, ids),
      { initialProps: { ids: ['LDP-001', 'BKK-002'] } },
    );
    act(() => {
      listenerNext(0)?.({ metadata: { fromCache: false }, docs: [] });
      listenerNext(1)?.({ metadata: { fromCache: false }, docs: [v9Doc('a', 'LDP-001')] });
      listenerNext(2)?.({ metadata: { fromCache: false }, docs: [v9Doc('b', 'BKK-002')] });
    });
    expect(result.current.loading).toBe(false);
    onSnapshotSpy.mockClear();
    rerender({ ids: ['CNX-003'] });
    expect(result.current.loading).toBe(true);
    expect(result.current.rows).toEqual([]);
  });
});
