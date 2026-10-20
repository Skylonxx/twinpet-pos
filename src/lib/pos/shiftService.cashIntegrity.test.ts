// @vitest-environment jsdom
// Return/Refund V1 — C1-R1 R1-B: the shift close must REFUSE ambiguous cash-entry
// identities instead of silently keeping the first one.
//
// `mergeCashEntries` unions by id with FIRST occurrence wins. A client-made
// `rfd_X pay_out 1` followed by the server's real `rfd_X pay_out 81` (arrayUnion
// is whole-object, not id, unique) therefore froze payOut 1 — an 80-baht drawer
// error with a closed shift. These tests drive the real `closeShift` through a
// faithful optimistic-transaction model and assert the exact write counts and
// cash totals, not only the copy.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Shift, ShiftCashEntry } from '../types';
import { createInMemoryShiftCloseIntentJournal } from './offline/shiftCloseIntentStore';
import type { ShiftCloseConfirmationReader } from './offline/shiftCloseReconciler';

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
  return { ...actual, doc: docMock, getDocFromCache: getDocFromCacheMock, updateDoc: updateDocMock };
});

vi.mock('./deviceId', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./deviceId')>();
  return { ...actual, getDeviceId: vi.fn(() => 'DEV1') };
});

import { closeShift, type CloseShiftDeps, type ShiftCloseTransactionRunner } from './shiftService';
import { hasShiftServerCashPending, markCashReturnAttemptPending } from './shiftCashFreshness';

const UUID_A = '11111111-1111-4111-8111-111111111111';
// Literal (not an exported constant) so the RED run on the parent compiles and
// fails on BEHAVIOR (the close succeeds with payOut 1), not on a missing import.
const AMBIGUOUS_COPY = 'รหัสรายการเงินสด';

const RFD_ID = `rfd_${'a'.repeat(40)}`;
const entry = (id: string, over: Partial<ShiftCashEntry> = {}): ShiftCashEntry => ({
  id,
  type: 'pay_out',
  amount: 1,
  note: 'n',
  staffId: 'staff-1',
  staffName: 'ทดสอบ',
  at: 1,
  ...over,
});
const FAKE_1 = entry(RFD_ID, { amount: 1, note: 'client-made', at: 5 });
const REAL_81 = entry(RFD_ID, { amount: 81, note: 'คืนเงินสด RT-R-1-1 (บิล B1)', at: 9 });
const PAY_IN = entry('Zk3sQe9wLm2PqRtUvXy1', { type: 'pay_in', amount: 50, at: 2 });
const PAY_OUT = entry('Ab3sQe9wLm2PqRtUvXy2', { type: 'pay_out', amount: 30, at: 3 });

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

function cacheSnap(cashEntries: unknown) {
  return { exists: () => true, data: () => ({ status: 'open', cashEntries }) };
}

type ServerShift = Record<string, unknown>;

function cloneDoc(d: ServerShift): ServerShift {
  return { ...d, cashEntries: Array.isArray(d.cashEntries) ? (d.cashEntries as unknown[]).map((e) => (e && typeof e === 'object' ? { ...(e as object) } : e)) : d.cashEntries };
}

