/**
 * SEC-001 Packet C-A — device-enrollment lifecycle collections are Functions-only.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/device-enrollment.spec.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const staff = { staffId: 'staff1', role: 'staff', branchIds: ['LDP-001'], permissions: [], authVersion: 0 };
const manager = { staffId: 'mgr1', role: 'manager', branchIds: ['LDP-001'], permissions: [], authVersion: 0 };
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
    await setDoc(doc(ctx.firestore(), 'users', 'staff1'), { role: 'staff', isActive: true, deletedAt: null, authVersion: 0 });
    await setDoc(doc(ctx.firestore(), 'users', 'mgr1'), { role: 'manager', isActive: true, deletedAt: null, authVersion: 0 });
    await setDoc(doc(ctx.firestore(), 'users', 'admin1'), { role: 'admin', isActive: true, deletedAt: null, authVersion: 0 });
  });
});

const collections = [
  'privilegedDeviceEnrollmentAuthorizations',
  'privilegedDeviceRegistrationSessions',
  'privilegedDeviceRegistrations',
];

describe('SEC-001 Packet C-A device-enrollment collections are deny-all to every client', () => {
  for (const collection of collections) {
    describe(collection, () => {
      it('staff/manager/admin cannot read a seeded doc', async () => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), collection, 'd1'), { x: 1 });
        });
        for (const [uid, token] of [
          ['staff1', staff],
          ['mgr1', manager],
          ['admin1', admin],
        ] as const) {
          const db = testEnv.authenticatedContext(uid, token).firestore();
          await assertFails(getDoc(doc(db, collection, 'd1')));
        }
      });

      it('staff/manager/admin cannot create', async () => {
        for (const [uid, token] of [
          ['staff1', staff],
          ['mgr1', manager],
          ['admin1', admin],
        ] as const) {
          const db = testEnv.authenticatedContext(uid, token).firestore();
          await assertFails(setDoc(doc(db, collection, 'd1'), { x: 1 }));
        }
      });

      it('admin cannot update or delete', async () => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), collection, 'd1'), { x: 1 });
        });
        const db = testEnv.authenticatedContext('admin1', admin).firestore();
        await assertFails(updateDoc(doc(db, collection, 'd1'), { x: 2 }));
        await assertFails(deleteDoc(doc(db, collection, 'd1')));
      });
    });
  }
});
