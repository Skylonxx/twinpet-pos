import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  type Firestore,
} from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { collections, db, isFirebaseConfigured } from '../firebase';
import { buildCreditDebtPaymentShiftUpdate } from '../pos/shiftService';
import type { CreditAccount, CreditPaymentTransaction, CreditTransaction, Customer, Shift } from '../types';
import { getDevCreditPayments, getDevCustomerCreditPayments, getDevCustomers, getDevDebtors, devReceiveCreditPayment } from './devMock';

export type ReceiveCreditPaymentInput = {
  customerId: string;
  branchId: string;
  amount: number;
  paymentMethod: 'cash' | 'transfer';
  notes?: string;
  shiftId?: string;
  createdBy?: string;
  paymentDate?: Date;
};

export function resolveOutstandingBalance(
  customer: Pick<Customer, 'outstandingBalance'>,
  creditAccount?: CreditAccount | null,
): number {
  if (customer.outstandingBalance != null) return customer.outstandingBalance;
  return creditAccount?.creditUsed ?? 0;
}

export function creditAvailable(creditLimit: number, outstandingBalance: number): number {
  if (creditLimit <= 0) return 0;
  return Math.max(0, creditLimit - outstandingBalance);
}

export async function receiveCreditPayment(
  input: ReceiveCreditPaymentInput,
  firestore: Firestore | undefined = db,
): Promise<number> {
  const { customerId, branchId, amount, paymentMethod, notes, shiftId, createdBy, paymentDate } = input;

  if (amount <= 0) {
    throw new Error('กรุณาระบุยอดชำระ');
  }

  if (!isFirebaseConfigured || !firestore) {
    return devReceiveCreditPayment(
      customerId,
      branchId,
      amount,
      paymentMethod,
      notes ?? '',
      createdBy ?? 'system',
      shiftId,
      paymentDate,
    );
  }

  const paidAt = paymentDate ? Timestamp.fromDate(paymentDate) : Timestamp.now();

  return runTransaction(firestore, async (transaction) => {
    const customerRef = doc(firestore, collections.customers, customerId);
    const customerSnap = await transaction.get(customerRef);
    if (!customerSnap.exists()) {
      throw new Error('ไม่พบข้อมูลลูกค้า');
    }

    const customer = customerSnap.data() as Customer;
    const credRef = doc(firestore, collections.creditAccounts, customerId);
    const credSnap = await transaction.get(credRef);
    const account = credSnap.exists() ? (credSnap.data() as CreditAccount) : null;

    let shiftRef: ReturnType<typeof doc> | null = null;
    let shiftSnap: Awaited<ReturnType<typeof transaction.get>> | null = null;
    if (shiftId) {
      shiftRef = doc(firestore, collections.shifts, shiftId);
      shiftSnap = await transaction.get(shiftRef);
    }

    const currentBalance = resolveOutstandingBalance(customer, account);
    if (amount > currentBalance) {
      throw new Error('ยอดชำระเกินหนี้ค้างชำระ');
    }

    const newOutstanding = currentBalance - amount;

    transaction.update(customerRef, {
      outstandingBalance: newOutstanding,
      lastPaymentDate: paidAt,
      updatedAt: serverTimestamp(),
    });

    if (account) {
      const newUsed = Math.max(0, account.creditUsed - amount);
      transaction.update(credRef, {
        creditUsed: newUsed,
        creditBalance: account.creditLimit - newUsed,
        lastTransAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    const paymentRef = doc(collection(firestore, collections.creditPayments));
    const paymentData: CreditPaymentTransaction = {
      id: paymentRef.id,
      customerId,
      amount,
      paymentMethod,
      createdAt: paidAt as never,
    };

    const trimmedNotes = notes?.trim();
    if (trimmedNotes) {
      paymentData.notes = trimmedNotes;
    }
    if (shiftId) {
      paymentData.shiftId = shiftId;
    }

    transaction.set(paymentRef, paymentData);

    const creditTxRef = doc(collection(firestore, collections.creditTransactions));
    const creditTx: CreditTransaction = {
      id: creditTxRef.id,
      customerId,
      branchId,
      type: 'payment',
      amount,
      balance: account ? account.creditLimit - Math.max(0, account.creditUsed - amount) : newOutstanding,
      refOrderId: null,
      note: notes?.trim() || `รับชำระหนี้ — ${paymentMethod === 'cash' ? 'เงินสด' : 'โอนเงิน'}`,
      createdBy: createdBy ?? 'system',
      createdAt: paidAt as never,
      dueDate: null,
      isPaid: true,
      paidAt: paidAt as never,
    };
    transaction.set(creditTxRef, creditTx);

    if (shiftRef && shiftSnap?.exists()) {
      const shift = shiftSnap.data() as Shift;
      if (shift.status === 'open') {
        transaction.update(shiftRef, buildCreditDebtPaymentShiftUpdate(paymentMethod, amount));
      }
    }

    return newOutstanding;
  });
}

export type CreditPaymentHistoryRow = CreditPaymentTransaction & {
  customerName: string;
};

function parseCreditPaymentDate(value: unknown): Date {
  if (value != null && typeof value === 'object' && 'toDate' in value) {
    return (value as { toDate: () => Date }).toDate();
  }
  if (value instanceof Date) return value;
  return new Date(0);
}

export function resolveCreditTermDays(customer: Pick<Customer, 'creditTermDays' | 'creditDays'>): number {
  return customer.creditTermDays ?? customer.creditDays ?? 0;
}

export function formatCustomerActivityDate(value: unknown): string {
  const d = parseCreditPaymentDate(value);
  if (d.getTime() === 0) return '—';
  return d.toLocaleDateString('th-TH', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function getCustomerLastActivity(customer: Customer): { label: string; date: Date } | null {
  const paymentDate = customer.lastPaymentDate
    ? parseCreditPaymentDate(customer.lastPaymentDate)
    : null;
  const purchaseDate = customer.lastCreditPurchaseDate
    ? parseCreditPaymentDate(customer.lastCreditPurchaseDate)
    : null;

  const paymentValid = paymentDate && paymentDate.getTime() > 0 ? paymentDate : null;
  const purchaseValid = purchaseDate && purchaseDate.getTime() > 0 ? purchaseDate : null;

  if (paymentValid && purchaseValid) {
    if (paymentValid >= purchaseValid) {
      return { label: 'ชำระล่าสุด', date: paymentValid };
    }
    return { label: 'ซื้อล่าสุด', date: purchaseValid };
  }
  if (paymentValid) return { label: 'ชำระล่าสุด', date: paymentValid };
  if (purchaseValid) return { label: 'ซื้อล่าสุด', date: purchaseValid };
  return null;
}

export function isCustomerCreditOverdue(customer: Customer): boolean {
  const termDays = resolveCreditTermDays(customer);
  if (termDays <= 0 || !customer.lastCreditPurchaseDate) return false;

  const purchaseDate = parseCreditPaymentDate(customer.lastCreditPurchaseDate);
  if (purchaseDate.getTime() === 0) return false;

  const dueDate = new Date(purchaseDate);
  dueDate.setDate(dueDate.getDate() + termDays);
  dueDate.setHours(23, 59, 59, 999);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return dueDate < today;
}

export function useDebtors(branchId: string | null, refreshKey = 0) {
  const [debtors, setDebtors] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!branchId) {
      setDebtors([]);
      setLoading(false);
      return;
    }

    if (!isFirebaseConfigured || !db) {
      setDebtors(getDevDebtors(branchId));
      setLoading(false);
      return;
    }

    setLoading(true);
    const q = query(
      collection(db, collections.customers),
      where('branchId', '==', branchId),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => ({ ...(d.data() as Customer), id: d.id }))
          .filter((c) => !c.deletedAt && (c.outstandingBalance ?? 0) > 0)
          .sort((a, b) => (b.outstandingBalance ?? 0) - (a.outstandingBalance ?? 0));
        setDebtors(list);
        setLoading(false);
      },
      () => {
        setDebtors([]);
        setLoading(false);
      },
    );

    return () => unsub();
  }, [branchId, refreshKey]);

  return { debtors, loading };
}

