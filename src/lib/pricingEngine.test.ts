import { describe, test, expect } from 'vitest';
import { calculateEffectivePrice, type PricingProduct } from './pricingEngine';
import type { ProductStock } from './types';

// ─── Minimal fixture helpers ──────────────────────────────────────────────────
//
// The pricing engine only reads `overridePrice` and `overrideTierPrices` from
// ProductStock.  We cast a partial object so tests stay short and focused.

function makeStock(
  fields: { overridePrice?: number | null; overrideTierPrices?: Record<string, number> | null },
): ProductStock {
  return fields as unknown as ProductStock;
}

const BASE_PRICE = 100;

// Product with no tier prices — useful for testing steps 3 and 4 in isolation.
const PLAIN_PRODUCT: PricingProduct = { basePrice: BASE_PRICE };

// Product with HQ-level tier prices.
const TIERED_PRODUCT: PricingProduct = {
  basePrice: BASE_PRICE,
  tierPrices: { VIP: 80, WHOLESALE: 70 },
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('calculateEffectivePrice — Waterfall Pricing Engine', () => {

  // ── Step 4: master basePrice (lowest priority / final fallback) ───────────

  describe('Step 4 fallback — master basePrice', () => {
    test('Scenario A: no stock doc, no customer tier → returns master basePrice', () => {
      expect(calculateEffectivePrice(PLAIN_PRODUCT, undefined, null)).toBe(BASE_PRICE);
    });

    test('stock doc present but carries no override fields → returns master basePrice', () => {
      expect(calculateEffectivePrice(PLAIN_PRODUCT, makeStock({}), null)).toBe(BASE_PRICE);
    });

    test('product.basePrice undefined → returns 0 (safe default)', () => {
      expect(calculateEffectivePrice({ basePrice: undefined }, undefined, null)).toBe(0);
    });

    test('product.basePrice is exactly 0 → returns 0', () => {
      expect(calculateEffectivePrice({ basePrice: 0 }, undefined, null)).toBe(0);
    });
  });

  // ── Step 3: branch overridePrice ─────────────────────────────────────────

  describe('Step 3 — branch overridePrice', () => {
    test('Scenario B: branch has overridePrice, null customer tier → returns overridePrice', () => {
      const stock = makeStock({ overridePrice: 150 });
      expect(calculateEffectivePrice(PLAIN_PRODUCT, stock, null)).toBe(150);
    });

    test('overridePrice = 0 is treated as "not set" → falls through to basePrice', () => {
      const stock = makeStock({ overridePrice: 0 });
      expect(calculateEffectivePrice(PLAIN_PRODUCT, stock, null)).toBe(BASE_PRICE);
    });

    test('overridePrice = null → falls through to basePrice', () => {
      const stock = makeStock({ overridePrice: null });
      expect(calculateEffectivePrice(PLAIN_PRODUCT, stock, null)).toBe(BASE_PRICE);
    });

    test('customer has a tier but no tier prices are defined anywhere → overridePrice still applies', () => {
      // After steps 1 and 2 both miss, we arrive at step 3.
      const stock = makeStock({ overridePrice: 150 });
      expect(calculateEffectivePrice(PLAIN_PRODUCT, stock, 'VIP')).toBe(150);
    });
  });

  // ── Step 2: master tierPrices ─────────────────────────────────────────────

  describe('Step 2 — master tierPrices', () => {
    test('Scenario D: no branch tier override, master tierPrices.VIP applies', () => {
      // Branch override would normally win, but tier lookup (step 2) beats it.
      const stock = makeStock({ overridePrice: 150 });
      expect(calculateEffectivePrice(TIERED_PRODUCT, stock, 'VIP')).toBe(80);
    });

    test('WHOLESALE tier resolves to its master price', () => {
      expect(calculateEffectivePrice(TIERED_PRODUCT, undefined, 'WHOLESALE')).toBe(70);
    });

    test('master tierPrices.VIP = 0 is ignored → falls through to branch overridePrice', () => {
      const product: PricingProduct = { basePrice: BASE_PRICE, tierPrices: { VIP: 0 } };
      const stock = makeStock({ overridePrice: 150 });
      expect(calculateEffectivePrice(product, stock, 'VIP')).toBe(150);
    });

    test('customer tier not present in master tierPrices → falls through to overridePrice', () => {
      const stock = makeStock({ overridePrice: 150 });
      expect(calculateEffectivePrice(TIERED_PRODUCT, stock, 'AGENT')).toBe(150);
    });
  });

  // ── Step 1: branch overrideTierPrices (highest priority) ─────────────────

  describe('Step 1 — branch overrideTierPrices (highest priority)', () => {
    test('Scenario C: branch overrideTierPrices.VIP beats master tier AND branch overridePrice', () => {
      const stock = makeStock({ overridePrice: 150, overrideTierPrices: { VIP: 60 } });
      expect(calculateEffectivePrice(TIERED_PRODUCT, stock, 'VIP')).toBe(60);
    });

    test('branch overrideTierPrices.VIP beats master tierPrices.VIP even without overridePrice', () => {
      const stock = makeStock({ overrideTierPrices: { VIP: 60 } });
      expect(calculateEffectivePrice(TIERED_PRODUCT, stock, 'VIP')).toBe(60);
    });

    test('branch overrideTierPrices.VIP = 0 is ignored → falls to master tierPrices.VIP', () => {
      const stock = makeStock({ overrideTierPrices: { VIP: 0 } });
      expect(calculateEffectivePrice(TIERED_PRODUCT, stock, 'VIP')).toBe(80);
    });

    test('branch overrideTierPrices exists for different tier → does not affect VIP lookup', () => {
      const stock = makeStock({ overrideTierPrices: { WHOLESALE: 50 } });
      expect(calculateEffectivePrice(TIERED_PRODUCT, stock, 'VIP')).toBe(80);
    });
  });

  // ── Full priority order ───────────────────────────────────────────────────

  describe('Priority order — full four-step waterfall', () => {
    test('branch tier(60) wins over master tier(80), branch override(150), and base(100)', () => {
      const stock = makeStock({ overridePrice: 150, overrideTierPrices: { VIP: 60 } });
      expect(calculateEffectivePrice(TIERED_PRODUCT, stock, 'VIP')).toBe(60);
    });

    test('no branch tier → master tier(80) wins over branch override(150) and base(100)', () => {
      const stock = makeStock({ overridePrice: 150 });
      expect(calculateEffectivePrice(TIERED_PRODUCT, stock, 'VIP')).toBe(80);
    });

    test('no tier prices anywhere → branch override(150) wins over base(100)', () => {
      const stock = makeStock({ overridePrice: 150 });
      expect(calculateEffectivePrice(PLAIN_PRODUCT, stock, 'VIP')).toBe(150);
    });

    test('no tier prices, no branch override → returns master basePrice(100)', () => {
      expect(calculateEffectivePrice(PLAIN_PRODUCT, undefined, 'VIP')).toBe(BASE_PRICE);
    });
  });

  // ── Tier string normalisation ─────────────────────────────────────────────

  describe('customerTier input normalisation', () => {
    test('leading/trailing whitespace is trimmed before key lookup', () => {
      const stock = makeStock({ overrideTierPrices: { VIP: 60 } });
      expect(calculateEffectivePrice(PLAIN_PRODUCT, stock, '  VIP  ')).toBe(60);
    });

    test('null customerTier skips all tier checks → resolves at step 3 (overridePrice)', () => {
      const stock = makeStock({ overridePrice: 150, overrideTierPrices: { VIP: 60 } });
      expect(calculateEffectivePrice(PLAIN_PRODUCT, stock, null)).toBe(150);
    });

    test('empty string customerTier treated as null → skips tier checks', () => {
      const stock = makeStock({ overridePrice: 150, overrideTierPrices: { VIP: 60 } });
      expect(calculateEffectivePrice(PLAIN_PRODUCT, stock, '')).toBe(150);
    });

    test('whitespace-only customerTier treated as null → skips tier checks', () => {
      const stock = makeStock({ overridePrice: 150, overrideTierPrices: { VIP: 60 } });
      expect(calculateEffectivePrice(PLAIN_PRODUCT, stock, '   ')).toBe(150);
    });
  });
});
