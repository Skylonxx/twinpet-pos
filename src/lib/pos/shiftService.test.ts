// Packet 7C-B1 — local optimistic offline close. `closeShift` is exercised
// against mocked Firestore primitives (never a real network/IndexedDB) so
// these tests can assert the cache-only verification, the durable
// close-intent write, and the fire-and-forget shift-doc update in isolation.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { serverTimestamp } from 'firebase/firestore';
import type { Shift } from '../types';
import { createInMemoryShiftCloseIntentJournal } from './offline/shiftCloseIntentStore';
import type { ShiftCloseIntentSnapshot } from './offline/shiftCloseIntentTypes';

vi.mock('../firebase', () => ({
  isFirebaseConfigured: true,
  db: {} as unknown,
  collections: { shifts: 'shifts', cashTransactions: 'cashTransactions' },
}));

const { getDocFromCacheMock, updateDocMock, docMock } = vi.hoisted(() => ({
  getDocFromCacheMock: vi.fn(),
  updateDocMock: vi.fn(),
  docMock: vi.fn(() => ({ id: 'shift-1' }) as never),
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    doc: docMock,
    getDocFromCache: getDocFromCacheMock,
    updateDoc: updateDocMock,
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
import { closeShift } from './shiftService';

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

function makeSnapshot(overrides: Partial<ShiftCloseIntentSnapshot> = {}): ShiftCloseIntentSnapshot {
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
    closedAtLocal: Date.now(),
    deviceId: 'DEV1',
    ...overrides,
  };
}

beforeEach(() => {
  getDocFromCacheMock.mockReset();
  updateDocMock.mockReset();
  updateDocMock.mockResolvedValue(undefined);
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
