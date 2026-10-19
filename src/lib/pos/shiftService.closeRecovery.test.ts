// @vitest-environment jsdom
// Return/Refund V1 — recovery gate B2: durable two-stage ONLINE shift close.
//
//   prepared  → written + verified BEFORE the close transaction (no totals, no claim)
//   finalized → after the W3 commit: journal entry from the COMMITTED values,
//               attempt consumed in the same store transaction
//   recovered → boot/reconnect sweep (or a retry) rebuilds the entry from the
//               authoritative closed doc carrying THIS correlation id
//
// The journal is the REAL IndexedDB-backed store over `fake-indexeddb`: a
// "restart" is a brand-new journal instance over the same persisted database,
// and a "crash" is a close whose promise never proceeds past the commit. The
// shift doc is the same faithful optimistic-transaction model used by
// shiftService.closeFreshness.test.ts (the real-emulator interleaving proof
// lives in rules-tests/shift-close-transaction.spec.ts and is unchanged).

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Shift, ShiftCashEntry } from '../types';
import {
  SHIFT_CLOSE_INTENT_DB_NAME,
  createInMemoryShiftCloseIntentStore,
  createShiftCloseIntentJournal,
  type ShiftCloseIntentJournal,
} from './offline/shiftCloseIntentStore';
import {
  LEGACY_NORMALIZATION_CHECKS_PER_SWEEP,
  recoverOnlineCloseAttempts,
  runShiftCloseReconciliationSweep,
  type ShiftCloseConfirmationReader,
} from './offline/shiftCloseReconciler';

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

import {
  CLOSE_SHIFT_ONLINE_ATTEMPT_UNRESOLVED_MESSAGE,
  CLOSE_SHIFT_ONLINE_STORE_UNAVAILABLE_MESSAGE,
  CLOSE_SHIFT_TX_FAILED_MESSAGE,
  closeShift,
  type CloseShiftDeps,
  type ShiftCloseTransactionRunner,
} from './shiftService';

const REFUND: ShiftCashEntry = {
  id: 'rfd_ret1',
  type: 'pay_out',
  amount: 162,
  note: 'คืนเงินสด RT-R-1-1',
  staffId: 'staff-1',
  staffName: 'ทดสอบ',
  at: 1,
};
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

// ── Authoritative shift doc: optimistic transaction model ─────────────────

type ServerShift = Record<string, unknown>;
const CLOSED_AT = new Date('2026-10-19T10:00:00Z');

function createShiftServer(initial: ServerShift) {
  const state = {
    doc: { ...initial } as ServerShift,
    version: 1,
    commits: 0,
    attempts: 0,
    /** Successful W4 (`syncState: 'synced'`) writes. */
    normalizations: 0,
    /** Every W4 attempt, failed or not. */
    normalizeAttempts: 0,
    /** The next N W4 attempts fail (transient unavailable). */
    normalizeFailuresLeft: 0,
  };
  let beforeCommit: ((attempt: number) => void | Promise<void>) | null = null;
  /** After a commit landed: `hang` = the client never sees the response (crash / frozen), `lose` = rejects. */
  let afterCommit: 'resolve' | 'hang' | 'lose' = 'resolve';

  const run: ShiftCloseTransactionRunner = async (_shiftId, fn) => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      state.attempts += 1;
      const txn: { readVersion: number | null; buffered: Record<string, unknown> | null } = { readVersion: null, buffered: null };
      const out = await fn({
        get: async () => {
          txn.readVersion = state.version;
          return { exists: true, data: { ...state.doc, cashEntries: [...((state.doc.cashEntries as ShiftCashEntry[]) ?? [])] } };
        },
        update: (payload) => {
          txn.buffered = payload;
        },
      });
      if (txn.buffered) {
        await beforeCommit?.(attempt);
        if (txn.readVersion !== state.version) continue;
        state.doc = { ...state.doc, ...txn.buffered, closedAt: { toDate: () => CLOSED_AT } };
        state.version += 1;
        state.commits += 1;
        if (afterCommit === 'hang') return new Promise<never>(() => undefined);
        if (afterCommit === 'lose') throw Object.assign(new Error('deadline-exceeded'), { code: 'deadline-exceeded' });
      }
      return out;
    }
    throw Object.assign(new Error('Transaction failed all retries'), { code: 'aborted' });
  };

  const readConfirmation: ShiftCloseConfirmationReader = async () => ({
    ok: true,
    doc: { exists: true, ...state.doc } as never,
  });
  const normalizeSyncState = async () => {
    state.normalizeAttempts += 1;
    if (state.normalizeFailuresLeft > 0) {
      state.normalizeFailuresLeft -= 1;
      throw Object.assign(new Error('W4 unavailable'), { code: 'unavailable' });
    }
    state.normalizations += 1;
    state.doc = { ...state.doc, syncState: 'synced' };
  };
  /** Another device / operation closes the shift with its own correlation id. */
  const closeElsewhere = (closeCorrelationId: string) => {
    state.doc = { ...state.doc, status: 'closed', closeCorrelationId, deviceId: 'DEV2', closedAt: { toDate: () => CLOSED_AT } };
    state.version += 1;
  };
  const returnCommits = (entry: ShiftCashEntry) => {
    if (state.doc.status !== 'open') return 'shift_required' as const;
    state.doc = { ...state.doc, cashEntries: [...((state.doc.cashEntries as ShiftCashEntry[]) ?? []), entry] };
    state.version += 1;
    return 'committed' as const;
  };

  return {
    state,
    run,
    readConfirmation,
    normalizeSyncState,
    closeElsewhere,
    returnCommits,
    onBeforeCommit: (f: typeof beforeCommit) => {
      beforeCommit = f;
    },
    setAfterCommit: (m: typeof afterCommit) => {
      afterCommit = m;
    },
  };
}

