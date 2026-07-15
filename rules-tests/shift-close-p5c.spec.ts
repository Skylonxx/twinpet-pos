/**
 * Packet 5 / P5-C-2 — Firestore rules hardening (rules-only, no runtime).
 *
 * Two independent surfaces proved here:
 *
 * 1. Packet 5 server-owned collections (shiftCloseEvidence, shiftCloseCases,
 *    shiftCloseAuditEvents, shiftCloseAlerts, shiftCloseValidationRuns) — no
 *    client create/update/delete on any of the five (Admin-SDK-only, per the
 *    frozen P5-C plan); read is manager/admin, branch-scoped only.
 * 2. `shifts` D4 W0–W4 lifecycle hardening — exact-19-field open create, the
 *    missing-as-empty first cash append + actor-bound/bounded entries, the
 *    accepted W2 credit-debt residual, the exact-16-field one-way close (with
 *    the frozen `totalBills` bound), and the sole post-close Variant C
 *    `syncState` normalization. Every other update shape is denied.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  serverTimestamp,
  arrayUnion,
  deleteField,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const BRANCH = 'LDP-001';
const OTHER_BRANCH = 'BKK-002';

const staff = (staffId = 'staff1', branchId = BRANCH) => ({
  staffId,
  role: 'staff',
  branchIds: [branchId],
  permissions: [],
});
const manager = (branchId = BRANCH) => ({ staffId: 'm1', role: 'manager', branchIds: [branchId], permissions: [] });
const admin = (branchId = BRANCH) => ({ staffId: 'a1', role: 'admin', branchIds: [branchId], permissions: [] });

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
});

// ─────────────────────────────────────────────────────────────────────────
// Packet 5 server-owned collections
// ─────────────────────────────────────────────────────────────────────────

const PACKET5_COLLECTIONS = [
  'shiftCloseEvidence',
  'shiftCloseCases',
  'shiftCloseAuditEvents',
  'shiftCloseAlerts',
  'shiftCloseValidationRuns',
] as const;

for (const collectionName of PACKET5_COLLECTIONS) {
  describe(`Packet 5 server-owned collection: ${collectionName}`, () => {
    const seedDoc = async (id: string, branchId = BRANCH) => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), collectionName, id), {
          shiftId: id,
          branchId,
          schemaVersion: 1,
        });
      });
    };

    it('DENIED: unauthenticated client write (create)', async () => {
      const db = testEnv.unauthenticatedContext().firestore();
      await assertFails(setDoc(doc(db, collectionName, 'x1'), { shiftId: 'x1', branchId: BRANCH }));
    });

    it('DENIED: unauthenticated client read', async () => {
      await seedDoc('x2');
      const db = testEnv.unauthenticatedContext().firestore();
      await assertFails(getDoc(doc(db, collectionName, 'x2')));
    });

    it('DENIED: cashier/staff client create', async () => {
      const db = testEnv.authenticatedContext('staff1', staff()).firestore();
      await assertFails(setDoc(doc(db, collectionName, 'x3'), { shiftId: 'x3', branchId: BRANCH }));
    });

    it('DENIED: cashier/staff client read (no read grant for staff role)', async () => {
      await seedDoc('x4');
      const db = testEnv.authenticatedContext('staff1', staff()).firestore();
      await assertFails(getDoc(doc(db, collectionName, 'x4')));
    });

    it('DENIED: manager client create', async () => {
      const db = testEnv.authenticatedContext('m1', manager()).firestore();
      await assertFails(setDoc(doc(db, collectionName, 'x5'), { shiftId: 'x5', branchId: BRANCH }));
    });

    it('DENIED: admin client create (Admin-SDK-only — no client role, incl. admin, may write)', async () => {
      const db = testEnv.authenticatedContext('a1', admin()).firestore();
      await assertFails(setDoc(doc(db, collectionName, 'x6'), { shiftId: 'x6', branchId: BRANCH }));
    });

    it('DENIED: manager client update on an existing doc', async () => {
      await seedDoc('x7');
      const db = testEnv.authenticatedContext('m1', manager()).firestore();
      await assertFails(updateDoc(doc(db, collectionName, 'x7'), { schemaVersion: 2 }));
    });

    it('DENIED: admin client update on an existing doc', async () => {
      await seedDoc('x8');
      const db = testEnv.authenticatedContext('a1', admin()).firestore();
      await assertFails(updateDoc(doc(db, collectionName, 'x8'), { schemaVersion: 2 }));
    });

    it('DENIED: manager client delete', async () => {
      await seedDoc('x9');
      const db = testEnv.authenticatedContext('m1', manager()).firestore();
      await assertFails(deleteDoc(doc(db, collectionName, 'x9')));
    });

    it('DENIED: admin client delete', async () => {
      await seedDoc('x10');
      const db = testEnv.authenticatedContext('a1', admin()).firestore();
      await assertFails(deleteDoc(doc(db, collectionName, 'x10')));
    });

    it('ALLOWED (read only): manager with branch access reads the same-branch doc', async () => {
      await seedDoc('x11', BRANCH);
      const db = testEnv.authenticatedContext('m1', manager(BRANCH)).firestore();
      await assertSucceeds(getDoc(doc(db, collectionName, 'x11')));
    });

    it('ALLOWED (read only): admin with branch access reads the same-branch doc', async () => {
      await seedDoc('x12', BRANCH);
      const db = testEnv.authenticatedContext('a1', admin(BRANCH)).firestore();
      await assertSucceeds(getDoc(doc(db, collectionName, 'x12')));
    });

    it('DENIED: manager cross-branch read', async () => {
      await seedDoc('x13', OTHER_BRANCH);
      const db = testEnv.authenticatedContext('m1', manager(BRANCH)).firestore();
      await assertFails(getDoc(doc(db, collectionName, 'x13')));
    });

    it('DENIED: admin cross-branch read', async () => {
      await seedDoc('x14', OTHER_BRANCH);
      const db = testEnv.authenticatedContext('a1', admin(BRANCH)).firestore();
      await assertFails(getDoc(doc(db, collectionName, 'x14')));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// shifts D4 — W0–W4 lifecycle hardening
// ─────────────────────────────────────────────────────────────────────────

const w0Payload = (shiftId: string, overrides: Record<string, unknown> = {}) => ({
  id: shiftId,
  branchId: BRANCH,
  staffId: 'staff1',
  staffName: 'Cashier One',
  status: 'open',
  openedAt: serverTimestamp(),
  closedAt: null,
  startingCash: 1000,
  actualCashCount: 0,
  expectedCash: 0,
  expectedQr: 0,
  expectedKbank: 0,
  expectedCard: 0,
  expectedCredit: 0,
  totalBills: 0,
  payInTotal: 0,
  payOutTotal: 0,
  variance: 0,
  note: '',
  ...overrides,
});

async function seedOpenShift(shiftId: string, overrides: Record<string, unknown> = {}) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'shifts', shiftId), {
      id: shiftId,
      branchId: BRANCH,
      staffId: 'staff1',
      staffName: 'Cashier One',
      status: 'open',
      openedAt: new Date(),
      closedAt: null,
      startingCash: 1000,
      actualCashCount: 0,
      expectedCash: 0,
      expectedQr: 0,
      expectedKbank: 0,
      expectedCard: 0,
      expectedCredit: 0,
      totalBills: 0,
      payInTotal: 0,
      payOutTotal: 0,
      variance: 0,
      note: '',
      ...overrides,
    });
  });
}

async function seedClosedShift(shiftId: string, overrides: Record<string, unknown> = {}) {
  await seedOpenShift(shiftId, {
    status: 'closed',
    closedAt: new Date(),
    actualCashCount: 1000,
    variance: 0,
    note: 'eod',
    totalBills: 10,
    closedOffline: true,
    syncState: 'pending',
    deviceId: 'device-1',
    ...overrides,
  });
}

const cashEntry = (overrides: Record<string, unknown> = {}) => ({
  id: 'ce1',
  type: 'pay_in',
  amount: 100,
  note: 'test entry',
  staffId: 'staff1',
  staffName: 'Cashier One',
  at: Date.now(),
  ...overrides,
});

const closePayload = (overrides: Record<string, unknown> = {}) => ({
  status: 'closed',
  closedAt: serverTimestamp(),
  actualCashCount: 1000,
  variance: 0,
  note: 'eod',
  expectedCash: 1000,
  expectedQr: 0,
  expectedKbank: 0,
  expectedCard: 0,
  expectedCredit: 0,
  totalBills: 10,
  payInTotal: 0,
  payOutTotal: 0,
  closedOffline: true,
  syncState: 'pending',
  deviceId: 'device-1',
  ...overrides,
});

describe('shifts W0 — exact openShift() create', () => {
  it('ALLOWED: exact 19-field create with staffId bound to the caller', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(setDoc(doc(db, 'shifts', 's1'), w0Payload('s1')));
  });

  it('DENIED: staff binding — payload staffId is not the caller token staffId', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(setDoc(doc(db, 'shifts', 's2'), w0Payload('s2', { staffId: 'someoneElse' })));
  });

  it('DENIED: branch access — caller has no access to the payload branch', async () => {
    const db = testEnv.authenticatedContext('staff1', staff('staff1', OTHER_BRANCH)).firestore();
    await assertFails(setDoc(doc(db, 'shifts', 's3'), w0Payload('s3')));
  });

  it('DENIED: extra field injected on create', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(setDoc(doc(db, 'shifts', 's4'), w0Payload('s4', { deviceId: 'd1' })));
  });

  it('DENIED: required field missing on create', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const { note: _note, ...missingNote } = w0Payload('s5');
    await assertFails(setDoc(doc(db, 'shifts', 's5'), missingNote));
  });

  it('DENIED: doc id does not match payload id', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(setDoc(doc(db, 'shifts', 's6'), w0Payload('wrong-id')));
  });

  it('DENIED: non-zero initial accrual field on create', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(setDoc(doc(db, 'shifts', 's7'), w0Payload('s7', { expectedCash: 100 })));
  });

  // Finite-money envelope on startingCash (frozen aggregate bound). A one-sided
  // `is number && >= 0` admitted NaN/+Infinity; the two-sided helper rejects them.
  it('DENIED: startingCash = +Infinity (non-finite)', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(setDoc(doc(db, 'shifts', 's8'), w0Payload('s8', { startingCash: Infinity })));
  });

  it('DENIED: startingCash = NaN (non-finite)', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(setDoc(doc(db, 'shifts', 's9'), w0Payload('s9', { startingCash: NaN })));
  });

  it('DENIED: startingCash negative', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(setDoc(doc(db, 'shifts', 's10'), w0Payload('s10', { startingCash: -1 })));
  });

  it('DENIED: startingCash over the aggregate envelope (> ฿10,000,000,000)', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(setDoc(doc(db, 'shifts', 's11'), w0Payload('s11', { startingCash: 10000000001 })));
  });

  it('ALLOWED: startingCash at the aggregate envelope edge (= ฿10,000,000,000)', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(setDoc(doc(db, 'shifts', 's12'), w0Payload('s12', { startingCash: 10000000000 })));
  });
});

describe('shifts W1 — open-shift cash append', () => {
  it('ALLOWED: first append with NO prior cashEntries field (missing-as-empty)', async () => {
    await seedOpenShift('s1'); // no cashEntries field at all — matches the real openShift() writer
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'shifts', 's1'), { cashEntries: [cashEntry()], updatedAt: serverTimestamp() }),
    );
  });

  it('ALLOWED: exact-one-entry append onto an existing entry', async () => {
    await seedOpenShift('s2', { cashEntries: [cashEntry({ id: 'ce0' })] });
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'shifts', 's2'), {
        cashEntries: [cashEntry({ id: 'ce0' }), cashEntry({ id: 'ce1' })],
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DENIED: append size delta != 1 (two entries added at once)', async () => {
    await seedOpenShift('s3');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      updateDoc(doc(db, 'shifts', 's3'), {
        cashEntries: [cashEntry({ id: 'a' }), cashEntry({ id: 'b' })],
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DENIED: extra field injected on the new cash entry', async () => {
    await seedOpenShift('s4');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      updateDoc(doc(db, 'shifts', 's4'), {
        cashEntries: [cashEntry({ extra: 'nope' })],
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DENIED: wrong actor — entry staffId is not the caller token staffId', async () => {
    await seedOpenShift('s5');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      updateDoc(doc(db, 'shifts', 's5'), {
        cashEntries: [cashEntry({ staffId: 'someoneElse' })],
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DENIED: non-positive amount', async () => {
    await seedOpenShift('s6');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      updateDoc(doc(db, 'shifts', 's6'), {
        cashEntries: [cashEntry({ amount: 0 })],
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DENIED: amount over the frozen per-entry bound (> ฿10,000,000)', async () => {
    await seedOpenShift('s7');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      updateDoc(doc(db, 'shifts', 's7'), {
        cashEntries: [cashEntry({ amount: 10000000.01 })],
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DENIED: append onto an already-closed shift', async () => {
    await seedClosedShift('s8');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      updateDoc(doc(db, 'shifts', 's8'), { cashEntries: [cashEntry()], updatedAt: serverTimestamp() }),
    );
  });

  // Current-writer shape: recordCashTransaction() appends via arrayUnion(entry),
  // not a whole-array rewrite. Prove the rule accepts the real transform.
  it('ALLOWED: first append using the real arrayUnion(entry) writer shape', async () => {
    await seedOpenShift('au1'); // no prior cashEntries field
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'shifts', 'au1'), {
        cashEntries: arrayUnion(cashEntry()),
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('ALLOWED: decimal amount 10.50 (valid positive, within bound)', async () => {
    await seedOpenShift('w1a');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'shifts', 'w1a'), {
        cashEntries: [cashEntry({ amount: 10.5 })],
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DENIED: entry amount = NaN (non-finite)', async () => {
    await seedOpenShift('w1b');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      updateDoc(doc(db, 'shifts', 'w1b'), {
        cashEntries: [cashEntry({ amount: NaN })],
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DENIED: entry amount = +Infinity (non-finite)', async () => {
    await seedOpenShift('w1c');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      updateDoc(doc(db, 'shifts', 'w1c'), {
        cashEntries: [cashEntry({ amount: Infinity })],
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DENIED: entry amount wrong type (string)', async () => {
    await seedOpenShift('w1d');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      updateDoc(doc(db, 'shifts', 'w1d'), {
        cashEntries: [cashEntry({ amount: '100' })],
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DENIED: entry note empty', async () => {
    await seedOpenShift('w1e');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      updateDoc(doc(db, 'shifts', 'w1e'), {
        cashEntries: [cashEntry({ note: '' })],
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DENIED: entry id empty', async () => {
    await seedOpenShift('w1f');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      updateDoc(doc(db, 'shifts', 'w1f'), {
        cashEntries: [cashEntry({ id: '' })],
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DENIED: entry `at` invalid (0 — must be a positive int)', async () => {
    await seedOpenShift('w1g');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      updateDoc(doc(db, 'shifts', 'w1g'), {
        cashEntries: [cashEntry({ at: 0 })],
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DENIED: entry missing a required key (staffName omitted)', async () => {
    await seedOpenShift('w1h');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const { staffName: _staffName, ...noStaffName } = cashEntry();
    await assertFails(
      updateDoc(doc(db, 'shifts', 'w1h'), {
        cashEntries: [noStaffName],
        updatedAt: serverTimestamp(),
      }),
    );
  });

  it('DENIED: append with updatedAt omitted (W1 requires updatedAt == request.time)', async () => {
    await seedOpenShift('w1i');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w1i'), { cashEntries: [cashEntry()] }));
  });

  it('DENIED: append with a wrong updatedAt (client Date, not request.time)', async () => {
    await seedOpenShift('w1j');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      updateDoc(doc(db, 'shifts', 'w1j'), {
        cashEntries: [cashEntry()],
        updatedAt: new Date(0),
      }),
    );
  });

  // Frozen DETECT-ONLY residual (P5-A Blocker 5): the rule validates only the
  // size delta (+1) and the NEW last element; it cannot compare every prior
  // element, so a same-size-plus-one write that ALSO rewrites an earlier element
  // is ALLOWED here and is caught only by the future P5-C evidence/cash-pair
  // audit — never by these rules. This test documents that accepted gap.
  it('ALLOWED (accepted prefix-rewrite residual): rewrites an earlier entry while appending', async () => {
    await seedOpenShift('w1k', {
      cashEntries: [cashEntry({ id: 'ceA', amount: 100 }), cashEntry({ id: 'ceB', amount: 200 })],
    });
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'shifts', 'w1k'), {
        cashEntries: [
          cashEntry({ id: 'ceA', amount: 999999 }), // tampered earlier element — undetectable at rules layer
          cashEntry({ id: 'ceB', amount: 200 }),
          cashEntry({ id: 'ceC', amount: 300 }),
        ],
        updatedAt: serverTimestamp(),
      }),
    );
  });
});

describe('shifts W2 — open-shift credit-debt receipt (accepted residual)', () => {
  it('ALLOWED: single-field expectedCash increment', async () => {
    await seedOpenShift('s1');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(updateDoc(doc(db, 'shifts', 's1'), { expectedCash: 500 }));
  });

  it('ALLOWED: single-field expectedKbank increment', async () => {
    await seedOpenShift('s2');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(updateDoc(doc(db, 'shifts', 's2'), { expectedKbank: 300 }));
  });

  it('DENIED: decreasing the field (rule only allows non-decreasing)', async () => {
    await seedOpenShift('s3', { expectedCash: 500 });
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 's3'), { expectedCash: 100 }));
  });

  it('DENIED: two-field update (only one of expectedCash/expectedKbank may change)', async () => {
    await seedOpenShift('s4');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 's4'), { expectedCash: 500, expectedKbank: 500 }));
  });

  it('DENIED: on an already-closed shift', async () => {
    await seedClosedShift('s5');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 's5'), { expectedCash: 500 }));
  });

  // Finite-money envelope on the requested value (in addition to `>= stored`).
  it('DENIED: expectedCash = +Infinity (non-finite)', async () => {
    await seedOpenShift('w2a');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w2a'), { expectedCash: Infinity }));
  });

  it('DENIED: expectedCash = NaN (non-finite)', async () => {
    await seedOpenShift('w2b');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w2b'), { expectedCash: NaN }));
  });

  it('DENIED: expectedCash over the aggregate envelope', async () => {
    await seedOpenShift('w2c');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w2c'), { expectedCash: 10000000001 }));
  });

  it('DENIED: expectedKbank = +Infinity (non-finite)', async () => {
    await seedOpenShift('w2d');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w2d'), { expectedKbank: Infinity }));
  });

  it('DENIED: expectedKbank = NaN (non-finite)', async () => {
    await seedOpenShift('w2e');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w2e'), { expectedKbank: NaN }));
  });

  // Accepted, detect-only forgery residual (frozen P5-A R2 §11.3): an arbitrary
  // LARGER finite in-envelope increment with no binding to a real creditPayments
  // doc is still allowed by the rule — flagged by the Packet 5 credit-debt audit
  // dimension, not prevented here. This test documents that accepted gap.
  it('ALLOWED (accepted finite-forgery residual): arbitrary larger finite in-envelope increment', async () => {
    await seedOpenShift('w2f', { expectedCash: 500 });
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(updateDoc(doc(db, 'shifts', 'w2f'), { expectedCash: 9999999 }));
  });
});

describe('shifts W3 — exact one-way open→closed transition', () => {
  it('ALLOWED: exact 16-field close from open', async () => {
    await seedOpenShift('s1');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(updateDoc(doc(db, 'shifts', 's1'), closePayload()));
  });

  it('DENIED: closedAtLocal injected alongside a valid close', async () => {
    await seedOpenShift('s2');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 's2'), closePayload({ closedAtLocal: Date.now() })));
  });

  it('DENIED: any other extra field injected alongside a valid close', async () => {
    await seedOpenShift('s3');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 's3'), closePayload({ extraField: 'x' })));
  });

  it('DENIED: required close field (deviceId) missing', async () => {
    await seedOpenShift('s4');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const { deviceId: _deviceId, ...noDeviceId } = closePayload();
    await assertFails(updateDoc(doc(db, 'shifts', 's4'), noDeviceId));
  });

  it('DENIED: required close field (syncState) missing', async () => {
    await seedOpenShift('s5');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const { syncState: _syncState, ...noSyncState } = closePayload();
    await assertFails(updateDoc(doc(db, 'shifts', 's5'), noSyncState));
  });

  it('DENIED: required close field (closedOffline) missing', async () => {
    await seedOpenShift('s6');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const { closedOffline: _closedOffline, ...noClosedOffline } = closePayload();
    await assertFails(updateDoc(doc(db, 'shifts', 's6'), noClosedOffline));
  });

  it('DENIED: identity mutation attempted during close (branchId)', async () => {
    await seedOpenShift('s7');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 's7'), closePayload({ branchId: OTHER_BRANCH })));
  });

  it('DENIED: identity mutation attempted during close (staffId)', async () => {
    await seedOpenShift('s8');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 's8'), closePayload({ staffId: 'someoneElse' })));
  });

  it('DENIED: closed → open forbidden (not a valid close transition)', async () => {
    await seedClosedShift('s9');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 's9'), { status: 'open' }));
  });

  describe('totalBills bound (0 .. 100000)', () => {
    it('ALLOWED: totalBills = 0', async () => {
      await seedOpenShift('tb1');
      const db = testEnv.authenticatedContext('staff1', staff()).firestore();
      await assertSucceeds(updateDoc(doc(db, 'shifts', 'tb1'), closePayload({ totalBills: 0 })));
    });

    it('ALLOWED: totalBills = 1', async () => {
      await seedOpenShift('tb2');
      const db = testEnv.authenticatedContext('staff1', staff()).firestore();
      await assertSucceeds(updateDoc(doc(db, 'shifts', 'tb2'), closePayload({ totalBills: 1 })));
    });

    it('ALLOWED: totalBills = 250 (normal)', async () => {
      await seedOpenShift('tb3');
      const db = testEnv.authenticatedContext('staff1', staff()).firestore();
      await assertSucceeds(updateDoc(doc(db, 'shifts', 'tb3'), closePayload({ totalBills: 250 })));
    });

    it('ALLOWED: totalBills = 100000 (bound edge)', async () => {
      await seedOpenShift('tb4');
      const db = testEnv.authenticatedContext('staff1', staff()).firestore();
      await assertSucceeds(updateDoc(doc(db, 'shifts', 'tb4'), closePayload({ totalBills: 100000 })));
    });

    it('DENIED: totalBills = 100001 (over bound)', async () => {
      await seedOpenShift('tb5');
      const db = testEnv.authenticatedContext('staff1', staff()).firestore();
      await assertFails(updateDoc(doc(db, 'shifts', 'tb5'), closePayload({ totalBills: 100001 })));
    });

    it('DENIED: totalBills = -1 (negative)', async () => {
      await seedOpenShift('tb6');
      const db = testEnv.authenticatedContext('staff1', staff()).firestore();
      await assertFails(updateDoc(doc(db, 'shifts', 'tb6'), closePayload({ totalBills: -1 })));
    });

    it('DENIED: totalBills = 3.5 (fractional — fails `is int`)', async () => {
      await seedOpenShift('tb7');
      const db = testEnv.authenticatedContext('staff1', staff()).firestore();
      await assertFails(updateDoc(doc(db, 'shifts', 'tb7'), closePayload({ totalBills: 3.5 })));
    });
  });

  // ── Finite-money envelope on close totals (representative fields) ──
  it('DENIED: close actualCashCount = +Infinity', async () => {
    await seedOpenShift('w3a');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3a'), closePayload({ actualCashCount: Infinity })));
  });

  it('DENIED: close actualCashCount = NaN', async () => {
    await seedOpenShift('w3b');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3b'), closePayload({ actualCashCount: NaN })));
  });

  it('DENIED: close expectedCash = +Infinity', async () => {
    await seedOpenShift('w3c');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3c'), closePayload({ expectedCash: Infinity })));
  });

  it('DENIED: close expectedCash = NaN', async () => {
    await seedOpenShift('w3d');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3d'), closePayload({ expectedCash: NaN })));
  });

  it('DENIED: close expectedKbank = +Infinity', async () => {
    await seedOpenShift('w3e');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3e'), closePayload({ expectedKbank: Infinity })));
  });

  it('DENIED: close payInTotal = +Infinity', async () => {
    await seedOpenShift('w3f');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3f'), closePayload({ payInTotal: Infinity })));
  });

  it('DENIED: close variance = NaN (signed helper also rejects NaN)', async () => {
    await seedOpenShift('w3g');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3g'), closePayload({ variance: NaN })));
  });

  it('DENIED: close startingCash unchanged but non-finite from a malformed open doc', async () => {
    // Malformed legacy/out-of-band open doc carries a non-finite startingCash;
    // the close keeps it (immutability satisfied) but the W3 final-state finite
    // check must still deny, closing the P5-C-1 structural-refusal blind spot.
    await seedOpenShift('w3h', { startingCash: Infinity });
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    // `startingCash` is NOT in the close payload → stays Infinity in the final doc.
    await assertFails(updateDoc(doc(db, 'shifts', 'w3h'), closePayload()));
  });

  // ── Signed variance envelope ──
  it('ALLOWED: close variance = +500 (finite, in-envelope)', async () => {
    await seedOpenShift('w3i');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(updateDoc(doc(db, 'shifts', 'w3i'), closePayload({ variance: 500 })));
  });

  it('ALLOWED: close variance = -500 (finite negative, in-envelope)', async () => {
    await seedOpenShift('w3j');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(updateDoc(doc(db, 'shifts', 'w3j'), closePayload({ variance: -500 })));
  });

  it('DENIED: close variance over the positive envelope', async () => {
    await seedOpenShift('w3k');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3k'), closePayload({ variance: 10000000001 })));
  });

  it('DENIED: close variance under the negative envelope', async () => {
    await seedOpenShift('w3l');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3l'), closePayload({ variance: -10000000001 })));
  });

  // ── Exact close-metadata value/type errors ──
  it('DENIED: closedAt not bound to request.time (client Date)', async () => {
    await seedOpenShift('w3m');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3m'), closePayload({ closedAt: new Date(0) })));
  });

  it('DENIED: closedOffline wrong value (false)', async () => {
    await seedOpenShift('w3n');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3n'), closePayload({ closedOffline: false })));
  });

  it('DENIED: syncState wrong value (synced instead of pending)', async () => {
    await seedOpenShift('w3o');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3o'), closePayload({ syncState: 'synced' })));
  });

  it('DENIED: deviceId wrong type (number)', async () => {
    await seedOpenShift('w3p');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3p'), closePayload({ deviceId: 123 })));
  });

  // ── Identity / open-time immutability ──
  it('DENIED: startingCash mutation during close', async () => {
    await seedOpenShift('w3q');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3q'), closePayload({ startingCash: 2000 })));
  });

  it('DENIED: openedAt mutation during close', async () => {
    await seedOpenShift('w3r');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3r'), closePayload({ openedAt: new Date(0) })));
  });

  // ── Final-schema presence: deleting a pre-existing required field is denied ──
  it('DENIED: close deletes a pre-existing required field (actualCashCount)', async () => {
    await seedOpenShift('w3s');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3s'), closePayload({ actualCashCount: deleteField() })));
  });

  it('DENIED: close deletes a pre-existing required field (expectedCash)', async () => {
    await seedOpenShift('w3t');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w3t'), closePayload({ expectedCash: deleteField() })));
  });

  // ── Update-mask residual (frozen, unavoidable): omitting a pre-existing,
  // already-valid close total from the update is ALLOWED because the final
  // stored value remains present and valid. Rules see only the final document,
  // never the update write mask. This documents the accepted residual. ──
  it('ALLOWED (update-mask residual): omits a pre-existing expectedCash from the close update', async () => {
    await seedOpenShift('w3u', { expectedCash: 500 }); // already accrued via W2
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const { expectedCash: _omitted, ...closeWithoutExpectedCash } = closePayload();
    await assertSucceeds(updateDoc(doc(db, 'shifts', 'w3u'), closeWithoutExpectedCash));
  });
});

describe('shifts W4 — Variant C sole post-close mutation', () => {
  it('ALLOWED: exact single-field syncState pending → synced', async () => {
    await seedClosedShift('s1');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(updateDoc(doc(db, 'shifts', 's1'), { syncState: 'synced' }));
  });

  it('DENIED: any extra field alongside the syncState normalization', async () => {
    await seedClosedShift('s2');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 's2'), { syncState: 'synced', note: 'x' }));
  });

  it('DENIED: wrong transition — already synced, attempting synced → pending', async () => {
    await seedClosedShift('s3', { syncState: 'synced' });
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 's3'), { syncState: 'pending' }));
  });

  it('DENIED: wrong transition — syncState write attempted while shift still open', async () => {
    await seedOpenShift('s4');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 's4'), { syncState: 'pending' }));
  });
});

describe('shifts regression — branch scope, field injection, no broad post-close update', () => {
  it('DENIED: cross-branch update attempt (caller lacks branch access)', async () => {
    await seedOpenShift('r1');
    const db = testEnv.authenticatedContext('staff1', staff('staff1', OTHER_BRANCH)).firestore();
    await assertFails(
      updateDoc(doc(db, 'shifts', 'r1'), { cashEntries: [cashEntry()], updatedAt: serverTimestamp() }),
    );
  });

  it('DENIED: no broad post-close update outside the exact W4 transition', async () => {
    await seedClosedShift('r2');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'r2'), { note: 'changed after close' }));
  });

  it('DENIED: no shifts.expected* mutation path outside the exact W2 residual / W3 close set', async () => {
    await seedClosedShift('r3');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'r3'), { expectedCash: 99999 }));
  });

  it('DENIED: field-injection attempt combining a valid W1 append shape with a foreign field', async () => {
    await seedOpenShift('r4');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      updateDoc(doc(db, 'shifts', 'r4'), {
        cashEntries: [cashEntry()],
        updatedAt: serverTimestamp(),
        status: 'closed',
      }),
    );
  });
});
