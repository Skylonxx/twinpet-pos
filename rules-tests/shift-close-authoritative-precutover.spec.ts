/**
 * Return/Refund V1 packets 012 → 017 — server-authoritative close vs the Rules.
 *
 * Packet 012 recorded, against the then UNSEALED Rules (byte-identical to HEAD):
 *  1. COMPATIBILITY: the exact W3 field set the callable writes
 *     (`planAuthoritativeClose().w3Fields` + server `closedAt`) was an accepted
 *     `isW3ShiftClose` shape, and W4 followed it.
 *  2. DOCUMENTED PRE-CUTOVER RISK: a branch-staff client could write a direct W3
 *     whose totals ignore a committed Return payout (those assertions PASSED on
 *     purpose and had to be inverted by the seal packet).
 *
 * Packet 017 (Rules SOURCE seal, not deployed) inverts them, as specified in
 * docs/contracts/close-shift-authoritative-v1.md §9:
 *  1. COMPATIBILITY now means: the callable's W3 field set written by the
 *     server (Rules BYPASSED — `withSecurityRulesDisabled` stands in for the
 *     Admin SDK here; it is NOT a Rules permission) is followed by the client
 *     W4, while the same field set sent by a client is DENIED.
 *  2. The two risks are now DENIED — the payout-dropping forged W3 and the
 *     non-owner W3 — and the shift (with its Return payout) is left untouched.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/shift-close-authoritative-precutover.spec.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, serverTimestamp, setDoc, Timestamp, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  foldShiftCashEntriesStrict,
  parseOpenShiftIdentity,
  planAuthoritativeClose,
  validateCloseShiftRequest,
} from '../functions/src/closeShiftAuthoritativeCore';

const BRANCH = 'LDP-001';
const SHIFT = 'shift-012';
const UUID = '22222222-2222-4222-8222-222222222222';
const RFD = `rfd_${'e'.repeat(40)}`;
const staff = () => ({ staffId: 'staff-1', role: 'staff', branchIds: [BRANCH], permissions: [] });

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

/** W0 open shift (startingCash 500) carrying the server Return payout of 81. */
async function seedOpenShiftWithReturn81(): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {
    id: SHIFT,
    branchId: BRANCH,
    staffId: 'staff-1',
    staffName: 'Cashier One',
    status: 'open',
    openedAt: Timestamp.fromMillis(1_760_000_000_000),
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
    cashEntries: [{ id: RFD, type: 'pay_out', amount: 81, note: 'คืนเงินสด', staffId: 'staff-1', staffName: 'Cashier One', at: 1 }],
  };
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'shifts', SHIFT), data);
  });
  return data;
}

function serverW3Fields(shiftData: Record<string, unknown>): Record<string, unknown> {
  const req = validateCloseShiftRequest({
    contractVersion: 1,
    shiftId: SHIFT,
    closeCorrelationId: UUID,
    actualCashCount: 1419,
    note: '',
    attestedSales: { expectedCash: 1000, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0, totalBills: 3 },
    deviceId: 'DEV1',
  });
  const shift = parseOpenShiftIdentity(SHIFT, shiftData);
  const cash = foldShiftCashEntriesStrict(shiftData.cashEntries, true);
  if (!req.ok || !shift.ok || !cash.ok) throw new Error('fixture');
  const plan = planAuthoritativeClose({ shift: shift.value, request: req.value, cash: cash.value });
  if (!plan.ok) throw new Error(plan.code);
  return plan.value.w3Fields;
}

async function readShift(): Promise<Record<string, unknown> | undefined> {
  let data: Record<string, unknown> | undefined;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    data = (await getDoc(doc(ctx.firestore(), 'shifts', SHIFT))).data();
  });
  return data;
}

async function expectUntouchedOpenShiftWithReturn81() {
  const after = (await readShift())!;
  expect(after).toMatchObject({ status: 'open', closedAt: null, payOutTotal: 0 });
  expect((after.cashEntries as { id: string }[]).map((e) => e.id)).toEqual([RFD]);
}

describe('012 → 017 — server-authoritative close vs the SEALED Rules', () => {
  it('COMPATIBILITY (017): the callable W3 field set is server-written (Rules bypassed) and the client W4 follows; the same field set from a client is DENIED', async () => {
    const data = await seedOpenShiftWithReturn81();
    const w3 = serverW3Fields(data);
    expect(w3).toMatchObject({ payOutTotal: 81, variance: 0, closedOffline: true, syncState: 'pending', closeCorrelationId: UUID });
    const db = testEnv.authenticatedContext('u-staff-1', staff()).firestore();

    // A client sending the server's exact (correct) field set is still refused: only the server closes.
    await assertFails(updateDoc(doc(db, 'shifts', SHIFT), { ...w3, closedAt: serverTimestamp() }));
    await expectUntouchedOpenShiftWithReturn81();

    // The server close (Rules bypassed — Admin-SDK stand-in, NOT a Rules permission).
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'shifts', SHIFT), { ...w3, closedAt: serverTimestamp() });
    });
    // The client W4 normalization (a real Rules-evaluated write) still follows it.
    await assertSucceeds(updateDoc(doc(db, 'shifts', SHIFT), { syncState: 'synced' }));
    const after = (await getDoc(doc(db, 'shifts', SHIFT))).data()!;
    expect(after).toMatchObject({ status: 'closed', payOutTotal: 81, variance: 0, syncState: 'synced' });
  });

  it('017 SEAL (was DOCUMENTED PRE-CUTOVER RISK, ALLOWED pre-seal): a direct client W3 that drops the Return payout is DENIED', async () => {
    const data = await seedOpenShiftWithReturn81();
    const forged = { ...serverW3Fields(data), payOutTotal: 0, variance: 0, actualCashCount: 1500 };
    const db = testEnv.authenticatedContext('u-staff-1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', SHIFT), { ...forged, closedAt: serverTimestamp() }));
    await expectUntouchedOpenShiftWithReturn81();
  });

  it('017 SEAL (was DOCUMENTED PRE-CUTOVER RISK, ALLOWED pre-seal): a non-owner branch staff direct W3 is DENIED', async () => {
    const data = await seedOpenShiftWithReturn81();
    const other = testEnv
      .authenticatedContext('u-staff-2', { staffId: 'staff-2', role: 'staff', branchIds: [BRANCH], permissions: [] })
      .firestore();
    await assertFails(updateDoc(doc(other, 'shifts', SHIFT), { ...serverW3Fields(data), closedAt: serverTimestamp() }));
    await expectUntouchedOpenShiftWithReturn81();
  });
});
