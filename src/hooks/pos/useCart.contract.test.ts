// ─── Phase 7C-L2: Empty-cart bill-discount reset (money-correctness contract) ─────────
// `useCart` is a stateful React hook, and the project's vitest unit config runs in a
// `node` environment with no DOM (and no @testing-library / renderHook). So the hook
// cannot be mounted here. Mirroring the established POSPage `?raw` precedent
// (src/pages/POSPage.keyboard-contract.test.ts), these tests assert the structural
// money-correctness contract at the source level: a bill-level discount must NEVER
// survive an empty cart (a lingering discount would silently apply to the next sale).

import { describe, test, expect, beforeAll, vi } from 'vitest';
// Phase 7C-POS-Stock-Matrix: the matrix decision AND the cart mutation are PURE in cartUtils
// (evaluator + appliers), so these suites import and EXECUTE them directly (node env, no DOM).
// The hook is a thin wrapper that threads the latest cart through the appliers and dispatches
// the toast — so a tiny behavior harness (below) around the SAME appliers + a showToast spy
// reproduces the hook's add/change/set/toast/block paths exactly, including the same-tick case.
import {
  applyAddToCart,
  applyChangeQty,
  applySetLineQty,
  committedBaseUnits,
  evaluateAddToCartStock,
  OVERSELL_WARNING_MESSAGE,
  resolveStockMode,
} from '../../lib/pos/cartUtils';
import type { CartLine, PosProduct, UomOption } from '../../lib/pos/types';

let cartSource: string;

beforeAll(async () => {
  cartSource = (await import('./useCart.ts?raw')).default;
});

// ── Fixtures ──────────────────────────────────────────────────────────────────────────
const BASE: UomOption = { unit: 'ชิ้น', factor: 1, price: 10, barcode: null };
const PACK: UomOption = { unit: 'ลัง', factor: 12, price: 100, barcode: null };

function makeProduct(overrides: Partial<PosProduct> = {}): PosProduct {
  return {
    id: 'P1',
    name: 'สินค้าทดสอบ',
    sku: 'SKU1',
    barcode: null,
    category: 'cat',
    emoji: '📦',
    imageUrl: null,
    stock: 58,
    baseUnit: 'ชิ้น',
    allowNegativeStock: false,
    warnOnOversell: true,
    isBestSeller: false,
    uomOptions: [BASE, PACK],
    ...overrides,
  };
}

function mkLine(unit: string, qty: number, unitFactor: number, productId = 'P1'): CartLine {
  return {
    lineKey: `${productId}::${unit}`,
    productId,
    productName: 'สินค้าทดสอบ',
    category: 'cat',
    sku: 'SKU1',
    barcode: null,
    unit,
    unitFactor,
    unitPrice: 10,
    originalPrice: 10,
    qty,
    discount: { type: 'none', val: 0 },
  };
}

function cartWith(...lines: CartLine[]): Record<string, CartLine> {
  const rec: Record<string, CartLine> = {};
  for (const l of lines) rec[l.lineKey] = l;
  return rec;
}

