import { describe, test, expect } from 'vitest';
import type { AsyncOrder, AsyncPayment, OrderStatus, ReconcileStatus, Timestamp } from '../types';
import {
  effectiveMillis,
  isLedgerSale,
  selectLocalLedger,
  toLocalSale,
} from './localLedger';

// ─── Fixtures ────────────────────────────────────────────────────────────────
//
// The selector reads only a handful of fields off AsyncOrder, so we build a
// minimal doc and cast it. A `Timestamp` is faked by the single method the
// selector touches: `.toMillis()`.

function fakeTimestamp(ms: number): Timestamp {
  return { toMillis: () => ms } as unknown as Timestamp;
}

type OrderOverrides = Partial<AsyncOrder> & { id: string; clientCreatedAt: number };

function makeOrder(o: OrderOverrides): AsyncOrder {
  const seq = o.id.slice(o.id.lastIndexOf('-') + 1);
  const payments: AsyncPayment[] = o.payments ?? [{ method: 'cash', amount: 100, ref: null }];
  return {
    id: o.id,
    billId: o.billId ?? `R${seq}`,
    deviceId: o.deviceId ?? 'iPad01',
    shiftId: o.shiftId ?? 'shift-1',
    staffId: o.staffId ?? 'staff-1',
    staffName: o.staffName ?? 'Dao',
    customerId: o.customerId ?? null,
    status: (o.status ?? 'completed') as OrderStatus,
    reconcileStatus: (o.reconcileStatus ?? 'pending_reconcile') as ReconcileStatus,
    total: o.total ?? 100,
    paidAmt: o.paidAmt ?? 100,
    changeAmt: o.changeAmt ?? 0,
    creditAmt: o.creditAmt ?? 0,
    payments,
    voidRequested: o.voidRequested,
    clientCreatedAt: o.clientCreatedAt,
    serverCreatedAt: o.serverCreatedAt ?? null,
    // Remaining AsyncOrder fields are irrelevant to the selector.
  } as unknown as AsyncOrder;
}

// ─── effectiveMillis: null serverCreatedAt handling ──────────────────────────

describe('effectiveMillis', () => {
  test('falls back to clientCreatedAt while the write is still pending (serverCreatedAt null)', () => {
    const order = makeOrder({ id: 'iPad01-1', clientCreatedAt: 1000, serverCreatedAt: null });
    expect(effectiveMillis(order)).toBe(1000);
  });

  test('prefers authoritative server time once the write has flushed', () => {
    const order = makeOrder({
      id: 'iPad01-1',
      clientCreatedAt: 1000,
      serverCreatedAt: fakeTimestamp(5000),
    });
    expect(effectiveMillis(order)).toBe(5000);
  });
});

// ─── isLedgerSale: inclusion / exclusion predicate ───────────────────────────

describe('isLedgerSale', () => {
  test('includes a plain completed, pending_reconcile sale', () => {
    expect(isLedgerSale(makeOrder({ id: 'iPad01-1', clientCreatedAt: 1 }))).toBe(true);
  });

  test('includes a settled sale', () => {
    expect(
      isLedgerSale(makeOrder({ id: 'iPad01-1', clientCreatedAt: 1, reconcileStatus: 'settled' })),
    ).toBe(true);
  });

  test('includes a pending_payment (partial credit) sale — still real revenue', () => {
    expect(
      isLedgerSale(makeOrder({ id: 'iPad01-1', clientCreatedAt: 1, status: 'pending_payment' })),
    ).toBe(true);
  });

  test('excludes a voided sale', () => {
    expect(
      isLedgerSale(makeOrder({ id: 'iPad01-1', clientCreatedAt: 1, status: 'voided' })),
    ).toBe(false);
  });

  test('excludes an offline void-intent (Phase A pending tombstone)', () => {
    expect(
      isLedgerSale(makeOrder({ id: 'iPad01-1', clientCreatedAt: 1, voidRequested: true })),
    ).toBe(false);
  });

  test('excludes a reconcile exception', () => {
    expect(
      isLedgerSale(
        makeOrder({ id: 'iPad01-1', clientCreatedAt: 1, reconcileStatus: 'exception' }),
      ),
    ).toBe(false);
  });
});

// ─── toLocalSale: normalization ──────────────────────────────────────────────

