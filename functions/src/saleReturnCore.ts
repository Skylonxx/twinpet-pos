/**
 * saleReturnCore — Return/Refund V1 pure decision core (TPOS-USABLE-POS-RETURN-REFUND-V1).
 *
 * A Return is a sale-linked, partial (line × quantity), cross-day capable flow
 * that is DISTINCT from the same-day whole-bill Void. The original sale
 * (`asyncOrders` / `orders` / `orderItems` / `payments`) is never mutated; a
 * Return creates immutable `saleReturns` / `saleRefunds` records and advances a
 * per-sale `saleReturnLedgers/{orderId}` aggregate that serializes concurrent
 * returns against the same sale.
 *
 * Everything here is pure: request validation, deterministic ids, satang
 * money math, historical-evidence classification, pricing/discount
 * allocation, cumulative refund math, FIFO cost-basis restoration planning,
 * refund-method caps and the ledger successor. No Admin SDK, no clock reads.
 *
 * Money is integer satang (minor units). Quantities are integer milli-units
 * (qty × 1000) so a fractional sale unit (e.g. weighed goods) stays exact.
 * Anything that cannot be represented exactly fails closed as unsupported
 * evidence — this module never guesses.
 */

import { sha256Hex } from './shiftCloseValidationHash';

export const SALE_RETURN_SCHEMA_VERSION = 1 as const;

export const SALE_RETURN_COLLECTIONS = {
  returns: 'saleReturns',
  refunds: 'saleRefunds',
  ledgers: 'saleReturnLedgers',
  auditEvents: 'saleReturnAuditEvents',
  /**
   * Server-owned fence for an attempt the client resolved as NOT committed
   * (after an unknown transport outcome). Once present, that attempt's
   * returnId can never commit, so the client may safely start a new attempt.
   */
  attemptResolutions: 'saleReturnAttemptResolutions',
} as const;

/** Lot id the reconciler records for an oversold quantity — it has no lot doc. */
export const OVERSELL_LOT_ID = 'oversell';

export const SALE_RETURN_MAX_LINES = 100;
export const SALE_RETURN_REASON_MAX = 300;
export const SALE_RETURN_NOTE_MAX = 500;
export const SALE_RETURN_REFERENCE_MAX = 120;

export const SALE_RETURN_REFUND_METHODS = ['cash', 'qr', 'kbank', 'card', 'none'] as const;
export type SaleReturnRefundMethod = (typeof SALE_RETURN_REFUND_METHODS)[number];
export type MoneyRefundMethod = Exclude<SaleReturnRefundMethod, 'none'>;
export const MONEY_REFUND_METHODS: readonly MoneyRefundMethod[] = ['cash', 'qr', 'kbank', 'card'];

export function isSaleReturnRefundMethod(value: unknown): value is SaleReturnRefundMethod {
  return (SALE_RETURN_REFUND_METHODS as readonly unknown[]).includes(value);
}

// ---------------------------------------------------------------------------
// Classification (D-RET-13)
// ---------------------------------------------------------------------------

export type SaleReturnClassification =
  | 'RETURN_ELIGIBLE'
  | 'RETURN_UNSUPPORTED_EVIDENCE'
  | 'RETURN_NOT_ELIGIBLE';

export type ReturnNotEligibleReason =
  | 'order_not_found'
  | 'branch_mismatch'
  | 'not_settled'
  | 'reconcile_exception'
  | 'voided'
  | 'void_in_progress'
  | 'void_terminal_marker'
  | 'canonical_not_completed'
  | 'fully_returned';

export type ReturnUnsupportedReason =
  | 'canonical_missing'
  | 'credit_sale_unsupported'
  | 'vat_unsupported'
  | 'money_malformed'
  | 'money_inconsistent'
  | 'payments_malformed'
  | 'paid_value_mismatch'
  | 'line_malformed'
  | 'line_evidence_missing'
  | 'lot_evidence_malformed'
  | 'lot_qty_mismatch'
  | 'precision_unsupported'
  | 'ledger_malformed'
  | 'oversell_return_unsupported';

// ---------------------------------------------------------------------------
// Exact conversions
// ---------------------------------------------------------------------------

/**
 * FIXED absolute tolerance, in SCALED units (satang / milli-units). It only
 * absorbs binary floating-point noise (≈1e-5 scaled units at the supported
 * maxima below) and can never swallow half a minor unit at any supported
 * magnitude. Never magnitude-relative.
 */
export const SCALED_ABS_TOLERANCE = 1e-4;
/** Largest |Baht| value accepted as exact money evidence. */
export const MONEY_MAX_ABS_BAHT = 1e9;
/** Largest |quantity| accepted as exact quantity evidence. */
export const QTY_MAX_ABS = 1e8;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function toScaledExact(value: unknown, factor: number, maxAbs: number): number | null {
  if (!isFiniteNumber(value)) return null;
  if (Math.abs(value) > maxAbs) return null;
  const scaled = value * factor;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded)) return null;
  if (Math.abs(scaled - rounded) > SCALED_ABS_TOLERANCE) return null;
  return rounded;
}

/** Baht → satang, exact to the satang. `null` when not representable or out of range. */
export function toMinorExact(value: unknown): number | null {
  return toScaledExact(value, 100, MONEY_MAX_ABS_BAHT);
}

/** Quantity → milli-units, exact to 0.001. `null` when not representable or out of range. */
export function toMilliExact(value: unknown): number | null {
  return toScaledExact(value, 1000, QTY_MAX_ABS);
}

/**
 * Sale-unit milli-quantity × unitFactor → exact base milli-units, or `null`
 * when the product is not an exact milli-unit (same fixed absolute tolerance).
 */
export function exactBaseMilli(qtyMilli: number, unitFactor: number): number | null {
  if (!Number.isSafeInteger(qtyMilli) || qtyMilli < 0) return null;
  if (!isFiniteNumber(unitFactor) || unitFactor <= 0) return null;
  const exact = qtyMilli * unitFactor;
  const rounded = Math.round(exact);
  if (!Number.isSafeInteger(rounded)) return null;
  if (Math.abs(exact - rounded) > SCALED_ABS_TOLERANCE) return null;
  return rounded;
}

export function minorToBaht(minor: number): number {
  return Math.round(minor) / 100;
}

