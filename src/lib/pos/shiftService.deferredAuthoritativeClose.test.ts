// @vitest-environment jsdom
// Packet 023 — offline-first server-authoritative shift close (gate ON in tests
// only): the close is RECORDED locally when the server cannot be reached, and
// the reconciliation sweep replays it through `closeShiftAuthoritative` under
// the owner's session. End to end over:
//   - the REAL IndexedDB-backed close journal (`fake-indexeddb`; a "restart" is
//     a new journal instance over the same database);
//   - a FAITHFUL in-memory `closeShiftAuthoritative` decided by the PRODUCTION
//     server core (functions/src/closeShiftAuthoritativeCore.ts) — request
//     validation, owner check, strict cash fold, refund audit, W3 plan,
//     idempotent replay, canonical response; only Admin I/O is modelled;
//   - a client-W3 tripwire (legacy transaction + `updateDoc`).
// The real-emulator path (Rules 017 W3 seal, real W4) is
// rules-tests/shift-close-authoritative-client.spec.ts. Neither proves the
// native Tauri HTTPS / CORS transport.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Shift, ShiftCashEntry } from '../types';
import type { LocalSale } from './localLedger';
import { deriveShiftDrawer } from './shiftLedger';
import {
  SHIFT_CLOSE_INTENT_DB_NAME,
  createInMemoryShiftCloseIntentJournal,
  createInMemoryShiftCloseIntentStore,
  createShiftCloseIntentJournal,
  type ShiftCloseIntentJournal,
} from './offline/shiftCloseIntentStore';
import {
  reconcileShiftCloseIntent,
  replayDeferredAuthoritativeClose,
  runShiftCloseReconciliationSweep,
  shiftCloseConfirmationDocFromData,
  shiftCloseNormalizationIssue,
  type DeferredCloseReplayIo,
  type ReconcileShiftCloseIntentDeps,
  type ShiftCloseConfirmationReader,
} from './offline/shiftCloseReconciler';
import {
  buildAuthorityRecord,
  canonicalResponseFromDurable,
  decideClosedShiftReplay,
  deriveCloseRequestDigest,
  foldShiftCashEntriesStrict,
  parseOpenShiftIdentity,
  planAuthoritativeClose,
  validateCloseShiftRequest,
  verifyRefundAudit,
  type RawRecord,
} from '../../../functions/src/closeShiftAuthoritativeCore';
import { SALE_RETURN_SCHEMA_VERSION, deriveCashRefundEntryId } from '../../../functions/src/saleReturnCore';

vi.mock('../firebase', () => ({
  isFirebaseConfigured: true,
  db: {} as unknown,
  collections: { shifts: 'shifts', cashTransactions: 'cashTransactions' },
}));

const fs = vi.hoisted(() => ({
  cacheDoc: null as Record<string, unknown> | null,
  updateDoc: vi.fn(),
  runTransaction: vi.fn(),
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    doc: vi.fn(() => ({ id: 'shift-1' })),
    getDocFromCache: vi.fn(async () => ({ exists: () => fs.cacheDoc !== null, data: () => fs.cacheDoc ?? undefined })),
    updateDoc: fs.updateDoc,
    runTransaction: fs.runTransaction,
    getDocFromServer: vi.fn(async () => {
      throw new Error('unexpected production server read in a test');
    }),
  };
});

vi.mock('./deviceId', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./deviceId')>();
  return { ...actual, getDeviceId: vi.fn(() => 'DEV1') };
});

import { buildReviewedDrawerWitness } from './shiftCloseAuthoritativeClient';
import { closeShift, type CloseShiftDeps, type ShiftCloseTransactionRunner } from './shiftService';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_OTHER = '99999999-9999-4999-8999-999999999999';
const CLOSED_AT_MS = Date.parse('2026-10-27T10:00:00Z');
const OWNER = 'staff-1';

const M = {
  conflict: 'พบข้อมูลปิดกะอื่นสำหรับกะนี้ในเครื่องนี้อยู่แล้ว',
  onlineAttempt: 'การปิดกะออนไลน์ครั้งก่อนของกะนี้ยังยืนยันผลกับเซิร์ฟเวอร์ไม่ได้',
  cashPending: 'มีรายการคืนเงินสดของกะนี้ที่เครื่องนี้ยังยืนยันผล',
  displayChanged: 'ยอดเงินสดในลิ้นชักที่แสดงอยู่ไม่ตรงกับข้อมูลล่าสุดบนเซิร์ฟเวอร์',
  drawerChanged: 'รายการเงินสดของกะบนเซิร์ฟเวอร์ไม่ตรงกับยอดที่บันทึกไว้ตอนปิดกะในเครื่องนี้ขณะออฟไลน์',
  closedByOther: 'กะนี้ถูกปิดบนเซิร์ฟเวอร์ด้วยการปิดกะอื่น',
  identity: 'สาขาหรือพนักงานของกะบนเซิร์ฟเวอร์ไม่ตรงกับการปิดกะที่บันทึกไว้',
  refused: 'เซิร์ฟเวอร์ไม่รับการปิดกะที่บันทึกไว้ในเครื่องนี้ขณะออฟไลน์',
  resultMismatch: 'เซิร์ฟเวอร์ปิดกะแล้ว แต่ยอดที่บันทึกไม่ตรงกับยอดที่เครื่องนี้ส่งไป',
  localCashInvalid: 'ข้อมูลเงินทอนเริ่มต้นหรือรายการเงินสดของกะในเครื่องนี้ไม่ถูกต้อง',
};

