/**
 * Gate 007-C — the Variant C (W4) normalization is a CONDITIONAL client
 * `runTransaction` (read the closed shift → decide → `syncState: 'synced'`).
 * Proves against the real emulator, with the production decision function:
 *  - the deployed W4 rule (`isW4SyncStateNormalization`) admits the single
 *    field write when it is committed by a transaction (no Rules change);
 *  - a competing W4 that commits between this transaction's read and its
 *    commit gets this commit REJECTED (Rules evaluate it against the now
 *    synced doc: permission-denied, not retried) — two API attempts, ONE
 *    effective `pending → synced` transition, no success for the loser; a
 *    transaction that reads after the competing commit decides
 *    `already_synced` and writes nothing;
 *  - a doc of another correlation id / device is never written;
 *  - independently of the client, Rules deny a second (plain) W4.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, runTransaction, setDoc, updateDoc, type Firestore } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shiftCloseNormalizationDecision } from '../src/lib/pos/offline/shiftCloseReconciler';

const BRANCH = 'LDP-001';
const CORR = '11111111-1111-4111-8111-111111111111';
const EXPECTED = { closeCorrelationId: CORR, deviceId: 'DEV1' };
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

async function seedClosedPending(shiftId: string, overrides: Record<string, unknown> = {}) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'shifts', shiftId), {
      id: shiftId, branchId: BRANCH, staffId: 'staff1', staffName: 'Cashier One', status: 'closed', openedAt: new Date(),
      closedAt: new Date(), startingCash: 500, actualCashCount: 1500, expectedCash: 1000, expectedQr: 0, expectedKbank: 0,
      expectedCard: 0, expectedCredit: 0, totalBills: 3, payInTotal: 0, payOutTotal: 0, variance: 0, note: '',
      closedOffline: true, syncState: 'pending', deviceId: 'DEV1', closeCorrelationId: CORR, ...overrides,
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

/** The production normalizer's transaction body (`normalizeShiftCloseSyncState`), with an optional hook before commit. */
function conditionalW4(db: Firestore, shiftId: string, beforeCommit?: (attempt: number) => Promise<void>) {
  let attempt = 0;
  const run = runTransaction(db, async (tx) => {
    attempt += 1;
    const ref = doc(db, 'shifts', shiftId);
    const snap = await tx.get(ref);
    const decision = shiftCloseNormalizationDecision(snap.exists() ? (snap.data() as Record<string, unknown>) : undefined, EXPECTED);
    if (decision !== 'write') return decision;
    if (beforeCommit) await beforeCommit(attempt);
    tx.update(ref, { syncState: 'synced' });
    return 'written' as const;
  });
  return { run, attempts: () => attempt };
}

describe('W4 via a conditional client runTransaction (gate 007-C)', () => {
  it('ALLOWED: the closed, pending doc of this close + device is written once', async () => {
    await seedClosedPending('w1');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await expect(conditionalW4(db, 'w1').run).resolves.toBe('written');
    expect(await readShift('w1')).toMatchObject({ status: 'closed', syncState: 'synced', closeCorrelationId: CORR });
  });

  it('a competing W4 commits between this read and this commit → this commit is REJECTED (Rules see the synced doc); ONE effective transition, no success for the loser', async () => {
    await seedClosedPending('w2');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const other = testEnv.authenticatedContext('staff1', staff()).firestore();
    const w4 = conditionalW4(db, 'w2', async (attempt) => {
      if (attempt === 1) await updateDoc(doc(other, 'shifts', 'w2'), { syncState: 'synced' }); // the other worker's W4 lands now
    });
    // The production normalizer propagates this rejection: a FAILED W4 (retry_later), never written / already_synced.
    await expect(w4.run).rejects.toMatchObject({ code: 'permission-denied' });
    expect(await readShift('w2')).toMatchObject({ syncState: 'synced' });
  });

  it('the competing W4 committed BEFORE this transaction read → decides already_synced and writes nothing', async () => {
    await seedClosedPending('w5');
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const other = testEnv.authenticatedContext('staff1', staff()).firestore();
    await updateDoc(doc(other, 'shifts', 'w5'), { syncState: 'synced' });
    const w4 = conditionalW4(db, 'w5');
    await expect(w4.run).resolves.toBe('already_synced');
    expect(w4.attempts()).toBe(1);
  });

  it.each([
    ['another correlation id', { closeCorrelationId: '22222222-2222-4222-8222-222222222222' }],
    ['another device', { deviceId: 'DEV2' }],
  ])('a doc of %s is never written (precondition_failed)', async (_label, overrides) => {
    await seedClosedPending('w3', overrides);
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await expect(conditionalW4(db, 'w3').run).resolves.toBe('precondition_failed');
    expect(await readShift('w3')).toMatchObject({ syncState: 'pending' });
  });

  it('DENIED by Rules: a second plain W4 on an already synced doc (Rules alone allow only pending → synced)', async () => {
    await seedClosedPending('w4', { syncState: 'synced' });
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'shifts', 'w4'), { syncState: 'synced' }));
  });
});
