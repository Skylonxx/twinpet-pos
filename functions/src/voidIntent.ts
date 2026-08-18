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
function readRevision(doc: Record<string, unknown>):
  | { kind: 'ABSENT' }
  | { kind: 'VALID'; value: number }
  | { kind: 'MALFORMED' } {
  if (!Object.prototype.hasOwnProperty.call(doc, 'historyRev')) return { kind: 'ABSENT' };
  const v = doc.historyRev;
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 1 || v > Number.MAX_SAFE_INTEGER) {
    return { kind: 'MALFORMED' };
  }
  return { kind: 'VALID', value: v };
}

function canMintSuccessor(current: number): boolean {
  return current < Number.MAX_SAFE_INTEGER;
}

export const VOID_ANOMALY_LITERALS = ['missing_canonical', 'canonical_ineligible'] as const;
export const VOID_REVISION_FAULT_LITERALS = ['revision_malformed', 'revision_overflow'] as const;

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

export type VoidIntentTxnOutcome =
  | { kind: 'NOOP'; reason: 'absent' | 'not_settled' | 'already_reconciled' | 'terminal_marker_present' }
  | { kind: 'VOID_TOMBSTONED' }
  | { kind: 'VOID_ANOMALY_COMMITTED'; anomaly: string }
  | { kind: 'VOID_REVISION_FAULT_COMMITTED'; fault: string; branchId: string }
  | { kind: 'VOID_APPLIED' };

export function terminalMarkerPresent(order: Record<string, unknown>): boolean {
  return (
    'voidAnomaly' in order ||
    'voidAnomalyAt' in order ||
    'voidRevisionFault' in order ||
    'voidRevisionFaultAt' in order
  );
}

function classifyRevisionFault(canonical: Record<string, unknown>): 'revision_malformed' | 'revision_overflow' | null {
  if (!('historyRev' in canonical)) return null;
  const read = readRevision(canonical);
  if (read.kind === 'MALFORMED') return 'revision_malformed';
  if (read.kind === 'VALID' && !canMintSuccessor(read.value)) return 'revision_overflow';
  return null;
}

export async function handleVoidIntent(
  db: Firestore,
  orderRef: DocumentReference,
): Promise<VoidIntentTxnOutcome> {
  const outcome = await db.runTransaction(async (tx): Promise<VoidIntentTxnOutcome> => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) return { kind: 'NOOP', reason: 'absent' };
    const order = snap.data() as VoidIntentOrder & Record<string, unknown>;

    if (terminalMarkerPresent(order)) {
      return { kind: 'NOOP', reason: 'terminal_marker_present' };
    }

    if (order.reconcileStatus === 'pending_reconcile') {
      tx.set(
        orderRef,
        {
          status: 'voided',
          reconcileStatus: 'settled' satisfies ReconcileStatus,
          voidedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return { kind: 'VOID_TOMBSTONED' };
    }

    if (order.reconcileStatus !== 'settled') {
      return { kind: 'NOOP', reason: 'not_settled' };
    }
    if (order.voidReconciled === true) {
      return { kind: 'NOOP', reason: 'already_reconciled' };
    }

    const canonicalRef = db.collection(C.orders).doc(order.id);
    const canonicalSnap = await tx.get(canonicalRef);

    if (!canonicalSnap.exists) {
      tx.set(
        orderRef,
        {
          voidAnomaly: 'missing_canonical',
          voidAnomalyAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return { kind: 'VOID_ANOMALY_COMMITTED', anomaly: 'missing_canonical' };
    }

    const canonical = canonicalSnap.data() as Record<string, unknown>;
    const canonicalStatus = canonical.status;
    if (canonicalStatus !== 'completed' && canonicalStatus !== 'pending_payment') {
      tx.set(
        orderRef,
        {
          voidAnomaly: 'canonical_ineligible',
          voidAnomalyAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return { kind: 'VOID_ANOMALY_COMMITTED', anomaly: 'canonical_ineligible' };
    }

    const fault = classifyRevisionFault(canonical);
    if (fault) {
      const branchId = order.branchId;
      tx.set(
        orderRef,
        {
          voidRevisionFault: fault,
          voidRevisionFaultAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return { kind: 'VOID_REVISION_FAULT_COMMITTED', fault, branchId };
    }

    const revRead = readRevision(canonical);
    const currentRev = revRead.kind === 'VALID' ? revRead.value : 0;

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

    const lotRestocks = planLotRestocks(order.lines);
    const stockRestores = planStockRestores(order.lines);
    const creditReversal = planCreditReversal(order.creditAmt, credData);
    const voidedBy = order.voidedBy ?? order.staffId;
    const voidReason = order.voidReason ?? null;

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

    tx.set(
      canonicalRef,
      {
        status: 'voided',
        voidReason,
        voidedBy,
        voidedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        historyRev: currentRev + 1,
      },
      { merge: true },
    );

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

    return { kind: 'VOID_APPLIED' };
  });

  if (outcome.kind === 'VOID_REVISION_FAULT_COMMITTED') {
    console.error('[voidIntent] void_revision_fault_terminal', {
      orderId: orderRef.id,
      branchId: outcome.branchId,
      fault: outcome.fault,
    });
  }
  return outcome;
}
