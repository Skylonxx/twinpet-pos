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
// UI-12: the toast store is a module with module-level state + a setTimeout-driven dismiss
// timer. The vitest unit config runs in `node` with no DOM and no renderHook, and the store
// exposes no state getter (and we must not add one), so its queue/dedupe/replace/timer
// contract is asserted at the source level via `?raw`, mirroring the cartSource precedent.
let toastStoreSource: string;

beforeAll(async () => {
  cartSource = (await import('./useCart.ts?raw')).default;
  toastStoreSource = (await import('../../components/ui/use-toast.ts?raw')).default;
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
// Mirrors the REAL UI-13 useCart.dispatchStockToast: the matrix copy from cartUtils still
// carries a leading status glyph (🚫 / ⚠️) so node-level cart tests can branch on it, but the
// toast UI uses a short STATIC title (the component renders its own SVG icon) and moves the
// dynamic product/stock detail into a `\n`-joined structured description — identical layout for
// the red and yellow variants, with only the strict block adding the third explanatory line.
// Keeping this harness faithful means the spy assertions below prove the ACTUAL UI-13 payload.
type StockToastContext = { name: string; stock: number; unit: string } | null;

function stockToastContext(product: PosProduct): StockToastContext {
  return { name: product.name, stock: product.stock, unit: product.baseUnit };
}

function resolveStockToastContext(
  lineKey: string,
  cart: Record<string, CartLine>,
  products: PosProduct[],
): StockToastContext {
  const line = cart[lineKey];
  if (!line) return null;
  const product = products.find((p) => p.id === line.productId);
  if (!product) return null;
  return stockToastContext(product);
}

function buildStockDescription(ctx: StockToastContext, includeDetail: boolean): string | undefined {
  const lines: string[] = [];
  if (ctx) {
    lines.push(ctx.name);
    lines.push(ctx.unit ? `คงเหลือ: ${ctx.stock} ${ctx.unit}` : `คงเหลือ: ${ctx.stock}`);
  }
  if (includeDetail) lines.push('ไม่สามารถเพิ่มสินค้าเกินจำนวนสต็อกที่มีอยู่ได้');
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function dispatchStockToast(msg: string, ctx: StockToastContext, showToast: any) {
  if (msg.startsWith('🚫')) {
    showToast({ title: 'สต็อกไม่พอ!', description: buildStockDescription(ctx, true), variant: 'destructive' });
  } else if (msg.startsWith('⚠️')) {
    showToast({ title: 'สินค้าเกินสต็อก', description: buildStockDescription(ctx, false), variant: 'warning' });
  } else {
    showToast({ title: msg });
  }
}

// UI-01-HOTFIX-BUMP-TO-TOP: mirrors the source `bumpLineToEnd` in useCart.ts — returns a NEW
// record with `key` moved to the LAST insertion slot, other lines keeping their order. Pure.
function bumpLineToEnd(
  cart: Record<string, CartLine>,
  key: string,
): Record<string, CartLine> {
  const bumped = cart[key];
  if (!bumped) return cart;
  const next: Record<string, CartLine> = {};
  for (const [k, line] of Object.entries(cart)) {
    if (k !== key) next[k] = line;
  }
  next[key] = bumped;
  return next;
}

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
      // Mirror the hook's add path INCLUDING the UI-01-HOTFIX bump-to-top reorder.
      const key = `${product.id}::${option.unit}`;
      const existed = cart[key] !== undefined;
      const result = applyAddToCart(cart, product, option, () =>
        mkLine(option.unit, 1, option.factor, product.id),
      );
      if (result.toast) dispatchStockToast(result.toast, stockToastContext(product), showToast);
      if (result.blocked) return;
      cart = existed ? bumpLineToEnd(result.cart, key) : result.cart;
    },
    changeQty(lineKey: string, delta: number, products: PosProduct[]) {
      const result = applyChangeQty(cart, lineKey, delta, products);
      if (result.toast) dispatchStockToast(result.toast, resolveStockToastContext(lineKey, cart, products), showToast);
      if (result.blocked) return;
      cart = result.cart;
    },
    setLineQty(lineKey: string, newQty: number, products: PosProduct[]): boolean {
      const result = applySetLineQty(cart, lineKey, newQty, products);
      if (result.toast) dispatchStockToast(result.toast, resolveStockToastContext(lineKey, cart, products), showToast);
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
    expect(h.showToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
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
    expect(h.showToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning' }));
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

// ─── UI-01-HOTFIX-BUMP-TO-TOP · existing-item add reorders cart state (executable) ──────
// CEO Physical UAT: re-scanning an item that already exists incremented it in place, leaving it
// buried (no visible feedback → double-scan risk). The add path now bumps the updated line to the
// END of the cart record; POSPage renders `cartLines.slice().reverse()`, so it surfaces at the
// TOP. These run the SAME applier + the bump reorder the hook uses (mirrored in makeHarness).
describe('7C-UI-01-HOTFIX-BUMP-TO-TOP · existing-item add bumps the line to the end of cart state', () => {
  // Distinct single-line products A, B, C inserted in order → state order [A, B, C].
  const silent = (id: string) =>
    makeProduct({ id, stock: 999, allowNegativeStock: true, warnOnOversell: false });

  test('re-adding existing B reorders state [A,B,C] → [A,C,B] (renders [B,C,A] under reverse)', () => {
    const h = makeHarness(
      cartWith(mkLine('ชิ้น', 1, 1, 'A'), mkLine('ชิ้น', 1, 1, 'B'), mkLine('ชิ้น', 1, 1, 'C')),
    );
    expect(Object.keys(h.cart)).toEqual(['A::ชิ้น', 'B::ชิ้น', 'C::ชิ้น']);
    h.addToCart(silent('B'), BASE);
    // B moved to the end; A and C keep their relative order.
    expect(Object.keys(h.cart)).toEqual(['A::ชิ้น', 'C::ชิ้น', 'B::ชิ้น']);
    // Visual reverse (what POSPage renders): newest (B) on top.
    expect(Object.keys(h.cart).slice().reverse()).toEqual(['B::ชิ้น', 'C::ชิ้น', 'A::ชิ้น']);
  });

  test('the bumped line keeps the correctly incremented quantity', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 1, 1, 'A'), mkLine('ชิ้น', 2, 1, 'B')));
    h.addToCart(silent('B'), BASE);
    expect(h.qty('B::ชิ้น')).toBe(3); // 2 → 3
    expect(Object.keys(h.cart)).toEqual(['A::ชิ้น', 'B::ชิ้น']); // already last, stays last
  });

  test('adding a NEW item appends to the end (existing lines keep their order)', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 1, 1, 'A'), mkLine('ชิ้น', 1, 1, 'B')));
    h.addToCart(silent('C'), BASE);
    expect(Object.keys(h.cart)).toEqual(['A::ชิ้น', 'B::ชิ้น', 'C::ชิ้น']);
    expect(h.qty('C::ชิ้น')).toBe(1);
  });

  test('a Tier 1 strict block does NOT reorder or change qty (blocked add is inert)', () => {
    const h = makeHarness(
      cartWith(mkLine('ชิ้น', 1, 1, 'A'), mkLine('ชิ้น', 58, 1, 'B'), mkLine('ชิ้น', 1, 1, 'C')),
    );
    h.addToCart(makeProduct({ id: 'B', stock: 58, allowNegativeStock: false }), BASE); // blocked
    expect(Object.keys(h.cart)).toEqual(['A::ชิ้น', 'B::ชิ้น', 'C::ชิ้น']); // order untouched
    expect(h.qty('B::ชิ้น')).toBe(58); // qty untouched
  });

  test('a different UOM of an existing product is a NEW line → appends last (no in-place bump)', () => {
    // P1 base line already present; adding the PACK unit creates P1::ลัง as a new last line.
    const h = makeHarness(cartWith(mkLine('ชิ้น', 1, 1, 'P1')));
    h.addToCart(makeProduct({ id: 'P1', stock: 999, allowNegativeStock: true, warnOnOversell: false }), PACK);
    expect(Object.keys(h.cart)).toEqual(['P1::ชิ้น', 'P1::ลัง']);
  });
});