export function milliToQty(milli: number): number {
  return Math.round(milli) / 1000;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export type SaleReturnRequestLine = { lineIndex?: unknown; productId?: unknown; qty?: unknown };

export type SubmitSaleReturnRequest = {
  /** 'submit' (default) executes with a PIN; 'resolve' replays-or-fences an unknown attempt without a PIN. */
  mode?: unknown;
  attemptId?: unknown;
  orderId?: unknown;
  branchId?: unknown;
  lines?: unknown;
  refundMethod?: unknown;
  refundReference?: unknown;
  reason?: unknown;
  note?: unknown;
  expectedRefundAmount?: unknown;
  shiftId?: unknown;
  approverStaffId?: unknown;
  pin?: unknown;
};

export type ValidatedReturnLine = { lineIndex: number; productId: string; qtyMilli: number };

export type ValidatedSubmitSaleReturnRequest = {
  attemptId: string;
  orderId: string;
  branchId: string;
  lines: ValidatedReturnLine[];
  refundMethod: SaleReturnRefundMethod;
  refundReference: string;
  reason: string;
  note: string;
  expectedRefundMinor: number;
  shiftId: string | null;
  approverStaffId: string;
  pin: string;
};

const ATTEMPT_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const DOC_ID_RE = /^[^/]{1,200}$/;

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * `requirePin: false` is used only by the PIN-less `resolve` mode, which can
 * replay an already-committed attempt or fence an uncommitted one but never
 * executes a Return.
 */
export function validateSubmitSaleReturnRequest(
  req: SubmitSaleReturnRequest,
  opts: { requirePin?: boolean } = {},
): { ok: true; value: ValidatedSubmitSaleReturnRequest } | { ok: false; code: 'invalid_request' } {
  const bad = { ok: false as const, code: 'invalid_request' as const };
  const attemptId = trimmedString(req.attemptId);
  const orderId = trimmedString(req.orderId);
  const branchId = trimmedString(req.branchId);
  if (!ATTEMPT_ID_RE.test(attemptId)) return bad;
  if (!DOC_ID_RE.test(orderId)) return bad;
  if (!DOC_ID_RE.test(branchId) || branchId === 'ALL') return bad;

  if (!Array.isArray(req.lines) || req.lines.length === 0 || req.lines.length > SALE_RETURN_MAX_LINES) return bad;
  const seen = new Set<number>();
  const lines: ValidatedReturnLine[] = [];
  for (const raw of req.lines as unknown[]) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad;
    const line = raw as SaleReturnRequestLine;
    if (typeof line.lineIndex !== 'number' || !Number.isSafeInteger(line.lineIndex) || line.lineIndex < 0) return bad;
    if (seen.has(line.lineIndex)) return bad;
    seen.add(line.lineIndex);
    const productId = trimmedString(line.productId);
    if (!productId) return bad;
    const qtyMilli = toMilliExact(line.qty);
    if (qtyMilli == null || qtyMilli <= 0) return bad;
    lines.push({ lineIndex: line.lineIndex, productId, qtyMilli });
  }
  lines.sort((a, b) => a.lineIndex - b.lineIndex);

  if (!isSaleReturnRefundMethod(req.refundMethod)) return bad;
  const refundReference = trimmedString(req.refundReference);
  if (refundReference.length > SALE_RETURN_REFERENCE_MAX) return bad;
  const reason = trimmedString(req.reason);
  if (!reason || reason.length > SALE_RETURN_REASON_MAX) return bad;
  const note = trimmedString(req.note);
  if (note.length > SALE_RETURN_NOTE_MAX) return bad;
  const expectedRefundMinor = toMinorExact(req.expectedRefundAmount);
  if (expectedRefundMinor == null || expectedRefundMinor < 0) return bad;
  const shiftIdRaw = trimmedString(req.shiftId);
  const shiftId = shiftIdRaw ? shiftIdRaw : null;
  if (shiftId != null && !DOC_ID_RE.test(shiftId)) return bad;
  const approverStaffId = trimmedString(req.approverStaffId);
  if (!approverStaffId) return bad;
  const pin = typeof req.pin === 'string' ? req.pin : '';
  if (opts.requirePin !== false && !pin) return bad;

  return {
    ok: true,
    value: {
      attemptId,
      orderId,
      branchId,
      lines,
      refundMethod: req.refundMethod,
      refundReference,
      reason,
      note,
      expectedRefundMinor,
      shiftId,
      approverStaffId,
      pin,
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic identity (Phase 3 idempotency)
// ---------------------------------------------------------------------------

/** One return attempt on one sale → one returnId, independent of retries. */
export function deriveReturnId(branchId: string, orderId: string, attemptId: string): string {
  return sha256Hex('saleReturn:v1:' + JSON.stringify([branchId, orderId, attemptId])).slice(0, 40);
}

/**
 * Digest over every economically/audit-relevant field of the request. The
 * approval commandId embeds it, so a Manager/Admin PIN approves EXACTLY these
 * lines, quantities, refund method/amount, reference and reason — a replay
 * under the same attempt with different content cannot reuse the approval.
 */
export function deriveReturnContentDigest(v: ValidatedSubmitSaleReturnRequest): string {
  return sha256Hex(
    'saleReturnContent:v1:' +
      JSON.stringify([
        v.branchId,
        v.orderId,
        v.lines.map((l) => [l.lineIndex, l.productId, l.qtyMilli]),
        v.refundMethod,
        v.expectedRefundMinor,
        v.refundReference,
        v.reason,
        v.note,
        v.shiftId,
        v.approverStaffId,
      ]),
  );
}

export function deriveReturnApprovalCommandId(returnId: string, contentDigest: string): string {
  return `saleReturn:v1:${returnId}:${contentDigest.slice(0, 32)}`;
}

export function deriveCashRefundEntryId(returnId: string): string {
  return `rfd_${returnId}`;
}

export function deriveReturnPortionDocId(returnId: string, lineIndex: number, portionIndex: number): string {
  return `ret_${returnId}_${lineIndex}_${portionIndex}`;
}

export type SaleReturnAuditKind =
  | 'initiated'
  | 'approved'
  | 'inventory_restored'
  | 'refund_recorded'
  | 'completed';

export function deriveReturnAuditEventId(returnId: string, kind: SaleReturnAuditKind): string {
  return `${returnId}_${kind}`;
}

export function deriveReturnNo(billId: string, sequence: number): string {
  return `RT-${billId}-${sequence}`;
}

// ---------------------------------------------------------------------------
// Historical sale evidence (D-RET-3 / D-RET-6 / D-RET-13)
// ---------------------------------------------------------------------------

export type SaleLotEvidence = { lotId: string; qtyBaseMilli: number; cost: number };

export type SaleLineEvidence = {
  lineIndex: number;
  productId: string;
  productName: string;
  sku: string;
  category: string;
  unit: string;
  unitFactor: number;
  soldQtyMilli: number;
  soldQtyBaseMilli: number;
  unitPriceMinor: number;
  lineDiscountMinor: number;
  lineTotalMinor: number;
  billDiscountAllocMinor: number;
  feeAllocMinor: number;
  /** Line's exact share of the paid total: lineTotal − bill-discount share + fee share. */
  refundableShareMinor: number;
  lots: SaleLotEvidence[];
};

export type NetPaidByMethod = Record<MoneyRefundMethod, number>;

export type SaleEvidence = {
  orderId: string;
  billId: string;
  branchId: string;
  customerId: string | null;
  customerName: string | null;
  saleCreatedAtMs: number;
  saleShiftId: string | null;
  saleStaffId: string | null;
  subtotalMinor: number;
  billDiscountMinor: number;
  feeMinor: number;
  totalMinor: number;
  netPaidByMethodMinor: NetPaidByMethod;
  lines: SaleLineEvidence[];
};

export type SaleEvidenceResult =
  | { ok: true; sale: SaleEvidence }
  | { ok: false; classification: 'RETURN_NOT_ELIGIBLE'; reason: ReturnNotEligibleReason }
  | { ok: false; classification: 'RETURN_UNSUPPORTED_EVIDENCE'; reason: ReturnUnsupportedReason };

function notEligible(reason: ReturnNotEligibleReason): SaleEvidenceResult {
  return { ok: false, classification: 'RETURN_NOT_ELIGIBLE', reason };
}

function unsupported(reason: ReturnUnsupportedReason): SaleEvidenceResult {
  return { ok: false, classification: 'RETURN_UNSUPPORTED_EVIDENCE', reason };
}

/** Any void state, including in-flight/anomalous ones, makes a sale non-returnable. */
export function isOrderVoidedOrVoiding(order: Record<string, unknown>): ReturnNotEligibleReason | null {
  if (order.status === 'voided' || order.voidReconciled === true) return 'voided';
  if (typeof order.privilegedVoidExecutionId === 'string' && order.privilegedVoidExecutionId.length > 0) return 'voided';
  if (order.voidRequested === true) return 'void_in_progress';
  // The online privileged Void stamps `voidedBy` in the SAME transaction that
  // consumes its approval (before the canonical void runs). A Return that
  // serializes after that consume must see the Void as in progress.
  if (typeof order.voidedBy === 'string' && order.voidedBy.length > 0) return 'void_in_progress';
  if ('voidAnomaly' in order || 'voidRevisionFault' in order) return 'void_terminal_marker';
  return null;
}

/**
 * Largest-remainder allocation of `amount` across `weights` (all integers).
 * Deterministic: ties go to the lower index. Σ result === amount exactly.
 */
export function allocateProportional(amount: number, weights: readonly number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (amount === 0 || total === 0) return weights.map(() => 0);
  const big = BigInt(amount);
  const bigTotal = BigInt(total);
  const base: bigint[] = weights.map((w) => (big * BigInt(w)) / bigTotal);
  const rema: { index: number; rem: bigint }[] = weights.map((w, index) => ({
    index,
    rem: (big * BigInt(w)) % bigTotal,
  }));
  let leftover = Number(big - base.reduce((s, b) => s + b, 0n));
  rema.sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  for (let k = 0; leftover > 0 && k < rema.length; k += 1, leftover -= 1) {
    base[rema[k]!.index]! += 1n;
  }
  return base.map((b) => Number(b));
}

function readString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Parse + classify one settled sale from its `asyncOrders` doc (the settled
 * FIFO/lot evidence written atomically by `reconcileSale`) and its canonical
 * `orders` doc. Returns exact satang/milli evidence or a fail-closed reason.
 */
export function parseSaleEvidence(
  orderId: string,
  asyncOrder: Record<string, unknown> | null,
  canonical: Record<string, unknown> | null,
  expectedBranchId: string,
): SaleEvidenceResult {
  if (asyncOrder == null) return notEligible('order_not_found');
  if (asyncOrder.branchId !== expectedBranchId) return notEligible('branch_mismatch');
  const voidState = isOrderVoidedOrVoiding(asyncOrder);
  if (voidState) return notEligible(voidState);
  if (asyncOrder.reconcileStatus === 'exception') return notEligible('reconcile_exception');
  if (asyncOrder.reconcileStatus !== 'settled') return notEligible('not_settled');
  if (canonical == null) return unsupported('canonical_missing');
  const canonicalVoid = isOrderVoidedOrVoiding(canonical);
  if (canonicalVoid) return notEligible(canonicalVoid);
  if (canonical.branchId !== expectedBranchId) return notEligible('branch_mismatch');

  const creditAmt = asyncOrder.creditAmt;
  if (creditAmt !== undefined && !(isFiniteNumber(creditAmt) && creditAmt >= 0)) return unsupported('money_malformed');
  if (isFiniteNumber(creditAmt) && creditAmt > 0) return unsupported('credit_sale_unsupported');
  if (canonical.status !== 'completed') return notEligible('canonical_not_completed');
  for (const k of ['vatAmt', 'vatRate'] as const) {
    const v = asyncOrder[k] ?? canonical[k];
    if (v !== undefined && v !== null && !(isFiniteNumber(v) && v === 0)) return unsupported('vat_unsupported');
  }

  const subtotalMinor = toMinorExact(asyncOrder.subtotal);
  const totalMinor = toMinorExact(asyncOrder.total);
  const billDiscountMinor = asyncOrder.billDiscount === undefined ? 0 : toMinorExact(asyncOrder.billDiscount);
  const feeMinor = asyncOrder.fee === undefined ? 0 : toMinorExact(asyncOrder.fee);
  const changeMinor = asyncOrder.changeAmt === undefined ? 0 : toMinorExact(asyncOrder.changeAmt);
  if (
    subtotalMinor == null ||
    totalMinor == null ||
    billDiscountMinor == null ||
    feeMinor == null ||
    changeMinor == null ||
    subtotalMinor < 0 ||
    totalMinor < 0 ||
    billDiscountMinor < 0 ||
    feeMinor < 0 ||
    changeMinor < 0
  ) {
    return unsupported('money_malformed');
  }
  if (subtotalMinor - billDiscountMinor + feeMinor !== totalMinor) return unsupported('money_inconsistent');
  if (billDiscountMinor > subtotalMinor) return unsupported('money_inconsistent');
  const canonicalTotal = toMinorExact(canonical.total);
  if (canonicalTotal == null || canonicalTotal !== totalMinor) return unsupported('money_inconsistent');

  // Payments: exact tender split, cash net of change.
  if (!Array.isArray(asyncOrder.payments)) return unsupported('payments_malformed');
  const gross: NetPaidByMethod = { cash: 0, qr: 0, kbank: 0, card: 0 };
  for (const raw of asyncOrder.payments as unknown[]) {
    if (raw === null || typeof raw !== 'object') return unsupported('payments_malformed');
    const p = raw as Record<string, unknown>;
    const amount = toMinorExact(p.amount);
    if (amount == null || amount < 0) return unsupported('payments_malformed');
    if (p.method === 'credit') {
      if (amount > 0) return unsupported('credit_sale_unsupported');
      continue;
    }
    if (p.method !== 'cash' && p.method !== 'qr' && p.method !== 'kbank' && p.method !== 'card') {
      return unsupported('payments_malformed');
    }
    gross[p.method] += amount;
  }
  if (changeMinor > gross.cash) return unsupported('paid_value_mismatch');
  const netPaid: NetPaidByMethod = { ...gross, cash: gross.cash - changeMinor };
  if (netPaid.cash + netPaid.qr + netPaid.kbank + netPaid.card !== totalMinor) return unsupported('paid_value_mismatch');

  // Lines: exact quantities, prices, and settled FIFO lot evidence.
  if (!Array.isArray(asyncOrder.lines) || asyncOrder.lines.length === 0) return unsupported('line_malformed');
  type Draft = Omit<SaleLineEvidence, 'billDiscountAllocMinor' | 'feeAllocMinor' | 'refundableShareMinor'>;
  const drafts: Draft[] = [];
  const rawLines = asyncOrder.lines as unknown[];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return unsupported('line_malformed');
    const line = raw as Record<string, unknown>;
    const productId = readString(line.productId);
    if (!productId) return unsupported('line_malformed');
    if (!isFiniteNumber(line.unitFactor) || line.unitFactor <= 0) return unsupported('line_malformed');
    const soldQtyMilli = toMilliExact(line.qty);
    const soldQtyBaseMilli = toMilliExact(line.qtyBase);
    if (soldQtyMilli == null || soldQtyBaseMilli == null || soldQtyMilli <= 0 || soldQtyBaseMilli <= 0) {
      return unsupported('precision_unsupported');
    }
    if (exactBaseMilli(soldQtyMilli, line.unitFactor) !== soldQtyBaseMilli) {
      return unsupported('precision_unsupported');
    }
    const unitPriceMinor = toMinorExact(line.unitPrice);
    const lineTotalMinor = toMinorExact(line.lineTotal);
    const lineDiscountMinor = line.discountAmt === undefined ? 0 : toMinorExact(line.discountAmt);
    if (unitPriceMinor == null || lineTotalMinor == null || lineDiscountMinor == null || lineTotalMinor < 0) {
      return unsupported('line_malformed');
    }
    if (!Array.isArray(line.lotRefs) || line.lotRefs.length === 0) return unsupported('line_evidence_missing');
    const lots: SaleLotEvidence[] = [];
    let lotBaseTotal = 0;
    for (const lr of line.lotRefs as unknown[]) {
      if (lr === null || typeof lr !== 'object') return unsupported('lot_evidence_malformed');
      const ref = lr as Record<string, unknown>;
      const lotId = readString(ref.lotId);
      const qtyBaseMilli = toMilliExact(ref.qty);
      if (!lotId || lotId.includes('/') || qtyBaseMilli == null || qtyBaseMilli <= 0) return unsupported('lot_evidence_malformed');
      if (!isFiniteNumber(ref.cost) || ref.cost < 0) return unsupported('lot_evidence_malformed');
      lots.push({ lotId, qtyBaseMilli, cost: ref.cost });
      lotBaseTotal += qtyBaseMilli;
    }
    if (lotBaseTotal !== soldQtyBaseMilli) return unsupported('lot_qty_mismatch');
    const snap = (line.productSnap ?? {}) as Record<string, unknown>;
    drafts.push({
      lineIndex: i,
      productId,
      productName: readString(snap.name),
      sku: readString(snap.sku),
      category: readString(snap.category),
      unit: readString(line.unit),
      unitFactor: line.unitFactor,
      soldQtyMilli,
      soldQtyBaseMilli,
      unitPriceMinor,
      lineDiscountMinor,
      lineTotalMinor,
      lots,
    });
  }
  const linesTotal = drafts.reduce((s, d) => s + d.lineTotalMinor, 0);
  if (linesTotal !== subtotalMinor) return unsupported('money_inconsistent');

  const weights = drafts.map((d) => d.lineTotalMinor);
  const discAlloc = allocateProportional(billDiscountMinor, weights);
  const feeAlloc = allocateProportional(feeMinor, weights);
  const lines: SaleLineEvidence[] = drafts.map((d, k) => ({
    ...d,
    billDiscountAllocMinor: discAlloc[k]!,
    feeAllocMinor: feeAlloc[k]!,
    refundableShareMinor: d.lineTotalMinor - discAlloc[k]! + feeAlloc[k]!,
  }));

  const customerSnap = (asyncOrder.customerSnap ?? null) as Record<string, unknown> | null;
  const createdMs = isFiniteNumber(asyncOrder.clientCreatedAt) ? asyncOrder.clientCreatedAt : 0;
  return {
    ok: true,
    sale: {
      orderId,
      billId: readString(asyncOrder.billId) || orderId,
      branchId: expectedBranchId,
      customerId: typeof asyncOrder.customerId === 'string' ? asyncOrder.customerId : null,
      customerName: customerSnap && typeof customerSnap.name === 'string' ? customerSnap.name : null,
      saleCreatedAtMs: createdMs,
      saleShiftId: typeof asyncOrder.shiftId === 'string' ? asyncOrder.shiftId : null,
      saleStaffId: typeof asyncOrder.staffId === 'string' ? asyncOrder.staffId : null,
      subtotalMinor,
      billDiscountMinor,
      feeMinor,
      totalMinor,
      netPaidByMethodMinor: netPaid,
      lines,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-sale return ledger (cumulative quantity / refund guard)
// ---------------------------------------------------------------------------

export type LedgerLine = { returnedQtyMilli: number; returnedQtyBaseMilli: number; refundedMinor: number };

export type ReturnLedger = {
  returnCount: number;
  refundedTotalMinor: number;
  refundedByMethodMinor: NetPaidByMethod;
  lines: Map<number, LedgerLine>;
  acceptedReturnIds: string[];
};

export function emptyLedger(): ReturnLedger {
  return {
    returnCount: 0,
    refundedTotalMinor: 0,
    refundedByMethodMinor: { cash: 0, qr: 0, kbank: 0, card: 0 },
    lines: new Map(),
    acceptedReturnIds: [],
  };
}

function nonNegInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** Absent ledger → empty. Present-but-unparseable → `null` (fail closed). */
export function parseReturnLedger(data: unknown): ReturnLedger | null {
  if (data === undefined) return emptyLedger();
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const raw = data as Record<string, unknown>;
  if (raw.schemaVersion !== SALE_RETURN_SCHEMA_VERSION) return null;
  const returnCount = nonNegInt(raw.returnCount);
  const refundedTotalMinor = nonNegInt(raw.refundedTotalMinor);
  if (returnCount == null || refundedTotalMinor == null) return null;
  const byMethodRaw = raw.refundedByMethodMinor as Record<string, unknown> | undefined;
  if (byMethodRaw == null || typeof byMethodRaw !== 'object' || Array.isArray(byMethodRaw)) return null;
  const byMethod: NetPaidByMethod = { cash: 0, qr: 0, kbank: 0, card: 0 };
  for (const m of MONEY_REFUND_METHODS) {
    const v = nonNegInt(byMethodRaw[m] ?? 0);
    if (v == null) return null;
    byMethod[m] = v;
  }
  if (!Array.isArray(raw.lines)) return null;
  const lines = new Map<number, LedgerLine>();
  for (const l of raw.lines as unknown[]) {
    if (l === null || typeof l !== 'object') return null;
    const rec = l as Record<string, unknown>;
    const lineIndex = nonNegInt(rec.lineIndex);
    const returnedQtyMilli = nonNegInt(rec.returnedQtyMilli);
    const returnedQtyBaseMilli = nonNegInt(rec.returnedQtyBaseMilli);
    const refundedMinor = nonNegInt(rec.refundedMinor);
    if (lineIndex == null || returnedQtyMilli == null || returnedQtyBaseMilli == null || refundedMinor == null) return null;
    if (lines.has(lineIndex)) return null;
    lines.set(lineIndex, { returnedQtyMilli, returnedQtyBaseMilli, refundedMinor });
  }
  if (
    !Array.isArray(raw.acceptedReturnIds) ||
    !raw.acceptedReturnIds.every((x) => typeof x === 'string' && x.length > 0)
  ) {
    return null;
  }
  const acceptedReturnIds = raw.acceptedReturnIds as string[];
  if (acceptedReturnIds.length !== returnCount) return null;
  if (new Set(acceptedReturnIds).size !== acceptedReturnIds.length) return null;
  return { returnCount, refundedTotalMinor, refundedByMethodMinor: byMethod, lines, acceptedReturnIds };
}

/**
 * The ledger is canonical server-owned state, but it is never trusted blindly:
 * a present ledger must be internally consistent AND consistent with the
 * immutable original sale before any new Return effect. `true` = valid.
 */
export function ledgerConsistentWithSale(sale: SaleEvidence, ledger: ReturnLedger): boolean {
  // Only an accepted Return creates a ledger, so a present one records ≥ 1.
  if (ledger.returnCount < 1) return false;
  const byIndex = new Map(sale.lines.map((l) => [l.lineIndex, l]));
  let linesRefunded = 0;
  let returnedMilliTotal = 0;
  for (const [lineIndex, l] of ledger.lines) {
    const saleLine = byIndex.get(lineIndex);
    if (!saleLine) return false;
    if (l.returnedQtyMilli > saleLine.soldQtyMilli) return false;
    if (l.returnedQtyBaseMilli > saleLine.soldQtyBaseMilli) return false;
    // Base must follow the sale's own unitFactor snapshot (the final return of
    // a line restores exactly the remaining sold base).
    const expectedBase =
      l.returnedQtyMilli === saleLine.soldQtyMilli
        ? saleLine.soldQtyBaseMilli
        : exactBaseMilli(l.returnedQtyMilli, saleLine.unitFactor);
    if (expectedBase == null || expectedBase !== l.returnedQtyBaseMilli) return false;
    // Cumulative refund math telescopes, so a line's refunded total is fully
    // determined by its cumulative returned quantity.
    if (l.refundedMinor !== cumulativeRefundMinor(saleLine.refundableShareMinor, saleLine.soldQtyMilli, l.returnedQtyMilli)) {
      return false;
    }
    linesRefunded += l.refundedMinor;
    returnedMilliTotal += l.returnedQtyMilli;
  }
  if (linesRefunded !== ledger.refundedTotalMinor) return false;
  const byMethodTotal = MONEY_REFUND_METHODS.reduce((s, m) => s + ledger.refundedByMethodMinor[m], 0);
  if (byMethodTotal !== ledger.refundedTotalMinor) return false;
  if (ledger.refundedTotalMinor > sale.totalMinor) return false;
  for (const m of MONEY_REFUND_METHODS) {
    if (ledger.refundedByMethodMinor[m] > sale.netPaidByMethodMinor[m]) return false;
  }
  // Every accepted Return returned at least one milli-unit.
  if (returnedMilliTotal < ledger.returnCount) return false;
  return true;
}

/**
 * Absent ledger → empty. Present ledger → parsed AND validated against the
 * sale (identity + invariants). `null` = malformed / inconsistent: fail closed.
 */
export function parseReturnLedgerForSale(data: unknown, sale: SaleEvidence): ReturnLedger | null {
  if (data === undefined) return emptyLedger();
  const ledger = parseReturnLedger(data);
  if (ledger == null) return null;
  const raw = data as Record<string, unknown>;
  if (raw.orderId !== sale.orderId || raw.branchId !== sale.branchId) return null;
  return ledgerConsistentWithSale(sale, ledger) ? ledger : null;
}

/**
 * Void cross-flow guard. In this architecture `saleReturnLedgers/{orderId}`
 * is created ONLY by an accepted Return, so the document's existence alone
 * blocks a whole-bill Void — its content (even `returnCount: 0`) is never
 * trusted as proof that no Return exists. Malformed ⇒ still blocks.
 */
export function saleReturnLedgerBlocksVoid(ledgerSnapExists: boolean): boolean {
  return ledgerSnapExists;
}

export function serializeReturnLedger(
  ledger: ReturnLedger,
  orderId: string,
  branchId: string,
): Record<string, unknown> {
  return {
    schemaVersion: SALE_RETURN_SCHEMA_VERSION,
    orderId,
    branchId,
    returnCount: ledger.returnCount,
    refundedTotalMinor: ledger.refundedTotalMinor,
    refundedByMethodMinor: { ...ledger.refundedByMethodMinor },
    lines: [...ledger.lines.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([lineIndex, l]) => ({ lineIndex, ...l })),
    acceptedReturnIds: [...ledger.acceptedReturnIds],
  };
}

export function lineReturnedQtyMilli(ledger: ReturnLedger, lineIndex: number): number {
  return ledger.lines.get(lineIndex)?.returnedQtyMilli ?? 0;
}

/** A sale whose every line is fully returned can take no further return. */
export function isFullyReturned(sale: SaleEvidence, ledger: ReturnLedger): boolean {
  return sale.lines.every((l) => lineReturnedQtyMilli(ledger, l.lineIndex) >= l.soldQtyMilli);
}

// ---------------------------------------------------------------------------
// Pricing / refund math (D-RET-5 / D-RET-6)
// ---------------------------------------------------------------------------

/**
 * Cumulative refund for the first `cumQtyMilli` of `soldQtyMilli` units of a
 * line whose exact paid share is `shareMinor`: round-half-up(share × cum / sold).
 * At `cum === sold` this is exactly `shareMinor`, so a sequence of partial
 * returns can never drift above (or below) the line's paid share.
 */
export function cumulativeRefundMinor(shareMinor: number, soldQtyMilli: number, cumQtyMilli: number): number {
  if (soldQtyMilli <= 0 || cumQtyMilli <= 0 || shareMinor <= 0) return 0;
  const cum = BigInt(Math.min(cumQtyMilli, soldQtyMilli));
  const sold = BigInt(soldQtyMilli);
  const share = BigInt(shareMinor);
  return Number((2n * share * cum + sold) / (2n * sold));
}

export function lineRefundForReturnMinor(
  shareMinor: number,
  soldQtyMilli: number,
  previouslyReturnedMilli: number,
  qtyMilli: number,
): number {
  return (
    cumulativeRefundMinor(shareMinor, soldQtyMilli, previouslyReturnedMilli + qtyMilli) -
    cumulativeRefundMinor(shareMinor, soldQtyMilli, previouslyReturnedMilli)
  );
}

// ---------------------------------------------------------------------------
// FIFO cost-basis restoration planning (D-RET-3)
// ---------------------------------------------------------------------------

export type RestorePortion = {
  portionIndex: number;
  originalLotId: string;
  qtyBaseMilli: number;
  /** Original sale-time unit cost of that lot (Baht per base unit) — never current product cost. */
  costPerUnit: number;
};

/**
 * Deterministic reconstruction of which originally-sold base units a return
 * covers. The sold units are laid out in the recorded FIFO cut order
 * (`lotRefs` order); earlier accepted returns of the same line consumed the
 * prefix `[0, previouslyReturnedBase)`, this return takes the next
 * `qtyBaseMilli` units. Cumulative restoration can therefore never exceed the
 * original allocation of any lot, and each portion keeps its own cost layer.
 */
export function planLotRestoration(
  lots: readonly SaleLotEvidence[],
  previouslyReturnedBaseMilli: number,
  qtyBaseMilli: number,
): RestorePortion[] | null {
  const total = lots.reduce((s, l) => s + l.qtyBaseMilli, 0);
  if (previouslyReturnedBaseMilli < 0 || qtyBaseMilli <= 0) return null;
  if (previouslyReturnedBaseMilli + qtyBaseMilli > total) return null;
  const start = previouslyReturnedBaseMilli;
  const end = previouslyReturnedBaseMilli + qtyBaseMilli;
  const portions: RestorePortion[] = [];
  let cursor = 0;
  for (const lot of lots) {
    const lotStart = cursor;
    const lotEnd = cursor + lot.qtyBaseMilli;
    cursor = lotEnd;
    const take = Math.min(end, lotEnd) - Math.max(start, lotStart);
    if (take > 0) {
      portions.push({ portionIndex: portions.length, originalLotId: lot.lotId, qtyBaseMilli: take, costPerUnit: lot.cost });
    }
  }
  return portions;
}

/**
 * Base offset (in the recorded FIFO cut order) at which the first oversell
 * allocation begins; `Σ lots` when the line has none. V1 never returns a unit
 * at or past this offset (D-RET-FIX-4).
 */
export function oversellFreeBaseEnd(lots: readonly SaleLotEvidence[]): number {
  let cursor = 0;
  for (const lot of lots) {
    if (lot.lotId === OVERSELL_LOT_ID) return cursor;
    cursor += lot.qtyBaseMilli;
  }
  return cursor;
}

/**
 * Largest further sale-unit milli-quantity of a line that V1 supports
 * returning: bounded by the unreturned quantity AND by the oversell-free
 * prefix of the line's FIFO allocation.
 */
export function maxSupportedReturnQtyMilli(line: SaleLineEvidence, prior: LedgerLine | undefined): number {
  const returned = prior?.returnedQtyMilli ?? 0;
  const returnedBase = prior?.returnedQtyBaseMilli ?? 0;
  const remaining = line.soldQtyMilli - returned;
  if (remaining <= 0) return 0;
  const end = oversellFreeBaseEnd(line.lots);
  if (end >= line.soldQtyBaseMilli) return remaining;
  const availBase = end - returnedBase;
  if (availBase <= 0) return 0;
  let q = Math.min(remaining, Math.floor((availBase + SCALED_ABS_TOLERANCE) / line.unitFactor));
  for (let guard = 0; q > 0 && guard < 1000; guard += 1, q -= 1) {
    const base = exactBaseMilli(q, line.unitFactor);
    if (base != null && base <= availBase) return q;
  }
  return 0;
}

export type InPlaceLotRejectReason =
  | 'lot_missing'
  | 'product_mismatch'
  | 'branch_mismatch'
  | 'ghost_lot'
  | 'qty_malformed'
  | 'remaining_exceeds_received'
  | 'capacity_exceeded'
  | 'cost_mismatch';

export type InPlaceLotDecision =
  | { ok: true; currentRemainingMilli: number; nextRemainingMilli: number }
  | { ok: false; reason: InPlaceLotRejectReason };

/**
 * May the returned units go back INTO their original lot? Only when the lot
 * read inside the Return transaction is provably the same, intact cost layer
 * with room for them: exists, same product/branch, not ghost, exact
 * non-negative quantities with remaining ≤ received, remaining + returned ≤
 * received, and its CURRENT cost equals the sale-time cost of every portion.
 * Anything else ⇒ a distinct restoration lot at the sale-time cost.
 */
export function decideInPlaceLotRestore(
  lot: Record<string, unknown> | null,
  expected: { productId: string; branchId: string; portionCosts: readonly number[]; restoreBaseMilli: number },
): InPlaceLotDecision {
  if (lot == null) return { ok: false, reason: 'lot_missing' };
  if (lot.productId !== expected.productId) return { ok: false, reason: 'product_mismatch' };
  if (lot.branchId !== expected.branchId) return { ok: false, reason: 'branch_mismatch' };
  if (lot.isGhost === true) return { ok: false, reason: 'ghost_lot' };
  const received = toMilliExact(lot.qtyReceived);
  const remaining = toMilliExact(lot.qtyRemaining);
  if (received == null || remaining == null || received < 0 || remaining < 0) {
    return { ok: false, reason: 'qty_malformed' };
  }
  if (remaining > received) return { ok: false, reason: 'remaining_exceeds_received' };
  if (!Number.isSafeInteger(expected.restoreBaseMilli) || expected.restoreBaseMilli <= 0) {
    return { ok: false, reason: 'qty_malformed' };
  }
  if (remaining + expected.restoreBaseMilli > received) return { ok: false, reason: 'capacity_exceeded' };
  const cost = lot.costPerUnit;
  if (!isFiniteNumber(cost) || expected.portionCosts.length === 0 || !expected.portionCosts.every((c) => c === cost)) {
    return { ok: false, reason: 'cost_mismatch' };
  }
  return { ok: true, currentRemainingMilli: remaining, nextRemainingMilli: remaining + expected.restoreBaseMilli };
}

export function portionsCostMinor(portions: readonly RestorePortion[]): number {
  // Σ qtyBase × cost, rounded once to the satang (cost may carry > 2 dp).
  const raw = portions.reduce((s, p) => s + (p.qtyBaseMilli / 1000) * p.costPerUnit * 100, 0);
  return Math.round(raw);
}

// ---------------------------------------------------------------------------
// Return planner
// ---------------------------------------------------------------------------

export type SaleReturnPlanRejectCode =
  | 'invalid_request'
  | 'return_not_eligible'
  | 'return_unsupported_evidence'
  | 'over_return'
  | 'refund_mismatch'
  | 'refund_method_not_allowed'
  | 'refund_cap_exceeded'
  | 'reference_required'
  | 'oversell_return_unsupported';

export type PlannedReturnLine = {
  lineIndex: number;
  productId: string;
  productName: string;
  sku: string;
  category: string;
  unit: string;
  unitFactor: number;
  soldQtyMilli: number;
  previouslyReturnedQtyMilli: number;
  returnQtyMilli: number;
  returnQtyBaseMilli: number;
  unitPriceMinor: number;
  lineDiscountMinor: number;
  lineTotalMinor: number;
  billDiscountAllocMinor: number;
  feeAllocMinor: number;
  refundableShareMinor: number;
  refundMinor: number;
  /**
   * Gross line revenue reversed (line total basis, BEFORE bill discount / fee
   * allocation), cumulative-exact like the refund. Reporting adapters that
   * measure revenue as Σ lineTotal net with this, never with the refund.
   */
  lineRevenueMinor: number;
  costMinor: number;
  portions: RestorePortion[];
};

export type SaleReturnPlan = {
  lines: PlannedReturnLine[];
  refundMinor: number;
  lineRevenueMinor: number;
  costMinor: number;
  refundMethod: SaleReturnRefundMethod;
  nextLedger: ReturnLedger;
  sequence: number;
};

export function planSaleReturn(
  sale: SaleEvidence,
  ledger: ReturnLedger,
  request: Pick<
    ValidatedSubmitSaleReturnRequest,
    'lines' | 'refundMethod' | 'refundReference' | 'expectedRefundMinor'
  >,
  returnId: string,
): { ok: true; plan: SaleReturnPlan } | { ok: false; code: SaleReturnPlanRejectCode } {
  if (isFullyReturned(sale, ledger)) return { ok: false, code: 'return_not_eligible' };
  const byIndex = new Map(sale.lines.map((l) => [l.lineIndex, l]));
  const planned: PlannedReturnLine[] = [];
  for (const req of request.lines) {
    const line = byIndex.get(req.lineIndex);
    if (!line || line.productId !== req.productId) return { ok: false, code: 'invalid_request' };
    const prior = ledger.lines.get(req.lineIndex) ?? { returnedQtyMilli: 0, returnedQtyBaseMilli: 0, refundedMinor: 0 };
    if (req.qtyMilli <= 0) return { ok: false, code: 'invalid_request' };
    if (prior.returnedQtyMilli + req.qtyMilli > line.soldQtyMilli) return { ok: false, code: 'over_return' };
    const baseMilli = exactBaseMilli(req.qtyMilli, line.unitFactor);
    if (baseMilli == null || baseMilli <= 0) return { ok: false, code: 'return_unsupported_evidence' };
    // Returning the last units of a line restores exactly the remaining sold base.
    const remainingBase = line.soldQtyBaseMilli - prior.returnedQtyBaseMilli;
    const isFinal = prior.returnedQtyMilli + req.qtyMilli === line.soldQtyMilli;
    const qtyBaseMilli = isFinal ? remainingBase : baseMilli;
    if (qtyBaseMilli <= 0 || qtyBaseMilli > remainingBase) return { ok: false, code: 'over_return' };
    const portions = planLotRestoration(line.lots, prior.returnedQtyBaseMilli, qtyBaseMilli);
    if (portions == null || portions.length === 0) return { ok: false, code: 'over_return' };
    // V1: an oversold unit has no sale-time cost layer to restore into, so a
    // Return that would reach any oversell allocation fails closed.
    if (portions.some((p) => p.originalLotId === OVERSELL_LOT_ID)) {
      return { ok: false, code: 'oversell_return_unsupported' };
    }
    const refundMinor = lineRefundForReturnMinor(
      line.refundableShareMinor,
      line.soldQtyMilli,
      prior.returnedQtyMilli,
      req.qtyMilli,
    );
    const lineRevenueMinor = lineRefundForReturnMinor(
      line.lineTotalMinor,
      line.soldQtyMilli,
      prior.returnedQtyMilli,
      req.qtyMilli,
    );
    planned.push({
      lineIndex: line.lineIndex,
      productId: line.productId,
      productName: line.productName,
      sku: line.sku,
      category: line.category,
      unit: line.unit,
      unitFactor: line.unitFactor,
      soldQtyMilli: line.soldQtyMilli,
      previouslyReturnedQtyMilli: prior.returnedQtyMilli,
      returnQtyMilli: req.qtyMilli,
      returnQtyBaseMilli: qtyBaseMilli,
      unitPriceMinor: line.unitPriceMinor,
      lineDiscountMinor: line.lineDiscountMinor,
      lineTotalMinor: line.lineTotalMinor,
      billDiscountAllocMinor: line.billDiscountAllocMinor,
      feeAllocMinor: line.feeAllocMinor,
      refundableShareMinor: line.refundableShareMinor,
      refundMinor,
      lineRevenueMinor,
      costMinor: portionsCostMinor(portions),
      portions,
    });
  }

  const refundMinor = planned.reduce((s, l) => s + l.refundMinor, 0);
  const lineRevenueMinor = planned.reduce((s, l) => s + l.lineRevenueMinor, 0);
  const costMinor = planned.reduce((s, l) => s + l.costMinor, 0);
  if (refundMinor !== request.expectedRefundMinor) return { ok: false, code: 'refund_mismatch' };
  if (ledger.refundedTotalMinor + refundMinor > sale.totalMinor) return { ok: false, code: 'refund_cap_exceeded' };

  const method = request.refundMethod;
  if (refundMinor === 0) {
    if (method !== 'none') return { ok: false, code: 'refund_method_not_allowed' };
  } else {
    if (method === 'none') return { ok: false, code: 'refund_method_not_allowed' };
    // A refund goes back through a tender the customer actually paid with, and
    // never exceeds what that tender netted on the sale (net of prior refunds).
    const paid = sale.netPaidByMethodMinor[method];
    if (!(paid > 0)) return { ok: false, code: 'refund_method_not_allowed' };
    if (ledger.refundedByMethodMinor[method] + refundMinor > paid) return { ok: false, code: 'refund_cap_exceeded' };
    if (method !== 'cash' && request.refundReference.length === 0) return { ok: false, code: 'reference_required' };
  }

  const nextLines = new Map(ledger.lines);
  for (const l of planned) {
    const prior = nextLines.get(l.lineIndex) ?? { returnedQtyMilli: 0, returnedQtyBaseMilli: 0, refundedMinor: 0 };
    nextLines.set(l.lineIndex, {
      returnedQtyMilli: prior.returnedQtyMilli + l.returnQtyMilli,
      returnedQtyBaseMilli: prior.returnedQtyBaseMilli + l.returnQtyBaseMilli,
      refundedMinor: prior.refundedMinor + l.refundMinor,
    });
  }
  const nextByMethod = { ...ledger.refundedByMethodMinor };
  if (method !== 'none') nextByMethod[method] += refundMinor;
  const nextLedger: ReturnLedger = {
    returnCount: ledger.returnCount + 1,
    refundedTotalMinor: ledger.refundedTotalMinor + refundMinor,
    refundedByMethodMinor: nextByMethod,
    lines: nextLines,
    acceptedReturnIds: [...ledger.acceptedReturnIds, returnId],
  };
  return {
    ok: true,
    plan: {
      lines: planned,
      refundMinor,
      lineRevenueMinor,
      costMinor,
      refundMethod: method,
      nextLedger,
      sequence: nextLedger.returnCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Customer spend aggregate (CRM release gate, D-RET-FIX-9)
// ---------------------------------------------------------------------------

export type CustomerSpendAdjustment =
  | {
      apply: true;
      decrementMinor: number;
      /** Field → [before, after] in Baht; only fields present on the customer doc. */
      fields: Partial<Record<'lifetimeValue' | 'totalSpent', { before: number; after: number; clamped: boolean }>>;
    }
  | { apply: false; reason: 'no_customer' | 'zero_refund' | 'customer_missing' | 'no_aggregate' | 'aggregate_malformed' };

/**
 * The sale reconciler adds the sale total to `customers.{lifetimeValue,
 * totalSpent}`; an accepted Return takes back exactly its refund, inside the
 * Return transaction (exact-once with the return record). Never below 0 —
 * the historical floor of a spend aggregate.
 */
export function planCustomerSpendAdjustment(
  customerId: string | null,
  customerDoc: Record<string, unknown> | null,
  refundMinor: number,
): CustomerSpendAdjustment {
  if (!customerId) return { apply: false, reason: 'no_customer' };
  if (refundMinor <= 0) return { apply: false, reason: 'zero_refund' };
  if (customerDoc == null) return { apply: false, reason: 'customer_missing' };
  const fields: Partial<Record<'lifetimeValue' | 'totalSpent', { before: number; after: number; clamped: boolean }>> = {};
  for (const key of ['lifetimeValue', 'totalSpent'] as const) {
    const raw = customerDoc[key];
    if (raw === undefined || raw === null) continue;
    const beforeMinor = toMinorExact(raw);
    if (beforeMinor == null) return { apply: false, reason: 'aggregate_malformed' };
    const afterMinor = Math.max(0, beforeMinor - refundMinor);
    fields[key] = {
      before: minorToBaht(beforeMinor),
      after: minorToBaht(afterMinor),
      clamped: beforeMinor - refundMinor < 0,
    };
  }
  if (Object.keys(fields).length === 0) return { apply: false, reason: 'no_aggregate' };
  return { apply: true, decrementMinor: refundMinor, fields };
}

// ---------------------------------------------------------------------------
// Read-only context view (UI D-RET-8)
// ---------------------------------------------------------------------------

export type SaleReturnContextLine = {
  lineIndex: number;
  productId: string;
  productName: string;
  sku: string;
  unit: string;
  soldQty: number;
  returnedQty: number;
  returnableQty: number;
  soldQtyMilli: number;
  returnedQtyMilli: number;
  /** What V1 can actually return now: ≤ returnable, excludes oversold units. */
  supportedReturnableQty: number;
  supportedReturnableQtyMilli: number;
  /** True when part of the unreturned quantity was sold from oversell (unsupported in V1). */
  oversellLimited: boolean;
  unitPrice: number;
  lineDiscount: number;
  lineTotal: number;
  billDiscountAlloc: number;
  feeAlloc: number;
  refundableShareMinor: number;
  refundedAmount: number;
};

export type SaleReturnContextView = {
  orderId: string;
  billId: string;
  branchId: string;
  customerName: string | null;
  saleCreatedAtMs: number;
  total: number;
  refundedTotal: number;
  returnCount: number;
  fullyReturned: boolean;
  lines: SaleReturnContextLine[];
  /** Remaining refundable value per tender the sale was actually paid with. */
  refundMethods: { method: MoneyRefundMethod; remaining: number }[];
};

export function buildReturnContextView(sale: SaleEvidence, ledger: ReturnLedger): SaleReturnContextView {
  return {
    orderId: sale.orderId,
    billId: sale.billId,
    branchId: sale.branchId,
    customerName: sale.customerName,
    saleCreatedAtMs: sale.saleCreatedAtMs,
    total: minorToBaht(sale.totalMinor),
    refundedTotal: minorToBaht(ledger.refundedTotalMinor),
    returnCount: ledger.returnCount,
    fullyReturned: isFullyReturned(sale, ledger),
    lines: sale.lines.map((l) => {
      const returned = ledger.lines.get(l.lineIndex);
      const returnedMilli = returned?.returnedQtyMilli ?? 0;
      const remainingMilli = Math.max(0, l.soldQtyMilli - returnedMilli);
      const supportedMilli = maxSupportedReturnQtyMilli(l, returned);
      return {
        lineIndex: l.lineIndex,
        productId: l.productId,
        productName: l.productName,
        sku: l.sku,
        unit: l.unit,
        soldQty: milliToQty(l.soldQtyMilli),
        returnedQty: milliToQty(returnedMilli),
        returnableQty: milliToQty(remainingMilli),
        soldQtyMilli: l.soldQtyMilli,
        returnedQtyMilli: returnedMilli,
        supportedReturnableQty: milliToQty(supportedMilli),
        supportedReturnableQtyMilli: supportedMilli,
        oversellLimited: supportedMilli < remainingMilli,
        unitPrice: minorToBaht(l.unitPriceMinor),
        lineDiscount: minorToBaht(l.lineDiscountMinor),
        lineTotal: minorToBaht(l.lineTotalMinor),
        billDiscountAlloc: minorToBaht(l.billDiscountAllocMinor),
        feeAlloc: minorToBaht(l.feeAllocMinor),
        refundableShareMinor: l.refundableShareMinor,
        refundedAmount: minorToBaht(returned?.refundedMinor ?? 0),
      };
    }),
    refundMethods: MONEY_REFUND_METHODS.filter((m) => sale.netPaidByMethodMinor[m] > 0).map((m) => ({
      method: m,
      remaining: minorToBaht(Math.max(0, sale.netPaidByMethodMinor[m] - ledger.refundedByMethodMinor[m])),
    })),
  };
}