function openServerShift(cashEntries: ShiftCashEntry[] = []): ServerShift {
  return { id: 'shift-1', branchId: 'LDP-001', staffId: 'staff-1', staffName: 'ทดสอบ', status: 'open', startingCash: 500, cashEntries };
}

/** A new process: fresh journal object over the SAME persisted IndexedDB. */
function bootJournal(ids: string[] = [UUID_A]): ShiftCloseIntentJournal {
  return createShiftCloseIntentJournal({ generateCloseCorrelationId: () => ids.shift() ?? UUID_B });
}

function deps(server: ReturnType<typeof createShiftServer>, journal: ShiftCloseIntentJournal, extra: Partial<CloseShiftDeps> = {}): CloseShiftDeps {
  return {
    journal,
    isOnline: () => true,
    serverCashPending: { has: () => false, clear: vi.fn() },
    runCloseTransaction: server.run,
    waitForQueuedWrites: async () => true,
    readConfirmation: server.readConfirmation,
    normalizeSyncState: server.normalizeSyncState,
    ...extra,
  };
}

function sweep(server: ReturnType<typeof createShiftServer>, journal: ShiftCloseIntentJournal) {
  return runShiftCloseReconciliationSweep({
    journal,
    readConfirmation: server.readConfirmation,
    normalizeSyncState: server.normalizeSyncState,
    deviceId: 'DEV1',
  });
}

async function attemptsOf(journal: ShiftCloseIntentJournal) {
  const listed = await journal.listOnlineCloseAttempts();
  if (!listed.ok) throw new Error(`listOnlineCloseAttempts ${listed.code}`);
  return listed.value;
}

async function entryOf(journal: ShiftCloseIntentJournal) {
  const got = await journal.getCloseIntent('shift-1');
  if (!got.ok) throw new Error(`getCloseIntent ${got.code}`);
  return got.value;
}

function deleteDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(SHIFT_CLOSE_INTENT_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await deleteDb();
  getDocFromCacheMock.mockReset();
  getDocFromCacheMock.mockResolvedValue({ exists: () => true, data: () => ({ status: 'open', cashEntries: [] }) });
  updateDocMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('B2 stage 1 — durable attempt BEFORE any server write', () => {
  test('durable store unavailable → refused, ZERO transaction attempts / server writes', async () => {
    const server = createShiftServer(openServerShift());
    const journal = bootJournal();
    const broken: ShiftCloseIntentJournal = {
      ...journal,
      prepareOnlineCloseAttempt: async () => ({ ok: false, code: 'unavailable', message: 'IndexedDB unavailable' }),
    };
    await expect(closeShift(makeShift(), 1500, '', deps(server, broken))).rejects.toThrow(CLOSE_SHIFT_ONLINE_STORE_UNAVAILABLE_MESSAGE);
    expect(server.state).toMatchObject({ attempts: 0, commits: 0 });
    expect(server.state.doc.status).toBe('open');
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  test('store throws / quota / read-back mismatch → refused before the transaction', async () => {
    const server = createShiftServer(openServerShift());
    const journal = bootJournal();
    const throwing: ShiftCloseIntentJournal = {
      ...journal,
      prepareOnlineCloseAttempt: async () => {
        throw new Error('boom');
      },
    };
    await expect(closeShift(makeShift(), 1500, '', deps(server, throwing))).rejects.toThrow(CLOSE_SHIFT_ONLINE_STORE_UNAVAILABLE_MESSAGE);
    const quota: ShiftCloseIntentJournal = {
      ...journal,
      prepareOnlineCloseAttempt: async () => ({ ok: false, code: 'quota', message: 'QuotaExceededError' }),
    };
    await expect(closeShift(makeShift(), 1500, '', deps(server, quota))).rejects.toThrow(CLOSE_SHIFT_ONLINE_STORE_UNAVAILABLE_MESSAGE);
    // No secure correlation id available → the store refuses to prepare (a commit could never be recognised).
    const noId = createShiftCloseIntentJournal({ generateCloseCorrelationId: () => null });
    await expect(closeShift(makeShift(), 1500, '', deps(server, noId))).rejects.toThrow(CLOSE_SHIFT_ONLINE_STORE_UNAVAILABLE_MESSAGE);
    expect(server.state).toMatchObject({ attempts: 0, commits: 0 });
  });

  test('the prepared attempt is NOT a close claim: no close-intent, not listed, no totals', async () => {
    const journal = bootJournal();
    const p = await journal.prepareOnlineCloseAttempt({ shiftId: 'shift-1', branchId: 'LDP-001', staffId: 'staff-1', staffName: 'ทดสอบ', deviceId: 'DEV1' });
    expect(p.ok && p.value.kind).toBe('prepared');
    expect(await entryOf(journal)).toBeUndefined();
    const listed = await journal.listCloseIntents();
    expect(listed.ok && listed.value).toEqual([]);
    const [attempt] = await attemptsOf(journal);
    expect(Object.keys(attempt!).sort()).toEqual(
      ['branchId', 'closeCorrelationId', 'deviceId', 'kind', 'preparedAtLocal', 'shiftId', 'staffId', 'staffName', 'version'].sort(),
    );
  });
});

describe('B2 — happy path and Return interleaving keep one journal entry', () => {
  test('Return commits between close read and commit → conflict, ONE re-fold, attempt consumed, entry = committed values', async () => {
    const server = createShiftServer(openServerShift());
    server.onBeforeCommit((attempt) => {
      if (attempt === 1) server.returnCommits(REFUND);
    });
    const journal = bootJournal();
    const result = await closeShift(makeShift(), 1338, '', deps(server, journal));
    expect(server.state).toMatchObject({ commits: 1, attempts: 2 });
    expect(result).toMatchObject({ payOutTotal: 162, variance: 0 });
    expect(await attemptsOf(journal)).toEqual([]);
    expect(await entryOf(journal)).toMatchObject({ payOutTotal: 162, variance: 0, closeCorrelationId: UUID_A });
    await expect(result.whenServerConfirmed).resolves.toMatchObject({ outcome: 'confirmed' });
    expect(await entryOf(journal)).toMatchObject({ status: 'synced' });
    expect(server.state).toMatchObject({ normalizations: 1 });
    expect(server.state.doc.syncState).toBe('synced');
  });
});

describe('B2 — commit / crash gap', () => {
  test('commit lands, process dies BEFORE finalize → restart sweep recovers the SAME correlation, server totals, journal and Variant C — exactly once', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    server.setAfterCommit('hang'); // the process never observes the commit response
    const first = bootJournal();
    void closeShift(makeShift(), 1338, 'นับแล้ว', deps(server, first));
    await vi.waitFor(() => expect(server.state.commits).toBe(1));
    expect(server.state.doc).toMatchObject({ status: 'closed', syncState: 'pending', closeCorrelationId: UUID_A, payOutTotal: 162 });
    expect(await entryOf(first)).toBeUndefined(); // OLD bug: nothing durable would exist here
    expect(await attemptsOf(first)).toHaveLength(1);

    // ── restart ──
    const rebooted = bootJournal([UUID_B]);
    const results = await sweep(server, rebooted);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ shiftId: 'shift-1', outcome: 'confirmed' });
    const entry = await entryOf(rebooted);
    expect(entry).toMatchObject({
      closeCorrelationId: UUID_A,
      status: 'synced',
      payOutTotal: 162,
      expectedCash: 1000,
      actualCashCount: 1338,
      variance: 0,
      note: 'นับแล้ว',
      totalBills: 3,
      deviceId: 'DEV1',
    });
    expect(await attemptsOf(rebooted)).toEqual([]);
    expect(server.state.doc.syncState).toBe('synced');
    expect(server.state.normalizations).toBe(1);

    // A second boot / reconnect sweep is a no-op: no second Variant C, no duplicate entry.
    const again = await sweep(server, bootJournal());
    expect(again).toEqual([]);
    expect(server.state.normalizations).toBe(1);
    expect(server.state.commits).toBe(1);
  });

  test('finalize THROWS after the commit → close reported closed (never failed); attempt survives; restart sweep recovers', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    const broken: ShiftCloseIntentJournal = {
      ...journal,
      finalizeOnlineClose: async () => {
        throw new Error('disk I/O error');
      },
    };
    const result = await closeShift(makeShift(), 1338, '', deps(server, broken));
    expect(result).toMatchObject({ status: 'closed', payOutTotal: 162, variance: 0 });
    await expect(result.whenServerConfirmed).resolves.toMatchObject({ outcome: 'confirmed' });
    expect(await entryOf(journal)).toBeUndefined();
    expect(await attemptsOf(journal)).toMatchObject([{ shiftId: 'shift-1', closeCorrelationId: UUID_A }]);
    expect(server.state.doc.syncState).toBe('pending');

    const rebooted = bootJournal();
    await sweep(server, rebooted);
    expect(await entryOf(rebooted)).toMatchObject({ closeCorrelationId: UUID_A, status: 'synced', payOutTotal: 162 });
    expect(await attemptsOf(rebooted)).toEqual([]);
    expect(server.state.doc.syncState).toBe('synced');
    expect(server.state.commits).toBe(1);
  });

  test('finalize fails ONCE (transient) → same-runtime recovery from the server doc finalizes + reconciles', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    let failures = 1;
    const flaky: ShiftCloseIntentJournal = {
      ...journal,
      finalizeOnlineClose: (...args) => {
        if (failures-- > 0) return Promise.resolve({ ok: false, code: 'tx_failed', message: 'transient' });
        return journal.finalizeOnlineClose(...args);
      },
    };
    const result = await closeShift(makeShift(), 1338, '', deps(server, flaky));
    await expect(result.whenServerConfirmed).resolves.toMatchObject({ outcome: 'confirmed' });
    expect(await entryOf(journal)).toMatchObject({ closeCorrelationId: UUID_A, status: 'synced', payOutTotal: 162 });
    expect(await attemptsOf(journal)).toEqual([]);
    expect(server.state.normalizations).toBe(1);
  });

  test('transaction NEVER commits → prepared entry asserts no close, no Z source, kept for retry; retry reuses its id', async () => {
    const server = createShiftServer(openServerShift());
    const failing: ShiftCloseTransactionRunner = async () => {
      throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
    };
    const journal = bootJournal([UUID_A, UUID_B]);
    await expect(closeShift(makeShift(), 1500, '', deps(server, journal, { runCloseTransaction: failing }))).rejects.toThrow(
      CLOSE_SHIFT_TX_FAILED_MESSAGE,
    );
    expect(await entryOf(journal)).toBeUndefined();
    const listed = await journal.listCloseIntents();
    expect(listed.ok && listed.value).toEqual([]);

    // Restart: the sweep finds the doc OPEN → kept, nothing journaled, no Variant C.
    const rebooted = bootJournal([UUID_B]);
    expect(await recoverOnlineCloseAttempts({ journal: rebooted, readConfirmation: server.readConfirmation, deviceId: 'DEV1' })).toEqual([
      { shiftId: 'shift-1', outcome: 'not_closed' },
    ]);
    expect(await sweep(server, rebooted)).toEqual([]);
    expect(await entryOf(rebooted)).toBeUndefined();
    expect(server.state.normalizations).toBe(0);

    // The cashier retries after the restart: same correlation id, one commit.
    const result = await closeShift(makeShift(), 1500, '', deps(server, rebooted));
    expect(result.status).toBe('closed');
    expect(server.state.doc.closeCorrelationId).toBe(UUID_A);
    expect(await attemptsOf(rebooted)).toEqual([]);
  });

  test('lost response + 10 s UI timeout + LATE commit after a restart → recognised as this device’s own close', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.onBeforeCommit(() => gate); // commit RPC stalls in flight
    server.setAfterCommit('hang');
    const first = bootJournal();
    const ui = Promise.race([
      closeShift(makeShift(), 1338, '', deps(server, first)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('UI timeout')), 20)),
    ]);
    await expect(ui).rejects.toThrow('UI timeout');
    expect(server.state.commits).toBe(0);

    // ── restart while the commit is still in flight ──
    const rebooted = bootJournal([UUID_B]);
    expect(await sweep(server, rebooted)).toEqual([]);
    expect(await attemptsOf(rebooted)).toHaveLength(1); // kept: outcome still unknown

    release(); // the late commit lands
    await vi.waitFor(() => expect(server.state.commits).toBe(1));
    expect(server.state.doc.closeCorrelationId).toBe(UUID_A);

    // The cashier retries: the cache now shows the shift closed with UUID_A →
    // this device's own close; its Z comes from the committed values, no 2nd write.
    getDocFromCacheMock.mockResolvedValue({
      exists: () => true,
      data: () => ({ status: 'closed', closeCorrelationId: UUID_A, cashEntries: [REFUND] }),
    });
    const retry = await closeShift(makeShift(), 9999, 'ignored', deps(server, rebooted));
    expect(retry).toMatchObject({ status: 'closed', payOutTotal: 162, actualCashCount: 1338, variance: 0 });
    await expect(retry.whenServerConfirmed).resolves.toMatchObject({ outcome: 'confirmed' });
    expect(server.state.commits).toBe(1);
    expect(await entryOf(rebooted)).toMatchObject({ closeCorrelationId: UUID_A, status: 'synced' });
    expect(await attemptsOf(rebooted)).toEqual([]);

    // A later sweep changes nothing.
    await sweep(server, bootJournal());
    expect(server.state.normalizations).toBe(1);
  });

  test('an OFFLINE close is refused while an online close attempt of the shift is unresolved; allowed again once resolved', async () => {
    const server = createShiftServer(openServerShift());
    const failing: ShiftCloseTransactionRunner = async () => {
      throw new Error('network');
    };
    const journal = bootJournal();
    await expect(closeShift(makeShift(), 1500, '', deps(server, journal, { runCloseTransaction: failing }))).rejects.toThrow(
      CLOSE_SHIFT_TX_FAILED_MESSAGE,
    );
    // Connectivity drops: the earlier attempt may have committed — no second (offline) close over it.
    await expect(closeShift(makeShift(), 1500, '', deps(server, journal, { isOnline: () => false }))).rejects.toThrow(
      CLOSE_SHIFT_ONLINE_ATTEMPT_UNRESOLVED_MESSAGE,
    );
    expect(updateDocMock).not.toHaveBeenCalled();
    expect(await entryOf(journal)).toBeUndefined();
    // Another shift of this device is unaffected.
    const other = await closeShift(makeShift({ id: 'shift-2' }), 1500, '', deps(server, journal, { isOnline: () => false }));
    expect(other.status).toBe('closed');
    // Once resolved (here: superseded by another device's close) nothing blocks.
    server.closeElsewhere(UUID_B);
    await recoverOnlineCloseAttempts({ journal, readConfirmation: server.readConfirmation, deviceId: 'DEV1' });
    expect(await attemptsOf(journal)).toEqual([]);
  });

  test('retry on a shift closed by ANOTHER correlation is still refused (never adopted as own)', async () => {
    const server = createShiftServer(openServerShift());
    server.closeElsewhere(UUID_B);
    getDocFromCacheMock.mockResolvedValue({ exists: () => true, data: () => ({ status: 'closed', closeCorrelationId: UUID_B }) });
    await expect(closeShift(makeShift(), 1, '', deps(server, bootJournal()))).rejects.toThrow('กะนี้ถูกปิดไปแล้ว');
  });
});

