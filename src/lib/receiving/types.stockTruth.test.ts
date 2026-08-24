import { describe, expect, test } from 'vitest';
import { RETAIL_PRICE_LEVEL_ID } from '../types';
import type { ProductListItem } from '../productCrud/types';
import { productListItemToPosProduct, uomOptionsForProduct } from './types';

function listItem(overrides: Partial<ProductListItem> = {}): ProductListItem {
  return {
    id: 'r1',
    name: 'Recv',
    sku: 'R1',
    barcode: null,
    category: 'อาหารสัตว์',
    description: '',
    imageUrl: null,
    baseUnit: 'ชิ้น',
    uomConversions: [{ unit: 'แพ็ค', factor: 6 }],
    prices: [{ priceLevelId: RETAIL_PRICE_LEVEL_ID, unit: 'ชิ้น', price: 10 }],
    cost: 0,
    avgCost: 0,
    reorderPoint: 0,
    isActive: true,
    createdAt: null as unknown as ProductListItem['createdAt'],
    updatedAt: null as unknown as ProductListItem['updatedAt'],
    deletedAt: null,
    stock: 42,
    branchReorderPoint: 0,
    emoji: '📦',
    retailPrice: 10,
    ...overrides,
  };
}

describe('receiving productListItemToPosProduct stockTruth', () => {
  test('T08 default-fill is unknown and uomOptionsForProduct never reads stockTruth', () => {
    const pos = productListItemToPosProduct(listItem());
    expect(pos.stock).toBe(42);
    expect(pos.stockTruth).toEqual({ state: 'unknown' });
    const uom = uomOptionsForProduct(listItem({ stock: 99 }));
    expect(uom.map((o) => o.unit)).toEqual(['ชิ้น', 'แพ็ค']);
    expect(uom.every((o) => !('stock' in o) && !('stockTruth' in o))).toBe(true);
  });
});
