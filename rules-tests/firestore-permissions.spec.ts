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

// ── 3. ANY 'staff' can request async void if they log themselves ─────
describe("any staff → async void intent", () => {
  it('creates an async void-intent (voidRequested) by logging own UID (voidedBy)', async () => {
    const db = testEnv.authenticatedContext('staff1', staffWith(['pos_sale'])).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'asyncOrders', 'a_void'), { branchId: BRANCH, voidRequested: true, status: 'voided', voidedBy: 'staff1' }),
    );
  });

  it('DENIES async void if voidedBy does not match their own UID', async () => {
    const db = testEnv.authenticatedContext('staff1', staffWith(['pos_sale'])).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'a_void_bad'), { branchId: BRANCH, voidRequested: true, status: 'voided', voidedBy: 'staff2' }),
    );
  });
});

// Sanity: the rules file compiled & loaded into the emulator at all.
it('rules loaded without syntax errors', () => {
  expect(testEnv).toBeTruthy();
});
