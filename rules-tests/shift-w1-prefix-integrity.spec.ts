/**
 * Return/Refund V1 — C1-R1 010: W1 must keep the EXISTING `cashEntries` prefix
 * immutable. W1 (staff open-shift cash append) used to validate only the list
 * size (+1) and the NEW last element, so an authorized branch-staff client could
 * submit a whole-array update that REPLACED a previously committed server refund
 * payout (`rfd_<returnId>`) with an ordinary entry and appended another ordinary
 * entry. A freshly-mounted POS then closed from the coherent-but-falsified list
 * and printed a Z without the payout (see shift-w1-prefix-close-chain.spec.ts).
 *
 * This spec drives REAL Firestore Rules (demo-twinpet emulator).
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/shift-w1-prefix-integrity.spec.ts"
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { arrayUnion, doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const BRANCH = 'LDP-001';
const staff = () => ({ staffId: 'staff1', role: 'staff', branchIds: [BRANCH], permissions: [] });
const otherStaff = () => ({ staffId: 'staff2', role: 'staff', branchIds: [BRANCH], permissions: [] });
const otherBranchStaff = () => ({ staffId: 'staff1', role: 'staff', branchIds: ['LDP-002'], permissions: [] });
const RETURN_ID = 'c'.repeat(40);

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

type Entry = Record<string, unknown> & { id: string };

const AT = 1_760_000_000_000;
function entry(id: string, over: Record<string, unknown> = {}): Entry {
  return { id, type: 'pay_out', amount: 1, note: 'n', staffId: 'staff1', staffName: 'Cashier One', at: AT, ...over };
}

/** Exactly what `submitSaleReturn` (Admin SDK) appends for a cash refund of 81 baht. */
const R: Entry = entry(`rfd_${RETURN_ID}`, {
  type: 'pay_out',
  amount: 81,
  note: 'คืนเงินสด RT-R-1-1 (บิล B1)',
  at: AT + 5,
});

async function seedShift(shiftId: string, cashEntries: unknown, over: Record<string, unknown> = {}) {
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
      expectedCash: 1000,
      expectedQr: 0,
      expectedKbank: 0,
      expectedCard: 0,
      expectedCredit: 0,
      totalBills: 3,
      payInTotal: 0,
      payOutTotal: 0,
      variance: 0,
      note: '',
      ...(cashEntries === undefined ? {} : { cashEntries }),
      ...over,
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

const list = (d: Record<string, unknown> | undefined) => (d?.cashEntries ?? []) as Entry[];

/** Whole-array W1 update (what a hostile — or legacy reconstructing — client can send). */
function writeList(newList: unknown, shiftId = 's1', as: () => Record<string, unknown> = staff, extra: Record<string, unknown> = {}) {
  const db = testEnv.authenticatedContext('staff1', as()).firestore();
  return updateDoc(doc(db, 'shifts', shiftId), { cashEntries: newList as never, updatedAt: serverTimestamp(), ...extra });
}

/** The production writer (`recordCashTransaction`): arrayUnion of one entry. */
function arrayUnionAppend(e: Entry, shiftId = 's1', as: () => Record<string, unknown> = staff) {
  const db = testEnv.authenticatedContext('staff1', as()).firestore();
  return updateDoc(doc(db, 'shifts', shiftId), { cashEntries: arrayUnion(e), updatedAt: serverTimestamp() });
}

const FAKE = entry('c_fake', { type: 'pay_out', amount: 1 });
const LAST = entry('c_last', { type: 'pay_in', amount: 1 });

describe('010 counterexample — replacing the server refund payout while appending an ordinary entry', () => {
  it('Return-81 chronology: server payout + audit doc exist, then the hostile whole-array W1 replacement is DENIED', async () => {
    // 1. Server Return (Admin SDK) records payout R and the companion audit document.
    await seedShift('s1', [R]);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'cashTransactions', R.id), {
        id: R.id, shiftId: 's1', branchId: BRANCH, staffId: 'staff1', staffName: 'Cashier One',
        type: 'pay_out', amount: 81, note: R.note, source: 'sale_refund', returnId: RETURN_ID,
      });
    });
    // 2. Hostile branch staff: replace R by ordinary c_fake pay_out 1, append ordinary c_last pay_in 1.
    //    old len 1 → new len 2; the LAST element is a perfectly valid ordinary pay_in.
    await assertFails(writeList([FAKE, LAST]));
    // 3. After the fix the Return evidence is untouched.
    expect(list(await readShift('s1'))).toEqual([R]);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDoc(doc(ctx.firestore(), 'cashTransactions', R.id))).data()).toMatchObject({ amount: 81, source: 'sale_refund' });
    });
  });

  it('a legitimate ordinary append to the SAME shift (R preserved byte-for-byte) is still ALLOWED, via arrayUnion and whole-list', async () => {
    await seedShift('s1', [R]);
    await assertSucceeds(arrayUnionAppend(entry('Aa3sQe9wLm2PqRtUvXy1', { type: 'pay_in', amount: 20 })));
    await assertSucceeds(writeList([R, entry('Aa3sQe9wLm2PqRtUvXy1', { type: 'pay_in', amount: 20 }), LAST]));
    expect(list(await readShift('s1')).map((e) => e.id)).toEqual([R.id, 'Aa3sQe9wLm2PqRtUvXy1', 'c_last']);
    expect(list(await readShift('s1'))[0]).toEqual(R);
  });
});

