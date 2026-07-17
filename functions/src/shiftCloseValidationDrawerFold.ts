// Packet 5 / P5-D-1 — pure device-scoped tender fold (worker-core-local,
// P5-B G1 Option A precedent: composes only exported P5-B encoders, zero
// P5-B edits). Pure, deterministic: no Admin SDK, no Firestore, no network,
// no environment/time-now dependency (all inputs are explicit parameters).
//
// Mirrors `summarizeDrawer` (src/lib/pos/shiftLedger.ts) exactly for any
// snapshot inside the frozen money envelope: per-sale netCash = max(0,
// cashIn - changeAmt), qr/kbank/card/credit sums, totalBills = folded sale
// count. Fold membership is restricted to `deviceId == evidence.deviceId`
// (frozen P5-A §7.2) — other-device ledger sales are counted only, in
// `crossDeviceSalesObserved`, never folded (P5-D plan §21.5/GD10).
//
// Governing (OneDrive Ai-Report\twinpet-pos\Architect, read-only inputs):
//   twinpet-p1-offline-sync-packet-5-p5-d-worker-sweep-readonly-architecture-plan.md §21.3-§21.4
//   twinpet-p1-offline-sync-packet-5-p5-d-worker-sweep-architecture-remediation-addendum.md §13 (B5 — invalid_payload)

import { toPositiveEntryMinor, toNonNegativeTotalMinor } from './shiftCloseValidationCore';

// ---------------------------------------------------------------------------
// Raw input shape — the exact relevant-field subset of an asyncOrders doc
// needed to fold (a superset of the frozen manifest relevant-field set, R2
// §9.4 — this module reads `id` additionally for canonical ordering/logging).
// ---------------------------------------------------------------------------

export interface RawAsyncOrderPayment {
  method: unknown;
  amount: unknown; // raw Baht number
}

export interface RawAsyncOrderForFold {
  id: string;
  shiftId: unknown;
  branchId: unknown;
  deviceId: unknown;
  status: unknown;
  voidRequested: unknown;
  reconcileStatus: unknown;
  changeAmt: unknown; // raw Baht number, >=0 valid
  payments: unknown; // expected: RawAsyncOrderPayment[]
}

const KNOWN_PAYMENT_METHODS = new Set(['cash', 'qr', 'kbank', 'card', 'credit']);

/**
 * Fold-blocking reason taxonomy (P5-D-local — not a P5-B frozen enum). Any
 * occurrence on a fold-member doc forces `foldBlocked:true`, which drives the
 * worker-core V6 `invalid_payload` classification (errorClassification stays
 * null per the frozen non-widening rule).
 */
export type TenderFoldBlockingReason =
  | 'payments_missing_or_malformed'
  | 'unknown_payment_method'
  | 'non_finite_amount'
  | 'non_positive_amount'
  | 'amount_over_bound'
  | 'amount_precision'
  | 'malformed_change_amt';

/**
 * Ledger-visible inclusion predicate — mirrors `isLedgerSale`
 * (src/lib/pos/localLedger.ts) exactly: excludes voided / void-requested /
 * reconcile-exception docs; `pending_reconcile` (and every other
 * reconcileStatus) is included.
 */
export function isLedgerSaleDoc(doc: RawAsyncOrderForFold): boolean {
  if (doc.status === 'voided') return false;
  if (doc.voidRequested === true) return false;
  if (doc.reconcileStatus === 'exception') return false;
  return true;
}

function utf8ByteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

interface PerSaleFold {
  docId: string;
  blockingReason: TenderFoldBlockingReason | null;
  cashMinor: bigint;
  qrMinor: bigint;
  kbankMinor: bigint;
  cardMinor: bigint;
  creditMinor: bigint;
  changeAmtMinor: bigint;
}

