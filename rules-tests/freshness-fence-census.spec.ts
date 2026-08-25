import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, type Firestore } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * R6 61-category authority census: 3 A + 2 B + 29 C + 27 D.
 * C29 = adjustmentItems update/delete with hasFreshBranchAccess.
 */
const BRANCH = 'LDP-001';
const OTHER = 'BKK-002';
const TRANSFER_ID = 'tr1';

const CENSUS = {
  A: ['A1', 'A2', 'A3'],
  B: ['B1', 'B2'],
  C: [
    'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10',
    'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17', 'C18', 'C19', 'C20',
    'C21', 'C22', 'C23', 'C24', 'C25', 'C26', 'C27', 'C28', 'C29',
  ],
  D: [
    'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10',
    'D11', 'D12', 'D13', 'D14', 'D15', 'D16', 'D17', 'D18', 'D19', 'D20',
    'D21', 'D22', 'D23', 'D24', 'D25', 'D26', 'D27',
  ],
} as const;

const LIVE = { isActive: true, deletedAt: null, authVersion: 0 };

const freshStaff = {
  staffId: 's1',
  role: 'staff' as const,
  branchIds: [BRANCH, OTHER],
  permissions: ['stock_receive', 'product_view', 'pos_sale', 'pos_void'],
  authVersion: 0,
};
const staleStaff = {
  staffId: 's1',
  role: 'staff' as const,
  branchIds: [BRANCH, OTHER],
  permissions: ['stock_receive', 'product_view', 'pos_sale', 'pos_void'],
};
const freshAdmin = {
  staffId: 'a1',
  role: 'admin' as const,
  branchIds: ['ALL'],
  permissions: [],
  authVersion: 0,
};
const staleAdmin = {
  staffId: 'a1',
  role: 'admin' as const,
  branchIds: ['ALL'],
  permissions: [],
};

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-twinpet-pkt1-census',
    firestore: {
      rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8'),
      host,
      port: Number(port),
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', 's1'), LIVE);
    await setDoc(doc(db, 'users', 'a1'), LIVE);
    await setDoc(doc(db, 'products', 'p1', 'productStocks', BRANCH), { branchId: BRANCH, totalStockBase: 10 });
    await setDoc(doc(db, 'stockLots', 'lot1'), { productId: 'p1', branchId: BRANCH, qtyRemaining: 10, costPerUnit: 1, isDepleted: false });
    await setDoc(doc(db, 'parkedOrders', 'pk1'), { branchId: BRANCH });
    await setDoc(doc(db, 'parkedOrders', 'pk1', 'parkedItems', 'i1'), { qty: 1 });
    await setDoc(doc(db, 'quotations', 'q1'), { branchId: BRANCH });
    await setDoc(doc(db, 'quotations', 'q1', 'quotationItems', 'i1'), { qty: 1 });
    await setDoc(doc(db, 'receivings', 'r1'), { branchId: BRANCH });
    await setDoc(doc(db, 'receivings', 'r1', 'receivingItems', 'i1'), { qty: 1 });
    await setDoc(doc(db, 'inventoryAdjustments', 'adj1'), { branchId: BRANCH });
    await setDoc(doc(db, 'inventoryAdjustments', 'adj1', 'adjustmentItems', 'i1'), { qty: 1 });
    await setDoc(doc(db, 'inventoryTransfers', TRANSFER_ID), {
      fromBranchId: BRANCH,
      toBranchId: OTHER,
      status: 'completed',
    });
    await setDoc(doc(db, 'inventoryTransfers', TRANSFER_ID, 'transferItems', 'i1'), { qty: 1 });
    await setDoc(doc(db, 'suppliers', 'sup1'), { allowedBranchIds: [BRANCH], isActive: true });
    await setDoc(doc(db, 'customers', 'c1'), { name: 'A' });
    await setDoc(doc(db, 'creditAccounts', 'ca1'), { balance: 0 });
    await setDoc(doc(db, 'settings', BRANCH), { branchId: BRANCH, requiresPasswordForVoid: true });
    await setDoc(doc(db, 'settings', BRANCH, 'docCounters', 'receipt'), { n: 1 });
    await setDoc(doc(db, 'categories', 'cat1'), { name: 'x' });
    await setDoc(doc(db, 'orders', 'o1'), { branchId: BRANCH, total: 1 });
    await setDoc(doc(db, 'asyncOrders', 'a1'), { branchId: BRANCH, staffId: 's1', total: 1 });
  });
});