function createShiftServer(initial: ServerShift | null, opts: { maxAttempts?: number } = {}) {
  const maxAttempts = opts.maxAttempts ?? 5;
  const state = { doc: initial ? cloneDoc(initial) : null, version: 1, commits: 0, conflicts: 0, attempts: 0 };
  const events: string[] = [];
  let beforeCommit: ((attempt: number) => void | Promise<void>) | null = null;

  const returnCommits = (e: ShiftCashEntry) => {
    const entries = Array.isArray(state.doc!.cashEntries) ? (state.doc!.cashEntries as ShiftCashEntry[]) : [];
    state.doc = { ...state.doc!, cashEntries: [...entries, e] };
    state.version += 1;
    events.push(`return ${e.id} amount=${e.amount} COMMITTED (v${state.version})`);
  };

  const run: ShiftCloseTransactionRunner = async (_id, fn) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      state.attempts += 1;
      const txn: { readVersion: number | null; buffered: Record<string, unknown> | null } = { readVersion: null, buffered: null };
      const out = await fn({
        get: async () => {
          txn.readVersion = state.version;
          events.push(`close#${attempt} read (v${state.version})`);
          return { exists: state.doc != null, data: state.doc ? cloneDoc(state.doc) : undefined };
        },
        update: (payload) => {
          txn.buffered = payload;
        },
      });
      if (txn.buffered) {
        await beforeCommit?.(attempt);
        if (txn.readVersion !== state.version) {
          state.conflicts += 1;
          events.push(`close#${attempt} commit FAILED precondition → retry`);
          continue;
        }
        state.doc = { ...state.doc!, ...txn.buffered, closedAt: { toDate: () => new Date('2026-10-20T10:00:00Z') } };
        state.version += 1;
        state.commits += 1;
        events.push(`close#${attempt} COMMITTED payOut=${String(txn.buffered.payOutTotal)} payIn=${String(txn.buffered.payInTotal)} variance=${String(txn.buffered.variance)}`);
      }
      return out;
    }
    throw Object.assign(new Error('Transaction failed all retries'), { code: 'aborted' });
  };

  const readConfirmation: ShiftCloseConfirmationReader = async () => ({
    ok: true,
    doc: state.doc ? ({ exists: true, ...state.doc } as never) : { exists: false },
  });
  const normalizeSyncState = async () => {
    if (state.doc) state.doc = { ...state.doc, syncState: 'synced' };
  };

  return {
    state,
    events,
    run,
    readConfirmation,
    normalizeSyncState,
    returnCommits,
    onBeforeCommit: (f: typeof beforeCommit) => {
      beforeCommit = f;
    },
  };
}

function serverDoc(cashEntries: unknown): ServerShift {
  return { id: 'shift-1', branchId: 'LDP-001', staffId: 'staff-1', staffName: 'ทดสอบ', status: 'open', startingCash: 500, cashEntries };
}

const noPending = { has: () => false, clear: vi.fn() };

function onlineDeps(server: ReturnType<typeof createShiftServer>, extra: Partial<CloseShiftDeps> = {}): CloseShiftDeps {
  return {
    journal: createInMemoryShiftCloseIntentJournal({ generateCloseCorrelationId: () => UUID_A }),
    isOnline: () => true,
    serverCashPending: noPending,
    runCloseTransaction: server.run,
    waitForQueuedWrites: async () => true,
    readConfirmation: server.readConfirmation,
    normalizeSyncState: server.normalizeSyncState,
    ...extra,
  };
}

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
  getDocFromCacheMock.mockResolvedValue(cacheSnap([]));
  updateDocMock.mockReset();
  updateDocMock.mockResolvedValue(undefined);
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Online close must refuse BEFORE any W3 write: shift still open and untouched,
 * no journal intent / Z, the cash guards kept, no `updateDoc`.
 */
async function expectRefusedOnline(
  server: ReturnType<typeof createShiftServer>,
  shift: Shift,
  deps = onlineDeps(server),
): Promise<CloseShiftDeps> {
  const before = JSON.stringify(server.state.doc);
  await expect(closeShift(shift, 1338, '', deps)).rejects.toThrow(AMBIGUOUS_COPY);
  expect(server.state.commits).toBe(0);
  expect(server.state.doc!.status).toBe('open');
  expect(JSON.stringify(server.state.doc)).toBe(before); // authoritative shift byte-identical
  expect(server.events.some((e) => e.includes('close#') && e.includes('COMMITTED'))).toBe(false);
  expect(updateDocMock).not.toHaveBeenCalled();
  const intent = await deps.journal!.getCloseIntent('shift-1');
  expect(intent.ok && intent.value).toBeFalsy(); // no journal entry, hence no Z
  return deps;
}

