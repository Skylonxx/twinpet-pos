/**
 * Return/Refund V1 — C1-R1 R1-A: the `rfd_` cash-entry id namespace belongs to
 * the server (`rfd_<returnId>` payout appended by the Admin-SDK Return callable,
 * which bypasses Rules). A staff client (W1) must never be able to APPEND an
 * entry carrying that prefix to a shift's `cashEntries[]`, because the online
 * close folds cash entries by id and a client-made `rfd_X` would otherwise be
 * able to shadow the server's real `rfd_X` payout. (The frozen P5 residual that
 * W1 checks only the last element is deliberately untouched — see below.)
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/shift-cash-rfd-namespace.spec.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { arrayUnion, doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const BRANCH = 'LDP-001';
const OTHER_BRANCH = 'LDP-002';
const RETURN_ID = 'a'.repeat(40);
const staff = () => ({ staffId: 'staff1', role: 'staff', branchIds: [BRANCH], permissions: [] });
const otherBranchStaff = () => ({ staffId: 'staff1', role: 'staff', branchIds: [OTHER_BRANCH], permissions: [] });

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

type Entry = {
  id: string;
  type: 'pay_in' | 'pay_out';
  amount: number;
  note: string;
  staffId: string;
  staffName: string;
  at: number;
};

function entry(id: string, over: Partial<Entry> = {}): Entry {
  return { id, type: 'pay_out', amount: 1, note: 'n', staffId: 'staff1', staffName: 'Cashier One', at: 1_700_000_000_000, ...over };
}

/** What `submitSaleReturn` (Admin SDK) writes for a cash refund. */
const SERVER_REFUND: Entry = entry(`rfd_${RETURN_ID}`, { amount: 81, note: 'คืนเงินสด RT-R-1-1 (บิล B1)' });

async function seedShift(shiftId: string, cashEntries: Entry[] | undefined, overrides: Record<string, unknown> = {}) {
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
      ...(cashEntries === undefined ? {} : { cashEntries }),
      ...overrides,
    });
  });
}

async function readShift(shiftId: string): Promise<Record<string, unknown> | undefined> {
  let data: Record<string, unknown> | undefined;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    data = (await getDoc(doc(ctx.firestore(), 'shifts', shiftId))).data();
  });
  return data;
}

const ids = (d: Record<string, unknown> | undefined) => ((d?.cashEntries ?? []) as Entry[]).map((e) => e.id);

/** The production client write (`recordCashTransaction`): arrayUnion of one entry. */
function appendViaArrayUnion(ctxEntry: Entry, as: () => Record<string, unknown> = staff, shiftId = 's1') {
  const db = testEnv.authenticatedContext('staff1', as()).firestore();
  return updateDoc(doc(db, 'shifts', shiftId), { cashEntries: arrayUnion(ctxEntry), updatedAt: serverTimestamp() });
}

/** A raw whole-list write (what a hostile client can send instead of arrayUnion). */
function writeList(list: Entry[], shiftId = 's1') {
  const db = testEnv.authenticatedContext('staff1', staff()).firestore();
  return updateDoc(doc(db, 'shifts', shiftId), { cashEntries: list, updatedAt: serverTimestamp() });
}

