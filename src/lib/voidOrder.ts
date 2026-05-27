import {
  collection,
  doc,
  getDocs,
  increment,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from './firebase';
import type { AuditLog, CreditAccount, CreditTransaction, Order, OrderItem } from './types';

export type VoidOrderInput = {
  orderId: string;
  branchId: string;
  reason: string;
  note?: string;
  voidedBy: string;
  voidedByName: string;
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

    for (const line of items) {
      for (const lotRef of line.lotRefs) {
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

      tx.update(productStockRef, {
        totalStockBase: increment(line.qtyBase),
        lastMovementAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const movementRef = doc(collection(firestore, collections.stockMovements));
      tx.set(movementRef, {
        id: movementRef.id,
        productId: line.productId,
        branchId: order.branchId,
        type: 'void',
        qty: line.qtyBase,
        costPerUnit: line.lotRefs[0]?.cost ?? 0,
        refId: order.id,
        refType: 'order',
        note: input.reason,
        createdBy: input.voidedBy,
        createdAt: serverTimestamp(),
      });
    }

    const voidNote = input.note?.trim()
      ? `${input.reason} — ${input.note.trim()}`
      : input.reason;

    tx.update(orderRef, {
      status: 'voided',
      voidReason: voidNote,
      voidedBy: input.voidedBy,
      voidedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    if (order.creditAmt > 0 && order.customerId) {
      const credRef = doc(firestore, collections.creditAccounts, order.customerId);
      const credSnap = await tx.get(credRef);
      const customerRef = doc(firestore, collections.customers, order.customerId);
      const customerSnap = await tx.get(customerRef);

      if (credSnap.exists()) {
        const account = credSnap.data() as CreditAccount;
        const newUsed = Math.max(0, account.creditUsed - order.creditAmt);
        const newBalance = account.creditLimit - newUsed;

        tx.update(credRef, {
          creditUsed: newUsed,
          creditBalance: newBalance,
          lastTransAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        if (customerSnap.exists()) {
          tx.update(customerRef, {
            outstandingBalance: newUsed,
            updatedAt: serverTimestamp(),
          });
        }

        const creditTxRef = doc(collection(firestore, collections.creditTransactions));
        const creditTx: CreditTransaction = {
          id: creditTxRef.id,
          customerId: order.customerId,
          branchId: order.branchId,
          type: 'payment',
          amount: -order.creditAmt,
          balance: newBalance,
          refOrderId: order.id,
          note: `ยกเลิกบิล ${order.id}`,
          createdBy: input.voidedBy,
          createdAt: serverTimestamp() as never,
          dueDate: null,
          isPaid: true,
          paidAt: serverTimestamp() as never,
        };
        tx.set(creditTxRef, creditTx);
      }
    }

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
    tx.set(auditRef, audit);
  });
}

import { voidDevOrder } from './salesHistory/devMock';

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
