import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

// Return/Refund V1 blocker fix D-RET-FIX-9: accepted Return records become the
// client-readable reporting adjustment source. Reads are branch-scoped exactly
// like `orders`; every client write stays denied; the other Return collections
// remain server-only (catch-all deny).

const BRANCH = 'LDP-001';
const OTHER = 'BKK-002';

const staff = (over: Record<string, unknown> = {}) => ({
  staffId: 'staff1',
  role: 'staff',
  branchIds: [BRANCH],
  permissions: ['pos_sale'],
  authVersion: 0,
  ...over,
});
const admin = () => ({ staffId: 'admin1', role: 'admin', branchIds: ['ALL'], permissions: ['pos_sale'], authVersion: 0 });

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-twinpet-sale-returns',
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
    await setDoc(doc(db, 'saleReturns', 'r1'), { branchId: BRANCH, originalOrderId: 'o1', status: 'completed' });
    await setDoc(doc(db, 'saleReturns', 'r2'), { branchId: OTHER, originalOrderId: 'o2', status: 'completed' });
    await setDoc(doc(db, 'saleRefunds', 'r1'), { branchId: BRANCH });
    await setDoc(doc(db, 'saleReturnLedgers', 'o1'), { branchId: BRANCH });
    await setDoc(doc(db, 'saleReturnAuditEvents', 'r1_completed'), { branchId: BRANCH });
    await setDoc(doc(db, 'saleReturnAttemptResolutions', 'r9'), { branchId: BRANCH });
    const live = { isActive: true, deletedAt: null, authVersion: 0 };
    await setDoc(doc(db, 'users', 'staff1'), live);
    await setDoc(doc(db, 'users', 'admin1'), live);
  });
});

describe('RR saleReturns reporting read', () => {
  it('RR01 same-branch staff can read a Return record and query their branch', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(getDoc(doc(db, 'saleReturns', 'r1')));
    await assertSucceeds(getDocs(query(collection(db, 'saleReturns'), where('branchId', '==', BRANCH))));
  });

  it('RR02 other-branch read and an unscoped staff query are DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(getDoc(doc(db, 'saleReturns', 'r2')));
    await assertFails(getDocs(query(collection(db, 'saleReturns'), where('branchId', '==', OTHER))));
    await assertFails(getDocs(collection(db, 'saleReturns')));
  });

  it('RR03 admin can read any branch', async () => {
    const db = testEnv.authenticatedContext('admin1', admin()).firestore();
    await assertSucceeds(getDoc(doc(db, 'saleReturns', 'r2')));
  });

  it('RR04 unauthenticated read is DENIED', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'saleReturns', 'r1')));
  });

  it('RR05 every client write to saleReturns is DENIED (admin included)', async () => {
    for (const ctx of [testEnv.authenticatedContext('staff1', staff()), testEnv.authenticatedContext('admin1', admin())]) {
      const db = ctx.firestore();
      await assertFails(setDoc(doc(db, 'saleReturns', 'new'), { branchId: BRANCH, status: 'completed' }));
      await assertFails(updateDoc(doc(db, 'saleReturns', 'r1'), { status: 'void' }));
      await assertFails(deleteDoc(doc(db, 'saleReturns', 'r1')));
    }
  });

  it('RR06 refunds / ledgers / audit events / attempt fences stay server-only', async () => {
    const db = testEnv.authenticatedContext('admin1', admin()).firestore();
    for (const path of ['saleRefunds/r1', 'saleReturnLedgers/o1', 'saleReturnAuditEvents/r1_completed', 'saleReturnAttemptResolutions/r9']) {
      const [c, id] = path.split('/') as [string, string];
      await assertFails(getDoc(doc(db, c, id)));
      await assertFails(setDoc(doc(db, c, `${id}x`), { branchId: BRANCH }));
    }
  });
});
