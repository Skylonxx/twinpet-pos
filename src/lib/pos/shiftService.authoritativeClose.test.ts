// @vitest-environment jsdom
// Return/Refund V1 packet 014 — the staged (default-OFF) server-authoritative
// close adapter in `closeShift`, end to end over:
//   - the REAL IndexedDB-backed close journal (`fake-indexeddb`; a "restart" /
//     "second window" is a new journal instance over the same database);
//   - a FAITHFUL in-memory `closeShiftAuthoritative`: the request is JSON
//     round-tripped like a callable payload and decided by the PRODUCTION
//     server core (functions/src/closeShiftAuthoritativeCore.ts: request
//     validation, strict cash fold, Return refund audit, W3 plan, replay,
//     canonical response) — only the Admin transaction / auth I/O is modelled;
//   - a client-W3 tripwire: any legacy close transaction or `updateDoc` of the
//     shift is recorded, so every ON case can assert ZERO client W3.
// The real-emulator path is rules-tests/shift-close-authoritative-client.spec.ts.
//
// Provenance: this file imports only symbols that exist at the parent commit
// (7194494) and passes the new deps by name, so on the parent every ON case
// runs the legacy close and fails on BEHAVIOUR (client W3 / no callable /
// offline intent), never on a missing import. Messages are literal fragments.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Shift, ShiftCashEntry } from '../types';
import type { LocalSale } from './localLedger';
import { deriveShiftDrawer } from './shiftLedger';
import {
  SHIFT_CLOSE_INTENT_DB_NAME,
  createShiftCloseIntentJournal,
  type ShiftCloseIntentJournal,
} from './offline/shiftCloseIntentStore';
import {
  recoverOnlineCloseAttempt,
  runShiftCloseReconciliationSweep,
  shiftCloseAttentionKey,
  shiftCloseConfirmationDocFromData,
  shiftCloseNormalizationIssue,
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
  cacheDoc: { status: 'open', cashEntries: [] } as Record<string, unknown> | null,
  updateDoc: vi.fn(),
  runTransaction: vi.fn(),
  getDocFromServer: vi.fn(),
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    doc: vi.fn(() => ({ id: 'shift-1' })),
    getDocFromCache: vi.fn(async () => ({ exists: () => fs.cacheDoc !== null, data: () => fs.cacheDoc ?? undefined })),
    updateDoc: fs.updateDoc,
    runTransaction: fs.runTransaction,
    getDocFromServer: fs.getDocFromServer,
  };
});

vi.mock('./deviceId', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./deviceId')>();
  return { ...actual, getDeviceId: vi.fn(() => 'DEV1') };
});

import * as authClient from './shiftCloseAuthoritativeClient';
import { closeShift as closeShiftReal, type CloseShiftDeps, type ShiftCloseTransactionRunner } from './shiftService';

/**
 * Packet 015 (F2): the ON close takes the operator-reviewed drawer witness of the
 * display the cashier confirmed. The shift an existing test passes IS that
 * display (the modal passes its `displayShift`), so the witness is derived from
 * it here unless a test sets `authoritativeClose.reviewedDrawer` itself (any
 * value, even `undefined`). On the parent commit the builder does not exist and
 * nothing is injected — the behaviour under test is unchanged.
 */
function closeShift(shift: Shift, count: number, note: string, deps?: CloseShiftDeps) {
  const ac = (deps as { authoritativeClose?: Record<string, unknown> } | undefined)?.authoritativeClose;
  const build = (authClient as unknown as { buildReviewedDrawerWitness?: (s: Shift, refresh: string) => unknown })
    .buildReviewedDrawerWitness;
  if (deps?.authoritativeCloseGate && ac && !('reviewedDrawer' in ac) && build) {
    deps = { ...deps, authoritativeClose: { ...ac, reviewedDrawer: build(shift, 'loaded') } } as CloseShiftDeps;
  }
  return closeShiftReal(shift, count, note, deps);
}

// ── Literal message fragments (the constants are new in 014) ──
const M = {
  offline: 'ปิดกะได้เฉพาะเมื่อเชื่อมต่ออินเทอร์เน็ตเท่านั้น',
  ledger: 'ยอดขายในบิลของกะนี้มีจำนวนเงินที่ไม่ใช่จำนวนสตางค์ที่ถูกต้อง',
  drawerInconsistent: 'ยอดขายที่รวมจากบิลไม่ตรงกับยอดที่แสดง',
  count: 'จำนวนเงินสดที่นับได้ต้องเป็นจำนวนเงินที่มีทศนิยมไม่เกิน 2 ตำแหน่ง',
  note: 'หมายเหตุยาวเกิน 1000 ตัวอักษร',
  salesUnavailable: 'ไม่สามารถรวมยอดขายของกะนี้จากบิลในเครื่องได้',
  localPending: 'มีการปิดกะของกะนี้ค้างอยู่ในเครื่องนี้',
  requestChanged: 'ระบบไม่ส่งยอดชุดใหม่ซ้ำ',
  drawerChanged: 'รายการเงินสดของกะบนเซิร์ฟเวอร์เปลี่ยนไปหลังจากส่งปิดกะครั้งก่อน',
  resultMismatch: 'เซิร์ฟเวอร์ปิดกะแล้ว แต่ยอดที่บันทึกไม่ตรงกับยอดที่เครื่องนี้ส่งไป',
  localCashMissing: 'รายการนำเงินเข้า/ออกของเครื่องนี้ยังไม่อยู่บนเซิร์ฟเวอร์',
  /** existing CLOSE_SHIFT_TX_FAILED_MESSAGE */
  unknown: 'ยังยืนยันผลการปิดกะกับเซิร์ฟเวอร์ไม่ได้ (การเชื่อมต่อหรือการบันทึกขัดข้อง)',
  /** existing CLOSE_SHIFT_COMMITTED_NOT_FINALIZED_MESSAGE */
  notFinalized: 'ส่งการปิดกะถึงเซิร์ฟเวอร์แล้ว',
  /** existing CLOSE_SHIFT_ALREADY_CLOSED_MESSAGE */
  alreadyClosed: 'กะนี้ถูกปิดไปแล้ว',
  /** existing CLOSE_SHIFT_ONLINE_STORE_UNAVAILABLE_MESSAGE */
  store: 'บันทึกข้อมูลการปิดกะในเครื่องไม่สำเร็จ',
};

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const CLOSED_AT_MS = Date.parse('2026-10-22T10:00:00Z');
const CALLER = 'staff-1';

// ── Fixtures ──

function sale(id: string, payments: Array<{ method: string; amount: unknown }>, changeAmt: unknown = 0): LocalSale {
  return {
    id,
    billId: `R-${id}`,
    deviceId: 'DEV1',
    shiftId: 'shift-1',
    staffId: CALLER,
    staffName: 'ทดสอบ',
    customerId: null,
    status: 'completed',
    reconcileStatus: 'settled',
    total: 0,
    paidAmt: 0,
    changeAmt,
    creditAmt: 0,
    payments,
    pendingSync: false,
    clientCreatedAt: 1,
    occurredAt: 1,
    sortSeq: 1,
  } as unknown as LocalSale;
}

/** 1000 cash in three bills (one with change), the drawer the cashier sees = deriveShiftDrawer. */
const SALES_1000: LocalSale[] = [
  sale('s1', [{ method: 'cash', amount: 400 }]),
  sale('s2', [{ method: 'cash', amount: 500 }], 100),
  sale('s3', [{ method: 'cash', amount: 200 }]),
];

function baseShift(cashEntries: ShiftCashEntry[] = []): Shift {
  return {
    id: 'shift-1',
    branchId: 'LDP-001',
    staffId: CALLER,
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
  };
}

function drawer(sales: LocalSale[] = SALES_1000, cashEntries: ShiftCashEntry[] = []): Shift {
  return deriveShiftDrawer(baseShift(cashEntries), sales);
}

