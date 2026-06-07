import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// ── Token shapes ─────────────────────────────────────────────────────────────
// authenticatedContext(uid, claims) projects `claims` onto request.auth.token,
// so these become request.auth.token.{staffId,role,branchIds,permissions}.

const BRANCH = 'LDP-001';

const staffWith = (perms: string[]) => ({
  staffId: 'staff1',
  role: 'staff',
  branchIds: [BRANCH],
  permissions: perms,
});

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  // emulators:exec injects FIRESTORE_EMULATOR_HOST (e.g. "127.0.0.1:8085").
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
  // Seed an existing order (rules-bypassed) for the void/update scenarios.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'orders', 'o1'), {
      branchId: BRANCH,
      staffId: 'staff1',
      total: 100,
      status: 'completed',
    });
  });
});

// ── 1. Plain 'staff' with ['pos_sale'] can create orders + asyncOrders ───────
describe("staff ['pos_sale'] → checkout create", () => {
  it('creates a canonical order', async () => {
    const db = testEnv.authenticatedContext('staff1', staffWith(['pos_sale'])).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'orders', 'o_new'), { branchId: BRANCH, staffId: 'staff1', total: 50 }),
    );
  });

  it('creates an async (offline-intent) order', async () => {
    const db = testEnv.authenticatedContext('staff1', staffWith(['pos_sale'])).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'asyncOrders', 'a_new'), { branchId: BRANCH, staffId: 'staff1', total: 50 }),
    );
  });

  it('DENIES create without pos_sale (proves the gate is real)', async () => {
    const db = testEnv.authenticatedContext('staff1', staffWith(['product_view'])).firestore();
    await assertFails(
      setDoc(doc(db, 'orders', 'o_bad'), { branchId: BRANCH, staffId: 'staff1', total: 50 }),
    );
  });
});

// ── 2. Plain 'staff' with ['pos_void'] can void canonical orders ─────
describe("staff ['pos_void'] → void/update", () => {
  it('updates (voids) a canonical order with NO manager/admin role', async () => {
    const db = testEnv.authenticatedContext('staff1', staffWith(['pos_void'])).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'orders', 'o1'), { status: 'voided', voidReason: 'test' }),
    );
  });

  it('DENIES void of canonical orders when only pos_sale is granted (no pos_void)', async () => {
    const db = testEnv.authenticatedContext('staff1', staffWith(['pos_sale'])).firestore();
    await assertFails(
      updateDoc(doc(db, 'orders', 'o1'), { status: 'voided' }),
    );
  });
});

// ── 3. ANY 'staff' can request async void if they log themselves AND it's same-day ─────
describe("any staff → async void intent", () => {
  it('updates an existing asyncOrder with void-intent (voidRequested) by logging own UID (voidedBy)', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'asyncOrders', 'a_void_update'), {
        branchId: BRANCH,
        reconcileStatus: 'pending_reconcile',
        lines: [], payments: [], total: 100, creditAmt: 0,
        staffId: 'staff_sale',
        deviceId: 'dev1',
        id: 'a_void_update',
        reconciledAt: null,
        serverCreatedAt: new Date(), // Same day
      });
    });

    const db = testEnv.authenticatedContext('staff1', staffWith(['pos_sale'])).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'asyncOrders', 'a_void_update'), { voidRequested: true, status: 'voided', voidedBy: 'staff1' }, { merge: true }),
    );
  });

  it('DENIES async void update if voidedBy does not match their own UID', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'asyncOrders', 'a_void_update_bad'), {
        branchId: BRANCH,
        reconcileStatus: 'pending_reconcile',
        lines: [], payments: [], total: 100, creditAmt: 0,
        staffId: 'staff_sale',
        deviceId: 'dev1',
        id: 'a_void_update_bad',
        reconciledAt: null,
        serverCreatedAt: new Date(), // Same day
      });
    });

    const db = testEnv.authenticatedContext('staff1', staffWith(['pos_sale'])).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'a_void_update_bad'), { voidRequested: true, status: 'voided', voidedBy: 'staff2' }, { merge: true }),
    );
  });

  it('DENIES cross-day async void update for standard staff', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1); // 24 hours ago, guaranteed cross-day
      
      await setDoc(doc(ctx.firestore(), 'asyncOrders', 'a_void_update_crossday'), {
        branchId: BRANCH,
        reconcileStatus: 'pending_reconcile',
        lines: [], payments: [], total: 100, creditAmt: 0,
        staffId: 'staff_sale',
        deviceId: 'dev1',
        id: 'a_void_update_crossday',
        reconciledAt: null,
        serverCreatedAt: yesterday,
      });
    });

    const db = testEnv.authenticatedContext('staff1', staffWith(['pos_sale'])).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'a_void_update_crossday'), { voidRequested: true, status: 'voided', voidedBy: 'staff1' }, { merge: true }),
    );
  });

  it('DENIES async void update if serverCreatedAt is missing (legacy compatibility safety)', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'asyncOrders', 'a_void_update_missing_date'), {
        branchId: BRANCH,
        reconcileStatus: 'pending_reconcile',
        lines: [], payments: [], total: 100, creditAmt: 0,
        staffId: 'staff_sale',
        deviceId: 'dev1',
        id: 'a_void_update_missing_date',
        reconciledAt: null,
        // intentionally omitting serverCreatedAt
      });
    });

    const db = testEnv.authenticatedContext('staff1', staffWith(['pos_sale'])).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'a_void_update_missing_date'), { voidRequested: true, status: 'voided', voidedBy: 'staff1' }, { merge: true }),
    );
  });

  it('DENIES async void update if serverCreatedAt is explicitly null', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'asyncOrders', 'a_void_update_null_date'), {
        branchId: BRANCH,
        reconcileStatus: 'pending_reconcile',
        lines: [], payments: [], total: 100, creditAmt: 0,
        staffId: 'staff_sale',
        deviceId: 'dev1',
        id: 'a_void_update_null_date',
        reconciledAt: null,
        serverCreatedAt: null,
      });
    });

    const db = testEnv.authenticatedContext('staff1', staffWith(['pos_sale'])).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'a_void_update_null_date'), { voidRequested: true, status: 'voided', voidedBy: 'staff1' }, { merge: true }),
    );
  });
});

// Sanity: the rules file compiled & loaded into the emulator at all.
it('rules loaded without syntax errors', () => {
  expect(testEnv).toBeTruthy();
});
