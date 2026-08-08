// Packet 7C-B1 — local optimistic offline close. `closeShift` is exercised
// against mocked Firestore primitives (never a real network/IndexedDB) so
// these tests can assert the cache-only verification, the durable
// close-intent write, and the fire-and-forget shift-doc update in isolation.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { serverTimestamp } from 'firebase/firestore';
import type { Shift } from '../types';
import { createInMemoryShiftCloseIntentJournal } from './offline/shiftCloseIntentStore';
import type { ShiftCloseIntentBusinessSnapshot } from './offline/shiftCloseIntentTypes';

vi.mock('../firebase', () => ({
  isFirebaseConfigured: true,
  db: {} as unknown,
  collections: { shifts: 'shifts', cashTransactions: 'cashTransactions' },
}));

const {
  getDocFromCacheMock,
  getDocFromServerMock,
  updateDocMock,
  setDocMock,
  docMock,
  collectionMock,
} = vi.hoisted(() => ({
  getDocFromCacheMock: vi.fn(),
  getDocFromServerMock: vi.fn(),
  updateDocMock: vi.fn(),
  setDocMock: vi.fn(),
  docMock: vi.fn(() => ({ id: 'shift-1' }) as never),
  collectionMock: vi.fn(() => ({ path: 'shifts' }) as never),
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    doc: docMock,
    collection: collectionMock,
    getDocFromCache: getDocFromCacheMock,
    getDocFromServer: getDocFromServerMock,
    updateDoc: updateDocMock,
    setDoc: setDocMock,
  };
});

vi.mock('./deviceId', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./deviceId')>();
  return {
    ...actual,
    getDeviceId: vi.fn(() => 'DEV1'),
  };
});

// Imported AFTER the mocks are declared (vi.mock is hoisted, so this is safe).
import { closeShift, openShift } from './shiftService';
import {
  createInMemoryShiftOpenIntentJournal,
  type ShiftOpenIntentJournal,
} from './offline/shiftOpenIntentStore';

function makeOpenSnap(status: string = 'open') {
  return { exists: () => true, data: () => ({ status }) };
}
function makeMissingSnap() {
  return { exists: () => false, data: () => undefined };
}

