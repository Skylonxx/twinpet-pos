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
import * as reconcilerModule from './offline/shiftCloseReconciler';
import {
  LEGACY_NORMALIZATION_CHECKS_PER_SWEEP,
  recoverOnlineCloseAttempts,
  runShiftCloseReconciliationSweep,
  shiftCloseConfirmationDocFromData,
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
/** Literal copy of CLOSE_SHIFT_COMMITTED_NOT_FINALIZED_MESSAGE (B2.1-A) so this file also runs against pre-005 sources. */
const NOT_FINALIZED = 'ส่งการปิดกะถึงเซิร์ฟเวอร์แล้ว';

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

  test('finalize THROWS after the commit → never reported failed/undone, but NO Z (B2.1-A); attempt survives; restart sweep recovers', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    const broken: ShiftCloseIntentJournal = {
      ...journal,
      finalizeOnlineClose: async () => {
        throw new Error('disk I/O error');
      },
    };
    await expect(closeShift(makeShift(), 1338, '', deps(server, broken))).rejects.toThrow(NOT_FINALIZED);
    expect(server.state.doc).toMatchObject({ status: 'closed', payOutTotal: 162, variance: 0 });
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

// ── Codex 004 → packet 005 ────────────────────────────────────────────────
// Every helper below is local (no new export is imported), so each test also
// runs against pre-005 sources for the red/green proof.

/**
 * The journal finalize after the W3 commit fails (`unavailable` result, or a
 * throw) for the first `failures` calls; `beforeFirst` runs once, first — used
 * to make the authoritative doc read malformed by the strict recovery.
 */
function failingFinalize(
  journal: ShiftCloseIntentJournal,
  { mode = 'unavailable', failures = Number.POSITIVE_INFINITY, beforeFirst }: { mode?: 'unavailable' | 'throw'; failures?: number; beforeFirst?: () => void } = {},
): ShiftCloseIntentJournal & { calls: () => number } {
  let calls = 0;
  let left = failures;
  return {
    ...journal,
    finalizeOnlineClose: async (...args) => {
      calls += 1;
      if (calls === 1) beforeFirst?.();
      if (left > 0) {
        left -= 1;
        if (mode === 'throw') throw new Error('disk I/O error');
        return { ok: false, code: 'unavailable', message: 'IndexedDB unavailable' };
      }
      return journal.finalizeOnlineClose(...args);
    },
    calls: () => calls,
  };
}

/** Production-faithful reader: the doc goes through the SAME mapper `readShiftCloseConfirmation` uses. */
function mappedReader(server: ReturnType<typeof createShiftServer>): ShiftCloseConfirmationReader {
  return async () => ({ ok: true, doc: shiftCloseConfirmationDocFromData({ ...server.state.doc }) });
}

/** Optional (absent before 005): forget the in-memory legacy schedule, like a process restart. */
function restartProcessMemory(): void {
  const reset = (reconcilerModule as Record<string, unknown>).resetLegacyNormalizationScheduleForTests;
  if (typeof reset === 'function') (reset as () => void)();
}

const POST_COMMIT_DEFECTS: Array<[string, (d: ServerShift) => ServerShift]> = [
  ['(a) own id, payOutTotal missing', (d) => without(d, 'payOutTotal')],
  ['(b) own id, payOutTotal non-finite', (d) => ({ ...d, payOutTotal: Number.NaN })],
  ['(b) own id, expectedCash wrong type', (d) => ({ ...d, expectedCash: '1000' })],
  ['(c) a DIFFERENT valid correlation id', (d) => ({ ...d, closeCorrelationId: UUID_B })],
  ['(d) wrong identity (branch)', (d) => ({ ...d, branchId: 'LDP-999' })],
  ['(d) wrong identity (device)', (d) => ({ ...d, deviceId: 'DEV2' })],
  ['(d) unresolved closedAt', (d) => ({ ...d, closedAt: null })],
];

describe('B2.1-A — W3 commits, journal finalize fails: Z ONLY after strict proof + durable finalization', () => {
  test.each(POST_COMMIT_DEFECTS)(
    'finalize unavailable, strict recovery reads %s → NO Z / no confirmation, totals not fabricated, attempt kept; restart + retry: no second W3',
    async (_label, corrupt) => {
      const server = createShiftServer(openServerShift([REFUND]));
      const journal = bootJournal();
      // The doc as read AFTER the commit is defective; any fallback read of it succeeds (status closed, closedAt toDate).
      const broken = failingFinalize(journal, { beforeFirst: () => (server.state.doc = corrupt(server.state.doc)) });
      const readConfirmation = vi.fn(mappedReader(server));
      const outcome = await closeShift(makeShift(), 1338, 'นับแล้ว', deps(server, broken, { readConfirmation })).then(
        async (r) => ({ z: r, confirmation: await r.whenServerConfirmed }),
        (err: Error) => ({ error: err.message }),
      );
      // Pre-005: a Z resolved immediately and the fallback read "confirmed" it.
      expect(outcome).toEqual({ error: expect.stringContaining(NOT_FINALIZED) });
      expect(server.state).toMatchObject({ commits: 1, normalizeAttempts: 0 });
      expect(await entryOf(journal)).toBeUndefined();
      expect(await attemptsOf(journal)).toMatchObject([{ shiftId: 'shift-1', closeCorrelationId: UUID_A }]);

      // ── restart: the sweep keeps the attempt (never superseded, never journaled) ──
      const rebooted = bootJournal([UUID_B]);
      const [rec] = await recoverOnlineCloseAttempts({ journal: rebooted, readConfirmation: mappedReader(server), deviceId: 'DEV1' });
      expect(['manual_attention', 'unreachable']).toContain(rec!.outcome);
      expect(await entryOf(rebooted)).toBeUndefined();
      expect(await attemptsOf(rebooted)).toMatchObject([{ closeCorrelationId: UUID_A }]);

      // ── the cashier retries (cache still open, then cache closed with our id): refused, no second W3 ──
      await expect(closeShift(makeShift(), 1338, 'นับแล้ว', deps(server, rebooted, { readConfirmation: mappedReader(server) }))).rejects.toThrow();
      getDocFromCacheMock.mockResolvedValue({ exists: () => true, data: () => ({ status: 'closed', closeCorrelationId: UUID_A, cashEntries: [REFUND] }) });
      await expect(closeShift(makeShift(), 1338, 'นับแล้ว', deps(server, rebooted, { readConfirmation: mappedReader(server) }))).rejects.toThrow();
      expect(server.state).toMatchObject({ commits: 1, normalizeAttempts: 0 });
      expect(await entryOf(rebooted)).toBeUndefined();
      expect(await attemptsOf(rebooted)).toMatchObject([{ closeCorrelationId: UUID_A }]);
    },
  );

  test('(e) wholly valid committed doc, finalize THROWS once → same-runtime strict recovery finalizes → Z from the committed values + confirmed', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    const flaky = failingFinalize(journal, { mode: 'throw', failures: 1 });
    const result = await closeShift(makeShift(), 1338, 'นับแล้ว', deps(server, flaky, { readConfirmation: mappedReader(server) }));
    expect(flaky.calls()).toBe(2); // the failed finalize + the strict recovery's finalize
    expect(result).toMatchObject({ status: 'closed', payOutTotal: 162, actualCashCount: 1338, variance: 0, note: 'นับแล้ว' });
    // The Z is only returned once the entry is durable.
    expect(await entryOf(journal)).toMatchObject({ closeCorrelationId: UUID_A, payOutTotal: 162 });
    await expect(result.whenServerConfirmed).resolves.toMatchObject({ outcome: 'confirmed' });
    expect(await attemptsOf(journal)).toEqual([]);
    expect(server.state).toMatchObject({ commits: 1, normalizations: 1 });
  });

  test('(e) wholly valid committed doc but the store STAYS unavailable → committed-but-unfinalized message (no Z); restart sweep finalizes; retry shows the canonical Z, one W3', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    const broken = failingFinalize(journal);
    await expect(closeShift(makeShift(), 1338, 'นับแล้ว', deps(server, broken, { readConfirmation: mappedReader(server) }))).rejects.toThrow(NOT_FINALIZED);
    expect(await entryOf(journal)).toBeUndefined();
    expect(await attemptsOf(journal)).toHaveLength(1);

    const rebooted = bootJournal([UUID_B]);
    const [r] = await sweep(server, rebooted);
    expect(r).toMatchObject({ shiftId: 'shift-1', outcome: 'confirmed' });
    expect(await entryOf(rebooted)).toMatchObject({ status: 'synced', closeCorrelationId: UUID_A, payOutTotal: 162, note: 'นับแล้ว' });
    expect(await attemptsOf(rebooted)).toEqual([]);

    getDocFromCacheMock.mockResolvedValue({ exists: () => true, data: () => ({ status: 'closed', closeCorrelationId: UUID_A, cashEntries: [REFUND] }) });
    const retry = await closeShift(makeShift({ payOutTotal: 0 }), 1, '', deps(server, rebooted, { readConfirmation: mappedReader(server) }));
    expect(retry).toMatchObject({ status: 'closed', payOutTotal: 162, actualCashCount: 1338, note: 'นับแล้ว' });
    expect(server.state).toMatchObject({ commits: 1, normalizations: 1 });
  });

  test('(c) a contradicting VALID correlation after an observed commit is never treated as superseded — the observation survives a restart', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    const broken = failingFinalize(journal, { beforeFirst: () => (server.state.doc = { ...server.state.doc, closeCorrelationId: UUID_B }) });
    await expect(closeShift(makeShift(), 1338, '', deps(server, broken, { readConfirmation: mappedReader(server) }))).rejects.toThrow(NOT_FINALIZED);
    const [kept] = await attemptsOf(journal);
    expect(kept).toMatchObject({ closeCorrelationId: UUID_A });
    expect(typeof (kept as { commitObservedAtLocal?: unknown }).commitObservedAtLocal).toBe('number');
    for (let i = 0; i < 2; i += 1) {
      const rebooted = bootJournal();
      expect(await recoverOnlineCloseAttempts({ journal: rebooted, readConfirmation: mappedReader(server), deviceId: 'DEV1' })).toEqual([
        { shiftId: 'shift-1', outcome: 'manual_attention' },
      ]);
      expect(await attemptsOf(rebooted)).toHaveLength(1);
    }
    expect(server.state.commits).toBe(1);
  });
});