describe('B2 — concurrency and lifecycle', () => {
  test('two windows (two journal instances, one database) close at once → ONE commit, ONE entry, both show the same Z', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = false;
    server.onBeforeCommit(async () => {
      if (gated) return;
      gated = true;
      await gate;
    });
    const tabA = bootJournal([UUID_A]);
    const tabB = bootJournal([UUID_B]);
    const a = closeShift(makeShift(), 1338, '', deps(server, tabA));
    await vi.waitFor(() => expect(gated).toBe(true)); // A read v1 and stalls before its commit
    const b = closeShift(makeShift(), 1338, '', deps(server, tabB));
    // B reuses A's durable attempt id and its transaction commits FIRST.
    await vi.waitFor(() => expect(server.state.commits).toBe(1));
    release(); // A's v1 commit now fails its precondition → re-read → sees its own id → no 2nd write
    const [ra, rb] = await Promise.all([a, b]);
    expect(server.state.commits).toBe(1);
    expect(server.state.doc.closeCorrelationId).toBe(UUID_A);
    expect(ra).toMatchObject({ payOutTotal: 162, variance: 0 });
    expect(rb).toMatchObject({ payOutTotal: 162, variance: 0 });
    await Promise.all([ra.whenServerConfirmed, rb.whenServerConfirmed]);
    const listed = await tabA.listCloseIntents();
    expect(listed.ok && listed.value.filter((e) => 'shiftId' in e && e.shiftId === 'shift-1')).toHaveLength(1);
    expect(await attemptsOf(tabA)).toEqual([]);
  });

  test('a window FINALIZES this attempt between another window’s prepare write and its verification read → journaled (not a store failure)', async () => {
    const mem = createInMemoryShiftCloseIntentStore();
    const tabA = createShiftCloseIntentJournal({ store: mem, generateCloseCorrelationId: () => UUID_A });
    const identity = { shiftId: 'shift-1', branchId: 'LDP-001', staffId: 'staff-1', staffName: 'ทดสอบ', deviceId: 'DEV1' };
    expect((await tabA.prepareOnlineCloseAttempt(identity)).ok).toBe(true);
    const committedSnapshot = {
      ...identity,
      startingCash: 500,
      expectedCash: 1000,
      expectedQr: 0,
      expectedKbank: 0,
      expectedCard: 0,
      expectedCredit: 0,
      payInTotal: 0,
      payOutTotal: 162,
      totalBills: 3,
      actualCashCount: 1338,
      variance: 0,
      note: '',
    };
    let injected = false;
    const racing: typeof mem = {
      ...mem,
      transact: (stores, mode, fn) => {
        const p = mem.transact(stores, mode, fn);
        if (mode !== 'readwrite' || injected) return p;
        injected = true;
        // Exactly between B's prepare write and B's verification read.
        return p.then(async (r) => {
          expect((await tabA.finalizeOnlineClose(committedSnapshot, UUID_A)).ok).toBe(true);
          return r;
        });
      },
    };
    const tabB = createShiftCloseIntentJournal({ store: racing, generateCloseCorrelationId: () => UUID_B });
    const b = await tabB.prepareOnlineCloseAttempt(identity);
    expect(b).toMatchObject({ ok: true, value: { kind: 'journaled', entry: { closeCorrelationId: UUID_A, payOutTotal: 162 } } });
  });

  test('superseded: the doc is closed by another operation → attempt deleted, no entry, no Z', async () => {
    const server = createShiftServer(openServerShift());
    const failing: ShiftCloseTransactionRunner = async () => {
      throw new Error('network');
    };
    const journal = bootJournal();
    await expect(closeShift(makeShift(), 1, '', deps(server, journal, { runCloseTransaction: failing }))).rejects.toThrow();
    server.closeElsewhere(UUID_B);
    expect(await recoverOnlineCloseAttempts({ journal, readConfirmation: server.readConfirmation, deviceId: 'DEV1' })).toEqual([
      { shiftId: 'shift-1', outcome: 'superseded' },
    ]);
    expect(await attemptsOf(journal)).toEqual([]);
    expect(await entryOf(journal)).toBeUndefined();
  });

  test('in-transaction "closed by another id" refusal deletes the attempt; other refusals keep it', async () => {
    const server = createShiftServer(openServerShift());
    server.closeElsewhere(UUID_B);
    const journal = bootJournal();
    await expect(closeShift(makeShift(), 1, '', deps(server, journal))).rejects.toThrow('กะนี้ถูกปิดไปแล้ว');
    expect(await attemptsOf(journal)).toEqual([]);

    await deleteDb();
    const foreign = createShiftServer({ ...openServerShift(), staffId: 'someone-else' });
    const j2 = bootJournal();
    await expect(closeShift(makeShift(), 1, '', deps(foreign, j2))).rejects.toThrow('ไม่สามารถยืนยันสถานะกะ');
    expect(await attemptsOf(j2)).toHaveLength(1);
  });

  test('closed with OUR id but untrustworthy fields → manual attention, kept, never journaled from guesses', async () => {
    const server = createShiftServer(openServerShift());
    const failing: ShiftCloseTransactionRunner = async () => {
      throw new Error('network');
    };
    const journal = bootJournal();
    await expect(closeShift(makeShift(), 1, '', deps(server, journal, { runCloseTransaction: failing }))).rejects.toThrow();
    server.state.doc = { ...server.state.doc, status: 'closed', closeCorrelationId: UUID_A, deviceId: 'DEV1', closedAt: { toDate: () => CLOSED_AT } };
    expect(await recoverOnlineCloseAttempts({ journal, readConfirmation: server.readConfirmation, deviceId: 'DEV1' })).toEqual([
      { shiftId: 'shift-1', outcome: 'manual_attention' },
    ]);
    expect(await entryOf(journal)).toBeUndefined();
    expect(await attemptsOf(journal)).toHaveLength(1);
  });

  test('unreadable server → unreachable, kept; a malformed attempt fails the attempt list closed', async () => {
    const journal = bootJournal();
    await journal.prepareOnlineCloseAttempt({ shiftId: 'shift-1', branchId: 'LDP-001', staffId: 'staff-1', staffName: 'ทดสอบ', deviceId: 'DEV1' });
    expect(await recoverOnlineCloseAttempts({ journal, readConfirmation: async () => ({ ok: false }), deviceId: 'DEV1' })).toEqual([
      { shiftId: 'shift-1', outcome: 'unreachable' },
    ]);
    expect(await attemptsOf(journal)).toHaveLength(1);
    // An attempt of ANOTHER device is never resolved by this one.
    expect(await recoverOnlineCloseAttempts({ journal, readConfirmation: async () => ({ ok: false }), deviceId: 'DEV9' })).toEqual([]);
  });
});

