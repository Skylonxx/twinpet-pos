// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook, cleanup } from '@testing-library/react';

type SnapDoc = { id: string; data: () => Record<string, unknown> };
type Snap = { docs: SnapDoc[]; metadata: { fromCache: boolean } };
type OnNext = (snap: Snap) => void;
type OnError = (err: { code?: string }) => void;

const collectionSpy = vi.fn((_db: unknown, name: string) => ({ __col: name }));
const whereSpy = vi.fn((field: string, op: string, value: unknown) => ({ __where: [field, op, value] }));
const querySpy = vi.fn((...args: unknown[]) => ({ __query: args }));
const orderBySpy = vi.fn();
const unsubscribeSpy = vi.fn();
let lastOnNext: OnNext | null = null;
let lastOnError: OnError | null = null;
const onSnapshotSpy = vi.fn((_q: unknown, onNext: OnNext, onError: OnError) => {
  lastOnNext = onNext;
  lastOnError = onError;
  return unsubscribeSpy;
});

vi.mock('firebase/firestore', () => ({
  collection: (...args: [unknown, string]) => collectionSpy(...args),
  query: (...args: unknown[]) => querySpy(...args),
  where: (...args: [string, string, unknown]) => whereSpy(...args),
  orderBy: (...args: unknown[]) => orderBySpy(...args),
  onSnapshot: (...args: [unknown, OnNext, OnError]) => onSnapshotSpy(...args),
}));

vi.mock('../../firebase', () => ({
  db: {},
  isFirebaseConfigured: true,
}));

let useShiftCloseReviewQueue: typeof import('./useShiftCloseReviewQueue').useShiftCloseReviewQueue;

