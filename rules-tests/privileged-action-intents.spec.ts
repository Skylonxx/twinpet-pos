/**
 * SEC-001 Packet B — privilegedActionIntents create-only assertion + nonce deny.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/privileged-action-intents.spec.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const BRANCH = 'LDP-001';
const OTHER = 'BKK-002';

const voidStaff = {
  staffId: 'staff1',
  role: 'staff',
  branchIds: [BRANCH],
  permissions: ['pos_void'],
  authVersion: 0,
};

const saleOnly = {
  staffId: 'staff1',
  role: 'staff',
  branchIds: [BRANCH],
  permissions: ['pos_sale'],
  authVersion: 0,
};

const validIntent = (over: Record<string, unknown> = {}) => ({
  actionId: 'VOID_PENDING_SALE',
  branchId: BRANCH,
  initiatingStaffId: 'staff1',
  approvingManagerId: 'manager1',
  targetOrderId: 'a1',
  commandId: 'cmd-1',
  ...over,
});

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-twinpet',
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
    await setDoc(doc(ctx.firestore(), 'users', 'staff1'), {
      isActive: true,
      deletedAt: null,
      authVersion: 0,
    });
  });
});

describe('privilegedActionIntents create gates', () => {
  it('staff without pos_void cannot create intent', async () => {
    const db = testEnv.authenticatedContext('staff1', saleOnly).firestore();
    await assertFails(setDoc(doc(db, 'privilegedActionIntents', 'i1'), validIntent()));
  });

  it('staff with stale authVersion cannot create intent', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', 'staff1'), {
        isActive: true,
        deletedAt: null,
        authVersion: 2,
      });
    });
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(setDoc(doc(db, 'privilegedActionIntents', 'i1'), validIntent()));
  });

  it('disabled staff cannot create intent', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', 'staff1'), {
        isActive: false,
        deletedAt: null,
        authVersion: 0,
      });
    });
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(setDoc(doc(db, 'privilegedActionIntents', 'i1'), validIntent()));
  });

  it('deleted staff cannot create intent', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', 'staff1'), {
        isActive: true,
        deletedAt: new Date(),
        authVersion: 0,
      });
    });
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(setDoc(doc(db, 'privilegedActionIntents', 'i1'), validIntent()));
  });

  it('fresh pos_void staff can create a valid intent', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertSucceeds(setDoc(doc(db, 'privilegedActionIntents', 'i1'), validIntent()));
  });

  it('another initiatingStaffId is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(setDoc(doc(db, 'privilegedActionIntents', 'i1'), validIntent({ initiatingStaffId: 'staff9' })));
  });

  it('self-approval shape is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(setDoc(doc(db, 'privilegedActionIntents', 'i1'), validIntent({ approvingManagerId: 'staff1' })));
  });

  it('server verdict fields cannot be seeded', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(
      setDoc(doc(db, 'privilegedActionIntents', 'i1'), validIntent({ serverVerdict: 'ACCEPTED' })),
    );
    await assertFails(
      setDoc(doc(db, 'privilegedActionIntents', 'i1'), validIntent({ processedAt: new Date() })),
    );
    await assertFails(
      setDoc(doc(db, 'privilegedActionIntents', 'i1'), validIntent({ managerApproved: true })),
    );
  });

  it('cross-branch intent is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(setDoc(doc(db, 'privilegedActionIntents', 'i1'), validIntent({ branchId: OTHER })));
  });

  it('branch ALL is DENIED', async () => {
    const otherToken = { ...voidStaff, branchIds: ['ALL'] };
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', 'staff1'), {
        isActive: true,
        deletedAt: null,
        authVersion: 0,
      });
    });
    const db = testEnv.authenticatedContext('staff1', otherToken).firestore();
    await assertFails(setDoc(doc(db, 'privilegedActionIntents', 'i1'), validIntent({ branchId: 'ALL' })));
  });

  it('unknown action is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(setDoc(doc(db, 'privilegedActionIntents', 'i1'), validIntent({ actionId: 'RETURN' })));
  });
});

describe('privilegedActionIntents immutability', () => {
  it('intent update is DENIED', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'privilegedActionIntents', 'i1'), validIntent());
    });
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(updateDoc(doc(db, 'privilegedActionIntents', 'i1'), { voidReason: 'x' }));
  });

  it('intent delete is DENIED', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'privilegedActionIntents', 'i1'), validIntent());
    });
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(deleteDoc(doc(db, 'privilegedActionIntents', 'i1')));
  });
});

describe('SEC-001 Packet C-A / F7 regression lock', () => {
  // The privilegedActionIntents create gate is a CLIENT ASSERTION, deliberately
  // keyed on the token's `permissions` claim (hasFreshPerm), not on the live
  // settings/_rolePermissions matrix or the F7 staged-deny head — those are
  // consulted server-side only (privilegedActionAuthority.ts's
  // stagedDenyReader, inside submitPrivilegedVoid/requestManagerApproval).
  // This proves that invariant still holds: a token that still carries
  // pos_void may create the assertion even though, server-side, an active
  // staged-deny round for their role would ultimately reject it.
  it('a token still carrying pos_void may create the client assertion (server enforces the real staged-deny gate)', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'privilegedStagedRoleDeny', 'staff'), {
        state: 'DRAINING',
        changeId: 'change-1',
        deniedPermissions: ['pos_void'],
      });
    });
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertSucceeds(setDoc(doc(db, 'privilegedActionIntents', 'i1'), validIntent()));
  });
});

describe('privilegedActionNonces are server-only', () => {
  it('client nonce read is DENIED', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'privilegedActionNonces', 'n1'), { branchId: BRANCH });
    });
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(getDoc(doc(db, 'privilegedActionNonces', 'n1')));
  });

  it('client nonce write is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(setDoc(doc(db, 'privilegedActionNonces', 'n1'), { branchId: BRANCH }));
  });
});
