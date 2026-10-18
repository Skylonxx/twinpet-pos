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
import { APPROVAL_TTL_MS, audienceForProtectedAction, deriveApprovalId } from '../requestManagerApprovalCore';
import { performRequestManagerApproval } from '../requestManagerApproval';
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

/**
 * Interleaving hooks (blocker-fix tests). `afterDirectGet` runs AFTER a plain
 * `ref.get()` captured its snapshot (the caller then receives that now
 * possibly stale snapshot); `afterTxGet` runs after a transactional read
 * recorded its version, so another operation can commit in between and force
 * a conflict at commit. Each hook may return a promise to block.
 */
type Hooks = {
  afterDirectGet?: (path: string) => unknown;
  afterTxGet?: (path: string) => unknown;
};

function makeDb(seed: Record<string, Doc>) {
  const store = new Map<string, Entry>(Object.entries(seed).map(([k, v]) => [k, { data: clone(v), version: 1 }]));
  let commits = 0;
  let conflicts = 0;
  let autoId = 0;
  const hooks: Hooks = {};

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
    doc: (id?: string) => FakeDocRef;
  }
  function docRef(path: string): FakeDocRef {
    return {
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      collection: (n: string) => colRef(`${path}/${n}`),
      get: async () => {
        const s = snap(path);
        await hooks.afterDirectGet?.(path);
        return s;
      },
      set: async (data: Doc, opts?: { merge?: boolean }) => apply(path, data, opts?.merge === true),
    };
  }
  function colRef(path: string): FakeColRef {
    return { path, doc: (id?: string) => docRef(`${path}/${id ?? `auto${(autoId += 1)}`}`) };
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
            const s = snap(ref.path);
            await hooks.afterTxGet?.(ref.path);
            return s;
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
    __hooks: hooks,
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

  // D-RET-FIX-4 (supersedes the V1 "restore without a lot" behaviour).
  test('a quantity crossing into the oversell allocation fails closed with no stock/refund/cash effect', async () => {
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
    expect(res).toEqual({ ok: false, code: 'oversell_return_unsupported' });
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(0);
    expect(data(db, 'stockLots/oversell')).toBeUndefined();
    expect(data(db, 'products/P1/productStocks/B1')!.totalStockBase).toBe(8);
    expect(data(db, 'shifts/SH1')!.cashEntries).toEqual([]);
    expect(data(db, 'saleReturnLedgers/O1')).toBeUndefined();
    expect([...db.__store.keys()].some((k) => k.startsWith('saleRefunds/') || k.startsWith('managerApprovals/'))).toBe(false);

    // The real-lot portion of the same line is still returnable.
    const ok = await performSubmitSaleReturn(
      db as never,
      submitReq({ attemptId: 'attempt-0002', lines: [{ lineIndex: 0, productId: 'P1', qty: 3 }], expectedRefundAmount: 243 }),
      staffAuth,
      deps,
    );
    expect(ok).toMatchObject({ ok: true, refundAmount: 243 });
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(3);
    const ctx = await performGetSaleReturnContext(db as never, { orderId: 'O1', branchId: 'B1' }, staffAuth, deps);
    expect(ctx).toMatchObject({ ok: true, classification: 'RETURN_ELIGIBLE' });
    if (ctx.ok && ctx.context) {
      expect(ctx.context.lines[0]).toMatchObject({ returnableQty: 2, supportedReturnableQty: 0, oversellLimited: true });
    }
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

// ═══ TPOS-USABLE-POS-RETURN-REFUND-V1-BLOCKER-FIX-CLAUDE-001 ═════════════════

const VOID_CMD = 'cmd-void-1';
const voidReq = {
  commandId: VOID_CMD,
  protectedAction: 'VOID_SETTLED_SALE',
  targetEntityId: 'O1',
  branchId: 'B1',
  voidReason: 'ลูกค้าเปลี่ยนใจ',
} as never;

/** Same-day settled sale: both a Return and an online Void are possible. */
function voidableSeed(extra: Record<string, Doc> = {}): Record<string, Doc> {
  return baseSeed({ 'asyncOrders/O1': settledAsync('O1', { serverCreatedAt: { toMillis: () => NOW } }), ...extra });
}

async function mintVoidApproval(db: ReturnType<typeof makeDb>) {
  const res = await performRequestManagerApproval(
    db as never,
    {
      commandId: VOID_CMD,
      protectedAction: 'VOID_SETTLED_SALE',
      targetEntityId: 'O1',
      branchId: 'B1',
      pin: GOOD_PIN,
      securityModel: 'delegated',
      approverStaffId: 'm1',
    } as never,
    staffAuth,
    { nowMillis: NOW, comparePin: deps.comparePin },
  );
  expect(res).toMatchObject({ ok: true });
  return `managerApprovals/${deriveApprovalId(VOID_CMD)}`;
}

function keys(db: ReturnType<typeof makeDb>, prefix: string): string[] {
  return [...db.__store.keys()].filter((k) => k.startsWith(prefix));
}

function returnApprovalPaths(db: ReturnType<typeof makeDb>): string[] {
  return keys(db, 'managerApprovals/').filter((k) => data(db, k)!.protectedAction === 'SALE_RETURN');
}

/** Bump a doc's version (and optionally patch it) to simulate a concurrent writer. */
function touch(db: ReturnType<typeof makeDb>, path: string, patch: Doc = {}) {
  const e = db.__store.get(path)!;
  db.__store.set(path, { data: { ...e.data, ...patch }, version: e.version + 1 });
}

const MALFORMED_LEDGER = { schemaVersion: 1, orderId: 'O1', branchId: 'B1', returnCount: 0, refundedTotalMinor: 0, refundedByMethodMinor: {}, lines: [], acceptedReturnIds: ['ghost-return'] };

describe('D-RET-FIX-6 Return vs online Void — true interleaving', () => {
  test('Return commits between the Void pre-check and its consume tx → Void consumes nothing, marks nothing', async () => {
    const db = makeDb(voidableSeed());
    const voidApprovalPath = await mintVoidApproval(db);
    let returnRes: Awaited<ReturnType<typeof performSubmitSaleReturn>> | undefined;
    db.__hooks.afterDirectGet = async (path) => {
      if (path !== 'saleReturnLedgers/O1') return;
      db.__hooks.afterDirectGet = undefined;
      // The Void's pre-check has already captured "no ledger"; the Return now commits.
      returnRes = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    };
    const voidRes = await performSubmitPrivilegedVoid(db as never, voidReq, staffAuth, { nowMillis: NOW });
    expect(returnRes).toMatchObject({ ok: true, refundAmount: 162 });
    expect(voidRes).toEqual({ ok: false, code: 'invalid_target' });
    // The in-transaction ledger read stopped the Void BEFORE consume / nonce / stamp.
    expect(data(db, voidApprovalPath)!.consumedAt ?? null).toBeNull();
    expect(keys(db, 'privilegedActionNonces/')).toEqual([]);
    expect(data(db, 'asyncOrders/O1')!.voidedBy).toBeUndefined();
    expect(data(db, 'asyncOrders/O1')!.status).toBe('completed');
    // Exactly one restoration: the Return's 2 units on L1.
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(2);
    expect(data(db, 'products/P1/productStocks/B1')!.totalStockBase).toBe(10);
  });

  test('Void consume commits while the Return transaction is in flight → Return sees the Void and rejects', async () => {
    const db = makeDb(voidableSeed());
    await mintVoidApproval(db);
    let voidRes: Awaited<ReturnType<typeof performSubmitPrivilegedVoid>> | undefined;
    db.__hooks.afterTxGet = async (path) => {
      if (path !== 'asyncOrders/O1') return;
      db.__hooks.afterTxGet = undefined;
      voidRes = await performSubmitPrivilegedVoid(db as never, voidReq, staffAuth, { nowMillis: NOW });
    };
    const ret = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(voidRes).toMatchObject({ ok: true, outcome: 'VOID_APPLIED' });
    // Rejected either by a read in the same attempt (voided canonical order) or
    // on the conflict retry — never committed.
    expect(ret).toEqual({ ok: false, code: 'return_not_eligible' });
    // No Return effect at all; its approval was never consumed.
    expect(keys(db, 'saleReturns/')).toEqual([]);
    expect(keys(db, 'saleRefunds/')).toEqual([]);
    expect(data(db, 'saleReturnLedgers/O1')).toBeUndefined();
    expect(data(db, 'shifts/SH1')!.cashEntries).toEqual([]);
    for (const p of returnApprovalPaths(db)) expect(data(db, p)!.consumedAt ?? null).toBeNull();
    // Exactly one restoration: the whole-bill Void (L1 3, L2 +2, L3 24).
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(3);
    expect(data(db, 'stockLots/L2')!.qtyRemaining).toBe(10);
    expect(data(db, 'stockLots/L3')!.qtyRemaining).toBe(24);
    expect(data(db, 'products/P1/productStocks/B1')!.totalStockBase).toBe(13);
  });

  test('Void lands AFTER the Return planned (last read) → commit conflict, retry rejects; no double restoration', async () => {
    const db = makeDb(voidableSeed());
    await mintVoidApproval(db);
    let voidRes: Awaited<ReturnType<typeof performSubmitPrivilegedVoid>> | undefined;
    db.__hooks.afterTxGet = async (path) => {
      // stockLots/L1 is read by the Return tx only after it validated the sale.
      if (path !== 'stockLots/L1') return;
      db.__hooks.afterTxGet = undefined;
      voidRes = await performSubmitPrivilegedVoid(db as never, voidReq, staffAuth, { nowMillis: NOW });
    };
    const ret = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(voidRes).toMatchObject({ ok: true, outcome: 'VOID_APPLIED' });
    expect(db.__conflicts).toBeGreaterThan(0);
    expect(ret).toEqual({ ok: false, code: 'return_not_eligible' });
    expect(keys(db, 'saleReturns/')).toEqual([]);
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(3);
    expect(data(db, 'products/P1/productStocks/B1')!.totalStockBase).toBe(13);
  });

  test('Void consumed first (voidedBy stamped, canonical void still pending) → Return is refused', async () => {
    const db = makeDb(voidableSeed());
    await mintVoidApproval(db);
    const res = await performSubmitPrivilegedVoid(db as never, voidReq, staffAuth, {
      nowMillis: NOW,
      // Simulate a crash between consume and canonical execution.
      executeCanonicalVoid: async () => ({ kind: 'NOOP', reason: 'not_settled' }),
    });
    expect(res).toMatchObject({ ok: true });
    expect(data(db, 'asyncOrders/O1')!.voidedBy).toBe('s1');
    expect(await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps)).toEqual({ ok: false, code: 'return_not_eligible' });
    const ctx = await performGetSaleReturnContext(db as never, { orderId: 'O1', branchId: 'B1' }, staffAuth, deps);
    expect(ctx).toMatchObject({ ok: true, classification: 'RETURN_NOT_ELIGIBLE', reason: 'void_in_progress' });
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(0);
  });
});

describe('D-RET-FIX-6 Return vs reconcile Void and offline-adjudicated Void', () => {
  const OFFLINE_OPTS = { privilegedVoidExecutionId: 'offline-exec-1', oacId: 'oac-1', authoritativeActorStaffId: 's1' };

  for (const [label, opts] of [
    ['reconcile route (no options)', undefined],
    ['offline adjudication route', OFFLINE_OPTS],
  ] as const) {
    test(`${label}: after an accepted Return the canonical Void is a NOOP — no double restoration`, async () => {
      const db = makeDb(baseSeed());
      expect((await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps)).ok).toBe(true);
      const before = clone(data(db, 'asyncOrders/O1'));
      const outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('O1') as never, opts as never);
      expect(outcome).toEqual({ kind: 'NOOP', reason: 'return_present' });
      expect(data(db, 'asyncOrders/O1')).toEqual(before);
      expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(2);
      expect(data(db, 'products/P1/productStocks/B1')!.totalStockBase).toBe(10);
    });

    test(`${label}: a canonical Void committing mid-Return wins; the Return rejects with no effect`, async () => {
      const db = makeDb(baseSeed());
      let outcome: unknown;
      db.__hooks.afterTxGet = async (path) => {
        if (path !== 'asyncOrders/O1') return;
        db.__hooks.afterTxGet = undefined;
        outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('O1') as never, opts as never);
      };
      const ret = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
      expect(outcome).toEqual({ kind: 'VOID_APPLIED' });
      expect(ret).toEqual({ ok: false, code: 'return_not_eligible' });
      expect(keys(db, 'saleReturns/')).toEqual([]);
      expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(3);
      expect(data(db, 'products/P1/productStocks/B1')!.totalStockBase).toBe(13);
    });
  }
});

