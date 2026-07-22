// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook, cleanup } from '@testing-library/react';

type DocSnap = {
  id: string;
  exists: () => boolean;
  data: () => Record<string, unknown> | undefined;
  metadata: { fromCache: boolean };
};
type OnNext = (snap: DocSnap) => void;
type OnError = (err: { code?: string }) => void;
type OnSnapshotOptions = { includeMetadataChanges?: boolean };

const docSpy = vi.fn((_db: unknown, collectionName: string, id: string) => ({ __doc: [collectionName, id] }));

type Listener = { onNext: OnNext; onError: OnError; unsubscribe: ReturnType<typeof vi.fn>; collectionName: string };
const listeners: Listener[] = [];
const onSnapshotSpy = vi.fn((ref: { __doc: [string, string] }, options: OnSnapshotOptions, onNext: OnNext, onError: OnError) => {
  const unsubscribe = vi.fn();
  listeners.push({ onNext, onError, unsubscribe, collectionName: ref.__doc[0] });
  void options;
  return unsubscribe;
});

vi.mock('firebase/firestore', () => ({
  doc: (...args: [unknown, string, string]) => docSpy(...args),
  onSnapshot: (...args: [{ __doc: [string, string] }, OnSnapshotOptions, OnNext, OnError]) => onSnapshotSpy(...args),
}));

vi.mock('../../firebase', () => ({
  db: {},
  isFirebaseConfigured: true,
}));

let useShiftCloseAlertDetail: typeof import('./useShiftCloseAlertDetail').useShiftCloseAlertDetail;

beforeEach(async () => {
  listeners.length = 0;
  useShiftCloseAlertDetail = (await import('./useShiftCloseAlertDetail')).useShiftCloseAlertDetail;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function existingSnap(id: string, data: Record<string, unknown>, fromCache: boolean): DocSnap {
  return { id, exists: () => true, data: () => data, metadata: { fromCache } };
}
function absentSnap(id: string, fromCache: boolean): DocSnap {
  return { id, exists: () => false, data: () => undefined, metadata: { fromCache } };
}

function alertListener() {
  return listeners.find((l) => l.collectionName === 'shiftCloseAlerts')!;
}
function caseListener() {
  return listeners.find((l) => l.collectionName === 'shiftCloseCases')!;
}

describe('useShiftCloseAlertDetail — query contract (Fallback A: direct doc listeners)', () => {
  test('reads exactly two documents: shiftCloseAlerts/{shiftId} and shiftCloseCases/{shiftId} — no whole-branch/list query', () => {
    renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    expect(docSpy).toHaveBeenCalledTimes(2);
    expect(docSpy).toHaveBeenCalledWith(expect.anything(), 'shiftCloseAlerts', 'SHIFT-001');
    expect(docSpy).toHaveBeenCalledWith(expect.anything(), 'shiftCloseCases', 'SHIFT-001');
  });

  test('both onSnapshot calls pass { includeMetadataChanges: true } exactly', () => {
    renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    expect(onSnapshotSpy).toHaveBeenCalledTimes(2);
    for (const call of onSnapshotSpy.mock.calls) {
      expect(call[1]).toEqual({ includeMetadataChanges: true });
    }
  });
});

describe('useShiftCloseAlertDetail — gate', () => {
  test('gate false (non-manager/admin) → onSnapshot never called, both sources disabled', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('staff', 'BR-001', 'SHIFT-001'));
    expect(onSnapshotSpy).not.toHaveBeenCalled();
    expect(result.current.alert.status).toBe('disabled');
    expect(result.current.case.status).toBe('disabled');
  });

  test('gate false (invalid route shiftId) → onSnapshot never called, routeValid is false', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'a/b'));
    expect(onSnapshotSpy).not.toHaveBeenCalled();
    expect(result.current.routeValid).toBe(false);
    expect(result.current.alert.status).toBe('disabled');
  });

  test('gate false (branchId ALL) → onSnapshot never called', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('admin', 'ALL', 'SHIFT-001'));
    expect(onSnapshotSpy).not.toHaveBeenCalled();
    expect(result.current.case.status).toBe('disabled');
  });
});