function makeShift(overrides: Partial<Shift> = {}): Shift {
  return {
    id: 'shift-1',
    branchId: 'LDP-001',
    staffId: 'staff-1',
    staffName: 'ทดสอบ ระบบ',
    status: 'open',
    openedAt: new Date() as unknown as Shift['openedAt'],
    closedAt: null,
    startingCash: 500,
    actualCashCount: 0,
    expectedCash: 1000,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    totalBills: 3,
    payInTotal: 0,
    payOutTotal: 0,
    variance: 0,
    note: '',
    cashEntries: [],
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<ShiftCloseIntentBusinessSnapshot> = {},
): ShiftCloseIntentBusinessSnapshot {
  return {
    shiftId: 'shift-1',
    branchId: 'LDP-001',
    staffId: 'staff-1',
    staffName: 'ทดสอบ ระบบ',
    startingCash: 500,
    expectedCash: 1000,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    payInTotal: 0,
    payOutTotal: 0,
    totalBills: 3,
    actualCashCount: 999,
    variance: 0,
    note: '',
    deviceId: 'DEV1',
    ...overrides,
  };
}

beforeEach(() => {
  getDocFromCacheMock.mockReset();
  updateDocMock.mockReset();
  updateDocMock.mockResolvedValue(undefined);
  setDocMock.mockReset();
  setDocMock.mockResolvedValue(undefined);
  getDocFromServerMock.mockReset();
  // Packet 7C-B2 default: "not found" — the same-runtime confirmation chain
  // (triggered fire-and-forget off the write ACK) resolves to `still_pending`
  // by default so existing tests that don't care about confirmation stay
  // deterministic and never touch a real network/Firestore instance.
  getDocFromServerMock.mockResolvedValue({ exists: () => false, data: () => undefined });
  docMock.mockReset();
  docMock.mockImplementation((...args: unknown[]) => {
    // doc(collection) → new id; doc(db, 'shifts', id) → existing id
    if (args.length >= 3 && typeof args[2] === 'string') {
      return { id: args[2] } as never;
    }
    return { id: 'shift-1' } as never;
  });
  collectionMock.mockReset();
  collectionMock.mockReturnValue({ path: 'shifts' } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('closeShift — Packet 7C-B1 local optimistic offline close', () => {
  test('returns a frozen snapshot without awaiting the shift-doc write', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    updateDocMock.mockImplementation(() => new Promise(() => {})); // never resolves
    const journal = createInMemoryShiftCloseIntentJournal();

    const result = await closeShift(makeShift(), 1000, 'note', { journal });

    expect(result.status).toBe('closed');
    expect(result.closedOffline).toBe(true);
    expect(result.syncState).toBe('pending');
    expect(typeof result.closedAtLocal).toBe('number');
    expect(result.deviceId).toBe('DEV1');
    // closedAt is never back-filled with a fake LOCAL/device timestamp — the
    // returned object keeps whatever the caller's shift carried (null here).
    expect(result.closedAt).toBeNull();
    // No unresolved mirror field is left on the returned local snapshot.
    expect(result.closedAtServer).toBeUndefined();
  });

  test('queued shift-doc update includes an authoritative server close timestamp (closedAt: serverTimestamp())', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    updateDocMock.mockResolvedValue(undefined);
    const journal = createInMemoryShiftCloseIntentJournal();

    await closeShift(makeShift(), 1000, 'note', { journal });

    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const [, patch] = updateDocMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(patch.status).toBe('closed');
    // The PERSISTED doc must keep a real server-resolving close timestamp —
    // 7C-B1 has no boot/reconnect worker to back-fill this later, so omitting
    // it would leave a synced closed shift with closedAt: null forever.
    expect(patch.closedAt).toEqual(serverTimestamp());
  });

  test('returned local closed Shift never fakes closedAt with device time; closedAtLocal carries the honest device-time display value', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    const journal = createInMemoryShiftCloseIntentJournal();

    const result = await closeShift(makeShift(), 1000, 'note', { journal });

    expect(result.closedAt).toBeNull();
    expect(typeof result.closedAtLocal).toBe('number');
    expect(result.closedAtLocal).not.toBe(result.closedAt);
  });

  test('persists a durable close-intent keyed by shiftId', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    const journal = createInMemoryShiftCloseIntentJournal();

    await closeShift(makeShift(), 1000, 'note', { journal });

    const stored = await journal.getCloseIntent('shift-1');
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value?.shiftId).toBe('shift-1');
    expect(stored.value?.status).toBe('local_closed_pending');
    expect(stored.value?.actualCashCount).toBe(1000);
  });

  test('second identical close is idempotent — no throw, no duplicate close-intent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T12:00:00.000Z'));
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    const journal = createInMemoryShiftCloseIntentJournal();
    const shift = makeShift();

    await closeShift(shift, 1000, 'note', { journal });
    await expect(closeShift(shift, 1000, 'note', { journal })).resolves.toMatchObject({
      status: 'closed',
    });

    const all = await journal.listCloseIntents();
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value).toHaveLength(1);
  });

  test('cold/stale cache (getDocFromCache rejects) fails fast — no fabricated close', async () => {
    getDocFromCacheMock.mockRejectedValue(new Error('Failed to get document from cache.'));
    const journal = createInMemoryShiftCloseIntentJournal();

    await expect(closeShift(makeShift(), 1000, 'note', { journal })).rejects.toThrow();

    const all = await journal.listCloseIntents();
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value).toHaveLength(0);
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  test('unverifiable shift (no cached doc) fails fast — no fabricated close', async () => {
    getDocFromCacheMock.mockResolvedValue(makeMissingSnap());
    const journal = createInMemoryShiftCloseIntentJournal();

    await expect(closeShift(makeShift(), 1000, 'note', { journal })).rejects.toThrow();
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  test('already-closed cached shift fails fast with an honest "already closed" error', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap('closed'));
    const journal = createInMemoryShiftCloseIntentJournal();

    await expect(closeShift(makeShift(), 1000, 'note', { journal })).rejects.toThrow('ปิดไปแล้ว');
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  test('durable close-intent store unavailable fails fast — no cache-only fallback', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    const journal = {
      upsertCloseIntent: async () => ({ ok: false as const, code: 'unavailable' as const }),
      getCloseIntent: async () => ({ ok: true as const, value: undefined }),
      listCloseIntents: async () => ({ ok: true as const, value: [] }),
      markSynced: async () => ({ ok: false as const, code: 'not_found' as const }),
      markRejectedManualAttention: async () => ({ ok: false as const, code: 'not_found' as const }),
    };

    await expect(closeShift(makeShift(), 1000, 'note', { journal })).rejects.toThrow();
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  test('durable close-intent conflict (different snapshot already exists) fails fast, not silently overwritten', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    const journal = createInMemoryShiftCloseIntentJournal();
    await journal.upsertCloseIntent(makeSnapshot({ actualCashCount: 999 }));

    await expect(closeShift(makeShift(), 1000, 'note', { journal })).rejects.toThrow();
    expect(updateDocMock).not.toHaveBeenCalled();

    const stored = await journal.getCloseIntent('shift-1');
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value?.actualCashCount).toBe(999); // original preserved, not overwritten
  });

  test('online happy path still resolves and queues the shift-doc write', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    updateDocMock.mockResolvedValue(undefined);
    const journal = createInMemoryShiftCloseIntentJournal();

    const result = await closeShift(makeShift(), 1000, 'note', { journal });

    expect(result.status).toBe('closed');
    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const [, patch] = updateDocMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(patch.status).toBe('closed');
    expect(patch.closedOffline).toBe(true);
    expect(patch.syncState).toBe('pending');
    expect(patch.closedAt).toEqual(serverTimestamp());
  });

  test('copy audit: fail-fast errors never claim synced/settled/server-confirmed/guaranteed', async () => {
    getDocFromCacheMock.mockRejectedValue(new Error('offline'));
    const journal = createInMemoryShiftCloseIntentJournal();
    const forbidden = [
      'ซิงก์แล้ว',
      'ยืนยันจากเซิร์ฟเวอร์แล้ว',
      'settled',
      'guaranteed',
      'ทุกเครื่อง',
      'ทุกอุปกรณ์',
    ];

    await expect(closeShift(makeShift(), 1000, 'note', { journal })).rejects.toSatisfy(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        return forbidden.every((word) => !message.includes(word));
      },
    );
  });
});

