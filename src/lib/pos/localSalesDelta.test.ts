import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { AsyncOrder, AsyncOrderLine } from '../types';
import {
  applyLocalSalesDeltaToProducts,
  classifyLocalSaleRetirements,
  eligibleSnapshotFromOrders,
  isEligibleLocalSale,
  overlayNumericStock,
  selectLocalSalesDelta,
} from './localSalesDelta';
import type { PosProduct, StockTruth } from './types';

function line(productId: string, qtyBase: number): AsyncOrderLine {
  return {
    productId,
    productSnap: { name: productId, sku: productId, category: 'cat' },
    unit: 'ชิ้น',
    unitFactor: 1,
    qty: qtyBase,
    qtyBase,
    unitPrice: 10,
    discountAmt: 0,
    lineTotal: 10,
  };
}

function order(overrides: Partial<AsyncOrder> & { id: string }): AsyncOrder {
  return {
    billId: overrides.id,
    deviceId: 'DEV1',
    branchId: 'B1',
    shiftId: 'S1',
    staffId: 'U1',
    staffName: 'Staff',
    customerId: null,
    customerSnap: null,
    priceLevelId: 'retail',
    lines: [line('p1', 2)],
    payments: [],
    subtotal: 0,
    discountAmt: 0,
    billDiscount: 0,
    fee: 0,
    vatRate: 0,
    vatAmt: 0,
    total: 0,
    paidAmt: 0,
    changeAmt: 0,
    creditAmt: 0,
    status: 'completed',
    reconcileStatus: 'pending_reconcile',
    reconciledAt: null,
    note: '',
    printCount: 0,
    clientCreatedAt: 1,
    serverCreatedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function product(id: string, stock: number, stockTruth: StockTruth): PosProduct {
  return {
    id,
    name: id,
    sku: id,
    barcode: null,
    category: 'cat',
    emoji: '📦',
    imageUrl: null,
    stock,
    stockTruth,
    baseUnit: 'ชิ้น',
    uomOptions: [{ unit: 'ชิ้น', factor: 1, price: 1 }],
  };
}

const KNOWN: StockTruth = { state: 'known', asOf: 'server', localDeltaApplied: false };
const UNKNOWN: StockTruth = { state: 'unknown' };

describe('selectLocalSalesDelta eligibility', () => {
  test('T25 voidRequested is excluded instantly regardless of reconcileStatus', () => {
    const pendingVoid = order({ id: 'a', voidRequested: true, reconcileStatus: 'pending_reconcile' });
    const settledVoid = order({ id: 'b', voidRequested: true, reconcileStatus: 'settled' });
    expect(isEligibleLocalSale(pendingVoid)).toBe(false);
    expect(isEligibleLocalSale(settledVoid)).toBe(false);
    expect(selectLocalSalesDelta([pendingVoid, settledVoid]).size).toBe(0);
  });

  test('T24 exception is excluded from the delta', () => {
    const ex = order({ id: 'e', reconcileStatus: 'exception' });
    expect(isEligibleLocalSale(ex)).toBe(false);
    expect(selectLocalSalesDelta([ex]).size).toBe(0);
  });

  test('T28 malformed lines are skipped per-line without dropping valid siblings', () => {
    const o = order({
      id: 'm',
      lines: [
        line('good', 3),
        { ...line('', 1), productId: '' },
        { ...line('bad-qty', 0), qtyBase: 0 },
        { ...line('nan', 1), qtyBase: Number.NaN },
        line('good2', 4),
      ],
    });
    const delta = selectLocalSalesDelta([o]);
    expect(delta.get('good')).toBe(3);
    expect(delta.get('good2')).toBe(4);
    expect(delta.has('bad-qty')).toBe(false);
    expect(delta.has('nan')).toBe(false);
  });

  test('pending_reconcile non-voided orders are included', () => {
    const delta = selectLocalSalesDelta([order({ id: 'p' })]);
    expect(delta.get('p1')).toBe(2);
  });
});

describe('classifyLocalSaleRetirements outcome matrix', () => {
  test('T23 only normal settlement raises the settlement list', () => {
    const prev = eligibleSnapshotFromOrders([order({ id: 'n' })]);
    const current = [order({ id: 'n', reconcileStatus: 'settled', status: 'completed' })];
    const result = classifyLocalSaleRetirements(prev, current);
    expect(result.normalSettlement).toEqual(['n']);
    expect(result.other).toEqual([]);
    expect(result.affectedProductIds).toEqual(['p1']);
  });

  test('T24 exception retirement is other — no refresh signal', () => {
    const prev = eligibleSnapshotFromOrders([order({ id: 'e' })]);
    const result = classifyLocalSaleRetirements(prev, [order({ id: 'e', reconcileStatus: 'exception' })]);
    expect(result.normalSettlement).toEqual([]);
    expect(result.other).toEqual(['e']);
  });

  test('T26 pending-void tombstone (voided+settled) is not stock-catch-up proof', () => {
    const prev = eligibleSnapshotFromOrders([order({ id: 'v' })]);
    const tombstone = order({ id: 'v', status: 'voided', reconcileStatus: 'settled', voidRequested: true });
    const result = classifyLocalSaleRetirements(prev, [tombstone]);
    expect(result.normalSettlement).toEqual([]);
    expect(result.other).toEqual(['v']);
  });

  test('T25 voidRequested-while-pending is other even if still pending_reconcile', () => {
    const prev = eligibleSnapshotFromOrders([order({ id: 'w' })]);
    const result = classifyLocalSaleRetirements(prev, [
      order({ id: 'w', voidRequested: true, reconcileStatus: 'pending_reconcile' }),
    ]);
    expect(result.normalSettlement).toEqual([]);
    expect(result.other).toEqual(['w']);
  });

  test('T27 voided-after-settlement is out of scope because it was already ineligible', () => {
    const prev = eligibleSnapshotFromOrders([]);
    const result = classifyLocalSaleRetirements(prev, [
      order({ id: 'old', status: 'voided', reconcileStatus: 'settled' }),
    ]);
    expect(result.normalSettlement).toEqual([]);
    expect(result.other).toEqual([]);
  });

  test('T29 retry re-arm re-includes exception→pending_reconcile', () => {
    const rearmed = order({ id: 'r', reconcileStatus: 'pending_reconcile' });
    expect(isEligibleLocalSale(order({ id: 'r', reconcileStatus: 'exception' }))).toBe(false);
    expect(isEligibleLocalSale(rearmed)).toBe(true);
    expect(selectLocalSalesDelta([rearmed]).get('p1')).toBe(2);
  });

  test('T39 exception/void outcomes contribute no normalSettlement ids', () => {
    const prev = eligibleSnapshotFromOrders([order({ id: 'a' }), order({ id: 'b' })]);
    const result = classifyLocalSaleRetirements(prev, [
      order({ id: 'a', reconcileStatus: 'exception' }),
      order({ id: 'b', status: 'voided', reconcileStatus: 'settled', voidRequested: true }),
    ]);
    expect(result.normalSettlement).toEqual([]);
    expect(result.affectedProductIds).toEqual([]);
  });
});

describe('unknown-base overlay propagation', () => {
  test('T18 known + reversal stays known', () => {
    const next = overlayNumericStock(10, KNOWN, 3);
    expect(next.stock).toBe(13);
    expect(next.stockTruth).toEqual(KNOWN);
  });

  test('T19 unknown + reversal stays unknown', () => {
    const next = overlayNumericStock(0, UNKNOWN, 5);
    expect(next.stock).toBe(5);
    expect(next.stockTruth).toEqual(UNKNOWN);
  });

  test('T20 known + local-sales delta sets localDeltaApplied', () => {
    const [next] = applyLocalSalesDeltaToProducts([product('p1', 10, KNOWN)], new Map([['p1', 3]]));
    expect(next!.stock).toBe(7);
    expect(next!.stockTruth).toEqual({ state: 'known', asOf: 'server', localDeltaApplied: true });
  });

  test('T21 unknown + local-sales delta stays unknown', () => {
    const [next] = applyLocalSalesDeltaToProducts([product('p1', 0, UNKNOWN)], new Map([['p1', 3]]));
    expect(next!.stock).toBe(-3);
    expect(next!.stockTruth).toEqual(UNKNOWN);
  });

  test('T22 unknown + both overlays never manufactures known', () => {
    const reversed = overlayNumericStock(0, UNKNOWN, 2);
    const [next] = applyLocalSalesDeltaToProducts(
      [product('p1', reversed.stock, reversed.stockTruth)],
      new Map([['p1', 1]]),
    );
    expect(next!.stockTruth.state).toBe('unknown');
  });

  test('T35 taint forces known server-fresh products to cache without claiming delta', () => {
    const [next] = applyLocalSalesDeltaToProducts(
      [product('p1', 10, KNOWN)],
      new Map(),
      new Set(['p1']),
    );
    expect(next!.stock).toBe(10);
    expect(next!.stockTruth).toEqual({ state: 'known', asOf: 'cache', localDeltaApplied: false });
  });

  test('taint does not upgrade unknown to known', () => {
    const [next] = applyLocalSalesDeltaToProducts(
      [product('p1', 0, UNKNOWN)],
      new Map(),
      new Set(['p1']),
    );
    expect(next!.stockTruth.state).toBe('unknown');
  });
});

describe('T30 sweeper regression', () => {
  test('sweeper.ts never mutates productStocks or reconcileStatus', () => {
    const src = readFileSync(resolve(process.cwd(), 'functions/src/sweeper.ts'), 'utf8');
    expect(src.includes('productStocks')).toBe(false);
    expect(src.includes('totalStockBase')).toBe(false);
    expect(src).not.toMatch(/reconcileStatus:\s*['"]/);
  });
});
