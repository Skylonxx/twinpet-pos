// Packet 5 / P5-B pure core — money conversion, per-entry classification,
// and the canonical cash-entries fold. Pure, deterministic, no Admin SDK, no
// Firestore, no network, no environment/time-now dependency (all inputs are
// explicit parameters). Frozen by P5-A R3 §7 (Blocker 1) / R4-D1.

import {
  CAP_SNAPSHOT_ENTRIES,
  MAX_ENTRY_BAHT,
  MAX_TOTAL_BAHT,
  type CashEntriesSnapshotMeta,
  type CashEntryFoldBlockingReason,
  type ShiftCashEntrySnapshot,
} from './shiftCloseValidationTypes';

// ---------------------------------------------------------------------------
// Money conversion — two frozen converters (P5-A R3 §7.1), never merged.
// ---------------------------------------------------------------------------

export type EntryMalformedReason = 'non_finite_amount' | 'non_positive_amount' | 'amount_over_bound' | 'amount_precision';

export type TotalMalformedReason = 'non_finite_total' | 'negative_total' | 'total_over_bound' | 'total_precision';

export type EntryMinorResult = { ok: true; minor: number } | { ok: false; reason: EntryMalformedReason };

export type TotalMinorResult = { ok: true; minor: number } | { ok: false; reason: TotalMalformedReason };

const PRECISION_EPSILON = 1e-6;

/** One snapshot ENTRY amount (raw Baht number) — strictly positive, ≤ ฿10,000,000, ≤ 2dp. */
export function toPositiveEntryMinor(x: number): EntryMinorResult {
  if (!Number.isFinite(x)) return { ok: false, reason: 'non_finite_amount' };
  if (x <= 0) return { ok: false, reason: 'non_positive_amount' };
  if (x > MAX_ENTRY_BAHT) return { ok: false, reason: 'amount_over_bound' };
  const scaled = x * 100;
  const nearest = Math.round(scaled);
  if (Math.abs(scaled - nearest) > PRECISION_EPSILON) return { ok: false, reason: 'amount_precision' };
  return { ok: true, minor: nearest };
}

/** An AGGREGATE captured total (payInTotal / payOutTotal, raw Baht number) — zero is valid. */
export function toNonNegativeTotalMinor(x: number): TotalMinorResult {
  if (!Number.isFinite(x)) return { ok: false, reason: 'non_finite_total' };
  if (x < 0) return { ok: false, reason: 'negative_total' };
  if (Object.is(x, -0)) return { ok: true, minor: 0 };
  if (x > MAX_TOTAL_BAHT) return { ok: false, reason: 'total_over_bound' };
  const scaled = x * 100;
  const nearest = Math.round(scaled);
  if (Math.abs(scaled - nearest) > PRECISION_EPSILON) return { ok: false, reason: 'total_precision' };
  return { ok: true, minor: nearest };
}

// ---------------------------------------------------------------------------
// Per-entry classification (P5-A R2 §7.4 two-class malformed schema).
// ---------------------------------------------------------------------------