// ── Codex 003 → packet 004 ────────────────────────────────────────────────
// Literal copy (not an import) so this file also runs against the pre-fix
// sources for the red/green proof.
const UNVERIFIED = 'ยังยืนยันยอดปิดกะนี้กับเซิร์ฟเวอร์ไม่ได้';

/** Commit an online close whose response is LOST (attempt kept, server closed with UUID_A). */
async function commitWithLostResponse(server: ReturnType<typeof createShiftServer>, journal: ShiftCloseIntentJournal) {
  server.setAfterCommit('lose');
  await expect(closeShift(makeShift(), 1338, 'นับแล้ว', deps(server, journal))).rejects.toThrow(CLOSE_SHIFT_TX_FAILED_MESSAGE);
  server.setAfterCommit('resolve');
  expect(server.state.commits).toBe(1);
  expect(server.state.doc).toMatchObject({ status: 'closed', closeCorrelationId: UUID_A, payOutTotal: 162, variance: 0 });
}

function without(d: ServerShift, key: string): ServerShift {
  const copy = { ...d };
  delete copy[key];
  return copy;
}

const MALFORMED_OWN_CLOSES: Array<[string, (d: ServerShift) => ServerShift]> = [
  ['payOutTotal missing', (d) => without(d, 'payOutTotal')],
  ['payOutTotal non-finite', (d) => ({ ...d, payOutTotal: Number.NaN })],
  ['payOutTotal malformed (string)', (d) => ({ ...d, payOutTotal: '162' })],
  ['actualCashCount missing', (d) => without(d, 'actualCashCount')],
  ['note missing', (d) => without(d, 'note')],
  ['closedAt unresolved', (d) => ({ ...d, closedAt: null })],
  ['wrong branch', (d) => ({ ...d, branchId: 'LDP-999' })],
  ['wrong staff', (d) => ({ ...d, staffId: 'someone-else' })],
  ['wrong device', (d) => ({ ...d, deviceId: 'DEV2' })],
  ['inconsistent variance', (d) => ({ ...d, variance: 5 })],
];

