/**
 * Admin & Security Center V1 — securityAuditEvents is Functions-only.
 *
 * Even a fresh admin (password or Quick PIN) cannot read, forge, edit or
 * delete an entry directly; the only client read path is the
 * password-admin-only getAdminSecurityOverview projection.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/security-audit-events.spec.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const admin = { staffId: 'admin1', role: 'admin', branchIds: ['ALL'], permissions: [], authVersion: 0 };
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
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', 'admin1'), { role: 'admin', isActive: true, deletedAt: null, authVersion: 0 });
    await setDoc(doc(db, 'users', 'mgr1'), { role: 'manager', isActive: true, deletedAt: null, authVersion: 0 });
    await setDoc(doc(db, 'securityAuditEvents', 'e1'), {
      schemaVersion: 1,
      type: 'QUICK_PIN_ROTATED',
      actorStaffId: 'admin1',
      targetStaffId: 'mgr1',
    });
  });
});

describe('securityAuditEvents is deny-all to every client', () => {
  for (const [label, claims, uid] of [
    ['a fresh admin', admin, 'admin1'],
    ['a manager', manager, 'mgr1'],
  ] as const) {
    it(`${label} cannot read, list, forge, edit or delete events`, async () => {
      const db = testEnv.authenticatedContext(uid, claims).firestore();
      await assertFails(getDoc(doc(db, 'securityAuditEvents', 'e1')));
      await assertFails(getDocs(collection(db, 'securityAuditEvents')));
      await assertFails(
        setDoc(doc(db, 'securityAuditEvents', 'forged'), {
          schemaVersion: 1,
          type: 'APPROVAL_LOCKOUT_CLEAR_ISSUED',
          actorStaffId: uid,
          targetStaffId: 'mgr1',
        }),
      );
      await assertFails(updateDoc(doc(db, 'securityAuditEvents', 'e1'), { targetStaffId: 'someone-else' }));
      await assertFails(deleteDoc(doc(db, 'securityAuditEvents', 'e1')));
    });
  }

  it('unauthenticated cannot read', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'securityAuditEvents', 'e1')));
  });
});
