/**
 * sweeper — repair orphaned `settled` async orders.  [recovery tooling]
 *
 * Symptom this fixes: an `asyncOrders/{id}` doc is `reconcileStatus === 'settled'`
 * but the canonical `orders/{id}` read-model doc is missing.
 *
 * IMPORTANT — this is NOT caused by a partial transaction. `reconcileSale`
 * writes the canonical order AND flips the async doc to `settled` inside ONE
 * `db.runTransaction` (see reconcileOrder.ts), so those two are all-or-nothing.
 * Real causes of an orphan:
 *   1. VOID TOMBSTONE (by design): `handleVoidIntent` sets reconcileStatus
 *      'settled' + status 'voided' and writes no canonical order. EXPECTED —
 *      this sweeper skips `status === 'voided'`.
 *   2. A canonical doc that was later deleted out-of-band.
 *
 * STRATEGY — backfill, never re-reconcile. A `settled` async order already
 * carries the enriched `lines` (fifoCost/lotRefs), `cogs`, `profit` and the
 * original `payments`. We rebuild ONLY the read-model docs (orders/orderItems/
 * payments) from that data. We DO NOT re-run FIFO, stock decrement, credit, or
 * shift roll-up — those side-effects already committed when the order settled,
 * and `FieldValue.increment` is not idempotent, so re-running would double-count.
 *
 * The repair is itself idempotent: it only acts when `orders/{id}` is absent,
 * and that check happens inside the repair transaction.
 */

import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';

const C = {
  asyncOrders: 'asyncOrders',
  orders: 'orders',
  orderItems: 'orderItems',
  payments: 'payments',
} as const;

const roundMoney = (n: number): number => Math.round((n ?? 0) * 100) / 100;

type LotRef = { lotId: string; qty: number; cost: number };
type Payment = { method: string; amount: number; ref?: string | null };
type Line = {
  productId: string;
  productSnap: { name: string; sku: string; category: string; barcode?: string | null };
  unit: string;
  unitFactor: number;
  qty: number;
  qtyBase: number;
  unitPrice: number;
  originalPrice?: number;
  discountAmt: number;
  lineTotal: number;
  fifoCost?: number;
  lotRefs?: LotRef[];
};

/** Outcome of inspecting/repairing a single settled async order. */
export type RepairOutcome =
  | 'repaired'
  | 'skipped_voided'
  | 'already_present'
  | 'unrepairable';

export interface SweepReport {
  scanned: number;
  repaired: string[];
  skippedVoided: number;
  alreadyPresent: number;
  unrepairable: { id: string; reason: string }[];
}

export interface SweepOptions {
  /** When false (default), only report — no writes. Pass true to apply repairs. */
  apply?: boolean;
  /** Optional log sink (defaults to console.log). */
  log?: (msg: string) => void;
}

/**
 * Inspect one settled async order and, if it is a genuine orphan, rebuild its
 * canonical `orders`/`orderItems`/`payments` docs from the settled data.
 * Returns what happened. Writes only when `apply` is true.
 */