describe('B2.1 — own-correlation retry: Z / journal ONLY from a strictly parsed committed close', () => {
  test.each(MALFORMED_OWN_CLOSES)('same-runtime retry, server doc closed with OUR id but %s → refused: no Z, no journal, attempt kept, no second write', async (_label, corrupt) => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    await commitWithLostResponse(server, journal);
    server.state.doc = corrupt(server.state.doc);
    // The local cache still says "open": the retry's transaction reads the doc closed with its own id.
    await expect(closeShift(makeShift(), 1338, 'นับแล้ว', deps(server, journal))).rejects.toThrow(UNVERIFIED);
    expect(server.state.commits).toBe(1);
    expect(await entryOf(journal)).toBeUndefined();
    expect(await attemptsOf(journal)).toMatchObject([{ closeCorrelationId: UUID_A }]);
    expect(server.state.normalizeAttempts).toBe(0);
  });

  test('same-runtime retry, fully valid committed doc → Z and journal carry the CANONICAL server totals (never the local shift’s)', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    await commitWithLostResponse(server, journal);
    // The retrying POS still holds a stale local shift (no refund folded, other count/note typed).
    const result = await closeShift(makeShift({ payOutTotal: 0, expectedCash: 999 }), 1, 'อื่น', deps(server, journal));
    expect(result).toMatchObject({ status: 'closed', payOutTotal: 162, expectedCash: 1000, actualCashCount: 1338, variance: 0, note: 'นับแล้ว' });
    expect(await entryOf(journal)).toMatchObject({ closeCorrelationId: UUID_A, payOutTotal: 162, actualCashCount: 1338, note: 'นับแล้ว' });
    expect(server.state.commits).toBe(1);
  });

  test.each(MALFORMED_OWN_CLOSES)('post-timeout retry (cache shows closed with OUR id, attempt only) with %s → refused, no Z, attempt kept', async (_label, corrupt) => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    await commitWithLostResponse(server, journal);
    server.state.doc = corrupt(server.state.doc);
    getDocFromCacheMock.mockResolvedValue({ exists: () => true, data: () => ({ status: 'closed', closeCorrelationId: UUID_A, cashEntries: [REFUND] }) });
    await expect(closeShift(makeShift(), 1338, '', deps(server, journal))).rejects.toThrow(UNVERIFIED);
    expect(await entryOf(journal)).toBeUndefined();
    expect(await attemptsOf(journal)).toHaveLength(1);
  });

  test('post-timeout retry with an ALREADY finalized entry, server doc later found malformed → refused (no Z from the local entry alone)', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    await closeShift(makeShift(), 1338, 'นับแล้ว', deps(server, journal)); // finalized entry exists
    server.state.doc = { ...server.state.doc, payOutTotal: Number.NaN };
    getDocFromCacheMock.mockResolvedValue({ exists: () => true, data: () => ({ status: 'closed', closeCorrelationId: UUID_A, cashEntries: [REFUND] }) });
    await expect(closeShift(makeShift(), 1338, '', deps(server, journal))).rejects.toThrow(UNVERIFIED);
  });

  test('post-timeout retry, entry exists but server read UNREACHABLE → fail closed (no Z)', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    await closeShift(makeShift(), 1338, 'นับแล้ว', deps(server, journal));
    getDocFromCacheMock.mockResolvedValue({ exists: () => true, data: () => ({ status: 'closed', closeCorrelationId: UUID_A, cashEntries: [REFUND] }) });
    await expect(
      closeShift(makeShift(), 1338, '', deps(server, journal, { readConfirmation: async () => ({ ok: false }) })),
    ).rejects.toThrow(UNVERIFIED);
  });

  test('post-timeout retry, valid committed doc → canonical Z', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    await commitWithLostResponse(server, journal);
    getDocFromCacheMock.mockResolvedValue({ exists: () => true, data: () => ({ status: 'closed', closeCorrelationId: UUID_A, cashEntries: [REFUND] }) });
    const retry = await closeShift(makeShift({ payOutTotal: 0 }), 1, '', deps(server, journal));
    expect(retry).toMatchObject({ status: 'closed', payOutTotal: 162, actualCashCount: 1338, variance: 0, note: 'นับแล้ว' });
  });

  test.each(MALFORMED_OWN_CLOSES)('restart sweep with %s → manual attention / kept, no journal entry, no W4', async (label, corrupt) => {
    const server = createShiftServer(openServerShift([REFUND]));
    await commitWithLostResponse(server, bootJournal());
    server.state.doc = corrupt(server.state.doc);
    const rebooted = bootJournal([UUID_B]);
    const [r] = await recoverOnlineCloseAttempts({ journal: rebooted, readConfirmation: server.readConfirmation, deviceId: 'DEV1' });
    expect(r!.outcome).toBe(label === 'closedAt unresolved' ? 'unreachable' : 'manual_attention');
    expect(await sweep(server, rebooted)).toEqual([]);
    expect(await entryOf(rebooted)).toBeUndefined();
    expect(await attemptsOf(rebooted)).toHaveLength(1);
    expect(server.state.normalizeAttempts).toBe(0);
  });

  test('own-correlation retry where the doc is closed by ANOTHER correlation → refused as already closed, attempt superseded', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    await commitWithLostResponse(server, journal);
    server.state.doc = { ...server.state.doc, closeCorrelationId: UUID_B };
    await expect(closeShift(makeShift(), 1338, '', deps(server, journal))).rejects.toThrow('กะนี้ถูกปิดไปแล้ว');
    expect(await entryOf(journal)).toBeUndefined();
    expect(await attemptsOf(journal)).toEqual([]);
  });
});

