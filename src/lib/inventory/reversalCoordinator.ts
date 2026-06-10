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
  ReversalSourceType,
} from '../pos/offline/offlineReversalTypes';

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
  | 'missing_items'
  | 'empty_items'
  | 'missing_product_id'
  | 'missing_lot_id'
  | 'non_finite_qty'
  | 'non_positive_qty'
  | 'no_effects';

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

/** Everything the page supplies to reverse a receiving. */
export type ReceivingReversalInput = {
  receivingId: string;
  branchId: string;
  actorRole: ReversalActorRole;
  staffId: string;
  reason: string;
  note?: string;
  items: readonly ReceivingReversalItem[];
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
 * Execute a confirmed RECEIVING reversal, queue-first:
 *   1. `createOfflineReversal` — asserts authority (Staff → throws BEFORE any
 *      write), applies the immediate local IndexedDB stock correction, and durably
 *      queues the intent (atomic).
 *   2. If online — sync the intent to the server resolver. A network error stays a
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

  // Fail-closed evidence gate (Track A blocker): refuse BEFORE any local stock
  // correction or durable queue write when the receiving item/lot evidence is
  // missing, empty, or malformed. All-or-nothing — one bad line rejects the set.
  assertReceivingReversalEvidence(input.items);
  const originalEffects = buildReceivingReversalEffects(input.items, input.branchId);
  if (originalEffects.length === 0) {
    // Defense-in-depth: every line was validated positive above, so this should be
    // unreachable, but it guarantees we never queue an empty correction.
    throw new ReceivingReversalEvidenceError('no_effects', RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE);
  }

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
  };
}
