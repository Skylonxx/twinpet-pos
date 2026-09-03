/**
 * SEC-001 Packet C-A — privilegedRevocationState is Functions-only. An admin
 * must never be able to directly bump the global OAC revocation epoch from a
 * client — that is exclusively an Admin SDK / Ops path.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/privileged-revocation-state.spec.ts"
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

describe('privilegedRevocationState is deny-all, even to an admin', () => {
  it('admin cannot read the current epoch doc', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'privilegedRevocationState', 'current'), { revocationEpoch: 3 });
    });
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertFails(getDoc(doc(db, 'privilegedRevocationState', 'current')));
  });

  it('admin cannot create or bump the epoch', async () => {
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertFails(setDoc(doc(db, 'privilegedRevocationState', 'current'), { revocationEpoch: 1 }));
  });

  it('admin cannot update or delete an existing epoch doc', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'privilegedRevocationState', 'current'), { revocationEpoch: 3 });
    });
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertFails(updateDoc(doc(db, 'privilegedRevocationState', 'current'), { revocationEpoch: 4 }));
    await assertFails(deleteDoc(doc(db, 'privilegedRevocationState', 'current')));
  });
});
