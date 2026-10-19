// @vitest-environment jsdom
// Return/Refund V1 — shift-close cash safety (D-RET-FIX-8 + final gate §2/§3).
//
// A cash Return posts a server-side `pay_out` onto `shifts/{id}.cashEntries`
// inside its own transaction. The ONLINE close must freeze payOut / expected
// cash / variance in ONE transaction over the same shift doc, so a Return that
// commits between the close's read and its commit forces a re-read (never a
// stale close). The OFFLINE close is refused while this device holds a guard
// for an unresolved / unsynced cash Return of the shift.
//
// The transaction runner below is a faithful model of Firestore's optimistic
// client transactions: reads record the doc version, writes are buffered, the
// commit applies them only if the version is unchanged (otherwise the update
// function re-runs on a fresh read, up to maxAttempts, then rejects).

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
  return {
    ...actual,
    doc: docMock,
    getDocFromCache: getDocFromCacheMock,
    updateDoc: updateDocMock,
  };
});

vi.mock('./deviceId', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./deviceId')>();
  return { ...actual, getDeviceId: vi.fn(() => 'DEV1') };
});

import {
  __resetInflightOnlineCloseForTests,
  CLOSE_SHIFT_FRESHNESS_MESSAGE,
  CLOSE_SHIFT_PENDING_WRITES_MESSAGE,
  CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE,
  CLOSE_SHIFT_TX_FAILED_MESSAGE,
  calcShiftDrawerExpected,
  closeShift,
  type CloseShiftDeps,
  type ShiftCloseTransactionRunner,
} from './shiftService';
import {
  clearCashReturnAttemptPending,
  hasShiftServerCashPending,
  markCashReturnAttemptPending,
  mergeCashEntries,
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
const REFUND2: ShiftCashEntry = { ...REFUND, id: 'rfd_ret2', amount: 40, note: 'คืนเงินสด RT-R-1-2', at: 3 };
const PAY_IN: ShiftCashEntry = { id: 'c1', type: 'pay_in', amount: 50, note: '', staffId: 'staff-1', staffName: 'ทดสอบ', at: 2 };

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

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

// ── Faithful optimistic-transaction model of the authoritative shift doc ──

type ServerShift = Record<string, unknown>;

/** Snapshot copy (a read never aliases the live doc); keeps the fake Timestamp object. */
function cloneDoc(d: ServerShift): ServerShift {
  return { ...d, cashEntries: Array.isArray(d.cashEntries) ? (d.cashEntries as ShiftCashEntry[]).map((e) => ({ ...e })) : d.cashEntries };
}
type Event = string;

function createShiftServer(initial: ServerShift | null, opts: { maxAttempts?: number } = {}) {
  const maxAttempts = opts.maxAttempts ?? 5;
  const state = { doc: initial ? cloneDoc(initial) : null, version: 1, commits: 0, conflicts: 0, attempts: 0 };
  const events: Event[] = [];
  let beforeCommit: ((attempt: number) => void | Promise<void>) | null = null;
  let afterCommit: (() => void) | null = null;

  /** The Return transaction's shift effect: requires an OPEN shift (submitSaleReturn.ts). */
  const returnCommits = (entry: ShiftCashEntry): 'committed' | 'shift_required' => {
    if (!state.doc || state.doc.status !== 'open') {
      events.push(`return ${entry.id} REJECTED shift_required`);
      return 'shift_required';
    }
    const entries = Array.isArray(state.doc.cashEntries) ? (state.doc.cashEntries as ShiftCashEntry[]) : [];
    state.doc = { ...state.doc, cashEntries: [...entries, entry] };
    state.version += 1;
    events.push(`return ${entry.id} COMMITTED (v${state.version})`);
    return 'committed';
  };

  const run: ShiftCloseTransactionRunner = async (_shiftId, fn) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      state.attempts += 1;
      // Holder objects: closure writes are invisible to TS control-flow narrowing.
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
          events.push(`close#${attempt} commit FAILED precondition (read v${txn.readVersion}, now v${state.version}) → retry`);
          continue;
        }
        const p = txn.buffered;
        state.doc = { ...state.doc!, ...p, closedAt: { toDate: () => new Date('2026-10-19T10:00:00Z') } };
        state.version += 1;
        state.commits += 1;
        events.push(`close#${attempt} COMMITTED payOut=${String(p.payOutTotal)} variance=${String(p.variance)}`);
        afterCommit?.();
      }
      return out;
    }
    events.push('close ABORTED (attempts exhausted)');
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
    onAfterCommit: (f: typeof afterCommit) => {
      afterCommit = f;
    },
  };
}

