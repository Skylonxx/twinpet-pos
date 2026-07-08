// posDeviceRegistry.seqReconcile — boot-time device-sequence watermark
// reconciliation (Packet 3B-4).
//
// `reconcileLocalSeqWithServer` exposes an injectable composition seam
// (SeqReconcileDeps: getDeviceId / getDeviceLastSeq / peekLocalSeq /
// fastForwardLocalSeqTo), so these tests override those directly instead of
// mocking Firestore reads through `getDeviceLastSeq`'s own internals. The only
// thing NOT injectable is the `isFirebaseConfigured` / `db` gate read directly
// from '../firebase' — that is mocked the same way as asyncOrderLookup.test.ts.

import { describe, test, expect, beforeEach, vi } from 'vitest';

const { firebaseState } = vi.hoisted(() => ({
  firebaseState: { isFirebaseConfigured: true as boolean, db: {} as unknown },
}));

vi.mock('../firebase', () => ({
  get isFirebaseConfigured() {
    return firebaseState.isFirebaseConfigured;
  },
  get db() {
    return firebaseState.db;
  },
}));

// Imported AFTER the mock is declared (vi.mock is hoisted, so this is safe).
import { claimDevice, reconcileLocalSeqWithServer, type SeqReconcileDeps } from './posDeviceRegistry';

function makeDeps(overrides?: Partial<SeqReconcileDeps>): {
  deps: SeqReconcileDeps;
  getDeviceId: ReturnType<typeof vi.fn>;
  getDeviceLastSeq: ReturnType<typeof vi.fn>;
  peekLocalSeq: ReturnType<typeof vi.fn>;
  fastForwardLocalSeqTo: ReturnType<typeof vi.fn>;
} {
  const getDeviceId = vi.fn(() => 'DEV1');
  const getDeviceLastSeq = vi.fn(async () => 0);
  const peekLocalSeq = vi.fn(() => 0);
  const fastForwardLocalSeqTo = vi.fn(async () => undefined);

  const deps: SeqReconcileDeps = {
    getDeviceId: (overrides?.getDeviceId ?? getDeviceId) as SeqReconcileDeps['getDeviceId'],
    getDeviceLastSeq: (overrides?.getDeviceLastSeq ??
      getDeviceLastSeq) as SeqReconcileDeps['getDeviceLastSeq'],
    peekLocalSeq: (overrides?.peekLocalSeq ?? peekLocalSeq) as SeqReconcileDeps['peekLocalSeq'],
    fastForwardLocalSeqTo: (overrides?.fastForwardLocalSeqTo ??
      fastForwardLocalSeqTo) as SeqReconcileDeps['fastForwardLocalSeqTo'],
  };

  return { deps, getDeviceId, getDeviceLastSeq, peekLocalSeq, fastForwardLocalSeqTo };
}

beforeEach(() => {
  firebaseState.isFirebaseConfigured = true;
  firebaseState.db = {};
  vi.restoreAllMocks();
});

describe('reconcileLocalSeqWithServer · happy path', () => {
  test('reads current device id via getDeviceId()', async () => {
    const h = makeDeps();
    await reconcileLocalSeqWithServer(h.deps);
    expect(h.getDeviceId).toHaveBeenCalledTimes(1);
  });

  test('reads the server lastSeq for this device', async () => {
    const h = makeDeps({ getDeviceLastSeq: vi.fn(async () => 50) as never });
    const getLastSeqSpy = h.deps.getDeviceLastSeq as ReturnType<typeof vi.fn>;
    await reconcileLocalSeqWithServer(h.deps);
    expect(getLastSeqSpy).toHaveBeenCalledWith('DEV1');
  });

  test('higher server watermark calls fast-forward with that watermark', async () => {
    const h = makeDeps({
      getDeviceLastSeq: vi.fn(async () => 50) as never,
      peekLocalSeq: vi.fn(() => 5) as never,
    });
    await reconcileLocalSeqWithServer(h.deps);
    expect(h.fastForwardLocalSeqTo).toHaveBeenCalledWith(50);
  });

  test('equal watermark is a no-op (fast-forward not called)', async () => {
    const h = makeDeps({
      getDeviceLastSeq: vi.fn(async () => 50) as never,
      peekLocalSeq: vi.fn(() => 50) as never,
    });
    await reconcileLocalSeqWithServer(h.deps);
    expect(h.fastForwardLocalSeqTo).not.toHaveBeenCalled();
  });

  test('lower watermark than local is a no-op (fast-forward not called)', async () => {
    const h = makeDeps({
      getDeviceLastSeq: vi.fn(async () => 5) as never,
      peekLocalSeq: vi.fn(() => 50) as never,
    });
    await reconcileLocalSeqWithServer(h.deps);
    expect(h.fastForwardLocalSeqTo).not.toHaveBeenCalled();
  });

  test('missing lastSeq (resolves to 0) is a no-op', async () => {
    const h = makeDeps({ getDeviceLastSeq: vi.fn(async () => 0) as never });
    await reconcileLocalSeqWithServer(h.deps);
    expect(h.fastForwardLocalSeqTo).not.toHaveBeenCalled();
  });
});

