import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../firebase';
import { getDeviceId } from './deviceId';

/**
 * Offline void — Phase A (pending tombstone), Standalone POS Local-First.
 *
 * Voiding an order the terminal still OWNS (i.e. `reconcileStatus ===
 * 'pending_reconcile'`, never settled) is just a queueable merge-write on the
 * local `asyncOrders` doc — no `runTransaction`, no canonical `orders` doc, no
 * stock/lot/credit reversal (there is nothing applied yet to reverse).
 *
 * Because all POS read surfaces derive from the local ledger and exclude voided
 * sales (`isLedgerSale`), flipping the local doc removes the order from the
 * drawer + dashboard totals INSTANTLY and offline. On the next flush the
 * `reconcileOrder` trigger routes `voidRequested` → `handleVoidIntent`, which
 * tombstones the still-pending doc (writes no canonical order, no side-effects).
 *
 * Scope: pending orders only. A SETTLED order requires server-side reversal —
 * that is Phase 7 (`handleVoidIntent`'s settled branch) and is NOT handled here;
 * the canonical back-office void (`voidOrderSafe`) remains for settled sales.
 */

export type PendingVoidInput = {
  reason: string;
  note?: string;
  voidedBy: string;
};

/** The exact merge fields written onto the pending `asyncOrders` doc. Pure. */
export type PendingVoidFields = {
  voidRequested: true;
  status: 'voided';
  voidReason: string;
  voidedBy: string;
};

/**
 * Build the void merge fields. `voidReason` combines reason + optional note as
 * `"reason — note"` (matching the canonical `voidOrder.ts`). Timestamps are added
 * by the impure writer so this stays pure and unit-testable.
 */
export function buildPendingVoidFields(input: PendingVoidInput): PendingVoidFields {
  const note = input.note?.trim();
  const voidReason = note ? `${input.reason} — ${note}` : input.reason;
  return {
    voidRequested: true,
    status: 'voided',
    voidReason,
    voidedBy: input.voidedBy,
  };
}

/**
 * Fire the void intent: a SINGLE queueable `setDoc(..., { merge: true })` on the
 * local `asyncOrders` doc. Fire-and-forget (never awaited) so an offline cashier
 * is never blocked — it commits to `persistentLocalCache` immediately and flushes
 * on reconnect. Dev (no Firebase) has no async cache to mutate → no-op.
 *
 * Why `setDoc(merge)` and not `updateDoc`: `updateDoc` REQUIRES the target doc to
 * already exist, so OFFLINE it silently does nothing when `asyncOrders/{id}` is
 * not in this device's cache (a synced bill rung on another device, an old
 * canonical-only order, or a cleared cache) — the cashier sees no effect.
 * `setDoc(merge)` materialises the doc locally either way, so the void always
 * commits offline and the overlay listener (scoped to `branchId` + `deviceId`)
 * surfaces it on screen immediately. For an existing settled doc the merge is a
 * no-op on its data fields; the reconciler still routes `voidRequested` →
 * `handleVoidIntent` for the server-side reversal on reconnect.
 */
export function requestPendingVoid(
  orderId: string,
  input: PendingVoidInput,
  branchId: string,
): void {
  if (!isFirebaseConfigured || !db) return;
  void setDoc(
    doc(db, 'asyncOrders', orderId),
    {
      ...buildPendingVoidFields(input),
      // branchId + deviceId let this device's overlay listener pick the intent up
      // offline (so the bill flips on screen at once); on an existing doc these
      // already match, so the merge leaves them unchanged.
      branchId,
      deviceId: getDeviceId(),
      voidedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  ).catch((err) => {
    console.warn('[voidPending] void-intent not yet acked (queued, will retry)', err);
  });
}