describe('toLocalSale', () => {
  test('projects the unified sale view and preserves the tender breakdown', () => {
    const payments: AsyncPayment[] = [
      { method: 'cash', amount: 60, ref: null },
      { method: 'credit', amount: 40, ref: null },
    ];
    const order = makeOrder({
      id: 'iPad01-7',
      billId: 'R007',
      clientCreatedAt: 1234,
      total: 100,
      paidAmt: 60,
      creditAmt: 40,
      status: 'pending_payment',
      payments,
    });

    expect(toLocalSale(order)).toEqual({
      id: 'iPad01-7',
      billId: 'R007',
      deviceId: 'iPad01',
      shiftId: 'shift-1',
      staffId: 'staff-1',
      staffName: 'Dao',
      customerId: null,
      status: 'pending_payment',
      reconcileStatus: 'pending_reconcile',
      total: 100,
      paidAmt: 60,
      changeAmt: 0,
      creditAmt: 40,
      payments,
      pendingSync: true,
      clientCreatedAt: 1234,
      occurredAt: 1234,
      sortSeq: 7,
    });
  });

  test('marks pendingSync false and parses sortSeq once flushed', () => {
    const sale = toLocalSale(
      makeOrder({ id: 'iPad01-42', clientCreatedAt: 1000, serverCreatedAt: fakeTimestamp(9000) }),
    );
    expect(sale.pendingSync).toBe(false);
    expect(sale.occurredAt).toBe(9000);
    expect(sale.sortSeq).toBe(42);
  });

  test('parses the trailing sequence even when the device id contains hyphens', () => {
    const sale = toLocalSale(makeOrder({ id: 'pos-ipad-01-13', clientCreatedAt: 1 }));
    expect(sale.sortSeq).toBe(13);
  });

  test('defensively copies payments — mutating the sale never touches the source order', () => {
    const order = makeOrder({
      id: 'iPad01-1',
      clientCreatedAt: 1,
      payments: [{ method: 'cash', amount: 100, ref: null }],
    });
    const sale = toLocalSale(order);

    expect(sale.payments).not.toBe(order.payments);
    expect(sale.payments[0]).not.toBe(order.payments[0]);

    sale.payments[0].amount = 999;
    sale.payments.push({ method: 'credit', amount: 1, ref: null });
    expect(order.payments).toEqual([{ method: 'cash', amount: 100, ref: null }]);
  });
});

// ─── selectLocalLedger: filter + normalize + order ───────────────────────────

describe('selectLocalLedger', () => {
  test('returns [] for empty input', () => {
    expect(selectLocalLedger([])).toEqual([]);
  });

  test('orders by clientCreatedAt ascending regardless of input order', () => {
    const orders = [
      makeOrder({ id: 'iPad01-3', clientCreatedAt: 300 }),
      makeOrder({ id: 'iPad01-1', clientCreatedAt: 100 }),
      makeOrder({ id: 'iPad01-2', clientCreatedAt: 200 }),
    ];
    expect(selectLocalLedger(orders).map((s) => s.id)).toEqual([
      'iPad01-1',
      'iPad01-2',
      'iPad01-3',
    ]);
  });

  test('tie-breaks same-millisecond sales by local sequence', () => {
    const orders = [
      makeOrder({ id: 'iPad01-10', clientCreatedAt: 500 }),
      makeOrder({ id: 'iPad01-2', clientCreatedAt: 500 }),
      makeOrder({ id: 'iPad01-1', clientCreatedAt: 500 }),
    ];
    expect(selectLocalLedger(orders).map((s) => s.id)).toEqual([
      'iPad01-1',
      'iPad01-2',
      'iPad01-10',
    ]);
  });

  test('does not order by serverCreatedAt — pending (null) sales keep client order', () => {
    // Sale 1 is flushed with a LATE server stamp; sale 2 is still pending. Client
    // order (1 then 2) must hold — the selector must never sort on serverCreatedAt.
    const orders = [
      makeOrder({ id: 'iPad01-2', clientCreatedAt: 200, serverCreatedAt: null }),
      makeOrder({ id: 'iPad01-1', clientCreatedAt: 100, serverCreatedAt: fakeTimestamp(9999) }),
    ];
    expect(selectLocalLedger(orders).map((s) => s.id)).toEqual(['iPad01-1', 'iPad01-2']);
  });

  test('excludes voided, void-requested, and exception docs; keeps the rest', () => {
    const orders = [
      makeOrder({ id: 'iPad01-1', clientCreatedAt: 100 }),
      makeOrder({ id: 'iPad01-2', clientCreatedAt: 200, status: 'voided' }),
      makeOrder({ id: 'iPad01-3', clientCreatedAt: 300, voidRequested: true }),
      makeOrder({ id: 'iPad01-4', clientCreatedAt: 400, reconcileStatus: 'exception' }),
      makeOrder({ id: 'iPad01-5', clientCreatedAt: 500, status: 'pending_payment' }),
    ];
    expect(selectLocalLedger(orders).map((s) => s.id)).toEqual(['iPad01-1', 'iPad01-5']);
  });

  test('does not mutate the input array', () => {
    const orders = [
      makeOrder({ id: 'iPad01-3', clientCreatedAt: 300 }),
      makeOrder({ id: 'iPad01-1', clientCreatedAt: 100 }),
    ];
    const snapshot = orders.map((o) => o.id);
    selectLocalLedger(orders);
    expect(orders.map((o) => o.id)).toEqual(snapshot);
  });
});
