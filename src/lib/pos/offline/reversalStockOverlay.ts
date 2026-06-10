/**
 * POS-visible Offline Reversal Stock Overlay  [Phase 7B Post-Commit Track A]
 *
 * The POS grid reads its stock from the authoritative Firestore `productStocks`
 * snapshot (`inventoryRepository.getInventorySnapshot`). The offline reversal queue,
 * however, applies an IMMEDIATE local stock correction the instant a Manager/Admin
 * voids a receiving/transfer — and that correction lives only in the queue's own
 * IndexedDB store, NOT in Firestore. Without an overlay, the "immediate local
 * correction" the queue advertises would be invisible to the cashier until the
 * server resolver synced and Firestore caught up.
 *
 * This module closes that gap. It derives, from the durable intent queue, the net
 * pending reversal delta per product at a branch, so the repository can present:
 *
 *     POS-visible stock = Firestore productStocks snapshot + pending reversal deltas
 *
 * WHY DERIVE FROM INTENTS (and not the queue's `stock` counter store):
 *   The queue's `stock` counters are internal bookkeeping (seeded at 0, accumulating
 *   signed corrections) and carry no status. Deriving from intents lets us include
 *   ONLY the statuses whose correction is still the device's best local truth, and —
 *   critically — EXCLUDE `server_accepted`, where Firestore is becoming authoritative
 *   (see double-count note below). It also naturally excludes a safely rolled-back
 *   correction (`localCorrection.reversed === true`).
 */

import { listQueue } from './offlineReversalQueue';
import { createIndexedDbReversalStore, type ReversalLocalStore } from './reversalLocalStore';
import type { OfflineReversalIntent, OfflineReversalStatus } from './offlineReversalTypes';

/**
 * Queue statuses whose local correction must be OVERLAID on the Firestore snapshot.
 *
 *  - `queued` / `syncing` / `retryable_error` — not yet server-confirmed; the local
 *    correction is the device's only record of the reversal, so it MUST be visible.
 *  - `manual_review_required` — server rejected but rollback was unsafe (or the server
 *    asked for manual reconciliation): the local correction REMAINS APPLIED, so it must
 *    stay visible until a human reconciles it.
 *
 * Deliberately EXCLUDED:
 *  - `server_accepted` — the server has accepted the reversal and is now authoritative;
 *    Firestore `productStocks` will reflect it. There is NO reliable local "Firestore has
 *    caught up" marker yet, so keeping the overlay here would risk a PERMANENT double
 *    correction (overlay delta + Firestore already-reversed value). We conservatively drop
 *    the overlay at `server_accepted` and rely on Firestore. The trade-off is a transient
 *    UNDER-correction in the brief window between server-accept and the next snapshot
 *    refresh — preferred over a permanent double-count.
 *  - `server_rejected` — the correction was safely rolled back (`reversed === true`); the
 *    `applied && !reversed` guard below excludes it regardless.
 */
export const POS_OVERLAY_STATUSES: ReadonlySet<OfflineReversalStatus> = new Set([
  'queued',
  'syncing',
  'retryable_error',
  'manual_review_required',
]);

/**
 * An intent contributes to the overlay only if its status is overlay-eligible AND its
 * local correction is currently applied and not rolled back. This single guard makes a
 * reversed correction (safe rollback) drop out even if its status were eligible.
 */
export function isOverlayEligible(intent: OfflineReversalIntent): boolean {
  return (
    POS_OVERLAY_STATUSES.has(intent.status) &&
    intent.localCorrection.applied === true &&
    intent.localCorrection.reversed === false
  );
}

/**
 * Pure: net pending reversal delta per `productId` for `branchId`. Sums the signed
 * `localCorrection.stockDelta` of every overlay-eligible intent, keeping only deltas at
 * this branch. Deterministic; safe to unit-test without IndexedDB.
 *
 * Idempotency note: each intent's id is deterministic (`deriveReversalIds`) and the queue
 * stores at most ONE record per (source doc, action), so a given reversal's delta appears
 * exactly once here — the same correction can never be summed twice.
 */
export function buildReversalOverlay(
  intents: readonly OfflineReversalIntent[],
  branchId: string,
): Map<string, number> {
  const overlay = new Map<string, number>();
  for (const intent of intents) {
    if (!isOverlayEligible(intent)) continue;
    for (const d of intent.localCorrection.stockDelta) {
      if (d.locationId !== branchId) continue;
      if (!d.delta) continue;
      overlay.set(d.productId, (overlay.get(d.productId) ?? 0) + d.delta);
    }
  }
  return overlay;
}

/**
 * Read overlay-eligible pending reversal deltas from the durable queue. FAIL-SAFE: if the
 * local store is unavailable (SSR / no IndexedDB) or the read throws, returns an EMPTY
 * overlay so the POS snapshot degrades to plain Firestore stock rather than breaking. Reads
 * only — never mutates the queue or its IndexedDB stores.
 */
export async function readReversalOverlay(
  branchId: string,
  store: ReversalLocalStore = createIndexedDbReversalStore(),
): Promise<Map<string, number>> {
  try {
    const intents = await listQueue(store);
    return buildReversalOverlay(intents, branchId);
  } catch (err) {
    console.warn('[reversalStockOverlay] local reversal queue unavailable — overlay skipped', err);
    return new Map();
  }
}
