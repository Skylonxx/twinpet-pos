/**
 * Return/Refund V1 — C1-R1 010: the Return-81 → falsified-prefix → false-Z chain.
 *
 * WHAT IS REAL vs MODELLED (do not over-read):
 *  REAL   Firestore Rules in the `demo-twinpet` emulator for every write in the
 *         chain: the server (Admin/rules-disabled) refund payout + audit doc, the
 *         hostile whole-array W1 update, the W3 close transaction
 *         (`runTransaction` through the production `firestoreShiftCloseTransaction`
 *         shape) and the W4 sync-state write.
 *  REAL   The production `closeShift` from src/lib/pos/shiftService.ts, including
 *         the 009 raw-list integrity checker and the strict post-commit proof.
 *  017    The client W3 is SEALED in the Rules source: each chain first proves the
 *         gate-OFF close is refused by the real Rules (no Z, shift open, R kept),
 *         then re-runs the close in a clearly labelled PRE-SEAL LEGACY MODEL whose
 *         W3 transaction alone runs with Rules disabled (see emulatorCloseDeps) —
 *         the hostile W1 and the W4 stay real Rules-evaluated client writes.
 *  MODEL  The POS's local persistent cache (`getDocFromCache`) is replaced by a
 *         plain server read of the shift as a *fresh, current POS* would have
 *         mounted it; the local journal is the in-memory journal; the device id,
 *         online flag, pending-write wait and guard store are injected. No
 *         browser IndexedDB / WebChannel is exercised.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/shift-w1-prefix-close-chain.spec.ts"
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/firebase', () => ({
  isFirebaseConfigured: true,
  db: {} as unknown,
  collections: { shifts: 'shifts', cashTransactions: 'cashTransactions' },
}));

const mocks = vi.hoisted(() => ({
  readShiftForCache: null as null | ((shiftId: string) => Promise<Record<string, unknown> | undefined>),
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    // closeShift builds a ref with the (mocked, `{}`) db; the "cache" read is a fresh server read.
    doc: ((_db: unknown, _col: string, id: string) => ({ id })) as unknown as typeof actual.doc,
    getDocFromCache: (async (ref: { id: string }) => {
      const data = await mocks.readShiftForCache!(ref.id);
      return { exists: () => data !== undefined, data: () => data } as never;
    }) as unknown as typeof actual.getDocFromCache,
  };
});

vi.mock('../src/lib/pos/deviceId', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/pos/deviceId')>();
  return { ...actual, getDeviceId: vi.fn(() => 'DEV1') };
});

import { closeShift, type CloseShiftDeps, type ShiftCloseTransactionRunner, type ShiftCloseTx } from '../src/lib/pos/shiftService';
import { createInMemoryShiftCloseIntentJournal } from '../src/lib/pos/offline/shiftCloseIntentStore';
import { shiftCloseConfirmationDocFromData, type ShiftCloseConfirmationReader } from '../src/lib/pos/offline/shiftCloseReconciler';
import type { Shift, ShiftCashEntry } from '../src/lib/types';

const BRANCH = 'LDP-001';
const staff = () => ({ staffId: 'staff-1', role: 'staff', branchIds: [BRANCH], permissions: [] });
const RETURN_ID = 'e'.repeat(40);
const UUID_A = '11111111-1111-4111-8111-111111111111';
const AT = 1_760_000_000_000;

let testEnv: RulesTestEnvironment;
let real: typeof import('firebase/firestore');

beforeAll(async () => {
  real = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-twinpet',
    firestore: { rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8'), host, port: Number(port) },
  });
  mocks.readShiftForCache = async (id) => {
    let data: Record<string, unknown> | undefined;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      data = (await real.getDoc(real.doc(ctx.firestore(), 'shifts', id))).data();
    });
    return data;
  };
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

const entry = (id: string, over: Partial<ShiftCashEntry> = {}): ShiftCashEntry => ({
  id,
  type: 'pay_out',
  amount: 1,
  note: 'n',
  staffId: 'staff-1',
  staffName: 'Cashier One',
  at: AT,
  ...over,
});
/** What `submitSaleReturn` (Admin SDK) appends for a cash refund of 81 baht. */
const R = entry(`rfd_${RETURN_ID}`, { type: 'pay_out', amount: 81, note: 'คืนเงินสด RT-R-1-1 (บิล B1)', at: AT + 5 });
const FAKE = entry('c_fake', { type: 'pay_out', amount: 1 });
const LAST = entry('c_last', { type: 'pay_in', amount: 1 });