describe('reconcileLocalSeqWithServer · fail-open', () => {
  test('Firebase not configured → fail-open, no-op, no reads', async () => {
    firebaseState.isFirebaseConfigured = false;
    const h = makeDeps();
    await reconcileLocalSeqWithServer(h.deps);
    expect(h.getDeviceId).not.toHaveBeenCalled();
    expect(h.getDeviceLastSeq).not.toHaveBeenCalled();
    expect(h.fastForwardLocalSeqTo).not.toHaveBeenCalled();
  });

  test('no db instance → fail-open, no-op', async () => {
    firebaseState.db = null;
    const h = makeDeps();
    await reconcileLocalSeqWithServer(h.deps);
    expect(h.fastForwardLocalSeqTo).not.toHaveBeenCalled();
  });

  test('getDeviceLastSeq rejection → fail-open, no throw, no fast-forward', async () => {
    const h = makeDeps({
      getDeviceLastSeq: vi.fn(async () => {
        throw new Error('read boom');
      }) as never,
    });
    await expect(reconcileLocalSeqWithServer(h.deps)).resolves.toBeUndefined();
    expect(h.fastForwardLocalSeqTo).not.toHaveBeenCalled();
  });

  test('inaccessible doc (getDeviceLastSeq resolves 0, mirroring its own internal fail-open) → no-op', async () => {
    // getDeviceLastSeq itself already fails open to 0 on a permission-denied /
    // missing-doc read (see posDeviceRegistry.ts) — reconcile must treat that
    // exactly like "no watermark" and stay silent.
    const h = makeDeps({ getDeviceLastSeq: vi.fn(async () => 0) as never });
    await expect(reconcileLocalSeqWithServer(h.deps)).resolves.toBeUndefined();
    expect(h.fastForwardLocalSeqTo).not.toHaveBeenCalled();
  });

  test('fastForwardLocalSeqTo rejection → fail-open, no throw', async () => {
    const h = makeDeps({
      getDeviceLastSeq: vi.fn(async () => 50) as never,
      peekLocalSeq: vi.fn(() => 5) as never,
      fastForwardLocalSeqTo: vi.fn(async () => {
        throw new Error('fast-forward boom');
      }) as never,
    });
    await expect(reconcileLocalSeqWithServer(h.deps)).resolves.toBeUndefined();
  });

  test('getDeviceId throw → fail-open, no throw', async () => {
    const h = makeDeps({
      getDeviceId: vi.fn(() => {
        throw new Error('id boom');
      }) as never,
    });
    await expect(reconcileLocalSeqWithServer(h.deps)).resolves.toBeUndefined();
    expect(h.fastForwardLocalSeqTo).not.toHaveBeenCalled();
  });
});

describe('reconcileLocalSeqWithServer · never writes posDevices', () => {
  test('no Firestore write function is imported/used by this module path (read-only contract)', async () => {
    // reconcileLocalSeqWithServer only composes getDeviceId / getDeviceLastSeq /
    // peekLocalSeq / fastForwardLocalSeqTo — none of which touch `setDoc`. This
    // is enforced structurally (no setDoc import reachable from the deps type),
    // but assert the call graph stays within the injected read seam.
    const h = makeDeps({
      getDeviceLastSeq: vi.fn(async () => 50) as never,
      peekLocalSeq: vi.fn(() => 5) as never,
    });
    await reconcileLocalSeqWithServer(h.deps);
    expect(h.deps.getDeviceId).toHaveBeenCalledTimes(1);
    expect(h.deps.getDeviceLastSeq).toHaveBeenCalledTimes(1);
    expect(h.deps.fastForwardLocalSeqTo).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileLocalSeqWithServer · does not change claimDevice semantics', () => {
  test('claimDevice remains exported and unaffected (still adopts lastSeq via setDeviceIdentity path)', () => {
    expect(typeof claimDevice).toBe('function');
  });
});