describe('010 — any mutation of the existing prefix is DENIED even though size is old+1 and the last element is valid', () => {
  const OLD = [entry('c_a', { type: 'pay_in', amount: 100 }), R, entry('c_b', { type: 'pay_out', amount: 7, at: AT + 9 })];
  const FRESH_LAST = entry('c_new', { type: 'pay_in', amount: 3 });

  async function expectDenied(prefix: Entry[]) {
    await seedShift('s1', OLD);
    await assertFails(writeList([...prefix, FRESH_LAST]));
    expect(list(await readShift('s1'))).toEqual(OLD);
  }

  it.each([
    ['id of the first element', (o: Entry[]) => [{ ...o[0]!, id: 'c_other' }, o[1]!, o[2]!]],
    ['amount of the first element', (o: Entry[]) => [{ ...o[0]!, amount: 101 }, o[1]!, o[2]!]],
    ['type of the first element', (o: Entry[]) => [{ ...o[0]!, type: 'pay_out' }, o[1]!, o[2]!]],
    ['note of the first element', (o: Entry[]) => [{ ...o[0]!, note: 'edited' }, o[1]!, o[2]!]],
    ['staffId of the first element', (o: Entry[]) => [{ ...o[0]!, staffId: 'staff2' }, o[1]!, o[2]!]],
    ['staffName of the first element', (o: Entry[]) => [{ ...o[0]!, staffName: 'Someone Else' }, o[1]!, o[2]!]],
    ['time (at) of the first element', (o: Entry[]) => [{ ...o[0]!, at: AT + 1 }, o[1]!, o[2]!]],
    ['an extra field added to an old element', (o: Entry[]) => [{ ...o[0]!, extra: 1 }, o[1]!, o[2]!]],
    [
      'a field removed from an old element',
      (o: Entry[]) => {
        const thin: Record<string, unknown> = { ...o[0]! };
        delete thin.note;
        return [thin as Entry, o[1]!, o[2]!];
      },
    ],
    ['the server refund payout amount (81 → 1)', (o: Entry[]) => [o[0]!, { ...o[1]!, amount: 1 }, o[2]!]],
    ['the server refund payout id (rfd_ → ordinary)', (o: Entry[]) => [o[0]!, { ...o[1]!, id: 'c_fake' }, o[2]!]],
    ['the server refund payout replaced by an ordinary entry', (o: Entry[]) => [o[0]!, FAKE, o[2]!]],
    ['the LAST old element', (o: Entry[]) => [o[0]!, o[1]!, { ...o[2]!, amount: 8 }]],
    ['reordering the old elements', (o: Entry[]) => [o[1]!, o[0]!, o[2]!]],
    ['reversing the old elements', (o: Entry[]) => [o[2]!, o[1]!, o[0]!]],
    ['deleting an old element and padding with an ordinary one', (o: Entry[]) => [o[0]!, o[2]!, entry('c_pad', { type: 'pay_in', amount: 1 })]],
    ['deleting the server refund and padding with a duplicate of another element', (o: Entry[]) => [o[0]!, o[0]!, o[2]!]],
  ])('%s', async (_name, mutate) => {
    await expectDenied(mutate(OLD));
  });

  it('identical-count substitution (no append) is denied too', async () => {
    await seedShift('s1', [R]);
    await assertFails(writeList([FAKE]));
    expect(list(await readShift('s1'))).toEqual([R]);
  });

  it('removing ALL old elements and appending is denied', async () => {
    await seedShift('s1', [R]);
    await assertFails(writeList([LAST, LAST]));
    await assertFails(writeList([LAST]));
    expect(list(await readShift('s1'))).toEqual([R]);
  });

  it('the 009 rfd_ reservation of a newly appended entry still holds on top of the prefix check', async () => {
    await seedShift('s1', [R]);
    await assertFails(writeList([R, entry(`rfd_${'d'.repeat(40)}`, { type: 'pay_out', amount: 5 })]));
    await assertFails(arrayUnionAppend(entry(R.id, { type: 'pay_out', amount: 1 })));
    expect(list(await readShift('s1'))).toEqual([R]);
  });
});