// ─── UI-01-HOTFIX-BUMP-TO-TOP · bumpLineToEnd helper contract (source-level: useCart.ts) ─
describe('7C-UI-01-HOTFIX-BUMP-TO-TOP · bumpLineToEnd is a pure, order-preserving re-key (useCart.ts)', () => {
  test('builds a NEW record, preserves other lines, appends the target last (no mutation)', () => {
    const fn = region(cartSource, 'function bumpLineToEnd', 'export function useCart');
    expect(fn).toContain('const next: Record<string, CartLine> = {}');
    expect(fn).toContain('if (k !== key) next[k] = line;');
    expect(fn).toContain('next[key] = bumped;');
    expect(fn).toContain('return next;');
  });

  test('addToCart only bumps an EXISTING line; a new line keeps applyAddToCart’s natural append', () => {
    const fn = region(cartSource, 'const addToCart = useCallback', '[buildCartLine, commit, showToast]');
    expect(fn).toContain('const existed = cartRef.current[key] !== undefined;');
    expect(fn).toContain('existed ? bumpLineToEnd(result.cart, key) : result.cart');
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
    expect(warnH.showToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning' }));

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
    expect(warnH.showToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning' }));

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
    expect(h.showToast.mock.calls[0]![0].variant).toBe('destructive');
  });

  test('Rule 2 (warn oversell) calls showToast with the oversell warning message', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 58, 1)));
    h.addToCart(makeProduct({ stock: 58, allowNegativeStock: true, warnOnOversell: true }), BASE);
    expect(h.showToast).toHaveBeenCalledTimes(1);
    expect(h.showToast.mock.calls[0]![0].variant).toBe('warning');
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
    // UI-13: the dispatch now threads product context for the structured description.
    expect(fn).toContain('dispatchStockToast(result.toast, { name: product.name, stock: product.stock, unit: product.baseUnit }, showToast)');
    expect(fn).toContain('if (result.blocked) return;');
    // UI-01-HOTFIX-BUMP-TO-TOP: an existing-line add re-keys the updated line to the end of the
    // record (commit still runs only after the blocked-return). New lines append naturally.
    expect(fn).toContain('bumpLineToEnd');
    expect(fn).toContain('commit(existed ? bumpLineToEnd(result.cart, key) : result.cart)');
    expect(fn.indexOf('if (result.blocked) return;')).toBeLessThan(fn.indexOf('commit('));
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

// ─── UI-13-TOAST-TYPOGRAPHY · static titles + structured description (source-level: useCart.ts) ─
// UI-13 replaced the UI-12 dynamic, glyph-stripped title with a short STATIC title and moved the
// dynamic product/stock detail into a `\n`-joined structured description. These assertions PROVE
// the title is no longer derived from `msg`, the exact static copy is used, and each tier maps to
// the right semantic variant + the shared description builder.
describe('7C-UI-13-TOAST-TYPOGRAPHY · dispatchStockToast uses static titles + structured description (useCart.ts)', () => {
  test('strict block uses the exact static title สต็อกไม่พอ! and variant destructive', () => {
    const helper = region(cartSource, 'function dispatchStockToast', 'function useCart');
    expect(helper).toContain("if (msg.startsWith('🚫'))");
    expect(helper).toContain("variant: 'destructive'");
    expect(helper).toContain("title: 'สต็อกไม่พอ!'");
    // Regression guard: the title must NOT be derived from `msg` (no UI-12 dynamic-title relapse).
    expect(helper).not.toMatch(/title:\s*msg\.replace/u);
    expect(helper).not.toMatch(/title:\s*msg\s*,/u);
  });

  test('warning pass uses the exact static title สินค้าเกินสต็อก and variant warning', () => {
    const helper = region(cartSource, 'function dispatchStockToast', 'function useCart');
    expect(helper).toContain("else if (msg.startsWith('⚠️'))");
    expect(helper).toContain("variant: 'warning'");
    expect(helper).toContain("title: 'สินค้าเกินสต็อก'");
  });

  test('both variants move the dynamic detail into the shared structured description builder', () => {
    const helper = region(cartSource, 'function dispatchStockToast', 'function useCart');
    expect(helper).toContain('description: buildStockDescription(ctx, true)');
    expect(helper).toContain('description: buildStockDescription(ctx, false)');
  });

  test('buildStockDescription emits product name, a distinct คงเหลือ line, and the strict-only detail', () => {
    const fn = region(cartSource, 'function buildStockDescription', 'function dispatchStockToast');
    expect(fn).toContain('ctx.name');
    expect(fn).toContain('คงเหลือ:');
    expect(fn).toContain('ไม่สามารถเพิ่มสินค้าเกินจำนวนสต็อกที่มีอยู่ได้');
  });

  test('silent pass remains silent (caller skips dispatch when result.toast is null)', () => {
    // cartUtils returns toast=null for Tier 3, so dispatchStockToast is never invoked.
    expect(cartSource).toContain('if (result.toast) dispatchStockToast(result.toast,');
  });
});

// ─── UI-13-TOAST-TYPOGRAPHY · static-title + structured payloads (EXECUTABLE via the showToast spy) ─
// The harness's dispatchStockToast mirrors the real UI-13 implementation, so the spy receives the
// ACTUAL payload the toast component would render: a short static title (no glyph, no product name,
// no remaining quantity) and a structured description that carries the dynamic detail.
const STOCK_GLYPHS = ['🚫', '⚠️', '⚠', '❌'];

describe('7C-UI-13-TOAST-TYPOGRAPHY · dispatched payloads carry static title + structured description (executable)', () => {
  const STRICT_DETAIL = 'ไม่สามารถเพิ่มสินค้าเกินจำนวนสต็อกที่มีอยู่ได้';

  test('strict block → destructive, static title, description has name + distinct คงเหลือ + strict detail', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 58, 1)));
    h.addToCart(makeProduct({ stock: 58, allowNegativeStock: false }), BASE);
    const payload = h.showToast.mock.calls[0]![0];
    expect(payload.variant).toBe('destructive');
    expect(payload.title).toBe('สต็อกไม่พอ!');
    // Title carries no glyph, no product name, no remaining quantity.
    for (const g of STOCK_GLYPHS) expect(payload.title).not.toContain(g);
    expect(payload.title).not.toContain('สินค้าทดสอบ');
    expect(payload.title).not.toContain('คงเหลือ');
    // Description carries the dynamic detail in the structured layout.
    expect(payload.description).toContain('สินค้าทดสอบ'); // line 1: product name
    expect(payload.description).toContain('คงเหลือ:'); // line 2: distinct remaining-stock line
    expect(payload.description).toContain('58'); // remaining stock
    expect(payload.description).toContain('ชิ้น'); // unit
    expect(payload.description).toContain(STRICT_DETAIL); // line 3: strict-only explanation
  });

  test('warning pass → warning, static title, SAME structure WITHOUT the strict-only line', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 58, 1)));
    h.addToCart(makeProduct({ stock: 58, allowNegativeStock: true, warnOnOversell: true }), BASE);
    const payload = h.showToast.mock.calls[0]![0];
    expect(payload.variant).toBe('warning');
    expect(payload.title).toBe('สินค้าเกินสต็อก');
    for (const g of STOCK_GLYPHS) expect(payload.title).not.toContain(g);
    expect(payload.title).not.toContain('สินค้าทดสอบ');
    expect(payload.description).toContain('สินค้าทดสอบ'); // line 1: product name
    expect(payload.description).toContain('คงเหลือ:'); // line 2: distinct remaining-stock line
    expect(payload.description).toContain('58'); // remaining stock
    expect(payload.description).toContain('ชิ้น'); // unit
    expect(payload.description).not.toContain(STRICT_DETAIL); // no strict-only third line
  });

  test('silent pass → no payload dispatched at all', () => {
    const h = makeHarness(cartWith(mkLine('ชิ้น', 58, 1)));
    h.addToCart(makeProduct({ stock: 58, allowNegativeStock: true, warnOnOversell: false }), BASE);
    expect(h.showToast).not.toHaveBeenCalled();
  });
});

