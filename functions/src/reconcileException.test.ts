import { describe, test, expect, vi, beforeEach } from 'vitest';

/**
 * PHASE 0 — reconcileOrder SALE-path exception handling CHARACTERIZATION.
 *
 * reconcileTrigger.test.ts already covers void-intent ROUTING and void-failure
 * surfacing. This file covers the OTHER branch of reconcileOnWrite: a pending
 * SALE whose settlement transaction throws. We mock ./db so `runTransaction`
 * is fully controllable — no emulator, no real settle logic — proving exactly
 * what the wrapper does on failure / re-delivery / success.
 *
 * NO behavior change: characterization only.
 */

const { runTransactionMock } = vi.hoisted(() => ({ runTransactionMock: vi.fn() }));

vi.mock('./db', () => ({ db: { runTransaction: runTransactionMock } }));
vi.mock('./deployConfig', () => ({
  FIRESTORE_DATABASE_ID: 'pos-db',
  FUNCTIONS_REGION: 'asia-southeast1',
}));
vi.mock('./voidIntent', () => ({ handleVoidIntent: vi.fn() }));
vi.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (_opts: unknown, handler: unknown) => handler,
}));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }), increment: (n: number) => ({ __fv: 'inc', n }) },
  Timestamp: { now: () => ({}), fromMillis: () => ({}) },
}));

import { reconcileOnWrite } from './reconcileOrder';

type EvtData = { voidRequested?: boolean; reconcileStatus?: string };
function event(data: EvtData | null, refSet = vi.fn()) {
  if (data === null) return { data: { after: { exists: false } } } as never;
  return {
    data: { after: { exists: true, ref: { id: 'dev01-1', set: refSet }, data: () => data } },
  } as never;
}

beforeEach(() => runTransactionMock.mockReset());

describe('reconcileOnWrite — SALE reconcile exception handling (Phase 0)', () => {
  test('a pending sale whose settlement THROWS is stamped reconcileStatus=exception + reconcileError, then rethrown for retry', async () => {
    runTransactionMock.mockRejectedValueOnce(new Error('tx boom'));
    const refSet = vi.fn();

    await expect(
      reconcileOnWrite(event({ reconcileStatus: 'pending_reconcile' }, refSet)),
    ).rejects.toThrow('tx boom');

    expect(runTransactionMock).toHaveBeenCalledTimes(1);
    expect(refSet).toHaveBeenCalledWith(
      expect.objectContaining({ reconcileStatus: 'exception', reconcileError: 'tx boom' }),
      { merge: true },
    );
  });

  test('a doc already in reconcileStatus=exception is a NO-OP on re-delivery (no settle attempt, no re-stamp) — no reprocessing loop', async () => {
    const refSet = vi.fn();
    await reconcileOnWrite(event({ reconcileStatus: 'exception' }, refSet));
    expect(runTransactionMock).not.toHaveBeenCalled();
    expect(refSet).not.toHaveBeenCalled();
  });

  test('happy path: a pending sale that settles cleanly does NOT stamp an error and does NOT rethrow', async () => {
    runTransactionMock.mockResolvedValueOnce(undefined);
    const refSet = vi.fn();

    await expect(
      reconcileOnWrite(event({ reconcileStatus: 'pending_reconcile' }, refSet)),
    ).resolves.toBeUndefined();

    expect(runTransactionMock).toHaveBeenCalledTimes(1);
    expect(refSet).not.toHaveBeenCalled();
  });

  test('a non-pending, non-void doc (e.g. already settled) is a NO-OP (idempotent skip)', async () => {
    const refSet = vi.fn();
    await reconcileOnWrite(event({ reconcileStatus: 'settled' }, refSet));
    expect(runTransactionMock).not.toHaveBeenCalled();
    expect(refSet).not.toHaveBeenCalled();
  });
});
