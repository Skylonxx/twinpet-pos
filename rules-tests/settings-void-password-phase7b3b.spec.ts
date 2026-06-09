import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, type Firestore } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Phase 7B-3B — Branch void-password policy (Firestore rules).
 *
 * Proves the field-scoped settings grant: Manager/Admin (with branch access) may
 * update ONLY `requiresPasswordForVoid` (+ updatedAt) on their per-branch settings
 * doc; Staff cannot; no one may use this narrow path to change other fields or
 * another branch's settings; the full settings write stays Admin-only.
 */

const BRANCH = 'LDP-001';
const OTHER = 'LDP-002';
const SETTINGS_PATH = `settings/${BRANCH}`;

const manager = (branchId = BRANCH) => ({ staffId: 'm1', role: 'manager', branchIds: [branchId], permissions: [] });
const adminGlobal = { staffId: 'a1', role: 'admin', branchIds: ['ALL'], permissions: [] };
const staff = (branchId = BRANCH) => ({ staffId: 's1', role: 'staff', branchIds: [branchId], permissions: [] });

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
  // Seed an existing per-branch settings doc (rules-bypassed) for the update path.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), SETTINGS_PATH), {
      branchId: BRANCH,
      requiresPasswordForVoid: true,
      allowNegativeStock: false,
      vatRate: 7,
    });
  });
});

const settingsRef = (db: Firestore) => doc(db, 'settings', BRANCH);

describe('settings.requiresPasswordForVoid — field-scoped Manager/Admin grant', () => {
  it('ALLOWS a Manager with branch access to toggle ONLY requiresPasswordForVoid', async () => {
    const db = testEnv.authenticatedContext('u', manager()).firestore();
    await assertSucceeds(
      updateDoc(settingsRef(db), { requiresPasswordForVoid: false, updatedAt: new Date() }),
    );
  });

  it('ALLOWS an Admin to toggle it (full settings authority preserved)', async () => {
    const db = testEnv.authenticatedContext('u', adminGlobal).firestore();
    await assertSucceeds(
      updateDoc(settingsRef(db), { requiresPasswordForVoid: false, updatedAt: new Date() }),
    );
  });

  it('DENIES Staff from toggling requiresPasswordForVoid', async () => {
    const db = testEnv.authenticatedContext('u', staff()).firestore();
    await assertFails(
      updateDoc(settingsRef(db), { requiresPasswordForVoid: false, updatedAt: new Date() }),
    );
  });

  it("DENIES a Manager from toggling ANOTHER branch's setting (no branch access)", async () => {
    const db = testEnv.authenticatedContext('u', manager(OTHER)).firestore();
    await assertFails(
      updateDoc(settingsRef(db), { requiresPasswordForVoid: false, updatedAt: new Date() }),
    );
  });

  it('DENIES a Manager from changing unrelated settings fields via the narrow path', async () => {
    const db = testEnv.authenticatedContext('u', manager()).firestore();
    await assertFails(
      updateDoc(settingsRef(db), {
        requiresPasswordForVoid: false,
        allowNegativeStock: true, // not in the allowed affectedKeys
        updatedAt: new Date(),
      }),
    );
  });

  it('DENIES a Manager from doing a full settings write (Admin-only)', async () => {
    const db = testEnv.authenticatedContext('u', manager()).firestore();
    await assertFails(updateDoc(settingsRef(db), { vatRate: 10, updatedAt: new Date() }));
  });
});
