import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../firebase';
import { getDeviceId } from './deviceId';

/**
 * Offline void — Phase A (pending tombstone), Standalone POS Local-First.
 *
 * Voiding an order the terminal still OWNS (i.e. `reconcileStatus ===
 * 'pending_reconcile'`, never settled) is an optimistic `updateDoc` on the
 * local `asyncOrders` doc.
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

/** The exact update fields written onto the pending `asyncOrders` doc. Pure. */
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
 * Submits an offline-first void request for a pending sale.
 * 
 * Uses `updateDoc` to modify the existing `asyncOrders` document.
 * This function returns immediately (fire-and-forget) to ensure the POS UI
 * remains fully unblocked and optimistic, even during network outages.
 * The Firestore SDK will apply the mutation locally and queue the write.
 */
export function requestPendingVoid(
  orderId: string,
  input: PendingVoidInput,
): Promise<void> {
  if (!isFirebaseConfigured || !db) return Promise.resolve();
  return updateDoc(
    doc(db, 'asyncOrders', orderId),
    {
      ...buildPendingVoidFields(input),
      deviceId: getDeviceId(),
      voidedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }
  );
}