describe('D-RET-FIX-2 malformed ledger fails closed on every path', () => {
  test('Return: context reports ledger_malformed; submit rejects before any approval or effect', async () => {
    const db = makeDb(voidableSeed({ 'saleReturnLedgers/O1': MALFORMED_LEDGER }));
    const ctx = await performGetSaleReturnContext(db as never, { orderId: 'O1', branchId: 'B1' }, staffAuth, deps);
    expect(ctx).toEqual({ ok: true, classification: 'RETURN_UNSUPPORTED_EVIDENCE', reason: 'ledger_malformed', context: null });
    expect(await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps)).toEqual({ ok: false, code: 'return_unsupported_evidence' });
    expect(keys(db, 'managerApprovals/')).toEqual([]);
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(0);
    expect(data(db, 'shifts/SH1')!.cashEntries).toEqual([]);
  });

  test('Return: a structurally valid but inconsistent ledger (refund not matching qty) also fails closed', async () => {
    const inconsistent = {
      schemaVersion: 1,
      orderId: 'O1',
      branchId: 'B1',
      returnCount: 1,
      refundedTotalMinor: 100,
      refundedByMethodMinor: { cash: 100 },
      lines: [{ lineIndex: 0, returnedQtyMilli: 1000, returnedQtyBaseMilli: 1000, refundedMinor: 100 }],
      acceptedReturnIds: ['r-1'],
    };
    const db = makeDb(baseSeed({ 'saleReturnLedgers/O1': inconsistent }));
    expect(await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps)).toEqual({ ok: false, code: 'return_unsupported_evidence' });
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(0);
  });

  test('Void: reconcile, offline-adjudication and online routes all block on a malformed (returnCount 0) ledger', async () => {
    const db = makeDb(voidableSeed({ 'saleReturnLedgers/O1': MALFORMED_LEDGER }));
    const before = clone(data(db, 'asyncOrders/O1'));
    const ref = db.collection('asyncOrders').doc('O1') as never;
    expect(await handleVoidIntent(db as never, ref)).toEqual({ kind: 'NOOP', reason: 'return_present' });
    expect(
      await handleVoidIntent(db as never, ref, { privilegedVoidExecutionId: 'x', oacId: 'o', authoritativeActorStaffId: 's1' } as never),
    ).toEqual({ kind: 'NOOP', reason: 'return_present' });
    const voidApprovalPath = await mintVoidApproval(db);
    expect(await performSubmitPrivilegedVoid(db as never, voidReq, staffAuth, { nowMillis: NOW })).toEqual({ ok: false, code: 'invalid_target' });
    expect(data(db, voidApprovalPath)!.consumedAt ?? null).toBeNull();
    expect(keys(db, 'privilegedActionNonces/')).toEqual([]);
    expect(data(db, 'asyncOrders/O1')).toEqual(before);
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(0);
  });
});

