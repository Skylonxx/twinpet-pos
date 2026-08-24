import { describe, expect, test } from 'vitest';
import { RETAIL_PRICE_LEVEL_ID, type Product } from '../types';
import { DEV_POS_PRODUCTS } from './devProducts';
import {
  mergePosProducts,
  stockEntryFromStockDoc,
  toPosProduct,
  UNKNOWN_STOCK_ENTRY,
} from './posProductMapper';
import type { PosProduct } from './types';

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    name: 'Test',
    sku: 'SKU',
    barcode: null,
    category: 'อาหารสัตว์',
    description: '',
    imageUrl: null,
    baseUnit: 'ชิ้น',
    uomConversions: [],
    prices: [{ priceLevelId: RETAIL_PRICE_LEVEL_ID, unit: 'ชิ้น', price: 10 }],
    cost: 0,
    avgCost: 0,
    reorderPoint: 0,
    isActive: true,
    createdAt: null as unknown as Product['createdAt'],
    updatedAt: null as unknown as Product['updatedAt'],
    deletedAt: null,
    ...overrides,
  };
}

describe('posProductMapper stockTruth', () => {
  test('T02 mergePosProducts no-entry fallback is unknown, not a silent 0 truth', () => {
    const products = mergePosProducts([makeProduct()], new Map());
    expect(products[0]!.stock).toBe(0);
    expect(products[0]!.stockTruth).toEqual({ state: 'unknown' });
    expect(UNKNOWN_STOCK_ENTRY.stockTruth.state).toBe('unknown');
  });

  test('T06 real numeric 0 is known and distinguishable from unknown', () => {
    const knownZero = stockEntryFromStockDoc({ totalStockBase: 0 }, false);
    const missing = stockEntryFromStockDoc(undefined, false);
    expect(knownZero).toEqual({
      stock: 0,
      stockTruth: { state: 'known', asOf: 'server', localDeltaApplied: false },
      overrideTierPrices: undefined,
    });
    expect(missing.stockTruth).toEqual({ state: 'unknown' });
    expect(knownZero.stockTruth).not.toEqual(missing.stockTruth);
  });

  test('T01 non-numeric totalStockBase is unknown', () => {
    expect(stockEntryFromStockDoc({ totalStockBase: '8' }, false).stockTruth.state).toBe('unknown');
    expect(stockEntryFromStockDoc({ totalStockBase: Number.NaN }, true).stockTruth.state).toBe('unknown');
  });

  test('toPosProduct passes stockTruth through (choke point)', () => {
    const pos = toPosProduct(
      makeProduct(),
      { stock: 4, stockTruth: { state: 'known', asOf: 'cache', localDeltaApplied: false } },
    );
    expect(pos.stock).toBe(4);
    expect(pos.stockTruth).toEqual({ state: 'known', asOf: 'cache', localDeltaApplied: false });
  });

  test('T07 DEV_POS_PRODUCTS entries are explicit unknown', () => {
    expect(DEV_POS_PRODUCTS.length).toBeGreaterThan(0);
    expect(DEV_POS_PRODUCTS.every((p) => p.stockTruth.state === 'unknown')).toBe(true);
  });

  test('T09 omitting stockTruth is a type error', () => {
    // @ts-expect-error PK-5 T09 — stockTruth is required
    const _bad: PosProduct = {
      id: 'x',
      name: 'x',
      sku: 'x',
      barcode: null,
      category: 'c',
      emoji: 'x',
      imageUrl: null,
      stock: 0,
      baseUnit: 'ชิ้น',
      uomOptions: [],
    };
    expect(_bad.stock).toBe(0);
  });
});
