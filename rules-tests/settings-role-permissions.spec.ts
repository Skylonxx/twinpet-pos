/**
 * SEC-001 Packet C-A / F7 — settings/_rolePermissions regression lock.
 *
 * F7 (setRolePermissions/roleSweepScheduler, Admin SDK) is the mechanism that
 * actually finalizes a role's permission row after a staged-deny sweep
 * converges, but the client-facing rules for this document are pre-existing
 * (Admin writes, staff+admin read as a global settings id) and must remain
 * exactly as they were — the Functions-only staging collections
 * (privilegedStagedRoleDeny/privilegedRoleSweepJobs, tested separately) are
 * what actually enforce F7; this doc's own access shape does not change.
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
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const BRANCH = 'LDP-001';
const staff = { staffId: 'staff1', role: 'staff', branchIds: [BRANCH], permissions: [], authVersion: 0 };
const manager = { staffId: 'mgr1', role: 'manager', branchIds: [BRANCH], permissions: [], authVersion: 0 };
const admin = { staffId: 'admin1', role: 'admin', branchIds: ['ALL'], permissions: [], authVersion: 0 };

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
    await setDoc(doc(ctx.firestore(), 'users', 'staff1'), { role: 'staff', isActive: true, deletedAt: null, authVersion: 0 });
    await setDoc(doc(ctx.firestore(), 'users', 'mgr1'), { role: 'manager', isActive: true, deletedAt: null, authVersion: 0 });
    await setDoc(doc(ctx.firestore(), 'users', 'admin1'), { role: 'admin', isActive: true, deletedAt: null, authVersion: 0 });
    await setDoc(doc(ctx.firestore(), 'settings', '_rolePermissions'), matrix);
  });
});

describe('settings/_rolePermissions access shape is unchanged by F7', () => {
  it('staff can read the matrix (login-time permission resolution)', async () => {
    const db = testEnv.authenticatedContext('staff1', staff).firestore();
    await assertSucceeds(getDoc(doc(db, 'settings', '_rolePermissions')));
  });

  it('admin can write the full matrix', async () => {
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertSucceeds(setDoc(doc(db, 'settings', '_rolePermissions'), matrix));
  });

  it('manager cannot write the matrix (not the narrow requiresPasswordForVoid grant)', async () => {
    const db = testEnv.authenticatedContext('mgr1', manager).firestore();
    await assertFails(setDoc(doc(db, 'settings', '_rolePermissions'), matrix));
  });

  it('staff cannot write the matrix', async () => {
    const db = testEnv.authenticatedContext('staff1', staff).firestore();
    await assertFails(setDoc(doc(db, 'settings', '_rolePermissions'), matrix));
  });
});
