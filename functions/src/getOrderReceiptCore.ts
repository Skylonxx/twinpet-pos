import { roundMoney } from './fifo';

export const AUTHORITY_NUMERIC_FIELDS = [
  'unitFactor',
  'qty',
  'qtyBase',
  'unitPrice',
  'originalPrice',
  'item.discountAmt',
  'lineTotal',
  'payment.amount',
  'subtotal',
  'order.discountAmt',
  'billDiscount',
  'surcharge',
  'total',
  'paidAmt',
  'changeAmt',
  'creditAmt',
] as const;

export const AUTHORITY_NON_NUMERIC_PAYMENT_FIELDS = ['payment.method', 'payment.ref'] as const;

export const VOID_ANOMALY_LITERALS = ['missing_canonical', 'canonical_ineligible'] as const;
export const VOID_REVISION_FAULT_LITERALS = ['revision_malformed', 'revision_overflow'] as const;

const PAYMENT_METHODS = ['cash', 'qr', 'kbank', 'card', 'credit'] as const;

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonNeg = (v: unknown): v is number => isFiniteNum(v) && v >= 0;
const isPos = (v: unknown): v is number => isFiniteNum(v) && v > 0;

export const isCentNormalized = (v: number): boolean => isFiniteNum(v) && roundMoney(v) === v;

function toSatang(v: number): { ok: true; k: number } | { ok: false; reason: 'satang_overflow' } {
  const k = Math.round(v * 100);
  if (!Number.isSafeInteger(k)) return { ok: false, reason: 'satang_overflow' };
  return { ok: true, k };
}

export function sumSatang(amounts: number[]): bigint {
  return amounts.reduce((acc, a) => {
    const s = toSatang(a);
    if (!s.ok) throw new Error('satang_overflow');
    return acc + BigInt(s.k);
  }, 0n);
}

export function toSatangOrUnproven(v: number): { ok: true; k: number } | { ok: false; reason: string } {
  if (!isCentNormalized(v)) return { ok: false, reason: 'payment_amount_not_cent_normalized' };
  const s = toSatang(v);
  if (!s.ok) return { ok: false, reason: 'satang_overflow' };
  return s;
}

export type ReceiptCoreAuthority = 'AUTHORITATIVE' | 'UNPROVEN' | 'REFUSED';

export type ReceiptCoreResult = {
  authority: ReceiptCoreAuthority;
  reason: string;
  order: Record<string, unknown> | null;
  items: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  projectionCompleteness: 'PROVEN' | 'UNPROVEN';
  displayAmount?: number;
};

export type ReceiptSnapshots = {
  order: Record<string, unknown> | null;
  orderExists: boolean;
  items: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  asyncOrder: Record<string, unknown> | null;
  asyncExists: boolean;
};

function isValidProductSnap(v: unknown): boolean {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof (v as { name?: unknown }).name === 'string' &&
    typeof (v as { sku?: unknown }).sku === 'string' &&
    typeof (v as { category?: unknown }).category === 'string' &&
    ((v as { barcode?: unknown }).barcode === undefined ||
      (v as { barcode?: unknown }).barcode === null ||
      typeof (v as { barcode?: unknown }).barcode === 'string')
  );
}

function normalizeBarcode(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : null;
}

/** Collision-safe injective encoding. Distinct tuples cannot share a key. */
export function encodeReceiptTuple(parts: readonly unknown[]): string {
  return JSON.stringify(parts.map((p) => (p === undefined ? null : p)));
}

function productSnapKey(snap: Record<string, unknown>): string {
  return encodeReceiptTuple([snap.name, snap.sku, snap.category, normalizeBarcode(snap.barcode)]);
}

function unproven(reason: string, snaps: ReceiptSnapshots, completeness: 'PROVEN' | 'UNPROVEN' = 'UNPROVEN'): ReceiptCoreResult {
  return {
    authority: 'UNPROVEN',
    reason,
    order: snaps.order,
    items: snaps.items,
    payments: snaps.payments,
    projectionCompleteness: completeness,
    displayAmount: typeof snaps.payments[0]?.amount === 'number' ? (snaps.payments[0].amount as number) : undefined,
  };
}

function refused(reason: string, snaps: ReceiptSnapshots): ReceiptCoreResult {
  return {
    authority: 'REFUSED',
    reason,
    order: snaps.order,
    items: snaps.items,
    payments: snaps.payments,
    projectionCompleteness: 'UNPROVEN',
  };
}