function serverShift(cashEntries: ShiftCashEntry[] = [], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'shift-1',
    branchId: 'LDP-001',
    staffId: CALLER,
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

// ── Faithful in-memory `closeShiftAuthoritative` (production decision core) ──

type AfterCommit = 'resolve' | 'throw' | 'unconfirmed';

function createAuthoritativeServer(initial: Record<string, unknown>) {
  const state = {
    doc: { ...initial } as Record<string, unknown>,
    record: null as Record<string, unknown> | null,
    refunds: [] as RawRecord[],
    returns: [] as RawRecord[],
    calls: [] as Array<Record<string, unknown>>,
    commits: 0,
    w4: 0,
    w4FailuresLeft: 0,
  };
  const hooks = {
    /** Runs inside the next call(s) after validation, before the transaction reads the shift. */
    beforeTx: null as null | ((call: number) => void),
    afterCommit: 'resolve' as AfterCommit,
    /** The next N calls fail at the transport before reaching the server (nothing runs). */
    transportFailuresLeft: 0,
    /** Replaces the response of the next call(s). */
    respond: null as null | ((real: unknown, call: number) => unknown),
    /** The next call is a definitive in-transaction refusal with this code (nothing written). */
    refuse: null as null | string,
  };

  async function callable(request: Record<string, unknown>): Promise<unknown> {
    const raw = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
    state.calls.push(raw);
    const n = state.calls.length;
    if (hooks.transportFailuresLeft > 0) {
      hooks.transportFailuresLeft -= 1;
      throw Object.assign(new Error('internal'), { code: 'functions/unavailable' });
    }
    const real = decide(raw, n);
    if (real === 'throw') throw Object.assign(new Error('deadline'), { code: 'functions/deadline-exceeded' });
    return hooks.respond ? hooks.respond(real, n) : real;
  }

  function decide(raw: Record<string, unknown>, n: number): unknown {
    const v = validateCloseShiftRequest(raw);
    if (!v.ok) return v;
    const request = v.value;
    const requestDigest = deriveCloseRequestDigest(request);
    hooks.beforeTx?.(n);
    if (hooks.refuse) {
      const code = hooks.refuse;
      hooks.refuse = null;
      return { ok: false, code };
    }
    const shiftData = state.doc;
    if (shiftData.staffId !== CALLER) return { ok: false, code: 'not_shift_owner' };
    if (shiftData.status === 'closed') {
      return decideClosedShiftReplay({ shiftData, record: state.record, request, requestDigest });
    }
    if (shiftData.status !== 'open') return { ok: false, code: 'shift_state_invalid' };
    if (state.record) return { ok: false, code: 'close_record_inconsistent' };
    const identity = parseOpenShiftIdentity(request.shiftId, shiftData);
    if (!identity.ok) return identity;
    const cash = foldShiftCashEntriesStrict(shiftData.cashEntries, 'cashEntries' in shiftData);
    if (!cash.ok) return cash;
    const audit = verifyRefundAudit({
      shift: identity.value,
      refunds: state.refunds,
      returns: state.returns,
      serverRefundEntries: cash.value.serverRefundEntries,
    });
    if (!audit.ok) return audit;
    const plan = planAuthoritativeClose({ shift: identity.value, request, cash: cash.value });
    if (!plan.ok) return plan;
    const closedAt = ts(CLOSED_AT_MS);
    state.doc = { ...shiftData, ...plan.value.w3Fields, closedAt };
    state.record = {
      ...buildAuthorityRecord({
        request,
        requestDigest,
        plan: plan.value,
        cash: cash.value,
        audit: audit.value,
        callerStaffId: CALLER,
        nowMillis: CLOSED_AT_MS,
      }),
      closedAt,
    };
    state.commits += 1;
    if (hooks.afterCommit === 'throw') return 'throw';
    if (hooks.afterCommit === 'unconfirmed') return { ok: false, code: 'committed_unconfirmed' };
    return canonicalResponseFromDurable({ shiftData: state.doc, record: state.record, idempotentReplay: false });
  }

  /** The production cash Return's shift + record effects (same commit). */
  function commitCashReturn(returnId: string, amount: number) {
    if (state.doc.status !== 'open') return 'shift_required' as const;
    const cashEntryId = deriveCashRefundEntryId(returnId);
    state.doc = {
      ...state.doc,
      cashEntries: [
        ...((state.doc.cashEntries as ShiftCashEntry[]) ?? []),
        { id: cashEntryId, type: 'pay_out', amount, note: 'คืนเงินสด', staffId: CALLER, staffName: 'ทดสอบ', at: 2 },
      ],
    };
    state.refunds.push({
      id: returnId,
      data: {
        schemaVersion: SALE_RETURN_SCHEMA_VERSION,
        refundId: returnId,
        returnId,
        method: 'cash',
        executionMode: 'cash_drawer',
        shiftId: 'shift-1',
        branchId: 'LDP-001',
        requesterStaffId: CALLER,
        cashEntryId,
        amount,
      },
    });
    state.returns.push({
      id: returnId,
      data: {
        schemaVersion: SALE_RETURN_SCHEMA_VERSION,
        returnId,
        status: 'completed',
        branchId: 'LDP-001',
        requesterStaffId: CALLER,
        refund: { method: 'cash', refundId: returnId, shiftId: 'shift-1', cashEntryId, amount },
      },
    });
    return 'committed' as const;
  }

  const readConfirmation: ShiftCloseConfirmationReader = async () => ({
    ok: true,
    doc: shiftCloseConfirmationDocFromData({ ...state.doc }),
  });
  const readServerShift = async () => ({ ok: true as const, exists: true as const, data: structuredCloneDoc(state.doc) });
  const normalizeSyncState = async () => {
    if (state.w4FailuresLeft > 0) {
      state.w4FailuresLeft -= 1;
      throw Object.assign(new Error('W4 unavailable'), { code: 'unavailable' });
    }
    if (state.doc.syncState === 'synced') return 'already_synced' as const;
    state.doc = { ...state.doc, syncState: 'synced' };
    state.w4 += 1;
    return 'written' as const;
  };
  return { state, hooks, callable, commitCashReturn, readConfirmation, readServerShift, normalizeSyncState };
}

function structuredCloneDoc(d: Record<string, unknown>): Record<string, unknown> {
  return { ...d, cashEntries: Array.isArray(d.cashEntries) ? (d.cashEntries as unknown[]).map((e) => ({ ...(e as object) })) : d.cashEntries };
}

type Server = ReturnType<typeof createAuthoritativeServer>;

/** Client-W3 tripwire: a legacy close transaction that would write the W3 itself. */
function legacyW3Tripwire(server: Server) {
  const calls: Array<Record<string, unknown>> = [];
  const run: ShiftCloseTransactionRunner = async (_id, fn) =>
    fn({
      get: async () => ({ exists: true, data: structuredCloneDoc(server.state.doc) }),
      update: (payload) => {
        calls.push(payload);
        server.state.doc = { ...server.state.doc, ...payload, closedAt: ts(CLOSED_AT_MS) };
      },
    });
  return { calls, run };
}

function bootJournal(ids: string[] = [UUID_A, UUID_B, UUID_C]): ShiftCloseIntentJournal {
  return createShiftCloseIntentJournal({ generateCloseCorrelationId: () => ids.shift() ?? null });
}

type Harness = { server: Server; tripwire: ReturnType<typeof legacyW3Tripwire>; clear: ReturnType<typeof vi.fn> };

function harness(initial = serverShift()): Harness {
  const server = createAuthoritativeServer(initial);
  return { server, tripwire: legacyW3Tripwire(server), clear: vi.fn() };
}

function onDeps(h: Harness, journal: ShiftCloseIntentJournal, extra: Record<string, unknown> = {}, sales: LocalSale[] = SALES_1000): CloseShiftDeps {
  return {
    journal,
    isOnline: () => true,
    serverCashPending: { has: () => false, clear: h.clear },
    runCloseTransaction: h.tripwire.run,
    waitForQueuedWrites: async () => true,
    readConfirmation: h.server.readConfirmation,
    normalizeSyncState: h.server.normalizeSyncState,
    authoritativeCloseGate: true,
    authoritativeClose: { sales, callable: h.server.callable, readServerShift: h.server.readServerShift },
    ...extra,
  } as CloseShiftDeps;
}

/** The same deps with the TEST-ONLY gate override removed: the hardcoded (OFF) gate decides. */
function gateOff(d: CloseShiftDeps): CloseShiftDeps {
  const copy = { ...d } as Record<string, unknown>;
  delete copy.authoritativeCloseGate;
  return copy as CloseShiftDeps;
}

async function attemptsOf(journal: ShiftCloseIntentJournal) {
  const listed = await journal.listOnlineCloseAttempts();
  if (!listed.ok) throw new Error(`listOnlineCloseAttempts ${listed.code}`);
  return listed.value as Array<Record<string, unknown>>;
}

async function entryOf(journal: ShiftCloseIntentJournal) {
  const got = await journal.getCloseIntent('shift-1');
  if (!got.ok) throw new Error(`getCloseIntent ${got.code}`);
  return got.value;
}

/** Every ON negative case: no client W3, no updateDoc, no journal entry (no Z source). */
async function expectNoClientW3NoZ(h: Harness, journal: ShiftCloseIntentJournal) {
  expect(h.tripwire.calls).toEqual([]);
  expect(fs.updateDoc).not.toHaveBeenCalled();
  expect(fs.runTransaction).not.toHaveBeenCalled();
  expect(await entryOf(journal)).toBeUndefined();
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
  fs.cacheDoc = { status: 'open', cashEntries: [] };
  fs.updateDoc.mockReset();
  fs.updateDoc.mockResolvedValue(undefined);
  fs.runTransaction.mockReset();
  fs.getDocFromServer.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
describe('014-A gate / cutover', () => {
  test('OFF (no gate override): the legacy online close runs — the callable is never invoked', async () => {
    const h = harness();
    const journal = bootJournal();
    const result = await closeShift(drawer(), 1500, '', gateOff(onDeps(h, journal)));
    expect(h.server.state.calls).toEqual([]);
    expect(h.tripwire.calls).toHaveLength(1); // the legacy client W3, unchanged
    expect(result).toMatchObject({ status: 'closed', variance: 0 });
  });

  test('OFF offline: the legacy offline close (intent + queued updateDoc) is unchanged — no callable', async () => {
    const h = harness();
    const journal = bootJournal();
    const result = await closeShift(drawer(), 1500, '', gateOff(onDeps(h, journal, { isOnline: () => false })));
    expect(h.server.state.calls).toEqual([]);
    expect(fs.updateDoc).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'closed', syncState: 'pending' });
    expect((await entryOf(journal))?.status).toBe('local_closed_pending');
  });

  test('ON online: the callable writes the W3; ZERO client W3; Z only after proof + finalize', async () => {
    const h = harness();
    const journal = bootJournal();
    const result = await closeShift(drawer(), 1500, 'ok', onDeps(h, journal));
    expect(h.server.state.calls).toHaveLength(1);
    expect(h.server.state.commits).toBe(1);
    await expectNoW3(h);
    expect(result).toMatchObject({ status: 'closed', expectedCash: 1000, payOutTotal: 0, variance: 0, note: 'ok' });
    const entry = await entryOf(journal);
    expect(entry).toMatchObject({ closeCorrelationId: UUID_A, actualCashCount: 1500, payOutTotal: 0 });
    expect(['local_closed_pending', 'synced']).toContain(entry?.status); // the reconcile may already have run
    expect(await attemptsOf(journal)).toEqual([]); // consumed by the 007-B finalize
    await expect(result.whenServerConfirmed).resolves.toMatchObject({ outcome: 'confirmed' });
    expect((await entryOf(journal))?.status).toBe('synced');
    expect(h.server.state.doc.syncState).toBe('synced'); // W4 (not W3) by the existing normalizer
    expect(h.clear).toHaveBeenCalledWith('shift-1');
  });

  test('ON offline: refused BEFORE any intent / attempt / queued write / guard change / callable / Z', async () => {
    const h = harness();
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal, { isOnline: () => false }))).rejects.toThrow(M.offline);
    await expectNoClientW3NoZ(h, journal);
    expect(await attemptsOf(journal)).toEqual([]);
    expect(h.server.state.calls).toEqual([]);
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.server.state.doc.status).toBe('open');
  });

  test('ON callable throws (transport) and the shift is still open: unknown outcome, NO fallback W3, attempt kept', async () => {
    const h = harness();
    h.server.hooks.transportFailuresLeft = 1;
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(M.unknown);
    await expectNoClientW3NoZ(h, journal);
    const [attempt] = await attemptsOf(journal);
    expect(attempt).toMatchObject({ closeCorrelationId: UUID_A });
    expect('commitObservedAtLocal' in attempt!).toBe(false);
    expect(h.server.state.doc.status).toBe('open');
    expect(h.clear).not.toHaveBeenCalled();
  });

  test('ON without the ledger sales: fails closed (never a legacy fallback)', async () => {
    const h = harness();
    const journal = bootJournal();
    const d = onDeps(h, journal);
    (d as { authoritativeClose: Record<string, unknown> }).authoritativeClose = { callable: h.server.callable };
    await expect(closeShift(drawer(), 1500, '', d)).rejects.toThrow(M.salesUnavailable);
    await expectNoClientW3NoZ(h, journal);
    expect(h.server.state.calls).toEqual([]);
  });
});