beforeEach(async () => {
  lastOnNext = null;
  lastOnError = null;
  useShiftCloseReviewQueue = (await import('./useShiftCloseReviewQueue')).useShiftCloseReviewQueue;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeDoc(id: string, data: Record<string, unknown>): SnapDoc {
  return { id, data: () => data };
}

describe('useShiftCloseReviewQueue — query contract', () => {
  test('queries exactly one collection: shiftCloseAlerts', () => {
    renderHook(() => useShiftCloseReviewQueue('manager', 'BR-001'));
    expect(collectionSpy).toHaveBeenCalledTimes(1);
    expect(collectionSpy).toHaveBeenCalledWith(expect.anything(), 'shiftCloseAlerts');
  });

  test('applies exactly one where("branchId", "==", activeBranchId)', () => {
    renderHook(() => useShiftCloseReviewQueue('manager', 'BR-001'));
    expect(whereSpy).toHaveBeenCalledTimes(1);
    expect(whereSpy).toHaveBeenCalledWith('branchId', '==', 'BR-001');
  });

  test('never calls orderBy', () => {
    renderHook(() => useShiftCloseReviewQueue('manager', 'BR-001'));
    expect(orderBySpy).not.toHaveBeenCalled();
  });

  test('never queries a second collection', () => {
    renderHook(() => useShiftCloseReviewQueue('manager', 'BR-001'));
    expect(collectionSpy).toHaveBeenCalledTimes(1);
    const names = collectionSpy.mock.calls.map((c) => c[1]);
    expect(new Set(names).size).toBe(1);
  });
});

describe('useShiftCloseReviewQueue — gate', () => {
  test('gate false (non-manager/admin) → onSnapshot is never called', () => {
    const { result } = renderHook(() => useShiftCloseReviewQueue('staff', 'BR-001'));
    expect(onSnapshotSpy).not.toHaveBeenCalled();
    expect(result.current.status).toBe('disabled');
    expect(result.current.loading).toBe(false);
  });

  test('gate false (branchId ALL) → onSnapshot is never called', () => {
    const { result } = renderHook(() => useShiftCloseReviewQueue('admin', 'ALL'));
    expect(onSnapshotSpy).not.toHaveBeenCalled();
    expect(result.current.status).toBe('disabled');
  });
});

// RC-1: the eligible-but-no-snapshot-yet window must be visibly distinct from
// a server-confirmed empty result. Before this remediation, the hook's
// initial state (loading:false, fromCache:false, zero rows) was
// indistinguishable from "server confirmed zero rows".
describe('useShiftCloseReviewQueue — RC-1 pre-snapshot state', () => {
  test('an eligible query renders as pending/loading BEFORE any snapshot callback fires — never as server-confirmed-empty', () => {
    const { result } = renderHook(() => useShiftCloseReviewQueue('manager', 'BR-001'));
    // onSnapshot has been called (subscription started) but neither callback
    // has fired yet — this is the exact gap RC-1 flagged.
    expect(onSnapshotSpy).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('pending');
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    // Must NOT look like a confirmed-empty result: fromCache is meaningless
    // pre-snapshot, and status alone (not fromCache/totalCount) is what the
    // page must branch on to avoid a false "server-confirmed empty" render.
    expect(result.current.status).not.toBe('ready');
  });

  test('status transitions pending → ready exactly once the first snapshot callback fires', () => {
    const { result } = renderHook(() => useShiftCloseReviewQueue('manager', 'BR-001'));
    expect(result.current.status).toBe('pending');
    act(() => {
      lastOnNext?.({ docs: [], metadata: { fromCache: false } });
    });
    expect(result.current.status).toBe('ready');
  });

  test('branch change resets to pending in the same update, never re-showing the previous branch data', () => {
    const { result, rerender } = renderHook(({ branchId }) => useShiftCloseReviewQueue('manager', branchId), {
      initialProps: { branchId: 'BR-001' },
    });
    act(() => {
      lastOnNext?.({
        docs: [makeDoc('s1', { branchId: 'BR-001', alertState: 'open' })],
        metadata: { fromCache: false },
      });
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.rows).toHaveLength(1);

    rerender({ branchId: 'BR-002' });

    // Reset happens synchronously in the render that observes the new
    // branchId — the stale BR-001 row must never be shown for BR-002.
    expect(result.current.status).toBe('pending');
    expect(result.current.rows).toHaveLength(0);
  });
});

describe('useShiftCloseReviewQueue — subscription lifecycle', () => {
  test('branch change unsubscribes the previous query and starts a new one', () => {
    const { rerender } = renderHook(({ branchId }) => useShiftCloseReviewQueue('manager', branchId), {
      initialProps: { branchId: 'BR-001' },
    });
    expect(onSnapshotSpy).toHaveBeenCalledTimes(1);
    expect(unsubscribeSpy).not.toHaveBeenCalled();

    rerender({ branchId: 'BR-002' });

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    expect(onSnapshotSpy).toHaveBeenCalledTimes(2);
    expect(whereSpy).toHaveBeenLastCalledWith('branchId', '==', 'BR-002');
  });

  test('unmount unsubscribes exactly once', () => {
    const { unmount } = renderHook(() => useShiftCloseReviewQueue('manager', 'BR-001'));
    expect(unsubscribeSpy).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('useShiftCloseReviewQueue — error mapping', () => {
  test('permission-denied maps to a distinct auth/session error, not an empty result', () => {
    const { result } = renderHook(() => useShiftCloseReviewQueue('manager', 'BR-001'));
    act(() => {
      lastOnError?.({ code: 'permission-denied' });
    });
    expect(result.current.error).toBe('permission-denied');
    expect(result.current.error).not.toBeNull();
  });

  test('other errors map to a generic error', () => {
    const { result } = renderHook(() => useShiftCloseReviewQueue('manager', 'BR-001'));
    act(() => {
      lastOnError?.({ code: 'unavailable' });
    });
    expect(result.current.error).toBe('generic');
  });
});

describe('useShiftCloseReviewQueue — cache/empty/stale states', () => {
  test('fromCache=true + zero rows → cache-only/unconfirmed empty', () => {
    const { result } = renderHook(() => useShiftCloseReviewQueue('manager', 'BR-001'));
    act(() => {
      lastOnNext?.({ docs: [], metadata: { fromCache: true } });
    });
    expect(result.current.fromCache).toBe(true);
    expect(result.current.totalCount).toBe(0);
    expect(result.current.rows).toHaveLength(0);
    expect(result.current.loading).toBe(false);
  });

  test('fromCache=false + zero rows → server-confirmed empty', () => {
    const { result } = renderHook(() => useShiftCloseReviewQueue('manager', 'BR-001'));
    act(() => {
      lastOnNext?.({ docs: [], metadata: { fromCache: false } });
    });
    expect(result.current.fromCache).toBe(false);
    expect(result.current.totalCount).toBe(0);
  });

  test('fromCache=true + rows present → stale indicator', () => {
    const { result } = renderHook(() => useShiftCloseReviewQueue('manager', 'BR-001'));
    act(() => {
      lastOnNext?.({
        docs: [makeDoc('s1', { branchId: 'BR-001', alertState: 'open' })],
        metadata: { fromCache: true },
      });
    });
    expect(result.current.fromCache).toBe(true);
    expect(result.current.rows.length).toBeGreaterThan(0);
  });

  test('actionable rows are a filtered subset while totalCount reflects the unfiltered snapshot', () => {
    const { result } = renderHook(() => useShiftCloseReviewQueue('manager', 'BR-001'));
    act(() => {
      lastOnNext?.({
        docs: [
          makeDoc('s1', { branchId: 'BR-001', alertState: 'open' }),
          makeDoc('s2', { branchId: 'BR-001', alertState: 'resolved' }),
        ],
        metadata: { fromCache: false },
      });
    });
    expect(result.current.totalCount).toBe(2);
    expect(result.current.actionableRows).toHaveLength(1);
  });

  // RC-2 (hook-level): malformed rows must reach the caller via
  // `malformedRows`, never silently vanish from both `rows` and `actionableRows`.
  test('unknown-state rows are counted in totalCount and surfaced via malformedRows, not silently dropped', () => {
    const { result } = renderHook(() => useShiftCloseReviewQueue('manager', 'BR-001'));
    act(() => {
      lastOnNext?.({
        docs: [
          makeDoc('s1', { branchId: 'BR-001', alertState: 'open' }),
          makeDoc('s2', { branchId: 'BR-001', alertState: 'totally-bogus-state' }),
        ],
        metadata: { fromCache: false },
      });
    });
    expect(result.current.totalCount).toBe(2);
    expect(result.current.actionableRows).toHaveLength(1);
    expect(result.current.malformedRows).toHaveLength(1);
    expect(result.current.malformedRows[0].id).toBe('s2');
  });

  // RC-2 (R2 remediation, hook-level): a valid non-actionable state (resolved)
  // with an unknown reasonCode must ALSO reach malformedRows — this is
  // precisely the case an alertState-only check misses.
  test('a resolved row with an unknown reasonCode is surfaced via malformedRows even though its alertState is valid', () => {
    const { result } = renderHook(() => useShiftCloseReviewQueue('manager', 'BR-001'));
    act(() => {
      lastOnNext?.({
        docs: [makeDoc('r1', { branchId: 'BR-001', alertState: 'resolved', reasonCode: 'bogus-reason' })],
        metadata: { fromCache: false },
      });
    });
    expect(result.current.actionableRows).toHaveLength(0);
    expect(result.current.malformedRows).toHaveLength(1);
    expect(result.current.malformedRows[0].id).toBe('r1');
  });
});
