// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

type SnapDoc = { id: string; data: () => Record<string, unknown> };
type Snap = { docs: SnapDoc[]; metadata: { fromCache: boolean } };
type OnNext = (snap: Snap) => void;
type OnError = (err: { code?: string }) => void;

const collectionSpy = vi.fn((_db: unknown, name: string) => ({ __col: name }));
const whereSpy = vi.fn((field: string, op: string, value: unknown) => ({ __where: [field, op, value] }));
const querySpy = vi.fn((...args: unknown[]) => ({ __query: args }));
const unsubscribeSpy = vi.fn();
let lastOnNext: OnNext | null = null;
let lastOnError: OnError | null = null;
const onSnapshotSpy = vi.fn(
  (_q: unknown, _opts: unknown, onNext: OnNext, onError: OnError) => {
    lastOnNext = onNext;
    lastOnError = onError;
    return unsubscribeSpy;
  },
);

vi.mock('firebase/firestore', () => ({
  collection: (...args: [unknown, string]) => collectionSpy(...args),
  query: (...args: unknown[]) => querySpy(...args),
  where: (...args: [string, string, unknown]) => whereSpy(...args),
  onSnapshot: (...args: [unknown, unknown, OnNext, OnError]) => onSnapshotSpy(...args),
}));

vi.mock('../firebase', () => ({
  db: {},
  isFirebaseConfigured: true,
}));

let useApproverRoster: typeof import('./useApproverRoster').useApproverRoster;

beforeEach(async () => {
  lastOnNext = null;
  lastOnError = null;
  useApproverRoster = (await import('./useApproverRoster')).useApproverRoster;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeDoc(id: string, data: Record<string, unknown>): SnapDoc {
  return { id, data: () => data };
}

describe('useApproverRoster', () => {
  test('gate-first: disabled never subscribes', () => {
    const { result } = renderHook(() =>
      useApproverRoster({ enabled: false, branchId: 'B1', requesterStaffId: 's1' }),
    );
    expect(onSnapshotSpy).not.toHaveBeenCalled();
    expect(result.current.status).toBe('disabled');
  });

  test('branch ALL never subscribes', () => {
    renderHook(() => useApproverRoster({ enabled: true, branchId: 'ALL', requesterStaffId: 's1' }));
    expect(onSnapshotSpy).not.toHaveBeenCalled();
  });

  test('eligible query uses array-contains-any [branch, ALL] with metadata changes', () => {
    renderHook(() => useApproverRoster({ enabled: true, branchId: 'B1', requesterStaffId: 's1' }));
    expect(collectionSpy).toHaveBeenCalledWith(expect.anything(), 'users');
    expect(whereSpy).toHaveBeenCalledWith('branchIds', 'array-contains-any', ['B1', 'ALL']);
    expect(onSnapshotSpy.mock.calls[0]?.[1]).toEqual({ includeMetadataChanges: true });
  });

  test('pre-snapshot is pending, not confirmed empty', () => {
    const { result } = renderHook(() =>
      useApproverRoster({ enabled: true, branchId: 'B1', requesterStaffId: 's1' }),
    );
    expect(result.current.status).toBe('pending');
    expect(result.current.candidates).toEqual([]);
  });

  test('cache-only empty stays fromCache and is not treated as confirmed', () => {
    const { result } = renderHook(() =>
      useApproverRoster({ enabled: true, branchId: 'B1', requesterStaffId: 's1' }),
    );
    act(() => {
      lastOnNext?.({ docs: [], metadata: { fromCache: true } });
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.fromCache).toBe(true);
    expect(result.current.candidates).toEqual([]);
  });

  test('server-confirmed empty is ready + !fromCache', () => {
    const { result } = renderHook(() =>
      useApproverRoster({ enabled: true, branchId: 'B1', requesterStaffId: 's1' }),
    );
    act(() => {
      lastOnNext?.({ docs: [], metadata: { fromCache: false } });
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.fromCache).toBe(false);
    expect(result.current.candidates).toEqual([]);
  });

  test('projects eligible candidates and excludes the requester', () => {
    const { result } = renderHook(() =>
      useApproverRoster({ enabled: true, branchId: 'B1', requesterStaffId: 's1' }),
    );
    act(() => {
      lastOnNext?.({
        docs: [
          makeDoc('s1', { firstName: 'Me', lastName: 'Staff', username: 'me', role: 'staff', isActive: true, branchIds: ['B1'] }),
          makeDoc('m1', {
            firstName: 'Somchai',
            lastName: 'Mgr',
            username: 'somchai',
            role: 'manager',
            isActive: true,
            deletedAt: null,
            branchIds: ['B1'],
            authVersion: 9,
            pin: 'secret',
          }),
        ],
        metadata: { fromCache: false },
      });
    });
    expect(result.current.candidates).toEqual([
      { userId: 'm1', displayName: 'Somchai Mgr', username: 'somchai', role: 'manager' },
    ]);
    expect(JSON.stringify(result.current.candidates)).not.toMatch(/authVersion|"pin"|secret/);
  });

  test('branch change resets to pending', () => {
    const { result, rerender } = renderHook(
      ({ branchId }) => useApproverRoster({ enabled: true, branchId, requesterStaffId: 's1' }),
      { initialProps: { branchId: 'B1' } },
    );
    act(() => {
      lastOnNext?.({
        docs: [makeDoc('m1', { role: 'manager', isActive: true, branchIds: ['B1'], username: 'x', firstName: 'A', lastName: 'B' })],
        metadata: { fromCache: false },
      });
    });
    expect(result.current.candidates).toHaveLength(1);
    rerender({ branchId: 'B2' });
    expect(result.current.status).toBe('pending');
    expect(result.current.candidates).toEqual([]);
  });

  test('snapshot error is status error', () => {
    const { result } = renderHook(() =>
      useApproverRoster({ enabled: true, branchId: 'B1', requesterStaffId: 's1' }),
    );
    act(() => {
      lastOnError?.({ code: 'permission-denied' });
    });
    expect(result.current.status).toBe('error');
    expect(result.current.candidates).toEqual([]);
  });
});
