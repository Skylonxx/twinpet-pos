/**
 * SEC-001 Packet C-A / F7 — settings/_rolePermissions server-authority boundary.
 *
 * Codex-020 Finding 2: the client UI was moved to the `setRolePermissions`
 * callable, but the rules still let a fresh admin client rewrite the matrix
 * document directly, bypassing the callable's validation, its transaction, the
 * staged-deny head, the sweep job and the pairing semantics. Deploying Group 1
 * would therefore not establish the intended server-authoritative mutation
 * boundary.
 *
 * This spec now locks the corrected shape: the document stays READABLE exactly
 * as before (login-time permission resolution and the admin panel both read
 * it), and every client mutation path — full write, create, delete, and the
 * narrow Phase 7B-3B field grant — is denied for every role. The Admin SDK
 * (setRolePermissions / roleSweepScheduler) is the only mutation authority.
 *
 * Note on why the fix is written as an explicit exclusion on each write grant:
 * Firestore ORs every matching `allow`, so adding a specific deny block would
 * do nothing, and removing the id from isGlobalSettingsId() would not close it
 * either because hasBranchAccess() is true for any admin holding 'ALL'.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/settings-role-permissions.spec.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const BRANCH = 'LDP-001';
const staff = { staffId: 'staff1', role: 'staff', branchIds: [BRANCH], permissions: [], authVersion: 0 };
const manager = { staffId: 'mgr1', role: 'manager', branchIds: [BRANCH], permissions: [], authVersion: 0 };
const admin = { staffId: 'admin1', role: 'admin', branchIds: ['ALL'], permissions: [], authVersion: 0 };
const branchAdmin = { staffId: 'admin2', role: 'admin', branchIds: [BRANCH], permissions: [], authVersion: 0 };

const matrix = { rolePermissions: { admin: ['pos_sale'], manager: ['pos_sale'], staff: ['pos_sale'] } };

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
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', 'staff1'), { role: 'staff', isActive: true, deletedAt: null, authVersion: 0 });
    await setDoc(doc(db, 'users', 'mgr1'), { role: 'manager', isActive: true, deletedAt: null, authVersion: 0 });
    await setDoc(doc(db, 'users', 'admin1'), { role: 'admin', isActive: true, deletedAt: null, authVersion: 0 });
    await setDoc(doc(db, 'users', 'admin2'), { role: 'admin', isActive: true, deletedAt: null, authVersion: 0 });
    await setDoc(doc(db, 'settings', '_rolePermissions'), matrix);
    await setDoc(doc(db, 'settings', 'system'), { companyName: 'TwinPet' });
    await setDoc(doc(db, 'settings', 'expiryPolicies'), { defaultDays: 30 });
    await setDoc(doc(db, 'settings', BRANCH), { branchId: BRANCH, requiresPasswordForVoid: false });
  });
});

describe('settings/_rolePermissions reads are preserved', () => {
  it('staff can read the matrix (login-time permission resolution)', async () => {
    const db = testEnv.authenticatedContext('staff1', staff).firestore();
    await assertSucceeds(getDoc(doc(db, 'settings', '_rolePermissions')));
  });

  it('manager can read the matrix', async () => {
    const db = testEnv.authenticatedContext('mgr1', manager).firestore();
    await assertSucceeds(getDoc(doc(db, 'settings', '_rolePermissions')));
  });

  it('admin can read the matrix (admin panel role editor)', async () => {
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertSucceeds(getDoc(doc(db, 'settings', '_rolePermissions')));
  });
});

describe('settings/_rolePermissions client mutation is denied for every role', () => {
  it('global admin CANNOT write the full matrix (server-authority boundary)', async () => {
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertFails(setDoc(doc(db, 'settings', '_rolePermissions'), matrix));
  });

  it('global admin cannot create the matrix document', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), 'settings', '_rolePermissions'));
    });
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertFails(setDoc(doc(db, 'settings', '_rolePermissions'), matrix));
  });

  it('global admin cannot delete the matrix document', async () => {
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertFails(deleteDoc(doc(db, 'settings', '_rolePermissions')));
  });

  it('global admin cannot use the narrow requiresPasswordForVoid grant on the matrix', async () => {
    // hasBranchAccess('_rolePermissions') is TRUE for an 'ALL' admin, so the
    // Phase 7B-3B grant needs its own server-owned exclusion.
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertFails(
      updateDoc(doc(db, 'settings', '_rolePermissions'), { requiresPasswordForVoid: true, updatedAt: new Date() }),
    );
  });

  it('branch-scoped admin cannot write the matrix', async () => {
    const db = testEnv.authenticatedContext('admin2', branchAdmin).firestore();
    await assertFails(setDoc(doc(db, 'settings', '_rolePermissions'), matrix));
  });

  it('manager cannot write the matrix', async () => {
    const db = testEnv.authenticatedContext('mgr1', manager).firestore();
    await assertFails(setDoc(doc(db, 'settings', '_rolePermissions'), matrix));
  });

  it('staff cannot write the matrix', async () => {
    const db = testEnv.authenticatedContext('staff1', staff).firestore();
    await assertFails(setDoc(doc(db, 'settings', '_rolePermissions'), matrix));
  });
});

describe('unrelated settings write behaviour is unchanged', () => {
  it('admin can still write settings/system', async () => {
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertSucceeds(setDoc(doc(db, 'settings', 'system'), { companyName: 'TwinPet 2' }));
  });

  it('admin can still write settings/expiryPolicies', async () => {
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertSucceeds(setDoc(doc(db, 'settings', 'expiryPolicies'), { defaultDays: 45 }));
  });

  it('admin can still write a per-branch settings document', async () => {
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertSucceeds(setDoc(doc(db, 'settings', BRANCH), { branchId: BRANCH, requiresPasswordForVoid: true }));
  });

  it('manager can still use the narrow requiresPasswordForVoid grant on their branch', async () => {
    const db = testEnv.authenticatedContext('mgr1', manager).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'settings', BRANCH), { requiresPasswordForVoid: true, updatedAt: new Date() }),
    );
  });
});