describe('D-RET-FIX-3 FIFO original-lot safety (in the Return transaction)', () => {
  async function returnTwo(seedLot: Doc | undefined) {
    const db = makeDb(baseSeed(seedLot === undefined ? {} : { 'stockLots/L1': seedLot }));
    if (seedLot === undefined) db.__store.delete('stockLots/L1');
    const res = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(res.ok).toBe(true);
    const returnId = res.ok ? res.returnId : '';
    const alloc = (((data(db, `saleReturns/${returnId}`)!.lines as Doc[])[0]!.cost as Doc).allocations as Doc[])[0]!;
    return { db, returnId, alloc };
  }
  const lot = (over: Doc = {}): Doc => ({ id: 'L1', productId: 'P1', branchId: 'B1', costPerUnit: 40, qtyReceived: 3, qtyRemaining: 0, isDepleted: true, ...over });

  test('intact lot with room: in place, exact value (never a blind increment)', async () => {
    const { db, alloc } = await returnTwo(lot());
    expect(alloc).toMatchObject({ restoreMode: 'original_lot', restoreDecisionReason: null, restoredLotId: 'L1' });
    expect(data(db, 'stockLots/L1')).toMatchObject({ qtyRemaining: 2, qtyReceived: 3 });
  });

  for (const [label, seedLot, reason] of [
    ['near-full original lot', lot({ qtyRemaining: 2, isDepleted: false }), 'capacity_exceeded'],
    ['already-full / edited lot', lot({ qtyRemaining: 3, isDepleted: false }), 'capacity_exceeded'],
    ['over-full lot (remaining > received)', lot({ qtyRemaining: 5, isDepleted: false }), 'remaining_exceeds_received'],
    ['lot cost changed after the sale', lot({ costPerUnit: 45 }), 'cost_mismatch'],
    ['later receiving/history edit shrank qtyReceived', lot({ qtyReceived: 1 }), 'capacity_exceeded'],
    ['ghost lot', lot({ isGhost: true }), 'ghost_lot'],
    ['mismatched product', lot({ productId: 'OTHER' }), 'product_mismatch'],
    ['mismatched branch', lot({ branchId: 'B2' }), 'branch_mismatch'],
    ['malformed quantities', lot({ qtyRemaining: 'x' }), 'qty_malformed'],
    ['missing lot', undefined, 'lot_missing'],
  ] as const) {
    test(`${label}: original lot untouched; restoration lot at the sale-time cost with linkage`, async () => {
      const before = seedLot === undefined ? undefined : clone(seedLot);
      const { db, returnId, alloc } = await returnTwo(seedLot as Doc | undefined);
      const restId = `ret_${returnId}_0_0`;
      expect(alloc).toMatchObject({ restoreMode: 'restoration_lot', restoreDecisionReason: reason, restoredLotId: restId });
      if (before === undefined) expect(data(db, 'stockLots/L1')).toBeUndefined();
      else expect(data(db, 'stockLots/L1')).toEqual(before);
      expect(data(db, `stockLots/${restId}`)).toMatchObject({
        productId: 'P1',
        branchId: 'B1',
        costPerUnit: 40,
        qtyReceived: 2,
        qtyRemaining: 2,
        source: 'sale_return',
        sourceReturnId: returnId,
        sourceOrderId: 'O1',
        sourceLineIndex: 0,
        sourceMovementId: restId,
        originalLotId: 'L1',
        originalCostPerUnit: 40,
        restoreDecisionReason: reason,
      });
      expect(data(db, `stockMovements/${restId}`)).toMatchObject({ type: 'return', qty: 2, costPerUnit: 40, restoredLotId: restId, originalLotId: 'L1' });
      expect(data(db, 'products/P1/productStocks/B1')!.totalStockBase).toBe(10);
    });
  }

  test('concurrent original-lot change between plan and commit: re-decided on retry, never exceeds qtyReceived', async () => {
    const db = makeDb(baseSeed());
    db.__hooks.afterTxGet = (path) => {
      if (path !== 'stockLots/L1') return;
      db.__hooks.afterTxGet = undefined;
      // A receiving-history edit lands while the Return transaction is open.
      touch(db, 'stockLots/L1', { qtyRemaining: 2, isDepleted: false });
    };
    const res = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(res.ok).toBe(true);
    expect(db.__conflicts).toBeGreaterThan(0);
    expect(data(db, 'stockLots/L1')).toMatchObject({ qtyRemaining: 2, qtyReceived: 3 });
    if (res.ok) expect(data(db, `stockLots/ret_${res.returnId}_0_0`)).toMatchObject({ qtyRemaining: 2, costPerUnit: 40 });
  });
});