export function useCreditPaymentHistory(branchId: string | null, refreshKey = 0) {
  const [paymentHistory, setPaymentHistory] = useState<CreditPaymentHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!branchId) {
      setPaymentHistory([]);
      setLoading(false);
      return;
    }

    if (!isFirebaseConfigured || !db) {
      const nameMap = new Map(
        getDevCustomers()
          .filter((c) => c.branchId === branchId)
          .map((c) => [c.id, c.name]),
      );
      setPaymentHistory(
        getDevCreditPayments(branchId).map((p) => ({
          ...p,
          customerName: nameMap.get(p.customerId) ?? p.customerId,
        })),
      );
      setLoading(false);
      return;
    }

    setLoading(true);
    let customerNameMap = new Map<string, string>();

    const custQuery = query(
      collection(db, collections.customers),
      where('branchId', '==', branchId),
    );

    const payQuery = query(
      collection(db, collections.creditPayments),
      orderBy('createdAt', 'desc'),
    );

    const mergePayments = (payments: CreditPaymentTransaction[]) => {
      setPaymentHistory(
        payments
          .filter((p) => customerNameMap.has(p.customerId))
          .map((p) => ({
            ...p,
            customerName: customerNameMap.get(p.customerId) ?? p.customerId,
          })),
      );
      setLoading(false);
    };

    let latestPayments: CreditPaymentTransaction[] = [];

    const unsubCustomers = onSnapshot(custQuery, (snap) => {
      customerNameMap = new Map(
        snap.docs.map((d) => {
          const data = d.data() as Customer;
          return [d.id, data.name || `${data.firstName} ${data.lastName}`.trim()];
        }),
      );
      mergePayments(latestPayments);
    });

    const unsubPayments = onSnapshot(
      payQuery,
      (snap) => {
        latestPayments = snap.docs.map((d) => ({
          ...(d.data() as CreditPaymentTransaction),
          id: d.id,
        }));
        mergePayments(latestPayments);
      },
      () => {
        setPaymentHistory([]);
        setLoading(false);
      },
    );

    return () => {
      unsubCustomers();
      unsubPayments();
    };
  }, [branchId, refreshKey]);

  return { paymentHistory, loading };
}

