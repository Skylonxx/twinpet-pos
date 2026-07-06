/**
 * W-01 evidence (rules side) — asyncOrders CREATE denials return permission-denied.
 *
 * Proves that a checkout `asyncOrders` create violating a create gate is DENIED by
 * Firestore security rules. The client (`submitAsyncOrder`) issues this write
 * fire-and-forget; a rule denial surfaces as a `permission-denied` rejection on the
 * setDoc promise — which the current client swallows into a "queued, will retry"
 * console.warn (see src/lib/pos/asyncCheckout.w01.test.ts for the client "before" state).
 *
 * Scope is narrow: only the create gates NOT already covered by
 * async-orders-phase2b.spec.ts (which covers reconcile-field spoofing + void updates).
 * Here we target: missing pos_sale permission, branch-scope mismatch, and staffId
 * mismatch — plus one representative reconcile-state spoof and a positive baseline.
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
import { doc, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const BRANCH = 'LDP-001';
const OTHER_BRANCH = 'BKK-002';

// A pos_sale staff in BRANCH whose token.staffId == 'staff2'.
const saleStaff = { staffId: 'staff2', role: 'staff', branchIds: [BRANCH], permissions: ['pos_sale'] };
// A staff WITHOUT pos_sale (only pos_void) — same branch/identity otherwise.
const noSaleStaff = { staffId: 'staff2', role: 'staff', branchIds: [BRANCH], permissions: ['pos_void'] };

// A normal POS checkout intent (matches asyncCheckout.ts buildAsyncOrder baseline):
// safe initial reconcile state, stamps the caller's own staffId.
const posCreate = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  branchId: BRANCH,
  staffId: 'staff2', // must equal token.staffId for stampedOwnStaffId
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
});

describe('W-01 · asyncOrders create is DENIED (permission-denied) for gate violations', () => {
  it('baseline: a valid pos_sale checkout intent SUCCEEDS (control)', async () => {
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertSucceeds(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate()));
  });

  it('DENIED: create WITHOUT pos_sale permission (only pos_void) → rule reject', async () => {
    // hasPerm('pos_sale') is false → create denied. This is the exact shape a mis-permissioned
    // device would hit; the client currently logs it as "queued, will retry".
    const db = testEnv.authenticatedContext('staff2', noSaleStaff).firestore();
    await assertFails(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate()));
  });

  it('DENIED: create with branchId OUTSIDE the caller branch scope → rule reject', async () => {
    // hasBranchAccess(branchId) is false (staff branch is LDP-001, doc says BKK-002).
    // staffId still matches the token, so the denial is attributable to the branch gate.
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertFails(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate({ branchId: OTHER_BRANCH })));
  });

  it('DENIED: create stamping a staffId that is NOT the caller token staffId → rule reject', async () => {
    // stampedOwnStaffId(data) is false (token.staffId='staff2', doc.staffId='someoneElse').
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertFails(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate({ staffId: 'someoneElse' })));
  });

  it('DENIED: create seeding an unsafe initial reconcile state (reconcileStatus=settled) → rule reject', async () => {
    // safeInitialReconcileState(data) is false — representative of the server-owned state machine
    // guard (fuller coverage lives in async-orders-phase2b.spec.ts).
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertFails(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate({ reconcileStatus: 'settled' })));
  });
});
