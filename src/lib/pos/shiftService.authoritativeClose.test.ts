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
  runShiftCloseReconciliationSweep,
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

import { closeShift, type CloseShiftDeps, type ShiftCloseTransactionRunner } from './shiftService';

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
    // The sweep recovers it from the server doc — the expectation still holds, so it is finalized there.
    const swept = await runShiftCloseReconciliationSweep({
      journal,
      readConfirmation: h.server.readConfirmation,
      normalizeSyncState: h.server.normalizeSyncState,
      deviceId: 'DEV1',
    });
    expect(swept.normalization.attempts).toMatchObject({ recovered: 1 });
    expect(await entryOf(journal)).toMatchObject({ closeCorrelationId: UUID_A, status: 'synced' });
    await expectNoW3(h);
  });
});
