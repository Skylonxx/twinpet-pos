/**
 * 019 — the global master-data hard deletes (customers / suppliers / categories) are
 * retired. Every direct module call must refuse BEFORE its first read, auth call,
 * batch or commit, with a typed Thai refusal, on every runtime (configured,
 * unconfigured, offline, denied). The ten 018 resets stay blocked exactly as before.
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
  DangerZoneResetBlockedError,
  hardDeleteCategories,
  hardDeleteCustomers,
  hardDeleteProducts,
  hardDeleteSuppliers,
  isResetBlocked,
  isUatToolRetired,
  resetAllProductStocks,
  resetCustomerCreditBalances,
  type DeletionSummary,
} from './clearTestData';
import { UatToolRetiredError, UAT_TOOL_RETIRED_CODE } from './uatToolRetired';

const RETIRED: Array<[string, () => Promise<DeletionSummary>]> = [
  ['hardDeleteCustomers', hardDeleteCustomers],
  ['hardDeleteSuppliers', hardDeleteSuppliers],
  ['hardDeleteCategories', hardDeleteCategories],
];

const TEN_BLOCKED_018: Array<[string, () => Promise<DeletionSummary>]> = [
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

/** Master data that sales, credit, receiving and Return records point at, across branches. */
function seedReferencedMasterData(): void {
  fakeDb.seed('customers/cust1', { name: 'A', outstandingBalance: 300, branchId: 'B1' });
  fakeDb.seed('customers/cust2', { name: 'B', branchId: 'B2' });
  fakeDb.seed('creditAccounts/cust1', { creditUsed: 300, creditLimit: 1000 });
  fakeDb.seed('creditPayments/cp1', { customerId: 'cust1', amount: 100 });
  fakeDb.seed('creditTransactions/ct1', { customerId: 'cust1' });
  fakeDb.seed('orders/o1', { customerId: 'cust1', branchId: 'B1' });
  fakeDb.seed('suppliers/sup1', { name: 'S1' });
  fakeDb.seed('suppliers/sup2', { name: 'S2' });
  fakeDb.seed('receivings/r1', { supplierId: 'sup1' });
  fakeDb.seed('categories/general', { name: 'ทั่วไป' });
  fakeDb.seed('categories/cat1', { name: 'อาหารสุนัข' });
  fakeDb.seed('products/prod1', { category: 'อาหารสุนัข' });
  fakeDb.seed('products/prod1/productStocks/B1', { totalStockBase: 40 });
  fakeDb.seed('stockLots/l1', { qtyRemaining: 40 });
  fakeDb.seed('saleReturns/ret1', { customerId: 'cust1', originalOrderId: 'o1' });
}

function snapshot(): Map<string, unknown> {
  return new Map([...fakeDb.docs].map(([path, data]) => [path, structuredClone(data)]));
}

async function expectRetiredWithoutSideEffects(name: string, run: () => Promise<DeletionSummary>) {
  const before = snapshot();
  const outcome = await run().then(
    (summary) => ({ ok: true as const, summary }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  expect(outcome.ok, `${name}: a retired tool must never resolve as success`).toBe(false);
  const error = (outcome as { error: unknown }).error;
  expect(error).toBeInstanceOf(UatToolRetiredError);
  expect(error).not.toBeInstanceOf(DangerZoneResetBlockedError);
  const typed = error as UatToolRetiredError;
  expect(typed.code).toBe(UAT_TOOL_RETIRED_CODE);
  expect(typed.action).toBe(name);
  expect(typed.message).toContain('ยกเลิกเครื่องมือนี้แล้ว');
  expect(typed.message).toContain('ไม่ได้อ่านหรือลบข้อมูลใด ๆ');
  // Fail closed BEFORE the first read, auth call, batch or commit.
  expect(fakeDb.ops).toEqual([]);
  expect(fakeDb.committedWrites).toBe(0);
  expect(snapshot()).toEqual(before);
}

beforeEach(() => {
  fakeDb.reset();
});

describe('019 — retired master hard deletes refuse before any read, auth or write', () => {
  test.each(RETIRED)('%s (direct module call, bypassing the UI) refuses with zero side effects', async (name, run) => {
    seedReferencedMasterData();
    await expectRetiredWithoutSideEffects(name, run);
  });

  test('every referenced record survives all three calls: credit, customers, suppliers, categories, history', async () => {
    seedReferencedMasterData();
    for (const [name, run] of RETIRED) await expectRetiredWithoutSideEffects(name, run);
    for (const path of [
      'customers/cust1', 'customers/cust2', 'creditAccounts/cust1', 'creditPayments/cp1',
      'suppliers/sup1', 'suppliers/sup2', 'categories/general', 'categories/cat1',
      'receivings/r1', 'saleReturns/ret1',
    ]) {
      expect(fakeDb.has(path), `${path} must survive`).toBe(true);
    }
  });

  test.each(['permission-denied', 'unavailable'])(
    'denied / offline Firestore (%s) still yields the typed retirement, not a raw error',
    async (code) => {
      seedReferencedMasterData();
      fakeDb.readFailure = code;
      for (const [name, run] of RETIRED) await expectRetiredWithoutSideEffects(name, run);
    },
  );

  test('unconfigured Firebase (local / dev runtime) is refused too, not given the old dev notice', async () => {
    fakeDb.configured = false;
    for (const [name, run] of RETIRED) await expectRetiredWithoutSideEffects(name, run);
  });

  test('empty database: still a refusal, never a "nothing to delete" success', async () => {
    for (const [name, run] of RETIRED) await expectRetiredWithoutSideEffects(name, run);
  });

  test('the UI is told these three are retired — and only these three', () => {
    for (const [, run] of RETIRED) expect(isUatToolRetired(run)).toBe(true);
    for (const [, run] of TEN_BLOCKED_018) expect(isUatToolRetired(run), 'ten 018 resets are not "retired"').toBe(false);
  });
});

describe('019 — the ten 018 resets stay blocked exactly as before', () => {
  test.each(TEN_BLOCKED_018)('%s still refuses with the 018 contract and zero side effects', async (name, run) => {
    seedReferencedMasterData();
    fakeDb.seed('shifts/s1', { status: 'closed' });
    fakeDb.seed('cashTransactions/rfd_ret1', { source: 'sale_refund' });
    const before = snapshot();
    const error = await run().then(
      () => null,
      (e: unknown) => e as Error & { code?: string; action?: string },
    );
    expect(error).toBeInstanceOf(DangerZoneResetBlockedError);
    expect(error).not.toBeInstanceOf(UatToolRetiredError);
    expect(error?.code).toBe('reset_blocked_server_owned_records');
    expect(error?.action).toBe(name);
    expect(fakeDb.ops).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(isResetBlocked(run)).toBe(true);
  });

  test('the 018 gate covers exactly the ten — the three retired tools are not in it', () => {
    for (const [, run] of RETIRED) expect(isResetBlocked(run)).toBe(false);
  });
});
