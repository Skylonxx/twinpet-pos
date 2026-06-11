/**
 * Transfer Reversal Evidence Builder  [Phase 7B-H6-E2-A — latent, not wired]
 *
 * Pure (no Firestore, no runtime queue): turns the dual-branch stock effect of a
 * completed transfer into a validatable evidence snapshot. Models both the
 * DESTINATION GAIN (toBranchId received stock) and the SOURCE LOSS (fromBranchId
 * lost stock) for each transfer item, so a later reversal can prove it is
 * undoing exactly what the original transfer did — to both branches.
 *
 * DUAL-BRANCH MODEL: every transfer item produces two evidence effects —
 *   dest_gain: the destination branch received transferQty units.
 *   source_loss: the source branch lost transferQty units.
 * Quantities are POSITIVE in both rows; direction carries the semantic meaning.
 * Source lot identity (if any) is audit-only — the balance check is product×total,
 * not lot-level, so multi-lot source transfers are not over-rejected.
 *
 * COMPLETENESS INVARIANT: `assertTransferReversalEvidenceCoversCompletion` proves
 * that the evidence's dual-branch effect set covers the input completely — for
 * every product, the dest_gain total and source_loss total each equal the summed
 * input quantity, and the derived checksums (itemCount, totalQtyBase) are
 * consistent with the input. A tampered or asymmetric evidence set fails closed.
 *
 * This file is LATENT — it has no runtime wiring and does not affect production
 * behavior. See Phase 7B-H6-E2-B for header write and H6-E2-C for coordinator
 * validation.
 */

/** Current schema version — bump only on a breaking shape change. */
export const TRANSFER_REVERSAL_EVIDENCE_VERSION = 1 as const;

/** Float tolerance for qty checksums (base units may be fractional). */
const QTY_EPSILON = 1e-9;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Whether an effect represents stock added to the destination or removed from the source. */
export type TransferReversalEvidenceDirection = 'dest_gain' | 'source_loss';

/** One stock-affecting row of a transfer evidence snapshot. */
export type TransferReversalEvidenceEffect = {
  productId: string;
  branchId: string;
  direction: TransferReversalEvidenceDirection;
  qtyBase: number;
  /** Source lot identifier — audit-only; null for destination effects and multi-lot sources. */
  lotId?: string | null;
};

/** The complete transfer reversal evidence snapshot. All checksums are derived by the builder. */
export type TransferReversalEvidence = {
  version: 1;
  source: 'transfer_completion';
  fromBranchId: string;
  toBranchId: string;
  /** Number of SOURCE transfer items (NOT number of effect rows; each item yields two effects). */
  itemCount: number;
  /** Sum of transferQty across all source items. */
  totalQtyBase: number;
  effects: TransferReversalEvidenceEffect[];
  createdAt: string;
  createdBy?: string | null;
};

/**
 * One transfer item as needed to build evidence. Source lot details are optional and
 * audit-only — their presence does not change the balance check or reject valid
 * multi-lot transfers. Permissive typing keeps the builder decoupled from runtime
 * transfer types.
 */
export type TransferReversalEvidenceItemInput = {
  productId: string;
  transferQty: number;
  sourceLotDetails?: readonly {
    lotId?: string | null;
    qty?: number;
    receivedAtMs?: number | null;
    costPerUnit?: number | null;
  }[];
};

/** Everything the completion path supplies to build evidence. */
export type TransferReversalEvidenceInput = {
  fromBranchId: string;
  toBranchId: string;
  items: readonly TransferReversalEvidenceItemInput[];
  createdAt: string;
  createdBy?: string | null;
};

// ─── Error types ──────────────────────────────────────────────────────────────

/** Structured reject codes for builder and invariant failures. */
export type TransferReversalEvidenceCode =
  // Builder input validation
  | 'missing_from_branch'
  | 'missing_to_branch'
  | 'same_branch'
  | 'missing_items'
  | 'empty_items'
  | 'missing_product_id'
  | 'non_finite_qty'
  | 'non_positive_qty'
  // Invariant validation
  | 'wrong_version'
  | 'wrong_source'
  | 'branch_header_mismatch'
  | 'empty_effects'
  | 'effect_missing_product_id'
  | 'effect_invalid_direction'
  | 'effect_invalid_branch'
  | 'effect_non_finite_qty'
  | 'effect_non_positive_qty'
  | 'dest_source_balance_mismatch'
  | 'itemcount_mismatch'
  | 'totalqty_mismatch';