/** Closed-doc correlation variants: [label, value or `undefined` to DELETE the key, expected classification]. */
const CORRELATION_VARIANTS: Array<[string, unknown, 'retained' | 'superseded' | 'own']> = [
  ["empty string ''", '', 'retained'],
  ['missing (key absent)', undefined, 'retained'],
  ['present null', null, 'retained'],
  ['malformed type (number)', 42, 'retained'],
  ['malformed string (not a UUID)', 'not-a-uuid', 'retained'],
  ['uppercase UUID (Rules deny)', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'retained'],
  ['distinct VALID id', UUID_B, 'superseded'],
  ['matching own id', UUID_A, 'own'],
];

function withCorrelation(d: ServerShift, value: unknown): ServerShift {
  return value === undefined ? without(d, 'closeCorrelationId') : { ...d, closeCorrelationId: value };
}

describe('B2.1-B — empty / malformed / absent closeCorrelationId never discards the attempt', () => {
  test.each(CORRELATION_VARIANTS)('restart sweep, doc closed with %s', async (_label, value, expected) => {
    const server = createShiftServer(openServerShift([REFUND]));
    await commitWithLostResponse(server, bootJournal());
    server.state.doc = withCorrelation(server.state.doc, value);
    const rebooted = bootJournal([UUID_B]);
    const [r] = await recoverOnlineCloseAttempts({ journal: rebooted, readConfirmation: mappedReader(server), deviceId: 'DEV1' });
    if (expected === 'own') {
      expect(r!.outcome).toBe('recovered');
      expect(await entryOf(rebooted)).toMatchObject({ closeCorrelationId: UUID_A, payOutTotal: 162 });
      expect(await attemptsOf(rebooted)).toEqual([]);
    } else if (expected === 'superseded') {
      expect(r!.outcome).toBe('superseded');
      expect(await entryOf(rebooted)).toBeUndefined();
      expect(await attemptsOf(rebooted)).toEqual([]);
    } else {
      expect(r!.outcome).toBe('manual_attention'); // pre-005: 'superseded' + attempt deleted
      expect(await entryOf(rebooted)).toBeUndefined();
      expect(await attemptsOf(rebooted)).toMatchObject([{ closeCorrelationId: UUID_A }]);
      // A further sweep keeps it too (no Z, no journal, no W4).
      await sweep({ ...server, readConfirmation: mappedReader(server) }, rebooted);
      expect(await attemptsOf(rebooted)).toHaveLength(1);
      expect(server.state.normalizeAttempts).toBe(0);
    }
    expect(server.state.commits).toBe(1);
  });

  test.each(CORRELATION_VARIANTS)('same-runtime own-ID retry (cache open), doc closed with %s', async (_label, value, expected) => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    await commitWithLostResponse(server, journal);
    server.state.doc = withCorrelation(server.state.doc, value);
    const attempt = closeShift(makeShift(), 1338, 'นับแล้ว', deps(server, journal, { readConfirmation: mappedReader(server) }));
    if (expected === 'own') {
      await expect(attempt).resolves.toMatchObject({ status: 'closed', payOutTotal: 162 });
      expect(await attemptsOf(journal)).toEqual([]);
    } else {
      await expect(attempt).rejects.toThrow('กะนี้ถูกปิดไปแล้ว');
      expect(await entryOf(journal)).toBeUndefined();
      expect(await attemptsOf(journal)).toHaveLength(expected === 'superseded' ? 0 : 1);
    }
    expect(server.state.commits).toBe(1);
  });

  test.each(CORRELATION_VARIANTS.filter(([, , e]) => e === 'retained'))(
    'post-timeout retry (cache closed with OUR id), server doc closed with %s → no Z, attempt kept',
    async (_label, value) => {
      const server = createShiftServer(openServerShift([REFUND]));
      const journal = bootJournal();
      await commitWithLostResponse(server, journal);
      server.state.doc = withCorrelation(server.state.doc, value);
      getDocFromCacheMock.mockResolvedValue({ exists: () => true, data: () => ({ status: 'closed', closeCorrelationId: UUID_A, cashEntries: [REFUND] }) });
      await expect(closeShift(makeShift(), 1338, '', deps(server, journal, { readConfirmation: mappedReader(server) }))).rejects.toThrow();
      expect(await entryOf(journal)).toBeUndefined();
      expect(await attemptsOf(journal)).toHaveLength(1);
      expect(server.state.commits).toBe(1);
    },
  );

  test('a distinct VALID id on a doc of ANOTHER branch/staff is not proof of supersession → retained', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    await commitWithLostResponse(server, bootJournal());
    server.state.doc = { ...server.state.doc, closeCorrelationId: UUID_B, staffId: 'someone-else' };
    const rebooted = bootJournal();
    const [r] = await recoverOnlineCloseAttempts({ journal: rebooted, readConfirmation: mappedReader(server), deviceId: 'DEV1' });
    expect(r!.outcome).toBe('manual_attention');
    expect(await attemptsOf(rebooted)).toHaveLength(1);
  });
});