/** Classifies + sums the tenders of one fold-member ledger-sale doc. Never throws. */
function foldOneSale(doc: RawAsyncOrderForFold): PerSaleFold {
  let blockingReason: TenderFoldBlockingReason | null = null;
  let cashMinor = 0n;
  let qrMinor = 0n;
  let kbankMinor = 0n;
  let cardMinor = 0n;
  let creditMinor = 0n;

  const payments = doc.payments;
  if (!Array.isArray(payments)) {
    blockingReason = 'payments_missing_or_malformed';
  } else {
    for (const raw of payments as readonly unknown[]) {
      if (raw === null || typeof raw !== 'object') {
        blockingReason ??= 'payments_missing_or_malformed';
        continue;
      }
      const p = raw as RawAsyncOrderPayment;
      if (typeof p.method !== 'string' || !KNOWN_PAYMENT_METHODS.has(p.method)) {
        blockingReason ??= 'unknown_payment_method';
        continue;
      }
      if (typeof p.amount !== 'number') {
        blockingReason ??= 'non_finite_amount';
        continue;
      }
      const converted = toPositiveEntryMinor(p.amount);
      if (!converted.ok) {
        blockingReason ??= converted.reason;
        continue;
      }
      const minor = BigInt(converted.minor);
      switch (p.method) {
        case 'cash':
          cashMinor += minor;
          break;
        case 'qr':
          qrMinor += minor;
          break;
        case 'kbank':
          kbankMinor += minor;
          break;
        case 'card':
          cardMinor += minor;
          break;
        case 'credit':
          creditMinor += minor;
          break;
      }
    }
  }

  let changeAmtMinor = 0n;
  if (blockingReason === null) {
    if (typeof doc.changeAmt !== 'number') {
      blockingReason = 'malformed_change_amt';
    } else {
      const converted = toNonNegativeTotalMinor(doc.changeAmt);
      if (!converted.ok) {
        blockingReason = 'malformed_change_amt';
      } else {
        changeAmtMinor = BigInt(converted.minor);
      }
    }
  }

  return { docId: doc.id, blockingReason, cashMinor, qrMinor, kbankMinor, cardMinor, creditMinor, changeAmtMinor };
}

export interface DeviceScopedFoldSummary {
  /** True iff any fold-member ledger-sale doc had a malformed tender (V6). */
  foldBlocked: boolean;
  /** First blocking reason in canonical (docId ASC) order; null iff not blocked. */
  foldBlockReason: TenderFoldBlockingReason | null;
  /** The offending doc id, for diagnostic logging only (never persisted payload values). */
  foldBlockDocId: string | null;
  /** Number of device-scoped ledger-sale docs attempted (populated even when blocked). */
  saleCount: number;
  /** `summarizeDrawer`-parity folded sale count; null iff blocked. */
  totalBills: number | null;
  expectedCashMinor: number | null;
  expectedQrMinor: number | null;
  expectedKbankMinor: number | null;
  expectedCardMinor: number | null;
  expectedCreditMinor: number | null;
  crossDeviceSalesObserved: { observed: boolean; count: number };
}

/**
 * Folds the branch+shift-scoped `asyncOrders` read set down to the frozen
 * device-scoped drawer summary. `evidenceDeviceId` is `evidence.deviceId`
 * (the immutable close-time device — the fold anchor, P5-A §7.2). Docs are
 * processed in canonical `docId` ASC order so the first fold-blocking reason
 * is deterministic regardless of query/read iteration order.
 */
export function foldDeviceScopedDrawer(docs: readonly RawAsyncOrderForFold[], evidenceDeviceId: string): DeviceScopedFoldSummary {
  const ordered = [...docs].sort((a, b) => utf8ByteCompare(a.id, b.id));

  const sameDeviceLedgerSales = ordered.filter((d) => isLedgerSaleDoc(d) && d.deviceId === evidenceDeviceId);
  const otherDeviceLedgerSales = ordered.filter((d) => isLedgerSaleDoc(d) && d.deviceId !== evidenceDeviceId);

  const folds = sameDeviceLedgerSales.map(foldOneSale);
  const firstBlocked = folds.find((f) => f.blockingReason !== null) ?? null;
  const foldBlocked = firstBlocked !== null;

  let expectedCashMinor: number | null = null;
  let expectedQrMinor: number | null = null;
  let expectedKbankMinor: number | null = null;
  let expectedCardMinor: number | null = null;
  let expectedCreditMinor: number | null = null;
  let totalBills: number | null = null;

  if (!foldBlocked) {
    let cash = 0n;
    let qr = 0n;
    let kbank = 0n;
    let card = 0n;
    let credit = 0n;
    for (const f of folds) {
      cash += f.cashMinor > f.changeAmtMinor ? f.cashMinor - f.changeAmtMinor : 0n;
      qr += f.qrMinor;
      kbank += f.kbankMinor;
      card += f.cardMinor;
      credit += f.creditMinor;
    }
    expectedCashMinor = Number(cash);
    expectedQrMinor = Number(qr);
    expectedKbankMinor = Number(kbank);
    expectedCardMinor = Number(card);
    expectedCreditMinor = Number(credit);
    totalBills = folds.length;
  }

  return {
    foldBlocked,
    foldBlockReason: firstBlocked?.blockingReason ?? null,
    foldBlockDocId: firstBlocked?.docId ?? null,
    saleCount: sameDeviceLedgerSales.length,
    totalBills,
    expectedCashMinor,
    expectedQrMinor,
    expectedKbankMinor,
    expectedCardMinor,
    expectedCreditMinor,
    crossDeviceSalesObserved: { observed: otherDeviceLedgerSales.length > 0, count: otherDeviceLedgerSales.length },
  };
}
