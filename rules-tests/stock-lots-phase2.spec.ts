/**
 * PHASE 2 (Track A) — stockLots rules EXPECTED-BEHAVIOR tests.
 *
 * Hardened firestore.rules for `stockLots/{lotId}`:
 *   allow read:   if isStaff();                              // UNCHANGED
 *   allow create: if isStaff() && canMutateStock()
 *                   && request.resource.data.branchId is string;
 *   allow update: if isStaff() && canMutateStock();
 *   allow delete: if isManagerOrAdmin();                     // UNCHANGED
 *
 * Track A goal: arbitrary staff (e.g. pos_sale-only cashiers) can no longer
 * create/rewrite lot qty/cost. Preserved: read access, cross-branch transfer
 * dest-lot creation, void restock, receiving, and delete (manager/admin only).
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
import { doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const HOME = 'LDP-001';
const OTHER = 'BKK-002';

const staff = (branchIds: string[], perms: string[]) => ({
  staffId: 'staff1',
  role: 'staff',
  branchIds,
  permissions: perms,
});
const manager = { staffId: 'mgr1', role: 'manager', branchIds: [HOME], permissions: ['stock_receive', 'product_view'] };
const adminAll = { staffId: 'admin1', role: 'admin', branchIds: ['ALL'], permissions: ['product_view'] };
const notStaff = {};

// Actors
const RECEIVER = staff([HOME], ['stock_receive', 'product_view']);
const TRANSFER_STAFF = staff([HOME], ['pos_sale', 'product_view']); // regular staff → transfer dest lot
const VOID_STAFF = staff([HOME], ['pos_void', 'product_view']);
const CASHIER_ONLY = staff([HOME], ['pos_sale']); // pos_sale-only terminal

const lot = (branch: string, over: Record<string, unknown> = {}) => ({
  productId: 'p1',
  branchId: branch,
  qtyRemaining: 10,
  costPerUnit: 40,
  isDepleted: false,
  receivedAt: null,
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
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'stockLots', 'lotHome'), lot(HOME));
    await setDoc(doc(db, 'stockLots', 'lotOther'), lot(OTHER));
  });
});

// ── READ: UNCHANGED (Track A must not alter read behavior) ───────────────────
describe('stockLots READ (unchanged)', () => {
  it('own-branch lot read by staff SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    await assertSucceeds(getDoc(doc(db, 'stockLots', 'lotHome')));
  });
  it('cross-branch lot read by foreign-branch staff still SUCCEEDS (read NOT branch-scoped — preserved for transfer planning / aggregate reporting)', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    await assertSucceeds(getDoc(doc(db, 'stockLots', 'lotOther')));
  });
  it('pos_sale-only cashier can still READ lots (read unchanged)', async () => {
    const db = testEnv.authenticatedContext('staff1', CASHIER_ONLY).firestore();
    await assertSucceeds(getDoc(doc(db, 'stockLots', 'lotHome')));
  });
  it('non-staff read is DENIED', async () => {
    const db = testEnv.authenticatedContext('ghost', notStaff).firestore();
    await assertFails(getDoc(doc(db, 'stockLots', 'lotHome')));
  });
});

// ── CREATE: stock-capable only; cross-branch transfer dest preserved ─────────
describe('stockLots CREATE (hardened)', () => {
  it('stock-capable staff (stock_receive) creates own-branch lot SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    await assertSucceeds(setDoc(doc(db, 'stockLots', 'newHome'), lot(HOME)));
  });
  it('regular staff (product_view) creates a DEST-branch lot SUCCEEDS (transfer dest preserved, decision #1)', async () => {
    const db = testEnv.authenticatedContext('staff1', TRANSFER_STAFF).firestore();
    await assertSucceeds(setDoc(doc(db, 'stockLots', 'newOther'), lot(OTHER, { costPerUnit: 55 })));
  });
  it('pos_sale-only cashier create is DENIED (now blocked)', async () => {
    const db = testEnv.authenticatedContext('staff1', CASHIER_ONLY).firestore();
    await assertFails(setDoc(doc(db, 'stockLots', 'newCashier'), lot(HOME)));
  });
  it('create WITHOUT a branchId is DENIED (integrity)', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    const { branchId, ...noBranch } = lot(HOME);
    void branchId;
    await assertFails(setDoc(doc(db, 'stockLots', 'newNoBranch'), noBranch));
  });
  it('non-staff create is DENIED', async () => {
    const db = testEnv.authenticatedContext('ghost', notStaff).firestore();
    await assertFails(setDoc(doc(db, 'stockLots', 'newGhost'), lot(HOME)));
  });
});

// ── UPDATE: stock-capable only; transfer/void/receiving updates preserved ────
describe('stockLots UPDATE (hardened)', () => {
  it('stock-capable staff updates own-branch lot qty SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    await assertSucceeds(updateDoc(doc(db, 'stockLots', 'lotHome'), { qtyRemaining: 5 }));
  });
  it('regular staff (product_view) updates a DEST-branch lot SUCCEEDS (transfer dest leg preserved)', async () => {
    const db = testEnv.authenticatedContext('staff1', TRANSFER_STAFF).firestore();
    await assertSucceeds(updateDoc(doc(db, 'stockLots', 'lotOther'), { qtyRemaining: 3 }));
  });
  it('void staff (pos_void) updates a lot SUCCEEDS (restock preserved)', async () => {
    const db = testEnv.authenticatedContext('staff1', VOID_STAFF).firestore();
    await assertSucceeds(updateDoc(doc(db, 'stockLots', 'lotHome'), { qtyRemaining: 12, isDepleted: false }));
  });
  it('pos_sale-only cashier update is DENIED (now blocked)', async () => {
    const db = testEnv.authenticatedContext('staff1', CASHIER_ONLY).firestore();
    await assertFails(updateDoc(doc(db, 'stockLots', 'lotHome'), { costPerUnit: 1 }));
  });
});

// ── UPDATE: branchId is IMMUTABLE (must not change or be removed) ─────────────
describe('stockLots UPDATE — branchId invariant', () => {
  it('changing branchId on an existing lot is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    await assertFails(updateDoc(doc(db, 'stockLots', 'lotHome'), { branchId: OTHER, qtyRemaining: 4 }));
  });
  it('removing branchId on an existing lot is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    await assertFails(updateDoc(doc(db, 'stockLots', 'lotHome'), { branchId: deleteField() }));
  });
  it('an update that re-sends the SAME branchId is ALLOWED', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    await assertSucceeds(updateDoc(doc(db, 'stockLots', 'lotHome'), { branchId: HOME, qtyRemaining: 6 }));
  });
});

// ── DELETE: UNCHANGED (manager/admin only) ───────────────────────────────────
describe('stockLots DELETE (unchanged)', () => {
  it('staff delete is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    await assertFails(deleteDoc(doc(db, 'stockLots', 'lotHome')));
  });
  it('manager delete SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('mgr1', manager).firestore();
    await assertSucceeds(deleteDoc(doc(db, 'stockLots', 'lotHome')));
  });
  it('admin delete SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('admin1', adminAll).firestore();
    await assertSucceeds(deleteDoc(doc(db, 'stockLots', 'lotHome')));
  });
});