export interface ClassifiedCashEntry {
  raw: ShiftCashEntrySnapshot;
  originalIndex: number;
  /** Well-formed id used for ordering/pairing; '' if malformed (originalIndex breaks ties). */
  orderingId: string;
  /** Well-formed `at` used for ordering; 0 if malformed. */
  orderingAt: number;
  /** Class-A fold-blocking reason, if any (id/type/amount corruption). */
  foldBlockingReason: CashEntryFoldBlockingReason | null;
  /** Well-formed type, if valid. */
  type: 'pay_in' | 'pay_out' | null;
  /** Converted minor-unit amount, only present when the amount itself is valid (independent of id/type validity). */
  amountMinor: number | null;
  /** Soft (Class-B) integrity flags recorded, non-blocking. */
  softFlags: {
    note: boolean;
    staffId: boolean;
    staffName: boolean;
    at: boolean;
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Classifies one raw snapshot entry into Class-A (fold-blocking) / Class-B
 * (soft) findings. `seenIds` tracks ids already observed in this snapshot so
 * a repeat id is flagged `id_duplicate` (P5-A R2 §7.4). Duplicate detection is
 * order-dependent by design: the first occurrence of a repeated id is NOT
 * itself flagged, only the second and later occurrences are — this keeps the
 * function a pure per-entry step callable during a single left-to-right scan.
 */
export function classifyCashEntry(
  raw: ShiftCashEntrySnapshot,
  originalIndex: number,
  seenIds: Set<string>,
): ClassifiedCashEntry {
  let foldBlockingReason: CashEntryFoldBlockingReason | null = null;

  // id
  let orderingId = '';
  if (!isNonEmptyString(raw.id)) {
    foldBlockingReason = 'id_missing';
  } else if (seenIds.has(raw.id)) {
    foldBlockingReason = 'id_duplicate';
    orderingId = raw.id;
  } else {
    orderingId = raw.id;
    seenIds.add(raw.id);
  }

  // type
  let type: 'pay_in' | 'pay_out' | null = null;
  if (raw.type === 'pay_in' || raw.type === 'pay_out') {
    type = raw.type;
  } else if (foldBlockingReason === null) {
    foldBlockingReason = 'type_unknown';
  }

  // amount
  let amountMinor: number | null = null;
  if (typeof raw.amount === 'number') {
    const converted = toPositiveEntryMinor(raw.amount);
    if (converted.ok) {
      amountMinor = converted.minor;
    } else if (foldBlockingReason === null) {
      foldBlockingReason = converted.reason;
    }
  } else if (foldBlockingReason === null) {
    foldBlockingReason = 'non_finite_amount';
  }

  // soft (Class-B) fields — never fold-blocking
  const noteBad = !(typeof raw.note === 'string');
  const staffIdBad = !(typeof raw.staffId === 'string');
  const staffNameBad = !(typeof raw.staffName === 'string');
  const atBad = !(typeof raw.at === 'number' && Number.isFinite(raw.at) && Number.isInteger(raw.at));

  const orderingAt = atBad ? 0 : (raw.at as number);

  return {
    raw,
    originalIndex,
    orderingId,
    orderingAt,
    foldBlockingReason,
    type,
    amountMinor,
    softFlags: { note: noteBad, staffId: staffIdBad, staffName: staffNameBad, at: atBad },
  };
}

// ---------------------------------------------------------------------------
// Canonical ordering — (at ASC, id ASC UTF-8 byte order), stable originalIndex
// tie-break for malformed/duplicate keys (P5-A R1 §7.2, R4 R5-review non-blocking
// note on tie-break determinism).
// ---------------------------------------------------------------------------

function utf8ByteCompare(a: string, b: string): number {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return Buffer.compare(bufA, bufB);
}

export function compareCanonicalOrder(a: ClassifiedCashEntry, b: ClassifiedCashEntry): number {
  if (a.orderingAt !== b.orderingAt) return a.orderingAt - b.orderingAt;
  const idCmp = utf8ByteCompare(a.orderingId, b.orderingId);
  if (idCmp !== 0) return idCmp;
  return a.originalIndex - b.originalIndex;
}

export function canonicalOrder(entries: readonly ClassifiedCashEntry[]): ClassifiedCashEntry[] {
  return [...entries].sort(compareCanonicalOrder);
}

// ---------------------------------------------------------------------------
// Fold — canonical (at,id)-ordered classification + BigInt parity fold
// (P5-A R3 §7.1-§7.3, R4-D1 sourceEntryCount/cashEntriesOverflowed).
// ---------------------------------------------------------------------------

export interface CashFoldResult {
  meta: CashEntriesSnapshotMeta;
  /** Canonical-order first CAP_SNAPSHOT_ENTRIES entries — the stored subset. */
  storedSubset: readonly ClassifiedCashEntry[];
  /** BigInt satang sums over the stored subset; null when folding is blocked. */
  payInMinor: bigint | null;
  payOutMinor: bigint | null;
}

/**
 * Folds a full raw `cashEntries[]` array (already read once by the evidence
 * capture, never re-read here). Classifies every entry, orders the canonical
 * first `CAP_SNAPSHOT_ENTRIES` as the stored subset, and BigInt-sums
 * `pay_in`/`pay_out` minor amounts over that subset — mirroring
 * `foldCashEntries` (shiftLedger.ts) exactly for any snapshot inside the
 * frozen envelope. Folding is refused (payInMinor/payOutMinor null) when any
 * fold-blocking entry exists in the stored subset or when the source
 * overflowed the capture cap — the caller must then classify the run
 * `insufficient_evidence`, never `match`/`discrepancy`.
 */
export function foldCashEntriesSnapshot(rawEntries: readonly ShiftCashEntrySnapshot[]): CashFoldResult {
  const sourceEntryCount = rawEntries.length;
  const cashEntriesOverflowed = sourceEntryCount > CAP_SNAPSHOT_ENTRIES;

  const seenIds = new Set<string>();
  const classified = rawEntries.map((raw, index) => classifyCashEntry(raw, index, seenIds));
  const ordered = canonicalOrder(classified);
  const storedSubset = ordered.slice(0, CAP_SNAPSHOT_ENTRIES);

  let foldBlockingCount = 0;
  let softFlagCount = 0;
  let firstFoldBlockingReason: CashEntryFoldBlockingReason | null = null;

  for (const entry of storedSubset) {
    if (entry.foldBlockingReason !== null) {
      foldBlockingCount += 1;
      if (firstFoldBlockingReason === null) firstFoldBlockingReason = entry.foldBlockingReason;
    }
    if (entry.softFlags.note || entry.softFlags.staffId || entry.softFlags.staffName || entry.softFlags.at) {
      softFlagCount += 1;
    }
  }

  const canFold = foldBlockingCount === 0 && !cashEntriesOverflowed;

  let payInMinor: bigint | null = null;
  let payOutMinor: bigint | null = null;
  if (canFold) {
    let payIn = 0n;
    let payOut = 0n;
    for (const entry of storedSubset) {
      const minor = BigInt(entry.amountMinor as number);
      if (entry.type === 'pay_in') payIn += minor;
      else if (entry.type === 'pay_out') payOut += minor;
    }
    payInMinor = payIn;
    payOutMinor = payOut;
  }

  const meta: CashEntriesSnapshotMeta = {
    count: storedSubset.length,
    capturedFrom: 'shifts.cashEntries',
    foldBlockingCount,
    softFlagCount,
    firstFoldBlockingReason,
    sourceEntryCount,
    cashEntriesOverflowed,
  };

  return { meta, storedSubset, payInMinor, payOutMinor };
}

/**
 * Terminal `roundMoney` kernel, replicated verbatim from `src/lib/money.ts`
 * (`Number.isFinite(x) ? Math.round(x * 100) / 100 : 0`). It is re-implemented
 * here rather than imported because `src/lib/money.ts` is a client-bundle
 * module and P5-B server-owned code must not import from `src/` (P5-A §7.1
 * RED ZONE). A parity test asserts identical results for the shared inputs.
 */
export function roundMoneyKernel(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}

/**
 * Parity comparison (P5-A R3 §7.1 step 3): compares the BigInt fold against
 * the captured evidence totals. Per the frozen algorithm the captured
 * aggregates are first normalized through the terminal `roundMoney` kernel
 * and then converted with `toNonNegativeTotalMinor` — so a legacy captured
 * total carrying >2-decimal float noise is rounded (as the terminal would),
 * not rejected. Returns `null` (no verdict possible) when the fold itself was
 * blocked or a captured total is non-finite/negative/over-bound — the caller
 * must then classify `insufficient_evidence`.
 */
export function drawerCashParityMatches(
  fold: CashFoldResult,
  evidencePayInTotal: number,
  evidencePayOutTotal: number,
): boolean | null {
  if (fold.payInMinor === null || fold.payOutMinor === null) return null;
  // Guard non-finite captured totals BEFORE roundMoney (which would map them to 0
  // and hide the corruption); a non-finite/malformed captured total is unverifiable.
  if (!Number.isFinite(evidencePayInTotal) || !Number.isFinite(evidencePayOutTotal)) return null;
  const payInTotal = toNonNegativeTotalMinor(roundMoneyKernel(evidencePayInTotal));
  const payOutTotal = toNonNegativeTotalMinor(roundMoneyKernel(evidencePayOutTotal));
  if (!payInTotal.ok || !payOutTotal.ok) return null;
  return fold.payInMinor === BigInt(payInTotal.minor) && fold.payOutMinor === BigInt(payOutTotal.minor);
}
