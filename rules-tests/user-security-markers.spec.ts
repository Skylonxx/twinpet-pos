/**
 * SEC-001 Packet C-A / F7 — `users/{userId}.stagedDenyRoundIdAtEntry` (the
 * entrant self-stamp `setUserAccountCore.ts` writes server-side) is a
 * security marker a client must never be able to forge. The pre-existing
 * `users/{userId}` update rule already narrows client self-updates to
 * exactly `lastLoginAt`; this locks that no F7 addition loosened it.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/user-security-markers.spec.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
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
    await setDoc(doc(ctx.firestore(), 'users', 'staff1'), {
      role: 'staff',
      isActive: true,
      deletedAt: null,
      authVersion: 0,
      stagedDenyRoundIdAtEntry: null,
    });
  });
});

describe('a staff member cannot forge their own stagedDenyRoundIdAtEntry marker', () => {
  it('updating stagedDenyRoundIdAtEntry alone is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff).firestore();
    await assertFails(updateDoc(doc(db, 'users', 'staff1'), { stagedDenyRoundIdAtEntry: 'forged-change-id' }));
  });

  it('updating role to self-promote is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff).firestore();
    await assertFails(updateDoc(doc(db, 'users', 'staff1'), { role: 'admin' }));
  });

  it('bundling stagedDenyRoundIdAtEntry with the allowed lastLoginAt update is still DENIED (hasOnly, not partial)', async () => {
    const db = testEnv.authenticatedContext('staff1', staff).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', 'staff1'), { lastLoginAt: serverTimestamp(), stagedDenyRoundIdAtEntry: 'forged' }),
    );
  });

  it('the pre-existing lastLoginAt-only self-update still SUCCEEDS (control, unaffected by F7)', async () => {
    const db = testEnv.authenticatedContext('staff1', staff).firestore();
    await assertSucceeds(updateDoc(doc(db, 'users', 'staff1'), { lastLoginAt: serverTimestamp() }));
  });
});
