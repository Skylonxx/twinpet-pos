import { describe, test, expect } from 'vitest';
import type { AsyncOrder } from '../types';
import type { DashboardPaymentRecord, DashboardSaleLine } from './types';
import { buildDashboardOverlay, mergeDashboardOverlay } from './asyncOverlay';

function makeAsyncOrder(o: Partial<AsyncOrder> & { id: string }): AsyncOrder {
  return {
    id: o.id,
    billId: 'R001',
    deviceId: 'iPad01',
    branchId: 'br1',
    shiftId: 'shift-1',
    staffId: 'staff-1',
    staffName: 'Dao',
    customerId: null,
    customerSnap: o.customerSnap ?? null,
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
    clientCreatedAt: o.clientCreatedAt ?? new Date('2026-06-03T10:00:00Z').getTime(),
    serverCreatedAt: null,
    updatedAt: null,
  } as AsyncOrder;
}

const START = new Date('2026-06-03T00:00:00Z');
const END = new Date('2026-06-03T23:59:59Z');

describe('buildDashboardOverlay', () => {
  test('projects pending sale into lines + payments (cogs unknown → 0)', () => {
    const { lines, payments } = buildDashboardOverlay([makeAsyncOrder({ id: 'iPad01-1' })], START, END);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ orderId: 'iPad01-1', revenue: 100, cogs: 0, qty: 2 });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ orderId: 'iPad01-1', method: 'cash', amount: 100 });
  });

  test('excludes sales outside the period window', () => {
    const yesterday = new Date('2026-06-02T10:00:00Z').getTime();
    const overlay = buildDashboardOverlay(
      [makeAsyncOrder({ id: 'iPad01-1', clientCreatedAt: yesterday })],
      START,
      END,
    );
    expect(overlay.lines).toEqual([]);
    expect(overlay.payments).toEqual([]);
  });

  test('excludes settled, exception, voided, and void-requested sales', () => {
    const overlay = buildDashboardOverlay(
      [
        makeAsyncOrder({ id: 'iPad01-1', reconcileStatus: 'settled' }),
        makeAsyncOrder({ id: 'iPad01-2', reconcileStatus: 'exception' }),
        makeAsyncOrder({ id: 'iPad01-3', status: 'voided' }),
        makeAsyncOrder({ id: 'iPad01-4', voidRequested: true }),
      ],
      START,
      END,
    );
    expect(overlay.lines).toEqual([]);
  });
});

describe('mergeDashboardOverlay', () => {
  const line = (orderId: string): DashboardSaleLine =>
    ({ orderId, revenue: 100, cogs: 0, qty: 1 }) as unknown as DashboardSaleLine;
  const pay = (orderId: string): DashboardPaymentRecord =>
    ({ orderId, method: 'cash', amount: 100 }) as unknown as DashboardPaymentRecord;

  test('appends overlay rows not present in canonical', () => {
    const merged = mergeDashboardOverlay([line('a')], [pay('a')], {
      lines: [line('b')],
      payments: [pay('b')],
    });
    expect(merged.saleLines.map((l) => l.orderId)).toEqual(['a', 'b']);
    expect(merged.paymentRecords.map((p) => p.orderId)).toEqual(['a', 'b']);
  });

  test('drops overlay rows whose orderId already settled into canonical', () => {
    const merged = mergeDashboardOverlay([line('a')], [pay('a')], {
      lines: [line('a')],
      payments: [pay('a')],
    });
    expect(merged.saleLines).toHaveLength(1);
    expect(merged.paymentRecords).toHaveLength(1);
  });
});
