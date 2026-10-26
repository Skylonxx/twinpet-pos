/**
 * 018 — Danger Zone reset safety. Every reset that writes shifts, cash, sales,
 * the credit ledger, system logs or inventory must refuse BEFORE its first read
 * or write (typed refusal, truthful Thai notice, zero committed writes).
 * 019 retired the customers / suppliers / categories hard deletes too — their
 * refusal contract is covered in clearTestData.uatRetired.test.ts.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('firebase/firestore', async () => (await import('./clearTestData.fakeFirestore')).fakeFirestoreModule);
vi.mock('../firebase', async () => (await import('./clearTestData.fakeFirestore')).fakeFirebaseModule);
vi.mock('../firebaseAuth', async () => (await import('./clearTestData.fakeFirestore')).fakeFirebaseAuthModule);

import { fakeDb } from './clearTestData.fakeFirestore';
import {
  clearAllTransactionData,
  clearCreditData,
  clearInventoryTransactions,
  clearSalesData,
  clearShiftAndCashData,
  clearStockLedgerAndFifo,
  clearSystemLogs,
  hardDeleteProducts,
  isResetBlocked,
  resetAllProductStocks,
  resetCustomerCreditBalances,
  type DeletionSummary,
} from './clearTestData';

const BLOCKED_CODE = 'reset_blocked_server_owned_records';
const NOTHING_DELETED = 'ไม่มีข้อมูลถูกลบ';

const BLOCKED: Array<[string, () => Promise<DeletionSummary>]> = [
  ['clearSalesData', clearSalesData],
  ['clearInventoryTransactions', clearInventoryTransactions],
  ['clearStockLedgerAndFifo', clearStockLedgerAndFifo],
  ['resetAllProductStocks', resetAllProductStocks],
  ['clearShiftAndCashData', clearShiftAndCashData],
  ['clearCreditData', clearCreditData],
  ['clearSystemLogs', clearSystemLogs],
  ['resetCustomerCreditBalances', resetCustomerCreditBalances],
  ['hardDeleteProducts', hardDeleteProducts],
  ['clearAllTransactionData', clearAllTransactionData],
];

/** A production-shaped database: history in every domain the resets touch. */
function seedProductionShape(): void {
  fakeDb.seed('orders/o1', { branchId: 'B1' });
  fakeDb.seed('orders/o1/orderItems/i1');
  fakeDb.seed('payments/p1');
  fakeDb.seed('asyncOrders/o1');
  fakeDb.seed('receivings/r1');
  fakeDb.seed('receivings/r1/receivingItems/i1');
  fakeDb.seed('inventoryTransfers/t1');
  fakeDb.seed('inventoryAdjustments/a1');
  fakeDb.seed('stockMovements/m1');
  fakeDb.seed('stockLots/l1');
  fakeDb.seed('products/prod1', { avgCost: 12 });
  fakeDb.seed('products/prod1/productStocks/B1', { totalStockBase: 40 });
  fakeDb.seed('shifts/s1', { status: 'closed' });
  fakeDb.seed('cashTransactions/ordinary1', { amount: 50 });
  fakeDb.seed('cashTransactions/rfd_ret1', { source: 'sale_refund', amount: 81 });
  fakeDb.seed('creditTransactions/c1');
  fakeDb.seed('creditPayments/cp1');
  fakeDb.seed('auditLogs/saleReturn_ret1');
  fakeDb.seed('staffActivities/sa1');
  fakeDb.seed('customers/cust1', { outstandingBalance: 300 });
  fakeDb.seed('creditAccounts/cust1', { creditUsed: 300, creditLimit: 1000 });
  // Server-only material the client cannot read.
  fakeDb.seed('saleReturns/ret1', { originalOrderId: 'o1' });
  fakeDb.seed('saleRefunds/rfd1', { returnId: 'ret1' });
  fakeDb.seed('shiftCloseAuthorityRecords/s1', { shiftId: 's1' });
}

