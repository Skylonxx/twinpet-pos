// @vitest-environment jsdom
// Return/Refund V1 blocker fix D-RET-FIX-8 — mounted-POS shift-close freshness.
//
// A cash Return posts a server-side `pay_out` onto `shifts/{id}.cashEntries`.
// An already-mounted POS holds a stale activeShift; closing from it would
// freeze a wrong payOutTotal / expected cash / variance. `closeShift` must
// re-read the authoritative shift when online and fail closed if it cannot.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Shift, ShiftCashEntry } from '../types';
import { createInMemoryShiftCloseIntentJournal } from './offline/shiftCloseIntentStore';

vi.mock('../firebase', () => ({
  isFirebaseConfigured: true,
  db: {} as unknown,
  collections: { shifts: 'shifts', cashTransactions: 'cashTransactions' },
}));

const { getDocFromCacheMock, getDocFromServerMock, updateDocMock, docMock } = vi.hoisted(() => ({
  getDocFromCacheMock: vi.fn(),
  getDocFromServerMock: vi.fn(),
  updateDocMock: vi.fn(),
  docMock: vi.fn(() => ({ id: 'shift-1' }) as never),
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    doc: docMock,
    getDocFromCache: getDocFromCacheMock,
    getDocFromServer: getDocFromServerMock,
    updateDoc: updateDocMock,
  };
});

vi.mock('./deviceId', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./deviceId')>();
  return { ...actual, getDeviceId: vi.fn(() => 'DEV1') };
});

import {
  CLOSE_SHIFT_FRESHNESS_MESSAGE,
  CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE,
  calcShiftDrawerExpected,
  closeShift,
} from './shiftService';
import {
  clearShiftServerCashPending,
  hasShiftServerCashPending,
  markShiftServerCashPending,
  mergeCashEntries,
  type ServerShiftCashRead,
} from './shiftCashFreshness';

const REFUND: ShiftCashEntry = {
  id: 'rfd_ret1',
  type: 'pay_out',
  amount: 162,
  note: 'คืนเงินสด RT-R-1-1',
  staffId: 'staff-1',
  staffName: 'ทดสอบ',
  at: 1,
};
const PAY_IN: ShiftCashEntry = { id: 'c1', type: 'pay_in', amount: 50, note: '', staffId: 'staff-1', staffName: 'ทดสอบ', at: 2 };

function makeShift(overrides: Partial<Shift> = {}): Shift {
  return {
    id: 'shift-1',
    branchId: 'LDP-001',
    staffId: 'staff-1',
    staffName: 'ทดสอบ',
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

function openCacheSnap(cashEntries: ShiftCashEntry[] = []) {
  return { exists: () => true, data: () => ({ status: 'open', cashEntries }) };
}

function serverReader(read: ServerShiftCashRead) {
  return vi.fn(async () => read);
}

const noPending = { has: () => false, clear: vi.fn() };

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  };
}