// ── Fixtures ──

function sale(id: string, payments: Array<{ method: string; amount: unknown }>, changeAmt: unknown = 0, shiftId = 'shift-1'): LocalSale {
  return {
    id,
    billId: `R-${id}`,
    deviceId: 'DEV1',
    shiftId,
    staffId: OWNER,
    staffName: 'ทดสอบ',
    customerId: null,
    status: 'completed',
    reconcileStatus: 'settled',
    total: 0,
    paidAmt: 0,
    changeAmt,
    creditAmt: 0,
    payments,
    pendingSync: true,
    clientCreatedAt: 1,
    occurredAt: 1,
    sortSeq: 1,
  } as unknown as LocalSale;
}

/** 1000 cash + 0.10 + 0.20 QR in four bills — offline sales the server never verifies (attested). */
const SALES: LocalSale[] = [
  sale('s1', [{ method: 'cash', amount: 400 }]),
  sale('s2', [{ method: 'cash', amount: 500 }], 100),
  sale('s3', [{ method: 'cash', amount: 200 }]),
  sale('s4', [{ method: 'qr', amount: 0.1 }, { method: 'qr', amount: 0.2 }]),
];

function payIn(id: string, amount: number): ShiftCashEntry {
  return { id, type: 'pay_in', amount, note: 'เติมเงินทอน', staffId: OWNER, staffName: 'ทดสอบ', at: 1 } as ShiftCashEntry;
}

function baseShift(cashEntries: ShiftCashEntry[] = [], over: Partial<Shift> = {}): Shift {
  return {
    id: 'shift-1',
    branchId: 'LDP-001',
    staffId: OWNER,
    staffName: 'ทดสอบ',
    status: 'open',
    openedAt: new Date() as unknown as Shift['openedAt'],
    closedAt: null,
    startingCash: 500,
    actualCashCount: 0,
    expectedCash: 0,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    totalBills: 0,
    payInTotal: 0,
    payOutTotal: 0,
    variance: 0,
    note: '',
    cashEntries,
    ...over,
  };
}

function drawer(cashEntries: ShiftCashEntry[] = [], sales: LocalSale[] = SALES, over: Partial<Shift> = {}): Shift {
  return deriveShiftDrawer(baseShift(cashEntries, over), sales);
}

function serverShift(cashEntries: ShiftCashEntry[] = [], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'shift-1',
    branchId: 'LDP-001',
    staffId: OWNER,
    staffName: 'ทดสอบ',
    status: 'open',
    openedAt: { toMillis: () => 1 },
    closedAt: null,
    startingCash: 500,
    actualCashCount: 0,
    expectedCash: 0,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    totalBills: 0,
    payInTotal: 0,
    payOutTotal: 0,
    variance: 0,
    note: '',
    cashEntries,
    ...over,
  };
}

function ts(ms: number) {
  return { toMillis: () => ms, toDate: () => new Date(ms) };
}

function clone(d: Record<string, unknown>): Record<string, unknown> {
  return { ...d, cashEntries: Array.isArray(d.cashEntries) ? (d.cashEntries as unknown[]).map((e) => ({ ...(e as object) })) : d.cashEntries };
}

// ── Faithful in-memory `closeShiftAuthoritative` (production decision core) ──