describe('010 — legitimate appends stay ALLOWED (production arrayUnion writer and whole-list), prefix preserved', () => {
  const ORD_IN = entry('Bb3sQe9wLm2PqRtUvXy2', { type: 'pay_in', amount: 200 });
  const ORD_OUT = entry('Cc3sQe9wLm2PqRtUvXy3', { type: 'pay_out', amount: 30 });

  it('first append onto a MISSING cashEntries field (W0-created shift)', async () => {
    await seedShift('m1', undefined);
    await assertSucceeds(arrayUnionAppend(ORD_IN, 'm1'));
    await seedShift('m2', undefined);
    await assertSucceeds(writeList([ORD_OUT], 'm2'));
    expect(list(await readShift('m1'))).toEqual([ORD_IN]);
    expect(list(await readShift('m2'))).toEqual([ORD_OUT]);
  });

  it('first append onto an EMPTY list (zero-length prefix must not hit a slice evaluation error)', async () => {
    await seedShift('e1', []);
    await assertSucceeds(arrayUnionAppend(ORD_IN, 'e1'));
    await seedShift('e2', []);
    await assertSucceeds(writeList([ORD_OUT], 'e2'));
    expect(list(await readShift('e1'))).toEqual([ORD_IN]);
    expect(list(await readShift('e2'))).toEqual([ORD_OUT]);
  });

  it('append onto non-empty ordinary history and onto server rfd_ history; pay_in and pay_out', async () => {
    await seedShift('n1', [entry('c_hist', { type: 'pay_in', amount: 5 })]);
    await assertSucceeds(arrayUnionAppend(ORD_IN, 'n1'));
    await assertSucceeds(writeList([entry('c_hist', { type: 'pay_in', amount: 5 }), ORD_IN, ORD_OUT], 'n1'));
    expect(list(await readShift('n1')).map((e) => e.id)).toEqual(['c_hist', ORD_IN.id, ORD_OUT.id]);

    await seedShift('n2', [R]);
    await assertSucceeds(arrayUnionAppend(ORD_OUT, 'n2'));
    await assertSucceeds(writeList([R, ORD_OUT, ORD_IN], 'n2'));
    expect(list(await readShift('n2')).map((e) => e.id)).toEqual([R.id, ORD_OUT.id, ORD_IN.id]);
  });

  it('historical optional fields / representations in the OLD prefix are preserved, not revalidated', async () => {
    const legacy: Entry[] = [
      { id: 'h_thin', type: 'pay_in', amount: 5 } as Entry, // no note/staff/at
      entry('h_float', { amount: 12.5, at: 1.5e12 + 0.5 }), // fractional amount, non-int `at`
      entry('h_extra', { legacyField: { nested: [1, 2, 3] } }), // unknown extra field
      entry('h_blank', { note: '' }), // blank note (fails the NEW-entry rule, legal as history)
    ];
    await seedShift('h1', legacy);
    await assertSucceeds(arrayUnionAppend(ORD_IN, 'h1'));
    await assertSucceeds(writeList([...legacy, ORD_IN, ORD_OUT], 'h1'));
    expect(list(await readShift('h1')).slice(0, 4)).toEqual(legacy);
  });

  it('a mutated old element is still denied when the history has those legacy shapes', async () => {
    const legacy: Entry[] = [{ id: 'h_thin', type: 'pay_in', amount: 5 } as Entry, entry('h_blank', { note: '' })];
    await seedShift('h2', legacy);
    await assertFails(writeList([{ ...legacy[0]!, amount: 6 }, legacy[1]!, ORD_IN], 'h2'));
    await assertFails(writeList([legacy[0]!, { ...legacy[1]!, note: 'x' }, ORD_IN], 'h2'));
  });
});

