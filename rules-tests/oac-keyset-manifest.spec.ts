/**
 * SEC-001 Packet C-A — OAC signing-key/keyset collections are Functions/Ops-only.
 * getOacKeysetManifest (Admin SDK) serves the public keyset to clients over the
 * callable — never a direct Firestore read of the private-key-bearing docs.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/oac-keyset-manifest.spec.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const staff = { staffId: 'staff1', role: 'staff', branchIds: ['LDP-001'], permissions: [], authVersion: 0 };

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
  });
});

const collections = ['privilegedOacKeysetMeta', 'privilegedOacSigningKeys'];

describe('SEC-001 Packet C-A OAC keyset collections are deny-all to every client', () => {
  for (const collection of collections) {
    describe(collection, () => {
      it('an authenticated staff member cannot read the private-key-bearing doc directly', async () => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), collection, 'd1'), { privateKeyBase64Url: 'secret' });
        });
        const db = testEnv.authenticatedContext('staff1', staff).firestore();
        await assertFails(getDoc(doc(db, collection, 'd1')));
      });

      it('cannot create, update, or delete', async () => {
        const db = testEnv.authenticatedContext('staff1', staff).firestore();
        await assertFails(setDoc(doc(db, collection, 'd1'), { x: 1 }));
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), collection, 'd1'), { x: 1 });
        });
        await assertFails(updateDoc(doc(db, collection, 'd1'), { x: 2 }));
        await assertFails(deleteDoc(doc(db, collection, 'd1')));
      });
    });
  }
});