async function serverReturnRecordsRefund() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    await real.setDoc(real.doc(fs, 'shifts', 'shift-1'), {
      id: 'shift-1', branchId: BRANCH, staffId: 'staff-1', staffName: 'Cashier One', status: 'open',
      openedAt: new Date(), closedAt: null, startingCash: 500, actualCashCount: 0,
      expectedCash: 0, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0,
      totalBills: 0, payInTotal: 0, payOutTotal: 0, variance: 0, note: '',
    });
    await real.updateDoc(real.doc(fs, 'shifts', 'shift-1'), { cashEntries: real.arrayUnion(R), updatedAt: new Date() });
    await real.setDoc(real.doc(fs, 'cashTransactions', R.id), {
      id: R.id, shiftId: 'shift-1', branchId: BRANCH, staffId: 'staff-1', staffName: 'Cashier One',
      type: 'pay_out', amount: 81, note: R.note, source: 'sale_refund', returnId: RETURN_ID,
    });
  });
}

async function readDoc(path: [string, string]) {
  let data: Record<string, unknown> | undefined;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    data = (await real.getDoc(real.doc(ctx.firestore(), ...path))).data();
  });
  return data;
}

/** A fresh, current POS mounts the shift exactly as the server holds it right now. */
async function freshPosShift(): Promise<Shift> {
  const d = (await readDoc(['shifts', 'shift-1']))!;
  return {
    id: 'shift-1', branchId: BRANCH, staffId: 'staff-1', staffName: 'Cashier One', status: 'open',
    openedAt: new Date() as unknown as Shift['openedAt'], closedAt: null,
    startingCash: 500, actualCashCount: 0,
    expectedCash: 1000, // sale-derived expected cash from the local ledger (cash sales 1000)
    expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0, totalBills: 3,
    payInTotal: 0, payOutTotal: 0, variance: 0, note: '',
    cashEntries: (d.cashEntries ?? []) as ShiftCashEntry[],
  };
}

/**
 * Production gate-OFF close wiring.
 *  - `sealed`: the W3 transaction runs as the staff client on the REAL emulator
 *    Rules (packet 017 sealed it, so it is DENIED) + the real W4.
 *  - `preSealModel`: LEGACY-HISTORY model of the pre-017 world (the gate-OFF fleet
 *    still runs against unsealed deployed Rules until cutover). The Rules no longer
 *    contain a client W3, so the W3 transaction runs with Rules DISABLED — this
 *    proves ONLY the client fold / strict proof / journal chain over the
 *    server-held list, never a Rules acceptance. The hostile W1 and the W4 stay
 *    real Rules-evaluated client writes.
 */
type ClientDb = ReturnType<ReturnType<RulesTestEnvironment['authenticatedContext']>['firestore']>;

function inTransaction<T>(db: ClientDb, shiftId: string, fn: (tx: ShiftCloseTx) => Promise<T>): Promise<T> {
  const ref = real.doc(db, 'shifts', shiftId);
  return real.runTransaction(db, (tx) =>
    fn({
      get: async () => {
        const snap = await tx.get(ref);
        return { exists: snap.exists(), data: snap.exists() ? (snap.data() as Record<string, unknown>) : undefined };
      },
      update: (payload) => tx.update(ref, payload),
    }),
  );
}

function emulatorCloseDeps(mode: 'sealed' | 'preSealModel'): CloseShiftDeps {
  const staffDb = testEnv.authenticatedContext('staff-1', staff()).firestore();
  const run: ShiftCloseTransactionRunner =
    mode === 'sealed'
      ? (shiftId, fn) => inTransaction(staffDb, shiftId, fn)
      : async <T>(shiftId: string, fn: (tx: ShiftCloseTx) => Promise<T>) => {
          let result: { value: T } | undefined;
          await testEnv.withSecurityRulesDisabled(async (ctx) => {
            result = { value: await inTransaction(ctx.firestore(), shiftId, fn) };
          });
          return result!.value;
        };
  const readConfirmation: ShiftCloseConfirmationReader = async (shiftId) => {
    const data = await mocks.readShiftForCache!(shiftId);
    return data ? { ok: true, doc: shiftCloseConfirmationDocFromData(data) } : { ok: true, doc: { exists: false } };
  };
  return {
    journal: createInMemoryShiftCloseIntentJournal({ generateCloseCorrelationId: () => UUID_A }),
    isOnline: () => true,
    serverCashPending: { has: () => false, clear: () => undefined },
    runCloseTransaction: run,
    waitForQueuedWrites: async () => true,
    readConfirmation,
    normalizeSyncState: async () => {
      await real.updateDoc(real.doc(staffDb, 'shifts', 'shift-1'), { syncState: 'synced' });
    },
  };
}

function hostileWholeArrayUpdate(list: ShiftCashEntry[]) {
  const staffDb = testEnv.authenticatedContext('staff-1', staff()).firestore();
  return real.updateDoc(real.doc(staffDb, 'shifts', 'shift-1'), { cashEntries: list as never, updatedAt: real.serverTimestamp() });
}

function record(line: string) {
  if (process.env.W1_CHAIN_LOG) appendFileSync(process.env.W1_CHAIN_LOG, `${line}\n`);
}

