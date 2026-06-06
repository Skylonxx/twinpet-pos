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
  FieldValue: {
    serverTimestamp: () => ({ __fv: 'ts' }),
    increment: (n: number) => ({ __fv: 'inc', n }),
    delete: () => ({ __fv: 'del' }),
  },
  Timestamp: { now: () => ({}), fromMillis: () => ({}) },
}));

import { reconcileOnWrite, sanitizeReconcileError, buildRecoveryAuditPatch } from './reconcileOrder';

type EvtData = {
  voidRequested?: boolean;
  reconcileStatus?: string;
  reconcileAttempts?: number;
  reconcileError?: string | null;
};
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
      expect.objectContaining({
        reconcileStatus: 'exception',
        reconcileAttempts: { __fv: 'inc', n: 1 }, // ATOMIC increment, not stale +1
        reconcileError: 'tx boom', // first error preserved
        lastReconcileError: 'tx boom',
      }),
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

describe('reconcileOnWrite — exception enrichment & audit (Track B Step 1)', () => {
  test('a SECOND failure increments attempts and PRESERVES the first error', async () => {
    runTransactionMock.mockRejectedValueOnce(new Error('second boom'));
    const refSet = vi.fn();
    // Re-armed doc already carries the prior failure's attempts + first error.
    await expect(
      reconcileOnWrite(
        event(
          { reconcileStatus: 'pending_reconcile', reconcileAttempts: 1, reconcileError: 'first boom' },
          refSet,
        ),
      ),
    ).rejects.toThrow('second boom');

    const patch = refSet.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.reconcileStatus).toBe('exception');
    expect(patch.reconcileAttempts).toEqual({ __fv: 'inc', n: 1 }); // atomic +1 (stored 1 → 2 server-side)
    expect(patch.lastReconcileError).toBe('second boom'); // latest
    expect(patch.reconcileError).toBeUndefined(); // first error NOT overwritten
  });
});

describe('buildRecoveryAuditPatch — clear active error, preserve sanitized history', () => {
  test('a recovered retry clears active error fields and preserves the prior sanitized error', () => {
    const patch = buildRecoveryAuditPatch({ lastReconcileError: 'second boom', reconcileError: 'first boom' });
    // Active error state cleared.
    expect(patch.reconcileError).toEqual({ __fv: 'del' });
    expect(patch.lastReconcileError).toEqual({ __fv: 'del' });
    expect(patch.lastReconcileErrorAt).toEqual({ __fv: 'del' });
    expect(patch.firstFailedAt).toEqual({ __fv: 'del' });
    // History preserved (sanitized string we had stored — never raw).
    expect(patch.previousReconcileError).toBe('second boom');
    expect(patch.reconcileRecoveredAt).toEqual({ __fv: 'ts' });
  });

  test('a first-time clean settle clears nothing-of-note and writes NO history field', () => {
    const patch = buildRecoveryAuditPatch({});
    expect(patch.reconcileError).toEqual({ __fv: 'del' }); // delete is a no-op on an absent field
    expect('previousReconcileError' in patch).toBe(false);
    expect('reconcileRecoveredAt' in patch).toBe(false);
  });
});

describe('sanitizeReconcileError — admin-safe error fields', () => {
  test('collapses multi-line / whitespace to a single line', () => {
    expect(sanitizeReconcileError(new Error('line one\n   line two\tend'))).toBe('line one line two end');
  });
  test('truncates very long messages (≤ ~300 chars) with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const out = sanitizeReconcileError(new Error(long));
    expect(out.length).toBeLessThanOrEqual(301);
    expect(out.endsWith('…')).toBe(true);
  });
  test('non-Error and empty inputs are handled', () => {
    expect(sanitizeReconcileError('plain string')).toBe('plain string');
    expect(sanitizeReconcileError(new Error('   '))).toBe('unknown error');
  });
});
