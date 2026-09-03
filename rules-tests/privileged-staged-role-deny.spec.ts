/**
 * SEC-001 Packet C-A / F7 — privilegedStagedRoleDeny (head docs) is
 * Functions-only. An admin must not be able to forge or clear a staged-deny
 * round directly — that would let a client bypass F7's fail-closed sweep.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/privileged-staged-role-deny.spec.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const admin = { staffId: 'admin1', role: 'admin', branchIds: ['ALL'], permissions: [], authVersion: 0 };

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
    await setDoc(doc(ctx.firestore(), 'users', 'admin1'), { role: 'admin', isActive: true, deletedAt: null, authVersion: 0 });
  });
});

describe('privilegedStagedRoleDeny is deny-all, even to an admin', () => {
  it('admin cannot read an active staged-deny head', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'privilegedStagedRoleDeny', 'staff'), {
        state: 'DRAINING',
        changeId: 'c1',
        deniedPermissions: ['pos_void'],
      });
    });
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertFails(getDoc(doc(db, 'privilegedStagedRoleDeny', 'staff')));
  });

  it('admin cannot forge a staged-deny head to bypass F7', async () => {
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertFails(
      setDoc(doc(db, 'privilegedStagedRoleDeny', 'staff'), { state: 'COMPLETED', changeId: 'forged', deniedPermissions: [] }),
    );
  });

  it('admin cannot force-clear (COMPLETE) an in-flight round directly', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'privilegedStagedRoleDeny', 'staff'), {
        state: 'DRAINING',
        changeId: 'c1',
        deniedPermissions: ['pos_void'],
      });
    });
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertFails(updateDoc(doc(db, 'privilegedStagedRoleDeny', 'staff'), { state: 'COMPLETED' }));
    await assertFails(deleteDoc(doc(db, 'privilegedStagedRoleDeny', 'staff')));
  });
});
