import { describe, test, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: { __unused: true } }));
vi.mock('../deployConfig', () => ({ FUNCTIONS_REGION: 'asia-southeast1', FIRESTORE_DATABASE_ID: 'pos-db' }));
vi.mock('firebase-functions/v2/https', () => ({
  onCall: (_opts: unknown, handler: unknown) => handler,
  HttpsError: class HttpsError extends Error {},
}));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => ({ __fv: 'ts' }),
    increment: (n: number) => ({ __fv: 'inc', n }),
    arrayUnion: (...items: unknown[]) => ({ __fv: 'arr', items }),
  },
  Timestamp: class Timestamp {
    private readonly ms: number;
    private constructor(ms: number) {
      this.ms = ms;
    }
    static fromMillis(ms: number) {
      return new Timestamp(ms);
    }
    toMillis() {
      return this.ms;
    }
  },
}));

import { performGetSaleReturnContext, performSubmitSaleReturn } from '../submitSaleReturn';
import { handleVoidIntent } from '../voidIntent';
import { performSubmitPrivilegedVoid } from '../submitPrivilegedVoid';
import { deriveReturnId } from '../saleReturnCore';
import { foldCashEntriesSnapshot } from '../shiftCloseValidationCore';
import {
  PRIVILEGED_ACTION_IDS,
  SALE_RETURN_ACTION_ID,
  SALE_RETURN_APPROVER_PERMISSION,
  SALE_RETURN_AUDIENCE,
  PRIVILEGED_VOID_AUDIENCE,
  getActionRequirement,
} from '../privilegedActionRegistry';
import { audienceForProtectedAction } from '../requestManagerApprovalCore';
import { foldCashEntries } from '../../../src/lib/pos/shiftLedger';

type Doc = Record<string, unknown>;

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;
const GOOD_PIN = '1234';

// ─── Fake Firestore with OPTIMISTIC transactions ──────────────────────────────
//
// Reads inside a transaction record the version they saw; at commit every read
// version is re-checked and a conflict re-runs the callback (like Firestore).
// Writes are buffered until commit. `tx.create` on an existing doc aborts the
// whole transaction, `tx.update` on a missing doc throws. Each tx.get yields a
// macrotask so two concurrent transactions genuinely interleave their reads.

type Entry = { data: Doc; version: number };

function isSentinel(v: unknown): v is { __fv: string; n?: number; items?: unknown[] } {
  return typeof v === 'object' && v !== null && '__fv' in v;
}

/** Deep-copies plain objects/arrays; keeps class instances (Timestamp mocks) and functions by reference. */
function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => clone(x)) as T;
  if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v as Doc).map(([k, x]) => [k, clone(x)])) as T;
  }
  return v;
}

function makeDb(seed: Record<string, Doc>) {
  const store = new Map<string, Entry>(Object.entries(seed).map(([k, v]) => [k, { data: clone(v), version: 1 }]));
  let commits = 0;
  let conflicts = 0;

  const resolveField = (current: unknown, incoming: unknown): unknown => {
    if (isSentinel(incoming)) {
      if (incoming.__fv === 'ts') return NOW;
      if (incoming.__fv === 'inc') return ((current as number) ?? 0) + (incoming.n ?? 0);
      if (incoming.__fv === 'arr') {
        const arr = Array.isArray(current) ? [...current] : [];
        for (const it of incoming.items ?? []) if (!arr.some((x) => JSON.stringify(x) === JSON.stringify(it))) arr.push(it);
        return arr;
      }
    }
    return incoming;
  };
  const apply = (path: string, data: Doc, merge: boolean) => {
    const prev = store.get(path);
    const base: Doc = merge && prev ? { ...prev.data } : {};
    for (const [k, v] of Object.entries(data)) base[k] = resolveField(prev?.data[k], v);
    store.set(path, { data: base, version: (prev?.version ?? 0) + 1 });
  };
  const snap = (path: string) => {
    const e = store.get(path);
    return { exists: e !== undefined, id: path.slice(path.lastIndexOf('/') + 1), data: () => (e ? clone(e.data) : undefined) };
  };

  type Snap = { exists: boolean; id: string; data: () => Doc | undefined };
  interface FakeDocRef {
    path: string;
    id: string;
    collection: (n: string) => FakeColRef;
    get: () => Promise<Snap>;
    set: (data: Doc, opts?: { merge?: boolean }) => Promise<void>;
  }
  interface FakeColRef {
    path: string;
    doc: (id: string) => FakeDocRef;
  }
  function docRef(path: string): FakeDocRef {
    return {
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      collection: (n: string) => colRef(`${path}/${n}`),
      get: async () => snap(path),
      set: async (data: Doc, opts?: { merge?: boolean }) => apply(path, data, opts?.merge === true),
    };
  }
  function colRef(path: string): FakeColRef {
    return { path, doc: (id: string) => docRef(`${path}/${id}`) };
  }

  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  const database = {
    collection: (c: string) => colRef(c),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const reads = new Map<string, number>();
        const writes: { kind: 'set' | 'update' | 'create'; path: string; data: Doc; merge: boolean }[] = [];
        const tx = {
          get: async (ref: { path: string }) => {
            await tick();
            reads.set(ref.path, store.get(ref.path)?.version ?? 0);
            return snap(ref.path);
          },
          set: (ref: { path: string }, data: Doc, opts?: { merge?: boolean }) =>
            writes.push({ kind: 'set', path: ref.path, data, merge: opts?.merge === true }),
          update: (ref: { path: string }, data: Doc) => writes.push({ kind: 'update', path: ref.path, data, merge: true }),
          create: (ref: { path: string }, data: Doc) => writes.push({ kind: 'create', path: ref.path, data, merge: false }),
        };
        const result = await fn(tx);
        const conflict = [...reads.entries()].some(([p, v]) => (store.get(p)?.version ?? 0) !== v);
        if (conflict) {
          conflicts += 1;
          await tick();
          continue;
        }
        for (const w of writes) {
          if (w.kind === 'create' && store.has(w.path)) throw new Error(`ALREADY_EXISTS: ${w.path}`);
          if (w.kind === 'update' && !store.has(w.path)) throw new Error(`NOT_FOUND: ${w.path}`);
        }
        for (const w of writes) apply(w.path, w.data, w.merge);
        commits += 1;
        return result;
      }
      throw new Error('ABORTED: too much contention');
    },
    __store: store,
    get __commits() {
      return commits;
    },
    get __conflicts() {
      return conflicts;
    },
  };
  return database;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MATRIX = {
  admin: ['pos_sale', 'pos_discount', 'pos_void', 'pos_return', 'product_view'],
  manager: ['pos_sale', 'pos_discount', 'pos_void', 'pos_return', 'product_view'],
  staff: ['pos_sale', 'product_view'],
};

