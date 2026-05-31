import type { Product, ProductStock } from './types';

/** Minimal product shape required by the pricing engine — satisfied by both Product and PosProduct */
export type PricingProduct = Pick<Product, 'tierPrices' | 'basePrice'>;

/**
 * Waterfall pricing resolution:
 *   1. Branch tier override  →  branchStock.overrideTierPrices[customerTier]
 *   2. Master tier price     →  product.tierPrices[customerTier]
 *   3. Branch price override →  branchStock.overridePrice
 *   4. Master base price     →  product.basePrice
 */
export function calculateEffectivePrice(
  product: PricingProduct,
  branchStock: ProductStock | undefined,
  customerTier: string | null,
): number {
  const tier = customerTier?.trim() || null;

  if (tier) {
    const branchTierPrice = branchStock?.overrideTierPrices?.[tier];
    if (typeof branchTierPrice === 'number' && branchTierPrice > 0) {
      return branchTierPrice;
    }

    const masterTierPrice = product.tierPrices?.[tier];
    if (typeof masterTierPrice === 'number' && masterTierPrice > 0) {
      return masterTierPrice;
    }
  }

  const branchOverride = branchStock?.overridePrice;
  if (typeof branchOverride === 'number' && branchOverride > 0) {
    return branchOverride;
  }

  return product.basePrice ?? 0;
}
