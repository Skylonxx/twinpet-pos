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
const saleOnly = { staffId: 'staff2', role: 'staff', branchIds: [BRANCH], permissions: ['pos_sale'] };

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
