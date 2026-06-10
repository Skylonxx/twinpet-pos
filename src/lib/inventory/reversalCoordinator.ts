/**
 * Reversal Coordinator — Track A live integration  [Phase 7B Post-Commit Track A]
 *
 * The single routing point a destructive Receiving/Transfer cancel action goes
 * through AFTER the user explicitly confirms in a modal gate. It decides the
 * correct reversal path and executes it, reusing the Phase 7B-3D-3 offline queue.
 *
 * Routing (approved minimal-blast-radius decision):
 *  - RECEIVING → queue-first: `createOfflineReversal` applies the immediate local
 *    IndexedDB stock correction + durably queues the intent, then (if online)
 *    syncs to the Phase 7B-3D-2 server resolver. Supersedes the legacy direct
 *    `cancelReceiving` for the confirmed path. Manager/Admin only — a Staff intent
 *    is rejected BEFORE any local write (the queue cannot satisfy the resolver's
 *    server-verified PIN contract, and a raw Staff PIN must never be stored).
 *  - TRANSFER (completed) → LEGACY executor only. The current server resolver only
 *    reverses transfers in state `sent`/`received` and rejects `completed` by
 *    design, so completed transfers are intentionally NOT routed through the
 *    resolver/queue here. The page keeps `cancelBranchTransfer` behind the modal
 *    gate. See {@link TRANSFER_REVERSAL_DEFERRED_NOTE}.
 *
 * This module owns NO UI and NO modal state — the page owns the confirmation gate
 * (no-instant-execution) and calls in here only on explicit confirm.
 */

import { createOfflineReversal, type QueueDeps } from '../pos/offline/offlineReversalQueue';
import {
  createIndexedDbReversalStore,
  type ReversalLocalStore,
} from '../pos/offline/reversalLocalStore';
import {
  getDefaultCallResolveReversal,
  syncOneReversal,
  type CallResolveReversal,
} from '../pos/offline/syncOfflineReversals';
import type {
  CreateReversalInput,
  OfflineReversalIntent,
  OfflineReversalStatus,
  OriginalStockEffect,
  ReversalAction,
  ReversalActorRole,
  ReversalEvidenceSource,
  ReversalSourceType,
} from '../pos/offline/offlineReversalTypes';
import { REVERSAL_EVIDENCE_VERSION } from '../receiving/reversalEvidence';

/**
 * Why completed-transfer reversal is NOT queue-first in this phase. Surfaced in
 * the page UI + report so the deferral is explicit, not silently dropped.
 */
export const TRANSFER_REVERSAL_DEFERRED_NOTE =
  'Completed-transfer reversal is not yet resolver-compatible (the Phase 7B-3D-2 ' +
  'resolver only reverses `sent`/`received`). Completed transfers stay on the legacy ' +
  '`cancelBranchTransfer` executor behind the confirmation gate; queue-first transfer ' +
  'reversal is deferred until the transfer lifecycle emits `sent`/`received` or the ' +
  'resolver contract is extended by an approved future phase.';

/** Which execution path a confirmed destructive action takes. */
export type ReversalRoute = 'receiving_queue_first' | 'transfer_legacy_executor';

/**
 * Pure routing decision. Receiving goes queue-first; transfer uses the legacy
 * executor (completed transfers are not resolver-compatible — see the note above).
 */
export function decideReversalRoute(sourceType: ReversalSourceType): ReversalRoute {
  return sourceType === 'receiving' ? 'receiving_queue_first' : 'transfer_legacy_executor';
}

/**
 * A receiving line as needed to compute the reversal's original stock effect.
 * This is an UNTRUSTED boundary value — it comes from a Firestore subcollection
 * load that can return empty/partial/malformed data — so the fields are typed
 * permissively and validated at the gate (`assertReceivingReversalEvidence`)
 * before any queue write or local stock mutation.
 */
export type ReceivingReversalItem = {
  productId: string;
  /** Base-unit quantity that was added to stock when the receiving completed. */
  qtyBase: number;
  lotId?: string | null;
};

// ─── Fail-closed receiving evidence gate (Track A blocker) ───────────────────

/** Structured codes for an incomplete/malformed receiving evidence rejection. */
export type ReceivingReversalEvidenceCode =
  // ── Legacy item-subcollection evidence (fallback path) ──
  | 'missing_items'
  | 'empty_items'
  | 'missing_product_id'
  | 'missing_lot_id'
  | 'non_finite_qty'
  | 'non_positive_qty'
  | 'no_effects'
  // ── Header `reversalEvidence` snapshot (Phase 7B-H1, preferred path) ──
  | 'header_not_object'
  | 'header_unsupported_version'
  | 'header_empty_effects'
  | 'header_malformed_effect'
  | 'header_missing_product_id'
  | 'header_missing_lot_id'
  | 'header_non_finite_qty'
  | 'header_non_positive_qty'
  | 'header_item_count_mismatch'
  | 'header_total_qty_mismatch';