export function useCustomerCreditPayments(customerId: string | null, refreshKey = 0) {
  const [payments, setPayments] = useState<CreditPaymentTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!customerId) {
      setPayments([]);
      setLoading(false);
      setError(null);
      return;
    }

    if (!isFirebaseConfigured || !db) {
      setPayments(getDevCustomerCreditPayments(customerId));
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    const firestore = db;

    const mapDocs = (docs: Array<{ id: string; data: () => unknown }>) =>
      docs.map((d) => ({
        ...(d.data() as CreditPaymentTransaction),
        id: d.id,
      }));

    const sortByDate = (list: CreditPaymentTransaction[]) =>
      [...list].sort(
        (a, b) =>
          parseCreditPaymentDate(b.createdAt).getTime() -
          parseCreditPaymentDate(a.createdAt).getTime(),
      );

    const indexedQuery = query(
      collection(firestore, collections.creditPayments),
      where('customerId', '==', customerId),
      orderBy('createdAt', 'desc'),
    );

    const simpleQuery = query(
      collection(firestore, collections.creditPayments),
      where('customerId', '==', customerId),
    );

    let unsubFallback: (() => void) | null = null;
    let cancelled = false;

    const unsubPrimary = onSnapshot(
      indexedQuery,
      (snap) => {
        if (cancelled) return;
        setPayments(mapDocs(snap.docs));
        setLoading(false);
        setError(null);
      },
      (err) => {
        if (cancelled) return;
        console.warn('[useCustomerCreditPayments] indexed query failed, using fallback:', err);
        unsubFallback = onSnapshot(
          simpleQuery,
          (snap) => {
            if (cancelled) return;
            setPayments(sortByDate(mapDocs(snap.docs)));
            setLoading(false);
            setError(null);
          },
          (fallbackErr) => {
            if (cancelled) return;
            console.error('[useCustomerCreditPayments]', fallbackErr);
            setPayments([]);
            setLoading(false);
            setError('โหลดประวัติการชำระหนี้ไม่สำเร็จ');
          },
        );
      },
    );

    return () => {
      cancelled = true;
      unsubPrimary();
      unsubFallback?.();
    };
  }, [customerId, refreshKey]);

  return { payments, loading, error };
}

export function formatCreditPaymentDate(value: unknown): string {
  const d = parseCreditPaymentDate(value);
  return d.toLocaleString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function creditPaymentMethodLabel(method: 'cash' | 'transfer'): string {
  return method === 'cash' ? 'เงินสด' : 'โอนเงิน';
}
