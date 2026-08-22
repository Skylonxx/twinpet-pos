/**
 * PK-3 — rules alignment for drain-time void pre-flight.
 *
 * Production firestore.rules are UNCHANGED. This spec restates the server-side
 * PF-1 shape (update of a document that does not exist is DENIED) and the
 * same-day ALLOW path so the new file is self-contained and non-vacuous.
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
const staff = {
  staffId: 'staff1',
  role: 'staff',
  branchIds: [BRANCH],
  permissions: ['pos_sale', 'pos_void'],
};

const sevenFieldVoid = {
  voidRequested: true,
  status: 'voided',
  voidReason: 'ลูกค้าเปลี่ยนใจ',
  voidedBy: 'staff1',
  deviceId: 'dev-1',
  voidedAt: new Date(),
  updatedAt: new Date(),
};

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
});

describe('asyncOrders void preflight (PK-3, production rules unchanged)', () => {
  it('RL-01 a void update against a NON-EXISTENT asyncOrders document is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff).firestore();
    await assertFails(updateDoc(doc(db, 'asyncOrders', 'does-not-exist'), sevenFieldVoid));
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'does-not-exist'), sevenFieldVoid, { merge: true }),
    );
  });

  it('RL-02 same-day seven-field void merge is ALLOWED', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'asyncOrders', 'a_same_day'), {
        id: 'a_same_day',
        branchId: BRANCH,
        staffId: 'staff_sale',
        total: 100,
        creditAmt: 0,
        lines: [],
        payments: [],
        status: 'completed',
        reconcileStatus: 'pending_reconcile',
        reconciledAt: null,
        serverCreatedAt: new Date(),
      });
    });
    const db = testEnv.authenticatedContext('staff1', staff).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'asyncOrders', 'a_same_day'), sevenFieldVoid, { merge: true }),
    );
  });

  it('RL-03 an eighth field in the merge is DENIED', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'asyncOrders', 'a_eighth'), {
        id: 'a_eighth',
        branchId: BRANCH,
        staffId: 'staff_sale',
        total: 100,
        creditAmt: 0,
        lines: [],
        payments: [],
        status: 'completed',
        reconcileStatus: 'pending_reconcile',
        reconciledAt: null,
        serverCreatedAt: new Date(),
      });
    });
    const db = testEnv.authenticatedContext('staff1', staff).firestore();
    await assertFails(
      setDoc(
        doc(db, 'asyncOrders', 'a_eighth'),
        { ...sevenFieldVoid, extraField: 'nope' },
        { merge: true },
      ),
    );
  });
});