describe('C1-R1 R1-B — ONLINE close refuses ambiguous cash-entry identities (before the W3 write)', () => {
  test('server list [rfd_X out 1, rfd_X out 81] → refused; no payout-1 close, no commit, guards kept', async () => {
    expect(markCashReturnAttemptPending('shift-1', 'att-1', 'committed_unsynced')).toBe(true);
    const server = createShiftServer(serverDoc([FAKE_1, REAL_81]));
    await expectRefusedOnline(server, makeShift(), onlineDeps(server, { serverCashPending: undefined }));
    expect(hasShiftServerCashPending('shift-1')).toBe(true); // pending guards NOT cleared by a refused close
  });

  test('reverse order [rfd_X out 81, rfd_X out 1] → refused', async () => {
    await expectRefusedOnline(createShiftServer(serverDoc([REAL_81, FAKE_1])), makeShift());
  });

  test('exact same-object duplicates inside the single authoritative server list → refused (uniqueness unproven)', async () => {
    await expectRefusedOnline(createShiftServer(serverDoc([REAL_81, { ...REAL_81 }])), makeShift());
  });

  test('same id with a different TYPE inside the server list → refused', async () => {
    await expectRefusedOnline(createShiftServer(serverDoc([REAL_81, { ...REAL_81, type: 'pay_in' }])), makeShift());
  });

  test('cross-source conflict: LOCAL mounted shift has rfd_X out 1, server has the real rfd_X out 81 → refused (the honest Return is not hidden)', async () => {
    const server = createShiftServer(serverDoc([REAL_81]));
    await expectRefusedOnline(server, makeShift({ cashEntries: [FAKE_1] }));
  });

  test('cross-source conflict: CACHE has rfd_X out 1 first, server has rfd_X out 81 → refused', async () => {
    getDocFromCacheMock.mockResolvedValue(cacheSnap([FAKE_1]));
    await expectRefusedOnline(createShiftServer(serverDoc([REAL_81])), makeShift());
  });

  test('cross-source conflict: same id, same amount, DIFFERENT type across local/server → refused', async () => {
    await expectRefusedOnline(createShiftServer(serverDoc([REAL_81])), makeShift({ cashEntries: [{ ...REAL_81, type: 'pay_in' }] }));
  });

  test('duplicate id inside the LOCAL list or the CACHE list → refused even when objects are identical', async () => {
    await expectRefusedOnline(createShiftServer(serverDoc([])), makeShift({ cashEntries: [PAY_IN, { ...PAY_IN }] }));
    getDocFromCacheMock.mockResolvedValue(cacheSnap([PAY_OUT, { ...PAY_OUT }]));
    await expectRefusedOnline(createShiftServer(serverDoc([])), makeShift());
  });

  test.each([
    ['amount is a string', { ...PAY_IN, amount: '50' }],
    ['amount is NaN', { ...PAY_IN, amount: Number.NaN }],
    ['amount is Infinity', { ...PAY_IN, amount: Number.POSITIVE_INFINITY }],
    ['amount is negative', { ...PAY_IN, amount: -5 }],
    ['amount is zero', { ...PAY_IN, amount: 0 }],
    ['amount missing', { ...PAY_IN, amount: undefined }],
    ['type unknown', { ...PAY_IN, type: 'refund' }],
    ['type missing', { ...PAY_IN, type: undefined }],
    ['id missing', { ...PAY_IN, id: undefined }],
    ['id blank', { ...PAY_IN, id: '   ' }],
    ['id not a string', { ...PAY_IN, id: 7 }],
    ['entry is null', null],
    ['entry is a string', 'rfd_x'],
    ['entry is an array', [PAY_IN]],
  ])('malformed server entry (%s) → refused, nothing written', async (_name, bad) => {
    await expectRefusedOnline(createShiftServer(serverDoc([PAY_OUT, bad])), makeShift());
  });

  test.each([
    ['an object', { 0: PAY_IN }],
    ['a string', 'oops'],
    ['null', null],
    ['a number', 3],
  ])('server cashEntries present but %s (not a list) → refused, nothing written', async (_name, bad) => {
    await expectRefusedOnline(createShiftServer(serverDoc(bad)), makeShift());
  });

  test('a malformed LOCAL or CACHE entry → refused (money is never coerced)', async () => {
    await expectRefusedOnline(createShiftServer(serverDoc([])), makeShift({ cashEntries: [{ ...PAY_IN, amount: '50' as unknown as number }] }));
    getDocFromCacheMock.mockResolvedValue(cacheSnap([{ ...PAY_IN, type: 'refund' }]));
    await expectRefusedOnline(createShiftServer(serverDoc([])), makeShift());
  });

  test('a collision revealed only on a RETRY (Return commits between read and commit) is refused on the fresh read, never closed', async () => {
    // Attempt #1 reads a clean server; the real Return then commits rfd_X out 81 while the
    // device's own (older, cache-projected) rfd_X out 1 is already local → attempt #2 must refuse.
    const server = createShiftServer(serverDoc([]));
    server.onBeforeCommit((attempt) => {
      if (attempt === 1) server.returnCommits(REAL_81);
    });
    await expect(closeShift(makeShift({ cashEntries: [FAKE_1] }), 1338, '', onlineDeps(server))).rejects.toThrow(AMBIGUOUS_COPY);
    expect(server.state.commits).toBe(0);
    expect(server.state.conflicts).toBe(1);
    expect(server.state.doc!.status).toBe('open');
    expect((server.state.doc!.cashEntries as ShiftCashEntry[]).map((e) => e.amount)).toEqual([81]);
  });

  test('refusal is not sticky: once the ambiguity is repaired the SAME deps close exactly once with the exact totals', async () => {
    const server = createShiftServer(serverDoc([FAKE_1, REAL_81]));
    const deps = await expectRefusedOnline(server, makeShift());
    server.state.doc = { ...server.state.doc!, cashEntries: [REAL_81] }; // operator repair (out of band)
    server.state.version += 1;
    const result = await closeShift(makeShift(), 1419, '', deps);
    expect(server.state.commits).toBe(1);
    expect(server.state.doc).toMatchObject({ status: 'closed', payOutTotal: 81, payInTotal: 0, variance: 0, closeCorrelationId: UUID_A });
    expect(result).toMatchObject({ status: 'closed', payOutTotal: 81, variance: 0 });
  });
});