describe('D-RET-FIX-5 approver credential + TTL at the commit boundary', () => {
  test('credential rotates after the PIN approval but before the Return commits → rejected, nothing written', async () => {
    const db = makeDb(baseSeed());
    db.__hooks.afterTxGet = (path) => {
      if (path !== 'userCredentials/m1') return;
      db.__hooks.afterTxGet = undefined;
      touch(db, 'userCredentials/m1', { credentialVersion: 2 });
    };
    expect(await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps)).toEqual({ ok: false, code: 'not_authorized' });
    expect(db.__conflicts).toBeGreaterThan(0);
    expect(keys(db, 'saleReturns/')).toEqual([]);
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(0);
    expect(data(db, 'shifts/SH1')!.cashEntries).toEqual([]);
    for (const p of returnApprovalPaths(db)) expect(data(db, p)!.consumedAt ?? null).toBeNull();
  });

  for (const [label, patch] of [
    ['disabled', { disabled: true }],
    ['no longer compare-authoritative', { credentialState: 'backfilled_not_trusted' }],
  ] as const) {
    test(`credential becomes ${label} between mint and commit → rejected`, async () => {
      const db = makeDb(baseSeed());
      const res = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, {
        ...deps,
        comparePin: async (pin, hash) => {
          queueMicrotask(() => touch(db, 'userCredentials/m1', patch));
          return pin === GOOD_PIN && hash === '$2b$10$realhash';
        },
      });
      expect(res).toEqual({ ok: false, code: 'not_authorized' });
      expect(keys(db, 'saleReturns/')).toEqual([]);
      expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(0);
    });
  }

  test('approval expires while waiting before the transaction → expired, approval not consumed', async () => {
    const db = makeDb(baseSeed());
    let t = NOW;
    const res = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, {
      clock: () => t,
      comparePin: async (pin, hash) => {
        // The approval is minted at NOW; time then passes beyond its TTL.
        t = NOW + APPROVAL_TTL_MS + 1;
        return pin === GOOD_PIN && hash === '$2b$10$realhash';
      },
    });
    expect(res).toEqual({ ok: false, code: 'expired_approval' });
    expect(keys(db, 'saleReturns/')).toEqual([]);
    for (const p of returnApprovalPaths(db)) expect(data(db, p)!.consumedAt ?? null).toBeNull();
  });

  test('a transaction retry that crosses the expiry boundary uses the fresh attempt time → expired', async () => {
    const db = makeDb(baseSeed());
    let t = NOW;
    db.__hooks.afterTxGet = (path) => {
      if (path !== 'stockLots/L1') return;
      db.__hooks.afterTxGet = undefined;
      // First attempt was unexpired; a contention retry happens after expiry.
      t = NOW + APPROVAL_TTL_MS;
      touch(db, 'stockLots/L1');
    };
    const res = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, { clock: () => t, comparePin: deps.comparePin });
    expect(db.__conflicts).toBeGreaterThan(0);
    expect(res).toEqual({ ok: false, code: 'expired_approval' });
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(0);
    expect(keys(db, 'saleReturns/')).toEqual([]);
  });
});

