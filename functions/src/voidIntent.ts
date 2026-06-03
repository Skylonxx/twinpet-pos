import {
  FieldValue,
  type DocumentData,
  type DocumentReference,
  type Firestore,
} from 'firebase-admin/firestore';
import {
  OVERSELL_LOT_ID,
  planCreditReversal,
  planLotRestocks,
  planStockRestores,
  type CreditAccountData,
} from './voidReversal';

/**
 * Offline-safe void handler (extracted from reconcileOrder.ts for testability —
 * `db` is INJECTED so it runs against a fake Firestore in unit tests, with no
 * emulator). The `reconcileOrder` trigger calls `handleVoidIntent(db, ref)`.
 *
 *  - `pending_reconcile` → tombstone BEFORE it ever settles (no side-effects yet).
 *  - `settled`           → reverse the applied side-effects (Phase 7 / Phase B).
 *
 * Single transaction, idempotent (guarded by `voidReconciled`), at-least-once
 * trigger safe. CRITICAL: it must NEVER touch `shifts.expected*` — the terminal
 * is the single writer of its drawer and its local ledger already drops a voided
 * order (drawer single-writer, Phase 3/4).
 */

const C = {
  products: 'products',
  productStocks: 'productStocks',
  stockLots: 'stockLots',
  stockMovements: 'stockMovements',
  customers: 'customers',
  creditAccounts: 'creditAccounts',
  creditTransactions: 'creditTransactions',
  orders: 'orders',
  auditLogs: 'auditLogs',
} as const;

type ReconcileStatus = 'pending_reconcile' | 'settled' | 'exception';
type VoidLotRef = { lotId: string; qty: number; cost?: number };
type VoidLine = { productId: string; qtyBase: number; lotRefs?: VoidLotRef[] };
type VoidIntentOrder = {
  id: string;
  branchId: string;
  staffId: string;
  customerId: string | null;
  creditAmt: number;
  total: number;
  reconcileStatus: ReconcileStatus;
  voidRequested?: boolean;
  voidReconciled?: boolean;
  voidReason?: string | null;
  voidedBy?: string | null;
  lines: VoidLine[];
};