function headerCentFields(order: Record<string, unknown>): Array<[string, unknown]> {
  return [
    ['subtotal', order.subtotal],
    ['discountAmt', order.discountAmt],
    ['billDiscount', order.billDiscount],
    ['surcharge', order.surcharge],
    ['total', order.total],
    ['paidAmt', order.paidAmt],
    ['changeAmt', order.changeAmt],
    ['creditAmt', order.creditAmt],
  ];
}

function validateItemDomain(item: Record<string, unknown>): string | null {
  if (!isPos(item.unitFactor)) {
    if (!isFiniteNum(item.unitFactor)) return 'unitfactor_nonfinite';
    return 'unitfactor_nonpositive_invariant';
  }
  if (!isPos(item.qty)) return 'qty_nonpositive';
  if (!isPos(item.qtyBase)) return 'qtybase_nonpositive';
  if (!isNonNeg(item.unitPrice)) return 'unitprice_negative';
  const original = 'originalPrice' in item ? item.originalPrice : item.unitPrice;
  if (!isNonNeg(original)) return 'originalprice_negative';
  if (!isFiniteNum(item.discountAmt)) return 'item_discount_nonfinite';
  if (!isNonNeg(item.lineTotal)) return 'linetotal_negative';
  if (isFiniteNum(item.lineTotal) && !isCentNormalized(item.lineTotal)) return 'item_not_cent_normalized';
  if (isFiniteNum(item.discountAmt) && !isCentNormalized(item.discountAmt)) return 'item_not_cent_normalized';
  return null;
}

function validateOrderDomain(order: Record<string, unknown>): string | null {
  if (!isNonNeg(order.subtotal)) return 'subtotal_negative';
  if (!isFiniteNum(order.discountAmt)) return 'order_discount_nonfinite';
  if (!isFiniteNum(order.billDiscount)) return 'billdiscount_nonfinite';
  if (isFiniteNum(order.billDiscount) && order.billDiscount < 0) return 'billdiscount_negative_invariant';
  if (!isNonNeg(order.surcharge)) return 'surcharge_negative';
  if (!isNonNeg(order.total)) return 'total_negative';
  if (!isNonNeg(order.paidAmt)) return 'paidamt_negative';
  if (!isNonNeg(order.changeAmt)) return 'changeamt_negative';
  if (!isNonNeg(order.creditAmt)) return 'creditamt_negative';
  for (const [name, v] of headerCentFields(order)) {
    if (isFiniteNum(v) && !isCentNormalized(v)) return `${name}_not_cent_normalized`;
  }
  return null;
}

function paymentMultiset(payments: Record<string, unknown>[]): string[] {
  return payments.map((p) => encodeReceiptTuple([p.method, p.amount, p.ref ?? null])).sort();
}

