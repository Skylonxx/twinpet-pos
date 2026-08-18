/**
 * Shared pre-coercion validator for canonical sale writers (reconciler + sweeper).
 * No Number() / parseFloat / unary + / ?? default / || default.
 * Invalid source must not fabricate canonical orders / orderItems / payments.
 */

export type CanonicalSourceReason =
  | 'missing'
  | 'not_finite'
  | 'not_array'
  | 'empty'
  | 'invalid_status'
  | 'invalid_clientCreatedAt'
  | 'invalid_line'
  | 'invalid_payment'
  | 'payments_required'
  | 'negative_bill_discount';

export type CanonicalSourceVerdict =
  | { ok: true }
  | { ok: false; field: string; reason: CanonicalSourceReason };

export const VALIDATED_FIELDS = [
  'total',
  'subtotal',
  'paidAmt',
  'discountAmt',
  'billDiscount',
  'fee',
  'changeAmt',
  'creditAmt',
  'cogs',
  'profit',
  'status',
  'clientCreatedAt',
  'lines',
  'payments',
] as const;

export const CANONICAL_PAYMENT_METHODS = ['cash', 'qr', 'kbank', 'card', 'credit'] as const;
export const CANONICAL_SOURCE_STATUSES = ['completed', 'pending_payment'] as const;

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const absent = (k: string, order: Record<string, unknown>) => !(k in order);
const reqNum = (k: string, order: Record<string, unknown>) => k in order && isFiniteNum(order[k]);
const optNum = (k: string, order: Record<string, unknown>) => absent(k, order) || isFiniteNum(order[k]);

function invalid(field: string, reason: CanonicalSourceReason): CanonicalSourceVerdict {
  return { ok: false, field, reason };
}

export type QtyBaseResolve =
  | { ok: true; qtyBase: number }
  | { ok: false; field: string; reason: CanonicalSourceReason };

/**
 * Resolve the inventory/canonical quantity before any multiplication default.
 * Explicit present qtyBase (including 0) never falls through to qty * unitFactor.
 * Absent qtyBase derives only from positive finite qty and unitFactor.
 */
export function resolveLineQtyBase(line: Record<string, unknown>, fieldPrefix: string): QtyBaseResolve {
  if (Object.prototype.hasOwnProperty.call(line, 'qtyBase')) {
    if (!isFiniteNum(line.qtyBase)) {
      return { ok: false, field: `${fieldPrefix}.qtyBase`, reason: 'not_finite' };
    }
    if (line.qtyBase <= 0) {
      return { ok: false, field: `${fieldPrefix}.qtyBase`, reason: 'invalid_line' };
    }
    return { ok: true, qtyBase: line.qtyBase };
  }
  if (!Object.prototype.hasOwnProperty.call(line, 'qty')) {
    return { ok: false, field: `${fieldPrefix}.qty`, reason: 'missing' };
  }
  if (!isFiniteNum(line.qty)) {
    return { ok: false, field: `${fieldPrefix}.qty`, reason: 'not_finite' };
  }
  if (line.qty <= 0) {
    return { ok: false, field: `${fieldPrefix}.qty`, reason: 'invalid_line' };
  }
  if (!Object.prototype.hasOwnProperty.call(line, 'unitFactor')) {
    return { ok: false, field: `${fieldPrefix}.unitFactor`, reason: 'missing' };
  }
  if (!isFiniteNum(line.unitFactor)) {
    return { ok: false, field: `${fieldPrefix}.unitFactor`, reason: 'not_finite' };
  }
  if (line.unitFactor <= 0) {
    return { ok: false, field: `${fieldPrefix}.unitFactor`, reason: 'invalid_line' };
  }
  const product = line.qty * line.unitFactor;
  if (!Number.isFinite(product) || product <= 0) {
    return { ok: false, field: `${fieldPrefix}.qtyBase`, reason: 'invalid_line' };
  }
  return { ok: true, qtyBase: product };
}

export function requireEffectiveQtyBases(order: Record<string, unknown>): number[] {
  const verdict = validateCanonicalSaleSource(order);
  if (!verdict.ok) {
    throw new CanonicalSourceInvalidError(verdict.field, verdict.reason);
  }
  const lines = order.lines as unknown[];
  return lines.map((line, index) => {
    const rec = line as Record<string, unknown>;
    const resolved = resolveLineQtyBase(rec, `lines[${index}]`);
    if (!resolved.ok) {
      throw new CanonicalSourceInvalidError(resolved.field, resolved.reason);
    }
    return resolved.qtyBase;
  });
}

