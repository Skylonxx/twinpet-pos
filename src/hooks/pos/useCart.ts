import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PaymentReceiptLine } from '../../components/PaymentModal';
import type { PosCustomerPick } from '../../components/customers/CustomerPickerModal';
import {
  applyAddToCart,
  applyChangeQty,
  applySetLineQty,
  calcCartTotals,
  cartLineKey,
  getLineTotal,
} from '../../lib/pos/cartUtils';
import { cartLinesToRecord, type SuspendedBill } from '../../lib/pos/suspendedBills';
import { resolvePosUnitPrice } from '../../lib/pos/tierPricing';
import type {
  CartLine,
  ItemDiscountType,
  PosProduct,
  UomOption,
} from '../../lib/pos/types';

export type PosCustomer = PosCustomerPick;

/** Resolve the active unit/original price for a product+UOM given the customer tier. */
export function getActivePriceForCustomer(
  product: PosProduct,
  option: UomOption,
  customer: PosCustomer | null,
): { unitPrice: number; originalPrice: number } {
  const tier = customer?.customerType?.trim() || null;
  return resolvePosUnitPrice(product, option, tier);
}

function priceChanged(a: number, b: number): boolean {
  return Math.round(a * 100) !== Math.round(b * 100);
}

/** Re-price every cart line for the current customer/products (pure, identity-stable). */
function repriceCartLines(
  cart: Record<string, CartLine>,
  products: PosProduct[],
  customer: PosCustomer | null,
): Record<string, CartLine> {
  if (Object.keys(cart).length === 0) return cart;
  let changed = false;
  const next = { ...cart };
  for (const [key, line] of Object.entries(cart)) {
    const product = products.find((p) => p.id === line.productId);
    if (!product) continue;
    const option = product.uomOptions.find((o) => o.unit === line.unit);
    if (!option) continue;
    const { unitPrice, originalPrice } = getActivePriceForCustomer(product, option, customer);
    if (priceChanged(line.unitPrice, unitPrice) || priceChanged(line.originalPrice ?? 0, originalPrice)) {
      next[key] = { ...line, unitPrice, originalPrice };
      changed = true;
    }
  }
  return changed ? next : cart;
}

export type ToastPayload = string | { title: string; description?: string; variant?: 'default' | 'destructive' | 'warning' | 'success' };

export type UseCartArgs = {
  products: PosProduct[];
  customer: PosCustomer | null;
  showToast: (payload: ToastPayload) => void;
};

/** Product context used to compose the structured toast description (UI-13). */
type StockToastContext = { name: string; stock: number; unit: string } | null;

/** Resolve the toast context for a cart line (used by changeQty / setLineQty). */
function resolveStockToastContext(
  lineKey: string,
  cart: Record<string, CartLine>,
  products: PosProduct[],
): StockToastContext {
  const line = cart[lineKey];
  if (!line) return null;
  const product = products.find((p) => p.id === line.productId);
  if (!product) return null;
  return { name: product.name, stock: product.stock, unit: product.baseUnit };
}