function itemMultiset(items: Record<string, unknown>[]): string[] {
  return items
    .map((it) => {
      const snap = it.productSnap as Record<string, unknown> | undefined;
      const key = snap && isValidProductSnap(snap) ? productSnapKey(snap) : 'invalid';
      return encodeReceiptTuple([
        key,
        it.unit,
        it.unitFactor,
        it.qty,
        it.qtyBase,
        it.unitPrice,
        it.originalPrice ?? it.unitPrice,
        it.discountAmt,
        it.lineTotal,
      ]);
    })
    .sort();
}

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function evaluateReceiptCore(snaps: ReceiptSnapshots): ReceiptCoreResult {
  if (!snaps.orderExists || snaps.order == null) {
    return refused('order_missing', snaps);
  }
  const order = snaps.order;
  if (order.status === 'voided') return refused('order_voided', snaps);
  if (snaps.asyncExists && snaps.asyncOrder) {
    if (snaps.asyncOrder.voidRequested === true && snaps.asyncOrder.voidReconciled !== true) {
      return refused('void_intent_unreconciled', snaps);
    }
    if ('voidAnomaly' in snaps.asyncOrder && snaps.asyncOrder.voidAnomaly != null) {
      return refused('void_anomaly', snaps);
    }
  }
  if (!snaps.asyncExists) {
    return unproven('async_absent_unproven_forever', snaps, 'UNPROVEN');
  }

  const rev = order.historyRev;
  if (Object.prototype.hasOwnProperty.call(order, 'historyRev')) {
    if (typeof rev !== 'number' || !Number.isFinite(rev) || !Number.isInteger(rev) || rev < 1 || rev > Number.MAX_SAFE_INTEGER) {
      return unproven('revision_malformed', snaps);
    }
  }

  const sourceLines = Array.isArray(snaps.asyncOrder?.lines) ? (snaps.asyncOrder!.lines as Record<string, unknown>[]) : [];
  const sourcePays = Array.isArray(snaps.asyncOrder?.payments) ? (snaps.asyncOrder!.payments as Record<string, unknown>[]) : [];

  if (snaps.items.length !== sourceLines.length) {
    return unproven('projection_cardinality', snaps);
  }
  if (snaps.payments.length !== sourcePays.filter((p) => isPos(p.amount)).length && snaps.payments.length !== sourcePays.length) {
    if (snaps.payments.length !== sourcePays.length) {
      return unproven('projection_cardinality', snaps);
    }
  }

  for (const item of snaps.items) {
    if (!isValidProductSnap(item.productSnap)) {
      if (item.productSnap == null) return unproven('productsnap_null', snaps);
      if (typeof item.productSnap !== 'object') return unproven('productsnap_non_object', snaps);
      return unproven('productsnap_invalid', snaps);
    }
    const domain = validateItemDomain(item);
    if (domain) return unproven(domain, snaps);
  }
  const orderDomain = validateOrderDomain(order);
  if (orderDomain) return unproven(orderDomain, snaps);

  if (!sameMultiset(itemMultiset(snaps.items), itemMultiset(sourceLines.map((l) => ({ ...l, productSnap: l.productSnap }))))) {
    return unproven('projection_item_mismatch', snaps);
  }

  for (const pay of snaps.payments) {
    if (!isFiniteNum(pay.amount)) return unproven('payment_amount_nonfinite', snaps);
    if (pay.amount <= 0) return unproven('payment_amount_nonpositive', snaps);
    if (!PAYMENT_METHODS.includes(pay.method as (typeof PAYMENT_METHODS)[number])) {
      return unproven('payment_method_invalid', snaps);
    }
    if (!('ref' in pay) || !(typeof pay.ref === 'string' || pay.ref === null)) {
      return unproven('payment_ref_invalid', snaps);
    }
    if (!isCentNormalized(pay.amount)) {
      return {
        ...unproven('payment_amount_not_cent_normalized', snaps),
        displayAmount: pay.amount,
      };
    }
    const satang = toSatangOrUnproven(pay.amount);
    if (!satang.ok) return unproven(satang.reason, snaps);
  }

  if (!sameMultiset(paymentMultiset(snaps.payments), paymentMultiset(sourcePays))) {
    return unproven('projection_payment_mismatch', snaps);
  }

  try {
    const payAmounts = snaps.payments.map((p) => p.amount as number);
    const paidFold = sumSatang(payAmounts);
    const paidHeader = toSatangOrUnproven(order.paidAmt as number);
    if (!paidHeader.ok) return unproven(paidHeader.reason, snaps);
    if (paidFold !== BigInt(paidHeader.k)) return unproven('p2_mismatch', snaps);

    const creditAmounts = snaps.payments.filter((p) => p.method === 'credit').map((p) => p.amount as number);
    const creditFold = sumSatang(creditAmounts);
    const creditHeader = toSatangOrUnproven(order.creditAmt as number);
    if (!creditHeader.ok) return unproven(creditHeader.reason, snaps);
    if (creditFold !== BigInt(creditHeader.k)) return unproven('p3_mismatch', snaps);
  } catch {
    return unproven('satang_overflow', snaps);
  }

  const expectedChange = roundMoney(Math.max(0, (order.paidAmt as number) - (order.total as number)));
  if ((order.changeAmt as number) !== expectedChange) return unproven('p4_mismatch', snaps);

  const pendingPred = (order.creditAmt as number) > 0 && (order.paidAmt as number) < (order.total as number);
  if (order.status === 'pending_payment' && !pendingPred) return unproven('p5_mismatch', snaps);
  if (order.status === 'completed' && pendingPred) return unproven('p5_mismatch', snaps);
  if (order.status !== 'completed' && order.status !== 'pending_payment' && order.status !== 'voided') {
    return unproven('p5_status_unknown', snaps);
  }

  if ((order.changeAmt as number) > 0 && !((order.paidAmt as number) > (order.total as number))) {
    return unproven('p6_mismatch', snaps);
  }

  const sourceNonPositive = sourcePays.some((p) => isFiniteNum(p.amount) && p.amount <= 0);
  if (sourceNonPositive) return unproven('source_nonpositive_payment', snaps);

  return {
    authority: 'AUTHORITATIVE',
    reason: 'all_conjuncts',
    order,
    items: snaps.items,
    payments: snaps.payments,
    projectionCompleteness: 'PROVEN',
  };
}

export { roundMoney };