/** 017: the production gate-OFF close is refused by the sealed Rules — no Z, shift open, R and its audit doc intact. */
async function expectSealedGateOffCloseRefused(countedCash: number, expectedIds: string[]) {
  const refused = await closeShift(await freshPosShift(), countedCash, '', emulatorCloseDeps('sealed')).catch((e: Error) => e);
  expect(refused).toBeInstanceOf(Error);
  record(`017 sealed gate-OFF close refused: ${(refused as Error).message}`);
  expect(await readDoc(['shifts', 'shift-1'])).toMatchObject({ status: 'open', closedAt: null, payOutTotal: 0 });
  expect(((await readDoc(['shifts', 'shift-1']))!.cashEntries as ShiftCashEntry[]).map((e) => e.id)).toEqual(expectedIds);
  expect(await readDoc(['cashTransactions', R.id])).toMatchObject({ amount: 81, source: 'sale_refund' });
}

describe('010 end-to-end chain (real emulator Rules + production closeShift; 017 sealed + pre-seal legacy model)', () => {
  it('Return-81 → hostile whole-array W1 replacement → fresh POS closes: the replacement is DENIED and the Z carries payOut 81 / variance 0', async () => {
    await serverReturnRecordsRefund();

    // Hostile branch staff: replace R by ordinary c_fake pay_out 1, append ordinary c_last pay_in 1 (old len 1 → new len 2).
    let attackAccepted = true;
    try {
      await hostileWholeArrayUpdate([FAKE, LAST]);
    } catch {
      attackAccepted = false;
    }
    record(`attack W1 [c_fake out 1, c_last in 1] over [rfd out 81]: ${attackAccepted ? 'ACCEPTED by Rules' : 'DENIED by Rules'}`);

    // 017 sealed Rules: the gate-OFF client close itself can no longer commit.
    await expectSealedGateOffCloseRefused(1419, [R.id]);

    // Pre-seal legacy model: a fresh, current POS reloads the shift and the cashier counts 1419 (500 + 1000 − 81).
    const z = await closeShift(await freshPosShift(), 1419, '', emulatorCloseDeps('preSealModel')).catch((e: Error) => e);
    if (z instanceof Error) {
      record(`close refused: ${z.message}`);
    } else {
      const expectedDrawer = z.startingCash + z.expectedCash + z.payInTotal - z.payOutTotal;
      record(`Z: payOutTotal=${z.payOutTotal} payInTotal=${z.payInTotal} expectedDrawer=${expectedDrawer} variance=${z.variance}`);
    }

    expect(attackAccepted).toBe(false);
    expect(z).not.toBeInstanceOf(Error);
    const closed = z as Awaited<ReturnType<typeof closeShift>>;
    expect(closed).toMatchObject({ status: 'closed', payOutTotal: 81, payInTotal: 0, variance: 0 });
    expect(closed.startingCash + closed.expectedCash + closed.payInTotal - closed.payOutTotal).toBe(1419);

    // The persisted close, the payout and the Return audit document are all intact.
    expect(await readDoc(['shifts', 'shift-1'])).toMatchObject({ status: 'closed', payOutTotal: 81, payInTotal: 0, variance: 0 });
    expect(((await readDoc(['shifts', 'shift-1']))!.cashEntries as ShiftCashEntry[]).map((e) => e.id)).toEqual([R.id]);
    expect(await readDoc(['cashTransactions', R.id])).toMatchObject({ amount: 81, source: 'sale_refund' });
  });

  it('a LEGITIMATE ordinary pay_in appended after the Return (R preserved) closes with payOut 81, payIn 20, variance 0', async () => {
    await serverReturnRecordsRefund();
    const staffDb = testEnv.authenticatedContext('staff-1', staff()).firestore();
    const ordinary = entry('Aa3sQe9wLm2PqRtUvXy1', { type: 'pay_in', amount: 20, at: AT + 9 });
    await real.updateDoc(real.doc(staffDb, 'shifts', 'shift-1'), { cashEntries: real.arrayUnion(ordinary), updatedAt: real.serverTimestamp() });

    await expectSealedGateOffCloseRefused(1439, [R.id, ordinary.id]);

    const z = await closeShift(await freshPosShift(), 1439, '', emulatorCloseDeps('preSealModel'));
    expect(z).toMatchObject({ status: 'closed', payOutTotal: 81, payInTotal: 20, variance: 0 });
    expect(z.startingCash + z.expectedCash + z.payInTotal - z.payOutTotal).toBe(1439);
    await expect(z.whenServerConfirmed).resolves.toMatchObject({ outcome: 'confirmed' });
    expect(await readDoc(['shifts', 'shift-1'])).toMatchObject({ status: 'closed', payOutTotal: 81, payInTotal: 20, variance: 0, syncState: 'synced' });
  });

  it('the hostile update is rejected by the Rules themselves — assertFails on the exact request, shift untouched', async () => {
    await serverReturnRecordsRefund();
    await assertFails(hostileWholeArrayUpdate([FAKE, LAST]));
    expect((await readDoc(['shifts', 'shift-1']))!.cashEntries).toEqual([R]);
  });
});
