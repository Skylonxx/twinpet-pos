/**
 * PHASE 2 Track B Step 1 — asyncOrders reconcile-control immutability (rules).
 *
 * The reconcile state machine is SERVER-OWNED. A non-admin client (the offline
 * void-intent merge) may update void fields, but must NOT flip `reconcileStatus`
 * or the retry counter `reconcileAttempts` — those move only via the Admin-SDK
 * reconciler / retryReconcile callable (which bypass rules).
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const BRANCH = 'LDP-001';
const voidStaff = { staffId: 'staff1', role: 'staff', branchIds: [BRANCH], permissions: ['pos_void'] };
const saleStaff = { staffId: 'staff2', role: 'staff', branchIds: [BRANCH], permissions: ['pos_sale'] };
const saleOnly = saleStaff;

// A normal POS checkout intent (matches asyncCheckout.ts): safe baseline only.
const posCreate = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  branchId: BRANCH,
  staffId: 'staff2', // == token.staffId for stampedOwnStaffId
  total: 50,
  status: 'completed',
  reconcileStatus: 'pending_reconcile',
  reconciledAt: null,
  ...over,
});

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-twinpet',
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
  // A settled async order (server-owned reconcile state) to attempt updates against.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'asyncOrders', 'a1'), {
      id: 'a1',
      branchId: BRANCH,
      staffId: 'staff1',
      total: 100,
      status: 'completed',
      reconcileStatus: 'settled',
      reconcileAttempts: 1,
    });
  });
});

describe('asyncOrders reconcile-control immutability (client updates)', () => {
  it('a pos_void client CANNOT flip reconcileStatus', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(updateDoc(doc(db, 'asyncOrders', 'a1'), { reconcileStatus: 'pending_reconcile' }));
  });

  it('a pos_void client CANNOT change reconcileAttempts (reset the retry cap)', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(updateDoc(doc(db, 'asyncOrders', 'a1'), { reconcileAttempts: 0 }));
  });

  it('the legitimate offline void-intent merge (no reconcile fields) still SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertSucceeds(
      setDoc(
        doc(db, 'asyncOrders', 'a1'),
        { voidRequested: true, status: 'voided', voidReason: 'ลูกค้าเปลี่ยนใจ', voidedBy: 'staff1' },
        { merge: true },
      ),
    );
  });

  it('a client without pos_void cannot update at all (existing gate intact)', async () => {
    const db = testEnv.authenticatedContext('staff2', saleOnly).firestore();
    await assertFails(updateDoc(doc(db, 'asyncOrders', 'a1'), { voidRequested: true, status: 'voided' }));
  });
});

describe('asyncOrders create — block server-owned reconcile-field spoofing', () => {
  it('a normal POS checkout intent (safe baseline) still SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertSucceeds(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate()));
  });

  it('create stamping reconcileStatus=settled is DENIED (spoof a sale straight to settled)', async () => {
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertFails(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate({ reconcileStatus: 'settled' })));
  });

  it('create seeding reconcileAttempts is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertFails(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate({ reconcileAttempts: 5 })));
  });

  it('create seeding error/audit control fields is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'c1'), posCreate({ reconcileError: 'x', lastReconcileError: 'x' })),
    );
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'c2'), posCreate({ id: 'c2', adminRetryCount: 1, lastRetryBy: 'staff2' })),
    );
  });

  it('the offline void-intent create (materialize, no reconcile fields) still SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'asyncOrders', 'v1'), {
        id: 'v1',
        branchId: BRANCH,
        voidRequested: true,
        status: 'voided',
        voidReason: 'ลูกค้าเปลี่ยนใจ',
      }),
    );
  });
});
