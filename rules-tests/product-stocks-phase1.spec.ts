/**
 * PHASE 1 — productStocks rules EXPECTED-BEHAVIOR tests.
 *
 * Hardened firestore.rules for `products/{pid}/productStocks/{branch}`:
 *   allow create, update: if isStaff()
 *     && request.resource.data.branchId == stockBranchId   // anti-spoof
 *     && canMutateStock();                                  // not pos_sale-only
 *   allow delete: if isAdmin();                             // admin-only (real)
 *
 * Preserved business behavior:
 *   #1 regular staff can initiate branch transfers (cross-branch dest write OK),
 *   #2 oversell/negative stock allowed; POS checkout never blocked.
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
import { doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';
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
const RECEIVER = staff([HOME], ['stock_receive', 'product_view']); // receiving / own-branch
const TRANSFER_STAFF = staff([HOME], ['pos_sale', 'product_view']); // regular staff → transfers (decision #1)
const VOID_STAFF = staff([HOME], ['pos_void', 'product_view']);
const CASHIER_ONLY = staff([HOME], ['pos_sale']); // pos_sale-only terminal

const stockPath = (pid: string, branch: string) => `products/${pid}/productStocks/${branch}`;
const stockDoc = (branch: string, total = 10) => ({
  branchId: branch,
  totalStockBase: total,
  lastMovementAt: null,
  updatedAt: null,
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
    await setDoc(doc(db, stockPath('p1', HOME)), stockDoc(HOME, 10));
    await setDoc(doc(db, stockPath('p1', OTHER)), stockDoc(OTHER, 10));
  });
});

// ── Reads: branch-isolated (unchanged) ───────────────────────────────────────
describe('productStocks READ (unchanged)', () => {
  it('own-branch read by branch staff SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    await assertSucceeds(getDoc(doc(db, stockPath('p1', HOME))));
  });
  it('cross-branch read by foreign-branch staff is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    await assertFails(getDoc(doc(db, stockPath('p1', OTHER))));
  });
  it('admin reads any branch', async () => {
    const db = testEnv.authenticatedContext('admin1', adminAll).firestore();
    await assertSucceeds(getDoc(doc(db, stockPath('p1', OTHER))));
  });
});

// ── Own-branch writes: still allowed for stock-capable staff ─────────────────
describe('productStocks WRITE — own-branch (preserved)', () => {
  it('branch staff with stock_receive writes own-branch stock (branchId==docId) SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    await assertSucceeds(setDoc(doc(db, stockPath('p1', HOME)), stockDoc(HOME, 25), { merge: true }));
  });
  it('void staff (pos_void) writes own-branch stock SUCCEEDS (void restock preserved)', async () => {
    const db = testEnv.authenticatedContext('staff1', VOID_STAFF).firestore();
    await assertSucceeds(setDoc(doc(db, stockPath('p1', HOME)), stockDoc(HOME, 12), { merge: true }));
  });
  it('admin own-branch write SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('admin1', adminAll).firestore();
    await assertSucceeds(setDoc(doc(db, stockPath('p1', HOME)), stockDoc(HOME, 25), { merge: true }));
  });
});

// ── Cross-branch transfer destination leg: still allowed (decision #1) ───────
describe('productStocks WRITE — cross-branch transfer dest (preserved, decision #1)', () => {
  it('regular staff (pos_sale+product_view) writes the DEST branch stock with branchId==docId SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('staff1', TRANSFER_STAFF).firestore();
    await assertSucceeds(setDoc(doc(db, stockPath('p1', OTHER)), stockDoc(OTHER, 30), { merge: true }));
  });
});

// ── Anti-spoof: branchId MUST equal the doc id (now blocked) ─────────────────
describe('productStocks WRITE — branchId spoof (now BLOCKED)', () => {
  it('write to OTHER doc id while stamping branchId=HOME is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    await assertFails(
      setDoc(doc(db, stockPath('p1', OTHER)), { ...stockDoc(OTHER, 5), branchId: HOME }, { merge: true }),
    );
  });
  it('write to HOME doc id while stamping branchId=OTHER is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    await assertFails(
      setDoc(doc(db, stockPath('p1', HOME)), { ...stockDoc(HOME, 5), branchId: OTHER }, { merge: true }),
    );
  });
});

// ── Permission gate: pos_sale-only cashier cannot mutate stock (now blocked) ─
describe('productStocks WRITE — permission gate (now BLOCKED)', () => {
  it('pos_sale-only cashier own-branch write is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', CASHIER_ONLY).firestore();
    await assertFails(setDoc(doc(db, stockPath('p1', HOME)), stockDoc(HOME, 7), { merge: true }));
  });
  it('non-staff (no staffId claim) is DENIED', async () => {
    const db = testEnv.authenticatedContext('ghost', notStaff).firestore();
    await assertFails(setDoc(doc(db, stockPath('p1', HOME)), stockDoc(HOME, 1), { merge: true }));
  });
});

// ── Delete: admin-only and genuinely enforced (now blocked for non-admins) ───
describe('productStocks DELETE — admin only (now enforced)', () => {
  it('own-branch staff delete is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    await assertFails(deleteDoc(doc(db, stockPath('p1', HOME))));
  });
  it('cross-branch staff delete is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', RECEIVER).firestore();
    await assertFails(deleteDoc(doc(db, stockPath('p1', OTHER))));
  });
  it('manager (non-admin) delete is DENIED', async () => {
    const db = testEnv.authenticatedContext('mgr1', manager).firestore();
    await assertFails(deleteDoc(doc(db, stockPath('p1', HOME))));
  });
  it('admin delete SUCCEEDS (Danger Zone hard-delete)', async () => {
    const db = testEnv.authenticatedContext('admin1', adminAll).firestore();
    await assertSucceeds(deleteDoc(doc(db, stockPath('p1', HOME))));
  });
});

// ── Oversell: POS must never be blocked on stock (preserved, decision #2) ────
describe('oversell / sale — never blocked (preserved, decision #2)', () => {
  it('a pos_sale staff creates an asyncOrder for a product with NO stock doc — sale not blocked', async () => {
    const db = testEnv.authenticatedContext('staff1', CASHIER_ONLY).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'asyncOrders', 'a_oversell'), {
        branchId: HOME,
        staffId: 'staff1',
        total: 50,
        lines: [{ productId: 'p_nostock', qtyBase: 5 }],
      }),
    );
  });
  it('the Admin-SDK sale decrement may drive stock NEGATIVE (rules-exempt)', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await assertSucceeds(
        setDoc(doc(db, stockPath('p1', HOME)), stockDoc(HOME, -3), { merge: true }),
      );
    });
  });
});
