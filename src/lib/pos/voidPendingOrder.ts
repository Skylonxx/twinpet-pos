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
 * Submits an offline-first void request for a pending or completed sale.
 * 
 * This merges the approved void fields into the asyncOrders document.
 * - If the device is online, this awaits confirmation from Firestore rules.
 * - If the device is offline, it queues the write and throws a timeout
 *   so the UI can transition to a pending/unresolved state gracefully without hanging.
 */
export async function requestPendingVoid(
  orderId: string,
  input: PendingVoidInput,
  branchId: string,
): Promise<void> {
  if (!isFirebaseConfigured || !db) return;
  const writePromise = setDoc(
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
  );

  const timeoutError = new Error('OFFLINE_TIMEOUT');
  const timeoutPromise = new Promise<void>((_, reject) => 
    setTimeout(() => reject(timeoutError), 5000)
  );

  try {
    await Promise.race([writePromise, timeoutPromise]);
  } catch (err) {
    if (err === timeoutError) {
      // The write is queued locally but not yet acknowledged by the server.
      throw new Error('คำขอยังไม่เสร็จสมบูรณ์ (ออฟไลน์) — กรุณาตรวจสอบประวัติเมื่อออนไลน์อีกครั้ง');
    }
    throw err; // Genuine Firestore rejection
  }
}