/** Slice a source between two markers so assertions target a specific construct. */
function region(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  expect(end, `end marker not found: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('7C-L2 · Empty-cart bill-level reset (useCart.ts)', () => {
  test('a shared resetBillLevel helper zeroes ALL bill-level fields (value, mode, fee)', () => {
    // Single source of truth for the bill-level cleanup — used by both the empty-cart effect
    // and clearCart, so the two can never drift apart (the Codex revision blocker).
    const fn = region(cartSource, 'const resetBillLevel = useCallback', '}, []);');
    expect(fn).toContain('setBillDiscValue(0);');
    expect(fn).toContain('setBillDiscPercent(false);');
    expect(fn).toContain('setFeeRate(0);');
  });

  test('the central empty-cart effect calls resetBillLevel under an all-fields guard', () => {
    // The reset lives in the cart-state layer (not per UI handler), keyed off the derived line
    // count, so EVERY emptying path (removeLine, qty→0, clear) is covered centrally. The guard
    // fires when ANY bill-level field is non-default and avoids loops on a fresh empty cart.
    const eff = region(
      cartSource,
      'if (cartLines.length === 0',
      '}, [cartLines.length, billDiscValue, billDiscPercent, feeRate, resetBillLevel]);',
    );
    expect(eff).toContain('billDiscValue !== 0');
    expect(eff).toContain('billDiscPercent');
    expect(eff).toContain('feeRate !== 0');
    expect(eff).toContain('resetBillLevel();');
    // No inline single-field reset — the helper owns the cleanup.
    expect(eff).not.toContain('setBillDiscValue(0);');
  });

  test('the reset effect depends on all bill-level fields + the helper (stays current)', () => {
    expect(cartSource).toContain(
      '}, [cartLines.length, billDiscValue, billDiscPercent, feeRate, resetBillLevel]);',
    );
  });

  test('clearCart resets bill-level state via the SAME shared helper (parity by construction)', () => {
    // POSPage routes new-sale, hold, and the clear-cart confirmation through cart.clearCart;
    // it now delegates the bill-level cleanup to resetBillLevel, identical to the empty-cart
    // effect — so feeRate / billDiscPercent / billDiscValue can never leak on either path.
    const fn = region(cartSource, 'const clearCart = useCallback', '}, [resetBillLevel]);');
    expect(fn).toContain('setRawCart({});');
    expect(fn).toContain('resetBillLevel();');
  });

  test('item-removal (removeLine) only deletes the line — the reset is centralised, not inline', () => {
    // removeLine / changeQty(qty<=0) / setLineQty(<=0) delete lines but do NOT reset bill-level
    // state inline; the central empty-cart effect (via resetBillLevel) is the single owner.
    const remove = region(cartSource, 'const removeLine = useCallback', '}, []);');
    expect(remove).toContain('delete next[lineKey];');
    expect(remove).not.toContain('setBillDiscValue');
    expect(remove).not.toContain('setFeeRate');
    expect(remove).not.toContain('resetBillLevel');
  });

  test('restoreCart still seeds discount/mode/fee from the suspended bill (not clobbered)', () => {
    // Restoring a parked bill repopulates lines AND its bill-level state together, so the cart
    // is never empty during restore → the empty-cart reset does not fire on it.
    const fn = region(cartSource, 'const restoreCart = useCallback', '}, []);');
    expect(fn).toContain('cartLinesToRecord(bill.cartItems)');
    expect(fn).toContain('setBillDiscValue(bill.discount);');
    expect(fn).toContain('setBillDiscPercent(bill.discountPercent);');
    expect(fn).toContain('setFeeRate(bill.feeRate);');
  });

  test('bill-level setters remain available (non-empty cart discount/fee behaviour unchanged)', () => {
    // The setters are still owned/exported by the hook and unchanged; the reset acts ONLY on an
    // empty cart, so a discount/fee on a cart that still has items is untouched.
    expect(cartSource).toContain('const [billDiscValue, setBillDiscValue] = useState(0);');
    expect(cartSource).toContain('const [billDiscPercent, setBillDiscPercent] = useState(false);');
    expect(cartSource).toContain('const [feeRate, setFeeRate] = useState(0);');
    expect(cartSource).toContain('setBillDiscValue,');
    expect(cartSource).toContain('setBillDiscPercent,');
    expect(cartSource).toContain('setFeeRate,');
  });

  test('totals math is untouched by L2 (no checkout/total semantics change)', () => {
    // The fix is a state reset only — calcCartTotals is still called with the same args, so
    // non-empty discount/fee totals and pre-sale checkout totals are unchanged.
    expect(cartSource).toContain('calcCartTotals(cartLines, billDiscValue, billDiscPercent, feeRate)');
  });
});

// ─── Stock Matrix · resolveStockMode (the two toggles → tier) ──────────────────────────
describe('7C-POS-Stock-Matrix · resolveStockMode (cartUtils.ts)', () => {
  test('allowNegativeStock=false → strict (Tier 1), regardless of warnOnOversell', () => {
    expect(resolveStockMode(makeProduct({ allowNegativeStock: false, warnOnOversell: true }))).toBe('strict');
    expect(resolveStockMode(makeProduct({ allowNegativeStock: false, warnOnOversell: false }))).toBe('strict');
  });

  test('allowNegativeStock=true + warnOnOversell=true → warn (Tier 2)', () => {
    expect(resolveStockMode(makeProduct({ allowNegativeStock: true, warnOnOversell: true }))).toBe('warn');
  });

  test('allowNegativeStock=true + warnOnOversell=false → silent (Tier 3)', () => {
    expect(resolveStockMode(makeProduct({ allowNegativeStock: true, warnOnOversell: false }))).toBe('silent');
  });

  test('absent/legacy warnOnOversell defaults to warn when overselling is allowed (safety)', () => {
    expect(resolveStockMode(makeProduct({ allowNegativeStock: true, warnOnOversell: undefined }))).toBe('warn');
  });
});

// ─── Stock Matrix · Tier 1 — Strict Block ──────────────────────────────────────────────
describe('7C-POS-Stock-Matrix · Tier 1 strict (allowNegativeStock=false) blocks oversell', () => {
  const strict = (o: Partial<PosProduct> = {}) => makeProduct({ allowNegativeStock: false, ...o });

  test('within stock: allowed silently (no block, no toast)', () => {
    const r = evaluateAddToCartStock(strict({ stock: 58 }), BASE, 1, cartWith(mkLine('ชิ้น', 57, 1)));
    expect(r).toEqual({ mode: 'strict', block: false, toast: null });
  });

  test('exact boundary (needed === stock): allowed', () => {
    const r = evaluateAddToCartStock(strict({ stock: 58 }), BASE, 1, cartWith(mkLine('ชิ้น', 57, 1)));
    expect(r.block).toBe(false);
    // 57 + 1 = 58, not over 58.
  });

  test('one over the boundary (58 → add 1 makes 59): BLOCKED with red toast', () => {
    const r = evaluateAddToCartStock(strict({ stock: 58 }), BASE, 1, cartWith(mkLine('ชิ้น', 58, 1)));
    expect(r.mode).toBe('strict');
    expect(r.block).toBe(true);
    expect(r.toast).toContain('🚫');
    expect(r.toast).toContain('สต็อกไม่พอ');
  });

  test('CEO scenario: stock 58, attempt 59 base units → BLOCKED', () => {
    const r = evaluateAddToCartStock(strict({ stock: 58 }), BASE, 59, cartWith());
    expect(r.block).toBe(true);
  });

  test('empty stock (stock<=0): BLOCKED with สต็อกหมด copy', () => {
    const r = evaluateAddToCartStock(strict({ stock: 0 }), BASE, 1, cartWith());
    expect(r.block).toBe(true);
    expect(r.toast).toContain('สต็อกหมด');
  });

  test('UOM multiplier oversell: stock 10, add 1 pack ×12 → BLOCKED (12 > 10)', () => {
    const r = evaluateAddToCartStock(strict({ stock: 10 }), PACK, 1, cartWith());
    expect(r.block).toBe(true);
  });

  test('UOM multiplier within stock: stock 24, add 1 pack ×12 → allowed (12 <= 24)', () => {
    const r = evaluateAddToCartStock(strict({ stock: 24 }), PACK, 1, cartWith());
    expect(r.block).toBe(false);
    expect(r.toast).toBeNull();
  });
});

// ─── Stock Matrix · Tier 2 — Warning Pass ──────────────────────────────────────────────
describe('7C-POS-Stock-Matrix · Tier 2 warn (allowNegativeStock=true, warnOnOversell=true)', () => {
  const warn = (o: Partial<PosProduct> = {}) => makeProduct({ allowNegativeStock: true, warnOnOversell: true, ...o });

  test('within stock: allowed silently (no toast)', () => {
    const r = evaluateAddToCartStock(warn({ stock: 58 }), BASE, 1, cartWith(mkLine('ชิ้น', 10, 1)));
    expect(r).toEqual({ mode: 'warn', block: false, toast: null });
  });

  test('oversell: ALLOWED (never blocks) but shows the yellow warning toast', () => {
    const r = evaluateAddToCartStock(warn({ stock: 58 }), BASE, 1, cartWith(mkLine('ชิ้น', 58, 1)));
    expect(r.mode).toBe('warn');
    expect(r.block).toBe(false);
    expect(r.toast).toContain('⚠️');
    expect(r.toast).toContain(OVERSELL_WARNING_MESSAGE);
  });

  test('UOM multiplier oversell: stock 10, add 1 pack ×12 → allowed + warning', () => {
    const r = evaluateAddToCartStock(warn({ stock: 10 }), PACK, 1, cartWith());
    expect(r.block).toBe(false);
    expect(r.toast).toContain(OVERSELL_WARNING_MESSAGE);
  });
});

// ─── Stock Matrix · Tier 3 — Silent Pass ───────────────────────────────────────────────
describe('7C-POS-Stock-Matrix · Tier 3 silent (allowNegativeStock=true, warnOnOversell=false)', () => {
  const silent = (o: Partial<PosProduct> = {}) => makeProduct({ allowNegativeStock: true, warnOnOversell: false, ...o });

  test('oversell: ALLOWED completely silently (no block, no toast)', () => {
    const r = evaluateAddToCartStock(silent({ stock: 58 }), BASE, 1, cartWith(mkLine('ชิ้น', 58, 1)));
    expect(r).toEqual({ mode: 'silent', block: false, toast: null });
  });

  test('massive UOM oversell still silent: stock 1, add 5 packs ×12 (=60)', () => {
    const r = evaluateAddToCartStock(silent({ stock: 1 }), PACK, 5, cartWith());
    expect(r.block).toBe(false);
    expect(r.toast).toBeNull();
  });
});

// ─── Stock Matrix · Aggregate across all UOM lines of the product ──────────────────────
describe('7C-POS-Stock-Matrix · aggregate base-unit accounting (cartUtils.ts)', () => {
  test('committedBaseUnits sums every UOM line of the product in base units', () => {
    // 5 base (×1) + 4 packs (×12 = 48) = 53 base units committed.
    const cart = cartWith(mkLine('ชิ้น', 5, 1), mkLine('ลัง', 4, 12));
    expect(committedBaseUnits(cart, 'P1')).toBe(53);
  });

  test('committedBaseUnits ignores other products', () => {
    const cart = cartWith(mkLine('ชิ้น', 5, 1), mkLine('ชิ้น', 9, 1, 'P2'));
    expect(committedBaseUnits(cart, 'P1')).toBe(5);
  });

  test('strict block uses the AGGREGATE: 53 committed + 6 base > 58 → BLOCKED', () => {
    const cart = cartWith(mkLine('ชิ้น', 5, 1), mkLine('ลัง', 4, 12)); // 53 base
    const r = evaluateAddToCartStock(makeProduct({ stock: 58 }), BASE, 6, cart);
    expect(r.block).toBe(true); // 53 + 6 = 59 > 58
  });

  test('strict allows when aggregate stays within: 53 committed + 5 base = 58 (boundary)', () => {
    const cart = cartWith(mkLine('ชิ้น', 5, 1), mkLine('ลัง', 4, 12)); // 53 base
    const r = evaluateAddToCartStock(makeProduct({ stock: 58 }), BASE, 5, cart);
    expect(r.block).toBe(false); // 53 + 5 = 58, not over
  });

  test('adding a different UOM counts against the same aggregate pool', () => {
    // 50 base committed; adding 1 pack (×12) → 62 > 58 → strict block.
    const cart = cartWith(mkLine('ชิ้น', 50, 1));
    const r = evaluateAddToCartStock(makeProduct({ stock: 58 }), PACK, 1, cart);
    expect(r.block).toBe(true);
  });
});

// ─── Stock Matrix · executable behavior harness (mirrors useCart's wrapper exactly) ─────
// The hook threads the LATEST cart through the pure appliers and dispatches the toast. This
// harness reproduces those exact wrapper lines around the SAME appliers + a showToast spy, so
// the add/change/set/toast/block/same-tick paths are executed for real (node env, no DOM).
function makeHarness(initial: Record<string, CartLine> = {}) {
  let cart: Record<string, CartLine> = { ...initial };
  const showToast = vi.fn();
  return {
    showToast,
    get cart() {
      return cart;
    },
    qty(lineKey: string) {
      return cart[lineKey]?.qty ?? 0;
    },
    has(lineKey: string) {
      return cart[lineKey] !== undefined;
    },
    addToCart(product: PosProduct, option: UomOption) {
      const result = applyAddToCart(cart, product, option, () =>
        mkLine(option.unit, 1, option.factor, product.id),
      );
      if (result.toast) showToast(result.toast);
      if (result.blocked) return;
      cart = result.cart;
    },
    changeQty(lineKey: string, delta: number, products: PosProduct[]) {
      const result = applyChangeQty(cart, lineKey, delta, products);
      if (result.toast) showToast(result.toast);
      if (result.blocked) return;
      cart = result.cart;
    },
    setLineQty(lineKey: string, newQty: number, products: PosProduct[]): boolean {
      const result = applySetLineQty(cart, lineKey, newQty, products);
      if (result.toast) showToast(result.toast);
      if (result.ok) cart = result.cart;
      return result.ok;
    },
  };
}

const KEY = 'P1::ชิ้น';

describe('7C-POS-Stock-Matrix · addToCart behavior (hook wrapper over applyAddToCart)', () => {
  test('Tier 1 strict: oversell attempt toasts and does NOT increase qty', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 58, 1)));
    h.addToCart(makeProduct({ stock: 58, allowNegativeStock: false }), BASE);
    expect(h.qty(KEY)).toBe(58);
    expect(h.showToast).toHaveBeenCalledTimes(1);
    expect(h.showToast).toHaveBeenCalledWith(expect.stringContaining('🚫'));
  });

  test('Tier 1 strict: within stock increases qty silently', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 57, 1)));
    h.addToCart(makeProduct({ stock: 58, allowNegativeStock: false }), BASE);
    expect(h.qty(KEY)).toBe(58);
    expect(h.showToast).not.toHaveBeenCalled();
  });

  test('Tier 2 warn: oversell INCREASES qty and emits the yellow warning toast', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 58, 1)));
    h.addToCart(makeProduct({ stock: 58, allowNegativeStock: true, warnOnOversell: true }), BASE);
    expect(h.qty(KEY)).toBe(59);
    expect(h.showToast).toHaveBeenCalledWith(expect.stringContaining(OVERSELL_WARNING_MESSAGE));
  });

  test('Tier 3 silent: oversell INCREASES qty with no toast', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 58, 1)));
    h.addToCart(makeProduct({ stock: 58, allowNegativeStock: true, warnOnOversell: false }), BASE);
    expect(h.qty(KEY)).toBe(59);
    expect(h.showToast).not.toHaveBeenCalled();
  });

  test('same-tick repeated addToCart cannot bypass the strict boundary', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 57, 1)));
    const p = makeProduct({ stock: 58, allowNegativeStock: false });
    h.addToCart(p, BASE); // 57 → 58 ok
    h.addToCart(p, BASE); // 58 → would be 59 → BLOCKED against the LATEST cart
    expect(h.qty(KEY)).toBe(58);
    expect(h.showToast).toHaveBeenCalledTimes(1);
  });
});

describe('7C-POS-Stock-Matrix · changeQty behavior (hook wrapper over applyChangeQty)', () => {
  test('Tier 1 strict: increase over stock toasts and does NOT change qty', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 58, 1)));
    h.changeQty(KEY, 1, [makeProduct({ stock: 58, allowNegativeStock: false })]);
    expect(h.qty(KEY)).toBe(58);
    expect(h.showToast).toHaveBeenCalledTimes(1);
  });

  test('same-tick repeated changeQty(+1) cannot bypass the strict boundary', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 57, 1)));
    const products = [makeProduct({ stock: 58, allowNegativeStock: false })];
    h.changeQty(KEY, 1, products); // 57 → 58 ok
    h.changeQty(KEY, 1, products); // 58 → 59 BLOCKED
    expect(h.qty(KEY)).toBe(58);
  });

  test('decrement is NEVER blocked, even for an oversold strict product', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 3, 1)));
    h.changeQty(KEY, -1, [makeProduct({ stock: 0, allowNegativeStock: false })]);
    expect(h.qty(KEY)).toBe(2);
    expect(h.showToast).not.toHaveBeenCalled();
  });

  test('zero-out removes the line (never blocked)', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 1, 1)));
    h.changeQty(KEY, -1, [makeProduct({ stock: 0, allowNegativeStock: false })]);
    expect(h.has(KEY)).toBe(false);
  });

  test('Tier 2 warn increase oversells with a warning; Tier 3 silent oversells quietly', () => {
    const warnH = makeHarness(cartWith(mkLine('ชิ้น', 58, 1)));
    warnH.changeQty(KEY, 1, [makeProduct({ stock: 58, allowNegativeStock: true, warnOnOversell: true })]);
    expect(warnH.qty(KEY)).toBe(59);
    expect(warnH.showToast).toHaveBeenCalledWith(expect.stringContaining(OVERSELL_WARNING_MESSAGE));

    const silentH = makeHarness(cartWith(mkLine('ชิ้น', 58, 1)));
    silentH.changeQty(KEY, 1, [makeProduct({ stock: 58, allowNegativeStock: true, warnOnOversell: false })]);
    expect(silentH.qty(KEY)).toBe(59);
    expect(silentH.showToast).not.toHaveBeenCalled();
  });
});

describe('7C-POS-Stock-Matrix · setLineQty behavior (hook wrapper over applySetLineQty)', () => {
  test('Tier 1 strict block: returns false, toasts, qty unchanged (numpad stays open)', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 50, 1)));
    const ok = h.setLineQty(KEY, 59, [makeProduct({ stock: 58, allowNegativeStock: false })]);
    expect(ok).toBe(false);
    expect(h.qty(KEY)).toBe(50);
    expect(h.showToast).toHaveBeenCalledTimes(1);
  });

  test('numpad correction after a block: a valid value then applies (returns true)', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 50, 1)));
    const products = [makeProduct({ stock: 58, allowNegativeStock: false })];
    expect(h.setLineQty(KEY, 59, products)).toBe(false); // blocked
    expect(h.setLineQty(KEY, 58, products)).toBe(true); // corrected
    expect(h.qty(KEY)).toBe(58);
  });

  test('same-tick repeated set cannot bypass the strict boundary', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 50, 1)));
    const products = [makeProduct({ stock: 58, allowNegativeStock: false })];
    h.setLineQty(KEY, 58, products); // ok
    const ok = h.setLineQty(KEY, 59, products); // blocked vs latest
    expect(ok).toBe(false);
    expect(h.qty(KEY)).toBe(58);
  });

  test('Tier 2 allows + warns; Tier 3 allows silently', () => {
    const warnH = makeHarness(cartWith(mkLine('ชิ้น', 50, 1)));
    expect(warnH.setLineQty(KEY, 59, [makeProduct({ stock: 58, allowNegativeStock: true, warnOnOversell: true })])).toBe(true);
    expect(warnH.qty(KEY)).toBe(59);
    expect(warnH.showToast).toHaveBeenCalledWith(expect.stringContaining(OVERSELL_WARNING_MESSAGE));

    const silentH = makeHarness(cartWith(mkLine('ชิ้น', 50, 1)));
    expect(silentH.setLineQty(KEY, 59, [makeProduct({ stock: 58, allowNegativeStock: true, warnOnOversell: false })])).toBe(true);
    expect(silentH.qty(KEY)).toBe(59);
    expect(silentH.showToast).not.toHaveBeenCalled();
  });

  test('lower quantity / zero removal stays unblocked (returns true)', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 50, 1)));
    const products = [makeProduct({ stock: 0, allowNegativeStock: false })];
    expect(h.setLineQty(KEY, 10, products)).toBe(true); // lowering, never blocked
    expect(h.qty(KEY)).toBe(10);
    expect(h.setLineQty(KEY, 0, products)).toBe(true); // removal
    expect(h.has(KEY)).toBe(false);
  });
});

describe('7C-POS-Stock-Matrix · toast path proven with a showToast spy', () => {
  test('Rule 1 (strict oversell) calls showToast with a red block message', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 58, 1)));
    h.addToCart(makeProduct({ stock: 58, allowNegativeStock: false }), BASE);
    expect(h.showToast).toHaveBeenCalledTimes(1);
    expect(h.showToast.mock.calls[0]![0]).toContain('🚫');
  });

  test('Rule 2 (warn oversell) calls showToast with the oversell warning message', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 58, 1)));
    h.addToCart(makeProduct({ stock: 58, allowNegativeStock: true, warnOnOversell: true }), BASE);
    expect(h.showToast).toHaveBeenCalledTimes(1);
    expect(h.showToast.mock.calls[0]![0]).toContain(OVERSELL_WARNING_MESSAGE);
  });

  test('Rule 3 (silent oversell) does NOT call showToast', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 58, 1)));
    h.addToCart(makeProduct({ stock: 58, allowNegativeStock: true, warnOnOversell: false }), BASE);
    expect(h.showToast).not.toHaveBeenCalled();
  });
});

describe('7C-POS-Stock-Matrix · aggregate / multi-UOM through the hook wrapper', () => {
  test('strict block uses the cross-UOM aggregate (5 base + 4 packs = 53; +6 base > 58)', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 5, 1), mkLine('ลัง', 4, 12)));
    h.changeQty('P1::ชิ้น', 6, [makeProduct({ stock: 58, allowNegativeStock: false })]);
    expect(h.qty('P1::ชิ้น')).toBe(5); // blocked: 53 + 6 = 59 > 58
  });

  test('strict allows when the aggregate stays within (53 + 5 = 58)', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 5, 1), mkLine('ลัง', 4, 12)));
    h.changeQty('P1::ชิ้น', 5, [makeProduct({ stock: 58, allowNegativeStock: false })]);
    expect(h.qty('P1::ชิ้น')).toBe(10); // 53 + 5 = 58, allowed
  });

  test('adding a different UOM counts against the same pool (50 base + 1 pack×12 > 58 → block)', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 50, 1)));
    h.addToCart(makeProduct({ stock: 58, allowNegativeStock: false }), PACK);
    expect(h.has('P1::ลัง')).toBe(false); // blocked, pack line never created
  });
});

// ─── Stock Matrix · useCart wiring (source-level: hook threads latest cart via appliers) ─
describe('7C-POS-Stock-Matrix · useCart wiring uses the latest-cart ref + pure appliers (useCart.ts)', () => {
  test('imports the appliers, not the old advisory validator', () => {
    expect(cartSource).toContain('applyAddToCart');
    expect(cartSource).toContain('applyChangeQty');
    expect(cartSource).toContain('applySetLineQty');
    expect(cartSource).not.toContain('validateAddToCartStock');
    expect(cartSource).not.toContain('คำเตือนสต๊อก');
  });

  test('a synchronously-updated cartRef + commit fixes the stale-closure same-tick race', () => {
    expect(cartSource).toContain('const cartRef = useRef');
    // commit writes the ref synchronously alongside the state set (latest cart for next call).
    const commit = region(cartSource, 'const commit = useCallback', '}, []);');
    expect(commit).toContain('cartRef.current = next;');
    expect(commit).toContain('setRawCart(next);');
    // The effect re-syncs the ref for other writers (reprice / clear / restore).
    expect(cartSource).toContain('cartRef.current = rawCart;');
  });

  test('addToCart validates against cartRef.current, toasts, and blocks before commit', () => {
    const fn = region(cartSource, 'const addToCart = useCallback', '[buildCartLine, commit, showToast]');
    expect(fn).toContain('applyAddToCart(cartRef.current, product, option');
    expect(fn).toContain('if (result.toast) showToast(result.toast);');
    expect(fn).toContain('if (result.blocked) return;');
    expect(fn.indexOf('if (result.blocked) return;')).toBeLessThan(fn.indexOf('commit(result.cart)'));
  });

  test('changeQty routes through applyChangeQty(cartRef.current, ...)', () => {
    const fn = region(cartSource, 'const changeQty = useCallback', '[commit, products, showToast]');
    expect(fn).toContain('applyChangeQty(cartRef.current, lineKey, delta, products)');
    expect(fn).toContain('if (result.blocked) return;');
  });

  test('setLineQty routes through applySetLineQty and returns its ok flag', () => {
    const fn = region(cartSource, 'const setLineQty = useCallback', '[commit, products, showToast]');
    expect(fn).toContain('applySetLineQty(cartRef.current, lineKey, newQty, products)');
    expect(fn).toContain('if (result.ok) commit(result.cart);');
    expect(fn).toContain('return result.ok;');
  });
});
