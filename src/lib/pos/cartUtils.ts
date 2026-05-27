import type { CartLine, CartTotals, ItemDiscountType, PosProduct, UomOption } from './types';

export function cartLineKey(productId: string, unit: string): string {
  return `${productId}::${unit}`;
}

export function getLineTotal(line: CartLine): number {
  const base = line.unitPrice * line.qty;
  const { type, val } = line.discount;
  if (type === 'disc_thb') return Math.max(0, base - val);
  if (type === 'disc_pct') return Math.max(0, base * (1 - val / 100));
  if (type === 'override') return Math.max(0, val * line.qty);
  return base;
}

export function calcCartTotals(
  lines: CartLine[],
  billDiscountValue: number,
  billDiscountIsPercent: boolean,
  feeRatePercent: number,
): CartTotals {
  const subtotal = lines.reduce((sum, line) => sum + getLineTotal(line), 0);
  const billDiscount = billDiscountIsPercent
    ? subtotal * (billDiscountValue / 100)
    : Math.min(billDiscountValue, subtotal);
  const afterDiscount = Math.max(0, subtotal - billDiscount);
  const fee = afterDiscount * (feeRatePercent / 100);
  const grandTotal = afterDiscount + fee;
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

export function formatMoney(n: number): string {
  return parseFloat(String(n || 0)).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export const IDP_LABELS: Record<Exclude<ItemDiscountType, 'none'>, string> = {
  disc_thb: 'ส่วนลด (฿)',
  disc_pct: 'ส่วนลด (%)',
  override: 'ราคาขายใหม่ (ต่อหน่วย)',
};

function baseQtyNeededByProduct(lines: CartLine[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of lines) {
    map.set(line.productId, (map.get(line.productId) ?? 0) + line.qty * line.unitFactor);
  }
  return map;
}

export function validateCartStock(
  products: PosProduct[],
  lines: CartLine[],
): string | null {
  const needed = baseQtyNeededByProduct(lines);
  for (const [productId, qtyBase] of needed) {
    const product = products.find((p) => p.id === productId);
    if (!product) continue;
    if (product.allowNegativeStock) continue;
    if (product.stock <= 0) {
      return `สต็อกหมด: ${product.name}`;
    }
    if (qtyBase > product.stock) {
      return `สต็อกไม่พอ: ${product.name} (เหลือ ${product.stock} ${product.baseUnit})`;
    }
  }
  return null;
}

export function validateAddToCartStock(
  product: PosProduct,
  option: UomOption,
  addQty: number,
  cart: Record<string, CartLine>,
): string | null {
  if (addQty <= 0) return null;
  const key = cartLineKey(product.id, option.unit);
  const existing = cart[key];
  const newQty = (existing?.qty ?? 0) + addQty;
  const neededBase = newQty * option.factor;

  if (!product.allowNegativeStock) {
    if (product.stock <= 0) {
      return `สต็อกหมด: ${product.name}`;
    }
    if (neededBase > product.stock) {
      return `สต็อกไม่พอ: ${product.name} (เหลือ ${product.stock} ${product.baseUnit})`;
    }
  }

  return null;
}
