import type { Product } from '../types';
import type { PosProduct, UomOption } from './types';

export type TierPriceProduct = Pick<Product, 'tierPrices'> & {
  price: number;
};

export function getActivePrice(
  product: TierPriceProduct,
  customerType: string | null | undefined,
): number {
  if (!customerType || !product.tierPrices) return product.price;
  const cleanType = customerType.trim();
  if (!cleanType) return product.price;

  let tierPrice: number | undefined = product.tierPrices[cleanType];
  if (typeof tierPrice !== 'number' || tierPrice <= 0) {
    const matchedKey = Object.keys(product.tierPrices).find(
      (k) => k.trim().toLowerCase() === cleanType.toLowerCase(),
    );
    tierPrice = matchedKey != null ? product.tierPrices[matchedKey] : undefined;
  }

  return typeof tierPrice === 'number' && tierPrice > 0 ? tierPrice : product.price;
}

export function getPosProductBasePrice(product: PosProduct): number {
  const baseOption =
    product.uomOptions.find((o) => o.unit === product.baseUnit) ??
    product.uomOptions.find((o) => o.factor === 1) ??
    product.uomOptions[0];
  return baseOption?.price ?? 0;
}

/** Resolve unit price for a UOM option, scaling tier base price proportionally. */
export function resolvePosUnitPrice(
  product: PosProduct,
  option: UomOption,
  customerType: string | null | undefined,
): { unitPrice: number; originalPrice: number } {
  const originalPrice = option.price;
  const baseRetail = getPosProductBasePrice(product);
  const activeBase = getActivePrice(
    { price: baseRetail, tierPrices: product.tierPrices },
    customerType,
  );

  if (activeBase === baseRetail || baseRetail <= 0) {
    return { unitPrice: originalPrice, originalPrice };
  }

  const unitPrice = Math.round((activeBase / baseRetail) * originalPrice * 100) / 100;
  return { unitPrice, originalPrice };
}
