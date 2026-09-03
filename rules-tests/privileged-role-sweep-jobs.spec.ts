/**
 * SEC-001 Packet C-A / F7 — privilegedRoleSweepJobs is Functions-only
 * (roleSweepScheduler owns every transition). No client may read job
 * progress or forge/advance a job directly.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/privileged-role-sweep-jobs.spec.ts"
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

describe('privilegedRoleSweepJobs is deny-all, even to an admin', () => {
  it('admin cannot read a job doc', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'privilegedRoleSweepJobs', 'job1'), { roleId: 'staff', state: 'DRAINING', changeId: 'c1' });
    });
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertFails(getDoc(doc(db, 'privilegedRoleSweepJobs', 'job1')));
  });

  it('admin cannot create, update, or delete a job doc', async () => {
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertFails(setDoc(doc(db, 'privilegedRoleSweepJobs', 'job1'), { roleId: 'staff', state: 'DRAINING', changeId: 'c1' }));
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'privilegedRoleSweepJobs', 'job1'), { roleId: 'staff', state: 'DRAINING', changeId: 'c1' });
    });
    await assertFails(updateDoc(doc(db, 'privilegedRoleSweepJobs', 'job1'), { state: 'COMPLETED' }));
    await assertFails(deleteDoc(doc(db, 'privilegedRoleSweepJobs', 'job1')));
  });
});
