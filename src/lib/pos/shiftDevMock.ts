import { Timestamp } from 'firebase/firestore';
import type { CashTransactionType, Shift } from '../types';

const devShifts = new Map<string, Shift>();

function makeOpenShift(
  id: string,
  branchId: string,
  staffId: string,
  staffName: string,
  startingCash: number,
): Shift {
  return {
    id,
    branchId,
    staffId,
    staffName,
    status: 'open',
    openedAt: Timestamp.now(),
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
  };
}

export function devGetActiveShift(branchId: string, staffId: string): Shift | null {
  for (const shift of devShifts.values()) {
    if (shift.branchId === branchId && shift.staffId === staffId && shift.status === 'open') {
      return { ...shift };
    }
  }
  return null;
}

export function devOpenShift(
  branchId: string,
  staffId: string,
  staffName: string,
  startingCash: number,
): string {
  const id = `dev-shift-${Date.now()}`;
  devShifts.set(id, makeOpenShift(id, branchId, staffId, staffName, startingCash));
  return id;
}

export function devCloseShift(shiftId: string, actualCashCount: number, note: string): Shift {
  const shift = devShifts.get(shiftId);
  if (!shift || shift.status !== 'open') {
    throw new Error('ไม่พบกะที่เปิดอยู่');
  }
  const totalExpected =
    shift.startingCash +
    shift.expectedCash +
    (shift.payInTotal || 0) -
    (shift.payOutTotal || 0);
  const variance = actualCashCount - totalExpected;
  const closed: Shift = {
    ...shift,
    status: 'closed',
    closedAt: Timestamp.now(),
    actualCashCount,
    variance,
    note,
  };
  devShifts.set(shiftId, closed);
  return { ...closed };
}

export function devIncrementShiftTotals(
  shiftId: string,
  deltas: {
    netCash: number;
    qrTotal: number;
    kbankTotal: number;
    cardTotal: number;
    creditTotal: number;
  },
): void {
  const shift = devShifts.get(shiftId);
  if (!shift || shift.status !== 'open') {
    throw new Error('ไม่พบกะที่เปิดอยู่');
  }
  devShifts.set(shiftId, {
    ...shift,
    expectedCash: shift.expectedCash + deltas.netCash,
    expectedQr: shift.expectedQr + deltas.qrTotal,
    expectedKbank: shift.expectedKbank + deltas.kbankTotal,
    expectedCard: shift.expectedCard + deltas.cardTotal,
    expectedCredit: shift.expectedCredit + deltas.creditTotal,
    totalBills: shift.totalBills + 1,
  });
}

export function devApplyCreditPaymentToShift(
  shiftId: string,
  paymentMethod: 'cash' | 'transfer',
  amount: number,
): void {
  const shift = devShifts.get(shiftId);
  if (!shift || shift.status !== 'open') return;

  if (paymentMethod === 'cash') {
    devShifts.set(shiftId, {
      ...shift,
      expectedCash: shift.expectedCash + amount,
    });
    return;
  }

  devShifts.set(shiftId, {
    ...shift,
    expectedKbank: shift.expectedKbank + amount,
  });
}

export function devRecordCashTransaction(input: {
  shiftId: string;
  type: CashTransactionType;
  amount: number;
}): void {
  const shift = devShifts.get(input.shiftId);
  if (!shift || shift.status !== 'open') {
    throw new Error('ไม่พบกะที่เปิดอยู่');
  }
  if (input.type === 'pay_in') {
    devShifts.set(input.shiftId, {
      ...shift,
      payInTotal: shift.payInTotal + input.amount,
    });
    return;
  }
  devShifts.set(input.shiftId, {
    ...shift,
    payOutTotal: shift.payOutTotal + input.amount,
  });
}
