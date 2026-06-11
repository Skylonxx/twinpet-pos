/**
 * Offline Reversal Queue — shared types  [Phase 7B-3D-3]
 *
 * The client-side counterpart of the server `resolveReversal` resolver
 * (functions/src/resolveReversal.ts, Phase 7B-3D-2). When a cashier voids /
 * reverses a Goods-Receiving or branch Transfer while offline (or simply
 * optimistically), we must:
 *
 *   1. correct the device's LOCAL stock immediately (so selling can continue
 *      against accurate numbers), and
 *   2. durably queue the reversal INTENT so it survives reload/crash and later
 *      syncs to the authoritative server resolver.
 *
 * These types are intentionally pure data (no I/O, no Firestore types) so the
 * logic layer (offlineReversalLogic.ts) and the orchestration layer
 * (offlineReversalQueue.ts) can be unit-tested without a browser/IndexedDB.
 *
 * INTEGRATION (Phase 7B Post-Commit Track A): this engine is now wired into the
 * live destructive flows — `ReceivingEditPage` routes a confirmed void through
 * `executeReceivingReversal` (queue-first), and the POS grid surfaces the immediate
 * local correction via the read-only overlay in `offline/reversalStockOverlay.ts`
 * (`inventoryRepository` adds pending reversal deltas on top of the Firestore
 * `productStocks` snapshot). Completed-transfer queue-first reversal remains deferred
 * (the page keeps the legacy `cancelBranchTransfer` behind a confirmation gate).
 */

/** Actor roles, mirroring the client `UserRole` (src/lib/types.ts). Only Manager/Admin
 *  may create an offline reversal — see the authority guard in offlineReversalLogic.ts. */
export type ReversalActorRole = 'admin' | 'manager' | 'staff';

/** The two source-document kinds the server resolver supports (see resolveReversal.ts). */
export type ReversalSourceType = 'receiving' | 'transfer';

/** The destructive intent the cashier expressed. `void` and `reverse` both map to
 *  a server `*_reversal` actionType; we keep the user's word for the audit trail. */
export type ReversalAction = 'void' | 'reverse';

/**
 * Which evidence the reversal's stock effects were derived from (Phase 7B-H1):
 *  - `header_snapshot`      — the receiving header's `reversalEvidence` (preferred).
 *  - `legacy_subcollection` — strict fallback to the item subcollection (pre-H1 records).
 * Recorded on the intent for audit so a reviewer can see how the effects were proven.
 */
export type ReversalEvidenceSource = 'header_snapshot' | 'legacy_subcollection';

/**
 * Durable lifecycle of a queued intent. This is the LOCAL queue status — distinct
 * from the server's own `ReversalStatus`. The mapping server→queue is performed by
 * {@link classifyServerResult} in the logic layer.
 *
 *  - `queued`                  — created locally, stock corrected, awaiting sync.
 *  - `syncing`                 — claimed by a sync worker (lock; prevents double send).
 *  - `server_accepted`         — server confirmed (or duplicate-confirmed). Done.
 *  - `server_rejected`         — server rejected AND local correction was safely
 *                                rolled back. Terminal.
 *  - `manual_review_required`  — server rejected but rollback was unsafe (later local
 *                                activity depends on the corrected stock) OR the
 *                                server itself asked for manual reconciliation.
 *  - `manual_review_resolved`  — (Phase 7B-H2) a Manager/Admin has operationally
 *                                reconciled the rejected/conflicted intent (e.g. in
 *                                Firestore) and explicitly cleared the LOCAL manual-
 *                                review state. TERMINAL and overlay-excluded, so the
 *                                POS overlay drops the delta and returns to tracking
 *                                the authoritative Firestore snapshot. The local
 *                                correction history is preserved (NOT rolled back).
 *  - `retryable_error`         — transient (network/transport/server_error). Local
 *                                correction stays applied; retry later.
 */
export type OfflineReversalStatus =
  | 'queued'
  | 'syncing'
  | 'server_accepted'
  | 'server_rejected'
  | 'manual_review_required'
  | 'manual_review_resolved'
  | 'retryable_error';

/**
 * Phase 7B-H2 — audit record of a manual-review resolution. Stamped on the intent
 * when a Manager/Admin operationally clears a `manual_review_required` state (after
 * reconciling the authoritative store). It records WHO cleared it, WHEN, and WHY; it
 * is an operator-declared action (not server-verified) and does NOT roll back or
 * invert the local stock correction — it only transitions the intent out of overlay.
 */
export type ManualReviewResolution = {
  /** ISO time the manual-review state was cleared (from the injected clock). */
  resolvedAt: string;
  /** Id of the Manager/Admin who resolved it. */
  resolvedByStaffId: string;
  /** Verified role of the resolver (manager | admin — staff cannot resolve). */
  resolvedByRole: ReversalActorRole;
  /** Required reason code for the audit trail. */
  reasonCode: string;
  /** Optional free-text note. */
  note?: string;
};

/**
 * One signed correction to a local stock counter. `delta` is what we ADD to the
 * device's local `totalStockBase` for (product, location). Reversing a receiving
 * yields negative deltas at the receiving branch; reversing a transfer yields a
 * negative delta at the destination and a positive delta back at the source.
 *
 * `lotId` is carried for audit fidelity only — the local correction is tracked at
 * product×location granularity, so the queue's internal `stock` counter is keyed by
 * product+location and lot-level deltas are summed in. (That internal counter is
 * bookkeeping, NOT what the POS grid reads: the grid reads the Firestore
 * `productStocks` snapshot, onto which `offline/reversalStockOverlay.ts` overlays
 * these pending deltas — see `inventoryRepository`.)
 */
