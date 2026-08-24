// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { PosProduct } from '../../lib/pos/types';
import { UNKNOWN_STOCK_LABEL } from '../../lib/pos/stockTruthDisplay';
import {
  formatPickerStock,
  posProductToPickerItem,
  productListItemToPickerItem,
} from './productPickerTypes';
import type { ProductListItem } from '../../lib/productCrud/types';
import { RETAIL_PRICE_LEVEL_ID } from '../../lib/types';

vi.mock('../../lib/productCrud/useProductCrud', () => ({
  useProductCrud: () => ({ products: [], loading: false }),
}));

import ProductPickerDialog from './ProductPickerDialog';

function posProduct(overrides: Partial<PosProduct> = {}): PosProduct {
  return {
    id: 'p1',
    name: 'POS item',
    sku: 'SKU1',
    barcode: '123',
    category: 'อาหารสัตว์',
    emoji: '🐕',
    imageUrl: null,
    stock: 0,
    stockTruth: { state: 'known', asOf: 'server', localDeltaApplied: false },
    baseUnit: 'ชิ้น',
    uomOptions: [{ unit: 'ชิ้น', factor: 1, price: 10 }],
    ...overrides,
  };
}

function listItem(): ProductListItem {
  return {
    id: 'a1',
    name: 'Admin item',
    sku: 'A1',
    barcode: '999',
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
    createdAt: null as unknown as ProductListItem['createdAt'],
    updatedAt: null as unknown as ProductListItem['updatedAt'],
    deletedAt: null,
    stock: 7,
    branchReorderPoint: 0,
    emoji: '📦',
    retailPrice: 10,
  };
}

afterEach(() => cleanup());

describe('ProductPickerDialog stock truth', () => {
  test('T15 posProductToPickerItem carries stockTruth; admin path leaves it undefined', () => {
    const pos = posProductToPickerItem(posProduct({ stockTruth: { state: 'unknown' } }));
    expect(pos.stockTruth?.state).toBe('unknown');
    const admin = productListItemToPickerItem(listItem());
    expect(admin.stockTruth).toBeUndefined();
    expect(formatPickerStock(admin)).toBe('7');
    expect(formatPickerStock(pos)).toBe(UNKNOWN_STOCK_LABEL);
  });

  test('T16 POS unknown stock is placeholder; admin raw number is unchanged', () => {
    render(
      <ProductPickerDialog
        open
        products={[
          posProductToPickerItem(posProduct({ id: 'u1', name: 'Unknown stock', stock: 0, stockTruth: { state: 'unknown' } })),
          productListItemToPickerItem({ ...listItem(), id: 'a1', name: 'Admin seven', stock: 7 }),
        ]}
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(UNKNOWN_STOCK_LABEL)).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  test('T16 known zero still renders numeric 0', () => {
    render(
      <ProductPickerDialog
        open
        products={[posProductToPickerItem(posProduct({ id: 'z1', name: 'Zero known', stock: 0 }))]}
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Zero known')).toBeTruthy();
    expect(document.querySelector('.stock-zero')?.textContent).toBe('0');
    expect(screen.queryByText(UNKNOWN_STOCK_LABEL)).toBeNull();
  });
});