// UI-13: build the structured, multi-line description shared by Strict Block (red) and
// Warning Pass (yellow). Both variants use the SAME line order/hierarchy — product name on
// line 1, the remaining-stock line (prefixed `คงเหลือ:` so toast.tsx can render it visually
// distinct) on line 2 — and ONLY the strict block appends the third explanatory line. The
// description is a `\n`-joined string because the toast store types `description` as a string
// (use-toast.ts is out of scope); toast.tsx splits the lines for the typography hierarchy.
function buildStockDescription(ctx: StockToastContext, includeDetail: boolean): string | undefined {
  const lines: string[] = [];
  if (ctx) {
    lines.push(ctx.name);
    lines.push(ctx.unit ? `คงเหลือ: ${ctx.stock} ${ctx.unit}` : `คงเหลือ: ${ctx.stock}`);
  }
  if (includeDetail) lines.push('ไม่สามารถเพิ่มสินค้าเกินจำนวนสต็อกที่มีอยู่ได้');
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function dispatchStockToast(
  msg: string,
  ctx: StockToastContext,
  showToast: (payload: ToastPayload) => void,
) {
  // Variant still derives from the matrix glyph prefix cartUtils emits (🚫 strict / ⚠️ warn);
  // the glyph itself never reaches the UI — the Toast renders its own SVG icon. UI-13 uses
  // short static titles and moves the dynamic product/stock detail into the description.
  if (msg.startsWith('🚫')) {
    showToast({ title: 'สต็อกไม่พอ!', description: buildStockDescription(ctx, true), variant: 'destructive' });
  } else if (msg.startsWith('⚠️')) {
    showToast({ title: 'สินค้าเกินสต็อก', description: buildStockDescription(ctx, false), variant: 'warning' });
  } else {
    showToast({ title: msg });
  }
}

/**
 * Owns the POS cart: line items, bill-level discount, and fee — plus the
 * derived totals/receipt lines.
 *
 * Price freezing: a cart line snapshots its price (`unitPrice`/`originalPrice`)
 * and name (`productName`) at add-time. Live Firestore product edits update the
 * grid but must NEVER mutate an active cart line. The cart is therefore the raw
 * stored lines verbatim — there is no live re-derivation on read. The one
 * sanctioned reprice is an explicit customer/tier change (effect below), which
 * is a deliberate cashier action, not a backend snapshot update.
 */
export function useCart({ products, customer, showToast }: UseCartArgs) {
  const [rawCart, setRawCart] = useState<Record<string, CartLine>>({});
  const [billDiscValue, setBillDiscValue] = useState(0);
  const [billDiscPercent, setBillDiscPercent] = useState(false);
  const [feeRate, setFeeRate] = useState(0);

  // Reprice the whole cart when — and only when — the customer's pricing tier
  // changes. The effect also re-runs on a `products` change, but the tier guard
  // early-returns in that case: a Firestore product/price edit therefore leaves
  // active lines frozen, while a wholesale/tier customer swap re-rates them
  // against the current products.
  const activeTier = customer?.customerType?.trim() || null;
  const pricedTierRef = useRef(activeTier);
  useEffect(() => {
    if (pricedTierRef.current === activeTier) return;
    pricedTierRef.current = activeTier;
    setRawCart((prev) => repriceCartLines(prev, products, customer));
  }, [activeTier, customer, products]);

  // The cart is the frozen lines as stored — no per-render reprice from live
  // products. (Tier changes mutate `rawCart` via the effect above.)
  const cart = rawCart;
  const cartLines = useMemo(() => Object.values(cart), [cart]);

  // Phase 7C-POS-Stock-Matrix (same-tick correctness): every mutation validates AND writes
  // against the LATEST committed cart through this ref — never the render-time `rawCart`
  // closure. Two same-tick increases would otherwise both read stale state and could jointly
  // cross a strict-block boundary (Codex blocker). `commit` updates the ref synchronously with
  // the state set; this effect re-syncs the ref for any other writer (reprice / clear / restore).
  const cartRef = useRef<Record<string, CartLine>>(rawCart);
  useEffect(() => {
    cartRef.current = rawCart;
  }, [rawCart]);
  const commit = useCallback((next: Record<string, CartLine>) => {
    cartRef.current = next;
    setRawCart(next);
  }, []);

  // Phase 7C-L2 (money correctness): bill-level state — discount value, discount MODE, and
  // fee — must never outlive the cart. `clearCart` wipes all three, but the item-removal paths
  // (removeLine / changeQty→0 / setLineQty→0) only delete lines, so a lingering discount/mode/
  // fee could silently apply to the NEXT customer's sale. The shared `resetBillLevel` helper is
  // the single source of truth for that cleanup — used by BOTH the empty-cart effect below and
  // `clearCart`, so they can never drift apart. The effect resets centrally whenever the cart
  // becomes empty (one place; no per-handler resets); its guard fires only when some bill-level
  // field is actually non-default, so it never loops or disturbs a fresh, already-empty cart.
  const resetBillLevel = useCallback(() => {
    setBillDiscValue(0);
    setBillDiscPercent(false);
    setFeeRate(0);
  }, []);

  useEffect(() => {
    if (cartLines.length === 0 && (billDiscValue !== 0 || billDiscPercent || feeRate !== 0)) {
      resetBillLevel();
    }
  }, [cartLines.length, billDiscValue, billDiscPercent, feeRate, resetBillLevel]);

  const totals = useMemo(
    () => calcCartTotals(cartLines, billDiscValue, billDiscPercent, feeRate),
    [cartLines, billDiscValue, billDiscPercent, feeRate],
  );

  const receiptLines = useMemo<PaymentReceiptLine[]>(
    () =>
      cartLines.map((line) => ({
        productName: line.productName,
        sku: line.sku,
        qty: line.qty,
        unit: line.unit,
        lineTotal: getLineTotal(line),
      })),
    [cartLines],
  );

  const cartQtyByProduct = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of cartLines) {
      map.set(line.productId, (map.get(line.productId) ?? 0) + line.qty);
    }
    return map;
  }, [cartLines]);

  // Build a fresh, price-frozen cart line for a product+UOM (only used for a NEW line).
  const buildCartLine = useCallback(
    (product: PosProduct, option: UomOption): CartLine => {
      const { unitPrice, originalPrice } = getActivePriceForCustomer(product, option, customer);
      return {
        lineKey: cartLineKey(product.id, option.unit),
        productId: product.id,
        productName: product.name,
        category: product.category,
        sku: product.sku,
        barcode: option.barcode ?? null,
        unit: option.unit,
        unitFactor: option.factor,
        unitPrice,
        originalPrice,
        qty: 1,
        discount: { type: 'none', val: 0 },
      };
    },
    [customer],
  );

  const addToCart = useCallback(
    (product: PosProduct, option: UomOption) => {
      // 3-Tier Stock Matrix, evaluated against the LATEST cart (cartRef): surface the toast
      // (Tier 1 red / Tier 2 yellow) and, on a Tier 1 strict block, do NOT apply the add.
      const result = applyAddToCart(cartRef.current, product, option, () =>
        buildCartLine(product, option),
      );
      if (result.toast) dispatchStockToast(result.toast, { name: product.name, stock: product.stock, unit: product.baseUnit }, showToast);
      if (result.blocked) return;
      commit(result.cart);
    },
    [buildCartLine, commit, showToast],
  );

  const changeQty = useCallback(
    (lineKey: string, delta: number) => {
      // Increase routes through the matrix vs. the LATEST cart; decrement/zero-out is never
      // blocked. cartRef makes repeated same-tick increases see each other (no stale bypass).
      const result = applyChangeQty(cartRef.current, lineKey, delta, products);
      if (result.toast) dispatchStockToast(result.toast, resolveStockToastContext(lineKey, cartRef.current, products), showToast);
      if (result.blocked) return;
      commit(result.cart);
    },
    [commit, products, showToast],
  );

  const removeLine = useCallback((lineKey: string) => {
    const next = { ...cartRef.current };
    delete next[lineKey];
    cartRef.current = next;
    setRawCart(next);
  }, []);

  const setLineQty = useCallback(
    (lineKey: string, newQty: number): boolean => {
      // On a Tier 1 strict block this returns false WITHOUT applying, so the numpad dialog stays
      // open for cashier correction. Removal / no-op / warn / silent all apply and return true.
      const result = applySetLineQty(cartRef.current, lineKey, newQty, products);
      if (result.toast) dispatchStockToast(result.toast, resolveStockToastContext(lineKey, cartRef.current, products), showToast);
      if (result.ok) commit(result.cart);
      return result.ok;
    },
    [commit, products, showToast],
  );

  const setLineDiscount = useCallback(
    (lineKey: string, type: ItemDiscountType, val: number) => {
      const line = cartRef.current[lineKey];
      if (!line) return;
      commit({ ...cartRef.current, [lineKey]: { ...line, discount: { type, val } } });
    },
    [commit],
  );

  const clearCart = useCallback(() => {
    cartRef.current = {};
    setRawCart({});
    resetBillLevel();
  }, [resetBillLevel]);

  const restoreCart = useCallback((bill: SuspendedBill) => {
    const restored = cartLinesToRecord(bill.cartItems);
    cartRef.current = restored;
    setRawCart(restored);
    setBillDiscValue(bill.discount);
    setBillDiscPercent(bill.discountPercent);
    setFeeRate(bill.feeRate);
  }, []);

  return {
    cart,
    cartLines,
    totals,
    receiptLines,
    cartQtyByProduct,
    billDiscValue,
    setBillDiscValue,
    billDiscPercent,
    setBillDiscPercent,
    feeRate,
    setFeeRate,
    addToCart,
    changeQty,
    removeLine,
    setLineQty,
    setLineDiscount,
    clearCart,
    restoreCart,
  };
}
