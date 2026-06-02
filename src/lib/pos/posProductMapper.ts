/**
 * Serialization boundary: pure `Product` (Firestore) → `PosProduct` (POS UI)
 * projection. This is the ONE place raw catalog documents are stripped down to
 * the primitive-only shape the POS grid and cart consume — no Firestore
 * `Timestamp`/`DocumentReference` ever crosses into `PosProduct`, so the result
 * is safe to structured-clone into IndexedDB and free of live-object identity.
 *
 * No React, no Firestore reads — just data transforms. Shared by the live
 * listener hook (`usePosProducts`) and the static repository
 * (`inventoryRepository`) so both produce byte-identical projections.
 */

import type { Product } from '../types';
import { RETAIL_PRICE_LEVEL_ID } from '../types';
import type { PosProduct, UomOption } from './types';

const CATEGORY_EMOJI: Record<string, string> = {
  'อาหารสุนัข': '🐕',
  'อาหารแมว': '🐱',
  'อาหารสัตว์': '🐾',
  'ทรีทและขนม': '🍪',
  'ของเล่น': '🧸',
  'ยาและวิตามิน': '💊',
  'อุปกรณ์': '💧',
  'ทรายแมว': '🪣',
};

/** Per-branch stock + price-override slice merged into a product projection. */
export type StockEntry = { stock: number; overrideTierPrices?: Record<string, number> };

export function buildUomOptions(product: Product): UomOption[] {
  const retailPrices = product.prices.filter((p) => p.priceLevelId === RETAIL_PRICE_LEVEL_ID);
  const options: UomOption[] = [];

  const basePrice =
    retailPrices.find((p) => p.unit === product.baseUnit)?.price ??
    retailPrices[0]?.price ??
    0;

  options.push({
    unit: product.baseUnit,
    factor: 1,
    price: basePrice,
    barcode: product.barcode ?? null,
  });

  for (const conv of product.uomConversions) {
    const price =
      retailPrices.find((p) => p.unit === conv.unit)?.price ??
      basePrice * conv.factor;
    options.push({ unit: conv.unit, factor: conv.factor, price, barcode: conv.barcode ?? null });
  }

  const unique = new Map<string, UomOption>();
  for (const o of options) unique.set(o.unit, o);
  return [...unique.values()];
}

export function toPosProduct(product: Product, entry: StockEntry): PosProduct {
  const uomOptions = buildUomOptions(product);
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode ?? null,
    category: product.category,
    emoji: CATEGORY_EMOJI[product.category] ?? '📦',
    imageUrl: product.imageUrl ?? null,
    stock: entry.stock,
    baseUnit: product.baseUnit,
    allowNegativeStock: product.allowNegativeStock ?? false,
    tierPrices: product.tierPrices,
    overrideTierPrices: entry.overrideTierPrices,
    branchSettings: product.branchSettings,
    uomOptions,
  };
}

export function mergePosProducts(
  rawProducts: Product[],
  stockByProduct: Map<string, StockEntry>,
): PosProduct[] {
  return rawProducts.map((p) => toPosProduct(p, stockByProduct.get(p.id) ?? { stock: 0 }));
}
