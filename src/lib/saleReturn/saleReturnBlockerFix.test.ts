// Return/Refund V1 blocker fix — client contract tests (D-RET-FIX-1/4/7/9/10).
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  checkReturnDraft,
  qtyToMilli,
  singleTenderCanCover,
  type SaleReturnContextView,
} from './saleReturnTypes';
import { resolveSaleReturnAttempt, submitSaleReturnRequest, type SubmitSaleReturnInput } from './saleReturnService';
import {
  clearUnresolvedReturnAttempt,
  readUnresolvedReturnAttempt,
  saveUnresolvedReturnAttempt,
  unresolvedAttemptKey,
  type AttemptStorage,
} from './unresolvedReturnAttempt';
import {
  netAfterReturns,
  parseSaleReturnRecord,
  summarizeReturnsByOrder,
  type SaleReturnAdjustment,
} from './returnAdjustments';
import { computeSummary, type SaleRecord } from '../salesHistory/types';
import { buildReturnAdjustmentLines } from '../profitReport/returnAdjustmentLines';
import { computeKpi, type ProfitSaleLine } from '../profitReport/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

function memory(): AttemptStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const input: SubmitSaleReturnInput = {
  attemptId: 'attempt-0001',
  orderId: 'O1',
  branchId: 'B1',
  lines: [{ lineIndex: 0, productId: 'P1', qty: 1 }],
  refundMethod: 'cash',
  refundReference: '',
  reason: 'ชำรุด',
  note: '',
  expectedRefundAmount: 81,
  shiftId: 'SH1',
  approverStaffId: 'm1',
  pin: '1234',
};

const ctx = (over: Partial<SaleReturnContextView> = {}): SaleReturnContextView => ({
  orderId: 'O1',
  billId: 'R1',
  branchId: 'B1',
  customerName: null,
  saleCreatedAtMs: 0,
  total: 945,
  refundedTotal: 0,
  returnCount: 0,
  fullyReturned: false,
  lines: [
    {
      lineIndex: 0,
      productId: 'P1',
      productName: 'อาหารแมว',
      sku: 'CF',
      unit: 'ถุง',
      soldQty: 5,
      returnedQty: 0,
      returnableQty: 5,
      soldQtyMilli: 5000,
      returnedQtyMilli: 0,
      supportedReturnableQty: 3,
      supportedReturnableQtyMilli: 3000,
      oversellLimited: true,
      unitPrice: 100,
      lineDiscount: 50,
      lineTotal: 450,
      billDiscountAlloc: 45,
      feeAlloc: 0,
      refundableShareMinor: 40500,
      refundedAmount: 0,
    },
  ],
  refundMethods: [{ method: 'cash', remaining: 945 }],
  ...over,
});

describe('D-RET-FIX-1 client exact quantity', () => {
  test('fixed absolute tolerance: sub-milli rejected at any magnitude', () => {
    expect(qtyToMilli(1.0005)).toBeNull();
    expect(qtyToMilli(12345678.0005)).toBeNull();
    expect(qtyToMilli(12345.678)).toBe(12345678);
    expect(qtyToMilli(0.1 * 3)).toBe(300);
  });
});

