/**
 * Return/Refund V1 final gate §2 — the ONLINE shift close is a client
 * `runTransaction` (read shift → fold cash → W3 close write). Proves against
 * the real emulator that:
 *  - the deployed W3 rule (`isW3ShiftClose`) admits the exact close write when
 *    it is committed by a transaction (no Rules change was needed);
 *  - a write to the shift between the transaction's read and its commit (the
 *    shape of a cash Return appending a pay-out) makes the commit fail its
 *    precondition, and the SDK re-runs the update function on a fresh read —
 *    the committed totals are those of the fresh read;
 *  - a transactional close of a shift that is no longer open is denied.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { arrayUnion, doc, getDoc, runTransaction, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const BRANCH = 'LDP-001';
const staff = () => ({ staffId: 'staff1', role: 'staff', branchIds: [BRANCH], permissions: [] });

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
});

type Entry = { id: string; type: 'pay_in' | 'pay_out'; amount: number };

async function seedOpenShift(shiftId: string, cashEntries: Entry[] = [], overrides: Record<string, unknown> = {}) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'shifts', shiftId), {
      id: shiftId,
      branchId: BRANCH,
      staffId: 'staff1',
      staffName: 'Cashier One',
      status: 'open',
      openedAt: new Date(),
      closedAt: null,
      startingCash: 500,
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
      cashEntries,
      ...overrides,
    });
  });
}

/** Same field set as shiftService `closeWritePayload` (W3). */
function closePayload(payOutTotal: number, payInTotal: number, actualCashCount: number) {
  const expectedCash = 1000;
  return {
    status: 'closed',
    closedAt: serverTimestamp(),
    actualCashCount,
    variance: actualCashCount - (500 + expectedCash + payInTotal - payOutTotal),
    note: '',
    expectedCash,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    totalBills: 3,
    payInTotal,
    payOutTotal,
    closedOffline: true,
    syncState: 'pending',
    deviceId: 'DEV1',
    closeCorrelationId: '11111111-1111-4111-8111-111111111111',
  };
}

/** withSecurityRulesDisabled resolves void — capture the read through a closure. */
async function readShift(shiftId: string): Promise<Record<string, unknown> | undefined> {
  let data: Record<string, unknown> | undefined;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    data = (await getDoc(doc(ctx.firestore(), 'shifts', shiftId))).data();
  });
  return data;
}

function fold(entries: Entry[]) {
  let payIn = 0;
  let payOut = 0;
  for (const e of entries) {
    if (e.type === 'pay_in') payIn += e.amount;
    else payOut += e.amount;
  }
  return { payIn, payOut };
}

describe('shifts W3 via client runTransaction (online close)', () => {
  it('ALLOWED: transactional read + exact W3 close of an open shift', async () => {
    await seedOpenShift('t1', [{ id: 'rfd1', type: 'pay_out', amount: 162 }]);
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const ref = doc(db, 'shifts', 't1');
    await assertSucceeds(
      runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const { payIn, payOut } = fold((snap.data()?.cashEntries ?? []) as Entry[]);
        tx.update(ref, closePayload(payOut, payIn, 1338));
      }),
    );
    const after = await readShift('t1');
    expect(after).toMatchObject({ status: 'closed', payOutTotal: 162, variance: 0 });
  });

  it('a write between the transaction read and commit forces a re-run on fresh data (real optimistic conflict)', async () => {
    await seedOpenShift('t2', []);
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const ref = doc(db, 'shifts', 't2');
    let attempts = 0;
    await runTransaction(db, async (tx) => {
      attempts += 1;
      const snap = await tx.get(ref);
      if (attempts === 1) {
        // A cash Return commits its pay-out to the same shift doc right now.
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await updateDoc(doc(ctx.firestore(), 'shifts', 't2'), {
            cashEntries: arrayUnion({ id: 'rfd_late', type: 'pay_out', amount: 162 }),
          });
        });
      }
      const { payIn, payOut } = fold((snap.data()?.cashEntries ?? []) as Entry[]);
      tx.update(ref, closePayload(payOut, payIn, 1338));
    });
    expect(attempts).toBeGreaterThanOrEqual(2);
    const after = await readShift('t2');
    // The committed close folded the late pay-out — never the stale (pre-Return) read.
    expect(after).toMatchObject({ status: 'closed', payOutTotal: 162, variance: 0 });
    expect((after!.cashEntries as Entry[]).map((e) => e.id)).toEqual(['rfd_late']);
  });

  it('DENIED: transactional close of a shift that is no longer open', async () => {
    await seedOpenShift('t3', [], { status: 'closed', closedAt: new Date(), closedOffline: true, syncState: 'pending', deviceId: 'D0' });
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const ref = doc(db, 'shifts', 't3');
    await assertFails(
      runTransaction(db, async (tx) => {
        await tx.get(ref);
        tx.update(ref, closePayload(0, 0, 1500));
      }),
    );
  });
});