// Packet 7C-B2 — same-runtime confirmation reconciliation (`whenServerConfirmed`).
describe('closeShift — Packet 7C-B2 whenServerConfirmed reconciliation', () => {
  function makeConfirmedSnap(overrides: Record<string, unknown> = {}) {
    return {
      exists: () => true,
      data: () => ({
        status: 'closed',
        closedAt: { toDate: () => new Date('2026-07-09T10:00:00.000Z') },
        closedOffline: true,
        syncState: 'pending',
        deviceId: 'DEV1',
        branchId: 'LDP-001',
        staffId: 'staff-1',
        startingCash: 500,
        actualCashCount: 1000,
        variance: -500,
        expectedCash: 1000,
        expectedQr: 0,
        expectedKbank: 0,
        expectedCard: 0,
        expectedCredit: 0,
        payInTotal: 0,
        payOutTotal: 0,
        totalBills: 3,
        note: 'note',
        ...overrides,
      }),
    };
  }

  test('ACK alone (default mock: doc not found on server) resolves whenServerConfirmed to still_pending and never marks the journal synced', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    updateDocMock.mockResolvedValue(undefined);
    const journal = createInMemoryShiftCloseIntentJournal();

    const result = await closeShift(makeShift(), 1000, 'note', { journal });
    const outcome = await result.whenServerConfirmed;

    expect(outcome.outcome).toBe('still_pending');
    const stored = await journal.getCloseIntent('shift-1');
    expect(stored.ok && stored.value?.status).toBe('local_closed_pending');
  });

  test('confirmation-grade server read proving the close resolves whenServerConfirmed to confirmed with the resolved server closedAt', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    updateDocMock.mockResolvedValue(undefined);
    getDocFromServerMock.mockResolvedValue(makeConfirmedSnap());
    const journal = createInMemoryShiftCloseIntentJournal();

    const result = await closeShift(makeShift(), 1000, 'note', { journal });
    const outcome = await result.whenServerConfirmed;

    expect(outcome.outcome).toBe('confirmed');
    if (outcome.outcome === 'confirmed') {
      expect(outcome.closedAt).toEqual(new Date('2026-07-09T10:00:00.000Z'));
    }
    const stored = await journal.getCloseIntent('shift-1');
    expect(stored.ok && stored.value?.status).toBe('synced');
  });

  test('a genuine write rejection resolves whenServerConfirmed to rejected and marks the journal rejected_manual_attention', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    updateDocMock.mockRejectedValue(new Error('permission-denied'));
    const journal = createInMemoryShiftCloseIntentJournal();

    const result = await closeShift(makeShift(), 1000, 'note', { journal });
    const outcome = await result.whenServerConfirmed;

    expect(outcome.outcome).toBe('rejected');
    const stored = await journal.getCloseIntent('shift-1');
    expect(stored.ok && stored.value?.status).toBe('rejected_manual_attention');
  });

  test('identity mismatch on the confirmed remote doc resolves to identity_mismatch and never rewrites the frozen local totals', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    updateDocMock.mockResolvedValue(undefined);
    getDocFromServerMock.mockResolvedValue(makeConfirmedSnap({ actualCashCount: 999 }));
    const journal = createInMemoryShiftCloseIntentJournal();

    const result = await closeShift(makeShift(), 1000, 'note', { journal });
    const outcome = await result.whenServerConfirmed;

    expect(outcome.outcome).toBe('identity_mismatch');
    const stored = await journal.getCloseIntent('shift-1');
    expect(stored.ok && stored.value?.status).toBe('rejected_manual_attention');
    expect(stored.ok && stored.value?.actualCashCount).toBe(1000); // frozen local snapshot untouched
  });

  test('Variant C: a confirmed close whose doc still reads syncState "pending" triggers exactly one syncState-only normalization write', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    updateDocMock.mockResolvedValue(undefined);
    getDocFromServerMock.mockResolvedValue(makeConfirmedSnap({ syncState: 'pending' }));
    const journal = createInMemoryShiftCloseIntentJournal();

    const result = await closeShift(makeShift(), 1000, 'note', { journal });
    await result.whenServerConfirmed;

    // Call 1 = the close write itself; call 2 = the Variant C normalization.
    expect(updateDocMock).toHaveBeenCalledTimes(2);
    const [, normalizePatch] = updateDocMock.mock.calls[1] as [unknown, Record<string, unknown>];
    expect(normalizePatch).toEqual({ syncState: 'synced' });
  });

  test('Variant C: a doc that already reads syncState "synced" is never re-normalized', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    updateDocMock.mockResolvedValue(undefined);
    getDocFromServerMock.mockResolvedValue(makeConfirmedSnap({ syncState: 'synced' }));
    const journal = createInMemoryShiftCloseIntentJournal();

    const result = await closeShift(makeShift(), 1000, 'note', { journal });
    const outcome = await result.whenServerConfirmed;

    expect(outcome.outcome).toBe('confirmed');
    expect(updateDocMock).toHaveBeenCalledTimes(1); // only the original close write
  });

  // NOTE: `closeShift`'s dev-mode branch (Firebase unconfigured) is not
  // exercised by this file — `isFirebaseConfigured: true` is fixed at the
  // top-level module mock for the whole suite. The dev-mode branch is a thin,
  // low-risk wrapper (`devCloseShift(...)` + `Promise.resolve({outcome:'confirmed',...})`)
  // with no offline/reconciliation logic of its own; deferring a dedicated
  // dev-mode test file rather than overclaiming coverage here.
});

