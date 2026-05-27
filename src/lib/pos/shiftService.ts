import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { CashTransactionType, Shift } from '../types';
import type { PaymentSplit } from './types';
import {
  devCloseShift,
  devGetActiveShift,
  devOpenShift,
  devRecordCashTransaction,
} from './shiftDevMock';

export type RecordCashTransactionInput = {
  shiftId: string;
  branchId: string;
  staffId: string;
  staffName: string;
  type: CashTransactionType;
  amount: number;
  note: string;
};

export function calcShiftDrawerExpected(
  shift: Pick<Shift, 'startingCash' | 'expectedCash' | 'payInTotal' | 'payOutTotal'>,
): number {
  return (
    shift.startingCash +
    shift.expectedCash +
    (shift.payInTotal || 0) -
    (shift.payOutTotal || 0)
  );
}

export function buildCreditDebtPaymentShiftUpdate(
  paymentMethod: 'cash' | 'transfer',
  amount: number,
): Record<string, ReturnType<typeof increment>> {
  if (paymentMethod === 'cash') {
    return { expectedCash: increment(amount) };
  }
  return { expectedKbank: increment(amount) };
}

export function calcShiftPaymentTotals(payments: PaymentSplit[], grandTotal: number) {
  const paidAmt = payments.reduce((s, p) => s + p.amount, 0);
  const cashPayment = payments
    .filter((p) => p.method === 'cash')
    .reduce((s, p) => s + p.amount, 0);
  const qrTotal = payments.filter((p) => p.method === 'qr').reduce((s, p) => s + p.amount, 0);
  const kbankTotal = payments
    .filter((p) => p.method === 'kbank')
    .reduce((s, p) => s + p.amount, 0);
  const cardTotal = payments.filter((p) => p.method === 'card').reduce((s, p) => s + p.amount, 0);
  const creditTotal = payments
    .filter((p) => p.method === 'credit')
    .reduce((s, p) => s + p.amount, 0);
  const changeAmt = Math.max(0, paidAmt - grandTotal);
  const netCash = Math.max(0, cashPayment - changeAmt);
  return { netCash, qrTotal, kbankTotal, cardTotal, creditTotal };
}

export function applyShiftPaymentTotals(shift: Shift, payments: PaymentSplit[], grandTotal: number): Shift {
  const { netCash, qrTotal, kbankTotal, cardTotal, creditTotal } = calcShiftPaymentTotals(
    payments,
    grandTotal,
  );
  return {
    ...shift,
    expectedCash: shift.expectedCash + netCash,
    expectedQr: shift.expectedQr + qrTotal,
    expectedKbank: shift.expectedKbank + kbankTotal,
    expectedCard: shift.expectedCard + cardTotal,
    expectedCredit: shift.expectedCredit + creditTotal,
    totalBills: shift.totalBills + 1,
  };
}

function mapShift(id: string, data: Record<string, unknown>): Shift {
  return {
    id,
    branchId: data.branchId as string,
    staffId: data.staffId as string,
    staffName: data.staffName as string,
    status: data.status as Shift['status'],
    openedAt: data.openedAt as Shift['openedAt'],
    closedAt: (data.closedAt ?? null) as Shift['closedAt'],
    startingCash: (data.startingCash as number) ?? 0,
    actualCashCount: (data.actualCashCount as number) ?? 0,
    expectedCash: (data.expectedCash as number) ?? 0,
    expectedQr: (data.expectedQr as number) ?? 0,
    expectedKbank: (data.expectedKbank as number) ?? 0,
    expectedCard: (data.expectedCard as number) ?? 0,
    expectedCredit: (data.expectedCredit as number) ?? 0,
    totalBills: (data.totalBills as number) ?? 0,
    payInTotal: (data.payInTotal as number) ?? 0,
    payOutTotal: (data.payOutTotal as number) ?? 0,
    variance: (data.variance as number) ?? 0,
    note: (data.note as string) ?? '',
  };
}

export async function getActiveShift(branchId: string, staffId: string): Promise<Shift | null> {
  if (!isFirebaseConfigured || !db) {
    return devGetActiveShift(branchId, staffId);
  }

  const snap = await getDocs(
    query(
      collection(db, collections.shifts),
      where('branchId', '==', branchId),
      where('staffId', '==', staffId),
      where('status', '==', 'open'),
      limit(1),
    ),
  );

  if (snap.empty) return null;
  const docSnap = snap.docs[0]!;
  return mapShift(docSnap.id, docSnap.data());
}

export async function openShift(
  branchId: string,
  staffId: string,
  staffName: string,
  startingCash: number,
): Promise<string> {
  if (!isFirebaseConfigured || !db) {
    return devOpenShift(branchId, staffId, staffName, startingCash);
  }

  const ref = doc(collection(db, collections.shifts));
  await setDoc(ref, {
    id: ref.id,
    branchId,
    staffId,
    staffName,
    status: 'open',
    openedAt: serverTimestamp(),
    closedAt: null,
    startingCash,
    actualCashCount: 0,
    expectedCash: 0,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    totalBills: 0,
    payInTotal: 0,
    payOutTotal: 0,
    variance: 0,
    note: '',
  });
  return ref.id;
}

export async function closeShift(
  shiftId: string,
  actualCashCount: number,
  note: string,
): Promise<Shift> {
  if (!isFirebaseConfigured || !db) {
    return devCloseShift(shiftId, actualCashCount, note);
  }

  const ref = doc(db, collections.shifts, shiftId);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    throw new Error('ไม่พบกะที่เปิดอยู่');
  }

  const shift = mapShift(snap.id, snap.data());
  const totalExpected = calcShiftDrawerExpected(shift);
  const variance = actualCashCount - totalExpected;

  await updateDoc(ref, {
    status: 'closed',
    closedAt: serverTimestamp(),
    actualCashCount,
    variance,
    note,
  });

  const updated = await getDoc(ref);
  return mapShift(updated.id, updated.data()!);
}

export async function recordCashTransaction(input: RecordCashTransactionInput): Promise<void> {
  if (input.amount <= 0) {
    throw new Error('จำนวนเงินต้องมากกว่า 0');
  }
  if (!input.note.trim()) {
    throw new Error('กรุณาระบุหมายเหตุ');
  }

  if (!isFirebaseConfigured || !db) {
    devRecordCashTransaction({
      shiftId: input.shiftId,
      type: input.type,
      amount: input.amount,
    });
    return;
  }

  const firestore = db;
  await runTransaction(firestore, async (tx) => {
    const shiftRef = doc(firestore, collections.shifts, input.shiftId);
    const shiftSnap = await tx.get(shiftRef);

    if (!shiftSnap.exists()) {
      throw new Error('ไม่พบกะที่เปิดอยู่');
    }

    const shift = shiftSnap.data();
    if (shift.status !== 'open') {
      throw new Error('กะนี้ถูกปิดแล้ว');
    }

    const txRef = doc(collection(firestore, collections.cashTransactions));
    tx.set(txRef, {
      id: txRef.id,
      shiftId: input.shiftId,
      branchId: input.branchId,
      staffId: input.staffId,
      staffName: input.staffName,
      type: input.type,
      amount: input.amount,
      note: input.note.trim(),
      createdAt: serverTimestamp(),
    });

    const field = input.type === 'pay_in' ? 'payInTotal' : 'payOutTotal';
    tx.update(shiftRef, {
      [field]: increment(input.amount),
    });
  });
}