describe('C1-R1 R1-B — legitimate shapes still close with exact totals', () => {
  test('valid mirror: the SAME entry in local + cache + server (distinct object copies) closes once, counted once', async () => {
    getDocFromCacheMock.mockResolvedValue(cacheSnap([PAY_IN, REAL_81]));
    const server = createShiftServer(serverDoc([PAY_IN, REAL_81]));
    const result = await closeShift(makeShift({ cashEntries: [PAY_IN, REAL_81] }), 1469, '', onlineDeps(server));
    expect(server.state.commits).toBe(1);
    expect(server.state.doc).toMatchObject({ status: 'closed', payInTotal: 50, payOutTotal: 81, variance: 0 });
    expect(result).toMatchObject({ payInTotal: 50, payOutTotal: 81, variance: 0 });
  });

  test('ordinary distinct entries across sources (local-only queued + server-only Return) are all counted', async () => {
    getDocFromCacheMock.mockResolvedValue(cacheSnap([PAY_IN]));
    const server = createShiftServer(serverDoc([PAY_IN, REAL_81]));
    const result = await closeShift(makeShift({ cashEntries: [PAY_IN, PAY_OUT] }), 1439, '', onlineDeps(server));
    expect(server.state.commits).toBe(1);
    expect(server.state.doc).toMatchObject({ payInTotal: 50, payOutTotal: 111, variance: 0 });
    expect(result).toMatchObject({ payInTotal: 50, payOutTotal: 111 });
  });

  test('case variants rfd_X / RFD_X are DISTINCT ids (reservation is the case-sensitive server prefix): both counted, no collision', async () => {
    const upper = entry(RFD_ID.toUpperCase(), { amount: 4 });
    const server = createShiftServer(serverDoc([REAL_81, upper]));
    const result = await closeShift(makeShift(), 1415, '', onlineDeps(server));
    expect(server.state.commits).toBe(1);
    expect(result).toMatchObject({ payOutTotal: 85, variance: 0 });
  });

  test('a missing/absent server cashEntries field is an empty list (W0 shifts that never had a cash entry)', async () => {
    const d = serverDoc([]);
    delete d.cashEntries;
    const server = createShiftServer(d);
    const result = await closeShift(makeShift(), 1500, '', onlineDeps(server));
    expect(server.state.commits).toBe(1);
    expect(result).toMatchObject({ payInTotal: 0, payOutTotal: 0, variance: 0 });
  });

  test('a concurrent honest Return still serialises: conflict → re-read → closes with the real payout', async () => {
    const server = createShiftServer(serverDoc([PAY_IN]));
    server.onBeforeCommit((attempt) => {
      if (attempt === 1) server.returnCommits(REAL_81);
    });
    getDocFromCacheMock.mockResolvedValue(cacheSnap([PAY_IN]));
    const result = await closeShift(makeShift({ cashEntries: [PAY_IN] }), 1469, '', onlineDeps(server));
    expect(server.state).toMatchObject({ commits: 1, conflicts: 1, attempts: 2 });
    expect(server.state.doc).toMatchObject({ payInTotal: 50, payOutTotal: 81, variance: 0 });
    expect(result).toMatchObject({ payOutTotal: 81, variance: 0 });
  });

  test('a refused close of shift-1 does not affect the guards or the close of another shift', async () => {
    expect(markCashReturnAttemptPending('shift-9', 'att-9')).toBe(true);
    await expectRefusedOnline(createShiftServer(serverDoc([FAKE_1, REAL_81])), makeShift());
    expect(hasShiftServerCashPending('shift-9')).toBe(true);
  });
});

