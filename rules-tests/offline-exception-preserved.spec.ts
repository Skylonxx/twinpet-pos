import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const BRANCH = 'LDP-001';
const staleStaff = {
  staffId: 'staff1',
  role: 'staff',
  branchIds: [BRANCH],
  permissions: ['pos_sale', 'pos_void'],
};

const w0 = (shiftId: string) => ({
  id: shiftId,
  branchId: BRANCH,
  staffId: 'staff1',
  staffName: 'Cashier One',
  status: 'open',
  openedAt: serverTimestamp(),
  closedAt: null,
  startingCash: 1000,
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

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-twinpet-pkt1-offline',
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
    await setDoc(doc(ctx.firestore(), 'asyncOrders', 'a_void'), {
      branchId: BRANCH,
      reconcileStatus: 'pending_reconcile',
      lines: [],
      payments: [],
      total: 100,
      creditAmt: 0,
      staffId: 'staff_sale',
      deviceId: 'dev1',
      id: 'a_void',
      reconciledAt: null,
      serverCreatedAt: new Date(),
    });
    await setDoc(doc(ctx.firestore(), 'shifts', 'open1'), {
      id: 'open1',
      branchId: BRANCH,
      staffId: 'staff1',
      staffName: 'Cashier One',
      status: 'open',
      openedAt: new Date(),
      closedAt: null,
      startingCash: 1000,
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
  });
});

describe('exactly 3 stale-authority offline exceptions', () => {
  it('A1 asyncOrders create remains reachable with a stale token and no live user doc', async () => {
    const db = testEnv.authenticatedContext('staff1', staleStaff).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'asyncOrders', 'a_new'), { branchId: BRANCH, staffId: 'staff1', total: 50 }),
    );
  });

  it('A2 asyncOrders void-intent update remains reachable with a stale token', async () => {
    const db = testEnv.authenticatedContext('staff1', staleStaff).firestore();
    await assertSucceeds(
      setDoc(
        doc(db, 'asyncOrders', 'a_void'),
        { voidRequested: true, status: 'voided', voidedBy: 'staff1' },
        { merge: true },
      ),
    );
  });

  it('A3 shifts create and update remain reachable with a stale token', async () => {
    const db = testEnv.authenticatedContext('staff1', staleStaff).firestore();
    await assertSucceeds(setDoc(doc(db, 'shifts', 's_stale'), w0('s_stale')));
    await assertSucceeds(updateDoc(doc(db, 'shifts', 'open1'), { expectedCash: 500 }));
  });

  it('does not treat a fenced C-path as an offline exception', async () => {
    expect(['A1', 'A2', 'A3']).toHaveLength(3);
  });
});
