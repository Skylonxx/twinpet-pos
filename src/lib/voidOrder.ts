import {
  collection,
  doc,
  getDocs,
  increment,
  runTransaction,
  serverTimestamp,
  type DocumentReference,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from './firebase';
import { OVERSELL_LOT_ID } from './fifo';
import { voidDevOrder } from './salesHistory/devMock';
import type { AuditLog, CreditAccount, CreditTransaction, Order, OrderItem } from './types';

export type VoidOrderInput = {
  orderId: string;
  branchId: string;
  reason: string;
  note?: string;
  voidedBy: string;
  voidedByName: string;
};

type StockMovementWrite = {
  ref: DocumentReference;
  data: {
    id: string;
    productId: string;
    branchId: string;
    type: 'void';
    qty: number;
    costPerUnit: number;
    refId: string;
    refType: string;
    note: string;
    createdBy: string;
    createdAt: ReturnType<typeof serverTimestamp>;
  };
};

export async function voidOrder(input: VoidOrderInput): Promise<void> {
  if (!db) {
    throw new Error('Firestore is not configured');
  }
  const firestore = db;

  const orderRef = doc(firestore, collections.orders, input.orderId);
  const itemsSnap = await getDocs(
    collection(firestore, collections.orders, input.orderId, collections.orderItems),
  );
  const items = itemsSnap.docs.map((d) => ({ ...(d.data() as OrderItem), id: d.id }));

  await runTransaction(firestore, async (tx) => {
    // ── Phase 1: all reads ──
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) {
      throw new Error('ไม่พบบิลนี้');
    }

    const order = { ...(orderSnap.data() as Order), id: orderSnap.id };

    if (order.branchId !== input.branchId) {
      throw new Error('บิลนี้ไม่ใช่ของสาขาปัจจุบัน');
    }

    if (order.status === 'voided') {
      throw new Error('บิลนี้ถูกยกเลิกแล้ว');
    }

    let credRef: DocumentReference | null = null;
    let customerRef: DocumentReference | null = null;
    let creditAccount: CreditAccount | null = null;
    let customerExists = false;

    if (order.creditAmt > 0 && order.customerId) {
      credRef = doc(firestore, collections.creditAccounts, order.customerId);
      customerRef = doc(firestore, collections.customers, order.customerId);
      const [credSnap, customerSnap] = await Promise.all([
        tx.get(credRef),
        tx.get(customerRef),
      ]);
      if (credSnap.exists()) {
        creditAccount = credSnap.data() as CreditAccount;
      }
      customerExists = customerSnap.exists();
    }

    // ── Phase 2 planning (in memory) ──
    const voidNote = input.note?.trim()
      ? `${input.reason} — ${input.note.trim()}`
      : input.reason;

    let creditReversal: { newUsed: number; newBalance: number } | null = null;
    if (creditAccount && order.creditAmt > 0) {
      const newUsed = Math.max(0, creditAccount.creditUsed - order.creditAmt);
      creditReversal = {
        newUsed,
        newBalance: creditAccount.creditLimit - newUsed,
      };
    }

    const movementWrites: StockMovementWrite[] = items.map((line) => {
      const movementRef = doc(collection(firestore, collections.stockMovements));
      return {
        ref: movementRef,
        data: {
          id: movementRef.id,
          productId: line.productId,
          branchId: order.branchId,
          type: 'void',
          qty: line.qtyBase,
          costPerUnit:
            line.lotRefs.find((r) => r.lotId !== OVERSELL_LOT_ID)?.cost ??
            line.lotRefs[0]?.cost ??
            0,
          refId: order.id,
          refType: 'order',
          note: input.reason,
          createdBy: input.voidedBy,
          createdAt: serverTimestamp(),
        },
      };
    });

    const auditRef = doc(collection(firestore, collections.auditLogs));
    const audit: AuditLog = {
      id: auditRef.id,
      collection: 'orders',
      docId: order.id,
      action: 'void',
      before: { status: order.status, total: order.total },
      after: { status: 'voided', voidReason: voidNote },
      changedFields: ['status', 'voidReason', 'voidedBy', 'voidedAt'],
      reason: voidNote,
      changedBy: input.voidedBy,
      changedByName: input.voidedByName,
      changedAt: serverTimestamp() as never,
    };

    let creditTxRef: DocumentReference | null = null;
    let creditTx: CreditTransaction | null = null;
    if (creditReversal && order.customerId) {
      creditTxRef = doc(collection(firestore, collections.creditTransactions));
      creditTx = {
        id: creditTxRef.id,
        customerId: order.customerId,
        branchId: order.branchId,
        type: 'payment',
        amount: -order.creditAmt,
        balance: creditReversal.newBalance,
        refOrderId: order.id,
        note: `ยกเลิกบิล ${order.id}`,
        createdBy: input.voidedBy,
        createdAt: serverTimestamp() as never,
        dueDate: null,
        isPaid: true,
        paidAt: serverTimestamp() as never,
      };
    }

    // ── Phase 2: all writes ──
    for (const line of items) {
      for (const lotRef of line.lotRefs) {
        if (lotRef.lotId === OVERSELL_LOT_ID) continue;

        const lotDocRef = doc(firestore, collections.stockLots, lotRef.lotId);
        tx.update(lotDocRef, {
          qtyRemaining: increment(lotRef.qty),
          isDepleted: false,
        });
      }

      const productStockRef = doc(
        firestore,
        collections.products,
        line.productId,
        collections.productStocks,
        order.branchId,
      );

      tx.set(
        productStockRef,
        {
          branchId: order.branchId,
          totalStockBase: increment(line.qtyBase),
          lastMovementAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    }

    for (const movement of movementWrites) {
      tx.set(movement.ref, movement.data);
    }

    tx.update(orderRef, {
      status: 'voided',
      voidReason: voidNote,
      voidedBy: input.voidedBy,
      voidedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    // Shift reversal REMOVED — drawer single-writer (Standalone POS): the local
    // ledger ({@link isLedgerSale}) excludes voided sales, so the terminal's
    // derived drawer self-corrects on void. The server must not decrement
    // `shifts.expected*` (no terminal reads server-maintained totals anymore).
    // NOTE: this online void flips only the canonical `orders` doc; propagating
    // the void onto the source `asyncOrders` doc (so it drops from the device's
    // live ledger) is the Phase 6/7 offline-void work.

    if (creditReversal && credRef) {
      tx.update(credRef, {
        creditUsed: creditReversal.newUsed,
        creditBalance: creditReversal.newBalance,
        lastTransAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      if (customerExists && customerRef) {
        tx.update(customerRef, {
          outstandingBalance: creditReversal.newUsed,
          updatedAt: serverTimestamp(),
        });
      }

      if (creditTxRef && creditTx) {
        tx.set(creditTxRef, creditTx);
      }
    }

    tx.set(auditRef, audit);
  });
}

export async function voidOrderDev(input: VoidOrderInput): Promise<void> {
  voidDevOrder(input.orderId, input.reason, input.voidedBy);
}

export async function voidOrderSafe(input: VoidOrderInput): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    await voidOrderDev(input);
    return;
  }
  await voidOrder(input);
}