describe('D-RET-FIX-4 / D-RET-FIX-10 draft limits', () => {
  test('a draft beyond the oversell-free quantity is blocked with explicit copy', () => {
    const r = checkReturnDraft(ctx(), [{ lineIndex: 0, qty: 4 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('สต็อกติดลบ');
    expect(checkReturnDraft(ctx(), [{ lineIndex: 0, qty: 3 }])).toMatchObject({ ok: true, refundMinor: 24300 });
  });

  test('single-tender coverage: one tender must cover the whole refund', () => {
    const c = ctx({ refundMethods: [{ method: 'cash', remaining: 100 }, { method: 'card', remaining: 200 }] });
    expect(singleTenderCanCover(c, 20000)).toBe(true);
    expect(singleTenderCanCover(c, 20001)).toBe(false); // 100 + 200 would cover it — still unsupported in V1
    expect(singleTenderCanCover(c, 0)).toBe(true);
  });
});

describe('D-RET-FIX-7 durable unresolved attempt record', () => {
  test('saves the exact non-secret attempt; never the PIN', () => {
    const s = memory();
    expect(saveUnresolvedReturnAttempt(input, { requesterStaffId: 's1', approverDisplayName: 'M', nowMs: 5 }, s)).toBe(true);
    const raw = s.map.get(unresolvedAttemptKey('B1', 'O1'))!;
    expect(raw).not.toContain('1234');
    expect(JSON.parse(raw)).not.toHaveProperty('pin');
    expect(readUnresolvedReturnAttempt('B1', 'O1', s)).toMatchObject({
      state: 'UNKNOWN_PENDING_RESOLUTION',
      attemptId: 'attempt-0001',
      lines: [{ lineIndex: 0, productId: 'P1', qty: 1 }],
      expectedRefundAmount: 81,
      approverStaffId: 'm1',
      requesterStaffId: 's1',
    });
  });

  test('absent → null; unreadable storage or corrupt record → undefined (fail closed)', () => {
    const s = memory();
    expect(readUnresolvedReturnAttempt('B1', 'O1', s)).toBeNull();
    s.map.set(unresolvedAttemptKey('B1', 'O1'), '{not json');
    expect(readUnresolvedReturnAttempt('B1', 'O1', s)).toBeUndefined();
    s.map.set(unresolvedAttemptKey('B1', 'O1'), JSON.stringify({ schemaVersion: 1, state: 'UNKNOWN_PENDING_RESOLUTION' }));
    expect(readUnresolvedReturnAttempt('B1', 'O1', s)).toBeUndefined();
    expect(readUnresolvedReturnAttempt('B1', 'O1', null)).toBeUndefined();
    const throwing: AttemptStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    expect(readUnresolvedReturnAttempt('B1', 'O1', throwing)).toBeUndefined();
    expect(saveUnresolvedReturnAttempt(input, { requesterStaffId: 's1', approverDisplayName: 'M', nowMs: 1 }, throwing)).toBe(false);
  });

  test('records are keyed per sale and cleared only explicitly', () => {
    const s = memory();
    saveUnresolvedReturnAttempt(input, { requesterStaffId: 's1', approverDisplayName: 'M', nowMs: 1 }, s);
    expect(readUnresolvedReturnAttempt('B1', 'O2', s)).toBeNull();
    clearUnresolvedReturnAttempt('B1', 'O1', s);
    expect(readUnresolvedReturnAttempt('B1', 'O1', s)).toBeNull();
  });

  test('resolve adapter: PIN-less resolve mode; submit adapter declares submit mode', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const transport = vi.fn(async () => ({ ok: false, code: 'attempt_not_committed' }));
    const payload: Omit<SubmitSaleReturnInput, 'pin'> = { ...input };
    delete (payload as Partial<SubmitSaleReturnInput>).pin;
    expect(await resolveSaleReturnAttempt(payload, transport)).toEqual({ kind: 'error', code: 'attempt_not_committed' });
    expect(transport).toHaveBeenCalledWith('submitSaleReturn', expect.objectContaining({ mode: 'resolve', pin: '', attemptId: 'attempt-0001' }));
    await submitSaleReturnRequest(input, transport);
    expect(transport).toHaveBeenLastCalledWith('submitSaleReturn', expect.objectContaining({ mode: 'submit', pin: '1234' }));
    const failing = vi.fn(async () => {
      throw new Error('network');
    });
    expect(await resolveSaleReturnAttempt(payload, failing)).toEqual({ kind: 'unknown' });
    vi.stubGlobal('navigator', { onLine: false });
    expect(await resolveSaleReturnAttempt(payload, transport)).toEqual({ kind: 'offline' });
  });
});

// ─── D-RET-FIX-9 reporting release gate ─────────────────────────────────────

function returnDoc(id: string, over: Record<string, unknown> = {}, lineOver: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    status: 'completed',
    returnId: id,
    returnNo: `RT-R1-${id}`,
    originalOrderId: 'O1',
    branchId: 'B1',
    originalSaleCreatedAtMillis: 1,
    createdAtMillis: 2,
    refund: { method: 'cash', amount: 162 },
    totals: { refundAmount: 162, lineRevenueReversed: 180, costRestored: 80 },
    lines: [
      {
        lineIndex: 0,
        productId: 'P1',
        productName: 'อาหารแมว',
        sku: 'CF',
        category: 'อาหาร',
        unit: 'ถุง',
        returnedQty: 2,
        pricing: { unitPrice: 100, refundAmount: 162, lineRevenueReversed: 180 },
        cost: { total: 80 },
        ...lineOver,
      },
    ],
    ...over,
  };
}

function adj(id: string, over: Record<string, unknown> = {}, lineOver: Record<string, unknown> = {}): SaleReturnAdjustment {
  const a = parseSaleReturnRecord(id, returnDoc(id, over, lineOver));
  if (!a) throw new Error('parse');
  return a;
}

function saleRecord(id: string, total: number, cashPaid: number, status: 'completed' | 'voided' = 'completed'): SaleRecord {
  return {
    order: { id, billId: id, total, status } as never,
    payments: cashPaid > 0 ? [{ method: 'cash', amount: cashPaid } as never] : [{ method: 'qr', amount: total } as never],
    items: [],
  };
}

describe('D-RET-FIX-9 Return record parsing (adjustment source)', () => {
  test('exact parse; malformed / inconsistent records are rejected (caller labels gross)', () => {
    expect(adj('r1')).toMatchObject({ orderId: 'O1', refundMinor: 16200, lineRevenueReversedMinor: 18000, costRestoredMinor: 8000 });
    expect(parseSaleReturnRecord('r1', returnDoc('r1', { status: 'pending' }))).toBeNull();
    expect(parseSaleReturnRecord('r1', returnDoc('r1', { totals: { refundAmount: 162, lineRevenueReversed: 181, costRestored: 80 } }))).toBeNull();
    expect(parseSaleReturnRecord('r1', returnDoc('r1', { refund: { method: 'cash', amount: 162.005 } }))).toBeNull();
    expect(parseSaleReturnRecord('rX', returnDoc('r1'))).toBeNull();
    expect(parseSaleReturnRecord('r1', returnDoc('r1', {}, { pricing: { unitPrice: 100, refundAmount: 162 } }))).toBeNull();
  });
});

describe('D-RET-FIX-9 Sales History summary net of Returns', () => {
  const zero = () =>
    adj('z', { refund: { method: 'none', amount: 0 }, totals: { refundAmount: 0, lineRevenueReversed: 0, costRestored: 20 } }, {
      pricing: { unitPrice: 0, refundAmount: 0, lineRevenueReversed: 0 },
      cost: { total: 20 },
    });

  test('partial Return: total/paid/cash are net; gross when Returns are not loaded', () => {
    const records = [saleRecord('O1', 945, 945), saleRecord('O2', 100, 100)];
    const byOrder = summarizeReturnsByOrder([adj('r1')]);
    expect(computeSummary(records, byOrder)).toMatchObject({ totalAmt: 883, paidAmt: 883, cashAmt: 883, refundAmt: 162, returnCount: 1, netOfReturns: true });
    expect(computeSummary(records)).toMatchObject({ totalAmt: 1045, refundAmt: 0, netOfReturns: false });
  });

  test('multiple Returns accumulate exactly; duplicate (replayed) records never double-net', () => {
    const records = [saleRecord('O1', 945, 945)];
    const two = summarizeReturnsByOrder([adj('r1'), adj('r2', { refund: { method: 'cash', amount: 243 }, totals: { refundAmount: 243, lineRevenueReversed: 270, costRestored: 150 } }, { pricing: { unitPrice: 100, refundAmount: 243, lineRevenueReversed: 270 }, cost: { total: 150 } })]);
    expect(computeSummary(records, two)).toMatchObject({ totalAmt: 540, refundAmt: 405, returnCount: 2 });
    const dup = summarizeReturnsByOrder([adj('r1'), adj('r1')]);
    expect(computeSummary(records, dup)).toMatchObject({ totalAmt: 783, refundAmt: 162, returnCount: 1 });
  });

  test('zero-value Return changes no money metric', () => {
    const records = [saleRecord('O1', 945, 945)];
    expect(computeSummary(records, summarizeReturnsByOrder([zero()]))).toMatchObject({ totalAmt: 945, cashAmt: 945, refundAmt: 0, returnCount: 1 });
  });

  test('cash vs non-cash refund: same net sales; only the cash metric differs', () => {
    const records = [saleRecord('O1', 945, 945)];
    const cash = computeSummary(records, summarizeReturnsByOrder([adj('r1')]));
    const qr = computeSummary(records, summarizeReturnsByOrder([adj('r1', { refund: { method: 'qr', amount: 162 } })]));
    expect(cash.totalAmt).toBe(qr.totalAmt);
    expect(cash.cashAmt).toBe(783);
    expect(qr.cashAmt).toBe(945);
  });

  test('voided bills are excluded; a bill never nets below 0', () => {
    expect(computeSummary([saleRecord('O1', 945, 945, 'voided')], summarizeReturnsByOrder([adj('r1')]))).toMatchObject({ totalAmt: 0, voidCount: 1, refundAmt: 0 });
    expect(netAfterReturns(100, summarizeReturnsByOrder([adj('r1')]).get('O1'))).toBe(0);
    expect(netAfterReturns(945, summarizeReturnsByOrder([adj('r1')]).get('O1'))).toBe(783);
  });
});

describe('D-RET-FIX-9 Profit / COGS report net of Returns', () => {
  const sale: ProfitSaleLine = {
    id: 'O1-i1',
    orderId: 'O1',
    date: '2026-10-15',
    time: '10:00',
    bill: 'R1',
    customer: 'สมาชิกทั่วไป',
    productId: 'P1',
    productName: 'อาหารแมว',
    productSku: 'CF',
    category: 'อาหาร',
    emoji: '',
    iconBg: '',
    imageUrl: null,
    qty: 5,
    salePrice: 100,
    revenue: 450,
    cogs: 230,
    profit: 220,
    margin: 48.9,
  };
  const meta = new Map([['O1', { date: '2026-10-15', time: '10:00', bill: 'R1', customer: 'สมาชิกทั่วไป' }]]);

  test('returned cost layer reduces COGS; revenue and profit net on the line-total basis', () => {
    const lines = [sale, ...buildReturnAdjustmentLines([adj('r1')], meta)];
    expect(lines[1]).toMatchObject({ isReturnAdjustment: true, qty: -2, revenue: -180, cogs: -80, profit: -100, bill: 'R1', date: '2026-10-15' });
    expect(computeKpi(lines)).toMatchObject({ revenue: 270, cogs: 150, profit: 120, bills: 1 });
  });

  test('duplicate records and Returns of orders not in the report add nothing', () => {
    expect(buildReturnAdjustmentLines([adj('r1'), adj('r1')], meta)).toHaveLength(1);
    expect(buildReturnAdjustmentLines([adj('r1', { originalOrderId: 'O-other' })], meta)).toHaveLength(0);
  });
});