function createServer(initial: Record<string, unknown>) {
  const state = {
    doc: { ...initial } as Record<string, unknown>,
    record: null as Record<string, unknown> | null,
    refunds: [] as RawRecord[],
    returns: [] as RawRecord[],
    calls: [] as Array<{ request: Record<string, unknown>; caller: string | null }>,
    commits: 0,
    w4: 0,
    /** The live server-side state of the caller (D7). */
    user: { isActive: true, authVersion: 0 },
  };
  const hooks = {
    /** The identity the next calls carry (the device's CURRENT session). */
    caller: OWNER as string | null,
    tokenAuthVersion: 0,
    transportFailuresLeft: 0,
    /** Commit, then lose the response (transport error) for the next N calls. */
    loseResponseLeft: 0,
    unconfirmedLeft: 0,
    refuse: null as null | string,
    respond: null as null | ((real: unknown) => unknown),
  };

  async function callable(request: Record<string, unknown>): Promise<unknown> {
    const raw = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
    state.calls.push({ request: raw, caller: hooks.caller });
    if (hooks.transportFailuresLeft > 0) {
      hooks.transportFailuresLeft -= 1;
      throw Object.assign(new Error('internal'), { code: 'functions/unavailable' });
    }
    const real = decide(raw);
    if (hooks.loseResponseLeft > 0) {
      hooks.loseResponseLeft -= 1;
      throw Object.assign(new Error('deadline'), { code: 'functions/deadline-exceeded' });
    }
    return hooks.respond ? hooks.respond(real) : real;
  }

  function decide(raw: Record<string, unknown>): unknown {
    if (hooks.caller === null) return { ok: false, code: 'unauthenticated' };
    const v = validateCloseShiftRequest(raw);
    if (!v.ok) return v;
    const request = v.value;
    const requestDigest = deriveCloseRequestDigest(request);
    if (!state.user.isActive) return { ok: false, code: 'not_authorized' };
    if (state.user.authVersion !== hooks.tokenAuthVersion) return { ok: false, code: 'session_stale' };
    if (hooks.refuse) {
      const code = hooks.refuse;
      hooks.refuse = null;
      return { ok: false, code };
    }
    const shiftData = state.doc;
    if (shiftData.staffId !== hooks.caller) return { ok: false, code: 'not_shift_owner' };
    if (shiftData.status === 'closed') return decideClosedShiftReplay({ shiftData, record: state.record, request, requestDigest });
    if (shiftData.status !== 'open') return { ok: false, code: 'shift_state_invalid' };
    if (state.record) return { ok: false, code: 'close_record_inconsistent' };
    const identity = parseOpenShiftIdentity(request.shiftId, shiftData);
    if (!identity.ok) return identity;
    const cash = foldShiftCashEntriesStrict(shiftData.cashEntries, 'cashEntries' in shiftData);
    if (!cash.ok) return cash;
    const audit = verifyRefundAudit({ shift: identity.value, refunds: state.refunds, returns: state.returns, serverRefundEntries: cash.value.serverRefundEntries });
    if (!audit.ok) return audit;
    const plan = planAuthoritativeClose({ shift: identity.value, request, cash: cash.value });
    if (!plan.ok) return plan;
    const closedAt = ts(CLOSED_AT_MS);
    state.doc = { ...shiftData, ...plan.value.w3Fields, closedAt };
    state.record = {
      ...buildAuthorityRecord({ request, requestDigest, plan: plan.value, cash: cash.value, audit: audit.value, callerStaffId: hooks.caller, nowMillis: CLOSED_AT_MS }),
      closedAt,
    };
    state.commits += 1;
    if (hooks.unconfirmedLeft > 0) {
      hooks.unconfirmedLeft -= 1;
      return { ok: false, code: 'committed_unconfirmed' };
    }
    return canonicalResponseFromDurable({ shiftData: state.doc, record: state.record, idempotentReplay: false });
  }

  function commitCashReturn(returnId: string, amount: number) {
    const cashEntryId = deriveCashRefundEntryId(returnId);
    state.doc = {
      ...state.doc,
      cashEntries: [
        ...((state.doc.cashEntries as ShiftCashEntry[]) ?? []),
        { id: cashEntryId, type: 'pay_out', amount, note: 'คืนเงินสด', staffId: OWNER, staffName: 'ทดสอบ', at: 2 },
      ],
    };
    state.refunds.push({
      id: returnId,
      data: {
        schemaVersion: SALE_RETURN_SCHEMA_VERSION, refundId: returnId, returnId, method: 'cash', executionMode: 'cash_drawer',
        shiftId: 'shift-1', branchId: 'LDP-001', requesterStaffId: OWNER, cashEntryId, amount,
      },
    });
    state.returns.push({
      id: returnId,
      data: {
        schemaVersion: SALE_RETURN_SCHEMA_VERSION, returnId, status: 'completed', branchId: 'LDP-001', requesterStaffId: OWNER,
        refund: { method: 'cash', refundId: returnId, shiftId: 'shift-1', cashEntryId, amount },
      },
    });
  }

  const readConfirmation: ShiftCloseConfirmationReader = async () => ({ ok: true, doc: shiftCloseConfirmationDocFromData({ ...state.doc }) });
  const normalizeSyncState = async () => {
    if (state.doc.syncState === 'synced') return 'already_synced' as const;
    state.doc = { ...state.doc, syncState: 'synced' };
    state.w4 += 1;
    return 'written' as const;
  };
  return { state, hooks, callable, commitCashReturn, readConfirmation, normalizeSyncState };
}

type Server = ReturnType<typeof createServer>;

function tripwire(server: Server) {
  const calls: Array<Record<string, unknown>> = [];
  const run: ShiftCloseTransactionRunner = async (_id, fn) =>
    fn({
      get: async () => ({ exists: true, data: clone(server.state.doc) }),
      update: (payload) => {
        calls.push(payload);
      },
    });
  return { calls, run };
}

function journalOf(ids: string[] = [UUID_A, UUID_B, UUID_C]): ShiftCloseIntentJournal {
  return createShiftCloseIntentJournal({ generateCloseCorrelationId: () => ids.shift() ?? null });
}

type World = {
  server: Server;
  wire: ReturnType<typeof tripwire>;
  io: DeferredCloseReplayIo & { flushed: boolean; session: string | null; readFails: boolean };
  clear: ReturnType<typeof vi.fn>;
};

function world(initial = serverShift()): World {
  const server = createServer(initial);
  const io = {
    flushed: true,
    session: OWNER as string | null,
    readFails: false,
    readServerShift: async () => (io.readFails ? { ok: false as const } : { ok: true as const, exists: true as const, data: clone(server.state.doc) }),
    waitForQueuedWrites: async () => io.flushed,
    sessionStaffId: async () => io.session,
  };
  return { server, wire: tripwire(server), io, clear: vi.fn() };
}

/** The ON close deps; `online` false = the device is offline. The witness is of the drawer shown (`display`, default = the shift). */
function closeDeps(w: World, journal: ShiftCloseIntentJournal, opts: { online?: boolean; display?: Shift; extra?: Record<string, unknown> } = {}): (s: Shift) => CloseShiftDeps {
  return (shift) =>
    ({
      journal,
      isOnline: () => opts.online ?? false,
      serverCashPending: { has: () => false, clear: w.clear },
      runCloseTransaction: w.wire.run,
      waitForQueuedWrites: async () => w.io.flushed,
      readConfirmation: w.server.readConfirmation,
      normalizeSyncState: w.server.normalizeSyncState,
      authoritativeCloseGate: true,
      authoritativeClose: {
        sales: SALES,
        callable: w.server.callable,
        readServerShift: w.io.readServerShift,
        reviewedDrawer: buildReviewedDrawerWitness(opts.display ?? shift, 'unavailable'),
      },
      ...opts.extra,
    }) as CloseShiftDeps;
}

