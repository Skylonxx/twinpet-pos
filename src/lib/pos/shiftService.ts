import {
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { CashTransactionType, Shift, ShiftCashEntry } from '../types';
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
    // Embedded offline cash movements — folded into the derived drawer.
    cashEntries: (data.cashEntries as ShiftCashEntry[]) ?? [],
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

/**
 * Close a shift. Under the drawer single-writer model the terminal is the sole
 * authority for the shift's sale totals, so the caller passes the shift it has
 * already DERIVED from its local ledger ({@link deriveShiftDrawer}); we never
 * re-read the (now reconciler-untouched, stale) stored `expected*` fields. The
 * derived `expected*` are persisted at close so the closed doc is the correct
 * historical snapshot for back-office reads, and variance is computed from them.
 */
export async function closeShift(
  shift: Shift,
  actualCashCount: number,
  note: string,
): Promise<Shift> {
  if (!isFirebaseConfigured || !db) {
    return devCloseShift(shift.id, actualCashCount, note);
  }

  const ref = doc(db, collections.shifts, shift.id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    throw new Error('ไม่พบกะที่เปิดอยู่');
  }

  const totalExpected = calcShiftDrawerExpected(shift);
  const variance = actualCashCount - totalExpected;

  await updateDoc(ref, {
    status: 'closed',
    closedAt: serverTimestamp(),
    actualCashCount,
    variance,
    note,
    // Commit the terminal's authoritative sale totals onto the closed doc.
    expectedCash: shift.expectedCash,
    expectedQr: shift.expectedQr,
    expectedKbank: shift.expectedKbank,
    expectedCard: shift.expectedCard,
    expectedCredit: shift.expectedCredit,
    totalBills: shift.totalBills,
    // Cash movements are also derived locally (from cashEntries[]); freeze the
    // snapshot so the closed doc + HQ variance are correct without the counters.
    payInTotal: shift.payInTotal,
    payOutTotal: shift.payOutTotal,
  });

  const updated = await getDoc(ref);
  return mapShift(updated.id, updated.data()!);
}

/**
 * Record a cash in/out — offline-first. Returns the {@link ShiftCashEntry}
 * SYNCHRONOUSLY (so the caller can append it to the live shift instantly) and
 * fires two QUEUEABLE writes fire-and-forget:
 *   1. `arrayUnion` the entry onto `shifts/{id}.cashEntries[]` — the durable
 *      local source the derived drawer folds (survives an offline reload).
 *   2. a plain `setDoc` to `cashTransactions/{id}` — back-office audit trail.
 * Neither uses `runTransaction`, so both commit to `persistentLocalCache`
 * instantly and flush on reconnect; we must NOT await them or an offline cashier
 * would hang. The old transactional `payInTotal`/`payOutTotal` increment is gone
 * (those totals are now derived from `cashEntries[]` via `foldCashEntries`).
 */
export function recordCashTransaction(input: RecordCashTransactionInput): ShiftCashEntry {
  if (input.amount <= 0) {
    throw new Error('จำนวนเงินต้องมากกว่า 0');
  }
  const note = input.note.trim();
  if (!note) {
    throw new Error('กรุณาระบุหมายเหตุ');
  }

  const id =
    isFirebaseConfigured && db
      ? doc(collection(db, collections.cashTransactions)).id
      : `cash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const entry: ShiftCashEntry = {
    id,
    type: input.type,
    amount: input.amount,
    note,
    staffId: input.staffId,
    staffName: input.staffName,
    at: Date.now(),
  };

  if (!isFirebaseConfigured || !db) {
    devRecordCashTransaction({ shiftId: input.shiftId, entry });
    return entry;
  }

  const firestore = db;
  const shiftRef = doc(firestore, collections.shifts, input.shiftId);

  // 1. Durable local drawer source — queueable append.
  void updateDoc(shiftRef, {
    cashEntries: arrayUnion(entry),
    updatedAt: serverTimestamp(),
  }).catch((err) => {
    console.warn('[shiftService] cashEntry append not yet acked (queued, will retry)', err);
  });

  // 2. Back-office audit doc — queueable setDoc (offline-safe; NOT a transaction).
  void setDoc(doc(firestore, collections.cashTransactions, id), {
    id,
    shiftId: input.shiftId,
    branchId: input.branchId,
    staffId: input.staffId,
    staffName: input.staffName,
    type: input.type,
    amount: input.amount,
    note,
    createdAt: serverTimestamp(),
  }).catch((err) => {
    console.warn('[shiftService] cashTransaction audit not yet acked (queued, will retry)', err);
  });

  return entry;
}
