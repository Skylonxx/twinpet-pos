import { roundMoney } from '../money';
import type { CartLine, CartTotals, ItemDiscountType, PosProduct, UomOption } from './types';

// Re-exported from the centralized money util so existing
// `import { formatMoney } from '.../pos/cartUtils'` call-sites keep working.
export { formatMoney } from '../money';

export function cartLineKey(productId: string, unit: string): string {
  return `${productId}::${unit}`;
}

export function getLineTotal(line: CartLine): number {
  const base = line.unitPrice * line.qty;
  const { type, val } = line.discount;
  if (type === 'disc_thb') return roundMoney(Math.max(0, base - val));
  if (type === 'disc_pct') return roundMoney(Math.max(0, base * (1 - val / 100)));
  if (type === 'override') return roundMoney(Math.max(0, val * line.qty));
  return roundMoney(base);
}

export function calcCartTotals(
  lines: CartLine[],
  billDiscountValue: number,
  billDiscountIsPercent: boolean,
  feeRatePercent: number,
): CartTotals {
  const subtotal = roundMoney(lines.reduce((sum, line) => sum + getLineTotal(line), 0));
  const billDiscount = roundMoney(
    billDiscountIsPercent
      ? subtotal * (billDiscountValue / 100)
      : Math.min(billDiscountValue, subtotal),
  );
  const afterDiscount = roundMoney(Math.max(0, subtotal - billDiscount));
  const fee = roundMoney(afterDiscount * (feeRatePercent / 100));
  const grandTotal = roundMoney(afterDiscount + fee);
  const totalQty = lines.reduce((sum, line) => sum + line.qty, 0);

  return {
    subtotal,
    billDiscount,
    fee,
    grandTotal,
    itemCount: lines.length,
    totalQty,
  };
}

export const IDP_LABELS: Record<Exclude<ItemDiscountType, 'none'>, string> = {
  disc_thb: 'ส่วนลด (฿)',
  disc_pct: 'ส่วนลด (%)',
  override: 'ราคาขายใหม่ (ต่อหน่วย)',
};

// ─── 3-Tier Stock Matrix (Phase 7C-POS-Stock-Matrix) ──────────────────────────────────
// Stock control is governed by TWO product flags evaluated together at cart-entry time:
//   Tier 1 · strict  (allowNegativeStock === false)               → BLOCK + red toast on oversell
//   Tier 2 · warn    (allowNegativeStock && warnOnOversell !== false) → ALLOW + yellow toast on oversell
//   Tier 3 · silent  (allowNegativeStock && warnOnOversell === false) → ALLOW, no toast ever
// All quantity math is in BASE UNITS and AGGREGATES every UOM line of the product already in
// the cart, so mixed-unit combinations cannot collectively slip past the boundary. Decrements
// and removals never reach this evaluator. Pure — no mutation, no React, no I/O.

/** Exact yellow-warning copy surfaced in Tier 2 (oversell allowed but flagged). */
export const OVERSELL_WARNING_MESSAGE = 'สินค้าเกินสต็อกที่มีอยู่!';

/** The stock-control mode derived purely from the two product toggles. */
export type StockMode = 'strict' | 'warn' | 'silent';

export function resolveStockMode(product: PosProduct): StockMode {
  if (!product.allowNegativeStock) return 'strict';
  // Overselling is allowed; warn unless explicitly silenced (absent/legacy → warn for safety).
  return product.warnOnOversell === false ? 'silent' : 'warn';
}

/** Sum of base units already committed for a product across ALL of its UOM cart lines. */
export function committedBaseUnits(
  cart: Record<string, CartLine>,
  productId: string,
): number {
  let total = 0;
  for (const line of Object.values(cart)) {
    if (line.productId === productId) total += line.qty * line.unitFactor;
  }
  return total;
}

export type StockEvaluation = {
  /** The product's configured matrix mode (independent of whether this add oversells). */
  mode: StockMode;
  /** true → the requested quantity INCREASE must be prevented (Tier 1 / strict only). */
  block: boolean;
  /** Toast to surface, or null. Tier 1 = red block copy; Tier 2 = yellow oversell warning. */
  toast: string | null;
};

/**
 * Evaluate a prospective quantity INCREASE of `addQty` of `option` against branch stock.
 * `addQty` is in the option's own unit; it is converted to base via `option.factor` and added
 * to the product's already-committed base units (across every UOM line) before the boundary
 * check. Returns the matrix decision — the caller surfaces the toast and honors `block`.
 */
export function evaluateAddToCartStock(
  product: PosProduct,
  option: UomOption,
  addQty: number,
  cart: Record<string, CartLine>,
): StockEvaluation {
  const mode = resolveStockMode(product);
  if (addQty <= 0) return { mode, block: false, toast: null };

  const neededBase = committedBaseUnits(cart, product.id) + addQty * option.factor;
  const oversold = product.stock <= 0 || neededBase > product.stock;
  if (!oversold) return { mode, block: false, toast: null };

  if (mode === 'strict') {
    const detail =
      product.stock <= 0
        ? `สต็อกหมด: ${product.name}`
        : `สต็อกไม่พอ: ${product.name} (เหลือ ${product.stock} ${product.baseUnit})`;
    return { mode, block: true, toast: `🚫 ${detail}` };
  }
  if (mode === 'warn') {
    return { mode, block: false, toast: `⚠️ ${OVERSELL_WARNING_MESSAGE} (${product.name})` };
  }
  return { mode, block: false, toast: null };
}