describe('closeShift — OBS-B1B correlation writer', () => {
  const FIXED_CORR = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const FIXED_NOW = Date.parse('2026-07-09T12:00:00.000Z');

  test('B1B-T11: persisted non-null correlation id appears in W3 update payload', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    const journal = createInMemoryShiftCloseIntentJournal({
      now: () => FIXED_NOW,
      generateCloseCorrelationId: () => FIXED_CORR,
    });

    await closeShift(makeShift(), 1000, 'note', { journal });

    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const [, patch] = updateDocMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(patch.closeCorrelationId).toBe(FIXED_CORR);
  });

  test('B1B-T12: persisted null correlation omits closeCorrelationId key from W3 payload', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    const journal = createInMemoryShiftCloseIntentJournal({
      now: () => FIXED_NOW,
      generateCloseCorrelationId: () => null,
    });

    await closeShift(makeShift(), 1000, 'note', { journal });

    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const [, patch] = updateDocMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(Object.prototype.hasOwnProperty.call(patch, 'closeCorrelationId')).toBe(false);
    expect(patch.closeCorrelationId).toBeUndefined();
  });

  test('B1B-T13: returned closedAtLocal equals persisted journal entry value', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    const journal = createInMemoryShiftCloseIntentJournal({
      now: () => FIXED_NOW,
      generateCloseCorrelationId: () => FIXED_CORR,
    });

    const result = await closeShift(makeShift(), 1000, 'note', { journal });
    const stored = await journal.getCloseIntent('shift-1');
    expect(stored.ok).toBe(true);
    if (!stored.ok || !stored.value) return;
    expect(result.closedAtLocal).toBe(stored.value.closedAtLocal);
    expect(result.closedAtLocal).toBe(FIXED_NOW);
  });

  test('B1B-T14: unrelated W3 payload fields remain unchanged aside from optional correlation key', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    const journal = createInMemoryShiftCloseIntentJournal({
      now: () => FIXED_NOW,
      generateCloseCorrelationId: () => FIXED_CORR,
    });

    await closeShift(makeShift(), 1000, 'note-x', { journal });

    const [, patch] = updateDocMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(patch.status).toBe('closed');
    expect(patch.closedAt).toEqual(serverTimestamp());
    expect(patch.actualCashCount).toBe(1000);
    expect(patch.note).toBe('note-x');
    expect(patch.closedOffline).toBe(true);
    expect(patch.syncState).toBe('pending');
    expect(patch.deviceId).toBe('DEV1');
    expect(patch.expectedCash).toBe(1000);
    expect(patch.totalBills).toBe(3);
    expect(patch.closeCorrelationId).toBe(FIXED_CORR);
  });
});

