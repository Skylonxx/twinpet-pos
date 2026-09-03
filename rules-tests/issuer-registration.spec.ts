/**
 * SEC-001 Packet C-A — issuer trust bootstrap collections are Functions/Ops-only.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/issuer-registration.spec.ts"
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

const collections = ['privilegedIssuerBootstrapTokens', 'privilegedIssuerRegistrations', 'privilegedIssuerRequestReplayRecords'];

describe('SEC-001 Packet C-A issuer registration collections are deny-all to every client', () => {
  for (const collection of collections) {
    describe(collection, () => {
      it('admin cannot read', async () => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), collection, 'd1'), { seeded: true });
        });
        const db = testEnv.authenticatedContext('admin1', admin).firestore();
        await assertFails(getDoc(doc(db, collection, 'd1')));
      });

      it('admin cannot create', async () => {
        const db = testEnv.authenticatedContext('admin1', admin).firestore();
        await assertFails(setDoc(doc(db, collection, 'd1'), { x: 1 }));
      });

      it('admin cannot update', async () => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), collection, 'd1'), { x: 1 });
        });
        const db = testEnv.authenticatedContext('admin1', admin).firestore();
        await assertFails(updateDoc(doc(db, collection, 'd1'), { x: 2 }));
      });

      it('admin cannot delete', async () => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), collection, 'd1'), { x: 1 });
        });
        const db = testEnv.authenticatedContext('admin1', admin).firestore();
        await assertFails(deleteDoc(doc(db, collection, 'd1')));
      });

      it('unauthenticated cannot read', async () => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), collection, 'd1'), { x: 1 });
        });
        const db = testEnv.unauthenticatedContext().firestore();
        await assertFails(getDoc(doc(db, collection, 'd1')));
      });
    });
  }
});
