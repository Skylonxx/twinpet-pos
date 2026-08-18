import { describe, test, expect } from 'vitest';
import type { AsyncOrder } from '../types';
import { orderCreatedAt, type SaleRecord } from './types';
import { buildPendingOverlay, decorateCanonicalFromAsync, mergeWithOverlay } from './asyncOverlay';
import { decideAction, rowVerdict } from './historyFreshness';

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
    voidAnomaly: o.voidAnomaly,
    voidRevisionFault: o.voidRevisionFault,
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

function canonical(id: string): SaleRecord {
  return { order: { id }, payments: [], items: [] } as unknown as SaleRecord;
}
function overlayRow(id: string): SaleRecord {
  return { order: { id }, payments: [], items: [], pendingSync: true } as unknown as SaleRecord;
}

describe('mergeWithOverlay', () => {
  test('appends overlay rows that are not already canonical', () => {
    const merged = mergeWithOverlay([canonical('a')], [overlayRow('b')]);
    expect(merged.map((r) => r.order.id)).toEqual(['a', 'b']);
  });

  test('canonical wins on id collision — the overlay duplicate is dropped', () => {
    const merged = mergeWithOverlay([canonical('a')], [overlayRow('a')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].pendingSync).toBeUndefined();
  });
});

describe('D overlay decorations', () => {
  test('D01 canonical base plus closed transient decoration set only', () => {
    const base = {
      order: { id: 'a', total: 100, historyRev: 1, status: 'completed' },
      payments: [{ id: 'p', amount: 100 }],
      items: [{ id: 'i', lineTotal: 100 }],
    } as unknown as SaleRecord;
    const asyncDoc = makeAsyncOrder({
      id: 'a',
      reconcileStatus: 'settled',
      voidAnomaly: 'missing_canonical',
    });
    const decorated = decorateCanonicalFromAsync(base, asyncDoc);
    expect(decorated.order.total).toBe(100);
    expect(decorated.voidAnomaly).toBe('missing_canonical');
    expect(Object.keys(decorated).filter((k) => k.startsWith('void') || k === 'pendingSync')).toEqual(
      expect.arrayContaining(['voidAnomaly']),
    );
  });

  test('D02 overlay-only row is never duplicated against a canonical row', () => {
    const merged = mergeWithOverlay([canonical('a')], [overlayRow('b'), overlayRow('a')]);
    expect(merged.map((r) => r.order.id)).toEqual(['a', 'b']);
  });

  test('D03 overlay may not replace totals/items/payments/historyRev', () => {
    const base = {
      order: { id: 'a', total: 100, historyRev: 2, status: 'completed', paidAmt: 100 },
      payments: [{ id: 'p', amount: 100 }],
      items: [{ id: 'i', lineTotal: 100 }],
    } as unknown as SaleRecord;
    const asyncDoc = makeAsyncOrder({ id: 'a', reconcileStatus: 'settled' });
    (asyncDoc as { total: number }).total = 1;
    const decorated = decorateCanonicalFromAsync(base, asyncDoc);
    expect(decorated.order.total).toBe(100);
    expect(decorated.order.historyRev).toBe(2);
    expect(decorated.payments[0].amount).toBe(100);
    expect(decorated.items[0].lineTotal).toBe(100);
  });

  test('D04 collision with pending replay is not a newer-revision win', () => {
    const can = { ...canonical('a'), order: { id: 'a', total: 100, historyRev: 1 } } as unknown as SaleRecord;
    const over = { ...overlayRow('a'), order: { id: 'a', total: 999, historyRev: 99 }, pendingSync: true } as unknown as SaleRecord;
    const merged = mergeWithOverlay([can], [over]);
    expect(merged).toHaveLength(1);
    expect(merged[0].order.total).toBe(100);
    expect(merged[0].pendingSync).toBeUndefined();
    expect(merged[0].localReconciliationAnomaly).toBe(true);
    expect(merged[0].verdict).toBe('ERROR');
    expect(merged[0].verdictReason).toBe('ROW_LOCAL_RECONCILIATION_ANOMALY');
    expect(decideAction('VOID_SETTLED_SALE', merged[0].verdict ?? 'CURRENT', merged[0].verdictReason ?? null)).toBe('REFUSE');
  });

  test('D05 missing_canonical decorates canonical row as ERROR/SOURCE_VOID_ANOMALY', () => {
    const verdict = rowVerdict({
      canonicalPresent: true,
      overlayOnly: false,
      queryMeta: { fromCache: false, hasPendingWrites: false },
      docMeta: { fromCache: false, hasPendingWrites: false },
      revision: { kind: 'VALID', value: 1 },
      highWater: 1,
      chronologyValid: true,
      unreconciledVoidIntent: false,
      voidAnomaly: 'missing_canonical',
    });
    expect(verdict).toEqual({ verdict: 'ERROR', reason: 'SOURCE_VOID_ANOMALY' });
  });

  test('E26 voidRevisionFault surfaces at zero extra reads and gates VOID_SETTLED_SALE; control row unaffected', () => {
    const faulted = decorateCanonicalFromAsync(canonical('a'), makeAsyncOrder({
      id: 'a',
      reconcileStatus: 'settled',
      voidRevisionFault: 'revision_malformed',
    } as Partial<AsyncOrder> & { id: string }));
    const control = decorateCanonicalFromAsync(canonical('b'), makeAsyncOrder({ id: 'b', reconcileStatus: 'settled' }));
    expect(faulted.voidRevisionFault).toBe('revision_malformed');
    expect(control.voidRevisionFault).toBeUndefined();
    const faultVerdict = rowVerdict({
      canonicalPresent: true,
      overlayOnly: false,
      queryMeta: { fromCache: false, hasPendingWrites: false },
      docMeta: { fromCache: false, hasPendingWrites: false },
      revision: { kind: 'VALID', value: 1 },
      highWater: 1,
      chronologyValid: true,
      unreconciledVoidIntent: false,
      voidRevisionFault: faulted.voidRevisionFault,
    });
    const controlVerdict = rowVerdict({
      canonicalPresent: true,
      overlayOnly: false,
      queryMeta: { fromCache: false, hasPendingWrites: false },
      docMeta: { fromCache: false, hasPendingWrites: false },
      revision: { kind: 'VALID', value: 1 },
      highWater: 1,
      chronologyValid: true,
      unreconciledVoidIntent: false,
      voidRevisionFault: control.voidRevisionFault,
    });
    expect(faultVerdict).toEqual({ verdict: 'ERROR', reason: 'REVISION_MALFORMED' });
    expect(decideAction('VOID_SETTLED_SALE', faultVerdict.verdict, faultVerdict.reason)).toBe('REFUSE');
    expect(controlVerdict.verdict).toBe('CURRENT');
    expect(decideAction('VOID_SETTLED_SALE', controlVerdict.verdict, controlVerdict.reason)).toBe('ALLOW');
  });
});