/**
 * Thrown when receiving item/lot evidence is incomplete or malformed. Throwing
 * (rather than silently dropping invalid lines or coercing missing data) is what
 * guarantees NO queue write, NO local IndexedDB stock correction, and NO sync
 * happen on incomplete evidence — the validation is all-or-nothing.
 */
export class ReceivingReversalEvidenceError extends Error {
  readonly code: ReceivingReversalEvidenceCode;
  constructor(code: ReceivingReversalEvidenceCode, message: string) {
    super(message);
    this.name = 'ReceivingReversalEvidenceError';
    this.code = code;
  }
}

/** Honest user-facing message: an incomplete-evidence reversal is refused, not faked as success. */
export const RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE =
  'ไม่สามารถยกเลิกเอกสารรับเข้าได้ เนื่องจากข้อมูลสินค้า/ล็อตไม่สมบูรณ์ — กรุณาโหลดใหม่หรือติดต่อผู้ดูแลระบบ';

/**
 * Fail-closed completeness gate. Rejects (throws) BEFORE any effects are built —
 * and therefore before `createOfflineReversal` does any local correction or queue
 * write — when the receiving item evidence is missing, empty, or contains ANY
 * malformed line. No invalid line is silently dropped; no missing `lotId` is
 * coerced to `null`. A completed receiving whose item subcollection failed to load
 * (empty array) or loaded partially can never produce a durable correction here.
 */