export async function repairSettledOrder(
  db: Firestore,
  snap: QueryDocumentSnapshot,
  apply: boolean,
): Promise<RepairOutcome> {
  const order = snap.data() as DocumentData;

  // (1) Void tombstones legitimately have no canonical order.
  if (order.status === 'voided') return 'skipped_voided';

  // The canonical doc id is the `id` FIELD (deterministic), matching reconcileSale.
  const canonicalId = typeof order.id === 'string' && order.id ? order.id : snap.id;
  const lines = Array.isArray(order.lines) ? (order.lines as Line[]) : null;
  if (!lines || lines.length === 0) {
    // A settled non-void order with no enriched lines can't be safely rebuilt.
    return 'unrepairable';
  }

  const canonicalRef = db.collection(C.orders).doc(canonicalId);

  // Fast pre-check outside the tx to avoid opening a tx for the common case.
  if ((await canonicalRef.get()).exists) return 'already_present';
  if (!apply) return 'repaired'; // dry-run: would repair

  let outcome: RepairOutcome = 'repaired';
  await db.runTransaction(async (tx) => {
    // Re-check inside the tx so concurrent settles/repairs can't double-write.
    if ((await tx.get(canonicalRef)).exists) {
      outcome = 'already_present';
      return;
    }

    // Sale time = device clock at sale (matches reconcileSale's createdAt).
    const saleTime =
      order.clientCreatedAt && typeof order.clientCreatedAt === 'number'
        ? Timestamp.fromMillis(order.clientCreatedAt)
        : Timestamp.now();

    const grandTotal = roundMoney(order.total);
    const settledStatus =
      typeof order.status === 'string' ? order.status : 'completed';

    tx.set(canonicalRef, {
      id: canonicalId,
      billId: order.billId,
      branchId: order.branchId,
      customerId: order.customerId ?? null,
      customerSnap: order.customerSnap ?? null,
      staffId: order.staffId,
      staffName: order.staffName,
      shiftId: order.shiftId,
      status: settledStatus,
      subtotal: roundMoney(order.subtotal),
      discountAmt: roundMoney(order.discountAmt ?? 0),
      billDiscount: roundMoney(order.billDiscount ?? 0),
      vatRate: 0,
      vatAmt: 0,
      surcharge: roundMoney(order.fee ?? 0),
      total: grandTotal,
      paidAmt: roundMoney(order.paidAmt),
      changeAmt: roundMoney(order.changeAmt ?? 0),
      creditAmt: order.creditAmt ?? 0,
      cogs: roundMoney(order.cogs ?? 0),
      profit: roundMoney(order.profit ?? 0),
      priceLevelId: order.priceLevelId,
      note: '',
      voidReason: null,
      voidedBy: null,
      voidedAt: null,
      printCount: 0,
      createdAt: saleTime,
      updatedAt: FieldValue.serverTimestamp(),
      asyncOrderId: canonicalId,
      deviceId: order.deviceId ?? null,
      // Provenance: this read-model doc was rebuilt by the sweeper, not the
      // reconciler. Useful for auditing which sales were repaired.
      repairedBySweeper: true,
    });

    const itemsCol = canonicalRef.collection(C.orderItems);
    for (const line of lines) {
      const itemRef = itemsCol.doc();
      tx.set(itemRef, {
        id: itemRef.id,
        productId: line.productId,
        productSnap: line.productSnap,
        unit: line.unit,
        unitFactor: line.unitFactor,
        qty: line.qty,
        qtyBase: line.qtyBase ?? line.qty * line.unitFactor,
        unitPrice: line.unitPrice,
        originalPrice: line.originalPrice ?? line.unitPrice,
        discountAmt: line.discountAmt,
        lineTotal: line.lineTotal,
        fifoCost: line.fifoCost ?? 0,
        lotRefs: line.lotRefs ?? [],
      });
    }

    const payments = Array.isArray(order.payments) ? (order.payments as Payment[]) : [];
    for (const pay of payments) {
      if (!pay || pay.amount <= 0) continue;
      const payRef = db.collection(C.payments).doc();
      tx.set(payRef, {
        id: payRef.id,
        orderId: canonicalId,
        branchId: order.branchId,
        method: pay.method,
        amount: pay.amount,
        ref: pay.ref ?? null,
        createdAt: saleTime,
      });
    }
  });

  return outcome;
}

/**
 * Scan every `settled` async order and repair genuine orphans (settled, not a
 * void tombstone, missing its canonical `orders` doc). Side-effect-free with
 * respect to inventory/credit/shift — see file header.
 *
 * Framework-agnostic: takes a Firestore handle (scoped to the configured
 * database) so it can be called from a local admin script, an onRequest, or an
 * onSchedule wrapper.
 */
export async function sweepStuckOrders(
  db: Firestore,
  opts: SweepOptions = {},
): Promise<SweepReport> {
  const apply = opts.apply ?? false;
  const log = opts.log ?? ((m: string) => console.log(m));

  const report: SweepReport = {
    scanned: 0,
    repaired: [],
    skippedVoided: 0,
    alreadyPresent: 0,
    unrepairable: [],
  };

  // Equality-only filter → no composite index required.
  const snap = await db
    .collection(C.asyncOrders)
    .where('reconcileStatus', '==', 'settled')
    .get();

  log(`[sweeper] ${apply ? 'APPLY' : 'DRY-RUN'} — scanning ${snap.size} settled orders…`);

  for (const doc of snap.docs) {
    report.scanned += 1;
    let outcome: RepairOutcome;
    try {
      outcome = await repairSettledOrder(db, doc, apply);
    } catch (err) {
      report.unrepairable.push({
        id: doc.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      log(`  ✗ ${doc.id} — error: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    switch (outcome) {
      case 'repaired':
        report.repaired.push(doc.id);
        log(`  ${apply ? '✓ repaired' : '→ would repair'} ${doc.id}`);
        break;
      case 'skipped_voided':
        report.skippedVoided += 1;
        break;
      case 'already_present':
        report.alreadyPresent += 1;
        break;
      case 'unrepairable':
        report.unrepairable.push({ id: doc.id, reason: 'settled order has no enriched lines' });
        log(`  ✗ ${doc.id} — unrepairable (no enriched lines)`);
        break;
    }
  }

  log('');
  log('[sweeper] summary');
  log(`  scanned          : ${report.scanned}`);
  log(`  ${apply ? 'repaired         ' : 'would repair     '}: ${report.repaired.length}`);
  log(`  already present  : ${report.alreadyPresent}`);
  log(`  void tombstones  : ${report.skippedVoided}`);
  log(`  unrepairable     : ${report.unrepairable.length}`);

  return report;
}