function validateLine(line: unknown, index: number): CanonicalSourceVerdict {
  const field = `lines[${index}]`;
  if (line === null || typeof line !== 'object' || Array.isArray(line)) {
    return invalid(field, 'invalid_line');
  }
  const rec = line as Record<string, unknown>;
  const qty = resolveLineQtyBase(rec, field);
  if (!qty.ok) return invalid(qty.field, qty.reason);
  if ('originalPrice' in rec) {
    if (!isFiniteNum(rec.originalPrice)) return invalid(`${field}.originalPrice`, 'not_finite');
  } else if (!reqNum('unitPrice', rec)) {
    return invalid(`${field}.originalPrice`, 'missing');
  }
  if ('fifoCost' in rec && !isFiniteNum(rec.fifoCost)) {
    return invalid(`${field}.fifoCost`, 'not_finite');
  }
  if ('lotRefs' in rec && !Array.isArray(rec.lotRefs)) {
    return invalid(`${field}.lotRefs`, 'not_array');
  }
  return { ok: true };
}

function validatePayment(pay: unknown, index: number): CanonicalSourceVerdict {
  const field = `payments[${index}]`;
  if (pay === null || typeof pay !== 'object' || Array.isArray(pay)) {
    return invalid(field, 'invalid_payment');
  }
  const rec = pay as Record<string, unknown>;
  if (!isFiniteNum(rec.amount)) return invalid(`${field}.amount`, 'not_finite');
  if (typeof rec.method !== 'string' || !CANONICAL_PAYMENT_METHODS.includes(rec.method as (typeof CANONICAL_PAYMENT_METHODS)[number])) {
    return invalid(`${field}.method`, 'invalid_payment');
  }
  if ('ref' in rec) {
    const ref = rec.ref;
    if (!(typeof ref === 'string' || ref === null)) return invalid(`${field}.ref`, 'invalid_payment');
  }
  return { ok: true };
}

export function validateCanonicalSaleSource(order: Record<string, unknown>): CanonicalSourceVerdict {
  for (const k of ['total', 'subtotal', 'paidAmt'] as const) {
    if (!(k in order)) return invalid(k, 'missing');
    if (!isFiniteNum(order[k])) return invalid(k, 'not_finite');
  }

  for (const k of ['discountAmt', 'billDiscount', 'fee', 'changeAmt', 'creditAmt', 'cogs', 'profit'] as const) {
    if (!optNum(k, order)) return invalid(k, 'not_finite');
  }

  if ('billDiscount' in order && isFiniteNum(order.billDiscount) && order.billDiscount < 0) {
    return invalid('billDiscount', 'negative_bill_discount');
  }

  if (!('status' in order) || typeof order.status !== 'string') {
    return invalid('status', 'invalid_status');
  }
  if (!CANONICAL_SOURCE_STATUSES.includes(order.status as (typeof CANONICAL_SOURCE_STATUSES)[number])) {
    return invalid('status', 'invalid_status');
  }

  if (!isFiniteNum(order.clientCreatedAt) || order.clientCreatedAt <= 0) {
    return invalid('clientCreatedAt', 'invalid_clientCreatedAt');
  }

  if (!Array.isArray(order.lines)) return invalid('lines', 'not_array');
  if (order.lines.length === 0) return invalid('lines', 'empty');
  for (let i = 0; i < order.lines.length; i++) {
    const lineVerdict = validateLine(order.lines[i], i);
    if (!lineVerdict.ok) return lineVerdict;
  }

  const paidAmt = order.paidAmt as number;
  if (!('payments' in order)) {
    if (paidAmt !== 0) return invalid('payments', 'payments_required');
  } else if (!Array.isArray(order.payments)) {
    return invalid('payments', 'not_array');
  } else {
    if (paidAmt > 0 && order.payments.length < 1) return invalid('payments', 'payments_required');
    for (let i = 0; i < order.payments.length; i++) {
      const payVerdict = validatePayment(order.payments[i], i);
      if (!payVerdict.ok) return payVerdict;
    }
  }

  return { ok: true };
}

export class CanonicalSourceInvalidError extends Error {
  readonly field: string;
  readonly reason: CanonicalSourceReason;
  constructor(field: string, reason: CanonicalSourceReason) {
    super(`source_invalid:${field}:${reason}`);
    this.name = 'CanonicalSourceInvalidError';
    this.field = field;
    this.reason = reason;
  }
}

export class CanonicalExistsAnomaly extends Error {
  constructor() {
    super('canonical_exists');
    this.name = 'CanonicalExistsAnomaly';
  }
}
