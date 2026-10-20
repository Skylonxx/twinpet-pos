/**
 * closeShiftAuthoritative — REAL Firestore emulator tests (packet 012).
 *
 * Runs only under the Firestore emulator with the demo project:
 *   npx firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --root functions src/__tests__/closeShiftAuthoritative.emulator.test.ts"
 * Otherwise every test is skipped (the default Functions unit run has no emulator).
 *
 * Provenance: GREEN-only design-acceptance tests of the NEW callable core.
 * Every Return here is the PRODUCTION `performSubmitSaleReturn` transaction
 * (real PIN-approval primitive with an injected compare), every close is the
 * PRODUCTION `performCloseShiftAuthoritative`, both on the Admin SDK against
 * the emulator's `pos-db` database — no copied transaction body.
 */
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { FieldValue, Timestamp, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import type { performCloseShiftAuthoritative as PerformClose } from '../closeShiftAuthoritative';
import type { performSubmitSaleReturn as PerformReturn } from '../submitSaleReturn';
import { SHIFT_CLOSE_AUTHORITY_COLLECTION, type CloseShiftAuthoritativeSuccess } from '../closeShiftAuthoritativeCore';
import { deriveCashRefundEntryId, deriveReturnId } from '../saleReturnCore';
import { planCapture } from '../shiftCloseEvidenceCaptureCore';
import {
  parseCommittedOwnClose,
  shiftCloseConfirmationDocFromData,
  shiftCloseNormalizationDecision,
} from '../../../src/lib/pos/offline/shiftCloseReconciler';
import { snapshotsEqual } from '../../../src/lib/pos/offline/shiftCloseIntentStore';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT;
const RUN = Boolean(EMULATOR) && PROJECT === 'demo-twinpet';

type Doc = Record<string, unknown>;

const GOOD_PIN = '1234';
const DAY = 86_400_000;
const MATRIX = {
  admin: ['pos_sale', 'pos_discount', 'pos_void', 'pos_return', 'product_view'],
  manager: ['pos_sale', 'pos_discount', 'pos_void', 'pos_return', 'product_view'],
  staff: ['pos_sale', 'product_view'],
};
const UUID_A = '0f8c2a4e-5b6d-4c3e-9a1b-2c3d4e5f6a7b';
const UUID_B = '1f8c2a4e-5b6d-4c3e-9a1b-2c3d4e5f6a7c';

let db: Firestore;
let performClose: typeof PerformClose;
let performReturn: typeof PerformReturn;
let seq = 0;

function staffAuth(staffId = 's1', authVersion = 0, branchIds = ['B1'], role = 'staff') {
  return { uid: `u-${staffId}`, token: { role, staffId, branchIds, authVersion, permissions: ['pos_sale', 'product_view'] } };
}

const returnDeps = { comparePin: async (pin: string, hash: string) => pin === GOOD_PIN && hash === '$2b$10$realhash' };

function cred(): Doc {
  return {
    pinHash: '$2b$10$realhash',
    algo: 'bcrypt',
    cost: 10,
    credentialVersion: 1,
    credentialState: 'rotated_authoritative',
    disabled: false,
    updatedBy: 't',
  };
}

type World = { tag: string; shiftId: string; orderId: string; p1: string };

/** A settled cross-day cash sale (the submitSaleReturn fixture) + a W0-shaped open shift: startingCash 500. */
async function seedWorld(shiftOver: Doc = {}): Promise<World> {
  seq += 1;
  const tag = `t${seq}_${Date.now().toString(36)}`;
  const orderId = `O_${tag}`;
  const shiftId = `SH_${tag}`;
  const p1 = `P1_${tag}`;
  const p2 = `P2_${tag}`;
  const l1 = `L1_${tag}`;
  const l2 = `L2_${tag}`;
  const l3 = `L3_${tag}`;
  const batch = db.batch();
  batch.set(db.doc(`asyncOrders/${orderId}`), {
    id: orderId,
    billId: `R-${orderId}`,
    deviceId: 'dev1',
    branchId: 'B1',
    shiftId: 'SH-OLD',
    staffId: 's1',
    staffName: 'Staff One',
    customerId: null,
    customerSnap: { name: 'คุณลูกค้า', phone: '', taxId: null },
    lines: [
      {
        productId: p1,
        productSnap: { name: 'อาหารแมว', sku: 'CF' },
        unit: 'ถุง',
        unitFactor: 1,
        qty: 5,
        qtyBase: 5,
        unitPrice: 100,
        originalPrice: 100,
        discountAmt: 50,
        lineTotal: 450,
        fifoCost: 230,
        lotRefs: [
          { lotId: l1, qty: 3, cost: 40 },
          { lotId: l2, qty: 2, cost: 55 },
        ],
      },
      {
        productId: p2,
        productSnap: { name: 'ทราย', sku: 'SD' },
        unit: 'ลัง',
        unitFactor: 12,
        qty: 2,
        qtyBase: 24,
        unitPrice: 300,
        originalPrice: 300,
        discountAmt: 0,
        lineTotal: 600,
        fifoCost: 480,
        lotRefs: [{ lotId: l3, qty: 24, cost: 20 }],
      },
    ],
    payments: [{ method: 'cash', amount: 1000, ref: null }],
    subtotal: 1050,
    discountAmt: 50,
    billDiscount: 105,
    fee: 0,
    vatRate: 0,
    vatAmt: 0,
    total: 945,
    paidAmt: 1000,
    changeAmt: 55,
    creditAmt: 0,
    status: 'completed',
    reconcileStatus: 'settled',
    clientCreatedAt: Date.now() - 3 * DAY,
  });
  batch.set(db.doc(`orders/${orderId}`), { id: orderId, billId: `R-${orderId}`, branchId: 'B1', status: 'completed', total: 945, cogs: 710, profit: 340, historyRev: 1 });
  batch.set(db.doc(`stockLots/${l1}`), { id: l1, productId: p1, branchId: 'B1', costPerUnit: 40, qtyReceived: 3, qtyRemaining: 0, isDepleted: true });
  batch.set(db.doc(`stockLots/${l2}`), { id: l2, productId: p1, branchId: 'B1', costPerUnit: 55, qtyReceived: 10, qtyRemaining: 8, isDepleted: false });
  batch.set(db.doc(`stockLots/${l3}`), { id: l3, productId: p2, branchId: 'B1', costPerUnit: 20, qtyReceived: 24, qtyRemaining: 0, isDepleted: true });
  batch.set(db.doc(`products/${p1}`), { id: p1, cost: 999, avgCost: 888 });
  batch.set(db.doc(`products/${p1}/productStocks/B1`), { branchId: 'B1', totalStockBase: 8 });
  batch.set(db.doc(`shifts/${shiftId}`), {
    id: shiftId,
    branchId: 'B1',
    staffId: 's1',
    staffName: 'Staff One',
    status: 'open',
    openedAt: Timestamp.fromMillis(Date.now() - DAY),
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
    ...shiftOver,
  });
  await batch.commit();
  return { tag, shiftId, orderId, p1 };
}

function returnReq(w: World, attempt: string): Doc {
  return {
    attemptId: `attempt-${attempt}-${w.tag}`,
    orderId: w.orderId,
    branchId: 'B1',
    lines: [{ lineIndex: 0, productId: w.p1, qty: 1 }],
    refundMethod: 'cash',
    refundReference: '',
    reason: 'สินค้าชำรุด',
    expectedRefundAmount: 81,
    shiftId: w.shiftId,
    approverStaffId: 'm1',
    pin: GOOD_PIN,
  };
}

function closeReq(w: World, over: Doc = {}, sales: Doc = {}): Doc {
  return {
    contractVersion: 1,
    shiftId: w.shiftId,
    closeCorrelationId: UUID_A,
    actualCashCount: 1419,
    note: 'ปิดกะ',
    attestedSales: { expectedCash: 1000, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0, totalBills: 3, ...sales },
    deviceId: 'dev-1',
    ...over,
  };
}

async function runReturn(w: World, attempt = 'a1') {
  return performReturn(db, returnReq(w, attempt), staffAuth(), returnDeps);
}

function okClose(r: Awaited<ReturnType<typeof PerformClose>>): CloseShiftAuthoritativeSuccess {
  if (!r.ok) throw new Error(`close refused: ${r.code}`);
  return r;
}

type Frozen = { exists: boolean; updateTime: string | null; data: Doc | undefined };

async function freeze(paths: string[]): Promise<Record<string, Frozen>> {
  const snaps = await db.getAll(...paths.map((p) => db.doc(p)));
  const out: Record<string, Frozen> = {};
  snaps.forEach((s: DocumentSnapshot, i) => {
    out[paths[i]!] = { exists: s.exists, updateTime: s.updateTime ? s.updateTime.valueOf() : null, data: s.data() };
  });
  return out;
}

async function refundPaths(w: World, attempt = 'a1'): Promise<string[]> {
  const returnId = deriveReturnId('B1', w.orderId, `attempt-${attempt}-${w.tag}`);
  return [`saleRefunds/${returnId}`, `saleReturns/${returnId}`, `cashTransactions/${deriveCashRefundEntryId(returnId)}`];
}

function closeOwnIdentity(w: World, deviceId = 'dev-1', correlation = UUID_A) {
  return { shiftId: w.shiftId, branchId: 'B1', staffId: 's1', staffName: 'Staff One', deviceId, closeCorrelationId: correlation };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Race observations, also appended to $CLOSE_RACE_EVIDENCE_FILE when set (evidence kept outside Git). */
function observe(line: string): void {
  console.info(line);
  const file = process.env.CLOSE_RACE_EVIDENCE_FILE;
  if (file) appendFileSync(file, `${new Date().toISOString()} ${line}
`);
}

describe.skipIf(!RUN)('closeShiftAuthoritative on the Firestore emulator (demo-twinpet / pos-db)', () => {
  beforeAll(async () => {
    // Never a production project: emulator host + demo project id are both required.
    expect(EMULATOR).toBeTruthy();
    expect(PROJECT).toBe('demo-twinpet');
    ({ db } = await import('../db'));
    ({ performCloseShiftAuthoritative: performClose } = await import('../closeShiftAuthoritative'));
    ({ performSubmitSaleReturn: performReturn } = await import('../submitSaleReturn'));
    expect(db.databaseId).toBe('pos-db');
    const res = await fetch(`http://${EMULATOR}/emulator/v1/projects/demo-twinpet/databases/pos-db/documents`, { method: 'DELETE' });
    expect(res.ok).toBe(true);
  });

  beforeEach(async () => {
    const batch = db.batch();
    batch.set(db.doc('users/s1'), { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['B1'], firstName: 'Staff', lastName: 'One' });
    batch.set(db.doc('users/s2'), { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: ['B1'], firstName: 'Staff', lastName: 'Two' });
    batch.set(db.doc('users/m1'), { isActive: true, deletedAt: null, authVersion: 0, role: 'manager', branchIds: ['B1'], firstName: 'Mana', lastName: 'Ger' });
    batch.set(db.doc('users/a1'), { isActive: true, deletedAt: null, authVersion: 0, role: 'admin', branchIds: ['ALL'], firstName: 'Ad', lastName: 'Min' });
    batch.set(db.doc('userCredentials/m1'), cred());
    batch.set(db.doc('settings/_rolePermissions'), { rolePermissions: MATRIX });
    await batch.commit();
  });

  afterAll(async () => {
    if (!RUN) return;
    await fetch(`http://${EMULATOR}/emulator/v1/projects/demo-twinpet/databases/pos-db/documents`, { method: 'DELETE' }).catch(() => undefined);
  });

  // ── 1 · honest close + 8 · client compatibility ─────────────────────────
  test('honest close: 500 + sale cash 1000 − real Return 81 ⇒ drawer 1419, count 1419 ⇒ variance 0; canonical + client-compatible', async () => {
    const w = await seedWorld();
    const ret = await runReturn(w);
    expect(ret).toMatchObject({ ok: true, refundAmount: 81, refundMethod: 'cash' });

    const res = okClose(await performClose(db, closeReq(w), staffAuth()));
    expect(res.idempotentReplay).toBe(false);
    expect(res.money).toMatchObject({ startingCashMinor: 50000, expectedCashMinor: 100000, payOutMinor: 8100, payInMinor: 0, expectedDrawerMinor: 141900, actualCashCountMinor: 141900, varianceMinor: 0 });
    expect(res.snapshot).toMatchObject({ shiftId: w.shiftId, branchId: 'B1', staffId: 's1', startingCash: 500, expectedCash: 1000, payOutTotal: 81, payInTotal: 0, totalBills: 3, actualCashCount: 1419, variance: 0, note: 'ปิดกะ', deviceId: 'dev-1' });
    expect(res.provenance.returnRefunds).toEqual({ status: 'server_audit_matched', count: 1, totalMinor: 8100 });
    expect(res.provenance.salesTotals.status).toBe('attested_unverified');
    expect(res.provenance.clientJournal).toBe('not_finalized_by_server');

    const shiftSnap = await db.doc(`shifts/${w.shiftId}`).get();
    const shift = shiftSnap.data()!;
    expect(shift).toMatchObject({ status: 'closed', closedOffline: true, syncState: 'pending', deviceId: 'dev-1', closeCorrelationId: UUID_A, payOutTotal: 81, variance: 0 });
    expect(shift.closedAt).toBeInstanceOf(Timestamp);
    expect((shift.closedAt as Timestamp).toMillis()).toBe(res.closedAtMillis);
    // No server-only field leaks onto the shift doc.
    expect(Object.keys(shift).sort()).toEqual(
      [
        'id', 'branchId', 'staffId', 'staffName', 'status', 'openedAt', 'closedAt', 'startingCash', 'actualCashCount',
        'expectedCash', 'expectedQr', 'expectedKbank', 'expectedCard', 'expectedCredit', 'totalBills', 'payInTotal',
        'payOutTotal', 'variance', 'note', 'cashEntries', 'updatedAt', 'closedOffline', 'syncState', 'deviceId', 'closeCorrelationId',
      ].sort(),
    );
    const record = (await db.doc(`${SHIFT_CLOSE_AUTHORITY_COLLECTION}/${w.shiftId}`).get()).data()!;
    expect(record).toMatchObject({ closeProtocol: 'server_authoritative_v1', closedByStaffId: 's1', closeCorrelationId: UUID_A });
    expect((record.closedAt as Timestamp).toMillis()).toBe(res.closedAtMillis);

    // Client strict proof (actual source): accepts, and equals the response snapshot.
    const parsed = parseCommittedOwnClose(closeOwnIdentity(w), shiftCloseConfirmationDocFromData(shift));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(snapshotsEqual(parsed.snapshot, res.snapshot)).toBe(true);
      expect(parsed.closedAt.getTime()).toBe(res.closedAtMillis);
    }
    // P5 evidence capture (actual planner) captures this W3.
    expect(planCapture({ shiftId: w.shiftId, before: { ...shift, status: 'open' }, after: shift, eventTimeIso: new Date().toISOString() }).kind).toBe('capture');
    // Follow-on W4 (client decision) is possible; after it, the canonical replay is unchanged.
    expect(shiftCloseNormalizationDecision(shift, { closeCorrelationId: UUID_A, deviceId: 'dev-1' })).toBe('write');
    await db.doc(`shifts/${w.shiftId}`).update({ syncState: 'synced' });
    const replay = okClose(await performClose(db, closeReq(w), staffAuth()));
    expect({ ...replay, idempotentReplay: false }).toEqual(res);
  });

  // ── 2 · client totals never control the close ──────────────────────────
  test('fake client payOutTotal / variance / stale totals are rejected outright with zero writes', async () => {
    const w = await seedWorld();
    await runReturn(w);
    const paths = [`shifts/${w.shiftId}`, `${SHIFT_CLOSE_AUTHORITY_COLLECTION}/${w.shiftId}`, ...(await refundPaths(w))];
    const before = await freeze(paths);
    for (const extra of [{ payOutTotal: 0 }, { variance: 0 }, { payInTotal: 81 }, { startingCash: 9999 }, { branchId: 'B2' }, { staffId: 's2' }, { pin: '1234' }, { approverStaffId: 'm1' }]) {
      expect(await performClose(db, closeReq(w, extra), staffAuth())).toEqual({ ok: false, code: 'invalid_request' });
    }
    expect(await performClose(db, closeReq(w, { actualCashCount: 'NaN' }), staffAuth())).toEqual({ ok: false, code: 'invalid_request' });
    expect(await freeze(paths)).toEqual(before);
  });

  test('a client that "forgets" the Return still gets the server payout: count 1500 at payOut 81 ⇒ variance +81, not 0', async () => {
    const w = await seedWorld();
    await runReturn(w);
    const res = okClose(await performClose(db, closeReq(w, { actualCashCount: 1500 }), staffAuth()));
    expect(res.snapshot.payOutTotal).toBe(81);
    expect(res.money.varianceMinor).toBe(8100);
  });

  // ── 3 · refund audit mismatches refuse with zero writes ─────────────────
  describe('tampered / inconsistent refund evidence ⇒ refuse, zero writes', () => {
    const tamper: Array<[string, (w: World, rid: string) => Promise<void>, string]> = [
      [
        'payout removed from the shift list',
        async (w) => db.doc(`shifts/${w.shiftId}`).update({ cashEntries: [] }).then(() => undefined),
        'refund_missing_in_shift',
      ],
      [
        'payout amount rewritten to 80 satang-exact',
        async (w) => {
          const e = ((await db.doc(`shifts/${w.shiftId}`).get()).data()!.cashEntries as Doc[])[0]!;
          await db.doc(`shifts/${w.shiftId}`).update({ cashEntries: [{ ...e, amount: 80 }] });
        },
        'refund_entry_mismatch',
      ],
      [
        'duplicate rfd_ entry',
        async (w) => {
          const e = ((await db.doc(`shifts/${w.shiftId}`).get()).data()!.cashEntries as Doc[])[0]!;
          await db.doc(`shifts/${w.shiftId}`).update({ cashEntries: [e, { ...e }] });
        },
        'cash_entry_duplicate',
      ],
      [
        'orphan fake rfd_ entry',
        async (w) => {
          const e = ((await db.doc(`shifts/${w.shiftId}`).get()).data()!.cashEntries as Doc[])[0]!;
          await db.doc(`shifts/${w.shiftId}`).update({ cashEntries: [e, { ...e, id: 'rfd_' + 'f'.repeat(40), amount: 5 }] });
        },
        'orphan_refund_entry',
      ],
      ['saleReturns record missing', async (_w, rid) => db.doc(`saleReturns/${rid}`).delete().then(() => undefined), 'refund_return_mismatch'],
      ['saleRefunds record missing', async (_w, rid) => db.doc(`saleRefunds/${rid}`).delete().then(() => undefined), 'refund_return_mismatch'],
      ['saleRefunds vs saleReturns amount mismatch', async (_w, rid) => db.doc(`saleReturns/${rid}`).update({ 'refund.amount': 80 }).then(() => undefined), 'refund_return_mismatch'],
      ['refund record on another branch', async (_w, rid) => db.doc(`saleRefunds/${rid}`).update({ branchId: 'B2' }).then(() => undefined), 'refund_record_invalid'],
      [
        'server refund moved to another shift (wrong shift)',
        async (_w, rid) => {
          await db.doc(`saleRefunds/${rid}`).update({ shiftId: 'SH-OTHER' });
          await db.doc(`saleReturns/${rid}`).update({ 'refund.shiftId': 'SH-OTHER' });
        },
        'orphan_refund_entry',
      ],
      [
        'second server refund for the shift never paid out (missing payout)',
        async (w, rid) => {
          const fake = 'e'.repeat(40);
          const r = (await db.doc(`saleRefunds/${rid}`).get()).data()!;
          const t = (await db.doc(`saleReturns/${rid}`).get()).data()!;
          await db.doc(`saleRefunds/${fake}`).set({ ...r, refundId: fake, returnId: fake, cashEntryId: deriveCashRefundEntryId(fake), shiftId: w.shiftId });
          await db.doc(`saleReturns/${fake}`).set({ ...t, returnId: fake, refund: { ...(t.refund as Doc), refundId: fake, cashEntryId: deriveCashRefundEntryId(fake) } });
        },
        'refund_missing_in_shift',
      ],
      ['corrupted cash list (non-list)', async (w) => db.doc(`shifts/${w.shiftId}`).update({ cashEntries: 'x' }).then(() => undefined), 'cash_entries_invalid'],
    ];

    test.each(tamper)('%s ⇒ %s', async (_name, mutate, code) => {
      const w = await seedWorld();
      expect((await runReturn(w)).ok).toBe(true);
      const rid = deriveReturnId('B1', w.orderId, `attempt-a1-${w.tag}`);
      await mutate(w, rid);
      const paths = [
        `shifts/${w.shiftId}`,
        `${SHIFT_CLOSE_AUTHORITY_COLLECTION}/${w.shiftId}`,
        `saleRefunds/${rid}`,
        `saleReturns/${rid}`,
        `saleRefunds/${'e'.repeat(40)}`,
        `saleReturns/${'e'.repeat(40)}`,
      ];
      const before = await freeze(paths);
      expect(await performClose(db, closeReq(w), staffAuth())).toEqual({ ok: false, code });
      expect(await freeze(paths)).toEqual(before);
      // cleanup the shared fake id for the next case
      await db.doc(`saleRefunds/${'e'.repeat(40)}`).delete();
      await db.doc(`saleReturns/${'e'.repeat(40)}`).delete();
    });

    test('an unreadable / failed refund query ⇒ refund_audit_unavailable, zero writes', async () => {
      const w = await seedWorld();
      await runReturn(w);
      const paths = [`shifts/${w.shiftId}`, `${SHIFT_CLOSE_AUTHORITY_COLLECTION}/${w.shiftId}`];
      const before = await freeze(paths);
      // Real db; only a transactional QUERY read is made to fail (non-retryable).
      const failingQueries = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'runTransaction') {
            return (fn: (tx: unknown) => Promise<unknown>) =>
              target.runTransaction((tx) =>
                fn(
                  new Proxy(tx, {
                    get(t, p) {
                      if (p === 'get') {
                        return (ref: unknown) =>
                          ref && typeof ref === 'object' && 'where' in (ref as object) && !('path' in (ref as object))
                            ? Promise.reject(Object.assign(new Error('index missing'), { code: 9 }))
                            : (t as unknown as { get: (r: unknown) => Promise<unknown> }).get(ref);
                      }
                      const v = (t as unknown as Record<string | symbol, unknown>)[p];
                      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
                    },
                  }),
                ),
              );
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      expect(await performClose(failingQueries, closeReq(w), staffAuth())).toEqual({ ok: false, code: 'refund_audit_unavailable' });
      expect(await freeze(paths)).toEqual(before);
    });
  });

  // ── 4 · Return vs close ordering and races ─────────────────────────────
  test('close first, then Return ⇒ Return refused (shift_required), no refund, stock untouched', async () => {
    const w = await seedWorld();
    const res = okClose(await performClose(db, closeReq(w, { actualCashCount: 1500 }), staffAuth()));
    expect(res.snapshot.payOutTotal).toBe(0);
    const lotBefore = await freeze([`stockLots/L1_${w.tag}`, `stockLots/L2_${w.tag}`]);
    expect(await runReturn(w)).toEqual({ ok: false, code: 'shift_required' });
    expect(await freeze(await refundPaths(w))).toEqual(
      Object.fromEntries((await refundPaths(w)).map((p) => [p, { exists: false, updateTime: null, data: undefined }])),
    );
    expect(await freeze([`stockLots/L1_${w.tag}`, `stockLots/L2_${w.tag}`])).toEqual(lotBefore);
  });

  test('Return committed WHILE the close transaction is in flight ⇒ serialized: never a lost payout', async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const w = await seedWorld();
      let returnPromise: ReturnType<typeof runReturn> | undefined;
      const attempts: number[] = [];
      const closePromise = performClose(db, closeReq(w), staffAuth(), {
        afterShiftRead: async (attempt) => {
          attempts.push(attempt);
          if (attempt === 1) {
            returnPromise = runReturn(w);
            await Promise.race([returnPromise, sleep(1500)]);
          }
        },
      });
      const close = await closePromise;
      const ret = await returnPromise!;
      const shift = (await db.doc(`shifts/${w.shiftId}`).get()).data()!;
      const entries = (shift.cashEntries ?? []) as Doc[];
      if (ret.ok) {
        // Return first ⇒ the committed close MUST include its payout.
        const c = okClose(close);
        expect(c.snapshot.payOutTotal).toBe(81);
        expect(c.money.varianceMinor).toBe(0);
        expect(entries.map((e) => e.id)).toEqual([deriveCashRefundEntryId(ret.returnId)]);
        expect(attempts.length).toBeGreaterThan(1);
        outcomes.push(`return_first(attempts=${attempts.length})`);
      } else {
        // Close first ⇒ Return refused, no payout anywhere.
        expect(ret).toEqual({ ok: false, code: 'shift_required' });
        const c = okClose(close);
        expect(c.snapshot.payOutTotal).toBe(0);
        expect(entries).toEqual([]);
        outcomes.push(`close_first(attempts=${attempts.length})`);
      }
      expect(shift.status).toBe('closed');
      expect(shift.payOutTotal).toBe(entries.reduce((s, e) => s + (e.amount as number), 0));
    }
    observe(`[emulator race] in-flight orderings observed: ${outcomes.join(', ')}`);
  }, 90_000);

  test('fully concurrent Return + close (both orderings possible) ⇒ consistent drawer every time', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const w = await seedWorld();
      const [ret, close] = await Promise.all([runReturn(w), performClose(db, closeReq(w), staffAuth())]);
      const shift = (await db.doc(`shifts/${w.shiftId}`).get()).data()!;
      const c = okClose(close);
      if (ret.ok) {
        expect(c.snapshot.payOutTotal).toBe(81);
        seen.add('return_first');
      } else {
        expect(ret).toEqual({ ok: false, code: 'shift_required' });
        expect(c.snapshot.payOutTotal).toBe(0);
        seen.add('close_first');
      }
      expect(shift.payOutTotal).toBe(c.snapshot.payOutTotal);
      expect(((shift.cashEntries ?? []) as Doc[]).length).toBe(ret.ok ? 1 : 0);
    }
    observe(`[emulator race] concurrent orderings observed: ${[...seen].join(', ')}`);
  }, 90_000);

  test('close requested while the Return transaction is in flight ⇒ serialized; the payout is never lost', async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const w = await seedWorld();
      const retPromise = runReturn(w);
      // The approval doc is minted immediately before the Return transaction starts.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const q = await db.collection('managerApprovals').where('targetEntityId', '==', w.orderId).limit(1).get();
        if (!q.empty) break;
        await sleep(2);
      }
      const attempts: number[] = [];
      const close = await performClose(db, closeReq(w), staffAuth(), { afterShiftRead: (a) => void attempts.push(a) });
      const ret = await retPromise;
      const shift = (await db.doc(`shifts/${w.shiftId}`).get()).data()!;
      const entries = (shift.cashEntries ?? []) as Doc[];
      const c = okClose(close);
      if (ret.ok) {
        expect(c.snapshot.payOutTotal).toBe(81);
        expect(c.money.varianceMinor).toBe(0);
        expect(entries.map((e) => e.id)).toEqual([deriveCashRefundEntryId(ret.returnId)]);
        outcomes.push(`return_first(closeAttempts=${attempts.length})`);
      } else {
        expect(ret).toEqual({ ok: false, code: 'shift_required' });
        expect(c.snapshot.payOutTotal).toBe(0);
        expect(entries).toEqual([]);
        outcomes.push(`close_first(closeAttempts=${attempts.length})`);
      }
      expect(shift.payOutTotal).toBe(c.snapshot.payOutTotal);
    }
    observe(`[emulator race] close-during-Return orderings observed: ${outcomes.join(', ')}`);
  }, 90_000);

  test('a conflicting shift write during the close transaction ⇒ the close re-runs and folds it (retry observed or serialized after)', async () => {
    const w = await seedWorld();
    await runReturn(w);
    const attempts: number[] = [];
    let writePromise: Promise<unknown> | undefined;
    const close = await performClose(db, closeReq(w, { actualCashCount: 1424 }), staffAuth(), {
      afterShiftRead: async (attempt) => {
        attempts.push(attempt);
        if (attempt === 1) {
          // A legitimate concurrent W1-style append of a manual pay-in (5 THB).
          writePromise = db.doc(`shifts/${w.shiftId}`).update({
            cashEntries: FieldValue.arrayUnion({ id: 'c-late', type: 'pay_in', amount: 5, note: 'x', staffId: 's1', staffName: 'Staff One', at: 1 }),
          });
          await Promise.race([writePromise, sleep(1500)]);
        }
      },
    });
    await writePromise!.catch(() => undefined);
    const shift = (await db.doc(`shifts/${w.shiftId}`).get()).data()!;
    const c = okClose(close);
    const ids = ((shift.cashEntries ?? []) as Doc[]).map((e) => e.id);
    if (attempts.length > 1) {
      // The write landed first: the close re-ran on the fresh doc and folded it.
      expect(c.money.payInMinor).toBe(500);
      expect(c.money.varianceMinor).toBe(0);
      observe(`[emulator race] conflicting write ⇒ close retried (attempts=${attempts.length})`);
    } else {
      // The emulator serialized the plain write AFTER the close commit (lock wait):
      // the close never saw it; the drawer it froze is internally consistent.
      expect(c.money.payInMinor).toBe(0);
      observe('[emulator race] conflicting write ⇒ serialized after the close (attempts=1)');
    }
    expect(ids).toContain(deriveCashRefundEntryId(deriveReturnId('B1', w.orderId, `attempt-a1-${w.tag}`)));
  }, 90_000);

  // ── 5 · idempotency ────────────────────────────────────────────────────
  test('same UUID repeated / lost response ⇒ same canonical close, no second W3; concurrent duplicates ⇒ one close', async () => {
    const w = await seedWorld();
    await runReturn(w);
    const attemptsA: number[] = [];
    const attemptsB: number[] = [];
    const [a, b] = await Promise.all([
      performClose(db, closeReq(w), staffAuth(), { afterShiftRead: (n) => void attemptsA.push(n) }),
      performClose(db, closeReq(w), staffAuth(), { afterShiftRead: (n) => void attemptsB.push(n) }),
    ]);
    observe(`[emulator race] duplicate same-UUID closes: attempts A=${attemptsA.length} B=${attemptsB.length}`);
    const ra = okClose(a);
    const rb = okClose(b);
    expect([ra.idempotentReplay, rb.idempotentReplay].sort()).toEqual([false, true]);
    expect(rb.snapshot).toEqual(ra.snapshot);
    expect(rb.closedAtMillis).toBe(ra.closedAtMillis);
    const paths = [`shifts/${w.shiftId}`, `${SHIFT_CLOSE_AUTHORITY_COLLECTION}/${w.shiftId}`, ...(await refundPaths(w))];
    const frozen = await freeze(paths);
    const again = okClose(await performClose(db, closeReq(w), staffAuth()));
    expect(again.idempotentReplay).toBe(true);
    expect(again.snapshot).toEqual(ra.snapshot);
    expect(await freeze(paths)).toEqual(frozen);
  }, 90_000);

  test('different UUID ⇒ already_closed; same UUID other content/device ⇒ idempotency_conflict; nothing written', async () => {
    const w = await seedWorld();
    okClose(await performClose(db, closeReq(w), staffAuth()));
    const paths = [`shifts/${w.shiftId}`, `${SHIFT_CLOSE_AUTHORITY_COLLECTION}/${w.shiftId}`];
    const frozen = await freeze(paths);
    expect(await performClose(db, closeReq(w, { closeCorrelationId: UUID_B }), staffAuth())).toEqual({ ok: false, code: 'already_closed' });
    expect(await performClose(db, closeReq(w, { actualCashCount: 1 }), staffAuth())).toEqual({ ok: false, code: 'idempotency_conflict' });
    expect(await performClose(db, closeReq(w, { deviceId: 'other-device' }), staffAuth())).toEqual({ ok: false, code: 'idempotency_conflict' });
    expect(await freeze(paths)).toEqual(frozen);
  });

  test('shift closed by a direct client W3 with the same UUID ⇒ closed_outside_authority (never server-verified)', async () => {
    const w = await seedWorld();
    await db.doc(`shifts/${w.shiftId}`).update({
      status: 'closed', closedAt: Timestamp.now(), actualCashCount: 1419, variance: 0, note: '', expectedCash: 1000,
      payInTotal: 0, payOutTotal: 0, closedOffline: true, syncState: 'pending', deviceId: 'dev-1', closeCorrelationId: UUID_A,
    });
    const frozen = await freeze([`shifts/${w.shiftId}`, `${SHIFT_CLOSE_AUTHORITY_COLLECTION}/${w.shiftId}`]);
    expect(await performClose(db, closeReq(w), staffAuth())).toEqual({ ok: false, code: 'closed_outside_authority' });
    expect(await freeze([`shifts/${w.shiftId}`, `${SHIFT_CLOSE_AUTHORITY_COLLECTION}/${w.shiftId}`])).toEqual(frozen);
  });

  // ── 5/6 · authority: owner + fresh live branch only ────────────────────
  test.each([
    ['unauthenticated', null, 'unauthenticated'],
    ['token without staffId', { uid: 'x', token: {} }, 'unauthenticated'],
    ['other staff of the same branch (not owner)', staffAuth('s2'), 'not_shift_owner'],
    ['branch manager, not owner, no override', staffAuth('m1', 0, ['B1'], 'manager'), 'not_shift_owner'],
    ['admin ALL, not owner', staffAuth('a1', 0, ['ALL'], 'admin'), 'not_shift_owner'],
    ['stale authVersion', staffAuth('s1', 5), 'session_stale'],
    ['forged token claims for an unknown staff', staffAuth('ghost'), 'not_authorized'],
  ])('%s ⇒ %s, no close', async (_n, auth, code) => {
    const w = await seedWorld();
    const paths = [`shifts/${w.shiftId}`, `${SHIFT_CLOSE_AUTHORITY_COLLECTION}/${w.shiftId}`];
    const frozen = await freeze(paths);
    expect(await performClose(db, closeReq(w), auth as never)).toEqual({ ok: false, code });
    expect(await freeze(paths)).toEqual(frozen);
  });

  test.each([
    ['inactive staff', { isActive: false }, 'not_authorized'],
    ['deleted staff', { deletedAt: Timestamp.now() }, 'not_authorized'],
    ['revoked branch', { branchIds: ['B2'] }, 'branch_not_authorized'],
    ['bumped authVersion (revoked session)', { authVersion: 1 }, 'session_stale'],
    ['role removed', { role: 'none' }, 'not_authorized'],
  ])('%s (live user doc) ⇒ %s, no close', async (_n, userOver, code) => {
    const w = await seedWorld();
    await db.doc('users/s1').set(userOver, { merge: true });
    const paths = [`shifts/${w.shiftId}`, `${SHIFT_CLOSE_AUTHORITY_COLLECTION}/${w.shiftId}`];
    const frozen = await freeze(paths);
    expect(await performClose(db, closeReq(w), staffAuth())).toEqual({ ok: false, code });
    expect(await freeze(paths)).toEqual(frozen);
  });

  test('informational deviceId never authorizes: the owner closes from any device id; a foreign staff with the owner device id cannot', async () => {
    const w = await seedWorld();
    expect(await performClose(db, closeReq(w, { deviceId: 'dev-1' }), staffAuth('s2'))).toEqual({ ok: false, code: 'not_shift_owner' });
    const res = okClose(await performClose(db, closeReq(w, { deviceId: 'brand-new-terminal' }), staffAuth()));
    expect(res.snapshot.deviceId).toBe('brand-new-terminal');
  });

  test('missing shift / foreign-branch shift / non-open state are refused', async () => {
    expect(await performClose(db, closeReq({ shiftId: 'nope', tag: 'x', orderId: 'x', p1: 'x' }), staffAuth())).toEqual({ ok: false, code: 'shift_not_found' });
    const foreign = await seedWorld({ branchId: 'B2' });
    expect(await performClose(db, closeReq(foreign), staffAuth())).toEqual({ ok: false, code: 'branch_not_authorized' });
    const weird = await seedWorld({ status: 'suspended' });
    expect(await performClose(db, closeReq(weird), staffAuth())).toEqual({ ok: false, code: 'shift_state_invalid' });
    const malformed = await seedWorld({ startingCash: 0.001 });
    expect(await performClose(db, closeReq(malformed), staffAuth())).toEqual({ ok: false, code: 'shift_record_invalid' });
  });

  // ── 7 · pathological lists ─────────────────────────────────────────────
  test('pathological cash lists (over cap, malformed, nullable) refuse with zero writes', async () => {
    for (const [cashEntries, code] of [
      [Array.from({ length: 1001 }, (_, i) => ({ id: `c${i}`, type: 'pay_in', amount: 1 })), 'cash_entries_over_cap'],
      [[{ id: 'c1', type: 'pay_in', amount: 0.001 }], 'cash_entries_invalid'],
      [[null], 'cash_entries_invalid'],
      [null, 'cash_entries_invalid'],
      [[{ id: 'c1', type: 'pay_in', amount: 1 }, { id: 'c1', type: 'pay_out', amount: 1 }], 'cash_entry_duplicate'],
    ] as const) {
      const w = await seedWorld({ cashEntries });
      const paths = [`shifts/${w.shiftId}`, `${SHIFT_CLOSE_AUTHORITY_COLLECTION}/${w.shiftId}`];
      const frozen = await freeze(paths);
      expect(await performClose(db, closeReq(w), staffAuth())).toEqual({ ok: false, code });
      expect(await freeze(paths)).toEqual(frozen);
    }
  });

  test('manual pay-in/out entries fold in integer satang next to the Return payout', async () => {
    const w = await seedWorld({ cashEntries: [{ id: 'c1', type: 'pay_in', amount: 0.1 }, { id: 'c2', type: 'pay_in', amount: 0.2 }, { id: 'c3', type: 'pay_out', amount: 10 }] });
    await runReturn(w);
    // drawer = 500 + 1000 + 0.30 − 10 − 81 = 1409.30
    const res = okClose(await performClose(db, closeReq(w, { actualCashCount: 1409.3 }), staffAuth()));
    expect(res.money).toMatchObject({ payInMinor: 30, payOutMinor: 9100, expectedDrawerMinor: 140930, varianceMinor: 0 });
    expect(res.provenance.manualCashEntries).toEqual({ status: 'shift_recorded_unattested', count: 3, payInMinor: 30, payOutMinor: 1000 });
    const shift = (await db.doc(`shifts/${w.shiftId}`).get()).data()!;
    const parsed = parseCommittedOwnClose(closeOwnIdentity(w), shiftCloseConfirmationDocFromData(shift));
    expect(parsed.ok).toBe(true);
  });
});