describe('B2.2 — Variant C (W4) normalization survives failure and restart', () => {
  test('W4 fails once after confirmation → journal records it OUTSTANDING → restart → sweep retries → normalized exactly once', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    server.state.normalizeFailuresLeft = 1;
    const first = bootJournal();
    const result = await closeShift(makeShift(), 1338, '', deps(server, first));
    await expect(result.whenServerConfirmed).resolves.toMatchObject({ outcome: 'confirmed' });
    expect(server.state).toMatchObject({ normalizeAttempts: 1, normalizations: 0 });
    expect(server.state.doc.syncState).toBe('pending');
    expect(await entryOf(first)).toMatchObject({ status: 'synced', syncStateNormalization: 'outstanding' });

    // ── restart on the same durable IndexedDB ──
    const rebooted = bootJournal([UUID_B]);
    await sweep(server, rebooted);
    expect(server.state).toMatchObject({ normalizeAttempts: 2, normalizations: 1 });
    expect(server.state.doc.syncState).toBe('synced');
    expect(await entryOf(rebooted)).toMatchObject({ status: 'synced', syncStateNormalization: 'done', closeCorrelationId: UUID_A });

    await sweep(server, bootJournal());
    expect(server.state).toMatchObject({ normalizeAttempts: 2, normalizations: 1 }); // idempotent
  });

  test('repeated W4 failures across restarts → one attempt per sweep, no duplicate write once it succeeds', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    server.state.normalizeFailuresLeft = 3;
    const result = await closeShift(makeShift(), 1338, '', deps(server, bootJournal()));
    await result.whenServerConfirmed;
    await sweep(server, bootJournal()); // fails (2)
    await sweep(server, bootJournal()); // fails (3)
    expect(await entryOf(bootJournal())).toMatchObject({ syncStateNormalization: 'outstanding' });
    expect(server.state.doc.syncState).toBe('pending');
    await sweep(server, bootJournal()); // succeeds
    await sweep(server, bootJournal()); // nothing owed
    expect(server.state).toMatchObject({ normalizeAttempts: 4, normalizations: 1 });
    expect(await entryOf(bootJournal())).toMatchObject({ syncStateNormalization: 'done' });
  });

  test('same totals but a DIFFERENT correlation id on the server → never normalized (pending entry: identity mismatch; outstanding entry: mismatch)', async () => {
    // (a) outstanding W4, then the doc turns out to carry another close's id.
    const server = createShiftServer(openServerShift([REFUND]));
    server.state.normalizeFailuresLeft = 1;
    const r = await closeShift(makeShift(), 1338, '', deps(server, bootJournal()));
    await r.whenServerConfirmed;
    server.state.doc = { ...server.state.doc, closeCorrelationId: UUID_B };
    await sweep(server, bootJournal());
    expect(server.state).toMatchObject({ normalizeAttempts: 1, normalizations: 0 });
    expect(server.state.doc.syncState).toBe('pending');
    expect(await entryOf(bootJournal())).toMatchObject({ status: 'synced', syncStateNormalization: 'mismatch' });
    await sweep(server, bootJournal());
    expect(server.state.normalizeAttempts).toBe(1); // terminal: not retried

    // (b) a still-pending entry is never confirmed by equal totals of another close.
    await deleteDb();
    const other = createShiftServer(openServerShift([REFUND]));
    const j = bootJournal();
    const res = await closeShift(makeShift(), 1338, '', deps(other, j, { readConfirmation: async () => ({ ok: false }) }));
    await res.whenServerConfirmed;
    expect(await entryOf(j)).toMatchObject({ status: 'local_closed_pending', closeCorrelationId: UUID_A });
    other.state.doc = { ...other.state.doc, closeCorrelationId: UUID_B };
    const [rec] = await sweep(other, j);
    expect(rec!.outcome).toBe('identity_mismatch');
    expect(other.state.normalizeAttempts).toBe(0);
  });

  test('already normalized elsewhere (doc reads synced) → recorded done, no W4 write', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    server.state.normalizeFailuresLeft = 1;
    const r = await closeShift(makeShift(), 1338, '', deps(server, bootJournal()));
    await r.whenServerConfirmed;
    server.state.doc = { ...server.state.doc, syncState: 'synced' };
    await sweep(server, bootJournal());
    expect(server.state.normalizeAttempts).toBe(1);
    expect(await entryOf(bootJournal())).toMatchObject({ syncStateNormalization: 'done' });
  });

  test('crash between the successful W4 and the local "done" record → next sweep reads synced and records done WITHOUT a second W4', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    const crashing: ShiftCloseIntentJournal = {
      ...journal,
      setSyncStateNormalization: async () => {
        throw new Error('process died');
      },
    };
    const r = await closeShift(makeShift(), 1338, '', deps(server, crashing));
    await r.whenServerConfirmed;
    expect(server.state).toMatchObject({ normalizeAttempts: 1, normalizations: 1 });
    expect(await entryOf(journal)).toMatchObject({ syncStateNormalization: 'outstanding' });
    await sweep(server, bootJournal());
    expect(server.state).toMatchObject({ normalizeAttempts: 1, normalizations: 1 });
    expect(await entryOf(bootJournal())).toMatchObject({ syncStateNormalization: 'done' });
  });

  test('commit → crash before finalize → restart recovery whose W4 fails → later sweep completes it', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    server.setAfterCommit('hang');
    void closeShift(makeShift(), 1338, '', deps(server, bootJournal()));
    await vi.waitFor(() => expect(server.state.commits).toBe(1));
    server.state.normalizeFailuresLeft = 1;
    await sweep(server, bootJournal()); // recovers the attempt, confirms, W4 fails
    expect(await entryOf(bootJournal())).toMatchObject({ status: 'synced', syncStateNormalization: 'outstanding' });
    expect(server.state.doc.syncState).toBe('pending');
    await sweep(server, bootJournal());
    expect(server.state.doc.syncState).toBe('synced');
    expect(server.state.normalizations).toBe(1);
  });

  test('legacy synced entry (pre-B2.2, no normalization field) whose doc is still pending → found by the bounded one-time check and normalized', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const legacy = bootJournal();
    const r = await closeShift(makeShift(), 1338, '', deps(server, legacy, { readConfirmation: async () => ({ ok: false }) }));
    await r.whenServerConfirmed;
    // Emulate the pre-B2.2 reconciler: synced written WITHOUT any normalization field, W4 failed.
    await legacy.markSynced('shift-1');
    const stored = await entryOf(legacy);
    expect(stored).toMatchObject({ status: 'synced' });
    expect(stored && 'syncStateNormalization' in stored).toBe(false);
    expect(server.state.doc.syncState).toBe('pending');
    await sweep(server, bootJournal());
    expect(server.state).toMatchObject({ normalizations: 1 });
    expect(await entryOf(bootJournal())).toMatchObject({ syncStateNormalization: 'done' });
  });
});