describe('C1-R1 R1-B — OFFLINE close folds local+cache with the same first-wins merge, so it refuses the same ambiguity', () => {
  const offlineDeps = () => ({ journal: createInMemoryShiftCloseIntentJournal(), isOnline: () => false });

  test('local list [rfd_X out 1] + cache [rfd_X out 81] → refused: no intent, no queued updateDoc', async () => {
    getDocFromCacheMock.mockResolvedValue(cacheSnap([REAL_81]));
    const deps = offlineDeps();
    await expect(closeShift(makeShift({ cashEntries: [FAKE_1] }), 1338, '', deps)).rejects.toThrow(AMBIGUOUS_COPY);
    expect(updateDocMock).not.toHaveBeenCalled();
    const none = await deps.journal.getCloseIntent('shift-1');
    expect(none.ok && none.value).toBeFalsy();
  });

  test('duplicate ids inside the cache list → refused offline', async () => {
    getDocFromCacheMock.mockResolvedValue(cacheSnap([REAL_81, { ...REAL_81 }]));
    const deps = offlineDeps();
    await expect(closeShift(makeShift(), 1338, '', deps)).rejects.toThrow(AMBIGUOUS_COPY);
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  test('valid mirrored local+cache entries still close offline with exact totals (one queued write)', async () => {
    getDocFromCacheMock.mockResolvedValue(cacheSnap([PAY_IN, REAL_81]));
    const result = await closeShift(makeShift({ cashEntries: [PAY_IN, REAL_81] }), 1469, '', offlineDeps());
    expect(result).toMatchObject({ status: 'closed', payInTotal: 50, payOutTotal: 81, variance: 0 });
    expect(updateDocMock).toHaveBeenCalledTimes(1);
    expect(updateDocMock.mock.calls[0]![1]).toMatchObject({ payInTotal: 50, payOutTotal: 81, closedOffline: true });
  });
});