const EVIDENCE_MESSAGE =
  'ไม่สามารถสร้างหลักฐานการโอนย้ายได้ เนื่องจากข้อมูลโอนย้ายไม่ครบถ้วน — กรุณาโหลดใหม่หรือติดต่อผู้ดูแลระบบ';

/**
 * Thrown when the transfer evidence cannot be built or its completeness invariant fails.
 * Throwing (rather than coercing/dropping) is all-or-nothing — no partial evidence is
 * ever produced or accepted.
 */
export class TransferReversalEvidenceError extends Error {
  readonly code: TransferReversalEvidenceCode;
  constructor(code: TransferReversalEvidenceCode, message: string) {
    super(message);
    this.name = 'TransferReversalEvidenceError';
    this.code = code;
  }
}

// ─── Deterministic sort ───────────────────────────────────────────────────────

/**
 * Canonical sort key for a transfer evidence effect.
 * Order: productId → direction → branchId → lotId (stable regardless of input order).
 */
function effectSortKey(e: TransferReversalEvidenceEffect): string {
  return `${e.productId}|${e.direction}|${e.branchId}|${e.lotId ?? ''}`;
}

// ─── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build a transfer reversal evidence snapshot from the completion input.
 *
 * Validates the input fail-closed — any missing/malformed field throws BEFORE any
 * effects are produced. Checksums (`itemCount`, `totalQtyBase`) are derived here
 * and can never drift from the effect set.
 *
 * Each item produces exactly two effects: a `dest_gain` (toBranchId) and a
 * `source_loss` (fromBranchId), both with positive `qtyBase`. Effects are sorted
 * deterministically by `productId|direction|branchId|lotId` so the output is
 * order-stable regardless of input order.
 *
 * Source lot identity is audit-only: the lotId on a source_loss effect is populated
 * only when there is exactly ONE source lot detail with a non-empty lotId. Multi-lot
 * sources use `null` (product×branch counter-based), consistent with how
 * `buildTransferReversalEffects` works in the live queue path.
 */