async function expectNoW3(h: Harness) {
  expect(h.tripwire.calls).toEqual([]);
  expect(fs.updateDoc).not.toHaveBeenCalled();
  expect(fs.runTransaction).not.toHaveBeenCalled();
}

// ─────────────────────────────────────────────────────────────────────────
describe('014-B exact money', () => {
  test('canonical 0.1 + 0.2 per-sale lines ⇒ the request carries exactly 0.3 (integer-satang fold)', async () => {
    const sales = [sale('a', [{ method: 'cash', amount: 0.1 }]), sale('b', [{ method: 'cash', amount: 0.2 }])];
    const h = harness();
    const journal = bootJournal();
    const shown = drawer(sales);
    expect(shown.expectedCash).toBe(0.3); // the drawer the cashier sees (roundMoney)
    const result = await closeShift(shown, 500.3, '', onDeps(h, journal, {}, sales));
    const sent = h.server.state.calls[0]!.attestedSales as Record<string, number>;
    expect(sent.expectedCash).toBe(0.3);
    expect(Object.is(sent.expectedCash, 0.1 + 0.2)).toBe(false);
    expect(result).toMatchObject({ expectedCash: 0.3, variance: 0 });
  });

  test('every attested field is the canonical minor / 100 (qr / kbank / card / credit / bills), large valid values', async () => {
    const sales = [
      sale('a', [{ method: 'cash', amount: 9_999_999.99 }, { method: 'qr', amount: 1234.56 }]),
      sale('b', [{ method: 'kbank', amount: 0.07 }, { method: 'card', amount: 8_888_888.88 }], 0),
      sale('c', [{ method: 'credit', amount: 19.99 }, { method: 'cash', amount: 100 }], 0.01),
    ];
    const h = harness();
    const journal = bootJournal();
    await closeShift(drawer(sales), 500 + 9_999_999.99 + 99.99, '', onDeps(h, journal, {}, sales));
    expect(h.server.state.calls[0]!.attestedSales).toEqual({
      expectedCash: 10_000_099.98,
      expectedQr: 1234.56,
      expectedKbank: 0.07,
      expectedCard: 8_888_888.88,
      expectedCredit: 19.99,
      totalBills: 3,
    });
    expect(h.server.state.commits).toBe(1);
  });

  test.each([
    ['81.000000001', [sale('a', [{ method: 'cash', amount: 81.000000001 }])]],
    ['0.010000001', [sale('a', [{ method: 'qr', amount: 0.010000001 }])]],
    ['NaN', [sale('a', [{ method: 'cash', amount: Number.NaN }])]],
    ['Infinity', [sale('a', [{ method: 'card', amount: Number.POSITIVE_INFINITY }])]],
    ['negative', [sale('a', [{ method: 'cash', amount: -5 }])]],
    ['string amount', [sale('a', [{ method: 'cash', amount: '10' }])]],
    ['unbounded', [sale('a', [{ method: 'cash', amount: 1e11 }])]],
    ['off-cent change', [sale('a', [{ method: 'cash', amount: 100 }], 0.005)]],
    ['missing change', [{ ...sale('a', [{ method: 'cash', amount: 100 }]), changeAmt: undefined } as unknown as LocalSale]],
    ['missing payments', [{ ...sale('a', []), payments: undefined } as unknown as LocalSale]],
    ['unknown method', [sale('a', [{ method: 'voucher', amount: 10 }])]],
    ['sale of another shift', [{ ...sale('a', [{ method: 'cash', amount: 10 }]), shiftId: 'shift-0' }]],
    ['repeated sale id', [sale('a', [{ method: 'cash', amount: 10 }]), sale('a', [{ method: 'cash', amount: 10 }])]],
  ])('ledger line %s ⇒ refused before anything durable or remote (never rounded into a close)', async (_label, sales) => {
    const h = harness();
    const journal = bootJournal();
    const shown = { ...baseShift(), expectedCash: 10 };
    await expect(closeShift(shown, 510, '', onDeps(h, journal, {}, sales as LocalSale[]))).rejects.toThrow(M.ledger);
    expect(h.server.state.calls).toEqual([]);
    expect(await attemptsOf(journal)).toEqual([]);
    await expectNoClientW3NoZ(h, journal);
  });

  test('a raw float aggregate (0.1 + 0.2) on the shown drawer is never forwarded', async () => {
    const sales = [sale('a', [{ method: 'cash', amount: 0.1 }]), sale('b', [{ method: 'cash', amount: 0.2 }])];
    const h = harness();
    const journal = bootJournal();
    const raw = { ...drawer(sales), expectedCash: 0.1 + 0.2 };
    await expect(closeShift(raw, 500.3, '', onDeps(h, journal, {}, sales))).rejects.toThrow(M.drawerInconsistent);
    expect(h.server.state.calls).toEqual([]);
    await expectNoClientW3NoZ(h, journal);
  });

  test('off-cent count / over-long note ⇒ Thai refusal before the call', async () => {
    const h = harness();
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500.005, '', onDeps(h, journal))).rejects.toThrow(M.count);
    await expect(closeShift(drawer(), 1500, 'x'.repeat(1001), onDeps(h, journal))).rejects.toThrow(M.note);
    expect(h.server.state.calls).toEqual([]);
    await expectNoClientW3NoZ(h, journal);
  });

  test('the request is the exact v1 key set — no branch / staff / role / payIn / payOut / variance / startingCash', async () => {
    const h = harness();
    const journal = bootJournal();
    await closeShift(drawer(), 1500, '', onDeps(h, journal));
    const req = h.server.state.calls[0]!;
    expect(Object.keys(req).sort()).toEqual(
      ['actualCashCount', 'attestedSales', 'closeCorrelationId', 'contractVersion', 'deviceId', 'note', 'shiftId'].sort(),
    );
    expect(req).toMatchObject({ contractVersion: 1, shiftId: 'shift-1', closeCorrelationId: UUID_A, deviceId: 'DEV1' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('014-C Return / close', () => {
  const RFD = { id: 'rfd_ret1', type: 'pay_out' as const, amount: 81, note: 'คืนเงินสด', staffId: CALLER, staffName: 'ทดสอบ', at: 2 };

  test('a cash Return 81 before the close: payOutTotal 81, drawer 1419 (500 + 1000 − 81), count 1419 ⇒ variance 0', async () => {
    const h = harness();
    expect(h.server.commitCashReturn('ret1', 81)).toBe('committed');
    fs.cacheDoc = { status: 'open', cashEntries: [RFD] };
    const journal = bootJournal();
    const result = await closeShift(drawer(SALES_1000, [RFD]), 1419, '', onDeps(h, journal));
    expect(result).toMatchObject({ payOutTotal: 81, payInTotal: 0, expectedCash: 1000, startingCash: 500, actualCashCount: 1419, variance: 0 });
    expect(h.server.state.record).toMatchObject({
      money: { expectedDrawerMinor: 141_900, payOutMinor: 8100, varianceMinor: 0 },
      cashAudit: { refundCount: 1, refundTotalMinor: 8100 },
    });
    expect(await entryOf(journal)).toMatchObject({ payOutTotal: 81, variance: 0, closeCorrelationId: UUID_A });
    await expectNoW3(h);
  });

  test('a Return between the pre-call read and the server commit is NOT adopted: no Z, attempt kept, sweep = manual attention', async () => {
    const h = harness();
    h.server.hooks.beforeTx = (call) => {
      if (call === 1) h.server.commitCashReturn('ret1', 81);
    };
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(M.resultMismatch);
    expect(h.server.state.commits).toBe(1);
    expect(h.server.state.doc).toMatchObject({ status: 'closed', payOutTotal: 81, closeCorrelationId: UUID_A });
    await expectNoClientW3NoZ(h, journal);
    const [attempt] = await attemptsOf(journal);
    expect('commitObservedAtLocal' in attempt!).toBe(true);
    // The bound expectation is unchanged — never rewritten to fit the server.
    expect((attempt!.authoritative as { expected: { payOutTotal: number; variance: number } }).expected).toMatchObject({
      payOutTotal: 0,
      variance: 0,
    });
    expect(h.clear).not.toHaveBeenCalled();

    // The boot / reconnect sweep cannot adopt it either (007-B finalize re-checks the expectation).
    const swept = await runShiftCloseReconciliationSweep({
      journal,
      readConfirmation: h.server.readConfirmation,
      normalizeSyncState: h.server.normalizeSyncState,
      deviceId: 'DEV1',
    });
    expect(swept.normalization.status).not.toBe('ok');
    expect(shiftCloseNormalizationIssue(swept.normalization)).toContain('attempt_manual_attention');
    expect(await entryOf(journal)).toBeUndefined();

    // A retry (same id, same body) replays the committed close: still no Z, no second W3.
    await expect(closeShift(drawer(), 1500, '', onDeps(h, bootJournal()))).rejects.toThrow(M.resultMismatch);
    expect(h.server.state.commits).toBe(1);
    expect(h.server.state.calls.map((c) => c.closeCorrelationId)).toEqual([UUID_A, UUID_A]);
    await expectNoClientW3NoZ(h, journal);
  });

  test('a Return after the attempt was bound but before a retry: refused before any call (drawer changed)', async () => {
    const h = harness();
    h.server.hooks.transportFailuresLeft = 1;
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(M.unknown);
    h.server.commitCashReturn('ret1', 81);
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(M.drawerChanged);
    expect(h.server.state.calls).toHaveLength(1);
    expect(h.server.state.doc.status).toBe('open');
    await expectNoClientW3NoZ(h, journal);
  });

  test('a local cash entry the server does not hold refuses before the attempt (server folds only what it has)', async () => {
    const h = harness();
    const journal = bootJournal();
    const local = { id: 'cash-x', type: 'pay_in' as const, amount: 50, note: 'n', staffId: CALLER, staffName: 'ทดสอบ', at: 3 };
    await expect(closeShift(drawer(SALES_1000, [local]), 1550, '', onDeps(h, journal))).rejects.toThrow(M.localCashMissing);
    expect(h.server.state.calls).toEqual([]);
    expect(await attemptsOf(journal)).toEqual([]);
    await expectNoClientW3NoZ(h, journal);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('014-D durability', () => {
  test('lost response after the commit: probe → same-id same-body replay → Z; ONE server commit', async () => {
    const h = harness();
    h.server.hooks.afterCommit = 'throw';
    const journal = bootJournal();
    // The replay hits the closed shift (decideClosedShiftReplay): nothing is committed again.
    const result = await closeShift(drawer(), 1500, '', onDeps(h, journal));
    expect(result).toMatchObject({ status: 'closed', variance: 0 });
    expect(h.server.state.commits).toBe(1);
    expect(h.server.state.calls).toHaveLength(2);
    expect(h.server.state.calls[0]).toEqual(h.server.state.calls[1]);
    expect(await entryOf(journal)).toMatchObject({ closeCorrelationId: UUID_A });
    await expectNoW3(h);
  });

  test('timeout + restart: the durable attempt keeps the SAME id and body across a new process', async () => {
    const h = harness();
    h.server.hooks.afterCommit = 'throw';
    h.server.hooks.respond = (real, n) => (n === 2 ? (() => { throw new Error('still offline'); })() : real);
    const first = bootJournal([UUID_A]);
    await expect(closeShift(drawer(), 1500, '', onDeps(h, first))).rejects.toThrow(M.notFinalized);
    expect(h.server.state.commits).toBe(1);
    expect('commitObservedAtLocal' in (await attemptsOf(first))[0]!).toBe(true);
    // Restart: a new journal over the same IndexedDB; its id generator would mint UUID_B.
    h.server.hooks.respond = null;
    h.server.hooks.afterCommit = 'resolve';
    const second = bootJournal([UUID_B]);
    const result = await closeShift(drawer(), 1500, '', onDeps(h, second));
    expect(result).toMatchObject({ status: 'closed' });
    expect(new Set(h.server.state.calls.map((c) => c.closeCorrelationId))).toEqual(new Set([UUID_A]));
    expect(h.server.state.commits).toBe(1);
    expect(await entryOf(second)).toMatchObject({ closeCorrelationId: UUID_A });
    await expectNoW3(h);
  });

  test('double click / two windows: one prepared attempt, one id, one server commit, one journal entry', async () => {
    const h = harness();
    const w1 = bootJournal([UUID_A]);
    const w2 = bootJournal([UUID_B]);
    const [r1, r2] = await Promise.allSettled([
      closeShift(drawer(), 1500, '', onDeps(h, w1)),
      closeShift(drawer(), 1500, '', onDeps(h, w2)),
    ]);
    expect(h.server.state.commits).toBe(1);
    expect(new Set(h.server.state.calls.map((c) => c.closeCorrelationId)).size).toBe(1);
    expect([r1.status, r2.status]).toContain('fulfilled');
    const entry = await entryOf(w1);
    expect(entry?.closeCorrelationId).toBe(h.server.state.calls[0]!.closeCorrelationId);
    expect(await attemptsOf(w1)).toEqual([]);
    await expectNoW3(h);
  });

  test('a changed request under the same unresolved id is refused — never sent', async () => {
    const h = harness();
    h.server.hooks.transportFailuresLeft = 1;
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, 'a', onDeps(h, journal))).rejects.toThrow(M.unknown);
    await expect(closeShift(drawer(), 1499, 'a', onDeps(h, journal))).rejects.toThrow(M.requestChanged);
    await expect(closeShift(drawer(), 1500, 'b', onDeps(h, journal))).rejects.toThrow(M.requestChanged);
    const moreSales = [...SALES_1000, sale('s4', [{ method: 'cash', amount: 1 }])];
    await expect(closeShift(drawer(moreSales), 1500, 'a', onDeps(h, journal, {}, moreSales))).rejects.toThrow(M.requestChanged);
    expect(h.server.state.calls).toHaveLength(1);
    // The same values are retried with the same id.
    await closeShift(drawer(), 1500, 'a', onDeps(h, journal));
    expect(h.server.state.calls.map((c) => c.closeCorrelationId)).toEqual([UUID_A, UUID_A]);
    expect(h.server.state.commits).toBe(1);
  });

  test('server success + IndexedDB finalize abort ⇒ no Z, journal/attempt preserved; restart retry finalizes with NO second W3', async () => {
    const h = harness();
    const journal = bootJournal([UUID_A]);
    const broken: ShiftCloseIntentJournal = {
      ...journal,
      finalizeOnlineClose: async () => ({ ok: false, code: 'tx_failed', message: 'AbortError' }),
    };
    await expect(closeShift(drawer(), 1500, '', onDeps(h, broken))).rejects.toThrow(M.notFinalized);
    expect(h.server.state.commits).toBe(1);
    await expectNoClientW3NoZ(h, journal);
    expect('commitObservedAtLocal' in (await attemptsOf(journal))[0]!).toBe(true);
    expect(h.clear).not.toHaveBeenCalled();
    const result = await closeShift(drawer(), 1500, '', onDeps(h, bootJournal([UUID_B])));
    expect(result).toMatchObject({ status: 'closed' });
    expect(h.server.state.commits).toBe(1);
    expect(h.server.state.calls.map((c) => c.closeCorrelationId)).toEqual([UUID_A, UUID_A]);
    await expectNoW3(h);
  });

  test('the authoritative proof read fails after ok:true ⇒ no Z, attempt commit-observed', async () => {
    const h = harness();
    const journal = bootJournal();
    await expect(
      closeShift(drawer(), 1500, '', onDeps(h, journal, { readConfirmation: async () => ({ ok: false }) })),
    ).rejects.toThrow(M.notFinalized);
    await expectNoClientW3NoZ(h, journal);
    expect('commitObservedAtLocal' in (await attemptsOf(journal))[0]!).toBe(true);
  });

  test('a legacy (transaction) attempt, a tombstone, or an offline-queued close of the shift ⇒ no call, no Z', async () => {
    // Legacy attempt of this shift (prepared by the OFF close): never reinterpreted.
    const h1 = harness();
    const j1 = bootJournal();
    await j1.prepareOnlineCloseAttempt({ shiftId: 'shift-1', branchId: 'LDP-001', staffId: CALLER, staffName: 'ทดสอบ', deviceId: 'DEV1' });
    await expect(closeShift(drawer(), 1500, '', onDeps(h1, j1))).rejects.toThrow(M.localPending);
    expect(h1.server.state.calls).toEqual([]);
    await expectNoClientW3NoZ(h1, j1);
    await deleteDb();

    // Offline-queued legacy close (journal entry, W3 not yet on the server).
    const h2 = harness();
    const j2 = bootJournal();
    await closeShift(drawer(), 1500, '', gateOff(onDeps(h2, j2, { isOnline: () => false })));
    fs.updateDoc.mockClear();
    await expect(closeShift(drawer(), 1500, '', onDeps(h2, j2))).rejects.toThrow(M.localPending);
    expect(h2.server.state.calls).toEqual([]);
    expect(fs.updateDoc).not.toHaveBeenCalled();
    expect(h2.server.state.doc.status).toBe('open');
  });

  test('a superseded (tombstoned) server-authoritative attempt ⇒ "already closed", no call, no Z', async () => {
    const h = harness();
    h.server.hooks.transportFailuresLeft = 1;
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(M.unknown);
    expect(await journal.supersedeOnlineCloseAttempt('shift-1', UUID_A)).toEqual({ ok: true, value: 'superseded' });
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(M.alreadyClosed);
    expect(h.server.state.calls).toHaveLength(1);
    await expectNoClientW3NoZ(h, journal);
  });

  test('the 007-B finalizer refuses (attempt missing) after a proven commit ⇒ no Z, custody recorded', async () => {
    const h = harness();
    const journal = bootJournal();
    const refusing: ShiftCloseIntentJournal = {
      ...journal,
      finalizeOnlineClose: async () => ({ ok: false, code: 'conflict', reason: 'attempt_missing', message: 'gone' }),
    };
    await expect(closeShift(drawer(), 1500, '', onDeps(h, refusing))).rejects.toThrow('ยังยืนยันยอดปิดกะนี้กับเซิร์ฟเวอร์ไม่ได้');
    expect(h.server.state.commits).toBe(1);
    await expectNoClientW3NoZ(h, journal);
    expect('commitObservedAtLocal' in (await attemptsOf(journal))[0]!).toBe(true);
  });

  test('prepare store failure ⇒ refused with nothing sent', async () => {
    const h = harness();
    const journal = bootJournal();
    const broken: ShiftCloseIntentJournal = {
      ...journal,
      prepareOnlineCloseAttempt: async () => ({ ok: false, code: 'unavailable', message: 'IndexedDB unavailable' }),
    };
    await expect(closeShift(drawer(), 1500, '', onDeps(h, broken))).rejects.toThrow(M.store);
    expect(h.server.state.calls).toEqual([]);
    await expectNoClientW3NoZ(h, journal);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('014-E server result variants', () => {
  test.each([
    ['refund_audit_unavailable', 'รหัส: refund_audit_unavailable'],
    ['not_shift_owner', 'รหัส: not_shift_owner'],
    ['session_stale', 'รหัส: session_stale'],
  ])('definitive ok:false %s ⇒ typed Thai copy, no Z, attempt kept (not commit-observed); same values retry the same id', async (code, copy) => {
    const h = harness();
    h.server.hooks.refuse = code;
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(copy);
    await expectNoClientW3NoZ(h, journal);
    const [attempt] = await attemptsOf(journal);
    expect('commitObservedAtLocal' in attempt!).toBe(false);
    await closeShift(drawer(), 1500, '', onDeps(h, journal));
    expect(h.server.state.calls.map((c) => c.closeCorrelationId)).toEqual([UUID_A, UUID_A]);
  });

  test('a refusal on the REPLAY of a known commit is never worded "not closed": no Z, custody kept', async () => {
    const h = harness();
    h.server.hooks.afterCommit = 'throw';
    h.server.hooks.beforeTx = (call) => {
      if (call === 2) h.server.hooks.refuse = 'close_record_inconsistent';
    };
    const journal = bootJournal();
    const err = await closeShift(drawer(), 1500, '', onDeps(h, journal)).catch((e: Error) => e);
    expect((err as Error).message).toContain('ยังยืนยันยอดปิดกะนี้กับเซิร์ฟเวอร์ไม่ได้');
    expect((err as Error).message).not.toContain('ยังไม่ได้ปิดกะ');
    expect(h.server.state.commits).toBe(1);
    await expectNoClientW3NoZ(h, journal);
    expect('commitObservedAtLocal' in (await attemptsOf(journal))[0]!).toBe(true);
  });

  test.each([
    ['close_record_inconsistent', 'ยังยืนยันยอดปิดกะนี้กับเซิร์ฟเวอร์ไม่ได้'],
    ['idempotency_conflict', 'รหัส: idempotency_conflict'],
    ['closed_outside_authority', 'รหัส: closed_outside_authority'],
  ])('%s while the shift is closed with THIS id ⇒ commit-observed custody, no Z, never "not closed"', async (code, copy) => {
    const h = harness();
    h.server.hooks.beforeTx = (call) => {
      if (call !== 1) return;
      h.server.state.doc = { ...h.server.state.doc, status: 'closed', closeCorrelationId: UUID_A, closedAt: ts(CLOSED_AT_MS) };
      h.server.hooks.refuse = code;
    };
    const journal = bootJournal();
    const err = await closeShift(drawer(), 1500, '', onDeps(h, journal)).catch((e: Error) => e);
    expect((err as Error).message).toContain(copy);
    expect((err as Error).message).not.toContain('ยังไม่ได้ปิดกะ');
    await expectNoClientW3NoZ(h, journal);
    expect('commitObservedAtLocal' in (await attemptsOf(journal))[0]!).toBe(true);
    expect(h.server.state.calls).toHaveLength(1);
  });

  test('committed_unconfirmed ⇒ commit-observed custody, one same-id replay (idempotentReplay) ⇒ Z', async () => {
    const h = harness();
    h.server.hooks.afterCommit = 'unconfirmed';
    const journal = bootJournal();
    const replays: boolean[] = [];
    h.server.hooks.respond = (real, n) => {
      if (n === 2) replays.push((real as { idempotentReplay?: boolean }).idempotentReplay === true);
      return real;
    };
    const result = await closeShift(drawer(), 1500, '', onDeps(h, journal));
    expect(result).toMatchObject({ status: 'closed' });
    expect(replays).toEqual([true]);
    expect(h.server.state.commits).toBe(1);
    await expectNoW3(h);
  });

  test('ok:true for another correlation id / malformed success ⇒ never trusted: no Z', async () => {
    const h = harness();
    h.server.hooks.respond = (real) => ({ ...(real as object), closeCorrelationId: UUID_C });
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(M.notFinalized);
    await expectNoClientW3NoZ(h, journal);
    expect('commitObservedAtLocal' in (await attemptsOf(journal))[0]!).toBe(true);
    expect(h.server.state.calls).toHaveLength(2); // one bounded replay, then stop
  });

  test('ok:true whose snapshot differs from the committed doc ⇒ no Z (proof needs response AND doc AND expectation)', async () => {
    const h = harness();
    h.server.hooks.respond = (real) => {
      const r = real as { snapshot: Record<string, unknown> };
      return { ...r, snapshot: { ...r.snapshot, note: 'tampered' } };
    };
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(M.resultMismatch);
    await expectNoClientW3NoZ(h, journal);
  });

  test('a doc closed with this id but a wrong identity (device) ⇒ no Z', async () => {
    const h = harness();
    const journal = bootJournal();
    const readConfirmation: ShiftCloseConfirmationReader = async () => ({
      ok: true,
      doc: shiftCloseConfirmationDocFromData({ ...h.server.state.doc, deviceId: 'DEV2' }),
    });
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal, { readConfirmation }))).rejects.toThrow(
      'ยังยืนยันยอดปิดกะนี้กับเซิร์ฟเวอร์ไม่ได้',
    );
    await expectNoClientW3NoZ(h, journal);
  });

  test('server already closed by a foreign correlation id ⇒ "already closed", no attempt is even prepared', async () => {
    const h = harness(serverShift([], { status: 'closed', closeCorrelationId: UUID_C, deviceId: 'DEV2', closedAt: ts(CLOSED_AT_MS) }));
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(M.alreadyClosed);
    expect(h.server.state.calls).toEqual([]);
    expect(await attemptsOf(journal)).toEqual([]);
    await expectNoClientW3NoZ(h, journal);
  });

  test('a foreign close lands after the attempt was bound ⇒ server already_closed, attempt kept for the sweep to tombstone', async () => {
    const h = harness();
    h.server.hooks.beforeTx = () => {
      h.server.state.doc = { ...h.server.state.doc, status: 'closed', closeCorrelationId: UUID_C, deviceId: 'DEV2', closedAt: ts(CLOSED_AT_MS) };
    };
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow('รหัส: already_closed');
    await expectNoClientW3NoZ(h, journal);
    h.server.hooks.beforeTx = null;
    await runShiftCloseReconciliationSweep({
      journal,
      readConfirmation: h.server.readConfirmation,
      normalizeSyncState: h.server.normalizeSyncState,
      deviceId: 'DEV1',
    });
    const [attempt] = await attemptsOf(journal);
    expect(typeof attempt!.supersededAtLocal).toBe('number');
  });

  test('W4 already synced by the time of the proof ⇒ the Z still requires (and gets) the strict proof; no second W4', async () => {
    const h = harness();
    h.server.hooks.respond = (real) => {
      h.server.state.doc = { ...h.server.state.doc, syncState: 'synced' };
      return real;
    };
    const journal = bootJournal();
    const result = await closeShift(drawer(), 1500, '', onDeps(h, journal));
    await expect(result.whenServerConfirmed).resolves.toMatchObject({ outcome: 'confirmed' });
    expect(h.server.state.w4).toBe(0);
    expect((await entryOf(journal))?.status).toBe('synced');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('014-F sync outcomes stay truthful after a callable success', () => {
  test('W4 fails after the server-authoritative close ⇒ the sweep summary is NOT ok (w4 owed / failed)', async () => {
    const h = harness();
    h.server.state.w4FailuresLeft = 2;
    const journal = bootJournal();
    const result = await closeShift(drawer(), 1500, '', onDeps(h, journal));
    await result.whenServerConfirmed;
    const swept = await runShiftCloseReconciliationSweep({
      journal,
      readConfirmation: h.server.readConfirmation,
      normalizeSyncState: h.server.normalizeSyncState,
      deviceId: 'DEV1',
    });
    expect(swept.normalization.status).not.toBe('ok');
    expect(shiftCloseNormalizationIssue(swept.normalization)).toMatch(/w4_failed|w4_owed/);
    // Once W4 lands, the summary turns clean.
    const later = await runShiftCloseReconciliationSweep({
      journal,
      readConfirmation: h.server.readConfirmation,
      normalizeSyncState: h.server.normalizeSyncState,
      deviceId: 'DEV1',
    });
    expect(later.normalization.status).toBe('ok');
  });

  test('a local journal write failure after the proof ⇒ degraded, never clean', async () => {
    const h = harness();
    const journal = bootJournal();
    const result = await closeShift(drawer(), 1500, '', onDeps(h, journal));
    await result.whenServerConfirmed;
    h.server.state.doc = { ...h.server.state.doc, syncState: 'pending' };
    await journal.setSyncStateNormalization('shift-1', UUID_A, 'outstanding');
    const failing: ShiftCloseIntentJournal = {
      ...journal,
      setSyncStateNormalization: async () => ({ ok: false, code: 'tx_failed', message: 'AbortError' }),
    };
    const swept = await runShiftCloseReconciliationSweep({
      journal: failing,
      readConfirmation: h.server.readConfirmation,
      normalizeSyncState: h.server.normalizeSyncState,
      deviceId: 'DEV1',
    });
    expect(swept.normalization.status).toBe('degraded');
  });

  test('an unresolved server-authoritative attempt (commit observed, finalize failed) is reported by the sweep until finalized', async () => {
    const h = harness();
    const journal = bootJournal();
    const broken: ShiftCloseIntentJournal = {
      ...journal,
      finalizeOnlineClose: async () => ({ ok: false, code: 'tx_failed', message: 'AbortError' }),
    };
    await expect(closeShift(drawer(), 1500, '', onDeps(h, broken))).rejects.toThrow(M.notFinalized);
    // The sweep recovers it from the server doc — the expectation still holds AND (015) the callable's
    // idempotent replay proves the server authored that close — so it is finalized there.
    const swept = await sweepOn(h, journal);
    expect(swept.normalization.attempts).toMatchObject({ recovered: 1 });
    expect(await entryOf(journal)).toMatchObject({ closeCorrelationId: UUID_A, status: 'synced' });
    await expectNoW3(h);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Packet 015 — Codex-014 F1–F4 closure (client recovery safety).
//
// Provenance: the cases tagged [RED-parent] use only symbols/behaviour that
// exist at a844855 (the new deps keys are passed by name and ignored there), so
// on the parent they fail on BEHAVIOUR. Cases tagged [GREEN-only] need the new
// 015 API and are not RED evidence; [GREEN-guard] pass on both (regression).
// ═════════════════════════════════════════════════════════════════════════

const REQUEST_A = {
  contractVersion: 1,
  shiftId: 'shift-1',
  closeCorrelationId: UUID_A,
  actualCashCount: 1500,
  note: '',
  attestedSales: { expectedCash: 1000, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0, totalBills: 3 },
  deviceId: 'DEV1',
};

/** A direct client W3 (Rules-accepted today): this attempt's UUID and its OLD expected totals, no authority record. */
function forgeDirectW3(h: Harness, over: Record<string, unknown> = {}) {
  h.server.state.doc = {
    ...h.server.state.doc,
    status: 'closed',
    closedAt: ts(CLOSED_AT_MS),
    closeCorrelationId: UUID_A,
    closedOffline: true,
    syncState: 'pending',
    deviceId: 'DEV1',
    actualCashCount: 1500,
    variance: 0,
    note: '',
    expectedCash: 1000,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    totalBills: 3,
    payInTotal: 0,
    payOutTotal: 0,
    ...over,
  };
}

/** ON close, transport lost before the server saw it: attempt UUID_A bound (payOut 0, drawer 1500), shift still open. */
async function openBoundAttempt(h: Harness): Promise<ShiftCloseIntentJournal> {
  h.server.hooks.transportFailuresLeft = 1;
  const j = bootJournal([UUID_A]);
  await expect(closeShift(drawer(), 1500, '', onDeps(h, j))).rejects.toThrow(M.unknown);
  return j;
}

function sweepOn(h: Harness, journal: ShiftCloseIntentJournal, extra: Record<string, unknown> = {}) {
  return runShiftCloseReconciliationSweep({
    journal,
    readConfirmation: h.server.readConfirmation,
    normalizeSyncState: h.server.normalizeSyncState,
    deviceId: 'DEV1',
    authoritativeCallable: h.server.callable,
    ...extra,
  } as Parameters<typeof runShiftCloseReconciliationSweep>[0]);
}

async function expectNothingAdopted(h: Harness, journal: ShiftCloseIntentJournal) {
  expect(await entryOf(journal)).toBeUndefined(); // no journal entry ⇒ no Z source
  const [attempt] = await attemptsOf(journal);
  expect(attempt).toBeDefined(); // attempt preserved, same UUID + bound request
  expect(attempt!.closeCorrelationId).toBe(UUID_A);
  expect('supersededAtLocal' in attempt!).toBe(false);
  expect(h.server.state.w4).toBe(0); // no W4
  expect(h.server.state.doc.syncState).toBe('pending');
  expect(h.tripwire.calls).toEqual([]);
}

describe('015-F1 a server-authored close is proven by the callable replay — never by the shift doc alone', () => {
  test('[RED-parent] forged direct W3 (UUID A + old totals, no authority record) after a Return 81 ⇒ restart sweep: no Z / journal / W4 / consumed attempt', async () => {
    const h = harness();
    await openBoundAttempt(h);
    expect(h.server.commitCashReturn('ret1', 81)).toBe('committed'); // payout 81 committed on the server
    forgeDirectW3(h); // staff client direct W3 under the unsealed Rules: UUID A, payOut 0, count 1500
    expect(h.server.state.record).toBeNull(); // no shiftCloseAuthorityRecords document
    // The real callable (production decision core) classifies that doc.
    await expect(h.server.callable(REQUEST_A)).resolves.toEqual({ ok: false, code: 'closed_outside_authority' });

    const restarted = bootJournal([UUID_B]); // fresh journal instance over the same IndexedDB
    const swept = await sweepOn(h, restarted);
    await expectNothingAdopted(h, restarted);
    expect(swept.normalization.status).not.toBe('ok');
    expect(shiftCloseNormalizationIssue(swept.normalization)).toContain('attempt_manual_attention');
    expect(swept.normalization.attempts).not.toHaveProperty('recovered');

    // Repeated sweeps (a boot, then a reconnect) stay unresolved — never "caught up".
    const again = await sweepOn(h, bootJournal([UUID_C]));
    expect(again.normalization.status).not.toBe('ok');
    await expectNothingAdopted(h, restarted);
  });

  test('[RED-parent] a forged W3 that even equals the saved expectation is not a Z without the replay', async () => {
    const h = harness();
    await openBoundAttempt(h);
    forgeDirectW3(h); // no Return: the forged doc equals the saved expectation exactly
    expect(h.server.state.record).toBeNull();
    const restarted = bootJournal([UUID_B]);
    const swept = await sweepOn(h, restarted);
    await expectNothingAdopted(h, restarted);
    expect(shiftCloseNormalizationIssue(swept.normalization)).toContain('attempt_manual_attention');
  });

  test.each([
    ['timeout / transport failure', (h: Harness) => { h.server.hooks.transportFailuresLeft = 1; }, 'attempt_unreachable'],
    ['committed_unconfirmed', (h: Harness) => { h.server.hooks.respond = () => ({ ok: false, code: 'committed_unconfirmed' }); }, 'attempt_unreachable'],
    ['session_stale (cannot verify now)', (h: Harness) => { h.server.hooks.refuse = 'session_stale'; }, 'attempt_unreachable'],
    ['unrecognized response', (h: Harness) => { h.server.hooks.respond = () => ({ hello: 'world' }); }, 'attempt_unreachable'],
    ['malformed success (other correlation id)', (h: Harness) => { h.server.hooks.respond = (real) => ({ ...(real as object), closeCorrelationId: UUID_C }); }, 'attempt_manual_attention'],
    ['malformed success (missing snapshot)', (h: Harness) => { h.server.hooks.respond = (real) => ({ ...(real as object), snapshot: undefined }); }, 'attempt_manual_attention'],
    ['a fresh-commit claim (idempotentReplay false) on an already closed shift', (h: Harness) => { h.server.hooks.respond = (real) => ({ ...(real as object), idempotentReplay: false }); }, 'attempt_manual_attention'],
    ['a success whose snapshot differs from the doc', (h: Harness) => { h.server.hooks.respond = (real) => { const r = real as { snapshot: object }; return { ...r, snapshot: { ...r.snapshot, note: 'tampered' } }; }; }, 'attempt_manual_attention'],
    ['a success whose closedAtMillis differs from the doc', (h: Harness) => { h.server.hooks.respond = (real) => ({ ...(real as object), closedAtMillis: CLOSED_AT_MS + 1 }); }, 'attempt_manual_attention'],
    ['idempotency_conflict', (h: Harness) => { h.server.hooks.refuse = 'idempotency_conflict'; }, 'attempt_manual_attention'],
    ['close_record_inconsistent', (h: Harness) => { h.server.hooks.refuse = 'close_record_inconsistent'; }, 'attempt_manual_attention'],
    ['closed_outside_authority', (h: Harness) => { h.server.hooks.refuse = 'closed_outside_authority'; }, 'attempt_manual_attention'],
  ])('[RED-parent] a genuine server close whose replay is %s ⇒ no Z / journal / W4, attempt kept (%#)', async (_label, tamper, condition) => {
    const h = harness();
    await openBoundAttempt(h);
    await h.server.callable(REQUEST_A); // the commit landed (record exists) but this client never heard: NOT commit-observed
    expect(h.server.state.record).not.toBeNull();
    tamper(h);
    const restarted = bootJournal([UUID_B]);
    const swept = await sweepOn(h, restarted);
    await expectNothingAdopted(h, restarted);
    expect(swept.normalization.status).not.toBe('ok');
    expect(shiftCloseNormalizationIssue(swept.normalization)).toContain(condition);
  });

  test('[RED-parent] a commit-observed attempt is proven the same way (the observation is custody, not authority)', async () => {
    const h = harness();
    const journal = bootJournal([UUID_A]);
    const broken: ShiftCloseIntentJournal = { ...journal, finalizeOnlineClose: async () => ({ ok: false, code: 'tx_failed', message: 'AbortError' }) };
    await expect(closeShift(drawer(), 1500, '', onDeps(h, broken))).rejects.toThrow(M.notFinalized);
    expect('commitObservedAtLocal' in (await attemptsOf(journal))[0]!).toBe(true);
    h.server.hooks.refuse = 'closed_outside_authority';
    const swept = await sweepOn(h, bootJournal([UUID_B]));
    expect(await entryOf(journal)).toBeUndefined();
    expect(await attemptsOf(journal)).toHaveLength(1);
    expect(h.server.state.w4).toBe(0);
    expect(shiftCloseNormalizationIssue(swept.normalization)).toContain('attempt_manual_attention');
  });

  test('[RED-parent] a legitimate server close (lost response) is proven by exactly ONE idempotent replay of the stored request, then recovered + reconciled', async () => {
    const h = harness();
    await openBoundAttempt(h);
    await h.server.callable(REQUEST_A);
    const before = h.server.state.calls.length;
    const replays: boolean[] = [];
    h.server.hooks.respond = (real) => {
      replays.push((real as { idempotentReplay?: boolean }).idempotentReplay === true);
      return real;
    };
    const restarted = bootJournal([UUID_B]);
    const swept = await sweepOn(h, restarted);
    expect(replays).toEqual([true]);
    expect(h.server.state.calls.length).toBe(before + 1);
    expect(h.server.state.calls[before]).toEqual(REQUEST_A); // the immutable stored request + UUID
    expect(swept.normalization.attempts).toMatchObject({ recovered: 1 });
    expect(await entryOf(restarted)).toMatchObject({ closeCorrelationId: UUID_A, status: 'synced' });
    expect(await attemptsOf(restarted)).toEqual([]);
    expect(h.server.state.w4).toBe(1);
    expect(h.server.state.commits).toBe(1);
    expect(swept.normalization.status).toBe('ok');
  });

  test('[RED-parent] no callable transport available ⇒ fail closed even for a genuine server close', async () => {
    const h = harness();
    await openBoundAttempt(h);
    await h.server.callable(REQUEST_A);
    const restarted = bootJournal([UUID_B]);
    const swept = await sweepOn(h, restarted, { authoritativeCallable: undefined }); // production default: no Firebase app in this suite
    expect(await entryOf(restarted)).toBeUndefined();
    expect(shiftCloseNormalizationIssue(swept.normalization)).toContain('attempt_unreachable');
    expect(h.server.state.w4).toBe(0);
  });

  test('[GREEN-guard] the sweep NEVER invokes the callable on an open (or unreadable) shift', async () => {
    const h = harness();
    await openBoundAttempt(h);
    const guard = vi.fn(h.server.callable);
    const before = h.server.state.calls.length;
    await sweepOn(h, bootJournal([UUID_B]), { authoritativeCallable: guard });
    await sweepOn(h, bootJournal([UUID_B]), { authoritativeCallable: guard, readConfirmation: async () => ({ ok: false }) });
    expect(guard).not.toHaveBeenCalled();
    expect(h.server.state.calls.length).toBe(before);
    expect(h.server.state.doc.status).toBe('open');
    expect(h.server.state.commits).toBe(0);
  });

  test('[RED-parent] two windows recovering the same genuine close: one server commit, ONE entry, the attempt consumed once, both proven', async () => {
    const h = harness();
    await openBoundAttempt(h);
    await h.server.callable(REQUEST_A);
    const w1 = bootJournal([UUID_B]);
    const w2 = bootJournal([UUID_C]);
    const [a1] = await attemptsOf(w1);
    const [a2] = await attemptsOf(w2);
    const deps = (journal: ShiftCloseIntentJournal) => ({
      journal,
      readConfirmation: h.server.readConfirmation,
      deviceId: 'DEV1',
      authoritativeCallable: h.server.callable,
    });
    const before = h.server.state.calls.length;
    const [r1, r2] = await Promise.all([
      recoverOnlineCloseAttempt(a1 as never, deps(w1) as never),
      recoverOnlineCloseAttempt(a2 as never, deps(w2) as never),
    ]);
    expect([r1.outcome, r2.outcome]).toEqual(['recovered', 'recovered']);
    expect(h.server.state.calls.length).toBe(before + 2); // each window obtained its own proof
    expect(h.server.state.commits).toBe(1);
    expect(await attemptsOf(w1)).toEqual([]);
    expect(await entryOf(w1)).toMatchObject({ closeCorrelationId: UUID_A });
  });

  test('[GREEN-guard] a retry (closeShift) after restart over the forged W3 is refused: no Z, no journal, no second W3', async () => {
    const h = harness();
    await openBoundAttempt(h);
    h.server.commitCashReturn('ret1', 81);
    forgeDirectW3(h);
    const restarted = bootJournal([UUID_B]);
    await expect(closeShift(drawer(), 1500, '', onDeps(h, restarted))).rejects.toThrow('รหัส: closed_outside_authority');
    expect(await entryOf(restarted)).toBeUndefined();
    expect(h.tripwire.calls).toEqual([]);
    expect(h.server.state.w4).toBe(0);
  });

  test('[GREEN-guard] a foreign valid close still tombstones the attempt (006-B supersession is unchanged and needs no replay)', async () => {
    const h = harness();
    await openBoundAttempt(h);
    h.server.state.doc = { ...h.server.state.doc, status: 'closed', closeCorrelationId: UUID_C, deviceId: 'DEV2', closedAt: ts(CLOSED_AT_MS) };
    const guard = vi.fn(h.server.callable);
    await sweepOn(h, bootJournal([UUID_B]), { authoritativeCallable: guard });
    const [attempt] = await attemptsOf(bootJournal([UUID_B]));
    expect(typeof attempt!.supersededAtLocal).toBe('number');
    expect(guard).not.toHaveBeenCalled();
    expect(await entryOf(bootJournal([UUID_B]))).toBeUndefined();
  });
});

describe('015-F3 an open server-authoritative attempt is never a clean sync state', () => {
  test('[RED-parent] open attempt after a transport failure: the sweep is unresolved + attention (not ok), stable across boots, cleared only by the genuine close', async () => {
    const h = harness();
    await openBoundAttempt(h);
    const boot1 = await sweepOn(h, bootJournal([UUID_B]));
    expect(boot1.normalization.status).toBe('unresolved');
    expect(boot1.normalization.attention).toEqual([{ shiftId: 'shift-1', branchId: 'LDP-001', condition: 'attempt_unresolved' }]);
    expect(shiftCloseNormalizationIssue(boot1.normalization)).toBe('attempt_unresolved=1');
    expect(boot1.normalization.attempts).toEqual({ not_closed: 1 });
    expect(boot1.normalization.advanced).toBe(0);

    const boot2 = await sweepOn(h, bootJournal([UUID_B]));
    expect(shiftCloseAttentionKey(boot2.normalization)).toBe(shiftCloseAttentionKey(boot1.normalization));
    expect(h.server.state.calls).toHaveLength(1); // the sweeps issued no remote close
    expect(h.server.state.doc.status).toBe('open');

    // The cashier retries the SAME close: the genuine server close resolves it.
    const result = await closeShift(drawer(), 1500, '', onDeps(h, bootJournal([UUID_B])));
    await result.whenServerConfirmed;
    const done = await sweepOn(h, bootJournal([UUID_B]));
    expect(done.normalization.status).toBe('ok');
    expect(done.normalization.attention).toEqual([]);
  });

  test('[GREEN-guard] an unreadable attempt store is reported, never read as zero attempts', async () => {
    const h = harness();
    const journal = bootJournal();
    const unreadable: ShiftCloseIntentJournal = { ...journal, listOnlineCloseAttempts: async () => ({ ok: false, code: 'tx_failed', message: 'AbortError' }) };
    const swept = await sweepOn(h, unreadable);
    expect(swept.normalization.status).toBe('degraded');
    expect(shiftCloseNormalizationIssue(swept.normalization)).toContain('attempts_unreadable');
    expect(swept.normalization.attempts).toBeNull();
  });

  test('[GREEN-only] the FINAL attempt list decides: an attempt another window settled meanwhile is not reported', async () => {
    const h = harness();
    await openBoundAttempt(h);
    const real = bootJournal([UUID_B]);
    let listed = 0;
    // First list (recovery): the open attempt. Later lists: another window already settled it.
    const racing: ShiftCloseIntentJournal = {
      ...real,
      listOnlineCloseAttempts: async () => {
        listed += 1;
        return listed === 1 ? real.listOnlineCloseAttempts() : { ok: true, value: [] };
      },
    };
    const swept = await sweepOn(h, racing);
    expect(swept.normalization.attention).toEqual([]);
    expect(swept.normalization.status).toBe('ok');
  });
});

describe('015-F4 a legacy close-intent entry is never relabelled as a server-authoritative Z', () => {
  test('[RED-parent] OFF-created journal entry (direct W3) + gate flipped ON ⇒ refused: no Z, entry untouched, no second W3', async () => {
    const h = harness();
    const journal = bootJournal([UUID_A]);
    // OFF (legacy) online close: the client itself writes the W3 and journals it.
    const off = await closeShift(drawer(), 1500, '', gateOff(onDeps(h, journal)));
    await off.whenServerConfirmed;
    expect(h.tripwire.calls).toHaveLength(1);
    expect(h.server.state.record).toBeNull(); // direct W3: no authority record
    const entryBefore = await entryOf(journal);
    expect(entryBefore).toMatchObject({ closeCorrelationId: UUID_A });

    // Gate flip: the same shift/UUID/amounts, but the Z must not come from the legacy entry.
    await expect(closeShift(drawer(), 1500, '', onDeps(h, bootJournal([UUID_B])))).rejects.toThrow();
    expect(await entryOf(journal)).toEqual(entryBefore);
    expect(h.tripwire.calls).toHaveLength(1); // no second W3
    expect(h.server.state.commits).toBe(0);
  });

  test('[GREEN-guard] an ON-created, server-proven entry stays recoverable (callable replay proves it)', async () => {
    const h = harness();
    const journal = bootJournal([UUID_A]);
    const first = await closeShift(drawer(), 1500, '', onDeps(h, journal));
    await first.whenServerConfirmed;
    expect(h.server.state.record).not.toBeNull();
    const again = await closeShift(drawer(), 1500, '', onDeps(h, bootJournal([UUID_B])));
    expect(again).toMatchObject({ status: 'closed', variance: 0 });
    expect(h.server.state.commits).toBe(1);
    expect(h.tripwire.calls).toEqual([]);
  });

  test('[GREEN-guard] an offline-queued legacy close (W3 not yet on the server) is still refused under ON', async () => {
    const h = harness();
    const journal = bootJournal([UUID_A]);
    await closeShift(drawer(), 1500, '', gateOff(onDeps(h, journal, { isOnline: () => false })));
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(M.localPending);
    expect(h.server.state.calls).toEqual([]);
    expect(h.server.state.doc.status).toBe('open');
  });
});

describe('015-F2 the cashier confirms the drawer that the close actually uses', () => {
  const RFD81 = { id: 'rfd_ret1', type: 'pay_out' as const, amount: 81, note: 'คืนเงินสด', staffId: CALLER, staffName: 'ทดสอบ', at: 2 };
  const DISPLAY_CHANGED = 'ยอดเงินสดในลิ้นชักที่แสดงอยู่ไม่ตรงกับข้อมูลล่าสุดบนเซิร์ฟเวอร์';
  const buildWitness = (shift: Shift, refresh: string) =>
    (authClient as unknown as { buildReviewedDrawerWitness: (s: Shift, r: string) => unknown }).buildReviewedDrawerWitness(shift, refresh);
  const withWitness = (h: Harness, witness: unknown) => ({
    authoritativeClose: { sales: SALES_1000, callable: h.server.callable, readServerShift: h.server.readServerShift, reviewedDrawer: witness },
  });

  async function expectRefusedBeforeAnything(h: Harness, journal: ShiftCloseIntentJournal) {
    expect(h.server.state.calls).toEqual([]);
    expect(await attemptsOf(journal)).toEqual([]);
    expect(h.server.state.doc.status).toBe('open');
    await expectNoClientW3NoZ(h, journal);
  }

  test('[RED-parent] the modal showed 1500 (no Return) but the server holds Return 81: refused before the attempt / callable — a stale count is never silently closed over the changed drawer', async () => {
    const h = harness();
    h.server.commitCashReturn('ret1', 81); // arrived after the display was rendered
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(DISPLAY_CHANGED);
    await expectRefusedBeforeAnything(h, journal);
  });

  test('[RED-parent] no reviewed-drawer witness on the ON path ⇒ refused (a witness guessed from the original shift is not accepted)', async () => {
    const h = harness();
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal, withWitness(h, undefined)))).rejects.toThrow(DISPLAY_CHANGED);
    await expectRefusedBeforeAnything(h, journal);
  });

  test('[RED-parent] a stored startingCash that differs from the displayed one is a changed drawer ⇒ refused', async () => {
    const h = harness(serverShift([], { startingCash: 600 }));
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(DISPLAY_CHANGED);
    await expectRefusedBeforeAnything(h, journal);
  });

  test('[GREEN-only] the display refresh had not loaded (pending / unavailable) ⇒ refused even when the numbers happen to agree', async () => {
    const h = harness();
    const journal = bootJournal();
    for (const refresh of ['pending', 'unavailable']) {
      await expect(closeShift(drawer(), 1500, '', onDeps(h, journal, withWitness(h, buildWitness(drawer(), refresh))))).rejects.toThrow(DISPLAY_CHANGED);
    }
    await expectRefusedBeforeAnything(h, journal);
  });

  test('[GREEN-only] a witness of another branch / shift is never accepted', async () => {
    const h = harness();
    const journal = bootJournal();
    for (const other of [{ ...drawer(), branchId: 'OTHER' }, { ...drawer(), id: 'shift-2' }]) {
      await expect(closeShift(drawer(), 1500, '', onDeps(h, journal, withWitness(h, buildWitness(other, 'loaded'))))).rejects.toThrow(DISPLAY_CHANGED);
    }
    await expectRefusedBeforeAnything(h, journal);
  });

  test('[GREEN-guard] after the refresh the cashier sees drawer 1419 and confirms it: the close commits exactly that (500 + 1000 − 81, variance 0)', async () => {
    const h = harness();
    h.server.commitCashReturn('ret1', 81);
    fs.cacheDoc = { status: 'open', cashEntries: [RFD81] };
    const journal = bootJournal();
    // The 1st confirm used the stale display ⇒ refused; the refreshed display is the new, explicit confirmation.
    await expect(closeShift(drawer(), 1419, '', onDeps(h, journal))).rejects.toThrow(DISPLAY_CHANGED);
    const result = await closeShift(drawer(SALES_1000, [RFD81]), 1419, '', onDeps(h, journal));
    expect(result).toMatchObject({ status: 'closed', payOutTotal: 81, startingCash: 500, actualCashCount: 1419, variance: 0 });
    expect(h.server.state.commits).toBe(1);
  });

  test('[GREEN-guard] a Return that lands AFTER the pre-call read (display honest at confirm time) still yields no Z', async () => {
    const h = harness();
    h.server.hooks.beforeTx = (call) => {
      if (call === 1) h.server.commitCashReturn('ret1', 81);
    };
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(M.resultMismatch);
    await expectNoClientW3NoZ(h, journal);
    expect(await attemptsOf(journal)).toHaveLength(1);
  });

  test('[GREEN-guard] a retry whose attempt already holds the pre-Return expectation keeps the drawer-changed refusal', async () => {
    const h = harness();
    h.server.hooks.transportFailuresLeft = 1;
    const journal = bootJournal();
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(M.unknown);
    h.server.commitCashReturn('ret1', 81);
    await expect(closeShift(drawer(), 1500, '', onDeps(h, journal))).rejects.toThrow(M.drawerChanged);
    expect(h.server.state.calls).toHaveLength(1);
  });
});