// ─── Pure cart-mutation appliers (Phase 7C-POS-Stock-Matrix revision) ──────────────────
// The matrix decision AND the resulting cart mutation are pure here so the hook stays a thin
// wrapper that just threads the latest cart (via a synchronously-updated ref) and dispatches
// the toast. Each applier takes the CURRENT cart and returns the NEXT cart — so the hook can
// chain same-tick mutations off `cartRef.current` without a stale closure ever bypassing a
// Tier 1 strict block. These are directly unit-testable, including the same-tick case (thread
// the returned `.cart` into the next call). No React, no I/O, no mutation of the input cart.

export type CartRecord = Record<string, CartLine>;

/** Result of an add-one-unit. `blocked` → caller must NOT apply `cart` (Tier 1 strict). */
export type AddToCartResult = { cart: CartRecord; toast: string | null; blocked: boolean };

/**
 * Add one unit of `option` under the matrix. `buildLine` produces the NEW line (price-frozen
 * by the caller) and is invoked ONLY when the line does not already exist. On a Tier 1 block
 * the input cart is returned unchanged with `blocked: true` (+ the red toast).
 */
export function applyAddToCart(
  cart: CartRecord,
  product: PosProduct,
  option: UomOption,
  buildLine: () => CartLine,
): AddToCartResult {
  const stock = evaluateAddToCartStock(product, option, 1, cart);
  if (stock.block) return { cart, toast: stock.toast, blocked: true };
  const key = cartLineKey(product.id, option.unit);
  const existing = cart[key];
  const line = existing ? { ...existing, qty: existing.qty + 1 } : buildLine();
  return { cart: { ...cart, [key]: line }, toast: stock.toast, blocked: false };
}

/** Result of a relative qty change. `blocked` → caller must NOT apply (Tier 1 strict). */
export type ChangeQtyResult = { cart: CartRecord; toast: string | null; blocked: boolean };

/**
 * Apply a relative `delta` to a line. Decrement / zero-out is NEVER blocked (it only deletes
 * the line). An increase runs the matrix; a Tier 1 strict block returns the cart unchanged.
 */
export function applyChangeQty(
  cart: CartRecord,
  lineKey: string,
  delta: number,
  products: PosProduct[],
): ChangeQtyResult {
  const line = cart[lineKey];
  if (!line) return { cart, toast: null, blocked: false };
  if (line.qty + delta <= 0) {
    const next = { ...cart };
    delete next[lineKey];
    return { cart: next, toast: null, blocked: false };
  }
  if (delta > 0) {
    const product = products.find((p) => p.id === line.productId);
    const option = product?.uomOptions.find((o) => o.unit === line.unit);
    if (product && option) {
      const stock = evaluateAddToCartStock(product, option, delta, cart);
      if (stock.block) return { cart, toast: stock.toast, blocked: true };
      return {
        cart: { ...cart, [lineKey]: { ...line, qty: line.qty + delta } },
        toast: stock.toast,
        blocked: false,
      };
    }
  }
  return { cart: { ...cart, [lineKey]: { ...line, qty: line.qty + delta } }, toast: null, blocked: false };
}

/** Result of an absolute qty set. `ok` is the boolean the hook's setLineQty returns. */
export type SetLineQtyResult = { cart: CartRecord; toast: string | null; ok: boolean };

/**
 * Set an absolute `newQty` for a line. `newQty <= 0` removes it (ok). A strict block on an
 * increase returns `ok: false` with the cart unchanged (so the numpad dialog stays open).
 */
export function applySetLineQty(
  cart: CartRecord,
  lineKey: string,
  newQty: number,
  products: PosProduct[],
): SetLineQtyResult {
  const line = cart[lineKey];
  if (!line) return { cart, toast: null, ok: false };
  if (newQty <= 0) {
    const next = { ...cart };
    delete next[lineKey];
    return { cart: next, toast: null, ok: true };
  }
  if (newQty === line.qty) return { cart, toast: null, ok: true };
  const delta = newQty - line.qty;
  if (delta > 0) {
    const product = products.find((p) => p.id === line.productId);
    const option = product?.uomOptions.find((o) => o.unit === line.unit);
    if (product && option) {
      const stock = evaluateAddToCartStock(product, option, delta, cart);
      if (stock.block) return { cart, toast: stock.toast, ok: false };
      return { cart: { ...cart, [lineKey]: { ...line, qty: newQty } }, toast: stock.toast, ok: true };
    }
  }
  return { cart: { ...cart, [lineKey]: { ...line, qty: newQty } }, toast: null, ok: true };
}