async function closeOffline(w: World, journal: ShiftCloseIntentJournal, shift = drawer(), count = 1500.3, note = 'offline') {
  return closeShift(shift, count, note, closeDeps(w, journal)(shift));
}

function sweepDeps(w: World, journal: ShiftCloseIntentJournal, over: Partial<ReconcileShiftCloseIntentDeps> = {}): ReconcileShiftCloseIntentDeps {
  return {
    journal,
    readConfirmation: w.server.readConfirmation,
    normalizeSyncState: w.server.normalizeSyncState,
    deviceId: 'DEV1',
    authoritativeCallable: w.server.callable,
    deferredReplay: w.io,
    ...over,
  };
}

async function sweep(w: World, journal: ShiftCloseIntentJournal, over: Partial<ReconcileShiftCloseIntentDeps> = {}) {
  const results = await runShiftCloseReconciliationSweep(sweepDeps(w, journal, over));
  return { result: results.find((r) => r.shiftId === 'shift-1'), summary: results.normalization };
}

async function entryOf(journal: ShiftCloseIntentJournal, shiftId = 'shift-1') {
  const got = await journal.getCloseIntent(shiftId);
  if (!got.ok) throw new Error(`getCloseIntent ${got.code}`);
  return got.value;
}

function expectNoClientW3(w: World) {
  expect(w.wire.calls).toEqual([]);
  expect(fs.updateDoc).not.toHaveBeenCalled();
  expect(fs.runTransaction).not.toHaveBeenCalled();
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
  fs.cacheDoc = { status: 'open', startingCash: 500, cashEntries: [] };
  fs.updateDoc.mockReset();
  fs.updateDoc.mockResolvedValue(undefined);
  fs.runTransaction.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
describe('023-A offline: the cashier finishes the close locally (no wait for Internet)', () => {
  test('recorded durably with a pending status; nothing sent / queued / attempted; never a server-confirmed result', async () => {
    const w = world();
    const journal = journalOf();
    const result = await closeOffline(w, journal);
    // expectedDrawer = 500 + 1000 cash = 1500; QR 0.1 + 0.2 folded in integer satang = 0.3 (never 0.30000000000000004).
    expect(result).toMatchObject({
      status: 'closed', syncState: 'pending', closedOffline: true, authoritativeDeferred: true,
      expectedCash: 1000, expectedQr: 0.3, totalBills: 4, actualCashCount: 1500.3, note: 'offline',
    });
    expect(result.variance).toBe(1500.3 - (500 + 1000 + 0 - 0));
    await expect(result.whenServerConfirmed).resolves.toEqual({ outcome: 'still_pending' });
    expect(await entryOf(journal)).toMatchObject({
      status: 'local_closed_pending', closeProtocol: 'server_authoritative_v1', closeCorrelationId: UUID_A, deviceId: 'DEV1', expectedQr: 0.3,
    });
    expectNoClientW3(w);
    expect(w.server.state.calls).toEqual([]);
    expect(w.server.state.doc.status).toBe('open');
    const attempts = await journal.listOnlineCloseAttempts();
    expect(attempts.ok && attempts.value).toEqual([]);
    expect(w.clear).not.toHaveBeenCalled();
  });

  test('survives a restart: a new journal over the same IndexedDB reads the same pending deferred close; a same-value retry is idempotent, a different count conflicts', async () => {
    const w = world();
    const first = await closeOffline(w, journalOf());
    const restarted = journalOf([UUID_C]);
    expect(await entryOf(restarted)).toMatchObject({ status: 'local_closed_pending', closeProtocol: 'server_authoritative_v1', closeCorrelationId: UUID_A });
    const again = await closeOffline(w, restarted);
    expect(again.closedAtLocal).toBe(first.closedAtLocal);
    expect((await entryOf(restarted))?.closeCorrelationId).toBe(UUID_A);
    await expect(closeOffline(w, restarted, drawer(), 1400)).rejects.toThrow(M.conflict);
    expectNoClientW3(w);
  });

  // Parity remediation (Codex 023 MASTER_PLAN_PARITY_BLOCKER): the pending
  // deferred close no longer blocks a DIFFERENT shift and is never resumed itself.
  // This file's Firestore fake models one shift document only, so that matrix
  // (new shift id, restart, other cashier, getActiveShift, boot read) lives in
  // shiftService.deferredCloseContinuity.test.ts.

  test('online but the connection fails before anything is sent (writes not flushed / server read fails): recorded locally, no attempt, no call', async () => {
    for (const fail of ['flush', 'read'] as const) {
      await deleteDb();
      const w = world();
      if (fail === 'flush') w.io.flushed = false;
      else w.io.readFails = true;
      const journal = journalOf();
      const shift = drawer();
      const result = await closeShift(shift, 1500, '', closeDeps(w, journal, { online: true })(shift));
      expect(result.authoritativeDeferred).toBe(true);
      expect(await entryOf(journal)).toMatchObject({ closeProtocol: 'server_authoritative_v1' });
      const attempts = await journal.listOnlineCloseAttempts();
      expect(attempts.ok && attempts.value).toEqual([]);
      expect(w.server.state.calls).toEqual([]);
      expectNoClientW3(w);
    }
  });

  test('connected: unchanged server-authoritative close (callable W3, proof, synced) — never deferred', async () => {
    const w = world();
    const journal = journalOf();
    const shift = drawer();
    const deps = closeDeps(w, journal, { online: true, display: shift })(shift);
    (deps.authoritativeClose as { reviewedDrawer: unknown }).reviewedDrawer = buildReviewedDrawerWitness(shift, 'loaded');
    const result = await closeShift(shift, 1500.3, '', deps);
    expect(result.authoritativeDeferred).toBeUndefined();
    expect(w.server.state.commits).toBe(1);
    await expect(result.whenServerConfirmed).resolves.toMatchObject({ outcome: 'confirmed' });
    expect(await entryOf(journal)).not.toHaveProperty('closeProtocol');
    expectNoClientW3(w);
  });

  test('legacy offline guards still apply: an unresolved online attempt or a pending cash Return refuses — nothing recorded', async () => {
    const w = world();
    const journal = journalOf();
    const prepared = await journal.prepareOnlineCloseAttempt({ shiftId: 'shift-1', branchId: 'LDP-001', staffId: OWNER, staffName: 'ทดสอบ', deviceId: 'DEV1' });
    expect(prepared.ok).toBe(true);
    await expect(closeOffline(w, journal)).rejects.toThrow(M.onlineAttempt);
    expect(await entryOf(journal)).toBeUndefined();

    await deleteDb();
    const j2 = journalOf();
    const shift = drawer();
    const deps = closeDeps(w, j2, { extra: { serverCashPending: { has: () => true, clear: w.clear } } })(shift);
    await expect(closeShift(shift, 1500, '', deps)).rejects.toThrow(M.cashPending);
    expect(await entryOf(j2)).toBeUndefined();
    expectNoClientW3(w);
  });

  test('F2 on the local basis: a cached pay-in the cashier was NOT shown refuses (reviewRequired) — nothing recorded', async () => {
    const w = world();
    const journal = journalOf();
    fs.cacheDoc = { status: 'open', startingCash: 500, cashEntries: [payIn('pi_1', 100)] };
    const shown = drawer();
    const err = await closeOffline(w, journal, shown).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(M.displayChanged);
    expect((err as { cause?: { reviewRequired?: boolean } }).cause?.reviewRequired).toBe(true);
    expect(await entryOf(journal)).toBeUndefined();
  });

  test('a non-canonical local cash movement refuses (never rounded into a close) — nothing recorded', async () => {
    const w = world();
    const journal = journalOf();
    const bad = [payIn('pi_1', 0.001)];
    fs.cacheDoc = { status: 'open', startingCash: 500, cashEntries: bad };
    await expect(closeOffline(w, journal, drawer(bad))).rejects.toThrow(M.localCashInvalid);
    expect(await entryOf(journal)).toBeUndefined();
  });

  test('a legacy (gate OFF) offline close record is never relabelled deferred, and a deferred one never gets a legacy queued W3', async () => {
    const w = world();
    const journal = journalOf();
    const shift = drawer();
    const offDeps = { ...closeDeps(w, journal)(shift) } as Record<string, unknown>;
    delete offDeps.authoritativeCloseGate;
    await closeShift(shift, 1500.3, 'offline', offDeps as CloseShiftDeps); // legacy: intent + queued updateDoc
    expect(fs.updateDoc).toHaveBeenCalledTimes(1);
    await expect(closeOffline(w, journal)).rejects.toThrow(M.conflict);
    expect(await entryOf(journal)).not.toHaveProperty('closeProtocol');

    await deleteDb();
    fs.updateDoc.mockClear();
    const j2 = journalOf();
    await closeOffline(w, j2);
    await expect(closeShift(shift, 1500.3, 'offline', { ...offDeps, journal: j2 } as CloseShiftDeps)).rejects.toThrow(M.conflict);
    expect(fs.updateDoc).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('023-B reconnect: one effective server-authoritative close, idempotent replay', () => {
  test('the sweep sends the recorded request once under the owner session: committed, proven, synced, W4 — a second sweep sends nothing', async () => {
    const w = world();
    const journal = journalOf();
    await closeOffline(w, journal);
    const { result, summary } = await sweep(w, journal);
    expect(result).toMatchObject({ outcome: 'confirmed', deferred: 'confirmed' });
    expect(summary.status).toBe('ok');
    expect(w.server.state.calls).toHaveLength(1);
    expect(w.server.state.calls[0]!.request).toMatchObject({
      contractVersion: 1, shiftId: 'shift-1', closeCorrelationId: UUID_A, actualCashCount: 1500.3, note: 'offline', deviceId: 'DEV1',
      attestedSales: { expectedCash: 1000, expectedQr: 0.3, totalBills: 4 },
    });
    expect(w.server.state.calls[0]!.caller).toBe(OWNER);
    expect(w.server.state.commits).toBe(1);
    expect(w.server.state.doc).toMatchObject({ status: 'closed', closeCorrelationId: UUID_A, syncState: 'synced' });
    expect(w.server.state.record).toMatchObject({ salesVerification: { status: 'attested_unverified' } });
    expect(await entryOf(journal)).toMatchObject({ status: 'synced', syncStateNormalization: 'done', closeProtocol: 'server_authoritative_v1' });
    await sweep(w, journal);
    expect(w.server.state.calls).toHaveLength(1);
    expect(w.server.state.commits).toBe(1);
    expectNoClientW3(w);
  });

  test('lost response after the commit: kept pending (unknown), the next sweep replays the SAME id → idempotent replay, ONE commit', async () => {
    const w = world();
    const journal = journalOf();
    await closeOffline(w, journal);
    w.server.hooks.loseResponseLeft = 1;
    expect((await sweep(w, journal)).result).toMatchObject({ outcome: 'unreachable', deferred: 'unreachable' });
    expect(await entryOf(journal)).toMatchObject({ status: 'local_closed_pending' });
    expect(w.server.state.commits).toBe(1);
    const { result } = await sweep(w, journal);
    expect(result).toMatchObject({ outcome: 'confirmed', deferred: 'confirmed' });
    expect(w.server.state.calls.map((c) => c.request.closeCorrelationId)).toEqual([UUID_A, UUID_A]);
    expect(w.server.state.commits).toBe(1);
    expect(await entryOf(journal)).toMatchObject({ status: 'synced' });
  });

  test('committed_unconfirmed, a transport failure, and a timeout before the server: each kept pending, then ONE commit', async () => {
    const w = world();
    const journal = journalOf();
    await closeOffline(w, journal);
    w.server.hooks.transportFailuresLeft = 1;
    expect((await sweep(w, journal)).result?.deferred).toBe('unreachable');
    expect(w.server.state.commits).toBe(0);
    w.server.hooks.unconfirmedLeft = 1;
    expect((await sweep(w, journal)).result?.deferred).toBe('unreachable');
    expect(w.server.state.commits).toBe(1);
    expect((await sweep(w, journal)).result?.deferred).toBe('confirmed');
    expect(w.server.state.commits).toBe(1);
    expect(w.server.state.calls).toHaveLength(3);
  });

  test('restart between the local close and the reconnect: the replay works from the durable record alone', async () => {
    const w = world();
    await closeOffline(w, journalOf());
    const afterRestart = journalOf([]);
    expect((await sweep(w, afterRestart)).result?.deferred).toBe('confirmed');
    expect(await entryOf(afterRestart)).toMatchObject({ status: 'synced' });
  });

  test('queued offline writes first: unflushed ⇒ nothing sent; once flushed the server folds the pay-in exactly once (no double cash)', async () => {
    const w = world();
    const journal = journalOf();
    const pi = payIn('pi_1', 200);
    fs.cacheDoc = { status: 'open', startingCash: 500, cashEntries: [pi] }; // own queued W1, applied to the cache
    await closeOffline(w, journal, drawer([pi]), 1700);
    expect(await entryOf(journal)).toMatchObject({ payInTotal: 200, variance: 0 });
    w.io.flushed = false;
    expect((await sweep(w, journal)).result).toMatchObject({ deferred: 'unreachable', deferredReason: 'queued_writes_pending' });
    expect(w.server.state.calls).toEqual([]);
    // The flush lands the W1 on the server, then the replay runs.
    w.server.state.doc = { ...w.server.state.doc, cashEntries: [pi] };
    w.io.flushed = true;
    expect((await sweep(w, journal)).result?.deferred).toBe('confirmed');
    expect(w.server.state.doc).toMatchObject({ payInTotal: 200, variance: 0, status: 'closed' });
    expect(w.server.state.record).toMatchObject({ money: { payInMinor: 20_000, varianceMinor: 0 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('023-C owner-only authorization: never escalated, never another actor', () => {
  test('no session, or a session of another staff (e.g. a manager): nothing sent, kept pending, scoped attention', async () => {
    for (const session of [null, 'manager-9']) {
      await deleteDb();
      const w = world();
      w.io.session = session;
      const journal = journalOf();
      await closeOffline(w, journal);
      const { result, summary } = await sweep(w, journal);
      expect(result).toMatchObject({ outcome: 'still_pending', deferred: 'awaiting_owner_session' });
      expect(w.server.state.calls).toEqual([]);
      expect(summary.attention).toContainEqual({ shiftId: 'shift-1', branchId: 'LDP-001', condition: 'deferred_close_awaiting_owner' });
      expect(shiftCloseNormalizationIssue(summary)).toContain('deferred_close_awaiting_owner=1');
      expect(await entryOf(journal)).toMatchObject({ status: 'local_closed_pending' });
    }
  });

  test('stale / missing token at the server (session_stale, unauthenticated): kept pending, not rejected', async () => {
    const w = world();
    const journal = journalOf();
    await closeOffline(w, journal);
    w.server.hooks.tokenAuthVersion = 1;
    expect((await sweep(w, journal)).result).toMatchObject({ deferred: 'awaiting_owner_session', deferredReason: 'session_stale' });
    w.server.hooks.tokenAuthVersion = 0;
    w.server.hooks.caller = null;
    expect((await sweep(w, journal)).result).toMatchObject({ deferred: 'awaiting_owner_session', deferredReason: 'unauthenticated' });
    expect(await entryOf(journal)).toMatchObject({ status: 'local_closed_pending' });
    expect(w.server.state.commits).toBe(0);
  });

  test('owner deactivated / revoked (not_authorized): kept pending with not_authorized attention — never rejected, never retried as anyone else', async () => {
    const w = world();
    const journal = journalOf();
    await closeOffline(w, journal);
    w.server.state.user.isActive = false;
    const { result, summary } = await sweep(w, journal);
    expect(result).toMatchObject({ outcome: 'still_pending', deferred: 'not_authorized', deferredReason: 'not_authorized' });
    expect(summary.attention).toContainEqual({ shiftId: 'shift-1', branchId: 'LDP-001', condition: 'deferred_close_not_authorized' });
    expect(w.server.state.calls.every((c) => c.caller === OWNER)).toBe(true);
    expect(await entryOf(journal)).toMatchObject({ status: 'local_closed_pending' });
    expect(w.server.state.commits).toBe(0);
  });

  test('no replay I/O wired: nothing sent (replay_unavailable)', async () => {
    const w = world();
    const journal = journalOf();
    await closeOffline(w, journal);
    const { result, summary } = await sweep(w, journal, { deferredReplay: undefined });
    expect(result).toMatchObject({ deferred: 'replay_unavailable' });
    expect(summary.attention.map((a) => a.condition)).toContain('deferred_close_replay_unavailable');
    expect(w.server.state.calls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('023-D conflict / rejection: durable manual attention, never a false Z', () => {
  test('a cash Return committed on the server after the local close: nothing sent, entry durably rejected, shift stays open', async () => {
    const w = world();
    const journal = journalOf();
    await closeOffline(w, journal);
    w.server.commitCashReturn('ret_1', 81);
    const { result } = await sweep(w, journal);
    expect(result).toMatchObject({ outcome: 'identity_mismatch', deferred: 'rejected', deferredReason: 'drawer_changed' });
    expect(w.server.state.calls).toEqual([]);
    expect(w.server.state.doc.status).toBe('open');
    const e = await entryOf(journal);
    expect(e?.status).toBe('rejected_manual_attention');
    expect(e?.lastErrorMessage).toContain(M.drawerChanged);
    await sweep(w, journal);
    expect(w.server.state.calls).toEqual([]);
  });

  test('a definitive server refusal is recorded durably with the refusal code', async () => {
    const w = world();
    const journal = journalOf();
    await closeOffline(w, journal);
    w.server.hooks.refuse = 'refund_entry_mismatch';
    expect((await sweep(w, journal)).result).toMatchObject({ deferred: 'rejected', deferredReason: 'refund_entry_mismatch' });
    const e = await entryOf(journal);
    expect(e?.status).toBe('rejected_manual_attention');
    expect(e?.lastErrorMessage).toContain(M.refused);
    expect(e?.lastErrorMessage).toContain('refund_entry_mismatch');
    expect(w.server.state.commits).toBe(0);
  });

  test('the shift was closed on the server by ANOTHER close: rejected, nothing sent', async () => {
    const w = world(serverShift([], { status: 'closed', closeCorrelationId: UUID_OTHER, closedAt: ts(CLOSED_AT_MS) }));
    const journal = journalOf();
    await closeOffline(w, journal);
    expect((await sweep(w, journal)).result).toMatchObject({ deferred: 'rejected', deferredReason: 'closed_by_other' });
    expect((await entryOf(journal))?.lastErrorMessage).toContain(M.closedByOther);
    expect(w.server.state.calls).toEqual([]);
  });

  test('a forged direct client W3 with the entry\'s UUID and amounts is never confirmed: plain reconcile stays pending, the callable says closed_outside_authority', async () => {
    const w = world();
    const journal = journalOf();
    await closeOffline(w, journal);
    const e = (await entryOf(journal))!;
    w.server.state.doc = {
      ...w.server.state.doc,
      status: 'closed', closedAt: ts(CLOSED_AT_MS), closeCorrelationId: UUID_A, deviceId: 'DEV1', closedOffline: true, syncState: 'pending',
      actualCashCount: e.actualCashCount, variance: e.variance, note: e.note, expectedCash: e.expectedCash, expectedQr: e.expectedQr,
      expectedKbank: e.expectedKbank, expectedCard: e.expectedCard, expectedCredit: e.expectedCredit, totalBills: e.totalBills,
      payInTotal: e.payInTotal, payOutTotal: e.payOutTotal,
    };
    expect(await reconcileShiftCloseIntent(e, sweepDeps(w, journal))).toEqual({ shiftId: 'shift-1', outcome: 'still_pending' });
    expect(await entryOf(journal)).toMatchObject({ status: 'local_closed_pending' });
    expect((await sweep(w, journal)).result).toMatchObject({ deferred: 'rejected', deferredReason: 'closed_outside_authority' });
    expect((await entryOf(journal))?.status).toBe('rejected_manual_attention');
    expect(w.server.state.doc.syncState).toBe('pending'); // no W4 over an unproven close
  });

  test('the server reports a commit of different values: rejected (never adopted as this close)', async () => {
    const w = world();
    const journal = journalOf();
    await closeOffline(w, journal);
    w.server.hooks.respond = (real) => {
      const r = real as { snapshot?: Record<string, unknown> };
      return r.snapshot ? { ...r, snapshot: { ...r.snapshot, actualCashCount: 9999 } } : real;
    };
    expect((await sweep(w, journal)).result).toMatchObject({ deferred: 'rejected', deferredReason: 'result_mismatch' });
    expect((await entryOf(journal))?.lastErrorMessage).toContain(M.resultMismatch);
  });

  test('a rejection that cannot be persisted is reported as a local durability failure, entry kept pending', async () => {
    const w = world();
    const journal = journalOf();
    await closeOffline(w, journal);
    w.server.commitCashReturn('ret_1', 81);
    const failing: ShiftCloseIntentJournal = { ...journal, markRejectedManualAttention: async () => ({ ok: false, code: 'quota' }) };
    const { result, summary } = await sweep(w, failing);
    expect(result).toMatchObject({ outcome: 'unreachable', deferred: 'unreachable', journalWriteFailed: 'mark_rejected_manual_attention' });
    expect(summary.status).toBe('degraded');
    expect(await entryOf(journal)).toMatchObject({ status: 'local_closed_pending' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('023-E branch / shift / device binding', () => {
  test('server shift of another branch or staff under the same id: rejected, nothing sent', async () => {
    const w = world(serverShift([], { branchId: 'OTHER-BRANCH' }));
    const journal = journalOf();
    await closeOffline(w, journal);
    expect((await sweep(w, journal)).result).toMatchObject({ deferred: 'rejected', deferredReason: 'identity_mismatch' });
    expect((await entryOf(journal))?.lastErrorMessage).toContain(M.identity);
    expect(w.server.state.calls).toEqual([]);
  });

  test('another device\'s deferred entry is never replayed from this device', async () => {
    const w = world();
    const journal = journalOf();
    await closeOffline(w, journal);
    const e = (await entryOf(journal))!;
    expect(await replayDeferredAuthoritativeClose(e, sweepDeps(w, journal, { deviceId: 'DEV2' }))).toEqual({ shiftId: 'shift-1', outcome: 'still_pending' });
    expect(w.server.state.calls).toEqual([]);
  });

  test('a second shift of the same device: each replay carries only its own shift id + correlation id; a synced close is never re-sent', async () => {
    const w = world();
    const journal = journalOf();
    await closeOffline(w, journal);
    await sweep(w, journal);
    expect(w.server.state.calls).toHaveLength(1);
    // The cashier's next shift, also closed offline (the server now holds that shift).
    w.server.state.doc = serverShift([], { id: 'shift-2' });
    w.server.state.record = null;
    const secondSales = SALES.map((s) => ({ ...s, id: `${s.id}-b`, shiftId: 'shift-2' }) as LocalSale);
    const second = deriveShiftDrawer(baseShift([], { id: 'shift-2' }), secondSales);
    const deps = closeDeps(w, journal)(second);
    (deps.authoritativeClose as { sales: LocalSale[] }).sales = secondSales;
    expect((await closeShift(second, 1500.3, '', deps)).authoritativeDeferred).toBe(true);
    expect(await entryOf(journal, 'shift-2')).toMatchObject({ closeCorrelationId: UUID_B, closeProtocol: 'server_authoritative_v1' });
    const results = await runShiftCloseReconciliationSweep(sweepDeps(w, journal));
    expect(results.find((r) => r.shiftId === 'shift-2')).toMatchObject({ deferred: 'confirmed' });
    expect(w.server.state.calls.map((c) => [c.request.shiftId, c.request.closeCorrelationId])).toEqual([
      ['shift-1', UUID_A],
      ['shift-2', UUID_B],
    ]);
    expect(w.server.state.commits).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('023-F Gate OFF regression and store validation', () => {
  test('gate OFF: the legacy offline close is unchanged and its entry is reconciled by the doc path — the callable is never invoked', async () => {
    const w = world();
    const journal = journalOf();
    const shift = drawer();
    const offDeps = { ...closeDeps(w, journal)(shift) } as Record<string, unknown>;
    delete offDeps.authoritativeCloseGate;
    const result = await closeShift(shift, 1500.3, '', offDeps as CloseShiftDeps);
    expect(result.authoritativeDeferred).toBeUndefined();
    expect(fs.updateDoc).toHaveBeenCalledTimes(1);
    await sweep(w, journal);
    expect(w.server.state.calls).toEqual([]);
  });

  test('a present but malformed closeProtocol, or a deferred entry without a correlation id, makes the record unreadable (fail closed)', async () => {
    const base = {
      shiftId: 'shift-x', branchId: 'B', staffId: 'S', staffName: 'N', startingCash: 0, expectedCash: 0, expectedQr: 0, expectedKbank: 0,
      expectedCard: 0, expectedCredit: 0, payInTotal: 0, payOutTotal: 0, totalBills: 0, actualCashCount: 0, variance: 0, note: '',
      deviceId: 'DEV1', closedAtLocal: 1, closeCorrelationId: UUID_A, status: 'local_closed_pending', createdAtLocal: 1, updatedAtLocal: 1,
      lastErrorMessage: null,
    };
    for (const bad of [{ ...base, closeProtocol: 'server_authoritative_v2' }, { ...base, closeProtocol: 'server_authoritative_v1', closeCorrelationId: null }]) {
      const store = createInMemoryShiftCloseIntentStore();
      await store.transact(['shiftCloseIntents'], 'readwrite', async (txn) => txn.put('shiftCloseIntents', 'shift-x', bad));
      const j = createInMemoryShiftCloseIntentJournal({ store });
      expect((await j.getCloseIntent('shift-x')).ok).toBe(false);
      expect((await j.listCloseIntents()).ok).toBe(false);
    }
  });

  test('a deferred record needs a secure correlation id: none available ⇒ nothing written (store unavailable)', async () => {
    const j = createInMemoryShiftCloseIntentJournal({ generateCloseCorrelationId: () => null });
    const snapshot = {
      shiftId: 'shift-x', branchId: 'B', staffId: 'S', staffName: 'N', startingCash: 0, expectedCash: 0, expectedQr: 0, expectedKbank: 0,
      expectedCard: 0, expectedCredit: 0, payInTotal: 0, payOutTotal: 0, totalBills: 0, actualCashCount: 0, variance: 0, note: '', deviceId: 'DEV1',
    };
    expect(await j.upsertCloseIntent(snapshot, undefined, undefined, { closeProtocol: 'server_authoritative_v1' })).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await j.getCloseIntent('shift-x')).toEqual({ ok: true, value: undefined });
  });
});