describe('OBS-B2 closeShift Mechanism-B observer wiring', () => {
  const FIXED_CORR = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const FIXED_NOW = Date.parse('2026-07-09T12:00:00.000Z');

  test('observer sees ok/changed after successful close; business result unchanged', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    updateDocMock.mockResolvedValue(undefined);
    const journal = createInMemoryShiftCloseIntentJournal({
      now: () => FIXED_NOW,
      generateCloseCorrelationId: () => FIXED_CORR,
    });
    const outcomes: unknown[] = [];
    const result = await closeShift(makeShift(), 1000, 'note', {
      journal,
      observePointerRepair: (o) => outcomes.push(o),
    });
    expect(result.status).toBe('closed');
    expect(result.closedAtLocal).toBe(FIXED_NOW);
    expect(outcomes).toEqual([{ status: 'ok', changed: true }]);
    expect(updateDocMock).toHaveBeenCalledTimes(1);
  });

  test('throwing observer does not fail the close', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    updateDocMock.mockResolvedValue(undefined);
    const journal = createInMemoryShiftCloseIntentJournal({
      now: () => FIXED_NOW,
      generateCloseCorrelationId: () => FIXED_CORR,
    });
    const result = await closeShift(makeShift(), 1000, 'note', {
      journal,
      observePointerRepair: () => {
        throw new Error('observer boom');
      },
    });
    expect(result.status).toBe('closed');
    expect(result.closedAtLocal).toBe(FIXED_NOW);
  });

  test('B1B correlation field behavior unchanged with observer present', async () => {
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap());
    updateDocMock.mockResolvedValue(undefined);
    const journal = createInMemoryShiftCloseIntentJournal({
      now: () => FIXED_NOW,
      generateCloseCorrelationId: () => FIXED_CORR,
    });
    await closeShift(makeShift(), 1000, 'note', {
      journal,
      observePointerRepair: () => undefined,
    });
    const [, patch] = updateDocMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(patch.closeCorrelationId).toBe(FIXED_CORR);
    expect(patch.deviceId).toBe('DEV1');
    expect(patch.syncState).toBe('pending');
  });
});

