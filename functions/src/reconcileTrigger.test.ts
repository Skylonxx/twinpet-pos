import { describe, test, expect, vi, beforeEach } from 'vitest';

// Prove the TRIGGER WRAPPER routing (not handleVoidIntent in isolation): does a
// settled `voidRequested` update actually reach handleVoidIntent, or is it
// dropped by a gate? We mock handleVoidIntent + db + the firebase modules and
// invoke the exported handler directly.

const { handleVoidIntentMock } = vi.hoisted(() => ({ handleVoidIntentMock: vi.fn() }));

vi.mock('./voidIntent', () => ({ handleVoidIntent: handleVoidIntentMock }));
vi.mock('./db', () => ({ db: { __fakeDb: true } }));
vi.mock('./deployConfig', () => ({
  FIRESTORE_DATABASE_ID: 'pos-db',
  FUNCTIONS_REGION: 'asia-southeast1',
}));
vi.mock('firebase-functions/v2/firestore', () => ({
  // Return the handler so importing the module has no side effects.
  onDocumentWritten: (_opts: unknown, handler: unknown) => handler,
}));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }), increment: (n: number) => ({ __fv: 'inc', n }) },
  Timestamp: { fromMillis: () => ({}), now: () => ({}) },
}));

import { reconcileOnWrite } from './reconcileOrder';

type EvtData = { voidRequested?: boolean; reconcileStatus?: string };
function event(data: EvtData | null, refSet = vi.fn()) {
  if (data === null) return { data: { after: { exists: false } } } as never;
  return {
    data: { after: { exists: true, ref: { id: 'dev01-1', set: refSet }, data: () => data } },
  } as never;
}

beforeEach(() => handleVoidIntentMock.mockReset());

describe('reconcileOnWrite — trigger routing (the wrapper, not in isolation)', () => {
  test('a SETTLED voidRequested update IS routed to handleVoidIntent (not dropped)', async () => {
    await reconcileOnWrite(event({ voidRequested: true, reconcileStatus: 'settled' }));
    expect(handleVoidIntentMock).toHaveBeenCalledTimes(1);
    // Routed with the injected db + the doc ref.
    expect(handleVoidIntentMock.mock.calls[0][0]).toEqual({ __fakeDb: true });
  });

  test('a PENDING voidRequested update is also routed (gate is voidRequested, not status)', async () => {
    await reconcileOnWrite(event({ voidRequested: true, reconcileStatus: 'pending_reconcile' }));
    expect(handleVoidIntentMock).toHaveBeenCalledTimes(1);
  });

  test('a settled NON-void doc is NOT routed to void (and not re-reconciled)', async () => {
    await reconcileOnWrite(event({ reconcileStatus: 'settled' }));
    expect(handleVoidIntentMock).not.toHaveBeenCalled();
  });

  test('a deleted doc is ignored', async () => {
    await reconcileOnWrite(event(null));
    expect(handleVoidIntentMock).not.toHaveBeenCalled();
  });

  test('a void failure is SURFACED on the doc (no silent stuck void)', async () => {
    handleVoidIntentMock.mockRejectedValueOnce(new Error('boom'));
    const refSet = vi.fn();
    await expect(
      reconcileOnWrite(event({ voidRequested: true, reconcileStatus: 'settled' }, refSet)),
    ).rejects.toThrow('boom');
    expect(refSet).toHaveBeenCalledWith(
      expect.objectContaining({ voidError: 'boom' }),
      { merge: true },
    );
  });
});
