/**
 * Return/Refund V1 packet 012 — server-authoritative close vs the CURRENT (unsealed) Rules.
 *
 * firestore.rules is byte-identical to HEAD in packet 012. This spec records two facts:
 *  1. COMPATIBILITY: the exact W3 field set the new callable writes
 *     (`planAuthoritativeClose().w3Fields` + server `closedAt`) is a valid
 *     `isW3ShiftClose` shape, and W4 still follows it — the server close is
 *     drop-in for every Rules-checked reader / follow-on write.
 *  2. DOCUMENTED PRE-CUTOVER RISK (NOT closed by 012): a branch-staff client can
 *     still write a direct W3 whose totals ignore a committed Return payout.
 *     These assertions PASS today on purpose; the later Rules seal packet must
 *     invert them (client W3 DENIED) before `pos_return` can be enabled.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/shift-close-authoritative-precutover.spec.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
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

describe('012 — server-authoritative close vs current (unsealed) Rules', () => {
  it('COMPATIBILITY: the callable W3 field set is an accepted isW3ShiftClose shape (payOut 81, variance 0), and W4 follows', async () => {
    const data = await seedOpenShiftWithReturn81();
    const w3 = serverW3Fields(data);
    expect(w3).toMatchObject({ payOutTotal: 81, variance: 0, closedOffline: true, syncState: 'pending', closeCorrelationId: UUID });
    const db = testEnv.authenticatedContext('u-staff-1', staff()).firestore();
    await assertSucceeds(updateDoc(doc(db, 'shifts', SHIFT), { ...w3, closedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(db, 'shifts', SHIFT), { syncState: 'synced' }));
    const after = (await getDoc(doc(db, 'shifts', SHIFT))).data()!;
    expect(after).toMatchObject({ status: 'closed', payOutTotal: 81, variance: 0, syncState: 'synced' });
  });

  it('DOCUMENTED PRE-CUTOVER RISK: a direct client W3 that drops the Return payout is STILL ACCEPTED (Rules unchanged in 012)', async () => {
    const data = await seedOpenShiftWithReturn81();
    const forged = { ...serverW3Fields(data), payOutTotal: 0, variance: 0, actualCashCount: 1500 };
    const db = testEnv.authenticatedContext('u-staff-1', staff()).firestore();
    // This PASSING is the open risk, not a guarantee: the seal packet must turn it into assertFails.
    await assertSucceeds(updateDoc(doc(db, 'shifts', SHIFT), { ...forged, closedAt: serverTimestamp() }));
    const after = (await getDoc(doc(db, 'shifts', SHIFT))).data()!;
    expect(after).toMatchObject({ status: 'closed', payOutTotal: 0, variance: 0 });
  });

  it('DOCUMENTED PRE-CUTOVER RISK: any branch staff (not the owner) can still direct-W3 the shift', async () => {
    const data = await seedOpenShiftWithReturn81();
    const other = testEnv
      .authenticatedContext('u-staff-2', { staffId: 'staff-2', role: 'staff', branchIds: [BRANCH], permissions: [] })
      .firestore();
    await assertSucceeds(updateDoc(doc(other, 'shifts', SHIFT), { ...serverW3Fields(data), closedAt: serverTimestamp() }));
  });
});