type Probe = { id: string; run: (db: Firestore) => Promise<unknown> };

const cProbes: Probe[] = [
  { id: 'C1', run: (db) => setDoc(doc(db, 'products', 'p1', 'productStocks', BRANCH), { branchId: BRANCH, totalStockBase: 11 }, { merge: true }) },
  { id: 'C2', run: (db) => setDoc(doc(db, 'stockLots', 'lot-new'), { productId: 'p1', branchId: BRANCH, qtyRemaining: 1, costPerUnit: 1, isDepleted: false }) },
  { id: 'C3', run: (db) => setDoc(doc(db, 'stockMovements', 'm1'), { branchId: BRANCH, refType: 'sale', qty: 1 }) },
  { id: 'C4', run: (db) => setDoc(doc(db, 'stockMovements', 'm2'), { branchId: OTHER, refType: 'inventoryTransfer', qty: 1 }) },
  { id: 'C5', run: (db) => setDoc(doc(db, 'parkedOrders', 'pk2'), { branchId: BRANCH }) },
  { id: 'C6', run: (db) => setDoc(doc(db, 'parkedOrders', 'pk1', 'parkedItems', 'i2'), { qty: 1 }) },
  { id: 'C7', run: (db) => updateDoc(doc(db, 'parkedOrders', 'pk1', 'parkedItems', 'i1'), { qty: 2 }) },
  { id: 'C8', run: (db) => setDoc(doc(db, 'quotations', 'q2'), { branchId: BRANCH }) },
  { id: 'C9', run: (db) => setDoc(doc(db, 'quotations', 'q1', 'quotationItems', 'i2'), { qty: 1 }) },
  { id: 'C10', run: (db) => updateDoc(doc(db, 'quotations', 'q1', 'quotationItems', 'i1'), { qty: 2 }) },
  { id: 'C11', run: (db) => setDoc(doc(db, 'receivings', 'r1', 'receivingItems', 'i2'), { qty: 1 }) },
  { id: 'C12', run: (db) => updateDoc(doc(db, 'receivings', 'r1', 'receivingItems', 'i1'), { qty: 2 }) },
  { id: 'C13', run: (db) => setDoc(doc(db, 'inventoryAdjustments', 'adj2'), { branchId: BRANCH }) },
  { id: 'C14', run: (db) => setDoc(doc(db, 'inventoryAdjustments', 'adj1', 'adjustmentItems', 'i2'), { qty: 1 }) },
  { id: 'C15', run: (db) => setDoc(doc(db, 'inventoryTransfers', 'tr2'), { fromBranchId: BRANCH, toBranchId: OTHER }) },
  { id: 'C16', run: (db) => setDoc(doc(db, 'inventoryTransfers', TRANSFER_ID, 'transferItems', 'i2'), { qty: 1 }) },
  { id: 'C17', run: (db) => updateDoc(doc(db, 'inventoryTransfers', TRANSFER_ID, 'transferItems', 'i1'), { qty: 2 }) },
  {
    id: 'C18',
    run: (db) =>
      setDoc(doc(db, 'inventoryTransfers', TRANSFER_ID, 'transferDiscrepancies', 'd1'), {
        id: 'd1',
        transferId: TRANSFER_ID,
        fromBranchId: BRANCH,
        toBranchId: OTHER,
        status: 'reported',
        reason: 'short',
        lines: [{ productId: 'P', expectedQty: 1, actualQty: 0, difference: -1 }],
        reportedByStaffId: 's1',
        reportedByStaffName: 'S',
        reportedByBranchId: OTHER,
      }),
  },
  { id: 'C19', run: (db) => setDoc(doc(db, 'cashTransactions', 'ct1'), { branchId: BRANCH, amount: 1 }) },
  { id: 'C20', run: (db) => setDoc(doc(db, 'suppliers', 'sup2'), { allowedBranchIds: [BRANCH], isActive: true }) },
  { id: 'C21', run: (db) => updateDoc(doc(db, 'suppliers', 'sup1'), { isActive: true, allowedBranchIds: [BRANCH] }) },
  { id: 'C22', run: (db) => setDoc(doc(db, 'customers', 'c2'), { name: 'B' }) },
  { id: 'C23', run: (db) => setDoc(doc(db, 'creditAccounts', 'ca2'), { balance: 0 }) },
  { id: 'C24', run: (db) => setDoc(doc(db, 'creditTransactions', 'ctx1'), { amount: 1 }) },
  { id: 'C25', run: (db) => setDoc(doc(db, 'creditPayments', 'cp1'), { amount: 1 }) },
  { id: 'C26', run: (db) => setDoc(doc(db, 'settings', BRANCH, 'docCounters', 'receipt'), { n: 2 }, { merge: true }) },
  { id: 'C27', run: (db) => setDoc(doc(db, 'staffActivities', 'act1'), { kind: 'login' }) },
  { id: 'C28', run: (db) => setDoc(doc(db, 'auditLogs', 'log1'), { action: 'x' }) },
  { id: 'C29', run: (db) => updateDoc(doc(db, 'inventoryAdjustments', 'adj1', 'adjustmentItems', 'i1'), { qty: 9 }) },
];