export function buildTransferReversalEvidence(
  input: TransferReversalEvidenceInput,
): TransferReversalEvidence {
  if (typeof input.fromBranchId !== 'string' || input.fromBranchId.trim().length === 0) {
    throw new TransferReversalEvidenceError('missing_from_branch', EVIDENCE_MESSAGE);
  }
  if (typeof input.toBranchId !== 'string' || input.toBranchId.trim().length === 0) {
    throw new TransferReversalEvidenceError('missing_to_branch', EVIDENCE_MESSAGE);
  }
  if (input.fromBranchId.trim() === input.toBranchId.trim()) {
    throw new TransferReversalEvidenceError('same_branch', EVIDENCE_MESSAGE);
  }
  if (input.items == null) {
    throw new TransferReversalEvidenceError('missing_items', EVIDENCE_MESSAGE);
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new TransferReversalEvidenceError('empty_items', EVIDENCE_MESSAGE);
  }
  for (const it of input.items) {
    if (!it || typeof it.productId !== 'string' || it.productId.trim().length === 0) {
      throw new TransferReversalEvidenceError('missing_product_id', EVIDENCE_MESSAGE);
    }
    if (typeof it.transferQty !== 'number' || !Number.isFinite(it.transferQty)) {
      throw new TransferReversalEvidenceError('non_finite_qty', EVIDENCE_MESSAGE);
    }
    if (it.transferQty <= 0) {
      throw new TransferReversalEvidenceError('non_positive_qty', EVIDENCE_MESSAGE);
    }
  }

  const rawEffects: TransferReversalEvidenceEffect[] = [];
  for (const it of input.items) {
    // Destination gain — stock was added to the destination branch.
    rawEffects.push({
      productId: it.productId,
      branchId: input.toBranchId,
      direction: 'dest_gain',
      qtyBase: it.transferQty,
      lotId: null,
    });
    // Source loss — stock was removed from the source branch.
    // Carry the lot identity only when there is exactly one source lot (audit trail);
    // multi-lot sources use null (product×branch counter-based, no over-rejection gate).
    const details = it.sourceLotDetails ?? null;
    const sourceLotId =
      details !== null &&
      details.length === 1 &&
      typeof details[0]?.lotId === 'string' &&
      (details[0].lotId as string).trim().length > 0
        ? (details[0].lotId as string)
        : null;
    rawEffects.push({
      productId: it.productId,
      branchId: input.fromBranchId,
      direction: 'source_loss',
      qtyBase: it.transferQty,
      lotId: sourceLotId,
    });
  }

  const effects = [...rawEffects].sort((a, b) => {
    const ka = effectSortKey(a);
    const kb = effectSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return {
    version: TRANSFER_REVERSAL_EVIDENCE_VERSION,
    source: 'transfer_completion',
    fromBranchId: input.fromBranchId,
    toBranchId: input.toBranchId,
    itemCount: input.items.length,
    totalQtyBase: input.items.reduce((s, it) => s + it.transferQty, 0),
    effects,
    createdAt: input.createdAt,
    createdBy: input.createdBy ?? null,
  };
}

// ─── Completeness invariant ───────────────────────────────────────────────────

/**
 * H6-E2-A COMPLETENESS INVARIANT. Proves that `evidence` was correctly and completely
 * derived from `input`:
 *
 *  1. Evidence version and source are correct.
 *  2. Required branch IDs are present in the evidence AND match the input branches.
 *  3. Every evidence effect is well-formed (non-empty productId, valid direction,
 *     branchId BOUND to direction — dest_gain→toBranchId, source_loss→fromBranchId —
 *     positive finite qtyBase).
 *  4. Input items are valid (non-empty array; every item has non-empty productId and
 *     positive finite transferQty).
 *  5. `evidence.itemCount` equals `input.items.length`.
 *  6. `evidence.totalQtyBase` equals the sum of input item quantities (float tolerance).
 *  7. For every product, summed `dest_gain` qtyBase AND summed `source_loss` qtyBase
 *     each equal the summed input transferQty for that product. Products in effects
 *     that do not appear in input also fail closed.
 *
 * Fails closed (throws `TransferReversalEvidenceError`) on any violation.
 * Does NOT verify effect ordering (ordering is a builder concern).
 */
export function assertTransferReversalEvidenceCoversCompletion(
  input: TransferReversalEvidenceInput,
  evidence: TransferReversalEvidence,
): void {
  // 1. Version and source.
  if (evidence.version !== TRANSFER_REVERSAL_EVIDENCE_VERSION) {
    throw new TransferReversalEvidenceError('wrong_version', EVIDENCE_MESSAGE);
  }
  if (evidence.source !== 'transfer_completion') {
    throw new TransferReversalEvidenceError('wrong_source', EVIDENCE_MESSAGE);
  }

  // 2. Required branch IDs in evidence.
  if (typeof evidence.fromBranchId !== 'string' || evidence.fromBranchId.length === 0) {
    throw new TransferReversalEvidenceError('missing_from_branch', EVIDENCE_MESSAGE);
  }
  if (typeof evidence.toBranchId !== 'string' || evidence.toBranchId.length === 0) {
    throw new TransferReversalEvidenceError('missing_to_branch', EVIDENCE_MESSAGE);
  }

  // 2b. Evidence header branches must match input — prevents a tampered snapshot from
  //     silently replacing which branch is origin vs destination while keeping totals valid.
  if (evidence.fromBranchId !== input.fromBranchId) {
    throw new TransferReversalEvidenceError('branch_header_mismatch', EVIDENCE_MESSAGE);
  }
  if (evidence.toBranchId !== input.toBranchId) {
    throw new TransferReversalEvidenceError('branch_header_mismatch', EVIDENCE_MESSAGE);
  }

  // 3. Effects are present and well-formed.
  if (!Array.isArray(evidence.effects) || evidence.effects.length === 0) {
    throw new TransferReversalEvidenceError('empty_effects', EVIDENCE_MESSAGE);
  }
  for (const e of evidence.effects) {
    if (!e || typeof e.productId !== 'string' || e.productId.length === 0) {
      throw new TransferReversalEvidenceError('effect_missing_product_id', EVIDENCE_MESSAGE);
    }
    if (e.direction !== 'dest_gain' && e.direction !== 'source_loss') {
      throw new TransferReversalEvidenceError('effect_invalid_direction', EVIDENCE_MESSAGE);
    }
    // Direction-bound branch check: dest_gain MUST use toBranchId; source_loss MUST use
    // fromBranchId. Membership in {from, to} is not enough — a swapped valid-but-wrong
    // branch passes the membership check yet violates the dual-branch invariant.
    if (
      (e.direction === 'dest_gain' && e.branchId !== evidence.toBranchId) ||
      (e.direction === 'source_loss' && e.branchId !== evidence.fromBranchId)
    ) {
      throw new TransferReversalEvidenceError('effect_invalid_branch', EVIDENCE_MESSAGE);
    }
    if (typeof e.qtyBase !== 'number' || !Number.isFinite(e.qtyBase)) {
      throw new TransferReversalEvidenceError('effect_non_finite_qty', EVIDENCE_MESSAGE);
    }
    if (e.qtyBase <= 0) {
      throw new TransferReversalEvidenceError('effect_non_positive_qty', EVIDENCE_MESSAGE);
    }
  }

  // 4. Input items are valid.
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new TransferReversalEvidenceError('empty_items', EVIDENCE_MESSAGE);
  }
  for (const it of input.items) {
    if (!it || typeof it.productId !== 'string' || it.productId.trim().length === 0) {
      throw new TransferReversalEvidenceError('missing_product_id', EVIDENCE_MESSAGE);
    }
    if (typeof it.transferQty !== 'number' || !Number.isFinite(it.transferQty)) {
      throw new TransferReversalEvidenceError('non_finite_qty', EVIDENCE_MESSAGE);
    }
    if (it.transferQty <= 0) {
      throw new TransferReversalEvidenceError('non_positive_qty', EVIDENCE_MESSAGE);
    }
  }

  // 5. itemCount == input.items.length.
  if (evidence.itemCount !== input.items.length) {
    throw new TransferReversalEvidenceError('itemcount_mismatch', EVIDENCE_MESSAGE);
  }

  // 6. totalQtyBase == sum of input item quantities (float tolerance).
  const expectedTotal = input.items.reduce((s, it) => s + it.transferQty, 0);
  if (Math.abs(evidence.totalQtyBase - expectedTotal) > QTY_EPSILON) {
    throw new TransferReversalEvidenceError('totalqty_mismatch', EVIDENCE_MESSAGE);
  }

  // 7. Per-product dual-branch balance: for every product in input, both the
  //    summed dest_gain and the summed source_loss in evidence must equal the input
  //    quantity for that product. Products in effects but NOT in input also fail closed.
  const destByProduct = new Map<string, number>();
  const sourceByProduct = new Map<string, number>();
  for (const e of evidence.effects) {
    if (e.direction === 'dest_gain') {
      destByProduct.set(e.productId, (destByProduct.get(e.productId) ?? 0) + e.qtyBase);
    } else {
      sourceByProduct.set(e.productId, (sourceByProduct.get(e.productId) ?? 0) + e.qtyBase);
    }
  }

  const inputByProduct = new Map<string, number>();
  for (const it of input.items) {
    inputByProduct.set(it.productId, (inputByProduct.get(it.productId) ?? 0) + it.transferQty);
  }

  // Every input product must be covered by both directions at the correct qty.
  for (const [productId, inputQty] of inputByProduct) {
    const destQty = destByProduct.get(productId) ?? 0;
    const sourceQty = sourceByProduct.get(productId) ?? 0;
    if (Math.abs(destQty - inputQty) > QTY_EPSILON || Math.abs(sourceQty - inputQty) > QTY_EPSILON) {
      throw new TransferReversalEvidenceError('dest_source_balance_mismatch', EVIDENCE_MESSAGE);
    }
  }

  // No extra products may appear in effects that are absent from input.
  const productSet = new Set(inputByProduct.keys());
  for (const [productId] of destByProduct) {
    if (!productSet.has(productId)) {
      throw new TransferReversalEvidenceError('dest_source_balance_mismatch', EVIDENCE_MESSAGE);
    }
  }
  for (const [productId] of sourceByProduct) {
    if (!productSet.has(productId)) {
      throw new TransferReversalEvidenceError('dest_source_balance_mismatch', EVIDENCE_MESSAGE);
    }
  }
}
