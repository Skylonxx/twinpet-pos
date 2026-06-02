/**
 * reconcileOrder — server-side settlement of offline-first sales.  [STEP-1 SHELL]
 *
 * The client writes an `asyncOrders/{orderId}` doc with ONLY queueable ops (no
 * transaction, no server reads) so the sale commits offline and flushes on
 * reconnect. THIS function is the single authoritative consistency boundary: it
 * applies FIFO lot cutting, stock decrement, credit posting and shift roll-ups
 * that could not be done safely on the client.
 *
 * Design invariants (see OFFLINE_CHECKOUT_ANALYSIS.md):
 *  - IDEMPOTENT: triggers are at-least-once; the doc id is the idempotency key.
 *    Re-delivery of an already-`settled` order is a no-op.
 *  - CLIENT-AUTHORITATIVE NUMBER: we NEVER renumber `billId`.
 *  - NEGATIVE STOCK TOLERATED: oversell is allowed, recorded, and flagged for audit.
 *
 * ⚠️ This file is the STRUCTURE / LOGIC FLOW only. Heavy logic (FIFO planning,
 * credit posting) is pseudo-coded with TODOs to be filled in Step P1.
 */

import { onDocumentWritten, type FirestoreEvent, type Change, type DocumentSnapshot } from 'firebase-functions/v2/firestore';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
// initializeApp() is already called in index.ts (same deployment).

const db = getFirestore();

// ── Minimal local shapes (functions package is independent of the web app) ──
type ReconcileStatus = 'pending' | 'settled' | 'exception';

type AsyncOrderDoc = {
  id: string;
  billId: string;
  branchId: string;
  shiftId: string;
  staffId: string;
  customerId: string | null;
  lines: Array<{ productId: string; qtyBase: number; unitPrice: number; qty: number }>;
  payments: Array<{ method: string; amount: number }>;
  creditAmt: number;
  reconcileStatus: ReconcileStatus;
  voidRequested?: boolean;
};

/**
 * Trigger on WRITE (create + update) so we catch both the initial sale and a
 * later offline void-intent flag on the same doc.
 */
export const reconcileOrder = onDocumentWritten(
  'asyncOrders/{orderId}',
  async (event: FirestoreEvent<Change<DocumentSnapshot> | undefined, { orderId: string }>) => {
    const after = event.data?.after;
    if (!after?.exists) return; // deleted — nothing to do
    const order = { id: after.id, ...(after.data() as Omit<AsyncOrderDoc, 'id'>) };

    // ── Fast idempotency / routing gate (cheap, before any transaction) ──
    if (order.voidRequested) {
      await handleVoidIntent(order);
      return;
    }
    if (order.reconcileStatus !== 'pending') {
      return; // already settled or in exception — re-delivery no-op
    }

    try {
      await reconcileSale(order);
    } catch (err) {
      // Mark exception; a scheduled sweeper (separate fn) retries/escalates.
      await after.ref.set(
        {
          reconcileStatus: 'exception' as ReconcileStatus,
          reconcileError: err instanceof Error ? err.message : String(err),
          reconciledAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      // Re-throw so Cloud Functions records the failure (and retries if configured).
      throw err;
    }
  },
);

/**
 * Apply one sale atomically, server-side. Mirrors the OLD `completePosSale`
 * transaction, but here the server always has connectivity, so concurrency is
 * safe to serialize per stock doc.
 */
async function reconcileSale(order: AsyncOrderDoc): Promise<void> {
  await db.runTransaction(async (tx) => {
    const orderRef = db.collection('asyncOrders').doc(order.id);

    // ── Phase 1: reads (all tx.get before any write) ──
    const orderSnap = await tx.get(orderRef);
    // IDEMPOTENCY guard INSIDE the transaction — re-delivery races settle here.
    if ((orderSnap.data()?.reconcileStatus as ReconcileStatus) === 'settled') return;

    const shiftRef = db.collection('shifts').doc(order.shiftId);
    const shiftSnap = await tx.get(shiftRef);

    // For each distinct product: read productStock + product + active FIFO lots.
    //   const stockSnap   = await tx.get(productStock(branchId, productId));
    //   const productSnap = await tx.get(product(productId));
    //   const lots        = await readActiveLots(tx, productId, branchId); // ordered FIFO
    // (Note: collection *queries* can't run inside a tx — pre-read lot refs
    //  outside the tx and tx.get each ref, exactly as completePosSale does.)

    // Optional: customer + creditAccount when order.creditAmt > 0.

    // ── Phase 2: validate & plan (pure, in-memory) ──
    // - Confirm shift exists/open (or attach to the right shift).
    // - For each line: FIFO-cut from lots (reuse planFifoCutFromState).
    //     * If lots run out AND negative stock tolerated → push an OVERSELL cut
    //       (OVERSELL_LOT_ID) and set hadOversell = true.  ← agreed policy
    // - Compute per-line fifoCost, order cogs, profit.
    // - Compute shift payment deltas (cash/qr/kbank/card/credit) from payments.
    void shiftSnap;

    // ── Phase 3: writes ──
    // - Write enriched orderItems (with fifoCost + lotRefs) under the order.
    // - Decrement each productStock.totalStockBase (may go negative — tolerated).
    // - Decrement consumed lot.qtyRemaining / mark depleted; write StockMovements
    //   (incl. an oversell movement when applicable, for audit).
    // - Post credit: creditAccount balance + creditTransaction (if creditAmt > 0).
    // - Roll up shift expected totals (+ bill count) onto the shift doc.
    // - Finalize the order:
    tx.set(
      orderRef,
      {
        reconcileStatus: 'settled' as ReconcileStatus,
        reconciledAt: FieldValue.serverTimestamp(),
        // cogs, profit, hadOversell, serverCreatedAt (if first settle) ...
      },
      { merge: true },
    );
  });
}

/**
 * Offline-safe void. A `pending` order is cancelled BEFORE it ever settles
 * (no stock side-effects to reverse); a `settled` order is reversed (restock +
 * reverse shift/credit), reusing the existing void logic server-side.
 */
async function handleVoidIntent(order: AsyncOrderDoc): Promise<void> {
  await db.runTransaction(async (tx) => {
    const orderRef = db.collection('asyncOrders').doc(order.id);
    const snap = await tx.get(orderRef);
    const status = snap.data()?.reconcileStatus as ReconcileStatus | undefined;

    if (status === 'pending') {
      // Never applied → just tombstone it; reconcileSale will skip a voided order.
      tx.set(
        orderRef,
        { status: 'voided', reconcileStatus: 'settled', voidedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return;
    }
    if (status === 'settled') {
      // TODO P5: reverse stock movements + lot restock + shift/credit deltas,
      // then mark status: 'voided'. Must itself be idempotent (guard on voidedAt).
    }
  });
}

// TODO (separate fn): scheduled `sweepStuckOrders` — re-run reconcile for orders
// stuck in `pending`/`exception` beyond an SLA, and alert on stale devices.