beforeEach(() => {
  getDocFromCacheMock.mockReset();
  getDocFromServerMock.mockReset();
  getDocFromServerMock.mockResolvedValue({ exists: () => false, data: () => undefined });
  updateDocMock.mockReset();
  updateDocMock.mockResolvedValue(undefined);
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('closeShift — online cash freshness (D-RET-FIX-8)', () => {
  test('POS mounted BEFORE a cash Return: the close folds the fresh server pay-out', async () => {
    getDocFromCacheMock.mockResolvedValue(openCacheSnap([]));
    const stale = makeShift(); // mounted before the Return: no refund entry, payOut 0
    expect(calcShiftDrawerExpected(stale)).toBe(1500);
    const journal = createInMemoryShiftCloseIntentJournal();
    const read = serverReader({ ok: true, exists: true, status: 'open', cashEntries: [REFUND] });

    const result = await closeShift(stale, 1338, '', { journal, readServerShiftCash: read, isOnline: () => true, serverCashPending: noPending });

    expect(read).toHaveBeenCalledWith('shift-1');
    expect(result.payOutTotal).toBe(162);
    expect(result.variance).toBe(0); // 500 + 1000 − 162 = 1338 counted
    expect(updateDocMock).toHaveBeenCalledTimes(1);
    expect(updateDocMock.mock.calls[0]![1]).toMatchObject({ payOutTotal: 162, payInTotal: 0, variance: 0, expectedCash: 1000 });
    const intent = await journal.getCloseIntent('shift-1');
    expect(intent.ok && intent.value?.payOutTotal).toBe(162);
  });

  test('local (possibly unflushed) and server entries are unioned by id — never double counted', async () => {
    getDocFromCacheMock.mockResolvedValue(openCacheSnap([PAY_IN]));
    const local = makeShift({ cashEntries: [PAY_IN], payInTotal: 50 });
    const result = await closeShift(local, 1388, '', {
      journal: createInMemoryShiftCloseIntentJournal(),
      readServerShiftCash: serverReader({ ok: true, exists: true, status: 'open', cashEntries: [PAY_IN, REFUND] }),
      isOnline: () => true,
      serverCashPending: noPending,
    });
    expect(result).toMatchObject({ payInTotal: 50, payOutTotal: 162, variance: 0 });
    expect(mergeCashEntries([PAY_IN], [PAY_IN, REFUND], [REFUND]).map((e) => e.id)).toEqual(['c1', 'rfd_ret1']);
  });

  test('a non-cash Return leaves cash expected unchanged (no server cash entry)', async () => {
    getDocFromCacheMock.mockResolvedValue(openCacheSnap([]));
    const result = await closeShift(makeShift(), 1500, '', {
      journal: createInMemoryShiftCloseIntentJournal(),
      readServerShiftCash: serverReader({ ok: true, exists: true, status: 'open', cashEntries: [] }),
      isOnline: () => true,
      serverCashPending: noPending,
    });
    expect(result).toMatchObject({ payOutTotal: 0, variance: 0 });
    expect(calcShiftDrawerExpected(result)).toBe(1500);
  });

  test('server refresh failure while online fails closed: no write, no close intent', async () => {
    getDocFromCacheMock.mockResolvedValue(openCacheSnap([]));
    const journal = createInMemoryShiftCloseIntentJournal();
    await expect(
      closeShift(makeShift(), 1338, '', {
        journal,
        readServerShiftCash: serverReader({ ok: false }),
        isOnline: () => true,
        serverCashPending: noPending,
      }),
    ).rejects.toThrow(CLOSE_SHIFT_FRESHNESS_MESSAGE);
    expect(updateDocMock).not.toHaveBeenCalled();
    const intent = await journal.getCloseIntent('shift-1');
    expect(intent.ok && intent.value).toBeFalsy();
  });

  test('server says the shift is already closed / missing: no stale close', async () => {
    getDocFromCacheMock.mockResolvedValue(openCacheSnap([]));
    const base = { journal: createInMemoryShiftCloseIntentJournal(), isOnline: () => true, serverCashPending: noPending };
    await expect(
      closeShift(makeShift(), 1, '', { ...base, readServerShiftCash: serverReader({ ok: true, exists: true, status: 'closed', cashEntries: [] }) }),
    ).rejects.toThrow('ปิดไปแล้ว');
    await expect(
      closeShift(makeShift(), 1, '', { ...base, readServerShiftCash: serverReader({ ok: true, exists: false, status: undefined, cashEntries: [] }) }),
    ).rejects.toThrow(CLOSE_SHIFT_FRESHNESS_MESSAGE);
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  test('default reader: real getDocFromServer path folds the server pay-out', async () => {
    getDocFromCacheMock.mockResolvedValue(openCacheSnap([]));
    getDocFromServerMock.mockResolvedValueOnce({ exists: () => true, data: () => ({ status: 'open', cashEntries: [REFUND] }) });
    const result = await closeShift(makeShift(), 1338, '', {
      journal: createInMemoryShiftCloseIntentJournal(),
      isOnline: () => true,
      serverCashPending: noPending,
    });
    expect(result.payOutTotal).toBe(162);
  });

  test('default reader: a server read error fails closed', async () => {
    getDocFromCacheMock.mockResolvedValue(openCacheSnap([]));
    getDocFromServerMock.mockRejectedValueOnce(new Error('unavailable'));
    await expect(
      closeShift(makeShift(), 1338, '', { journal: createInMemoryShiftCloseIntentJournal(), isOnline: () => true, serverCashPending: noPending }),
    ).rejects.toThrow(CLOSE_SHIFT_FRESHNESS_MESSAGE);
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  test('ordinary online close with no cash movements is unchanged', async () => {
    getDocFromCacheMock.mockResolvedValue(openCacheSnap([]));
    const result = await closeShift(makeShift(), 1490, 'n', {
      journal: createInMemoryShiftCloseIntentJournal(),
      readServerShiftCash: serverReader({ ok: true, exists: true, status: 'open', cashEntries: [] }),
      isOnline: () => true,
      serverCashPending: noPending,
    });
    expect(result).toMatchObject({ status: 'closed', payInTotal: 0, payOutTotal: 0, variance: -10, expectedCash: 1000 });
  });
});

describe('closeShift — offline close with a known unsynced server cash mutation', () => {
  test('offline + pending marker for this shift → fail closed (must close online)', async () => {
    getDocFromCacheMock.mockResolvedValue(openCacheSnap([]));
    markShiftServerCashPending('shift-1');
    const read = serverReader({ ok: true, exists: true, status: 'open', cashEntries: [] });
    await expect(
      closeShift(makeShift(), 1338, '', { journal: createInMemoryShiftCloseIntentJournal(), readServerShiftCash: read, isOnline: () => false }),
    ).rejects.toThrow(CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE);
    expect(read).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  test('offline without marker keeps the existing cache-only close, folding the cached refund entry', async () => {
    getDocFromCacheMock.mockResolvedValue(openCacheSnap([REFUND]));
    const result = await closeShift(makeShift(), 1338, '', { journal: createInMemoryShiftCloseIntentJournal(), isOnline: () => false });
    expect(result).toMatchObject({ payOutTotal: 162, variance: 0 });
  });

  test('a successful online close clears the marker', async () => {
    getDocFromCacheMock.mockResolvedValue(openCacheSnap([]));
    markShiftServerCashPending('shift-1');
    await closeShift(makeShift(), 1338, '', {
      journal: createInMemoryShiftCloseIntentJournal(),
      readServerShiftCash: serverReader({ ok: true, exists: true, status: 'open', cashEntries: [REFUND] }),
      isOnline: () => true,
    });
    expect(hasShiftServerCashPending('shift-1')).toBe(false);
    clearShiftServerCashPending('shift-1');
  });
});