describe('010 — W1 negatives preserved', () => {
  const ORD = entry('Dd3sQe9wLm2PqRtUvXy4', { type: 'pay_in', amount: 20 });

  it('foreign actor / foreign branch / non-open shift / forged updatedAt / extra changed field / malformed entry', async () => {
    await seedShift('s1', [R]);
    await assertFails(arrayUnionAppend(entry('Ee3sQe9wLm2PqRtUvXy5', { staffId: 'staff2' })));
    await assertFails(arrayUnionAppend(ORD, 's1', otherBranchStaff));
    await assertFails(arrayUnionAppend(ORD, 's1', otherStaff)); // entry.staffId=staff1 ≠ token staff2
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const ref = doc(db, 'shifts', 's1');
    await assertFails(updateDoc(ref, { cashEntries: [R, ORD], updatedAt: new Date(0) }));
    await assertFails(updateDoc(ref, { cashEntries: [R, ORD] }));
    await assertFails(updateDoc(ref, { cashEntries: [R, ORD], updatedAt: serverTimestamp(), payOutTotal: 999 }));
    await assertFails(writeList([R, { ...ORD, extra: 1 }]));
    await assertFails(writeList([R, { ...ORD, amount: -1 }]));
    await assertFails(writeList([R, { ...ORD, amount: 0 }]));
    await assertFails(writeList([R, { ...ORD, type: 'refund' }]));
    await assertFails(writeList([R, { ...ORD, id: '' }]));
    await assertFails(writeList([R, 'not-a-map']));
    await assertFails(writeList([R, ORD, ORD])); // +2
    await seedShift('c1', [R], { status: 'closed', closedAt: new Date(), closedOffline: true, syncState: 'pending', deviceId: 'D0' });
    await assertFails(writeList([R, ORD], 'c1'));
    expect(list(await readShift('s1'))).toEqual([R]);
  });

  it('a MALFORMED old list (null / string / map / number) denies every append, fail-closed', async () => {
    for (const [i, bad] of [null, 'oops', { 0: R }, 7].entries()) {
      await seedShift(`b${i}`, bad);
      await assertFails(writeList([ORD], `b${i}`));
      await assertFails(arrayUnionAppend(ORD, `b${i}`));
    }
  });

  it('a non-list NEW cashEntries is denied', async () => {
    await seedShift('s1', [R]);
    await assertFails(writeList('x'));
    await assertFails(writeList({ 0: R, 1: ORD }));
    await assertFails(writeList(null));
  });

  it('W2 / W3 / W4 are unaffected on a shift holding server rfd_ history', async () => {
    await seedShift('s1', [R]);
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const ref = doc(db, 'shifts', 's1');
    await assertSucceeds(updateDoc(ref, { expectedCash: 1100 }));
    await assertSucceeds(
      updateDoc(ref, {
        status: 'closed', closedAt: serverTimestamp(), actualCashCount: 1519, variance: 0, note: '',
        expectedCash: 1100, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0,
        totalBills: 3, payInTotal: 0, payOutTotal: 81, closedOffline: true, syncState: 'pending', deviceId: 'DEV1',
        closeCorrelationId: '11111111-1111-4111-8111-111111111111',
      }),
    );
    await assertSucceeds(updateDoc(ref, { syncState: 'synced' }));
    expect(list(await readShift('s1'))).toEqual([R]);
  });
});