// ── B2.2-A: fair, bounded legacy W4 migration ────────────────────────────

const legacyUuid = (i: number) => `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;

/** N pre-B2.2 `synced` entries (no normalization field), shift `L<i>`, closedAtLocal ascending with i (L<N-1> newest). */
async function seedLegacy(n: number): Promise<void> {
  let t = 1_000;
  let id = 0;
  const journal = createShiftCloseIntentJournal({ now: () => (t += 1), generateCloseCorrelationId: () => legacyUuid(id++) });
  for (let i = 0; i < n; i += 1) {
    const created = await journal.upsertCloseIntent({
      shiftId: `L${i}`, branchId: 'LDP-001', staffId: 'staff-1', staffName: 'ทดสอบ', startingCash: 500, expectedCash: 1000,
      expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0, payInTotal: 0, payOutTotal: 0, totalBills: 3,
      actualCashCount: 1500, variance: 0, note: '', deviceId: 'DEV1',
    });
    if (!created.ok) throw new Error('seed');
    await journal.markSynced(`L${i}`); // pre-B2.2 shape: no normalization field
  }
}

/** Authoritative closed docs for the legacy shifts, with per-shift read failure and W4 counters. */
function createLegacyServer(n: number) {
  const docs = new Map<string, ServerShift>();
  for (let i = 0; i < n; i += 1) {
    docs.set(`L${i}`, {
      status: 'closed', closedAt: { toDate: () => CLOSED_AT }, syncState: 'pending', deviceId: 'DEV1', branchId: 'LDP-001',
      staffId: 'staff-1', startingCash: 500, expectedCash: 1000, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0,
      payInTotal: 0, payOutTotal: 0, totalBills: 3, actualCashCount: 1500, variance: 0, note: '', closeCorrelationId: legacyUuid(i),
    });
  }
  const failing = new Set<string>();
  const reads: string[] = [];
  const w4: string[] = [];
  let failNextReads = 0;
  const readConfirmation: ShiftCloseConfirmationReader = async (id) => {
    reads.push(id);
    if (failNextReads > 0) {
      failNextReads -= 1;
      return { ok: false };
    }
    if (failing.has(id)) return { ok: false };
    const d = docs.get(id);
    return d ? { ok: true, doc: shiftCloseConfirmationDocFromData({ ...d }) } : { ok: true, doc: { exists: false } };
  };
  const normalizeSyncState = async (id: string) => {
    w4.push(id);
    const d = docs.get(id)!;
    if (d.status !== 'closed' || d.syncState !== 'pending') throw new Error('W4 denied by Rules');
    docs.set(id, { ...d, syncState: 'synced' });
  };
  return {
    docs,
    failing,
    reads,
    w4,
    readConfirmation,
    normalizeSyncState,
    failNext: (k: number) => {
      failNextReads = k;
    },
  };
}

/** One boot/reconnect sweep, by default on a FRESH journal + fresh process memory (a restart). Returns this sweep's reads / W4s. */
async function legacySweep(
  server: ReturnType<typeof createLegacyServer>,
  opts: { restart?: boolean; journal?: ShiftCloseIntentJournal } = {},
) {
  if (opts.restart !== false) restartProcessMemory();
  const r0 = server.reads.length;
  const w0 = server.w4.length;
  await runShiftCloseReconciliationSweep({
    journal: opts.journal ?? createShiftCloseIntentJournal(),
    readConfirmation: server.readConfirmation,
    normalizeSyncState: server.normalizeSyncState,
    deviceId: 'DEV1',
  });
  return { reads: server.reads.slice(r0), w4: server.w4.slice(w0) };
}

async function legacyState(shiftId: string) {
  const got = await createShiftCloseIntentJournal().getCloseIntent(shiftId);
  if (!got.ok || !got.value) throw new Error(`legacy ${shiftId}`);
  return got.value.syncStateNormalization;
}

describe('B2.2-A — legacy W4 migration makes fair progress (no starvation), bounded per sweep', () => {
  test('RED-before: 11 legacy entries, the 10 newest reads fail forever, the OLDEST is reachable + pending → reached and normalized across restarts', async () => {
    await seedLegacy(11);
    const server = createLegacyServer(11);
    for (let i = 1; i <= 10; i += 1) server.failing.add(`L${i}`);
    const perSweep: Array<{ reads: string[]; w4: string[] }> = [];
    for (let s = 0; s < 3; s += 1) perSweep.push(await legacySweep(server));
    // Pre-005: every sweep read exactly L10..L1 — L0 never, W4 never.
    expect(server.reads).toContain('L0');
    expect(server.w4).toEqual(['L0']);
    expect(await legacyState('L0')).toBe('done');
    for (const s of perSweep) {
      expect(s.reads.length).toBeLessThanOrEqual(LEGACY_NORMALIZATION_CHECKS_PER_SWEEP);
      expect(s.w4.length).toBeLessThanOrEqual(LEGACY_NORMALIZATION_CHECKS_PER_SWEEP);
    }
    // The unreachable ones stay legacy (never terminal without proof).
    expect(await legacyState('L5')).toBeUndefined();
  });

  test('25 entries, 20 persistently unreadable: every entry is read within ⌈25/10⌉ = 3 sweeps (restart each time); each reachable one W4-ed exactly once; ≤10 reads per sweep, ≤1 W4 per close per sweep', async () => {
    await seedLegacy(25);
    const server = createLegacyServer(25);
    for (let i = 5; i < 25; i += 1) server.failing.add(`L${i}`); // the 20 newest fail; L0..L4 reachable
    const seen = new Set<string>();
    for (let s = 0; s < 3; s += 1) {
      const { reads, w4 } = await legacySweep(server);
      expect(reads.length).toBeLessThanOrEqual(LEGACY_NORMALIZATION_CHECKS_PER_SWEEP);
      expect(new Set(w4).size).toBe(w4.length); // at most one W4 per close per sweep
      reads.forEach((id) => seen.add(id));
    }
    expect(seen.size).toBe(25);
    expect([...server.w4].sort()).toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
    for (let i = 0; i < 5; i += 1) expect(await legacyState(`L${i}`)).toBe('done');
    // More sweeps: only the 20 unreadable remain, rotated 10 per sweep; never another W4.
    const a = await legacySweep(server);
    const b = await legacySweep(server);
    expect(new Set([...a.reads, ...b.reads]).size).toBe(20);
    expect(server.w4).toHaveLength(5);
  });

  test('intermittent read failures (the next 7 reads fail) still converge across restarts', async () => {
    await seedLegacy(15);
    const server = createLegacyServer(15);
    server.failNext(7);
    for (let s = 0; s < 4; s += 1) await legacySweep(server);
    expect([...server.w4].sort()).toEqual(Array.from({ length: 15 }, (_, i) => `L${i}`).sort());
    for (let i = 0; i < 15; i += 1) expect(await legacyState(`L${i}`)).toBe('done');
  });

  test('crash between a legacy W4 success and the local "done" write → later sweeps record done WITHOUT a second W4', async () => {
    await seedLegacy(12);
    const server = createLegacyServer(12);
    const base = createShiftCloseIntentJournal();
    const crashing: ShiftCloseIntentJournal = {
      ...base,
      setSyncStateNormalization: async () => {
        throw new Error('process died');
      },
    };
    await legacySweep(server, { journal: crashing }); // 10 selected: W4 lands, "done" never recorded
    expect(server.w4).toHaveLength(10);
    for (let s = 0; s < 3; s += 1) await legacySweep(server);
    expect(server.w4).toHaveLength(12); // the remaining two, once each — no second W4 for the first ten
    expect(new Set(server.w4).size).toBe(12);
    for (let i = 0; i < 12; i += 1) expect(await legacyState(`L${i}`)).toBe('done');
  });

  test('the schedule stamp cannot be written (journal update failure) → the same runtime still rotates fairly', async () => {
    await seedLegacy(11);
    const server = createLegacyServer(11);
    for (let i = 1; i <= 10; i += 1) server.failing.add(`L${i}`);
    const base = createShiftCloseIntentJournal();
    const noStamp = {
      ...base,
      recordNormalizationCheck: async () => ({ ok: false as const, code: 'unavailable' as const }),
    } as ShiftCloseIntentJournal;
    restartProcessMemory();
    await legacySweep(server, { journal: noStamp, restart: false });
    await legacySweep(server, { journal: noStamp, restart: false });
    expect(server.w4).toEqual(['L0']);
  });

  test('exact-correlation mismatch and already-synced legacy docs: mismatch / done, ZERO W4, never re-read', async () => {
    await seedLegacy(2);
    const server = createLegacyServer(2);
    server.docs.set('L0', { ...server.docs.get('L0')!, closeCorrelationId: UUID_B }); // same totals, another close
    server.docs.set('L1', { ...server.docs.get('L1')!, syncState: 'synced' });
    await legacySweep(server);
    expect(await legacyState('L0')).toBe('mismatch');
    expect(await legacyState('L1')).toBe('done');
    expect(server.w4).toEqual([]);
    await legacySweep(server);
    expect(server.reads).toHaveLength(2);
  });

  test.each([['SYNCED'], [null], [7], ['']])(
    'malformed authoritative syncState %j → never classified not_applicable/terminal, never written; retained',
    async (bad) => {
      await seedLegacy(1);
      const server = createLegacyServer(1);
      server.docs.set('L0', { ...server.docs.get('L0')!, syncState: bad });
      await legacySweep(server);
      await legacySweep(server);
      expect(server.w4).toEqual([]);
      expect(await legacyState('L0')).toBeUndefined(); // pre-005: 'not_applicable' (an owed W4 silently dropped)
      expect(server.reads).toEqual(['L0', 'L0']); // still checked, not abandoned
    },
  );

  test('malformed syncState at FIRST confirmation of a pending close → recorded outstanding (not not_applicable), no W4', async () => {
    const server = createShiftServer(openServerShift([REFUND]));
    const journal = bootJournal();
    const r = await closeShift(makeShift(), 1338, '', deps(server, journal, { readConfirmation: async () => ({ ok: false }) }));
    await r.whenServerConfirmed;
    server.state.doc = { ...server.state.doc, syncState: 'weird' };
    await sweep({ ...server, readConfirmation: mappedReader(server) }, journal);
    expect(await entryOf(journal)).toMatchObject({ status: 'synced', syncStateNormalization: 'outstanding' });
    expect(server.state.normalizeAttempts).toBe(0);
  });
});