// ─── UI-12-FLOWBITE-TOAST · single-visible toast store contract (source-level: use-toast.ts) ─
// Codex blocker 3: there was no coverage for MAX_VISIBLE_TOASTS=1, identical-toast
// dedupe/refresh, different-toast replace, or timer cleanup. The store has no state getter
// (and we must not add one), so these are precise source-contract assertions.
describe('7C-UI-12-FLOWBITE-TOAST · toast store caps/dedupes/replaces with timer cleanup (use-toast.ts)', () => {
  test('caps the visible queue at exactly one toast (no unbounded stacking)', () => {
    expect(toastStoreSource).toMatch(/MAX_VISIBLE_TOASTS\s*=\s*1\b/);
    expect(toastStoreSource).toContain('.slice(0, MAX_VISIBLE_TOASTS)');
    // Regression guard against the rejected UI-11 store that prepended unboundedly.
    expect(toastStoreSource).not.toMatch(/memoryState\s*=\s*\[\s*\w+\s*,\s*\.\.\.memoryState\s*\]/);
  });

  test('identical toast is deduped — it refreshes the current timer and returns early', () => {
    const dispatch = region(toastStoreSource, 'export function toast', 'export function useToastDispatcher');
    expect(dispatch).toContain('isSameContent');
    expect(dispatch).toMatch(/scheduleDismiss\(\s*current\.id/);
    expect(dispatch).toContain('return current.id;');
  });

  test('a different toast REPLACES the current one (max one visible)', () => {
    const dispatch = region(toastStoreSource, 'export function toast', 'export function useToastDispatcher');
    expect(dispatch).toContain('memoryState = [newToast].slice(0, MAX_VISIBLE_TOASTS)');
  });

  test('isSameContent compares title, description and variant', () => {
    const same = region(toastStoreSource, 'function isSameContent', 'export function toast');
    expect(same).toContain('current.title === incoming.title');
    expect(same).toContain('current.description === incoming.description');
    expect(same).toContain("variant ?? 'default'");
  });

  test('uses a single shared dismiss timer cleared on every (re)schedule', () => {
    expect(toastStoreSource).toMatch(/let\s+dismissTimer/);
    expect(toastStoreSource).toContain('function clearDismissTimer');
    const schedule = region(toastStoreSource, 'function scheduleDismiss', 'function dismiss');
    expect(schedule).toContain('clearDismissTimer();');
  });
});