function cred(): Doc {
  return {
    pinHash: '$2b$10$realhash',
    algo: 'bcrypt',
    cost: 10,
    credentialVersion: 1,
    credentialState: 'rotated_authoritative',
    disabled: false,
    updatedBy: 't',
  };
}

function saleLines(): Doc[] {
  return [
    {
      productId: 'P1',
      productSnap: { name: 'อาหารแมว', sku: 'CF' },
      unit: 'ถุง',
      unitFactor: 1,
      qty: 5,
      qtyBase: 5,
      unitPrice: 100,
      originalPrice: 100,
      discountAmt: 50,
      lineTotal: 450,
      fifoCost: 230,
      lotRefs: [
        { lotId: 'L1', qty: 3, cost: 40 },
        { lotId: 'L2', qty: 2, cost: 55 },
      ],
    },
    {
      productId: 'P2',
      productSnap: { name: 'ทราย', sku: 'SD' },
      unit: 'ลัง',
      unitFactor: 12,
      qty: 2,
      qtyBase: 24,
      unitPrice: 300,
      originalPrice: 300,
      discountAmt: 0,
      lineTotal: 600,
      fifoCost: 480,
      lotRefs: [{ lotId: 'L3', qty: 24, cost: 20 }],
    },
  ];
}

function settledAsync(id: string, over: Doc = {}): Doc {
  return {
    id,
    billId: `R-${id}`,
    deviceId: 'dev1',
    branchId: 'B1',
    shiftId: 'SH-OLD',
    staffId: 's1',
    staffName: 'Staff One',
    customerId: null,
    customerSnap: { name: 'คุณลูกค้า', phone: '', taxId: null },
    lines: saleLines(),
    payments: [{ method: 'cash', amount: 1000, ref: null }],
    subtotal: 1050,
    discountAmt: 50,
    billDiscount: 105,
    fee: 0,
    vatRate: 0,
    vatAmt: 0,
    total: 945,
    paidAmt: 1000,
    changeAmt: 55,
    creditAmt: 0,
    status: 'completed',
    reconcileStatus: 'settled',
    clientCreatedAt: NOW - 3 * DAY, // cross-day sale
    ...over,
  };
}