describe('B2.2 — bounds and schema compatibility', () => {
  const snapshotFor = (shiftId: string) => ({
    shiftId, branchId: 'LDP-001', staffId: 'staff-1', staffName: 'ทดสอบ', startingCash: 500, expectedCash: 1000, expectedQr: 0,
    expectedKbank: 0, expectedCard: 0, expectedCredit: 0, payInTotal: 0, payOutTotal: 0, totalBills: 3, actualCashCount: 1500,
    variance: 0, note: '', deviceId: 'DEV1',
  });

  test(`legacy one-time check is bounded: at most ${LEGACY_NORMALIZATION_CHECKS_PER_SWEEP} server reads per sweep`, async () => {
    const journal = bootJournal(Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`));
    for (let i = 0; i < 12; i += 1) {
      await journal.upsertCloseIntent(snapshotFor(`legacy-${i}`));
      await journal.markSynced(`legacy-${i}`); // pre-B2.2 shape: no normalization field
    }
    const reads: string[] = [];
    await runShiftCloseReconciliationSweep({
      journal,
      readConfirmation: async (id) => {
        reads.push(id);
        return { ok: false };
      },
      normalizeSyncState: async () => undefined,
      deviceId: 'DEV1',
    });
    expect(reads).toHaveLength(LEGACY_NORMALIZATION_CHECKS_PER_SWEEP);
  });

  test('an entry with an UNKNOWN normalization value fails the journal read closed (never silently skipped)', async () => {
    const mem = createInMemoryShiftCloseIntentStore();
    const journal = createShiftCloseIntentJournal({ store: mem, generateCloseCorrelationId: () => UUID_A });
    const created = await journal.upsertCloseIntent(snapshotFor('shift-x'));
    if (!created.ok) throw new Error('setup');
    await mem.transact(['shiftCloseIntents'], 'readwrite', (txn) =>
      txn.put('shiftCloseIntents', 'shift-x', { ...created.value, status: 'synced', syncStateNormalization: 'bogus' }),
    );
    const listed = await journal.listCloseIntents();
    expect(listed).toMatchObject({ ok: false, code: 'unreadable_record', reason: 'malformed_entry' });
  });
});