describe('useShiftCloseAlertDetail — pre-snapshot pending state', () => {
  test('an eligible query renders both sources as pending before any snapshot callback fires', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    expect(result.current.alert.status).toBe('pending');
    expect(result.current.case.status).toBe('pending');
  });
});

describe('useShiftCloseAlertDetail — client-side branch veto (no where() predicate on a direct doc read)', () => {
  test('a doc that exists but belongs to a DIFFERENT branch is treated as empty/absent for the active branch', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    act(() =>
      alertListener().onNext(
        existingSnap('SHIFT-001', { shiftId: 'SHIFT-001', branchId: 'OTHER-BRANCH', alertState: 'open' }, false),
      ),
    );
    expect(result.current.alert.status).toBe('ready');
    expect(result.current.alert.empty).toBe(true);
    expect(result.current.alert.row).toBeNull();
  });

  test('a doc that exists and belongs to the active branch is surfaced normally', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    act(() =>
      alertListener().onNext(
        existingSnap('SHIFT-001', { shiftId: 'SHIFT-001', branchId: 'BR-001', alertState: 'open' }, false),
      ),
    );
    expect(result.current.alert.empty).toBe(false);
    expect(result.current.alert.row?.id).toBe('SHIFT-001');
  });
});

describe('useShiftCloseAlertDetail — per-source cache/server transitions', () => {
  test('alert cache-absent → later identical server-absent metadata-only transition updates fromCache, keeps ready/empty', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    act(() => alertListener().onNext(absentSnap('SHIFT-001', true)));
    expect(result.current.alert.status).toBe('ready');
    expect(result.current.alert.fromCache).toBe(true);
    expect(result.current.alert.empty).toBe(true);

    act(() => alertListener().onNext(absentSnap('SHIFT-001', false)));
    expect(result.current.alert.fromCache).toBe(false);
    expect(result.current.alert.empty).toBe(true);
    expect(result.current.alert.status).toBe('ready');
  });

  test('alert cache-present → identical server-present metadata-only transition preserves projection, flips fromCache', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    const snapData = { shiftId: 'SHIFT-001', branchId: 'BR-001', alertState: 'open' };
    act(() => alertListener().onNext(existingSnap('SHIFT-001', snapData, true)));
    expect(result.current.alert.fromCache).toBe(true);
    expect(result.current.alert.row?.id).toBe('SHIFT-001');

    act(() => alertListener().onNext(existingSnap('SHIFT-001', snapData, false)));
    expect(result.current.alert.fromCache).toBe(false);
    expect(result.current.alert.row?.id).toBe('SHIFT-001');
    expect(result.current.alert.status).toBe('ready');
  });

  test('case cache-absent → later server-absent metadata-only transition updates fromCache, keeps ready/empty', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    act(() => caseListener().onNext(absentSnap('SHIFT-001', true)));
    expect(result.current.case.fromCache).toBe(true);
    expect(result.current.case.empty).toBe(true);

    act(() => caseListener().onNext(absentSnap('SHIFT-001', false)));
    expect(result.current.case.fromCache).toBe(false);
    expect(result.current.case.empty).toBe(true);
  });

  test('case cache-present → identical server-present metadata-only transition preserves projection, flips fromCache', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    const snapData = { shiftId: 'SHIFT-001', branchId: 'BR-001', processingState: 'validated', caseVersion: 1 };
    act(() => caseListener().onNext(existingSnap('SHIFT-001', snapData, true)));
    expect(result.current.case.fromCache).toBe(true);
    expect(result.current.case.projection?.id).toBe('SHIFT-001');

    act(() => caseListener().onNext(existingSnap('SHIFT-001', snapData, false)));
    expect(result.current.case.fromCache).toBe(false);
    expect(result.current.case.projection?.id).toBe('SHIFT-001');
    expect(result.current.case.status).toBe('ready');
  });

  test('metadata-only callback preserves status: ready throughout (never regresses to pending)', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    act(() => alertListener().onNext(absentSnap('SHIFT-001', true)));
    expect(result.current.alert.status).toBe('ready');
    act(() => alertListener().onNext(absentSnap('SHIFT-001', false)));
    expect(result.current.alert.status).toBe('ready');
  });
});

