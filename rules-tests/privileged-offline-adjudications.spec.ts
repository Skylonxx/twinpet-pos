/**
 * SEC-001 Packet D / D-1B — `privilegedOfflineAdjudications/{adjudicationId}`
 * is the server-owned durable replay anchor for offline privileged-action
 * attestations. It is Admin-SDK-only: no client of any role may read a stored
 * verdict, create a replay anchor, mutate one, or delete one. A client that
 * could write here could forge "this offline void already completed", or read
 * another branch's rejection reasons.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/privileged-offline-adjudications.spec.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const BRANCH = 'LDP-001';
const ADJ_ID = 'a1a2a3a4a5a6a7a8a9aaabacadaeaf00';
const COLLECTION = 'privilegedOfflineAdjudications';

const roles = {
  staff: { staffId: 'staff2', role: 'staff', branchIds: [BRANCH], permissions: ['pos_sale', 'pos_void'] },
  manager: { staffId: 'mgr1', role: 'manager', branchIds: [BRANCH], permissions: ['pos_void'] },
  admin: { staffId: 'admin1', role: 'admin', branchIds: ['ALL'], permissions: ['pos_void'] },
};

const storedRecord = {
  schemaVersion: 1,
  state: 'TERMINALLY_REJECTED',
  adjudicationId: ADJ_ID,
  attestationDigest: 'f'.repeat(64),
  paa1SchemaVersion: 1,
  actionId: 'VOID_SETTLED_SALE',
  targetOrderId: 'order-1',
  branchId: BRANCH,
  initiatingStaffId: 'staff-1',
  approvingManagerStaffId: 'manager-1',
  oacId: 'oac-1',
  ssa1Id: 'ssa1-1',
  securityDeviceIdHex: '101112131415161718191a1b1c1d1e1f',
  deviceKeyVersion: 3,
  audience: 'privilegedVoid',
  trustedApprovalLowerMs: 1_763_099_940_000,
  trustedApprovalUpperMs: 1_763_099_940_250,
  serverPendingExpiryMs: 1_763_139_600_000,
  offlineExecutionId: null,
  verdict: 'REJECTED',
  rejectionReason: 'device_not_active',
  manualAttentionReason: null,
  outcomeKind: null,
};

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
    await setDoc(doc(ctx.firestore(), COLLECTION, ADJ_ID), storedRecord);
  });
});

describe('privilegedOfflineAdjudications is Admin-SDK-only (deny-all for clients)', () => {
  for (const [label, claims] of Object.entries(roles)) {
    it(`DENIED: ${label} cannot read a stored adjudication verdict`, async () => {
      const db = testEnv.authenticatedContext(claims.staffId, claims).firestore();
      await assertFails(getDoc(doc(db, COLLECTION, ADJ_ID)));
    });

    it(`DENIED: ${label} cannot create a forged replay anchor`, async () => {
      const db = testEnv.authenticatedContext(claims.staffId, claims).firestore();
      await assertFails(
        setDoc(doc(db, COLLECTION, 'b1b2b3b4b5b6b7b8b9babbbcbdbebf00'), {
          ...storedRecord,
          adjudicationId: 'b1b2b3b4b5b6b7b8b9babbbcbdbebf00',
          state: 'COMPLETED',
          verdict: 'ACCEPTED',
          outcomeKind: 'VOID_APPLIED',
          offlineExecutionId: 'forged-execution-id',
        }),
      );
    });

    it(`DENIED: ${label} cannot mutate an existing adjudication`, async () => {
      const db = testEnv.authenticatedContext(claims.staffId, claims).firestore();
      await assertFails(updateDoc(doc(db, COLLECTION, ADJ_ID), { state: 'COMPLETED' }));
      await assertFails(updateDoc(doc(db, COLLECTION, ADJ_ID), { rejectionReason: 'target_already_voided' }));
      await assertFails(setDoc(doc(db, COLLECTION, ADJ_ID), storedRecord, { merge: true }));
    });

    it(`DENIED: ${label} cannot delete an adjudication anchor`, async () => {
      const db = testEnv.authenticatedContext(claims.staffId, claims).firestore();
      await assertFails(deleteDoc(doc(db, COLLECTION, ADJ_ID)));
    });
  }

  it('DENIED: an unauthenticated client cannot read, write, or delete', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, COLLECTION, ADJ_ID)));
    await assertFails(setDoc(doc(db, COLLECTION, ADJ_ID), storedRecord));
    await assertFails(deleteDoc(doc(db, COLLECTION, ADJ_ID)));
  });

  it('DENIED: a nested path under the collection is also denied (no wildcard escape)', async () => {
    const db = testEnv.authenticatedContext('admin1', roles.admin).firestore();
    await assertFails(getDoc(doc(db, COLLECTION, ADJ_ID, 'attempts', 'a1')));
    await assertFails(setDoc(doc(db, COLLECTION, ADJ_ID, 'attempts', 'a1'), { any: 'thing' }));
  });
});
