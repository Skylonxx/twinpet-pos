/**
 * Return/Refund V1 packet 015 — F1/F2 on the REAL Firestore emulator (named
 * database `pos-db`, project `demo-twinpet`, CURRENT UNSEALED Rules, no live data).
 *
 *   forged W3   a Rules-authenticated staff CLIENT (`mockUserToken`, Rules from
 *               firebase.json) writes a direct W3 with the saved attempt UUID and
 *               the OLD expected totals after a REAL cash Return — accepted by the
 *               unsealed Rules, with no `shiftCloseAuthorityRecords` document;
 *   Return      the PRODUCTION `performSubmitSaleReturn` transaction (Admin SDK,
 *               PIN primitive with an injected compare) — not a copied body;
 *   callable    the PRODUCTION `performCloseShiftAuthoritative` invoked IN-PROCESS
 *               (request / response JSON round-tripped). The Functions HTTPS
 *               transport itself is NOT exercised (no Functions emulator);
 *   client      the PRODUCTION `closeShift` (gate injected ON) and the PRODUCTION
 *               recovery sweep (`runShiftCloseReconciliationSweep` with the real
 *               `readShiftCloseConfirmation` / `normalizeShiftCloseSyncState`)
 *               over a real fake-IndexedDB journal. A "restart" / "second window"
 *               is a fresh journal instance over the same database.
 *
 * Provenance: only parent-existing symbols are imported (the 015 deps are passed
 * by name and the witness builder is looked up lazily), so on a844855 the forged-W3
 * cases fail on BEHAVIOUR (a Z is minted from the forged doc).
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/shift-close-authoritative-recovery.spec.ts"
 * Skips unless FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT=demo-twinpet are set.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import * as clientFs from 'firebase/firestore';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const RUN = Boolean(EMULATOR) && process.env.GCLOUD_PROJECT === 'demo-twinpet';

const env = vi.hoisted(() => ({ db: undefined as unknown, updateDocCalls: [] as unknown[] }));

vi.mock('../src/lib/firebase', () => ({
  isFirebaseConfigured: true,
  get db() {
    return env.db;
  },
  collections: { shifts: 'shifts', cashTransactions: 'cashTransactions' },
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    // Tripwire: the server-authoritative close must never updateDoc the shift itself.
    updateDoc: (...args: Parameters<typeof actual.updateDoc>) => {
      env.updateDocCalls.push(args[0]);
      return actual.updateDoc(...args);
    },
  };
});

vi.mock('../src/lib/pos/deviceId', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/pos/deviceId')>()),
  getDeviceId: () => 'DEV1',
}));

import * as authClient from '../src/lib/pos/shiftCloseAuthoritativeClient';
import { authoritativeCloseRequest } from '../src/lib/pos/shiftCloseAuthoritativeClient';
import {
  closeShift,
  normalizeShiftCloseSyncState,
  readShiftCloseConfirmation,
  type CloseShiftDeps,
} from '../src/lib/pos/shiftService';
import { runShiftCloseReconciliationSweep, shiftCloseNormalizationIssue } from '../src/lib/pos/offline/shiftCloseReconciler';
import { deriveShiftDrawer } from '../src/lib/pos/shiftLedger';
import {
  SHIFT_CLOSE_INTENT_DB_NAME,
  createShiftCloseIntentJournal,
  type ShiftCloseIntentJournal,
} from '../src/lib/pos/offline/shiftCloseIntentStore';
import type { LocalSale } from '../src/lib/pos/localLedger';
import type { Shift } from '../src/lib/types';

type Doc = Record<string, unknown>;
type AdminDb = {
  doc: (p: string) => {
    set: (d: Doc) => Promise<unknown>;
    get: () => Promise<{ exists: boolean; data: () => Doc | undefined }>;
    update: (d: Doc) => Promise<unknown>;
  };
  batch: () => { set: (ref: unknown, d: Doc) => unknown; commit: () => Promise<unknown> };
};
type PerformClose = (db: unknown, req: unknown, auth: unknown) => Promise<unknown>;
type PerformReturn = (db: unknown, req: unknown, auth: unknown, deps: unknown) => Promise<unknown>;

let adminDb: AdminDb;
let performClose: PerformClose;
let performReturn: PerformReturn;
let app: FirebaseApp;
let clientDb: clientFs.Firestore;
let seq = 0;

const STAFF = 's1';
const BRANCH = 'B1';
const DAY = 86_400_000;
const GOOD_PIN = '1234';
const AUTH = { uid: `u-${STAFF}`, token: { staffId: STAFF, role: 'staff', branchIds: [BRANCH], authVersion: 0, permissions: ['pos_sale', 'product_view'] } };
const MATRIX = {
  admin: ['pos_sale', 'pos_discount', 'pos_void', 'pos_return', 'product_view'],
  manager: ['pos_sale', 'pos_discount', 'pos_void', 'pos_return', 'product_view'],
  staff: ['pos_sale', 'product_view'],
};
const returnDeps = { comparePin: async (pin: string, hash: string) => pin === GOOD_PIN && hash === '$2b$10$realhash' };

const describeEmu = RUN ? describe : describe.skip;

describeEmu('015 recovery safety ⇄ closeShiftAuthoritative on the Firestore emulator (demo-twinpet / pos-db, unsealed Rules)', () => {
  beforeAll(async () => {
    adminDb = ((await import('../functions/src/db')) as unknown as { db: AdminDb }).db;
    performClose = ((await import('../functions/src/closeShiftAuthoritative')) as unknown as { performCloseShiftAuthoritative: PerformClose })
      .performCloseShiftAuthoritative;
    performReturn = ((await import('../functions/src/submitSaleReturn')) as unknown as { performSubmitSaleReturn: PerformReturn })
      .performSubmitSaleReturn;
    app = initializeApp({ projectId: 'demo-twinpet', apiKey: 'demo-key' }, 'recovery-015');
    clientDb = clientFs.getFirestore(app, 'pos-db');
    const [host, port] = EMULATOR!.split(':');
    clientFs.connectFirestoreEmulator(clientDb, host!, Number(port), {
      mockUserToken: { sub: AUTH.uid, user_id: AUTH.uid, staffId: STAFF, role: 'staff', branchIds: [BRANCH], authVersion: 0 },
    });
    env.db = clientDb;
    const batch = adminDb.batch();
    batch.set(adminDb.doc(`users/${STAFF}`), { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: [BRANCH], firstName: 'Staff', lastName: 'One' });
    batch.set(adminDb.doc('users/m1'), { isActive: true, deletedAt: null, authVersion: 0, role: 'manager', branchIds: [BRANCH], firstName: 'Mana', lastName: 'Ger' });
    batch.set(adminDb.doc('userCredentials/m1'), {
      pinHash: '$2b$10$realhash',
      algo: 'bcrypt',
      cost: 10,
      credentialVersion: 1,
      credentialState: 'rotated_authoritative',
      disabled: false,
      updatedBy: 't',
    });
    batch.set(adminDb.doc('settings/_rolePermissions'), { rolePermissions: MATRIX });
    await batch.commit();
  });

  // Every test starts from an empty close journal (an attempt of an earlier test's shift would be swept too).
  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(SHIFT_CLOSE_INTENT_DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  afterAll(async () => {
    await clientFs.terminate(clientDb);
    await deleteApp(app);
  });

  // ── fixtures ──────────────────────────────────────────────────────────

  function sale(id: string, shiftId: string, cash: number, changeAmt = 0): LocalSale {
    return { id, shiftId, payments: [{ method: 'cash', amount: cash, ref: null }], changeAmt } as unknown as LocalSale;
  }

  type World = { tag: string; shiftId: string; orderId: string; p1: string; sales: LocalSale[]; unsubscribe: () => void };

  /** A settled cash sale (the Return fixture) + a W0-shaped open shift (startingCash 500) + 3 attested sales (cash 1000). */
  async function world(): Promise<World> {
    seq += 1;
    const tag = `r${seq}_${Date.now().toString(36)}`;
    const orderId = `O_${tag}`;
    const shiftId = `SH015_${tag}`;
    const p1 = `P1_${tag}`;
    const p2 = `P2_${tag}`;
    const l1 = `L1_${tag}`;
    const l2 = `L2_${tag}`;
    const l3 = `L3_${tag}`;
    const batch = adminDb.batch();
    batch.set(adminDb.doc(`asyncOrders/${orderId}`), {
      id: orderId,
      billId: `R-${orderId}`,
      deviceId: 'dev1',
      branchId: BRANCH,
      shiftId: 'SH-OLD',
      staffId: STAFF,
      staffName: 'Staff One',
      customerId: null,
      customerSnap: { name: 'คุณลูกค้า', phone: '', taxId: null },
      lines: [
        {
          productId: p1, productSnap: { name: 'อาหารแมว', sku: 'CF' }, unit: 'ถุง', unitFactor: 1, qty: 5, qtyBase: 5,
          unitPrice: 100, originalPrice: 100, discountAmt: 50, lineTotal: 450, fifoCost: 230,
          lotRefs: [{ lotId: l1, qty: 3, cost: 40 }, { lotId: l2, qty: 2, cost: 55 }],
        },
        {
          productId: p2, productSnap: { name: 'ทราย', sku: 'SD' }, unit: 'ลัง', unitFactor: 12, qty: 2, qtyBase: 24,
          unitPrice: 300, originalPrice: 300, discountAmt: 0, lineTotal: 600, fifoCost: 480, lotRefs: [{ lotId: l3, qty: 24, cost: 20 }],
        },
      ],
      payments: [{ method: 'cash', amount: 1000, ref: null }],
      subtotal: 1050, discountAmt: 50, billDiscount: 105, fee: 0, vatRate: 0, vatAmt: 0, total: 945, paidAmt: 1000, changeAmt: 55, creditAmt: 0,
      status: 'completed', reconcileStatus: 'settled', clientCreatedAt: Date.now() - 3 * DAY,
    });
    batch.set(adminDb.doc(`orders/${orderId}`), { id: orderId, billId: `R-${orderId}`, branchId: BRANCH, status: 'completed', total: 945, cogs: 710, profit: 340, historyRev: 1 });
    batch.set(adminDb.doc(`stockLots/${l1}`), { id: l1, productId: p1, branchId: BRANCH, costPerUnit: 40, qtyReceived: 3, qtyRemaining: 0, isDepleted: true });
    batch.set(adminDb.doc(`stockLots/${l2}`), { id: l2, productId: p1, branchId: BRANCH, costPerUnit: 55, qtyReceived: 10, qtyRemaining: 8, isDepleted: false });
    batch.set(adminDb.doc(`stockLots/${l3}`), { id: l3, productId: p2, branchId: BRANCH, costPerUnit: 20, qtyReceived: 24, qtyRemaining: 0, isDepleted: true });
    batch.set(adminDb.doc(`products/${p1}`), { id: p1, cost: 999, avgCost: 888 });
    batch.set(adminDb.doc(`products/${p1}/productStocks/${BRANCH}`), { branchId: BRANCH, totalStockBase: 8 });
    batch.set(adminDb.doc(`shifts/${shiftId}`), {
      id: shiftId, branchId: BRANCH, staffId: STAFF, staffName: 'Staff One', status: 'open', openedAt: new Date(Date.now() - DAY), closedAt: null,
      startingCash: 500, actualCashCount: 0, expectedCash: 0, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0,
      totalBills: 0, payInTotal: 0, payOutTotal: 0, variance: 0, note: '',
    });
    await batch.commit();
    const sales = [sale(`${shiftId}-1`, shiftId, 400), sale(`${shiftId}-2`, shiftId, 500, 100), sale(`${shiftId}-3`, shiftId, 200)];
    // The app keeps a listener on the active shift, so the local cache holds it.
    const unsubscribe = clientFs.onSnapshot(clientFs.doc(clientDb, 'shifts', shiftId), () => undefined);
    await clientFs.getDocFromServer(clientFs.doc(clientDb, 'shifts', shiftId));
    await new Promise((r) => setTimeout(r, 50));
    return { tag, shiftId, orderId, p1, sales, unsubscribe };
  }

  /** The PRODUCTION cash Return: shift `rfd_` pay-out + saleRefunds + saleReturns in one Admin transaction. */
  async function productionReturn81(w: World) {
    const res = await performReturn(
      adminDb,
      {
        attemptId: `attempt-a1-${w.tag}`,
        orderId: w.orderId,
        branchId: BRANCH,
        lines: [{ lineIndex: 0, productId: w.p1, qty: 1 }],
        refundMethod: 'cash',
        refundReference: '',
        reason: 'สินค้าชำรุด',
        expectedRefundAmount: 81,
        shiftId: w.shiftId,
        approverStaffId: 'm1',
        pin: GOOD_PIN,
      },
      AUTH,
      returnDeps,
    );
    expect(res).toMatchObject({ ok: true, refundAmount: 81, refundMethod: 'cash' });
  }

  function displayOf(shiftId: string, sales: LocalSale[], cashEntries: Shift['cashEntries'] = []): Shift {
    return deriveShiftDrawer(
      {
        id: shiftId, branchId: BRANCH, staffId: STAFF, staffName: 'Staff One', status: 'open', openedAt: null as unknown as Shift['openedAt'],
        closedAt: null, startingCash: 500, actualCashCount: 0, expectedCash: 0, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0,
        totalBills: 0, payInTotal: 0, payOutTotal: 0, variance: 0, note: '', cashEntries,
      },
      sales,
    );
  }

  let journalSeq = 0;
  /** A fresh journal instance over the shared fake IndexedDB ("restart" / "second window"); its id generator is valid v4. */
  function freshJournal(w: World): ShiftCloseIntentJournal {
    journalSeq += 1;
    const n = journalSeq;
    return createShiftCloseIntentJournal({
      generateCloseCorrelationId: () => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    });
  }

  const inProcessCallable = async (request: Record<string, unknown>) =>
    JSON.parse(JSON.stringify(await performClose(adminDb, JSON.parse(JSON.stringify(request)), AUTH)));

  function witnessFor(display: Shift, refresh: 'loaded' | 'pending' | 'unavailable' = 'loaded'): unknown {
    const build = (authClient as unknown as { buildReviewedDrawerWitness?: (s: Shift, r: string) => unknown }).buildReviewedDrawerWitness;
    return build ? build(display, refresh) : undefined;
  }

  function onDeps(w: World, journal: ShiftCloseIntentJournal, display: Shift, callable: (r: Record<string, unknown>) => Promise<unknown>) {
    const legacyW3 = vi.fn(() => Promise.reject(new Error('legacy W3 must not run')));
    const deps = {
      journal,
      isOnline: () => true,
      serverCashPending: { has: () => false, clear: () => undefined },
      runCloseTransaction: legacyW3,
      waitForQueuedWrites: async () => true,
      authoritativeCloseGate: true,
      authoritativeClose: { sales: w.sales, callable, reviewedDrawer: witnessFor(display) },
    } as unknown as CloseShiftDeps;
    return { deps, legacyW3 };
  }

  const sweep = (journal: ShiftCloseIntentJournal, authoritativeCallable?: (r: Record<string, unknown>) => Promise<unknown>) =>
    runShiftCloseReconciliationSweep({
      journal,
      readConfirmation: readShiftCloseConfirmation, // the real server read under the Rules
      normalizeSyncState: normalizeShiftCloseSyncState, // the real conditional W4 under the Rules
      deviceId: 'DEV1',
      authoritativeCallable,
    } as Parameters<typeof runShiftCloseReconciliationSweep>[0]);

  async function attemptOf(journal: ShiftCloseIntentJournal, shiftId: string) {
    const listed = await journal.listOnlineCloseAttempts();
    if (!listed.ok) throw new Error(`list ${listed.code}`);
    return listed.value.find((a) => a.shiftId === shiftId);
  }
  async function entryOf(journal: ShiftCloseIntentJournal, shiftId: string) {
    const got = await journal.getCloseIntent(shiftId);
    if (!got.ok) throw new Error(`get ${got.code}`);
    return got.value;
  }
  async function serverShift(shiftId: string) {
    return (await adminDb.doc(`shifts/${shiftId}`).get()).data()!;
  }
  async function authorityRecord(shiftId: string) {
    const snap = await adminDb.doc(`shiftCloseAuthorityRecords/${shiftId}`).get();
    return snap.exists ? snap.data() : undefined;
  }

  /** ON close whose transport is lost before the server sees it: the attempt UUID is bound, the shift stays open. */
  async function openBoundAttempt(w: World, journal: ShiftCloseIntentJournal) {
    const down = async () => {
      throw Object.assign(new Error('unavailable'), { code: 'functions/unavailable' });
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { deps } = onDeps(w, journal, displayOf(w.shiftId, w.sales), down);
    await expect(closeShift(displayOf(w.shiftId, w.sales), 1500, '', deps)).rejects.toThrow('ยังยืนยันผลการปิดกะกับเซิร์ฟเวอร์ไม่ได้');
    const attempt = await attemptOf(journal, w.shiftId);
    expect(attempt?.authoritative?.expected).toMatchObject({ payOutTotal: 0, actualCashCount: 1500, variance: 0 });
    return attempt!;
  }

  /** A direct client W3 through the Rules-checked CLIENT SDK: the attempt's UUID, the OLD expected totals (payout 0). */
  async function forgeDirectW3(w: World, uuid: string) {
    await clientFs.updateDoc(clientFs.doc(clientDb, 'shifts', w.shiftId), {
      status: 'closed',
      closedAt: clientFs.serverTimestamp(),
      actualCashCount: 1500,
      variance: 0,
      note: '',
      expectedCash: 1000,
      expectedQr: 0,
      expectedKbank: 0,
      expectedCard: 0,
      expectedCredit: 0,
      totalBills: 3,
      payInTotal: 0,
      payOutTotal: 0,
      closedOffline: true,
      syncState: 'pending',
      deviceId: 'DEV1',
      closeCorrelationId: uuid,
    });
  }

  async function expectNothingAdopted(w: World, journal: ShiftCloseIntentJournal, uuid: string) {
    expect(await entryOf(journal, w.shiftId)).toBeUndefined(); // no close journal entry ⇒ no Z
    const attempt = await attemptOf(journal, w.shiftId);
    expect(attempt?.closeCorrelationId).toBe(uuid); // attempt preserved (same UUID, bound request)
    expect(attempt && 'supersededAtLocal' in attempt).toBe(false);
    expect((await serverShift(w.shiftId)).syncState).toBe('pending'); // no W4
  }

  // ── F1 ────────────────────────────────────────────────────────────────

  test('F1 chronology: attempt A (payout 0, drawer 1500) → real Return 81 → Rules-accepted forged W3 → callable says closed_outside_authority → restart sweep: NO journal / Z / W4', async () => {
    const w = await world();
    const journal = freshJournal(w);
    const attempt = await openBoundAttempt(w, journal);
    const uuid = attempt.closeCorrelationId;
    const log: string[] = [`1 attempt ${uuid} bound: expected payOut 0, drawer 1500, shift open`];

    await productionReturn81(w);
    const afterReturn = await serverShift(w.shiftId);
    expect(afterReturn.cashEntries).toEqual([expect.objectContaining({ id: expect.stringMatching(/^rfd_/), type: 'pay_out', amount: 81 })]);
    log.push('2 production Return committed: rfd_ pay_out 81 on the shift');

    await forgeDirectW3(w, uuid); // Rules-accepted (unsealed): the premise of F1
    env.updateDocCalls = []; // from here on the ADAPTER must not write the shift
    const forged = await serverShift(w.shiftId);
    expect(forged).toMatchObject({ status: 'closed', closeCorrelationId: uuid, payOutTotal: 0, variance: 0, actualCashCount: 1500, deviceId: 'DEV1' });
    expect(await authorityRecord(w.shiftId)).toBeUndefined();
    log.push('3 client direct W3 ACCEPTED by the unsealed Rules (UUID A, payOut 0); no shiftCloseAuthorityRecords document');

    const request = authoritativeCloseRequest(attempt.authoritative!.request, uuid);
    await expect(inProcessCallable(request)).resolves.toEqual({ ok: false, code: 'closed_outside_authority' });
    log.push('4 callable replay of the stored request: ok:false closed_outside_authority');

    const restarted = freshJournal(w);
    const swept = await sweep(restarted, inProcessCallable);
    await expectNothingAdopted(w, restarted, uuid);
    expect(await authorityRecord(w.shiftId)).toBeUndefined();
    expect(swept.normalization.status).not.toBe('ok');
    expect(shiftCloseNormalizationIssue(swept.normalization)).toContain('attempt_manual_attention');
    const again = await sweep(freshJournal(w), inProcessCallable);
    expect(again.normalization.status).not.toBe('ok');
    await expectNothingAdopted(w, restarted, uuid);
    expect(env.updateDocCalls).toEqual([]); // the adapter never wrote the shift itself
    log.push('5 restart sweeps (x2): no journal entry, attempt kept, syncState still pending (no W4), attention attempt_manual_attention');
    console.info(`[015-F1 chronology]\n${log.join('\n')}`);
    w.unsubscribe();
  });

  test('F1 variants over a REAL server close: timeout / other-UUID success / no transport ⇒ nothing adopted, attempt kept', async () => {
    for (const variant of ['timeout', 'other_uuid_success', 'closed_outside_authority_answer'] as const) {
      const w = await world();
      const journal = freshJournal(w);
      const attempt = await openBoundAttempt(w, journal);
      const uuid = attempt.closeCorrelationId;
      // The server really closes it (record exists) but this client never heard.
      const real = (await inProcessCallable(authoritativeCloseRequest(attempt.authoritative!.request, uuid))) as Record<string, unknown>;
      expect(real).toMatchObject({ ok: true, idempotentReplay: false, closeCorrelationId: uuid });
      expect(await authorityRecord(w.shiftId)).toBeDefined();
      const tampered = async (r: Record<string, unknown>) => {
        const answer = (await inProcessCallable(r)) as Record<string, unknown>;
        if (variant === 'timeout') throw Object.assign(new Error('deadline'), { code: 'functions/deadline-exceeded' });
        if (variant === 'other_uuid_success') return { ...answer, closeCorrelationId: '99999999-9999-4999-8999-999999999999' };
        return { ok: false, code: 'closed_outside_authority' };
      };
      const restarted = freshJournal(w);
      const swept = await sweep(restarted, tampered);
      await expectNothingAdopted(w, restarted, uuid);
      expect(swept.normalization.status, variant).not.toBe('ok');
      w.unsubscribe();
    }
  });

  test('F1 positive: a genuine server close whose response was lost is proven by ONE idempotent replay, then recovered + W4 (exactly one authority record)', async () => {
    const w = await world();
    const journal = freshJournal(w);
    const attempt = await openBoundAttempt(w, journal);
    const uuid = attempt.closeCorrelationId;
    await inProcessCallable(authoritativeCloseRequest(attempt.authoritative!.request, uuid)); // committed server-side, client unaware
    const replays: unknown[] = [];
    const spy = async (r: Record<string, unknown>) => {
      const a = await inProcessCallable(r);
      replays.push((a as { idempotentReplay?: boolean }).idempotentReplay);
      return a;
    };
    const restarted = freshJournal(w);
    const swept = await sweep(restarted, spy);
    expect(replays).toEqual([true]);
    expect(swept.normalization.attempts).toMatchObject({ recovered: 1 });
    expect(await entryOf(restarted, w.shiftId)).toMatchObject({ closeCorrelationId: uuid, status: 'synced', payOutTotal: 0 });
    expect(await attemptOf(restarted, w.shiftId)).toBeUndefined();
    expect((await serverShift(w.shiftId)).syncState).toBe('synced'); // the real W4 under the Rules
    expect(swept.normalization.status).toBe('ok');
    w.unsubscribe();
  });

  test('F1 two windows: concurrent recovery of the same genuine close ⇒ one entry, attempt consumed once, one server commit', async () => {
    const w = await world();
    const journal = freshJournal(w);
    const attempt = await openBoundAttempt(w, journal);
    const uuid = attempt.closeCorrelationId;
    await inProcessCallable(authoritativeCloseRequest(attempt.authoritative!.request, uuid));
    const w1 = freshJournal(w);
    const w2 = freshJournal(w);
    const { recoverOnlineCloseAttempt } = await import('../src/lib/pos/offline/shiftCloseReconciler');
    const a1 = (await attemptOf(w1, w.shiftId))!;
    const a2 = (await attemptOf(w2, w.shiftId))!;
    const deps = (j: ShiftCloseIntentJournal) => ({ journal: j, readConfirmation: readShiftCloseConfirmation, deviceId: 'DEV1', authoritativeCallable: inProcessCallable });
    const [r1, r2] = await Promise.all([recoverOnlineCloseAttempt(a1, deps(w1)), recoverOnlineCloseAttempt(a2, deps(w2))]);
    expect([r1.outcome, r2.outcome]).toEqual(['recovered', 'recovered']);
    expect(await entryOf(w1, w.shiftId)).toMatchObject({ closeCorrelationId: uuid });
    expect(await attemptOf(w1, w.shiftId)).toBeUndefined();
    w.unsubscribe();
  });

  test('F1 the sweep NEVER calls the callable on an open shift (no W3 can come from a read/recovery sweep)', async () => {
    const w = await world();
    const journal = freshJournal(w);
    const attempt = await openBoundAttempt(w, journal);
    const callable = vi.fn(inProcessCallable);
    await sweep(freshJournal(w), callable);
    expect(callable).not.toHaveBeenCalled();
    expect((await serverShift(w.shiftId)).status).toBe('open');
    expect(await authorityRecord(w.shiftId)).toBeUndefined();
    expect(await attemptOf(journal, w.shiftId)).toMatchObject({ closeCorrelationId: attempt.closeCorrelationId });
    w.unsubscribe();
  });

  // ── F2 ────────────────────────────────────────────────────────────────

  test('F2: the display showed 1500 (no Return) but a real Return 81 reached the server first ⇒ refused before attempt/callable; the refreshed 1419 display closes exactly that', async () => {
    const w = await world();
    await productionReturn81(w); // after the modal rendered, before Confirm
    const journal = freshJournal(w);
    const callable = vi.fn(inProcessCallable);
    const stale = displayOf(w.shiftId, w.sales); // what the cashier saw: no payout
    const first = onDeps(w, journal, stale, callable);
    await expect(closeShift(stale, 1500, '', first.deps)).rejects.toThrow('ยอดเงินสดในลิ้นชักที่แสดงอยู่ไม่ตรงกับข้อมูลล่าสุดบนเซิร์ฟเวอร์');
    expect(callable).not.toHaveBeenCalled();
    expect(await attemptOf(journal, w.shiftId)).toBeUndefined();
    expect((await serverShift(w.shiftId)).status).toBe('open');

    // Refresh: the display now includes the server payout; the cashier recounts 1419 and confirms.
    const entries = (await serverShift(w.shiftId)).cashEntries as Shift['cashEntries'];
    const fresh = displayOf(w.shiftId, w.sales, entries);
    const second = onDeps(w, journal, fresh, callable);
    const result = await closeShift(fresh, 1419, '', second.deps);
    expect(result).toMatchObject({ status: 'closed', payOutTotal: 81, actualCashCount: 1419, variance: 0 });
    expect(await authorityRecord(w.shiftId)).toMatchObject({ money: { expectedDrawerMinor: 141_900, payOutMinor: 8100, varianceMinor: 0 } });
    expect(second.legacyW3).not.toHaveBeenCalled();
    w.unsubscribe();
  });
});