describe('61-category freshness census', () => {
  it('is 3 A + 2 B + 29 C + 27 D', () => {
    expect(CENSUS.A).toHaveLength(3);
    expect(CENSUS.B).toHaveLength(2);
    expect(CENSUS.C).toHaveLength(29);
    expect(CENSUS.D).toHaveLength(27);
    expect(CENSUS.A.length + CENSUS.B.length + CENSUS.C.length + CENSUS.D.length).toBe(61);
  });

  it('covers every C probe id C1-C29 including C29', () => {
    expect(cProbes.map((p) => p.id)).toEqual([...CENSUS.C]);
  });

  it.each(cProbes)('$id is denied for a stale staff token', async (probe) => {
    const db = testEnv.authenticatedContext('s1', staleStaff).firestore();
    await assertFails(probe.run(db));
  });

  it('C29 adjustmentItems update is allowed for a fresh staff token', async () => {
    const db = testEnv.authenticatedContext('s1', freshStaff).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'inventoryAdjustments', 'adj1', 'adjustmentItems', 'i1'), { qty: 9 }),
    );
  });

  it('C29 adjustmentItems delete is denied stale and allowed fresh', async () => {
    const stale = testEnv.authenticatedContext('s1', staleStaff).firestore();
    await assertFails(deleteDoc(doc(stale, 'inventoryAdjustments', 'adj1', 'adjustmentItems', 'i1')));
    const fresh = testEnv.authenticatedContext('s1', freshStaff).firestore();
    await assertSucceeds(deleteDoc(doc(fresh, 'inventoryAdjustments', 'adj1', 'adjustmentItems', 'i1')));
  });

  it('B1/B2 stale staff can still read ordinary surfaces', async () => {
    const db = testEnv.authenticatedContext('s1', staleStaff).firestore();
    await assertSucceeds(getDoc(doc(db, 'stockLots', 'lot1')));
    await assertSucceeds(getDoc(doc(db, 'users', 's1')));
    await assertSucceeds(getDoc(doc(db, 'orders', 'o1')));
  });

  it('D16 productStocks delete is denied stale admin and allowed fresh admin', async () => {
    const stale = testEnv.authenticatedContext('a1', staleAdmin).firestore();
    await assertFails(deleteDoc(doc(stale, 'products', 'p1', 'productStocks', BRANCH)));
    const fresh = testEnv.authenticatedContext('a1', freshAdmin).firestore();
    await assertSucceeds(deleteDoc(doc(fresh, 'products', 'p1', 'productStocks', BRANCH)));
  });
});