function baseSeed(extra: Record<string, Doc> = {}): Record<string, Doc> {
  return {
    'users/s1': { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['B1'], firstName: 'Staff', lastName: 'One' },
    'users/m1': { isActive: true, deletedAt: null, authVersion: 0, role: 'manager', branchIds: ['B1'], firstName: 'Mana', lastName: 'Ger' },
    'users/m2': { isActive: true, deletedAt: null, authVersion: 0, role: 'manager', branchIds: ['B2'], firstName: 'Other', lastName: 'Branch' },
    'users/a1': { isActive: true, deletedAt: null, authVersion: 0, role: 'admin', branchIds: ['ALL'], firstName: 'Ad', lastName: 'Min' },
    'userCredentials/m1': cred(),
    'userCredentials/m2': cred(),
    'userCredentials/a1': cred(),
    'settings/_rolePermissions': { rolePermissions: clone(MATRIX) },
    'asyncOrders/O1': settledAsync('O1'),
    'orders/O1': { id: 'O1', billId: 'R-O1', branchId: 'B1', status: 'completed', total: 945, cogs: 710, profit: 340, historyRev: 1 },
    'stockLots/L1': { id: 'L1', productId: 'P1', branchId: 'B1', costPerUnit: 40, qtyReceived: 3, qtyRemaining: 0, isDepleted: true },
    'stockLots/L2': { id: 'L2', productId: 'P1', branchId: 'B1', costPerUnit: 55, qtyReceived: 10, qtyRemaining: 8, isDepleted: false },
    'stockLots/L3': { id: 'L3', productId: 'P2', branchId: 'B1', costPerUnit: 20, qtyReceived: 24, qtyRemaining: 0, isDepleted: true },
    'products/P1': { id: 'P1', cost: 999, avgCost: 888 }, // current cost changed after the sale
    'products/P1/productStocks/B1': { branchId: 'B1', totalStockBase: 8 },
    'products/P2/productStocks/B1': { branchId: 'B1', totalStockBase: 0 },
    'shifts/SH1': { id: 'SH1', status: 'open', branchId: 'B1', staffId: 's1', startingCash: 1000, cashEntries: [] },
    ...extra,
  };
}

const staffAuth = {
  uid: 'u-s1',
  token: { role: 'staff', staffId: 's1', branchIds: ['B1'], authVersion: 0, permissions: ['pos_sale', 'product_view'] },
};

const deps = {
  nowMillis: NOW,
  comparePin: async (pin: string, hash: string) => pin === GOOD_PIN && hash === '$2b$10$realhash',
};

function submitReq(over: Doc = {}): Doc {
  return {
    attemptId: 'attempt-0001',
    orderId: 'O1',
    branchId: 'B1',
    lines: [{ lineIndex: 0, productId: 'P1', qty: 2 }],
    refundMethod: 'cash',
    refundReference: '',
    reason: 'สินค้าชำรุด',
    expectedRefundAmount: 162,
    shiftId: 'SH1',
    approverStaffId: 'm1',
    pin: GOOD_PIN,
    ...over,
  };
}

