/**
 * PHASE 0 — stockLots rules CHARACTERIZATION (read-only analysis).
 *
 * Documents CURRENT behavior of firestore.rules for `stockLots/{lotId}`
 * (firestore.rules:300-309). NO rule/function/behavior changes.
 *
 *   allow read:   if isStaff();              // NO branch scoping
 *   allow create: if isStaff();              // NO branch scoping, NO field checks
 *   allow update: if isStaff();              // NO branch scoping — arbitrary qty/cost
 *   allow delete: if isManagerOrAdmin();     // separate clause → genuinely gated
 *
 * Contrast with productStocks: stockLots uses explicit create/update/delete (not
 * `write`), so the admin-only delete here is REAL — unlike the productStocks
 * `allow write: if isStaff()` which silently subsumes (and thus opens) delete.
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
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const HOME = 'LDP-001';
const OTHER = 'BKK-002';

const staff = (branchIds: string[], perms: string[] = ['stock_receive']) => ({
  staffId: 'staff1',
  role: 'staff',
  branchIds,
  permissions: perms,
});
const manager = { staffId: 'mgr1', role: 'manager', branchIds: [HOME], permissions: [] };
const adminAll = { staffId: 'admin1', role: 'admin', branchIds: ['ALL'], permissions: [] };
const notStaff = {};

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

// ── Reads: NOT branch-isolated (unlike productStocks reads) ──────────────────
describe('stockLots READ', () => {
  it('own-branch lot read by staff SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('staff1', staff([HOME])).firestore();
    await assertSucceeds(getDoc(doc(db, 'stockLots', 'lotHome')));
  });

  it('CURRENT: cross-branch lot read by foreign-branch staff SUCCEEDS (lots are NOT branch-scoped for reads)', async () => {
    const db = testEnv.authenticatedContext('staff1', staff([HOME])).firestore();
    await assertSucceeds(getDoc(doc(db, 'stockLots', 'lotOther')));
  });

  it('non-staff read is DENIED', async () => {
    const db = testEnv.authenticatedContext('ghost', notStaff).firestore();
    await assertFails(getDoc(doc(db, 'stockLots', 'lotHome')));
  });
});

// ── Create: any staff, any branch, any fields ────────────────────────────────
describe('stockLots CREATE', () => {
  it('own-branch lot create by staff SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('staff1', staff([HOME])).firestore();
    await assertSucceeds(setDoc(doc(db, 'stockLots', 'newHome'), lot(HOME)));
  });

  it('CURRENT (unconstrained): foreign-branch staff create a lot for ANOTHER branch SUCCEEDS (needed for transfer dest lot; also unscoped)', async () => {
    const db = testEnv.authenticatedContext('staff1', staff([HOME])).firestore();
    await assertSucceeds(setDoc(doc(db, 'stockLots', 'newOther'), lot(OTHER, { costPerUnit: 999 })));
  });

  it('non-staff create is DENIED', async () => {
    const db = testEnv.authenticatedContext('ghost', notStaff).firestore();
    await assertFails(setDoc(doc(db, 'stockLots', 'newGhost'), lot(HOME)));
  });
});

// ── Update: any staff can rewrite qty/cost on any lot (no branch scoping) ────
describe('stockLots UPDATE', () => {
  it('own-branch lot update by staff SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('staff1', staff([HOME])).firestore();
    await assertSucceeds(updateDoc(doc(db, 'stockLots', 'lotHome'), { qtyRemaining: 5 }));
  });

  it('CURRENT (unconstrained): staff can rewrite qtyRemaining/costPerUnit on ANOTHER branch lot', async () => {
    const db = testEnv.authenticatedContext('staff1', staff([HOME])).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'stockLots', 'lotOther'), { qtyRemaining: 99999, costPerUnit: 0 }),
    );
  });

  it('CURRENT (unconstrained): a cashier with ONLY pos_sale can mutate a lot', async () => {
    const db = testEnv.authenticatedContext('staff1', staff([HOME], ['pos_sale'])).firestore();
    await assertSucceeds(updateDoc(doc(db, 'stockLots', 'lotHome'), { costPerUnit: 1 }));
  });
});

// ── Delete: genuinely manager/admin-only (separate allow delete clause) ──────
describe('stockLots DELETE', () => {
  it('staff delete is DENIED (delete is NOT subsumed here — separate clause)', async () => {
    const db = testEnv.authenticatedContext('staff1', staff([HOME])).firestore();
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
