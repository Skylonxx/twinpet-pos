/**
 * SEC-001 Packet C-A — privileged-void execution outcome fields
 * (`privilegedVoidExecutionId`, `privilegedVoidOacId`, written by
 * `voidIntent.ts`/Admin SDK only) can never be seeded by a client on
 * `asyncOrders` create, and the doc remains immutable to direct client
 * update — a client can never fabricate "this void already completed"
 * correlation state.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/privileged-void-execution-outcomes.spec.ts"
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
const saleStaff = { staffId: 'staff2', role: 'staff', branchIds: [BRANCH], permissions: ['pos_sale'] };

const posCreate = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  branchId: BRANCH,
  staffId: 'staff2',
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
    firestore: { rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8'), host, port: Number(port) },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

describe('privileged-void execution correlation fields cannot be client-seeded', () => {
  it('baseline: a valid pos_sale checkout create still SUCCEEDS (control)', async () => {
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertSucceeds(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate()));
  });

  it('DENIED: create seeding a fake privilegedVoidExecutionId', async () => {
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertFails(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate({ privilegedVoidExecutionId: 'forged-exec-id' })));
  });

  it('DENIED: create seeding a fake privilegedVoidOacId', async () => {
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertFails(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate({ privilegedVoidOacId: 'forged-oac-id' })));
  });

  it('DENIED: direct client update can never write either correlation field (client asyncOrders update is retired)', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'asyncOrders', 'c1'), {
        ...posCreate(),
        status: 'settled',
        reconcileStatus: 'settled',
      });
    });
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertFails(
      updateDoc(doc(db, 'asyncOrders', 'c1'), { privilegedVoidExecutionId: 'forged-exec-id' }),
    );
    await assertFails(updateDoc(doc(db, 'asyncOrders', 'c1'), { privilegedVoidOacId: 'forged-oac-id' }));
  });
});
