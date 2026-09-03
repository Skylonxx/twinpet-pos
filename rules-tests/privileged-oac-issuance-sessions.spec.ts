/**
 * SEC-001 Packet C-A — privilegedOacIssuanceSessions is Functions-only.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/privileged-oac-issuance-sessions.spec.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const manager = { staffId: 'mgr1', role: 'manager', branchIds: ['LDP-001'], permissions: [], authVersion: 0 };

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
    await setDoc(doc(ctx.firestore(), 'users', 'mgr1'), { role: 'manager', isActive: true, deletedAt: null, authVersion: 0 });
  });
});

describe('privilegedOacIssuanceSessions is deny-all to every client, including the owning manager', () => {
  it('the manager who owns the session cannot read it directly', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'privilegedOacIssuanceSessions', 's1'), { managerStaffId: 'mgr1' });
    });
    const db = testEnv.authenticatedContext('mgr1', manager).firestore();
    await assertFails(getDoc(doc(db, 'privilegedOacIssuanceSessions', 's1')));
  });

  it('a manager cannot create a session for themselves', async () => {
    const db = testEnv.authenticatedContext('mgr1', manager).firestore();
    await assertFails(setDoc(doc(db, 'privilegedOacIssuanceSessions', 's1'), { managerStaffId: 'mgr1' }));
  });

  it('a manager cannot update or delete a session', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'privilegedOacIssuanceSessions', 's1'), { managerStaffId: 'mgr1' });
    });
    const db = testEnv.authenticatedContext('mgr1', manager).firestore();
    await assertFails(updateDoc(doc(db, 'privilegedOacIssuanceSessions', 's1'), { status: 'CONSUMED' }));
    await assertFails(deleteDoc(doc(db, 'privilegedOacIssuanceSessions', 's1')));
  });

  it('unauthenticated cannot read', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'privilegedOacIssuanceSessions', 's1'), { managerStaffId: 'mgr1' });
    });
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'privilegedOacIssuanceSessions', 's1')));
  });
});