async function expectRefusedWithoutSideEffects(run: () => Promise<DeletionSummary>) {
  const before = new Map(fakeDb.docs);
  const outcome = await run().then(
    (summary) => ({ ok: true as const, summary }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  expect(outcome.ok, 'a blocked reset must never resolve as success').toBe(false);
  const error = (outcome as { error: unknown }).error as Error & { code?: string };
  expect(error.code).toBe(BLOCKED_CODE);
  expect(error.message).toContain(NOTHING_DELETED);
  // Fail closed BEFORE the first destructive write — and before any read or auth.
  expect(fakeDb.committedWrites).toBe(0);
  expect(fakeDb.ops).toEqual([]);
  expect(new Map(fakeDb.docs)).toEqual(before);
}

beforeEach(() => {
  fakeDb.reset();
});

describe('018 — blocked resets refuse before any read or write', () => {
  test.each(BLOCKED)('%s (direct helper call) refuses with zero side effects', async (_name, run) => {
    seedProductionShape();
    await expectRefusedWithoutSideEffects(run);
  });

  test.each(BLOCKED)('%s is reported blocked to the UI', (_name, run) => {
    expect(typeof isResetBlocked).toBe('function');
    expect(isResetBlocked(run)).toBe(true);
  });

  test('protected rfd_ refund cash record: shift + cash reset deletes nothing', async () => {
    fakeDb.seed('shifts/s1', { status: 'closed' });
    fakeDb.seed('shifts/s2', { status: 'closed' });
    fakeDb.seed('cashTransactions/ordinary1');
    fakeDb.seed('cashTransactions/rfd_ret1', { source: 'sale_refund' });
    await expectRefusedWithoutSideEffects(clearShiftAndCashData);
    expect(fakeDb.idsIn('shifts')).toEqual(['s1', 's2']);
    expect(fakeDb.has('cashTransactions/rfd_ret1')).toBe(true);
  });

  test('original partial-delete hazard: factory reset never commits earlier batches before the rfd_ failure', async () => {
    // Parent behavior: sales, inventory, ledger and ALL shifts are deleted, then
    // the cash batch containing rfd_ is denied atomically → partial reset.
    seedProductionShape();
    await expectRefusedWithoutSideEffects(clearAllTransactionData);
    for (const path of ['orders/o1', 'stockMovements/m1', 'stockLots/l1', 'shifts/s1', 'cashTransactions/ordinary1']) {
      expect(fakeDb.has(path), `${path} must survive`).toBe(true);
    }
  });

  test('authority record without any rfd_ cash: the shift it guards is not deleted', async () => {
    fakeDb.seed('shifts/s1', { status: 'closed' });
    fakeDb.seed('cashTransactions/ordinary1');
    fakeDb.seed('shiftCloseAuthorityRecords/s1', { shiftId: 's1' });
    await expectRefusedWithoutSideEffects(clearShiftAndCashData);
    expect(fakeDb.has('shifts/s1')).toBe(true);
  });

  test('return/refund history: sales and stock ledger resets keep the records a Return references', async () => {
    fakeDb.seed('orders/o1');
    fakeDb.seed('stockMovements/ret_mv1', { refType: 'saleReturn' });
    fakeDb.seed('stockLots/restored1');
    fakeDb.seed('saleReturns/ret1', { originalOrderId: 'o1' });
    fakeDb.seed('saleRefunds/rfd1');
    fakeDb.seed('saleReturnAttemptResolutions/ret2', { originalOrderId: 'o1' });
    await expectRefusedWithoutSideEffects(clearSalesData);
    await expectRefusedWithoutSideEffects(clearStockLedgerAndFifo);
    await expectRefusedWithoutSideEffects(resetAllProductStocks);
    expect(fakeDb.has('orders/o1')).toBe(true);
    expect(fakeDb.has('stockMovements/ret_mv1')).toBe(true);
  });

  test.each(['permission-denied', 'unavailable'])(
    'denied / offline Firestore (%s) still yields the typed safety refusal, not a raw error',
    async (code) => {
      seedProductionShape();
      fakeDb.readFailure = code;
      for (const [, run] of BLOCKED) await expectRefusedWithoutSideEffects(run);
    },
  );

  test('unconfigured Firebase: blocked resets still give the safety refusal', async () => {
    fakeDb.configured = false;
    for (const [, run] of BLOCKED) await expectRefusedWithoutSideEffects(run);
  });
});
