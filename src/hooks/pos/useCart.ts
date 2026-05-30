import { useCallback, useMemo, useState } from 'react';
import type { PaymentReceiptLine } from '../../components/PaymentModal';
import type { PosCustomerPick } from '../../components/customers/CustomerPickerModal';
import {
  calcCartTotals,
  cartLineKey,
  getLineTotal,
  validateAddToCartStock,
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

export type UseCartArgs = {
  products: PosProduct[];
  customer: PosCustomer | null;
  showToast: (msg: string) => void;
};

/**
 * Owns the POS cart: line items, bill-level discount, and fee — plus the
 * derived totals/receipt lines. Tier re-pricing is derived on read (no effect),
 * so the cart always reflects the active customer without cascading renders.
 */
export function useCart({ products, customer, showToast }: UseCartArgs) {
  const [rawCart, setRawCart] = useState<Record<string, CartLine>>({});
  const [billDiscValue, setBillDiscValue] = useState(0);
  const [billDiscPercent, setBillDiscPercent] = useState(false);
  const [feeRate, setFeeRate] = useState(0);

  // The stored cart holds raw lines; the priced view is derived for the active
  // customer/products. This replaces the previous reprice-in-useEffect.
  const cart = useMemo(
    () => repriceCartLines(rawCart, products, customer),
    [rawCart, products, customer],
  );

  const cartLines = useMemo(() => Object.values(cart), [cart]);

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

  const addToCart = useCallback(
    (product: PosProduct, option: UomOption) => {
      const stockErr = validateAddToCartStock(product, option, 1, rawCart);
      if (stockErr) {
        showToast(stockErr);
        return;
      }
      const key = cartLineKey(product.id, option.unit);
      const { unitPrice, originalPrice } = getActivePriceForCustomer(product, option, customer);
      setRawCart((prev) => {
        const existing = prev[key];
        if (existing) {
          return {
            ...prev,
            [key]: { ...existing, qty: existing.qty + 1 },
          };
        }
        return {
          ...prev,
          [key]: {
            lineKey: key,
            productId: product.id,
            productName: product.name,
            category: product.category,
            sku: product.sku,
            unit: option.unit,
            unitFactor: option.factor,
            unitPrice,
            originalPrice,
            qty: 1,
            discount: { type: 'none', val: 0 },
          },
        };
      });
    },
    [customer, rawCart, showToast],
  );

  const changeQty = useCallback(
    (lineKey: string, delta: number) => {
      setRawCart((prev) => {
        const line = prev[lineKey];
        if (!line) return prev;
        const qty = line.qty + delta;
        if (qty <= 0) {
          const next = { ...prev };
          delete next[lineKey];
          return next;
        }
        if (delta > 0) {
          const product = products.find((p) => p.id === line.productId);
          const option = product?.uomOptions.find((o) => o.unit === line.unit);
          if (product && option) {
            const stockErr = validateAddToCartStock(product, option, delta, prev);
            if (stockErr) {
              showToast(stockErr);
              return prev;
            }
          }
        }
        return { ...prev, [lineKey]: { ...line, qty } };
      });
    },
    [products, showToast],
  );

  const removeLine = useCallback((lineKey: string) => {
    setRawCart((prev) => {
      const next = { ...prev };
      delete next[lineKey];
      return next;
    });
  }, []);

  const setLineQty = useCallback(
    (lineKey: string, newQty: number): boolean => {
      const line = rawCart[lineKey];
      if (!line) return false;
      if (newQty <= 0) {
        removeLine(lineKey);
        return true;
      }
      if (newQty === line.qty) return true;
      const delta = newQty - line.qty;
      if (delta > 0) {
        const product = products.find((p) => p.id === line.productId);
        const option = product?.uomOptions.find((o) => o.unit === line.unit);
        if (product && option) {
          const stockErr = validateAddToCartStock(product, option, delta, rawCart);
          if (stockErr) {
            showToast(stockErr);
            return false;
          }
        }
      }
      setRawCart((prev) => {
        const current = prev[lineKey];
        if (!current) return prev;
        return { ...prev, [lineKey]: { ...current, qty: newQty } };
      });
      return true;
    },
    [rawCart, products, removeLine, showToast],
  );

  const setLineDiscount = useCallback(
    (lineKey: string, type: ItemDiscountType, val: number) => {
      setRawCart((prev) => {
        const line = prev[lineKey];
        if (!line) return prev;
        return { ...prev, [lineKey]: { ...line, discount: { type, val } } };
      });
    },
    [],
  );

  const clearCart = useCallback(() => {
    setRawCart({});
    setBillDiscValue(0);
    setBillDiscPercent(false);
    setFeeRate(0);
  }, []);

  const restoreCart = useCallback((bill: SuspendedBill) => {
    setRawCart(cartLinesToRecord(bill.cartItems));
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