export type LocalStockDelta = {
  productId: string;
  locationId: string;
  lotId?: string | null;
  /** Signed quantity (base units) to add to the local counter. */
  delta: number;
};

/**
 * The ORIGINAL stock effect of the source document, as it was applied to local
 * stock when the document was first completed. The reversal correction is simply
 * the negation of these (see {@link computeReversalDelta}).
 */
export type OriginalStockEffect = {
  productId: string;
  locationId: string;
  lotId?: string | null;
  /** Signed quantity originally applied to the local counter (e.g. +5 on receiving). */
  quantity: number;
};

/** Deterministic identity triple derived from the source document (see deriveReversalIds). */
export type ReversalIds = {
  /** IndexedDB primary key + stable intent id. */
  id: string;
  /** Stable string handed to the server resolver; the server hashes it for its ledger. */
  idempotencyKey: string;
  /** Local idempotency anchor — guards against double stock application on replay. */
  localMutationId: string;
};

/** Everything the caller must supply to create an offline reversal intent. */
export type CreateReversalInput = {
  businessId: string;
  sourceType: ReversalSourceType;
  sourceId: string;
  action: ReversalAction;
  createdByStaffId: string;
  /** Verified role of the actor. Staff is rejected before any local write (Blocker 2). */
  actorRole: ReversalActorRole;
  branchId: string;
  reasonCode: string;
  reasonNote?: string;
  terminalId?: string;
  /** The original local stock effects to be reversed (negated into the correction). */
  originalEffects: OriginalStockEffect[];
  /** Phase 7B-H1: how those effects were proven (header snapshot vs legacy subcollection). */
  evidenceSource?: ReversalEvidenceSource;
  /**
   * Phase 7B-H5: the source document's `updatedAt` as the client observed it when
   * capturing this reversal (ISO 8601). Threaded to the server resolver as
   * `clientObservedDocumentUpdatedAt` to drive the H4 stale-client guard. Optional —
   * omitted when the loaded document carries no convertible `updatedAt`.
   */
  observedDocumentUpdatedAt?: string | null;
};

/** Bookkeeping of the local correction attached to an intent. */
export type LocalCorrection = {
  /** True once the stock delta has been applied to local counters. */
  applied: boolean;
  /** True once a (safe) rollback has reversed the correction. */
  reversed: boolean;
  /** The exact deltas that were/will be applied. */
  stockDelta: LocalStockDelta[];
};

/**
 * The durable queue record. Shape follows the brief's conceptual model, adapted to
 * the codebase (ISO string timestamps like asyncCheckout, explicit reason fields
 * like the server resolver).
 */
export type OfflineReversalIntent = {
  id: string;
  businessId: string;
  sourceType: ReversalSourceType;
  sourceId: string;
  action: ReversalAction;
  branchId: string;
  reasonCode: string;
  reasonNote?: string | null;
  terminalId?: string | null;
  createdAt: string;
  createdByStaffId: string;
  /** Verified role at creation time (always manager/admin — staff cannot queue). */
  createdByRole: ReversalActorRole;
  idempotencyKey: string;
  localMutationId: string;
  /** Phase 7B-H1: evidence the reversal effects were derived from (audit trail). */
  evidenceSource?: ReversalEvidenceSource;
  /**
   * Phase 7B-H5: source document `updatedAt` observed at capture (ISO 8601). Persisted
   * durably so a later sync (possibly long after going offline) sends the SAME observed
   * value to the resolver as `clientObservedDocumentUpdatedAt`. Absent on legacy intents.
   */
  observedDocumentUpdatedAt?: string | null;
  /** ISO time the local stock correction was applied (set inside the create txn). */
  localAppliedAt?: string;
  status: OfflineReversalStatus;
  /** Raw server response, kept verbatim for audit / Manager reconciliation. */
  serverResult?: unknown;
  /** Server reject code preserved for manual review. */
  rejectionCode?: string;
  /** Human-readable error/rejection message preserved for manual review. */
  errorMessage?: string;
  /** ISO time of the last status transition driven by a sync attempt. */
  lastSyncedAt?: string;
  // ── Recoverable sync lease (Blocker 1) — lets a crashed `syncing` claim be
  //    safely reclaimed once its lease expires, so an item is never stranded. ──
  /** Worker that currently holds the sync claim (null when unclaimed). */
  syncLeaseOwner?: string | null;
  /** ISO time the current sync claim expires; past/absent ⇒ reclaimable. */
  syncLeaseExpiresAt?: string | null;
  /** Monotonic count of claim attempts (diagnostics / backoff). */
  syncAttempt?: number;
  /** ISO time of the last claim attempt. */
  lastSyncAttemptAt?: string;
  /** Phase 7B-H2: audit of a manual-review resolution (set when status → manual_review_resolved). */
  manualReviewResolution?: ManualReviewResolution;
  localCorrection: LocalCorrection;
};

/** Append-only local ledger row — one per applied/reversed counter mutation. */
export type LocalStockLedgerRow = {
  id: string;
  intentId: string;
  productId: string;
  locationId: string;
  lotId?: string | null;
  direction: 'apply' | 'reverse';
  delta: number;
  /** Counter value AFTER this row was applied. */
  resultingQuantity: number;
  createdAt: string;
};

/** Local mutation marker — the idempotency guard keyed by `localMutationId`. */
export type LocalMutationMarker = {
  localMutationId: string;
  intentId: string;
  /** True once the stock correction was applied — blocks any second application. */
  applied: boolean;
  appliedAt: string;
  /** True once the server confirmed the reversal (`server_confirmed`). */
  serverConfirmed: boolean;
  /** True once a safe rollback reversed the local correction. */
  reversed: boolean;
};

/** A single local stock counter (product × location). */
export type LocalStockCounter = {
  productId: string;
  locationId: string;
  quantity: number;
};