function data(db: ReturnType<typeof makeDb>, path: string): Doc | undefined {
  return db.__store.get(path)?.data;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('submitSaleReturn — happy path, FIFO cost basis, drawer', () => {
  test('partial cross-day cash return: Staff initiates, Manager approves; stock at original cost; drawer pay-out', async () => {
    const db = makeDb(baseSeed());
    const res = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(res).toMatchObject({ ok: true, refundAmount: 162, refundMethod: 'cash', idempotent: false, returnNo: 'RT-R-O1-1' });
    if (!res.ok) return;

    const ret = data(db, `saleReturns/${res.returnId}`)!;
    expect(ret).toMatchObject({
      status: 'completed',
      originalOrderId: 'O1',
      originalReceiptNo: 'R-O1',
      branchId: 'B1',
      requesterStaffId: 's1',
      approverStaffId: 'm1',
      reason: 'สินค้าชำรุด',
    });
    const line = (ret.lines as Doc[])[0]!;
    expect(line).toMatchObject({ lineIndex: 0, originalSoldQty: 5, returnedQty: 2, previouslyReturnedQty: 0 });
    expect((line.pricing as Doc)).toMatchObject({ unitPrice: 100, lineDiscount: 50, lineTotal: 450, billDiscountAlloc: 45, refundAmount: 162 });
    // Original sale cost, never current product.cost (999) / avgCost (888).
    expect((line.cost as Doc).allocations).toEqual([
      expect.objectContaining({ originalLotId: 'L1', qtyBase: 2, costPerUnit: 40, restoreMode: 'original_lot', restoredLotId: 'L1' }),
    ]);
    expect(data(db, 'stockLots/L1')).toMatchObject({ qtyRemaining: 2, isDepleted: false });
    expect(data(db, 'products/P1/productStocks/B1')!.totalStockBase).toBe(10);
    const mv = data(db, `stockMovements/ret_${res.returnId}_0_0`)!;
    expect(mv).toMatchObject({ type: 'return', qty: 2, costPerUnit: 40, refType: 'saleReturn', sourceOrderId: 'O1', originalLotId: 'L1' });

    // Immutable refund record; original payment/sale untouched.
    expect(data(db, `saleRefunds/${res.refundId}`)).toMatchObject({ method: 'cash', amount: 162, executionMode: 'cash_drawer', gatewayConfirmed: false });
    expect(data(db, 'asyncOrders/O1')).toEqual(settledAsync('O1'));
    expect(data(db, 'orders/O1')!.status).toBe('completed');

    // Drawer: cash refund is a pay-out on the open shift, counted by BOTH the
    // terminal fold and the shift-close validator fold.
    const shift = data(db, 'shifts/SH1')!;
    const entries = shift.cashEntries as never[];
    expect(entries).toEqual([expect.objectContaining({ id: `rfd_${res.returnId}`, type: 'pay_out', amount: 162, staffId: 's1' })]);
    expect(foldCashEntries(entries).payOutTotal).toBe(162);
    expect(foldCashEntriesSnapshot(entries).payOutMinor).toBe(16200n);
    expect(data(db, `cashTransactions/rfd_${res.returnId}`)).toMatchObject({ type: 'pay_out', amount: 162, shiftId: 'SH1' });

    // Approval consumed under the distinct Return audience.
    const approvals = [...db.__store.entries()].filter(([k]) => k.startsWith('managerApprovals/'));
    expect(approvals).toHaveLength(1);
    expect(approvals[0]![1].data).toMatchObject({
      audience: SALE_RETURN_AUDIENCE,
      protectedAction: 'SALE_RETURN',
      requesterStaffId: 's1',
      approverStaffId: 'm1',
      consumingAudience: SALE_RETURN_AUDIENCE,
    });
    expect(approvals[0]![1].data.consumedAt).not.toBeNull();

    // Audit trail.
    for (const kind of ['initiated', 'approved', 'inventory_restored', 'refund_recorded', 'completed']) {
      expect(data(db, `saleReturnAuditEvents/${res.returnId}_${kind}`)).toMatchObject({
        eventType: kind,
        originalOrderId: 'O1',
        requesterStaffId: 's1',
        approverStaffId: 'm1',
        refundAmount: 162,
        refundMethod: 'cash',
      });
    }
    expect(data(db, `auditLogs/saleReturn_${res.returnId}`)).toMatchObject({ action: 'refund' });
  });

  test('second return of the remaining qty spans two cost layers; then the line is exhausted', async () => {
    const db = makeDb(baseSeed());
    const first = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(first.ok).toBe(true);
    const second = await performSubmitSaleReturn(
      db as never,
      submitReq({ attemptId: 'attempt-0002', lines: [{ lineIndex: 0, productId: 'P1', qty: 3 }], expectedRefundAmount: 243 }),
      staffAuth,
      deps,
    );
    expect(second).toMatchObject({ ok: true, refundAmount: 243, returnNo: 'RT-R-O1-2' });
    if (!second.ok) return;
    const ret = data(db, `saleReturns/${second.returnId}`)!;
    expect(((ret.lines as Doc[])[0]!.cost as Doc).allocations).toEqual([
      expect.objectContaining({ originalLotId: 'L1', qtyBase: 1, costPerUnit: 40 }),
      expect.objectContaining({ originalLotId: 'L2', qtyBase: 2, costPerUnit: 55 }),
    ]);
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(3); // back to its original 3 sold
    expect(data(db, 'stockLots/L2')!.qtyRemaining).toBe(10);
    expect(data(db, 'products/P1/productStocks/B1')!.totalStockBase).toBe(13);
    expect(data(db, 'saleReturnLedgers/O1')).toMatchObject({ returnCount: 2, refundedTotalMinor: 40500 });

    const over = await performSubmitSaleReturn(
      db as never,
      submitReq({ attemptId: 'attempt-0003', lines: [{ lineIndex: 0, productId: 'P1', qty: 1 }], expectedRefundAmount: 0, refundMethod: 'none' }),
      staffAuth,
      deps,
    );
    expect(over).toEqual({ ok: false, code: 'over_return' });
  });

  test('multi-line full return (incl. 12-unit case line) → sale fully returned, further return blocked', async () => {
    const db = makeDb(baseSeed());
    const res = await performSubmitSaleReturn(
      db as never,
      submitReq({
        lines: [
          { lineIndex: 0, productId: 'P1', qty: 5 },
          { lineIndex: 1, productId: 'P2', qty: 2 },
        ],
        expectedRefundAmount: 945,
      }),
      staffAuth,
      deps,
    );
    expect(res).toMatchObject({ ok: true, refundAmount: 945 });
    expect(data(db, 'products/P2/productStocks/B1')!.totalStockBase).toBe(24);
    expect(data(db, 'stockLots/L3')!.qtyRemaining).toBe(24);
    // Returning every remaining line is still a Return, never a Void.
    expect(data(db, 'asyncOrders/O1')!.status).toBe('completed');
    expect(data(db, 'orders/O1')!.status).toBe('completed');

    const ctx = await performGetSaleReturnContext(db as never, { orderId: 'O1', branchId: 'B1' }, staffAuth, deps);
    expect(ctx).toMatchObject({ ok: true, classification: 'RETURN_NOT_ELIGIBLE', reason: 'fully_returned' });
    const again = await performSubmitSaleReturn(
      db as never,
      submitReq({ attemptId: 'attempt-0009', lines: [{ lineIndex: 1, productId: 'P2', qty: 1 }], expectedRefundAmount: 0, refundMethod: 'none' }),
      staffAuth,
      deps,
    );
    expect(again).toEqual({ ok: false, code: 'return_not_eligible' });
  });

  test('non-cash (QR) refund: manual record with reference, drawer cash untouched', async () => {
    const db = makeDb(
      baseSeed({ 'asyncOrders/O1': settledAsync('O1', { payments: [{ method: 'qr', amount: 945, ref: null }], paidAmt: 945, changeAmt: 0 }) }),
    );
    const noRef = await performSubmitSaleReturn(db as never, submitReq({ refundMethod: 'qr', shiftId: '' }), staffAuth, deps);
    expect(noRef).toEqual({ ok: false, code: 'reference_required' });
    const res = await performSubmitSaleReturn(
      db as never,
      submitReq({ attemptId: 'attempt-0002', refundMethod: 'qr', refundReference: 'QR-TXN-778', shiftId: '' }),
      staffAuth,
      deps,
    );
    expect(res).toMatchObject({ ok: true, refundMethod: 'qr', refundAmount: 162 });
    if (!res.ok) return;
    expect(data(db, `saleRefunds/${res.refundId}`)).toMatchObject({
      method: 'qr',
      reference: 'QR-TXN-778',
      executionMode: 'manual_external',
      gatewayConfirmed: false,
      cashEntryId: null,
    });
    expect(data(db, 'shifts/SH1')!.cashEntries).toEqual([]);
    expect([...db.__store.keys()].some((k) => k.startsWith('cashTransactions/'))).toBe(false);
  });

  test('cash refund requires the requester’s own open shift', async () => {
    const closed = makeDb(baseSeed({ 'shifts/SH1': { status: 'closed', branchId: 'B1', staffId: 's1', cashEntries: [] } }));
    expect(await performSubmitSaleReturn(closed as never, submitReq(), staffAuth, deps)).toEqual({ ok: false, code: 'shift_required' });
    const other = makeDb(baseSeed({ 'shifts/SH1': { status: 'open', branchId: 'B1', staffId: 'someone-else', cashEntries: [] } }));
    expect(await performSubmitSaleReturn(other as never, submitReq(), staffAuth, deps)).toEqual({ ok: false, code: 'shift_required' });
    const none = makeDb(baseSeed());
    expect(await performSubmitSaleReturn(none as never, submitReq({ shiftId: '' }), staffAuth, deps)).toEqual({ ok: false, code: 'shift_required' });
    expect(data(none, 'stockLots/L1')!.qtyRemaining).toBe(0);
  });

  test('original lot no longer safe → explicit restoration lot carrying source + original cost', async () => {
    const db = makeDb(baseSeed({ 'stockLots/L1': { id: 'L1', productId: 'OTHER', branchId: 'B1', costPerUnit: 40, qtyRemaining: 0 } }));
    const res = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const lotId = `ret_${res.returnId}_0_0`;
    expect(data(db, `stockLots/${lotId}`)).toMatchObject({
      productId: 'P1',
      branchId: 'B1',
      costPerUnit: 40,
      qtyRemaining: 2,
      source: 'sale_return',
      sourceReturnId: res.returnId,
      sourceOrderId: 'O1',
      sourceLineIndex: 0,
      originalLotId: 'L1',
      originalCostPerUnit: 40,
    });
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(0);
  });

  test('oversold portion restores product stock without fabricating a lot (exact inverse of the sale)', async () => {
    const lines = saleLines();
    lines[0]!.lotRefs = [
      { lotId: 'L1', qty: 3, cost: 40 },
      { lotId: 'oversell', qty: 2, cost: 40 },
    ];
    const db = makeDb(baseSeed({ 'asyncOrders/O1': settledAsync('O1', { lines }) }));
    const res = await performSubmitSaleReturn(
      db as never,
      submitReq({ lines: [{ lineIndex: 0, productId: 'P1', qty: 5 }], expectedRefundAmount: 405 }),
      staffAuth,
      deps,
    );
    expect(res.ok).toBe(true);
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(3);
    expect(data(db, 'stockLots/oversell')).toBeUndefined();
    expect(data(db, 'products/P1/productStocks/B1')!.totalStockBase).toBe(13);
  });
});

describe('submitSaleReturn — idempotency / concurrency', () => {
  test('duplicate replay is exact-once (no second stock/refund/drawer effect)', async () => {
    const db = makeDb(baseSeed());
    const first = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    const replay = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay).toMatchObject({ idempotent: true, returnId: first.returnId, returnNo: first.returnNo, refundAmount: 162 });
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(2);
    expect((data(db, 'shifts/SH1')!.cashEntries as unknown[]).length).toBe(1);
    expect(data(db, 'saleReturnLedgers/O1')!.returnCount).toBe(1);
    expect([...db.__store.keys()].filter((k) => k.startsWith('saleRefunds/'))).toHaveLength(1);
    expect([...db.__store.keys()].some((k) => k.startsWith(`saleReturnAuditEvents/${first.returnId}_duplicate_replay_`))).toBe(true);
  });

  test('same attempt with different content is an idempotency conflict, not a second return', async () => {
    const db = makeDb(baseSeed());
    await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    const conflict = await performSubmitSaleReturn(
      db as never,
      submitReq({ lines: [{ lineIndex: 0, productId: 'P1', qty: 1 }], expectedRefundAmount: 81 }),
      staffAuth,
      deps,
    );
    expect(conflict).toEqual({ ok: false, code: 'idempotency_conflict' });
    expect(data(db, 'saleReturnLedgers/O1')!.returnCount).toBe(1);
  });

  test('concurrent returns on the same sale serialize: only one fits, cumulative qty never exceeds sold', async () => {
    const db = makeDb(baseSeed());
    const a = submitReq({ attemptId: 'attempt-A001', lines: [{ lineIndex: 0, productId: 'P1', qty: 3 }], expectedRefundAmount: 243 });
    const b = submitReq({ attemptId: 'attempt-B001', lines: [{ lineIndex: 0, productId: 'P1', qty: 3 }], expectedRefundAmount: 243 });
    const [ra, rb] = await Promise.all([
      performSubmitSaleReturn(db as never, a, staffAuth, deps),
      performSubmitSaleReturn(db as never, b, staffAuth, deps),
    ]);
    const oks = [ra, rb].filter((r) => r.ok);
    const fails = [ra, rb].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(fails).toEqual([{ ok: false, code: 'over_return' }]);
    expect(db.__conflicts).toBeGreaterThan(0); // transactions genuinely interleaved and were re-run
    expect(data(db, 'saleReturnLedgers/O1')).toMatchObject({ returnCount: 1 });
    expect(data(db, 'products/P1/productStocks/B1')!.totalStockBase).toBe(11);
    expect((data(db, 'shifts/SH1')!.cashEntries as unknown[]).length).toBe(1);
  });

  test('concurrent returns that both fit are both applied exactly once', async () => {
    const db = makeDb(baseSeed());
    const [ra, rb] = await Promise.all([
      performSubmitSaleReturn(db as never, submitReq({ attemptId: 'attempt-A002' }), staffAuth, deps),
      performSubmitSaleReturn(
        db as never,
        submitReq({ attemptId: 'attempt-B002', lines: [{ lineIndex: 1, productId: 'P2', qty: 1 }], expectedRefundAmount: 270 }),
        staffAuth,
        deps,
      ),
    ]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(data(db, 'saleReturnLedgers/O1')).toMatchObject({ returnCount: 2, refundedTotalMinor: 16200 + 27000 });
    expect((data(db, 'shifts/SH1')!.cashEntries as unknown[]).length).toBe(2);
  });
});

describe('submitSaleReturn — eligibility / evidence / money guards', () => {
  test('voided sale cannot be returned', async () => {
    const db = makeDb(baseSeed({ 'asyncOrders/O1': settledAsync('O1', { status: 'voided', voidReconciled: true }) }));
    expect(await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps)).toEqual({ ok: false, code: 'return_not_eligible' });
    const ctx = await performGetSaleReturnContext(db as never, { orderId: 'O1', branchId: 'B1' }, staffAuth, deps);
    expect(ctx).toEqual({ ok: true, classification: 'RETURN_NOT_ELIGIBLE', reason: 'voided', context: null });
  });

  test('historical sale without FIFO evidence fails closed (RETURN_UNSUPPORTED_EVIDENCE)', async () => {
    const lines = saleLines().map((l) => ({ ...l, lotRefs: undefined }));
    const db = makeDb(baseSeed({ 'asyncOrders/O1': settledAsync('O1', { lines }) }));
    const ctx = await performGetSaleReturnContext(db as never, { orderId: 'O1', branchId: 'B1' }, staffAuth, deps);
    expect(ctx).toMatchObject({ ok: true, classification: 'RETURN_UNSUPPORTED_EVIDENCE', reason: 'line_evidence_missing' });
    expect(await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps)).toEqual({
      ok: false,
      code: 'return_unsupported_evidence',
    });
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(0);
  });

  test('over-refund (client-inflated amount) and cross-tender cash leak are rejected', async () => {
    const db = makeDb(baseSeed());
    expect(await performSubmitSaleReturn(db as never, submitReq({ expectedRefundAmount: 200 }), staffAuth, deps)).toEqual({
      ok: false,
      code: 'refund_mismatch',
    });
    const mixed = makeDb(
      baseSeed({
        'asyncOrders/O1': settledAsync('O1', {
          payments: [
            { method: 'cash', amount: 100, ref: null },
            { method: 'card', amount: 845, ref: null },
          ],
          paidAmt: 945,
          changeAmt: 0,
        }),
      }),
    );
    expect(await performSubmitSaleReturn(mixed as never, submitReq(), staffAuth, deps)).toEqual({ ok: false, code: 'refund_cap_exceeded' });
    expect(data(mixed, 'shifts/SH1')!.cashEntries).toEqual([]);
  });

  test('context shows sold / already returned / returnable for the UI', async () => {
    const db = makeDb(baseSeed());
    await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    const ctx = await performGetSaleReturnContext(db as never, { orderId: 'O1', branchId: 'B1' }, staffAuth, deps);
    expect(ctx).toMatchObject({ ok: true, classification: 'RETURN_ELIGIBLE' });
    if (!ctx.ok || !ctx.context) return;
    expect(ctx.context.billId).toBe('R-O1');
    expect(ctx.context.customerName).toBe('คุณลูกค้า');
    expect(ctx.context.lines[0]).toMatchObject({ soldQty: 5, returnedQty: 2, returnableQty: 3, refundableShareMinor: 40500, soldQtyMilli: 5000, returnedQtyMilli: 2000 });
    expect(ctx.context.refundMethods).toEqual([{ method: 'cash', remaining: 783 }]);
  });
});

