import { describe, test, expect } from 'vitest';
import type { AsyncOrder } from '../types';
import { orderCreatedAt, type SaleRecord } from './types';
import { buildPendingOverlay, mergeWithOverlay } from './asyncOverlay';

function makeAsyncOrder(o: Partial<AsyncOrder> & { id: string }): AsyncOrder {
  return {
    id: o.id,
    billId: o.billId ?? 'R001',
    deviceId: 'iPad01',
    branchId: 'br1',
    shiftId: 'shift-1',
    staffId: 'staff-1',
    staffName: 'Dao',
    customerId: null,
    customerSnap: null,
    priceLevelId: 'RETAIL',
    lines: o.lines ?? [
      {
        productId: 'p1',
        productSnap: { name: 'Food', sku: 'SKU1', category: 'cat' },
        unit: 'ea',
        unitFactor: 1,
        qty: 2,
        qtyBase: 2,
        unitPrice: 50,
        discountAmt: 0,
        lineTotal: 100,
      },
    ],
    payments: o.payments ?? [{ method: 'cash', amount: 100, ref: null }],
    subtotal: 100,
    discountAmt: 0,
    billDiscount: 0,
    fee: 0,
    vatRate: 0,
    vatAmt: 0,
    total: 100,
    paidAmt: 100,
    changeAmt: 0,
    creditAmt: 0,
    status: o.status ?? 'completed',
    reconcileStatus: o.reconcileStatus ?? 'pending_reconcile',
    reconciledAt: null,
    voidRequested: o.voidRequested,
    note: '',
    printCount: 0,
    clientCreatedAt: o.clientCreatedAt ?? 1_700_000_000_000,
    serverCreatedAt: null,
    updatedAt: null,
  } as AsyncOrder;
}

describe('buildPendingOverlay', () => {
  test('maps a pending async order into a pendingSync SaleRecord with inline items + payments', () => {
    const [rec] = buildPendingOverlay([makeAsyncOrder({ id: 'iPad01-1', billId: 'R009' })]);
    expect(rec.pendingSync).toBe(true);
    expect(rec.order.id).toBe('iPad01-1');
    expect(rec.order.billId).toBe('R009');
    expect(rec.order.total).toBe(100);
    expect(rec.payments).toHaveLength(1);
    expect(rec.payments[0]).toMatchObject({ method: 'cash', amount: 100, orderId: 'iPad01-1' });
    expect(rec.items).toHaveLength(1);
    expect(rec.items[0]).toMatchObject({ productId: 'p1', qty: 2, fifoCost: 0 });
  });

  test('createdAt is the device clock and parses back to a real Date', () => {
    const ts = 1_701_000_000_000;
    const [rec] = buildPendingOverlay([makeAsyncOrder({ id: 'iPad01-1', clientCreatedAt: ts })]);
    expect(orderCreatedAt(rec.order).getTime()).toBe(ts);
  });

  test('excludes settled orders — those arrive via the canonical projection', () => {
    const overlay = buildPendingOverlay([
      makeAsyncOrder({ id: 'iPad01-1', reconcileStatus: 'settled' }),
    ]);
    expect(overlay).toEqual([]);
  });

  test('excludes exceptions (not pending_reconcile)', () => {
    const overlay = buildPendingOverlay([
      makeAsyncOrder({ id: 'iPad01-1', reconcileStatus: 'exception' }),
    ]);
    expect(overlay).toEqual([]);
  });

  test('Phase 6: voided / void-requested pending orders LINGER for the badge', () => {
    const overlay = buildPendingOverlay([
      makeAsyncOrder({ id: 'iPad01-1', status: 'voided', voidRequested: true }),
      makeAsyncOrder({ id: 'iPad01-2', voidRequested: true }),
    ]);
    expect(overlay.map((r) => r.order.id)).toEqual(['iPad01-1', 'iPad01-2']);
    // status flows through so saleDisplayStatus → 'void' renders the ยกเลิก badge.
    expect(overlay[0].order.status).toBe('voided');
  });

  test('keeps a pending credit (pending_payment) sale', () => {
    const overlay = buildPendingOverlay([
      makeAsyncOrder({ id: 'iPad01-1', status: 'pending_payment' }),
    ]);
    expect(overlay).toHaveLength(1);
  });
});

describe('mergeWithOverlay', () => {
  const canonical = (id: string): SaleRecord =>
    ({ order: { id }, payments: [], items: [] }) as unknown as SaleRecord;
  const overlay = (id: string): SaleRecord =>
    ({ order: { id }, payments: [], items: [], pendingSync: true }) as unknown as SaleRecord;

  test('appends overlay rows that are not already canonical', () => {
    const merged = mergeWithOverlay([canonical('a')], [overlay('b')]);
    expect(merged.map((r) => r.order.id)).toEqual(['a', 'b']);
  });

  test('canonical wins on id collision — the overlay duplicate is dropped', () => {
    const merged = mergeWithOverlay([canonical('a')], [overlay('a')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].pendingSync).toBeUndefined();
  });
});
