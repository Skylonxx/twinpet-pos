import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const BRANCH = 'LDP-001';
const staff = {
  staffId: 'staff1',
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
    projectId: 'demo-twinpet-pkt1-mig',
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
    await setDoc(doc(db, 'users', 'staff1'), { isActive: true, deletedAt: null, authVersion: 0 });
    await setDoc(doc(db, 'users', 'admin1'), { isActive: true, deletedAt: null, authVersion: 0 });
    await setDoc(doc(db, 'migrationControl', 'usernameReservations'), {
      complete: true,
      maintenanceMode: false,
      epoch: 1,
    });
    await setDoc(doc(db, 'migrationControl', 'usernameCensus', 'headers', 'op-1'), {
      status: 'published',
    });
  });
});

describe('migrationControl deny-all-client', () => {
  it('denies staff and admin read/write of usernameReservations', async () => {
    for (const claims of [staff, admin]) {
      const db = testEnv.authenticatedContext('u', claims).firestore();
      await assertFails(getDoc(doc(db, 'migrationControl', 'usernameReservations')));
      await assertFails(
        setDoc(doc(db, 'migrationControl', 'usernameReservations'), { complete: false }, { merge: true }),
      );
    }
  });

  it('denies nested census header and entries', async () => {
    const db = testEnv.authenticatedContext('u', admin).firestore();
    await assertFails(getDoc(doc(db, 'migrationControl', 'usernameCensus', 'headers', 'op-1')));
    await assertFails(
      setDoc(doc(db, 'migrationControl', 'usernameCensus', 'headers', 'op-1', 'entries', 'u1'), {
        userId: 'u1',
      }),
    );
  });
});