describe('010 — long cash lists (Rules evaluation limits, bounded findings)', () => {
  const big = (n: number): Entry[] =>
    Array.from({ length: n }, (_v, i) => entry(`c_${String(i).padStart(5, '0')}`, { type: i % 2 ? 'pay_in' : 'pay_out', amount: 1 + (i % 50), at: AT + i }));

  it.each([25, 100, 250, 500, 1000, 2000])('N=%i existing entries: append allowed; mutating the first / a middle / the last old element is denied', async (n) => {
    const old = big(n);
    old[Math.floor(n / 2)] = R;
    await seedShift(`L${n}`, old);
    const t0 = Date.now();
    await assertSucceeds(arrayUnionAppend(entry('Zz3sQe9wLm2PqRtUvXy9', { type: 'pay_in', amount: 2 }), `L${n}`));
    await assertSucceeds(writeList([...old, entry('Zz3sQe9wLm2PqRtUvXy9', { type: 'pay_in', amount: 2 }), entry('Zy3sQe9wLm2PqRtUvXy8')], `L${n}`));
    const allowedMs = Date.now() - t0;
    const fresh = entry('Yy3sQe9wLm2PqRtUvXy0', { type: 'pay_in', amount: 3 });
    const base = (await readShift(`L${n}`))!.cashEntries as Entry[];
    for (const idx of [0, Math.floor(n / 2), n - 1]) {
      const tampered = base.map((e, i) => (i === idx ? { ...e, amount: (e.amount as number) + 1 } : e));
      await assertFails(writeList([...tampered, fresh], `L${n}`));
    }
    if (process.env.W1_PREFIX_LOG) {
      appendFileSync(process.env.W1_PREFIX_LOG, `N=${n}: two allowed appends in ${allowedMs} ms; 3 tamper attempts denied\n`);
    }
  });

  // Exploratory (env-gated, records outcomes, asserts nothing): where do Rules evaluation / document limits bite?
  it.runIf(process.env.W1_PREFIX_PROBE)('PROBE: outcome of one append at large N (recorded to W1_PREFIX_LOG)', async () => {
    for (const n of [6500, 7000, 7500, 8000]) {
      const old = big(n);
      let outcome: string;
      try {
        await seedShift(`P${n}`, old);
        try {
          await assertSucceeds(arrayUnionAppend(entry('Pp3sQe9wLm2PqRtUvXy9', { type: 'pay_in', amount: 2 }), `P${n}`));
          outcome = 'append ALLOWED';
          const cur = (await readShift(`P${n}`))!.cashEntries as Entry[];
          const tampered = cur.map((e, i) => (i === n - 1 ? { ...e, amount: (e.amount as number) + 1 } : e));
          try {
            await assertFails(writeList([...tampered, entry('Pq3sQe9wLm2PqRtUvXy9', { type: 'pay_in', amount: 2 })], `P${n}`));
            outcome += '; tamper of last old element DENIED';
          } catch {
            outcome += '; tamper of last old element NOT DENIED (!)';
          }
        } catch (err) {
          outcome = `append REJECTED: ${String((err as Error).message).slice(0, 160)}`;
        }
      } catch (err) {
        outcome = `seed failed (document limit): ${String((err as Error).message).slice(0, 120)}`;
      }
      appendFileSync(process.env.W1_PREFIX_LOG ?? 'probe.log', `PROBE N=${n}: ${outcome}\n`);
    }
  });
});