describe('D-RET-FIX-7 unknown outcome: PIN-less resolve of the SAME attempt', () => {
  const resolveReq = (over: Doc = {}) => ({ ...submitReq(over), mode: 'resolve', pin: '' });

  test('response lost after commit → resolve replays the committed result, no second effect, no PIN', async () => {
    const db = makeDb(baseSeed());
    const first = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(first.ok).toBe(true);
    let compares = 0;
    const resolved = await performSubmitSaleReturn(db as never, resolveReq(), staffAuth, {
      ...deps,
      comparePin: async () => {
        compares += 1;
        return true;
      },
    });
    expect(resolved).toMatchObject({ ok: true, idempotent: true, returnNo: 'RT-R-O1-1', refundAmount: 162 });
    expect(compares).toBe(0);
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(2);
    expect((data(db, 'shifts/SH1')!.cashEntries as unknown[]).length).toBe(1);
    expect(keys(db, 'saleReturnAttemptResolutions/')).toEqual([]);
  });

  test('lost before commit → resolve fences the attempt (definitive); it can never commit afterwards', async () => {
    const db = makeDb(baseSeed());
    const resolved = await performSubmitSaleReturn(db as never, resolveReq(), staffAuth, deps);
    expect(resolved).toEqual({ ok: false, code: 'attempt_not_committed' });
    expect(keys(db, 'saleReturnAttemptResolutions/')).toHaveLength(1);
    // A late duplicate of the fenced attempt (same attemptId, with PIN) never commits.
    expect(await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps)).toEqual({ ok: false, code: 'attempt_not_committed' });
    expect(keys(db, 'managerApprovals/')).toEqual([]);
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(0);
    // Resolving again is stable; a NEW attempt is then safe and applies once.
    expect(await performSubmitSaleReturn(db as never, resolveReq(), staffAuth, deps)).toEqual({ ok: false, code: 'attempt_not_committed' });
    expect(await performSubmitSaleReturn(db as never, submitReq({ attemptId: 'attempt-0002' }), staffAuth, deps)).toMatchObject({ ok: true });
    expect(data(db, 'saleReturnLedgers/O1')!.returnCount).toBe(1);
  });

  test('lost before commit → retrying the SAME attempt with the PIN commits exactly once', async () => {
    const db = makeDb(baseSeed());
    // First send minted the approval then failed before the transaction (lost).
    await performRequestManagerApproval(
      db as never,
      {
        commandId: `saleReturn:v1:${deriveReturnId('B1', 'O1', 'attempt-0001')}:x`,
        protectedAction: 'SALE_RETURN',
        targetEntityId: 'O1',
        branchId: 'B1',
        pin: GOOD_PIN,
        securityModel: 'delegated',
        approverStaffId: 'm1',
      } as never,
      staffAuth,
      deps,
    );
    const retry = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(retry).toMatchObject({ ok: true, idempotent: false });
    const again = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(again).toMatchObject({ ok: true, idempotent: true });
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(2);
    expect(data(db, 'saleReturnLedgers/O1')!.returnCount).toBe(1);
  });

  test('resolve racing an in-flight commit: exactly one outcome — fenced OR committed, never both', async () => {
    const db = makeDb(baseSeed());
    let resolved: unknown;
    db.__hooks.afterTxGet = async (path) => {
      if (!path.startsWith('saleReturnAttemptResolutions/')) return;
      db.__hooks.afterTxGet = undefined;
      resolved = await performSubmitSaleReturn(db as never, resolveReq(), staffAuth, deps);
    };
    const submit = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(resolved).toEqual({ ok: false, code: 'attempt_not_committed' });
    expect(submit).toEqual({ ok: false, code: 'attempt_not_committed' });
    expect(keys(db, 'saleReturns/')).toEqual([]);
    expect(data(db, 'stockLots/L1')!.qtyRemaining).toBe(0);
  });

  test('resolve with different content or another requester is a conflict, never a fence-over', async () => {
    const db = makeDb(baseSeed());
    await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(
      await performSubmitSaleReturn(db as never, resolveReq({ lines: [{ lineIndex: 0, productId: 'P1', qty: 1 }], expectedRefundAmount: 81 }), staffAuth, deps),
    ).toEqual({ ok: false, code: 'idempotency_conflict' });
    expect(await performSubmitSaleReturn(db as never, { ...resolveReq(), mode: 'bogus' }, staffAuth, deps)).toEqual({ ok: false, code: 'invalid_request' });
  });
});

