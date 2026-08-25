import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const BRANCH = 'LDP-001';
const self = {
  staffId: 'staff1',
  role: 'staff',
  branchIds: [BRANCH],
  permissions: ['pos_sale'],
  authVersion: 0,
};
const other = {
  staffId: 'staff2',
  role: 'staff',
  branchIds: [BRANCH],
  permissions: ['pos_sale'],
  authVersion: 0,
};
const admin = {
  staffId: 'admin1',
  role: 'admin',
  branchIds: ['ALL'],
  permissions: [],
  authVersion: 0,
};

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-twinpet-pkt1-users',
    firestore: {
      rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8'),
      host,
      port: Number(port),
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', 'staff1'), {
      username: 'somchai',
      isActive: true,
      deletedAt: null,
      authVersion: 0,
      pin: 'legacy',
      lastLoginAt: null,
    });
    await setDoc(doc(db, 'users', 'staff2'), {
      username: 'suda',
      isActive: true,
      deletedAt: null,
      authVersion: 0,
    });
    await setDoc(doc(db, 'users', 'admin1'), { isActive: true, deletedAt: null, authVersion: 0 });
    await setDoc(doc(db, 'userCredentials', 'staff1'), { pinHash: 'x', credentialState: 'rotated_authoritative' });
    await setDoc(doc(db, 'usernames', 'somchai'), { userId: 'staff1' });
    await setDoc(doc(db, 'userAccountCommandIntents', 'intent1'), { userId: 'staff1' });
    await setDoc(doc(db, 'managerApprovals', 'ap1'), { status: 'pending' });
    await setDoc(doc(db, 'managerApprovalAttempts', 'scope1'), { n: 1 });
  });
});

describe('users authority lockdown', () => {
  it('allows staff to read profiles', async () => {
    const db = testEnv.authenticatedContext('staff1', self).firestore();
    await assertSucceeds(getDoc(doc(db, 'users', 'staff1')));
    await assertSucceeds(getDoc(doc(db, 'users', 'staff2')));
  });

  it('allows self lastLoginAt only', async () => {
    const db = testEnv.authenticatedContext('staff1', self).firestore();
    await assertSucceeds(updateDoc(doc(db, 'users', 'staff1'), { lastLoginAt: serverTimestamp() }));
  });

  it('denies cross-user lastLoginAt and any other field', async () => {
    const db = testEnv.authenticatedContext('staff1', self).firestore();
    await assertFails(updateDoc(doc(db, 'users', 'staff2'), { lastLoginAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, 'users', 'staff1'), { authVersion: 9 }));
    await assertFails(updateDoc(doc(db, 'users', 'staff1'), { pin: '0000' }));
    await assertFails(updateDoc(doc(db, 'users', 'staff1'), { role: 'admin' }));
    await assertFails(updateDoc(doc(db, 'users', 'staff1'), { isActive: false }));
  });

  it('denies create/delete even for admin clients', async () => {
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertFails(setDoc(doc(db, 'users', 'new'), { username: 'x', isActive: true }));
  });

  it('denies client credential, username, intent, and approval surfaces', async () => {
    const db = testEnv.authenticatedContext('admin1', admin).firestore();
    await assertFails(getDoc(doc(db, 'userCredentials', 'staff1')));
    await assertFails(getDoc(doc(db, 'usernames', 'somchai')));
    await assertFails(getDoc(doc(db, 'userAccountCommandIntents', 'intent1')));
    await assertFails(getDoc(doc(db, 'managerApprovals', 'ap1')));
    await assertFails(getDoc(doc(db, 'managerApprovalAttempts', 'scope1')));
    await assertFails(setDoc(doc(db, 'userCredentials', 'staff1'), { pinHash: 'y' }, { merge: true }));
  });
});