describe('submitSaleReturn — authority (D-RET-7)', () => {
  test('self-approval is rejected before any PIN compare', async () => {
    const db = makeDb(baseSeed());
    let compares = 0;
    const res = await performSubmitSaleReturn(db as never, submitReq({ approverStaffId: 's1' }), staffAuth, {
      ...deps,
      comparePin: async () => {
        compares += 1;
        return true;
      },
    });
    expect(res).toEqual({ ok: false, code: 'self_approval_not_permitted' });
    expect(compares).toBe(0);
  });

  test('approver without live pos_return is rejected even if they hold pos_void', async () => {
    const matrix = clone(MATRIX);
    matrix.manager = matrix.manager.filter((p) => p !== 'pos_return');
    const db = makeDb(baseSeed({ 'settings/_rolePermissions': { rolePermissions: matrix } }));
    expect(await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps)).toEqual({ ok: false, code: 'approver_not_eligible' });
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(0);
  });

  test('staff cannot approve (staff role, even if granted pos_return)', async () => {
    const matrix = clone(MATRIX);
    matrix.staff = [...matrix.staff, 'pos_return'];
    const db = makeDb(
      baseSeed({
        'settings/_rolePermissions': { rolePermissions: matrix },
        'users/s2': { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['B1'] },
        'userCredentials/s2': cred(),
      }),
    );
    expect(await performSubmitSaleReturn(db as never, submitReq({ approverStaffId: 's2' }), staffAuth, deps)).toEqual({
      ok: false,
      code: 'approver_not_eligible',
    });
  });

  test('inactive / deleted / branch-ineligible actors are rejected', async () => {
    const inactiveApprover = makeDb(baseSeed({ 'users/m1': { isActive: false, deletedAt: null, authVersion: 0, role: 'manager', branchIds: ['B1'] } }));
    expect(await performSubmitSaleReturn(inactiveApprover as never, submitReq(), staffAuth, deps)).toEqual({
      ok: false,
      code: 'approver_not_eligible',
    });
    const deletedApprover = makeDb(baseSeed({ 'users/m1': { isActive: true, deletedAt: NOW, authVersion: 0, role: 'manager', branchIds: ['B1'] } }));
    expect(await performSubmitSaleReturn(deletedApprover as never, submitReq(), staffAuth, deps)).toEqual({
      ok: false,
      code: 'approver_not_eligible',
    });
    const otherBranch = makeDb(baseSeed());
    expect(await performSubmitSaleReturn(otherBranch as never, submitReq({ approverStaffId: 'm2' }), staffAuth, deps)).toEqual({
      ok: false,
      code: 'approver_not_eligible',
    });
    const inactiveRequester = makeDb(baseSeed({ 'users/s1': { isActive: false, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['B1'] } }));
    expect(await performSubmitSaleReturn(inactiveRequester as never, submitReq(), staffAuth, deps)).toEqual({
      ok: false,
      code: 'not_authorized',
    });
    const requesterOtherBranch = makeDb(baseSeed({ 'users/s1': { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['B2'] } }));
    expect(await performSubmitSaleReturn(requesterOtherBranch as never, submitReq(), staffAuth, deps)).toEqual({
      ok: false,
      code: 'branch_mismatch',
    });
    const noSale = makeDb(baseSeed());
    expect(
      await performSubmitSaleReturn(noSale as never, submitReq(), { ...staffAuth, token: { ...staffAuth.token, permissions: ['product_view'] } }, deps),
    ).toEqual({ ok: false, code: 'not_authorized' });
  });

  test('approver deactivated between PIN mint and commit is caught at the transactional re-check', async () => {
    const db = makeDb(baseSeed());
    const res = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, {
      ...deps,
      comparePin: async (pin, hash) => {
        const ok = pin === GOOD_PIN && hash === '$2b$10$realhash';
        // Mutate AFTER the mint's eligibility read but before the consume tx.
        queueMicrotask(() => {
          const e = db.__store.get('users/m1')!;
          db.__store.set('users/m1', { data: { ...e.data, isActive: false }, version: e.version + 1 });
        });
        return ok;
      },
    });
    expect(res).toEqual({ ok: false, code: 'approver_not_eligible' });
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(0);
    expect(data(db, 'saleReturnLedgers/O1')).toBeUndefined();
  });

  test('wrong approver PIN is rejected and nothing is written', async () => {
    const db = makeDb(baseSeed());
    expect(await performSubmitSaleReturn(db as never, submitReq({ pin: '9999' }), staffAuth, deps)).toEqual({
      ok: false,
      code: 'invalid_credentials',
    });
    expect(data(db, 'saleReturnLedgers/O1')).toBeUndefined();
    expect([...db.__store.keys()].some((k) => k.startsWith('saleReturns/'))).toBe(false);
  });

  test('admin with ALL may approve', async () => {
    const db = makeDb(baseSeed());
    expect(await performSubmitSaleReturn(db as never, submitReq({ approverStaffId: 'a1' }), staffAuth, deps)).toMatchObject({ ok: true });
  });
});