describe('openShift — PK-1 local optimistic offline open', () => {
  test('persists open intent before issuing remote setDoc', async () => {
    const openJournal = createInMemoryShiftOpenIntentJournal();
    const closeJournal = createInMemoryShiftCloseIntentJournal();
    let intentVisibleBeforeSetDoc = false;
    let resolveSetDoc!: () => void;
    const setDocGate = new Promise<void>((resolve) => {
      resolveSetDoc = resolve;
    });
    setDocMock.mockImplementation(async () => {
      const stored = await openJournal.getOpenIntent('shift-1');
      intentVisibleBeforeSetDoc = !!(stored.ok && stored.value?.status === 'local_open_pending');
      resolveSetDoc();
    });

    const resultPromise = openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
      journal: openJournal,
      closeJournal,
    });
    await setDocGate;
    const result = await resultPromise;

    expect(intentVisibleBeforeSetDoc).toBe(true);
    expect(setDocMock).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('shift-1');
  });

  test('local persistence failure prevents remote write', async () => {
    const openJournal = createInMemoryShiftOpenIntentJournal();
    const closeJournal = createInMemoryShiftCloseIntentJournal();
    vi.spyOn(openJournal, 'upsertOpenIntent').mockResolvedValue({
      ok: false,
      code: 'unavailable',
    });
    vi.spyOn(openJournal, 'findPendingOpenForStaff').mockResolvedValue({
      ok: true,
      value: undefined,
    });
    vi.spyOn(openJournal, 'findRejectedOpenForDevice').mockResolvedValue({
      ok: true,
      value: undefined,
    });

    await expect(
      openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
        journal: openJournal,
        closeJournal,
      }),
    ).rejects.toThrow(/ออฟไลน์ไม่สำเร็จ|ไม่พร้อม/);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  test('returns usable local Shift without awaiting unresolved remote write', async () => {
    setDocMock.mockImplementation(() => new Promise(() => {})); // never resolves
    const openJournal = createInMemoryShiftOpenIntentJournal();
    const closeJournal = createInMemoryShiftCloseIntentJournal();

    const result = await openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
      journal: openJournal,
      closeJournal,
    });

    expect(result.id).toBe('shift-1');
    expect(result.status).toBe('open');
    expect(result.openedOffline).toBe(true);
    expect(result.syncState).toBe('pending');
    expect(result.startingCash).toBe(500);
    expect(result.deviceId).toBe('DEV1');
  });

  test('remote create payload is exact W0 shape (no offline extras)', async () => {
    const openJournal = createInMemoryShiftOpenIntentJournal();
    const closeJournal = createInMemoryShiftCloseIntentJournal();
    await openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
      journal: openJournal,
      closeJournal,
    });

    const [, payload] = setDocMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(Object.keys(payload).sort()).toEqual(
      [
        'id',
        'branchId',
        'staffId',
        'staffName',
        'status',
        'openedAt',
        'closedAt',
        'startingCash',
        'actualCashCount',
        'expectedCash',
        'expectedQr',
        'expectedKbank',
        'expectedCard',
        'expectedCredit',
        'totalBills',
        'payInTotal',
        'payOutTotal',
        'variance',
        'note',
      ].sort(),
    );
    expect(payload.status).toBe('open');
    expect(payload.closedAt).toBeNull();
    expect(payload.openedAt).toEqual(serverTimestamp());
    expect(payload).not.toHaveProperty('deviceId');
    expect(payload).not.toHaveProperty('openedOffline');
    expect(payload).not.toHaveProperty('syncState');
  });

  test('retry/resume of same pending open reuses shift identity and does not re-setDoc', async () => {
    const openJournal = createInMemoryShiftOpenIntentJournal();
    const closeJournal = createInMemoryShiftCloseIntentJournal();

    const first = await openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
      journal: openJournal,
      closeJournal,
    });
    expect(setDocMock).toHaveBeenCalledTimes(1);

    const second = await openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
      journal: openJournal,
      closeJournal,
    });
    expect(second.id).toBe(first.id);
    expect(setDocMock).toHaveBeenCalledTimes(1);
  });

  test('rejected open blocks duplicate new open', async () => {
    const openJournal = createInMemoryShiftOpenIntentJournal();
    const closeJournal = createInMemoryShiftCloseIntentJournal();
    await openJournal.upsertOpenIntent({
      shiftId: 'old-open',
      branchId: 'LDP-001',
      staffId: 'staff-1',
      staffName: 'ทดสอบ ระบบ',
      startingCash: 100,
      deviceId: 'DEV1',
    });
    await openJournal.markRejectedManualAttention('old-open', 'denied');

    await expect(
      openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
        journal: openJournal,
        closeJournal,
      }),
    ).rejects.toThrow(/ถูกปฏิเสธ/);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  test('rejected close blocks new open', async () => {
    const openJournal = createInMemoryShiftOpenIntentJournal();
    const closeJournal = createInMemoryShiftCloseIntentJournal();
    await closeJournal.upsertCloseIntent({
      shiftId: 'closed-1',
      branchId: 'LDP-001',
      staffId: 'staff-1',
      staffName: 'ทดสอบ ระบบ',
      startingCash: 500,
      expectedCash: 0,
      expectedQr: 0,
      expectedKbank: 0,
      expectedCard: 0,
      expectedCredit: 0,
      payInTotal: 0,
      payOutTotal: 0,
      totalBills: 0,
      actualCashCount: 500,
      variance: 0,
      note: '',
      deviceId: 'DEV1',
    });
    await closeJournal.markRejectedManualAttention('closed-1', 'close denied');

    await expect(
      openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
        journal: openJournal,
        closeJournal,
      }),
    ).rejects.toThrow(/ปิดกะก่อนหน้านี้ต้องตรวจสอบ/);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  test('unresolved pending close against still-open cached shift blocks new open', async () => {
    const openJournal = createInMemoryShiftOpenIntentJournal();
    const closeJournal = createInMemoryShiftCloseIntentJournal();
    await closeJournal.upsertCloseIntent({
      shiftId: 'still-open-close',
      branchId: 'LDP-001',
      staffId: 'staff-1',
      staffName: 'ทดสอบ ระบบ',
      startingCash: 500,
      expectedCash: 0,
      expectedQr: 0,
      expectedKbank: 0,
      expectedCard: 0,
      expectedCredit: 0,
      payInTotal: 0,
      payOutTotal: 0,
      totalBills: 0,
      actualCashCount: 500,
      variance: 0,
      note: '',
      deviceId: 'DEV1',
    });
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap('open'));

    await expect(
      openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
        journal: openJournal,
        closeJournal,
      }),
    ).rejects.toThrow(/ปิดค้าง/);
    expect(setDocMock).not.toHaveBeenCalled();
  });

  test('pending close for already-closed shift still allows a new open (multi-shift)', async () => {
    const openJournal = createInMemoryShiftOpenIntentJournal();
    const closeJournal = createInMemoryShiftCloseIntentJournal();
    await closeJournal.upsertCloseIntent({
      shiftId: 'already-closed',
      branchId: 'LDP-001',
      staffId: 'staff-1',
      staffName: 'ทดสอบ ระบบ',
      startingCash: 500,
      expectedCash: 0,
      expectedQr: 0,
      expectedKbank: 0,
      expectedCard: 0,
      expectedCredit: 0,
      payInTotal: 0,
      payOutTotal: 0,
      totalBills: 0,
      actualCashCount: 500,
      variance: 0,
      note: '',
      deviceId: 'DEV1',
    });
    getDocFromCacheMock.mockResolvedValue(makeOpenSnap('closed'));

    const result = await openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
      journal: openJournal,
      closeJournal,
    });
    expect(result.status).toBe('open');
    expect(setDocMock).toHaveBeenCalledTimes(1);
  });

  test('unavailable remote write error remains pending — intent not erased', async () => {
    setDocMock.mockRejectedValue(Object.assign(new Error('offline'), { code: 'unavailable' }));
    const openJournal = createInMemoryShiftOpenIntentJournal();
    const closeJournal = createInMemoryShiftCloseIntentJournal();

    const result = await openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
      journal: openJournal,
      closeJournal,
    });
    const outcome = await result.whenServerConfirmed;
    expect(outcome.outcome).toBe('still_pending');

    const stored = await openJournal.getOpenIntent(result.id);
    expect(stored.ok && stored.value?.status).toBe('local_open_pending');
    expect(stored.ok && stored.value?.remoteCreateState).toBe('outstanding');
    expect(stored.ok && stored.value?.shiftId).toBe(result.id);
  });

  test('ambiguous transport error remains pending — no false rejection', async () => {
    setDocMock.mockRejectedValue(Object.assign(new Error('network'), { code: 'deadline-exceeded' }));
    const openJournal = createInMemoryShiftOpenIntentJournal();
    const closeJournal = createInMemoryShiftCloseIntentJournal();

    const result = await openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
      journal: openJournal,
      closeJournal,
    });
    const outcome = await result.whenServerConfirmed;
    expect(outcome.outcome).toBe('still_pending');
    const stored = await openJournal.getOpenIntent(result.id);
    expect(stored.ok && stored.value?.status).toBe('local_open_pending');
  });

  test('permission-denied remote write becomes rejected_manual_attention', async () => {
    setDocMock.mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'permission-denied' }),
    );
    const openJournal = createInMemoryShiftOpenIntentJournal();
    const closeJournal = createInMemoryShiftCloseIntentJournal();

    const result = await openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
      journal: openJournal,
      closeJournal,
    });
    const outcome = await result.whenServerConfirmed;
    expect(outcome).toEqual({ outcome: 'rejected', message: 'denied' });

    const stored = await openJournal.getOpenIntent(result.id);
    expect(stored.ok && stored.value?.status).toBe('rejected_manual_attention');
    expect(stored.ok && stored.value?.lastErrorMessage).toBe('denied');
  });

  test('permission-denied + markRejectedManualAttention {ok:false} remains still_pending — no false manual attention', async () => {
    setDocMock.mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'permission-denied' }),
    );
    const baseJournal = createInMemoryShiftOpenIntentJournal();
    const markRejectedManualAttention = vi.fn(async () => ({
      ok: false as const,
      code: 'unavailable' as const,
      message: 'IndexedDB unavailable',
    }));
    const openJournal: ShiftOpenIntentJournal = {
      ...baseJournal,
      markRejectedManualAttention,
    };
    const closeJournal = createInMemoryShiftCloseIntentJournal();

    const result = await openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
      journal: openJournal,
      closeJournal,
    });
    const outcome = await result.whenServerConfirmed;
    expect(outcome.outcome).toBe('still_pending');
    expect(markRejectedManualAttention).toHaveBeenCalledTimes(1);

    // Read durable state via the real base journal — stub only blocked the transition.
    const stored = await baseJournal.getOpenIntent(result.id);
    expect(stored.ok && stored.value?.status).toBe('local_open_pending');
    expect(stored.ok && stored.value?.remoteCreateState).toBe('outstanding');
    expect(stored.ok && stored.value?.shiftId).toBe(result.id);
    expect(stored.ok && stored.value?.status).not.toBe('rejected_manual_attention');
  });

  test('after unavailable failure, later reconciliation can still confirm same pending intent', async () => {
    setDocMock.mockRejectedValue(Object.assign(new Error('offline'), { code: 'unavailable' }));
    const openJournal = createInMemoryShiftOpenIntentJournal();
    const closeJournal = createInMemoryShiftCloseIntentJournal();

    const result = await openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
      journal: openJournal,
      closeJournal,
    });
    expect((await result.whenServerConfirmed).outcome).toBe('still_pending');

    const stored = await openJournal.getOpenIntent(result.id);
    expect(stored.ok && stored.value).toBeTruthy();
    if (!stored.ok || !stored.value) return;

    const { reconcileShiftOpenIntent } = await import('./offline/shiftOpenReconciler');
    const confirmed = await reconcileShiftOpenIntent(stored.value, {
      journal: openJournal,
      deviceId: 'DEV1',
      readConfirmation: async () => ({
        ok: true,
        doc: {
          exists: true,
          status: 'open',
          openedAt: { toDate: () => new Date('2026-08-08T12:00:00.000Z') },
          branchId: 'LDP-001',
          staffId: 'staff-1',
          staffName: 'ทดสอบ ระบบ',
          startingCash: 500,
        },
      }),
    });
    expect(confirmed.outcome).toBe('confirmed');
    const after = await openJournal.getOpenIntent(result.id);
    expect(after.ok && after.value?.status).toBe('synced');
    expect(after.ok && after.value?.shiftId).toBe(result.id);
  });

  test('openShift claims create attempt before setDoc — resume does not allocate new id', async () => {
    const openJournal = createInMemoryShiftOpenIntentJournal();
    const closeJournal = createInMemoryShiftCloseIntentJournal();
    const first = await openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
      journal: openJournal,
      closeJournal,
    });
    const afterFirst = await openJournal.getOpenIntent(first.id);
    expect(afterFirst.ok && afterFirst.value?.remoteCreateState).toBe('outstanding');

    setDocMock.mockClear();
    const second = await openShift('LDP-001', 'staff-1', 'ทดสอบ ระบบ', 500, {
      journal: openJournal,
      closeJournal,
    });
    expect(second.id).toBe(first.id);
    expect(setDocMock).not.toHaveBeenCalled();
  });
});