function openServerShift(cashEntries: ShiftCashEntry[] = []): ServerShift {
  return {
    id: 'shift-1',
    branchId: 'LDP-001',
    staffId: 'staff-1',
    staffName: 'ทดสอบ',
    status: 'open',
    startingCash: 500,
    cashEntries,
  };
}

const noPending = { has: () => false, clear: vi.fn() };

function onlineDeps(server: ReturnType<typeof createShiftServer>, extra: Partial<CloseShiftDeps> = {}): CloseShiftDeps {
  return {
    journal: createInMemoryShiftCloseIntentJournal(),
    isOnline: () => true,
    serverCashPending: noPending,
    runCloseTransaction: server.run,
    waitForQueuedWrites: async () => true,
    readConfirmation: server.readConfirmation,
    normalizeSyncState: server.normalizeSyncState,
    generateCloseCorrelationId: () => UUID_A,
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
  getDocFromCacheMock.mockResolvedValue(openCacheSnap([]));
  updateDocMock.mockReset();
  updateDocMock.mockResolvedValue(undefined);
  vi.stubGlobal('localStorage', memoryStorage());
  __resetInflightOnlineCloseForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('closeShift ONLINE — commit-boundary serialization against a cash Return', () => {
  test('Return commits AFTER the close read but BEFORE its commit → precondition conflict → re-read → exact totals', async () => {
    const server = createShiftServer(openServerShift([]));
    // Inject the Return exactly once, between close attempt #1's read and commit.
    server.onBeforeCommit((attempt) => {
      if (attempt === 1) expect(server.returnCommits(REFUND)).toBe('committed');
    });
    const stale = makeShift(); // mounted before the Return: no refund entry
    expect(calcShiftDrawerExpected(stale)).toBe(1500);
    const deps = onlineDeps(server);

    const result = await closeShift(stale, 1338, '', deps);

    expect(server.events).toEqual([
      'close#1 read (v1)',
      'return rfd_ret1 COMMITTED (v2)',
      'close#1 commit FAILED precondition (read v1, now v2) → retry',
      'close#2 read (v2)',
      'close#2 COMMITTED payOut=162 variance=0',
    ]);
    expect(server.state).toMatchObject({ commits: 1, conflicts: 1, attempts: 2 });
    // Persisted close == returned snapshot == journal (Z report source).
    expect(server.state.doc).toMatchObject({
      status: 'closed',
      payOutTotal: 162,
      payInTotal: 0,
      expectedCash: 1000,
      actualCashCount: 1338,
      variance: 0,
      closedOffline: true,
      syncState: 'pending',
      deviceId: 'DEV1',
      closeCorrelationId: UUID_A,
    });
    expect((server.state.doc!.cashEntries as ShiftCashEntry[]).map((e) => e.id)).toEqual(['rfd_ret1']); // no duplicate pay-out
    expect(result).toMatchObject({ status: 'closed', payOutTotal: 162, variance: 0, expectedCash: 1000 });
    expect(calcShiftDrawerExpected(result)).toBe(1338);
    const intent = await deps.journal!.getCloseIntent('shift-1');
    expect(intent.ok && intent.value).toMatchObject({ payOutTotal: 162, variance: 0, closeCorrelationId: UUID_A, status: 'local_closed_pending' });
    expect(updateDocMock).not.toHaveBeenCalled(); // never a separate read-then-updateDoc

    await expect(result.whenServerConfirmed).resolves.toMatchObject({ outcome: 'confirmed' });
    const after = await deps.journal!.getCloseIntent('shift-1');
    expect(after.ok && after.value?.status).toBe('synced');
    expect(server.state.doc!.syncState).toBe('synced');
  });

  test('Return AFTER the close commit is refused by the Return transaction (shift no longer open); totals unchanged', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const result = await closeShift(makeShift(), 1338, '', onlineDeps(server));
    expect(result.payOutTotal).toBe(162);
    expect(server.returnCommits(REFUND2)).toBe('shift_required');
    expect(server.state.doc).toMatchObject({ status: 'closed', payOutTotal: 162 });
    expect((server.state.doc!.cashEntries as ShiftCashEntry[]).map((e) => e.id)).toEqual(['rfd_ret1']);
  });

  test('conflicts on every attempt → aborted: NO close, NO journal intent, still retryable with fresh totals', async () => {
    const server = createShiftServer(openServerShift([]), { maxAttempts: 3 });
    let n = 0;
    server.onBeforeCommit(() => {
      n += 1;
      server.returnCommits({ ...REFUND, id: `rfd_loop${n}`, amount: 10 });
    });
    const deps = onlineDeps(server);
    await expect(closeShift(makeShift(), 1000, '', deps)).rejects.toThrow(CLOSE_SHIFT_TX_FAILED_MESSAGE);
    expect(server.state.doc!.status).toBe('open');
    expect(server.state.commits).toBe(0);
    const none = await deps.journal!.getCloseIntent('shift-1');
    expect(none.ok && none.value).toBeFalsy();

    // Retry once the concurrent writer stopped: one close, folding all 3 committed refunds.
    server.onBeforeCommit(null);
    const result = await closeShift(makeShift(), 1470, '', deps);
    expect(result).toMatchObject({ payOutTotal: 30, variance: 0 });
    expect(server.state.commits).toBe(1);
  });

  test('shift already closed on the server (another device / earlier close) → refused, nothing written', async () => {
    const server = createShiftServer({ ...openServerShift([]), status: 'closed', closeCorrelationId: UUID_B });
    const deps = onlineDeps(server);
    await expect(closeShift(makeShift(), 1, '', deps)).rejects.toThrow('กะนี้ถูกปิดไปแล้ว');
    expect(server.state.commits).toBe(0);
    const none = await deps.journal!.getCloseIntent('shift-1');
    expect(none.ok && none.value).toBeFalsy();
  });

  test('missing server doc / identity mismatch → refused before any write', async () => {
    const missing = createShiftServer(null);
    await expect(closeShift(makeShift(), 1, '', onlineDeps(missing))).rejects.toThrow(CLOSE_SHIFT_FRESHNESS_MESSAGE);
    const foreign = createShiftServer({ ...openServerShift([]), staffId: 'someone-else' });
    await expect(closeShift(makeShift(), 1, '', onlineDeps(foreign))).rejects.toThrow('ไม่สามารถยืนยันสถานะกะ');
    expect(missing.state.commits + foreign.state.commits).toBe(0);
  });

  test('server read error / timeout inside the transaction → fail closed, no write, no intent', async () => {
    const journal = createInMemoryShiftCloseIntentJournal();
    const failing: ShiftCloseTransactionRunner = async () => {
      throw Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' });
    };
    await expect(
      closeShift(makeShift(), 1338, '', { ...onlineDeps(createShiftServer(openServerShift())), journal, runCloseTransaction: failing }),
    ).rejects.toThrow(CLOSE_SHIFT_TX_FAILED_MESSAGE);
    const none = await journal.getCloseIntent('shift-1');
    expect(none.ok && none.value).toBeFalsy();
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  test('queued local writes not flushed in time → refused BEFORE the transaction (ordering preserved)', async () => {
    const server = createShiftServer(openServerShift([]));
    let runs = 0;
    const run: ShiftCloseTransactionRunner = (id, fn) => {
      runs += 1;
      return server.run(id, fn);
    };
    await expect(
      closeShift(makeShift(), 1500, '', { ...onlineDeps(server), runCloseTransaction: run, waitForQueuedWrites: async () => false }),
    ).rejects.toThrow(CLOSE_SHIFT_PENDING_WRITES_MESSAGE);
    expect(runs).toBe(0);
  });

  test('commit landed but the response was lost → same-runtime retry recognises ITS OWN close (no second close)', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    let lose = true;
    const lossy: ShiftCloseTransactionRunner = async (id, fn) => {
      const out = await server.run(id, fn);
      if (lose) {
        lose = false;
        throw Object.assign(new Error('deadline-exceeded'), { code: 'deadline-exceeded' });
      }
      return out;
    };
    const ids = [UUID_A, UUID_B];
    const deps = onlineDeps(server, { runCloseTransaction: lossy, generateCloseCorrelationId: () => ids.shift()! });
    await expect(closeShift(makeShift(), 1338, '', deps)).rejects.toThrow(CLOSE_SHIFT_TX_FAILED_MESSAGE);
    expect(server.state.commits).toBe(1);

    // The local cache still says open; the retry reuses UUID_A and sees its own commit.
    const result = await closeShift(makeShift(), 1338, '', deps);
    expect(server.state.commits).toBe(1);
    expect(result).toMatchObject({ status: 'closed', payOutTotal: 162, variance: 0 });
    const intent = await deps.journal!.getCloseIntent('shift-1');
    expect(intent.ok && intent.value?.closeCorrelationId).toBe(UUID_A);
    expect(ids).toEqual([UUID_B]); // no new correlation id was minted for the retry
  });

  test('late UI timeout: a second close while the first is still in flight → exactly one commit, both see the same close', async () => {
    const server = createShiftServer(openServerShift([]));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    let gated = false;
    server.onBeforeCommit(async () => {
      if (gated) return;
      gated = true;
      reached();
      await gate; // first attempt stalls between its read and its commit (UI times out meanwhile)
    });
    const ids = [UUID_A, UUID_B];
    const deps = onlineDeps(server, { generateCloseCorrelationId: () => ids.shift()! });
    const first = closeShift(makeShift(), 1500, '', deps);
    await atGate;
    const second = closeShift(makeShift(), 1500, '', deps); // cashier retries after the UI timeout
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(ids).toEqual([UUID_B]); // the retry reused the in-flight attempt's id
    expect(server.state.doc!.closeCorrelationId).toBe(UUID_A);
    expect(server.state.commits).toBe(1);
    expect(a).toMatchObject({ status: 'closed', variance: 0 });
    expect(b).toMatchObject({ status: 'closed', variance: 0 });
    const listed = await deps.journal!.listCloseIntents();
    expect(listed.ok && listed.value.filter((e) => 'shiftId' in e && e.shiftId === 'shift-1')).toHaveLength(1);
  });

  test('local (possibly unflushed) + cached + server entries are unioned by id — never double counted', async () => {
    getDocFromCacheMock.mockResolvedValue(openCacheSnap([PAY_IN]));
    const server = createShiftServer(openServerShift([PAY_IN, REFUND]));
    const result = await closeShift(makeShift({ cashEntries: [PAY_IN], payInTotal: 50 }), 1388, '', onlineDeps(server));
    expect(result).toMatchObject({ payInTotal: 50, payOutTotal: 162, variance: 0 });
    expect(server.state.doc).toMatchObject({ payInTotal: 50, payOutTotal: 162 });
    expect(mergeCashEntries([PAY_IN], [PAY_IN, REFUND], [REFUND]).map((e) => e.id)).toEqual(['c1', 'rfd_ret1']);
  });

  test('ordinary non-cash close: exact W3 write payload, unchanged business values', async () => {
    const server = createShiftServer(openServerShift([]));
    const result = await closeShift(makeShift(), 1490, 'n', onlineDeps(server));
    expect(result).toMatchObject({ status: 'closed', payInTotal: 0, payOutTotal: 0, variance: -10, expectedCash: 1000 });
    const written = Object.keys(server.state.doc!).filter((k) => !(k in openServerShift([]))).sort();
    expect(written).toEqual(
      [
        'actualCashCount', 'closeCorrelationId', 'closedAt', 'closedOffline', 'deviceId', 'expectedCard', 'expectedCash',
        'expectedCredit', 'expectedKbank', 'expectedQr', 'note', 'payInTotal', 'payOutTotal', 'syncState', 'totalBills', 'variance',
      ].sort(),
    );
  });

  test('journal unavailable AFTER the commit: the committed close is never reported as failed', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = createInMemoryShiftCloseIntentJournal();
    const broken = { ...journal, upsertCloseIntent: async () => ({ ok: false as const, code: 'unavailable' as const, message: 'x' }) };
    const result = await closeShift(makeShift(), 1338, '', { ...onlineDeps(server), journal: broken });
    expect(result).toMatchObject({ status: 'closed', payOutTotal: 162 });
    await expect(result.whenServerConfirmed).resolves.toMatchObject({ outcome: 'confirmed' });
  });

  test('a committed online close clears every cash guard of that shift (and only that shift)', async () => {
    expect(markCashReturnAttemptPending('shift-1', 'a1')).toBe(true);
    expect(markCashReturnAttemptPending('shift-1', 'a2', 'committed_unsynced')).toBe(true);
    expect(markCashReturnAttemptPending('shift-9', 'a3')).toBe(true);
    const server = createShiftServer(openServerShift([REFUND]));
    await closeShift(makeShift(), 1338, '', { ...onlineDeps(server), serverCashPending: undefined });
    expect(hasShiftServerCashPending('shift-1')).toBe(false);
    expect(hasShiftServerCashPending('shift-9')).toBe(true);
  });

  test('an online close is NOT blocked by an unresolved cash guard (its transaction is authoritative)', async () => {
    expect(markCashReturnAttemptPending('shift-1', 'a1')).toBe(true);
    const server = createShiftServer(openServerShift([REFUND]));
    const result = await closeShift(makeShift(), 1338, '', { ...onlineDeps(server), serverCashPending: undefined });
    expect(result.payOutTotal).toBe(162);
  });
});

describe('closeShift OFFLINE — unresolved / unsynced cash Return guard', () => {
  test('guard present → fail closed with Thai copy, no intent, no write', async () => {
    expect(markCashReturnAttemptPending('shift-1', 'att-1')).toBe(true);
    const journal = createInMemoryShiftCloseIntentJournal();
    await expect(closeShift(makeShift(), 1338, '', { journal, isOnline: () => false })).rejects.toThrow(
      CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE,
    );
    expect(CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE).toContain('ปิดกะแบบออฟไลน์ไม่ได้');
    expect(updateDocMock).not.toHaveBeenCalled();
    const none = await journal.getCloseIntent('shift-1');
    expect(none.ok && none.value).toBeFalsy();
  });

  test('guard of ANOTHER shift does not block; no guard keeps the existing cache-only close', async () => {
    expect(markCashReturnAttemptPending('shift-OTHER', 'att-1')).toBe(true);
    getDocFromCacheMock.mockResolvedValue(openCacheSnap([REFUND]));
    const result = await closeShift(makeShift(), 1338, '', { journal: createInMemoryShiftCloseIntentJournal(), isOnline: () => false });
    expect(result).toMatchObject({ payOutTotal: 162, variance: 0, status: 'closed' });
    expect(updateDocMock).toHaveBeenCalledTimes(1);
    expect(updateDocMock.mock.calls[0]![1]).toMatchObject({ payOutTotal: 162, closedOffline: true, syncState: 'pending' });
  });

  test('guard released (definitive not-committed) → offline close allowed again', async () => {
    expect(markCashReturnAttemptPending('shift-1', 'att-1')).toBe(true);
    clearCashReturnAttemptPending('shift-1', 'att-1');
    const result = await closeShift(makeShift(), 1500, '', { journal: createInMemoryShiftCloseIntentJournal(), isOnline: () => false });
    expect(result.status).toBe('closed');
  });

  test('unreadable guard store fails closed', async () => {
    vi.stubGlobal('localStorage', {
      get length(): number {
        throw new Error('SecurityError');
      },
      key: () => null,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    } as unknown as Storage);
    await expect(
      closeShift(makeShift(), 1500, '', { journal: createInMemoryShiftCloseIntentJournal(), isOnline: () => false }),
    ).rejects.toThrow(CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE);
  });
});