describe('Return and Void stay distinct', () => {
  test('registry: SALE_RETURN is not a Void/offline privileged action and has its own audience + permission', () => {
    expect([...PRIVILEGED_ACTION_IDS]).toEqual(['VOID_PENDING_SALE', 'VOID_SETTLED_SALE']);
    expect(getActionRequirement(SALE_RETURN_ACTION_ID)).toBeNull();
    expect(audienceForProtectedAction(SALE_RETURN_ACTION_ID)).toBe(SALE_RETURN_AUDIENCE);
    expect(SALE_RETURN_AUDIENCE).not.toBe(PRIVILEGED_VOID_AUDIENCE);
    expect(SALE_RETURN_APPROVER_PERMISSION).toBe('pos_return');
  });

  test('a sale with an accepted Return cannot be voided afterwards (no double restoration)', async () => {
    const db = makeDb(baseSeed());
    const ret = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(ret.ok).toBe(true);
    const before = clone(data(db, 'asyncOrders/O1'));
    const outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('O1'), {
      privilegedVoidExecutionId: 'exec-1',
    });
    expect(outcome).toEqual({ kind: 'NOOP', reason: 'return_present' });
    expect(data(db, 'asyncOrders/O1')).toEqual(before);
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(2);
  });

  test('submitPrivilegedVoid refuses before consuming an approval when a Return exists', async () => {
    const db = makeDb(
      baseSeed({
        'asyncOrders/O1': settledAsync('O1', { serverCreatedAt: { toMillis: () => NOW } }),
        'saleReturnLedgers/O1': { schemaVersion: 1, returnCount: 1 },
      }),
    );
    const res = await performSubmitPrivilegedVoid(
      db as never,
      { commandId: 'cmd-void-1', protectedAction: 'VOID_SETTLED_SALE', targetEntityId: 'O1', branchId: 'B1' },
      staffAuth,
      { nowMillis: NOW },
    );
    expect(res).toEqual({ ok: false, code: 'invalid_target' });
    expect([...db.__store.keys()].some((k) => k.startsWith('privilegedActionNonces/'))).toBe(false);
  });

  test('a Return never writes the original sale documents or Void fields', async () => {
    const db = makeDb(baseSeed());
    const before = { a: clone(data(db, 'asyncOrders/O1')), o: clone(data(db, 'orders/O1')) };
    await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(data(db, 'asyncOrders/O1')).toEqual(before.a);
    expect(data(db, 'orders/O1')).toEqual(before.o);
  });

  test('returnId is deterministic per attempt (retry-safe identity)', () => {
    expect(deriveReturnId('B1', 'O1', 'attempt-0001')).toMatch(/^[0-9a-f]{40}$/);
  });
});
