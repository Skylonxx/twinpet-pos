/**
 * Return/Refund V1 packet 014 — the staged server-authoritative close ADAPTER
 * (src/lib/pos/shiftService.ts `closeShift`, gate injected ON) against the REAL
 * Firestore emulator, named database `pos-db`, project `demo-twinpet`.
 *
 *   client  the PRODUCTION `closeShift` with a real client Firestore connected
 *           to the emulator with a staff `mockUserToken` (Rules from
 *           firebase.json are evaluated for every client read and the W4), the
 *           REAL IndexedDB journal (fake-indexeddb), real `getDocFromServer`
 *           proof reads and the real conditional W4 transaction;
 *   server  the PRODUCTION `performCloseShiftAuthoritative` (Admin SDK on the
 *           emulator's pos-db), invoked IN-PROCESS as the callable with the
 *           request / response JSON round-tripped. The Functions HTTPS
 *           transport itself is NOT exercised (no Functions emulator).
 *   Return  seeded with the exact server-only shape the production Return
 *           transaction writes (shift `rfd_` pay-out + saleRefunds +
 *           saleReturns) — not the Return transaction itself.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/shift-close-authoritative-client.spec.ts"
 * Skips unless FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT=demo-twinpet are set.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
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
    // Client-W3 tripwire: the server-authoritative close must never updateDoc the shift.
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

import { buildReviewedDrawerWitness } from '../src/lib/pos/shiftCloseAuthoritativeClient';
import { closeShift, type CloseShiftDeps } from '../src/lib/pos/shiftService';
import { deriveShiftDrawer } from '../src/lib/pos/shiftLedger';
import { createShiftCloseIntentJournal } from '../src/lib/pos/offline/shiftCloseIntentStore';
import type { LocalSale } from '../src/lib/pos/localLedger';
import type { Shift } from '../src/lib/types';

type AdminDb = {
  doc: (p: string) => {
    set: (d: Record<string, unknown>) => Promise<unknown>;
    get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined; updateTime?: { toMillis: () => number } }>;
    update: (d: Record<string, unknown>) => Promise<unknown>;
  };
  collection: (p: string) => { where: (f: string, op: string, v: unknown) => { get: () => Promise<{ size: number }> } };
};
type PerformClose = (db: unknown, req: unknown, auth: unknown) => Promise<unknown>;

let adminDb: AdminDb;
let performClose: PerformClose;
let app: FirebaseApp;
let clientDb: clientFs.Firestore;
let seq = 0;

const STAFF = 'staff-e1';
const BRANCH = 'B-E1';
const AUTH = { uid: `u-${STAFF}`, token: { staffId: STAFF, role: 'staff', branchIds: [BRANCH], authVersion: 0 } };

const describeEmu = RUN ? describe : describe.skip;

describeEmu('014 adapter ⇄ closeShiftAuthoritative on the Firestore emulator (demo-twinpet / pos-db)', () => {
  beforeAll(async () => {
    const dbModule = (await import('../functions/src/db')) as unknown as { db: AdminDb };
    adminDb = dbModule.db;
    performClose = ((await import('../functions/src/closeShiftAuthoritative')) as unknown as { performCloseShiftAuthoritative: PerformClose })
      .performCloseShiftAuthoritative;
    app = initializeApp({ projectId: 'demo-twinpet', apiKey: 'demo-key' }, 'adapter-014');
    clientDb = clientFs.getFirestore(app, 'pos-db');
    const [host, port] = EMULATOR!.split(':');
    clientFs.connectFirestoreEmulator(clientDb, host!, Number(port), {
      mockUserToken: { sub: AUTH.uid, user_id: AUTH.uid, staffId: STAFF, role: 'staff', branchIds: [BRANCH], authVersion: 0 },
    });
    env.db = clientDb;
    await adminDb.doc(`users/${STAFF}`).set({ isActive: true, deletedAt: null, authVersion: 0, role: 'staff', branchIds: [BRANCH] });
  });

  afterAll(async () => {
    await clientFs.terminate(clientDb);
    await deleteApp(app);
  });

  function sale(id: string, shiftId: string, cash: number, changeAmt = 0): LocalSale {
    return { id, shiftId, payments: [{ method: 'cash', amount: cash, ref: null }], changeAmt } as unknown as LocalSale;
  }

  async function world() {
    seq += 1;
    const shiftId = `SH014_${seq}_${Date.now().toString(36)}`;
    await adminDb.doc(`shifts/${shiftId}`).set({
      id: shiftId,
      branchId: BRANCH,
      staffId: STAFF,
      staffName: 'Cashier E',
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
      cashEntries: [],
    });
    const sales = [sale(`${shiftId}-1`, shiftId, 400), sale(`${shiftId}-2`, shiftId, 500, 100), sale(`${shiftId}-3`, shiftId, 200)];
    // The app keeps a listener on the active shift, so the local cache holds it.
    const unsubscribe = clientFs.onSnapshot(clientFs.doc(clientDb, 'shifts', shiftId), () => undefined);
    await clientFs.getDocFromServer(clientFs.doc(clientDb, 'shifts', shiftId));
    await new Promise((r) => setTimeout(r, 50));
    return { shiftId, sales, unsubscribe };
  }

  /** The exact server-only records + shift pay-out the production cash Return commits together. */
  async function seedCashReturn(shiftId: string, returnId: string, amount: number) {
    const cashEntryId = `rfd_${returnId}`;
    const shift = (await adminDb.doc(`shifts/${shiftId}`).get()).data()!;
    await adminDb.doc(`shifts/${shiftId}`).update({
      cashEntries: [
        ...((shift.cashEntries as unknown[]) ?? []),
        { id: cashEntryId, type: 'pay_out', amount, note: 'คืนเงินสด', staffId: STAFF, staffName: 'Cashier E', at: Date.now() },
      ],
    });
    await adminDb.doc(`saleRefunds/${returnId}`).set({
      schemaVersion: 1,
      refundId: returnId,
      returnId,
      method: 'cash',
      executionMode: 'cash_drawer',
      shiftId,
      branchId: BRANCH,
      requesterStaffId: STAFF,
      cashEntryId,
      amount,
    });
    await adminDb.doc(`saleReturns/${returnId}`).set({
      schemaVersion: 1,
      returnId,
      status: 'completed',
      branchId: BRANCH,
      requesterStaffId: STAFF,
      refund: { method: 'cash', refundId: returnId, shiftId, cashEntryId, amount },
    });
  }

  function drawerOf(shiftId: string, sales: LocalSale[], cashEntries: Shift['cashEntries'] = []): Shift {
    return deriveShiftDrawer(
      {
        id: shiftId,
        branchId: BRANCH,
        staffId: STAFF,
        staffName: 'Cashier E',
        status: 'open',
        openedAt: null as unknown as Shift['openedAt'],
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
      },
      sales,
    );
  }

  let journalSeq = 0;
  function freshJournal() {
    journalSeq += 1;
    let n = journalSeq;
    return createShiftCloseIntentJournal({
      generateCloseCorrelationId: () => `${String(n++).padStart(8, '0')}-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    });
  }

  /** `display` = the drawer the cashier was shown (packet 015 F2): its reviewed-drawer witness rides on the ON close. */
  function onDeps(
    sales: LocalSale[],
    journal: ReturnType<typeof freshJournal>,
    callable: (r: Record<string, unknown>) => Promise<unknown>,
    display: Shift,
  ) {
    const legacyW3 = vi.fn(() => Promise.reject(new Error('legacy W3 must not run')));
    const deps = {
      journal,
      isOnline: () => true,
      serverCashPending: { has: () => false, clear: () => undefined },
      runCloseTransaction: legacyW3,
      waitForQueuedWrites: async () => true,
      authoritativeCloseGate: true,
      authoritativeClose: { sales, callable, reviewedDrawer: buildReviewedDrawerWitness(display, 'loaded') },
    } as unknown as CloseShiftDeps;
    return { deps, legacyW3 };
  }

  const inProcessCallable = async (request: Record<string, unknown>) =>
    JSON.parse(JSON.stringify(await performClose(adminDb, JSON.parse(JSON.stringify(request)), AUTH)));

  async function authorityRecordCount(shiftId: string): Promise<number> {
    return (await adminDb.collection('shiftCloseAuthorityRecords').where('shiftId', '==', shiftId).get()).size;
  }

  test('Return 81 before the close: callable W3 only, payOut 81 / drawer 1419 / variance 0, proven + journaled, client W4 under Rules', async () => {
    const w = await world();
    await seedCashReturn(w.shiftId, `ret_${w.shiftId}`, 81);
    env.updateDocCalls = [];
    const journal = freshJournal();
    // The refreshed modal shows the server payout: the cashier reviewed drawer 1419 before confirming it.
    const shown = drawerOf(w.shiftId, w.sales, (await adminDb.doc(`shifts/${w.shiftId}`).get()).data()!.cashEntries as Shift['cashEntries']);
    const { deps, legacyW3 } = onDeps(w.sales, journal, inProcessCallable, shown);
    const result = await closeShift(shown, 1419, '', deps);
    expect(result).toMatchObject({ status: 'closed', startingCash: 500, expectedCash: 1000, payOutTotal: 81, actualCashCount: 1419, variance: 0 });

    const server = (await adminDb.doc(`shifts/${w.shiftId}`).get()).data()!;
    const entry = await journal.getCloseIntent(w.shiftId);
    expect(entry.ok && entry.value).toMatchObject({ payOutTotal: 81, variance: 0, closeCorrelationId: server.closeCorrelationId });
    const record = (await adminDb.doc(`shiftCloseAuthorityRecords/${w.shiftId}`).get()).data()!;
    expect(record).toMatchObject({
      closeCorrelationId: server.closeCorrelationId,
      money: { expectedDrawerMinor: 141_900, payOutMinor: 8100, varianceMinor: 0 },
      cashAudit: { refundCount: 1, refundTotalMinor: 8100 },
      salesVerification: { status: 'attested_unverified' },
    });
    expect(legacyW3).not.toHaveBeenCalled();
    expect(env.updateDocCalls).toEqual([]);

    await expect(result.whenServerConfirmed).resolves.toMatchObject({ outcome: 'confirmed' });
    expect((await adminDb.doc(`shifts/${w.shiftId}`).get()).data()!.syncState).toBe('synced');
    w.unsubscribe();
  });

  test('a Return committed after the pre-call read but before the server transaction is NOT adopted: no Z, attempt kept', async () => {
    const w = await world();
    env.updateDocCalls = [];
    const journal = freshJournal();
    let calls = 0;
    const racing = async (request: Record<string, unknown>) => {
      calls += 1;
      if (calls === 1) await seedCashReturn(w.shiftId, `ret_${w.shiftId}`, 81);
      return inProcessCallable(request);
    };
    const shown = drawerOf(w.shiftId, w.sales);
    const { deps, legacyW3 } = onDeps(w.sales, journal, racing, shown);
    await expect(closeShift(shown, 1500, '', deps)).rejects.toThrow(
      'เซิร์ฟเวอร์ปิดกะแล้ว แต่ยอดที่บันทึกไม่ตรงกับยอดที่เครื่องนี้ส่งไป',
    );
    const server = (await adminDb.doc(`shifts/${w.shiftId}`).get()).data()!;
    expect(server).toMatchObject({ status: 'closed', payOutTotal: 81, variance: 81 });
    expect(await journal.getCloseIntent(w.shiftId)).toEqual({ ok: true, value: undefined });
    const listed = await journal.listOnlineCloseAttempts();
    const attempt = listed.ok ? listed.value.find((a) => a.shiftId === w.shiftId) : undefined;
    expect(attempt && 'commitObservedAtLocal' in attempt).toBe(true);
    expect(attempt?.authoritative?.expected).toMatchObject({ payOutTotal: 0, variance: 0 });
    expect(legacyW3).not.toHaveBeenCalled();
    expect(env.updateDocCalls).toEqual([]);
    w.unsubscribe();
  });

  test('lost response after the commit: real server probe, same-id same-body replay (idempotentReplay), ONE authority record', async () => {
    const w = await world();
    env.updateDocCalls = [];
    const journal = freshJournal();
    const responses: unknown[] = [];
    let calls = 0;
    const lossy = async (request: Record<string, unknown>) => {
      calls += 1;
      const r = await inProcessCallable(request);
      responses.push(r);
      if (calls === 1) throw Object.assign(new Error('deadline-exceeded'), { code: 'functions/deadline-exceeded' });
      return r;
    };
    const shown = drawerOf(w.shiftId, w.sales);
    const { deps, legacyW3 } = onDeps(w.sales, journal, lossy, shown);
    const result = await closeShift(shown, 1500, 'n', deps);
    expect(result).toMatchObject({ status: 'closed', variance: 0, note: 'n' });
    expect(calls).toBe(2);
    expect(responses.map((r) => (r as { idempotentReplay?: boolean }).idempotentReplay)).toEqual([false, true]);
    expect(await authorityRecordCount(w.shiftId)).toBe(1);
    expect(legacyW3).not.toHaveBeenCalled();
    expect(env.updateDocCalls).toEqual([]);
    w.unsubscribe();
  });

  test('ON offline: refused before anything — server shift untouched, no attempt, no callable', async () => {
    const w = await world();
    const before = await adminDb.doc(`shifts/${w.shiftId}`).get();
    const journal = freshJournal();
    const callable = vi.fn(inProcessCallable);
    const shown = drawerOf(w.shiftId, w.sales);
    const { deps } = onDeps(w.sales, journal, callable, shown);
    await expect(closeShift(shown, 1500, '', { ...deps, isOnline: () => false })).rejects.toThrow(
      'ปิดกะได้เฉพาะเมื่อเชื่อมต่ออินเทอร์เน็ตเท่านั้น',
    );
    const after = await adminDb.doc(`shifts/${w.shiftId}`).get();
    expect(after.data()).toEqual(before.data());
    expect(after.updateTime?.toMillis()).toBe(before.updateTime?.toMillis());
    expect(callable).not.toHaveBeenCalled();
    const listed = await journal.listOnlineCloseAttempts();
    expect(listed.ok && listed.value.filter((a) => a.shiftId === w.shiftId)).toEqual([]);
    w.unsubscribe();
  });
});