export function assertReceivingReversalEvidence(
  items: readonly ReceivingReversalItem[] | null | undefined,
): asserts items is readonly ReceivingReversalItem[] {
  if (items == null) {
    throw new ReceivingReversalEvidenceError('missing_items', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new ReceivingReversalEvidenceError('empty_items', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
  }
  for (const it of items) {
    if (!it || typeof it.productId !== 'string' || it.productId.length === 0) {
      throw new ReceivingReversalEvidenceError('missing_product_id', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
    }
    if (typeof it.lotId !== 'string' || it.lotId.length === 0) {
      throw new ReceivingReversalEvidenceError('missing_lot_id', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
    }
    if (typeof it.qtyBase !== 'number' || !Number.isFinite(it.qtyBase)) {
      throw new ReceivingReversalEvidenceError('non_finite_qty', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
    }
    if (it.qtyBase <= 0) {
      throw new ReceivingReversalEvidenceError('non_positive_qty', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
    }
  }
}

/**
 * The receiving's original local stock effect to be reversed: completing a
 * receiving ADDED `+qtyBase` of each product at the branch, so the queue will
 * negate these into the correction. Zero-qty lines are dropped.
 */
export function buildReceivingReversalEffects(
  items: readonly ReceivingReversalItem[],
  branchId: string,
): OriginalStockEffect[] {
  const effects: OriginalStockEffect[] = [];
  for (const it of items) {
    if (!it.qtyBase) continue;
    effects.push({
      productId: it.productId,
      locationId: branchId,
      lotId: it.lotId ?? null,
      quantity: it.qtyBase,
    });
  }
  return effects;
}

// ─── Header reversal-evidence gate (Phase 7B-H1 — preferred over legacy items) ──

/** Float tolerance for the `totalQtyBase` checksum (base units may be fractional). */
const HEADER_QTY_EPSILON = 1e-9;

/**
 * Validate the receiving header's `reversalEvidence` snapshot and project it into the
 * reversal's original stock effects. FAIL-CLOSED: a present-but-malformed snapshot
 * (wrong shape/version, empty/invalid effects, or a failed `itemCount` / `totalQtyBase`
 * checksum) THROWS — it must never silently fall back to the item subcollection,
 * because a corrupt/partial header write is itself a danger signal.
 *
 * Evidence is LOT-EFFECT SEGMENT based (Phase 7B-H1): one segment per actual lot
 * mutation. A repeated `(productId, lotId)` is therefore LEGITIMATE (e.g. two lines
 * reconciling the same ghost lot), so duplicates are NOT rejected — they are AGGREGATED
 * (summed once) into the projected effects. The integrity checksums are verified
 * against the RAW persisted entries (so a tampered count/total still fails closed);
 * aggregation only affects the projected set handed to the queue, which can therefore
 * never double-apply beyond the summed quantity.
 *
 * `raw` is treated as fully UNTRUSTED (it crosses the Firestore boundary), so every
 * field is type-checked before use.
 */
export function validateReceivingHeaderEvidence(
  raw: unknown,
  branchId: string,
): OriginalStockEffect[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ReceivingReversalEvidenceError('header_not_object', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
  }
  const ev = raw as Record<string, unknown>;
  if (ev.version !== REVERSAL_EVIDENCE_VERSION) {
    throw new ReceivingReversalEvidenceError('header_unsupported_version', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
  }
  const rawEffects = ev.effects;
  if (!Array.isArray(rawEffects) || rawEffects.length === 0) {
    throw new ReceivingReversalEvidenceError('header_empty_effects', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
  }

  // Aggregate by (productId, lotId) — duplicates are summed once, not rejected.
  const byKey = new Map<string, OriginalStockEffect>();
  const order: string[] = [];
  let total = 0;
  for (const entry of rawEffects) {
    if (!entry || typeof entry !== 'object') {
      throw new ReceivingReversalEvidenceError('header_malformed_effect', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.productId !== 'string' || e.productId.length === 0) {
      throw new ReceivingReversalEvidenceError('header_missing_product_id', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
    }
    if (typeof e.lotId !== 'string' || e.lotId.length === 0) {
      throw new ReceivingReversalEvidenceError('header_missing_lot_id', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
    }
    if (typeof e.qtyBase !== 'number' || !Number.isFinite(e.qtyBase)) {
      throw new ReceivingReversalEvidenceError('header_non_finite_qty', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
    }
    if (e.qtyBase <= 0) {
      throw new ReceivingReversalEvidenceError('header_non_positive_qty', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
    }
    total += e.qtyBase;
    const key = `${e.productId} ${e.lotId}`;
    const cur = byKey.get(key);
    if (cur) {
      cur.quantity += e.qtyBase; // duplicate (product, lot) → sum once
    } else {
      byKey.set(key, { productId: e.productId, locationId: branchId, lotId: e.lotId, quantity: e.qtyBase });
      order.push(key);
    }
  }

  // Integrity checksums verified against the RAW persisted entries (pre-aggregation),
  // so a tampered count/total cannot slip through.
  if (typeof ev.itemCount !== 'number' || ev.itemCount !== rawEffects.length) {
    throw new ReceivingReversalEvidenceError('header_item_count_mismatch', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
  }
  if (typeof ev.totalQtyBase !== 'number' || Math.abs(ev.totalQtyBase - total) > HEADER_QTY_EPSILON) {
    throw new ReceivingReversalEvidenceError('header_total_qty_mismatch', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
  }
  return order.map((k) => byKey.get(k)!);
}

/** Everything the page supplies to reverse a receiving. */
export type ReceivingReversalInput = {
  receivingId: string;
  branchId: string;
  actorRole: ReversalActorRole;
  staffId: string;
  reason: string;
  note?: string;
  items: readonly ReceivingReversalItem[];
  /**
   * Phase 7B-H1: the receiving header's `reversalEvidence` snapshot, passed straight
   * from the loaded Firestore doc (UNTRUSTED). When present it is PREFERRED over
   * `items` and must validate or the reversal fails closed (no fallback). When
   * `null`/`undefined` (legacy/pre-H1 record) the strict `items` fallback is used.
   */
  headerEvidence?: unknown;
  /** Defaults to `void` (the cashier's "cancel bill" wording). */
  action?: ReversalAction;
};

/** Injectable dependencies — overridden in tests, defaulted for the browser. */
export type ReversalCoordinatorDeps = {
  store: ReversalLocalStore;
  isOnline: () => boolean;
  call: CallResolveReversal;
  /** ISO clock; injected for deterministic tests. */
  now?: () => string;
};

/** Outcome handed back to the page so it can pick honest, async-safe wording. */
export type ReceivingReversalOutcome = {
  intent: OfflineReversalIntent;
  status: OfflineReversalStatus;
  /** Server rejected + rollback unsafe → manual review (local correction preserved). */
  manualReviewRequired: boolean;
  /** True if an online sync to the resolver was attempted this call. */
  synced: boolean;
  /** Phase 7B-H1: which evidence the reversal effects were proven from. */
  evidenceSource: ReversalEvidenceSource;
};

/** Browser-default dependencies (real IndexedDB store + Firebase resolver callable). */
export function createDefaultReversalCoordinatorDeps(): ReversalCoordinatorDeps {
  return {
    store: createIndexedDbReversalStore(),
    isOnline: () => (typeof navigator !== 'undefined' ? navigator.onLine : true),
    call: async (req) => {
      const callable = await getDefaultCallResolveReversal();
      return callable(req);
    },
  };
}

/**
 * Resolve the reversal's original stock effects + the evidence source they came from,
 * applying the Phase 7B-H1 precedence (all gates run BEFORE any queue write / local
 * mutation, so every rejection is fail-closed):
 *
 *   Case 1 — header evidence present & valid  → use header effects; `header_snapshot`.
 *   Case 2 — header evidence present & invalid → THROW (no fallback — a corrupt/partial
 *            header write is a danger signal that must not be silently ignored).
 *   Case 3 — header evidence absent           → strict legacy item-subcollection gate;
 *            `legacy_subcollection`.
 *   Case 4 — header absent AND legacy invalid → THROW (legacy gate fails closed).
 *
 * "Present" means `headerEvidence != null`; an empty/partial object is present-but-invalid.
 */
function resolveReceivingReversalEffects(
  input: ReceivingReversalInput,
): { originalEffects: OriginalStockEffect[]; evidenceSource: ReversalEvidenceSource } {
  if (input.headerEvidence != null) {
    // Case 1/2 — header present: must validate or fail closed. NEVER falls back.
    return {
      originalEffects: validateReceivingHeaderEvidence(input.headerEvidence, input.branchId),
      evidenceSource: 'header_snapshot',
    };
  }

  // Case 3/4 — no header snapshot (legacy record): strict item-subcollection fallback.
  assertReceivingReversalEvidence(input.items);
  const originalEffects = buildReceivingReversalEffects(input.items, input.branchId);
  if (originalEffects.length === 0) {
    // Defense-in-depth: every line was validated positive above, so this should be
    // unreachable, but it guarantees we never queue an empty correction.
    throw new ReceivingReversalEvidenceError('no_effects', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
  }
  return { originalEffects, evidenceSource: 'legacy_subcollection' };
}

/**
 * Execute a confirmed RECEIVING reversal, queue-first:
 *   1. Resolve + validate the original stock effects, preferring the receiving header's
 *      `reversalEvidence` snapshot over the item subcollection (Phase 7B-H1). Any
 *      missing/malformed evidence fails closed HERE — before any write.
 *   2. `createOfflineReversal` — asserts authority (Staff → throws BEFORE any write),
 *      applies the immediate local IndexedDB stock correction, and durably queues the
 *      intent (atomic), tagging it with the `evidenceSource` for audit.
 *   3. If online — sync the intent to the server resolver. A network error stays a
 *      `retryable_error` (correction preserved); a definitive rejection becomes
 *      `manual_review_required` (fail-closed: no auto-rollback proof is supplied).
 *
 * Never executes instantly — the page only calls this from the modal's confirm.
 */
export async function executeReceivingReversal(
  deps: ReversalCoordinatorDeps,
  input: ReceivingReversalInput,
): Promise<ReceivingReversalOutcome> {
  const queueDeps: QueueDeps | undefined = deps.now ? { now: deps.now } : undefined;

  // Fail-closed evidence gate (Phase 7B-H1): prefer header snapshot, strict legacy
  // fallback only when no header is present; present-but-invalid header rejects.
  const { originalEffects, evidenceSource } = resolveReceivingReversalEffects(input);

  const createInput: CreateReversalInput = {
    // Source doc id (GRN) is globally unique; branch scopes the idempotency key.
    businessId: input.branchId,
    sourceType: 'receiving',
    sourceId: input.receivingId,
    action: input.action ?? 'void',
    createdByStaffId: input.staffId,
    actorRole: input.actorRole,
    branchId: input.branchId,
    reasonCode: input.reason,
    reasonNote: input.note,
    originalEffects,
    evidenceSource,
  };

  // Authority + immediate local correction + durable queue (atomic). A Staff actor
  // throws OfflineReversalRejectedError here — nothing is written or corrected.
  const intent = await createOfflineReversal(deps.store, createInput, queueDeps);

  let current = intent;
  let synced = false;
  if (deps.isOnline()) {
    const result = await syncOneReversal(deps.store, intent.id, deps.call, queueDeps ? { deps: queueDeps } : {});
    synced = result.claimed;
    if (result.intent) current = result.intent;
  }

  return {
    intent: current,
    status: current.status,
    manualReviewRequired: current.status === 'manual_review_required',
    synced,
    evidenceSource,
  };
}