export async function handleVoidIntent(
  db: Firestore,
  orderRef: DocumentReference,
): Promise<void> {
  await db.runTransaction(async (tx) => {
    // ── Reads (all before any write, per Firestore tx rules) ──
    const snap = await tx.get(orderRef);
    if (!snap.exists) return;
    const order = snap.data() as VoidIntentOrder;

    if (order.reconcileStatus === 'pending_reconcile') {
      // Never applied → tombstone so reconcileSale skips it entirely.
      tx.set(
        orderRef,
        {
          status: 'voided',
          reconcileStatus: 'settled' satisfies ReconcileStatus,
          voidedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return;
    }

    // Only a SETTLED order needs reversal; `exception` (or anything else) is left
    // for the exception sweeper — there is nothing safely reversible here.
    if (order.reconcileStatus !== 'settled') return;
    // Idempotency guard — re-delivery / double-trigger must not re-reverse.
    if (order.voidReconciled === true) return;

    // Read the credit account up-front (needed to recompute the clamped balance).
    let credData: CreditAccountData | null = null;
    let credRef: DocumentReference | null = null;
    let custRef: DocumentReference | null = null;
    if (order.creditAmt > 0 && order.customerId) {
      credRef = db.collection(C.creditAccounts).doc(order.customerId);
      custRef = db.collection(C.customers).doc(order.customerId);
      const credSnap = await tx.get(credRef);
      if (credSnap.exists) {
        const d = credSnap.data() as DocumentData;
        credData = {
          creditUsed: (d.creditUsed as number) ?? 0,
          creditLimit: (d.creditLimit as number) ?? 0,
        };
      }
    }

    // ── Plan (pure; unit-tested in voidReversal.test.ts) ──
    const lotRestocks = planLotRestocks(order.lines);
    const stockRestores = planStockRestores(order.lines);
    const creditReversal = planCreditReversal(order.creditAmt, credData);
    const voidedBy = order.voidedBy ?? order.staffId;
    const voidReason = order.voidReason ?? null;

    // ── Writes ──
    // 1. Restock FIFO lots (oversell virtual lot already filtered out).
    for (const r of lotRestocks) {
      tx.set(
        db.collection(C.stockLots).doc(r.lotId),
        {
          qtyRemaining: FieldValue.increment(r.qty),
          isDepleted: false,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    // 2. Restore per-branch product stock.
    for (const s of stockRestores) {
      tx.set(
        db.collection(C.products).doc(s.productId).collection(C.productStocks).doc(order.branchId),
        {
          branchId: order.branchId,
          totalStockBase: FieldValue.increment(s.qtyBase),
          lastMovementAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    // 3. Reversal stock movements (audit trail; mirrors the 'sale' rows).
    for (const line of order.lines) {
      const moveRef = db.collection(C.stockMovements).doc();
      const cost =
        line.lotRefs?.find((l) => l.lotId !== OVERSELL_LOT_ID)?.cost ??
        line.lotRefs?.[0]?.cost ??
        0;
      tx.set(moveRef, {
        id: moveRef.id,
        productId: line.productId,
        branchId: order.branchId,
        type: 'void',
        qty: line.qtyBase ?? 0,
        costPerUnit: cost,
        refId: order.id,
        refType: 'order',
        note: voidReason ?? '',
        createdBy: voidedBy,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    // 4. Reverse credit: clamp `creditUsed`, restore `creditBalance`, draw down the
    //    customer's outstanding balance, and write a reversal credit transaction.
    if (creditReversal && credRef && custRef) {
      tx.update(credRef, {
        creditUsed: creditReversal.newCreditUsed,
        creditBalance: creditReversal.newCreditBalance,
        lastTransAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(custRef, {
        outstandingBalance: FieldValue.increment(-creditReversal.outstandingDecrement),
        updatedAt: FieldValue.serverTimestamp(),
      });
      const creditTxRef = db.collection(C.creditTransactions).doc();
      tx.set(creditTxRef, {
        id: creditTxRef.id,
        customerId: order.customerId,
        branchId: order.branchId,
        // Map to 'payment' (an existing reversal type) — matches the canonical
        // voidOrder.ts path and renders cleanly in the back-office credit history
        // ("ชำระ / ชำระแล้ว"); 'void' is not a CreditTransactionType.
        type: 'payment',
        amount: -order.creditAmt,
        balance: creditReversal.newCreditBalance,
        refOrderId: order.id,
        note: `ยกเลิกบิล ${order.id}`,
        createdBy: voidedBy,
        createdAt: FieldValue.serverTimestamp(),
        dueDate: null,
        isPaid: true,
        paidAt: FieldValue.serverTimestamp(),
      });
    }

    // ───────────────────────────────────────────────────────────────────────
    // TODO: Future CRM Reversal — NOT YET IMPLEMENTED (per directive).
    // ───────────────────────────────────────────────────────────────────────
    // At settlement, reconcileSale() INCREMENTS the customer's CRM lifetime stats
    // (`lifetimeValue` and `totalSpent` both += the order's grandTotal, and
    // `lastVisitAt` is bumped). Voiding a settled sale should symmetrically
    // REVERSE those, or lifetime metrics over-count voided sales. When CRM is
    // activated, add HERE (inside this same transaction, using `custRef`):
    //
    //   if (order.customerId && custRef) {
    //     tx.update(custRef, {
    //       lifetimeValue: FieldValue.increment(-grandTotal),  // grandTotal = roundMoney(order.total)
    //       totalSpent:    FieldValue.increment(-grandTotal),
    //       updatedAt:     FieldValue.serverTimestamp(),
    //       // NOTE: `lastVisitAt` is monotonic/derived — do NOT roll it back here.
    //       // NOTE: loyalty points are feature-flagged off; reverse them too once enabled.
    //     });
    //   }
    //
    // Guard: this must run exactly once — protected by the `voidReconciled` check.
    // ───────────────────────────────────────────────────────────────────────

    // 5. Mark the canonical order voided so back-office/HQ reflects it.
    tx.set(
      db.collection(C.orders).doc(order.id),
      {
        status: 'voided',
        voidReason,
        voidedBy,
        voidedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // 6. Audit log.
    const auditRef = db.collection(C.auditLogs).doc();
    tx.set(auditRef, {
      id: auditRef.id,
      collection: 'asyncOrders',
      docId: order.id,
      action: 'void',
      before: { status: 'settled', total: order.total },
      after: { status: 'voided', voidReason },
      reason: voidReason,
      changedBy: voidedBy,
      changedAt: FieldValue.serverTimestamp(),
    });

    // 7. Flip the idempotency flag on the async source (stays `settled`).
    tx.set(
      orderRef,
      {
        status: 'voided',
        voidReconciled: true,
        voidedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}