describe('D-RET-FIX-1 request precision at the callable boundary', () => {
  test('sub-milli quantity and half-satang expected amount are invalid', async () => {
    const db = makeDb(baseSeed());
    expect(await performSubmitSaleReturn(db as never, submitReq({ lines: [{ lineIndex: 0, productId: 'P1', qty: 2.0005 }] }), staffAuth, deps)).toEqual({
      ok: false,
      code: 'invalid_request',
    });
    expect(await performSubmitSaleReturn(db as never, submitReq({ expectedRefundAmount: 162.005 }), staffAuth, deps)).toEqual({
      ok: false,
      code: 'invalid_request',
    });
  });
});

describe('D-RET-FIX-9 customer spend + reporting fields (exact-once)', () => {
  const custSeed = (spend: number) =>
    baseSeed({
      'asyncOrders/O1': settledAsync('O1', { customerId: 'C1' }),
      'customers/C1': { name: 'คุณลูกค้า', lifetimeValue: spend, totalSpent: spend },
    });

  test('partial + multiple Returns decrement spend by the refund; replay never double-nets', async () => {
    const db = makeDb(custSeed(945));
    const first = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(first.ok).toBe(true);
    expect(data(db, 'customers/C1')).toMatchObject({ lifetimeValue: 783, totalSpent: 783 });
    await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps); // duplicate replay
    expect(data(db, 'customers/C1')).toMatchObject({ lifetimeValue: 783, totalSpent: 783 });
    await performSubmitSaleReturn(
      db as never,
      submitReq({ attemptId: 'attempt-0002', lines: [{ lineIndex: 0, productId: 'P1', qty: 3 }], expectedRefundAmount: 243 }),
      staffAuth,
      deps,
    );
    expect(data(db, 'customers/C1')).toMatchObject({ lifetimeValue: 540, totalSpent: 540 });
    if (first.ok) {
      expect(data(db, `saleReturns/${first.returnId}`)!.customerAdjustment).toMatchObject({ applied: true, customerId: 'C1', decrement: 162 });
    }
  });

  test('spend never goes below the 0 floor; zero-value Return leaves it untouched', async () => {
    const db = makeDb(custSeed(100));
    await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    expect(data(db, 'customers/C1')).toMatchObject({ lifetimeValue: 0, totalSpent: 0 });

    const zeroLines = saleLines();
    zeroLines[1]!.lineTotal = 0;
    zeroLines[1]!.unitPrice = 0;
    const zero = makeDb(
      baseSeed({
        'asyncOrders/O1': settledAsync('O1', { customerId: 'C1', lines: zeroLines, subtotal: 450, billDiscount: 0, total: 450, payments: [{ method: 'cash', amount: 450 }], paidAmt: 450, changeAmt: 0 }),
        'orders/O1': { id: 'O1', billId: 'R-O1', branchId: 'B1', status: 'completed', total: 450 },
        'customers/C1': { lifetimeValue: 450, totalSpent: 450 },
      }),
    );
    const res = await performSubmitSaleReturn(
      zero as never,
      submitReq({ lines: [{ lineIndex: 1, productId: 'P2', qty: 1 }], expectedRefundAmount: 0, refundMethod: 'none', shiftId: '' }),
      staffAuth,
      deps,
    );
    expect(res).toMatchObject({ ok: true, refundAmount: 0, refundId: null });
    expect(data(zero, 'customers/C1')).toMatchObject({ lifetimeValue: 450, totalSpent: 450 });
  });

  test('Return record carries the exact reporting basis (line revenue reversed, cost, category)', async () => {
    const db = makeDb(baseSeed());
    const res = await performSubmitSaleReturn(db as never, submitReq(), staffAuth, deps);
    if (!res.ok) throw new Error('return');
    const ret = data(db, `saleReturns/${res.returnId}`)!;
    expect(ret.totals).toMatchObject({ refundAmount: 162, lineRevenueReversed: 180, costRestored: 80 });
    const line = (ret.lines as Doc[])[0]!;
    expect(line.pricing).toMatchObject({ refundAmount: 162, lineRevenueReversed: 180 });
    expect(line.cost).toMatchObject({ total: 80 });
    expect(line).toHaveProperty('category');
  });
});