describe('useShiftCloseAlertDetail — stale generation guard', () => {
  test('a superseded generation metadata callback is ignored after shiftId changes', () => {
    const { result, rerender } = renderHook(
      ({ shiftId }) => useShiftCloseAlertDetail('manager', 'BR-001', shiftId),
      { initialProps: { shiftId: 'SHIFT-001' } },
    );
    const staleAlertListener = alertListener();
    act(() => staleAlertListener.onNext(absentSnap('SHIFT-001', false)));
    expect(result.current.alert.status).toBe('ready');

    rerender({ shiftId: 'SHIFT-002' });
    expect(result.current.alert.status).toBe('pending'); // reset for the new generation

    // The OLD generation's captured callback fires late — must be ignored.
    act(() => staleAlertListener.onNext(existingSnap('SHIFT-001', { branchId: 'BR-001' }, false)));
    expect(result.current.alert.status).toBe('pending');
    expect(result.current.alert.row).toBeNull();
  });

  test('branch change resets both sources to pending in the same render, never showing stale-branch data', () => {
    const { result, rerender } = renderHook(
      ({ branchId }) => useShiftCloseAlertDetail('manager', branchId, 'SHIFT-001'),
      { initialProps: { branchId: 'BR-001' } },
    );
    act(() => alertListener().onNext(absentSnap('SHIFT-001', false)));
    expect(result.current.alert.status).toBe('ready');

    rerender({ branchId: 'BR-002' });
    expect(result.current.alert.status).toBe('pending');
    expect(result.current.case.status).toBe('pending');
  });
});

describe('useShiftCloseAlertDetail — mixed pending/cache/server/error and error mapping', () => {
  test('overall would be considered loading while either source is pending (alert ready, case still pending)', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    act(() => alertListener().onNext(absentSnap('SHIFT-001', false)));
    expect(result.current.alert.status).toBe('ready');
    expect(result.current.case.status).toBe('pending');
  });

  test('alert permission-denied maps to a distinct error, independent of case source', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    act(() => alertListener().onError({ code: 'permission-denied' }));
    expect(result.current.alert.status).toBe('error');
    expect(result.current.alert.errorType).toBe('permission-denied');
    expect(result.current.case.status).toBe('pending');
  });

  test('case generic error maps to generic, independent of alert source', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    act(() => caseListener().onError({ code: 'unavailable' }));
    expect(result.current.case.status).toBe('error');
    expect(result.current.case.errorType).toBe('generic');
  });

  test('no clean conclusion while either source is pending', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    expect(result.current.alert.status).toBe('pending');
    expect(result.current.case.status).toBe('pending');
  });
});

describe('useShiftCloseAlertDetail — integrity composition', () => {
  test('integrityCautions surfaces a caseVersion drift once both sources are ready with mismatched versions', () => {
    const { result } = renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    act(() =>
      alertListener().onNext(
        existingSnap('SHIFT-001', { shiftId: 'SHIFT-001', branchId: 'BR-001', alertState: 'open', caseVersion: 5 }, false),
      ),
    );
    act(() =>
      caseListener().onNext(
        existingSnap(
          'SHIFT-001',
          { shiftId: 'SHIFT-001', branchId: 'BR-001', processingState: 'validated', caseVersion: 2 },
          false,
        ),
      ),
    );
    expect(result.current.integrityCautions).toContain('case_version_drift');
  });
});

describe('useShiftCloseAlertDetail — subscription lifecycle', () => {
  test('unmount unsubscribes both listeners exactly once', () => {
    const { unmount } = renderHook(() => useShiftCloseAlertDetail('manager', 'BR-001', 'SHIFT-001'));
    const alertUnsub = alertListener().unsubscribe;
    const caseUnsub = caseListener().unsubscribe;
    expect(alertUnsub).not.toHaveBeenCalled();
    expect(caseUnsub).not.toHaveBeenCalled();
    unmount();
    expect(alertUnsub).toHaveBeenCalledTimes(1);
    expect(caseUnsub).toHaveBeenCalledTimes(1);
  });
});
