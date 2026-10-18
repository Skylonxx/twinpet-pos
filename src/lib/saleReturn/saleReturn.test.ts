import { afterEach, describe, expect, test, vi } from 'vitest';
import { checkReturnDraft, cumulativeRefundMinor, previewLineRefundMinor, qtyToMilli, type SaleReturnContextView } from './saleReturnTypes';
import { fetchSaleReturnContext, submitSaleReturnRequest, type SubmitSaleReturnInput } from './saleReturnService';
import { DEFAULT_ROLE_PERMS, PERM_MODULES } from '../staffManagement/types';

const ctx: SaleReturnContextView = {
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
      soldQty: 3,
      returnedQty: 1,
      returnableQty: 2,
      soldQtyMilli: 3000,
      returnedQtyMilli: 1000,
      unitPrice: 33.34,
      lineDiscount: 0,
      lineTotal: 100,
      billDiscountAlloc: 0,
      feeAlloc: 0,
      refundableShareMinor: 10000,
      refundedAmount: 33.33,
    },
  ],
  refundMethods: [{ method: 'cash', remaining: 66.67 }],
};

const input: SubmitSaleReturnInput = {
  attemptId: 'attempt-0001',
  orderId: 'O1',
  branchId: 'B1',
  lines: [{ lineIndex: 0, productId: 'P1', qty: 1 }],
  refundMethod: 'cash',
  refundReference: '',
  reason: 'ชำรุด',
  note: '',
  expectedRefundAmount: 33.34,
  shiftId: 'SH1',
  approverStaffId: 'm1',
  pin: '1234',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refund preview (display-only, server-mirrored)', () => {
  test('cumulative rounding never drifts: 3333 + 3334 + 3333 = 10000', () => {
    expect(cumulativeRefundMinor(10000, 3000, 1000)).toBe(3333);
    expect(previewLineRefundMinor(ctx.lines[0]!, 1000)).toBe(3334);
    expect(previewLineRefundMinor({ ...ctx.lines[0]!, returnedQtyMilli: 2000 }, 1000)).toBe(3333);
  });
  test('qty precision: 3 decimals exact, otherwise rejected', () => {
    expect(qtyToMilli(1.5)).toBe(1500);
    expect(qtyToMilli(0.0001)).toBeNull();
  });
  test('draft: over-returnable is blocked, empty draft is blocked, valid draft totals the preview', () => {
    expect(checkReturnDraft(ctx, [{ lineIndex: 0, qty: 3 }])).toMatchObject({ ok: false });
    expect(checkReturnDraft(ctx, [{ lineIndex: 0, qty: 0 }])).toMatchObject({ ok: false });
    expect(checkReturnDraft(ctx, [{ lineIndex: 0, qty: 2 }])).toEqual({
      ok: true,
      lines: [{ lineIndex: 0, productId: 'P1', qty: 2 }],
      refundMinor: 6667,
    });
  });
});

describe('saleReturnService — online-required, never throws', () => {
  test('offline: neither callable is invoked and nothing is queued', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const transport = vi.fn();
    expect(await fetchSaleReturnContext('O1', 'B1', transport)).toEqual({ kind: 'offline' });
    expect(await submitSaleReturnRequest(input, transport)).toEqual({ kind: 'offline' });
    expect(transport).not.toHaveBeenCalled();
  });

  test('transport failure on submit is UNKNOWN (never success, never a definitive failure)', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const transport = vi.fn(async () => {
      throw new Error('network');
    });
    expect(await submitSaleReturnRequest(input, transport)).toEqual({ kind: 'unknown' });
  });

  test('server responses are parsed strictly', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const ok = vi.fn(async () => ({
      ok: true,
      returnId: 'r1',
      returnNo: 'RT-R1-1',
      refundId: 'r1',
      refundAmount: 33.34,
      refundMethod: 'cash',
      idempotent: false,
    }));
    expect(await submitSaleReturnRequest(input, ok)).toMatchObject({ kind: 'ok', returnNo: 'RT-R1-1' });
    expect(ok).toHaveBeenCalledWith('submitSaleReturn', expect.objectContaining({ pin: '1234', shiftId: 'SH1' }));
    const rejected = vi.fn(async () => ({ ok: false, code: 'over_return' }));
    expect(await submitSaleReturnRequest(input, rejected)).toEqual({ kind: 'error', code: 'over_return' });
    const garbage = vi.fn(async () => ({ ok: false, code: 'something_else' }));
    expect(await submitSaleReturnRequest(input, garbage)).toEqual({ kind: 'unknown' });
    const ctxCall = vi.fn(async () => ({ ok: true, classification: 'RETURN_ELIGIBLE', reason: null, context: ctx }));
    expect(await fetchSaleReturnContext('O1', 'B1', ctxCall)).toMatchObject({ kind: 'ok', classification: 'RETURN_ELIGIBLE' });
    expect(ctxCall).toHaveBeenCalledWith('getSaleReturnContext', { orderId: 'O1', branchId: 'B1' });
  });
});

describe('pos_return permission source defaults (D-RET-7)', () => {
  test('Admin and Manager hold pos_return; Staff does not', () => {
    expect(DEFAULT_ROLE_PERMS.admin.has('pos_return')).toBe(true);
    expect(DEFAULT_ROLE_PERMS.manager.has('pos_return')).toBe(true);
    expect(DEFAULT_ROLE_PERMS.staff.has('pos_return')).toBe(false);
    expect(DEFAULT_ROLE_PERMS.staff.has('pos_sale')).toBe(true);
  });
  test('pos_return is a distinct, editable permission (not pos_void)', () => {
    const keys = PERM_MODULES.flatMap((m) => m.items.map((i) => i.key));
    expect(keys).toContain('pos_return');
    expect(keys).toContain('pos_void');
  });
});