describe('W1 — the rfd_ namespace is reserved for the server', () => {
  it('DENIED: a staff client appending rfd_<id> as pay_out, pay_in and with other amounts', async () => {
    for (const [i, variant] of [
      entry(`rfd_${RETURN_ID}`, { type: 'pay_out', amount: 1 }),
      entry(`rfd_${RETURN_ID}`, { type: 'pay_out', amount: 81 }),
      entry(`rfd_${RETURN_ID}`, { type: 'pay_in', amount: 1 }),
      entry(`rfd_${RETURN_ID}`, { type: 'pay_in', amount: 5000 }),
      entry('rfd_X', { type: 'pay_out', amount: 0.5 }),
      entry('rfd_', { type: 'pay_out', amount: 10 }),
      entry('rfd_\nX', { type: 'pay_out', amount: 10 }),
    ].entries()) {
      await seedShift(`s${i}`, []);
      await assertFails(appendViaArrayUnion(variant, staff, `s${i}`));
      expect(await readShift(`s${i}`)).toMatchObject({ cashEntries: [] });
    }
  });

  it('DENIED: re-using the id of a legitimate server rfd_ entry (the shadowing attack), both amounts', async () => {
    await seedShift('s1', [SERVER_REFUND]);
    await assertFails(appendViaArrayUnion(entry(SERVER_REFUND.id, { type: 'pay_out', amount: 1 })));
    await assertFails(appendViaArrayUnion(entry(SERVER_REFUND.id, { type: 'pay_out', amount: 81 })));
    await assertFails(appendViaArrayUnion(entry(SERVER_REFUND.id, { type: 'pay_in', amount: 81 })));
    expect(ids(await readShift('s1'))).toEqual([SERVER_REFUND.id]);
  });

  it('DENIED: a whole-list write that appends rfd_ as its last element', async () => {
    await seedShift('s1', [entry('c1', { type: 'pay_in', amount: 50 })]);
    await assertFails(writeList([entry('c1', { type: 'pay_in', amount: 50 }), entry('rfd_Y', { amount: 7 })]));
    expect(ids(await readShift('s1'))).toEqual(['c1']);
  });

  it('DENIED (forged-mutation negatives preserved): an append bundled with another field, a forged updatedAt, or no updatedAt', async () => {
    await seedShift('s1', [SERVER_REFUND]);
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const ref = doc(db, 'shifts', 's1');
    const list = [SERVER_REFUND, entry('Mm3sQe9wLm2PqRtUvXz4', { amount: 3 })];
    await assertFails(updateDoc(ref, { cashEntries: list, updatedAt: serverTimestamp(), payOutTotal: 999 }));
    await assertFails(updateDoc(ref, { cashEntries: list, updatedAt: new Date(0) }));
    await assertFails(updateDoc(ref, { cashEntries: list }));
    expect(ids(await readShift('s1'))).toEqual([SERVER_REFUND.id]);
  });

  it('ALLOWED — PRE-EXISTING frozen P5 residual, NOT changed by C1-R1: W1 validates only the LAST element, so an earlier one can be rewritten', async () => {
    // Documented in shift-close-p5c.spec.ts ("accepted prefix-rewrite residual"). C1-R1
    // reserves the namespace of the APPENDED entry only. For the cash identity defect the
    // outcome stays fail-closed: rewriting an earlier element into a duplicate of the
    // server's rfd_ id yields a list that the online close REFUSES
    // (shiftService.cashIntegrity.test.ts). Reported to the decision authority.
    await seedShift('s1', [entry('c1', { type: 'pay_in', amount: 50 }), SERVER_REFUND]);
    await assertSucceeds(writeList([entry(SERVER_REFUND.id, { amount: 1 }), SERVER_REFUND, entry('c2', { type: 'pay_in', amount: 1 })]));
    expect(ids(await readShift('s1'))).toEqual([SERVER_REFUND.id, SERVER_REFUND.id, 'c2']);
  });

  it('ALLOWED: ordinary pay_in / pay_out appends (Firestore auto-id shaped) on an empty or absent list', async () => {
    await seedShift('s1', []);
    await assertSucceeds(appendViaArrayUnion(entry('Zk3sQe9wLm2PqRtUvXy1', { type: 'pay_in', amount: 200 })));
    await assertSucceeds(appendViaArrayUnion(entry('Ab3sQe9wLm2PqRtUvXy2', { type: 'pay_out', amount: 30 })));
    expect(ids(await readShift('s1'))).toEqual(['Zk3sQe9wLm2PqRtUvXy1', 'Ab3sQe9wLm2PqRtUvXy2']);

    await seedShift('s2', undefined); // W0-created shift has no cashEntries field yet
    await assertSucceeds(appendViaArrayUnion(entry('Cc3sQe9wLm2PqRtUvXy3', { type: 'pay_in', amount: 10 }), staff, 's2'));
    expect(ids(await readShift('s2'))).toEqual(['Cc3sQe9wLm2PqRtUvXy3']);
  });

  it('ALLOWED: an ordinary append onto a shift that already holds a legitimate server rfd_ entry (history preserved)', async () => {
    await seedShift('s1', [SERVER_REFUND]);
    await assertSucceeds(appendViaArrayUnion(entry('Dd3sQe9wLm2PqRtUvXy4', { type: 'pay_in', amount: 20 })));
    await assertSucceeds(writeList([SERVER_REFUND, entry('Dd3sQe9wLm2PqRtUvXy4', { type: 'pay_in', amount: 20 }), entry('Ee3sQe9wLm2PqRtUvXy5', { amount: 3 })]));
    expect(ids(await readShift('s1'))).toEqual([SERVER_REFUND.id, 'Dd3sQe9wLm2PqRtUvXy4', 'Ee3sQe9wLm2PqRtUvXy5']);
  });

  it('ALLOWED: ids that merely contain, or case-differ from, the reserved prefix are not reserved', async () => {
    await seedShift('s1', []);
    await assertSucceeds(appendViaArrayUnion(entry('xrfd_1')));
    await assertSucceeds(appendViaArrayUnion(entry('rfd1'))); // no underscore (pre-existing rules-test shape)
    await assertSucceeds(appendViaArrayUnion(entry('RFD_1'))); // reservation is the case-sensitive server prefix
    expect(ids(await readShift('s1'))).toEqual(['xrfd_1', 'rfd1', 'RFD_1']);
  });

  it('server (Admin SDK, rules bypassed) still appends rfd_<returnId> exactly as submitSaleReturn does', async () => {
    await seedShift('s1', [entry('c1', { type: 'pay_in', amount: 50 })]);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'shifts', 's1'), { cashEntries: arrayUnion(SERVER_REFUND), updatedAt: new Date() });
    });
    expect(ids(await readShift('s1'))).toEqual(['c1', SERVER_REFUND.id]);
  });

  it('negatives preserved: other branch, other actor, unknown field, closed shift and bad type/amount are still denied', async () => {
    await seedShift('s1', []);
    await assertFails(appendViaArrayUnion(entry('Ff3sQe9wLm2PqRtUvXy6'), otherBranchStaff));
    await assertFails(appendViaArrayUnion(entry('Gg3sQe9wLm2PqRtUvXy7', { staffId: 'someone-else' })));
    await assertFails(appendViaArrayUnion({ ...entry('Hh3sQe9wLm2PqRtUvXy8'), extra: 1 } as Entry));
    await assertFails(appendViaArrayUnion(entry('Ii3sQe9wLm2PqRtUvXy9', { amount: 0 })));
    await assertFails(appendViaArrayUnion(entry('Jj3sQe9wLm2PqRtUvXz1', { type: 'refund' as unknown as 'pay_in' })));
    await assertFails(appendViaArrayUnion(entry('')));
    await seedShift('sc', [], { status: 'closed', closedAt: new Date(), closedOffline: true, syncState: 'pending', deviceId: 'D0' });
    await assertFails(appendViaArrayUnion(entry('Kk3sQe9wLm2PqRtUvXz2'), staff, 'sc'));
    expect(ids(await readShift('s1'))).toEqual([]);
  });
});

describe('W1 namespace change does not regress W2 / W3 / W4 or the Return read path on a shift holding rfd_ history', () => {
  it('W2 credit-debt receipt, W3 close and W4 sync-state normalization still work with a server rfd_ entry present', async () => {
    await seedShift('s1', [SERVER_REFUND]);
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const ref = doc(db, 'shifts', 's1');
    await assertSucceeds(updateDoc(ref, { expectedCash: 100 }));
    await assertSucceeds(
      updateDoc(ref, {
        status: 'closed',
        closedAt: serverTimestamp(),
        actualCashCount: 519,
        variance: 0,
        note: '',
        expectedCash: 100,
        expectedQr: 0,
        expectedKbank: 0,
        expectedCard: 0,
        expectedCredit: 0,
        totalBills: 1,
        payInTotal: 0,
        payOutTotal: 81,
        closedOffline: true,
        syncState: 'pending',
        deviceId: 'DEV1',
        closeCorrelationId: '11111111-1111-4111-8111-111111111111',
      }),
    );
    await assertSucceeds(updateDoc(ref, { syncState: 'synced' }));
    expect(await readShift('s1')).toMatchObject({ status: 'closed', syncState: 'synced', payOutTotal: 81 });
    expect(ids(await readShift('s1'))).toEqual([SERVER_REFUND.id]);
  });

  it('a closed shift can no longer take any cash append (W1 requires open), including an ordinary one', async () => {
    await seedShift('s1', [SERVER_REFUND], { status: 'closed', closedAt: new Date(), closedOffline: true, syncState: 'synced', deviceId: 'D0' });
    await assertFails(appendViaArrayUnion(entry('Ll3sQe9wLm2PqRtUvXz3')));
  });
});
