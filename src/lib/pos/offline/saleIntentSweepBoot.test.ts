// saleIntentSweepBoot — startup sweep boot wiring (Packet 3A-2B).
//
// The boot module exposes an injectable composition seam (SaleIntentSweepBootDeps),
// so these tests override createLookup / createJournal / runSweep / getClaims /
// navigatorRef directly instead of vi.mock-ing Firebase. The React hook
// (useSaleIntentSweepBoot) is an untested-by-design one-line useEffect wrapper —
// vitest env is `node`, no DOM harness — so all behavior is exercised through the
// plain maybeStartSaleIntentSweepBoot function with fake timers.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { User as FirebaseUser } from 'firebase/auth';
import {
  SALE_INTENT_SWEEP_BOOT_DELAY_MS,
  maybeStartSaleIntentSweepBoot,
  __resetSaleIntentSweepBootForTests,
  __saleIntentSweepBootPendingRunForTests,
  type SaleIntentSweepBootContext,
  type SaleIntentSweepBootDeps,
} from './saleIntentSweepBoot';

const FAKE_USER = { uid: 'anon-1' } as unknown as FirebaseUser;

function baseCtx(overrides?: Partial<SaleIntentSweepBootContext>): SaleIntentSweepBootContext {
  return { session: {}, branchId: 'LDP-001', firebaseUser: FAKE_USER, ...overrides };
}

type Harness = {
  deps: SaleIntentSweepBootDeps;
  lookupFn: ReturnType<typeof vi.fn>;
  createLookup: ReturnType<typeof vi.fn>;
  createJournal: ReturnType<typeof vi.fn>;
  runSweep: ReturnType<typeof vi.fn>;
  getClaims: ReturnType<typeof vi.fn>;
  lockRequest: ReturnType<typeof vi.fn> | null;
};

function makeHarness(opts?: {
  lookupNull?: boolean;
  onLine?: boolean;
  claims?: Record<string, unknown> | 'throw';
  locks?: 'acquire' | 'held' | 'none';
  runSweepReject?: boolean;
}): Harness {
  const lookupFn = vi.fn(async () => ({ exists: true }));
  const createLookup = vi.fn(() => (opts?.lookupNull ? null : lookupFn));
  const createJournal = vi.fn(() => ({}) as never);
  const runSweep = vi.fn(async () => {
    if (opts?.runSweepReject) throw new Error('sweep boom');
    return {} as never;
  });
  const getClaims = vi.fn(async () => {
    if (opts?.claims === 'throw') throw new Error('token boom');
    return { claims: (opts?.claims as Record<string, unknown>) ?? { staffId: 'staff-1' } };
  });

  let lockRequest: ReturnType<typeof vi.fn> | null = null;
  let locks: unknown;
  if (opts?.locks === 'acquire') {
    lockRequest = vi.fn(async (name: string, _o: unknown, cb: (lock: unknown) => unknown) =>
      cb({ name }),
    );
    locks = { request: lockRequest };
  } else if (opts?.locks === 'held') {
    lockRequest = vi.fn(async (_n: string, _o: unknown, cb: (lock: unknown) => unknown) => cb(null));
    locks = { request: lockRequest };
  } else {
    locks = undefined; // 'none' / default → Web Locks unsupported
  }

  const navigatorRef = {
    onLine: opts?.onLine ?? true,
    ...(locks ? { locks } : {}),
  } as unknown as Navigator;

  const deps: SaleIntentSweepBootDeps = {
    createLookup: createLookup as unknown as SaleIntentSweepBootDeps['createLookup'],
    createJournal: createJournal as unknown as SaleIntentSweepBootDeps['createJournal'],
    runSweep: runSweep as unknown as SaleIntentSweepBootDeps['runSweep'],
    getClaims: getClaims as unknown as SaleIntentSweepBootDeps['getClaims'],
    navigatorRef,
  };

  return { deps, lookupFn, createLookup, createJournal, runSweep, getClaims, lockRequest };
}

async function advanceAndSettle(ms: number = SALE_INTENT_SWEEP_BOOT_DELAY_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await __saleIntentSweepBootPendingRunForTests();
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetSaleIntentSweepBootForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Synchronous gates (no schedule, no-op) ──────────────────────────────────
describe('saleIntentSweepBoot · synchronous gates', () => {
  test('no app session → no-op (nothing scheduled)', async () => {
    const h = makeHarness();
    const cleanup = maybeStartSaleIntentSweepBoot(baseCtx({ session: null }), h.deps);
    expect(cleanup).toBeUndefined();
    await advanceAndSettle();
    expect(h.createLookup).not.toHaveBeenCalled();
    expect(h.runSweep).not.toHaveBeenCalled();
  });

  test('missing branchId → no-op', async () => {
    const h = makeHarness();
    const cleanup = maybeStartSaleIntentSweepBoot(baseCtx({ branchId: null }), h.deps);
    expect(cleanup).toBeUndefined();
    await advanceAndSettle();
    expect(h.runSweep).not.toHaveBeenCalled();
  });

  test("branchId 'ALL' (global-admin sentinel) → no-op (POS-shell-only scope)", async () => {
    const h = makeHarness();
    const cleanup = maybeStartSaleIntentSweepBoot(baseCtx({ branchId: 'ALL' }), h.deps);
    expect(cleanup).toBeUndefined();
    await advanceAndSettle();
    expect(h.runSweep).not.toHaveBeenCalled();
  });

  test('missing firebaseUser → no-op', async () => {
    const h = makeHarness();
    const cleanup = maybeStartSaleIntentSweepBoot(baseCtx({ firebaseUser: null }), h.deps);
    expect(cleanup).toBeUndefined();
    await advanceAndSettle();
    expect(h.runSweep).not.toHaveBeenCalled();
  });

  test('navigator.onLine === false → silent no-op (advisory offline pre-filter)', async () => {
    const h = makeHarness({ onLine: false });
    const cleanup = maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    expect(cleanup).toBeUndefined();
    await advanceAndSettle();
    expect(h.createLookup).not.toHaveBeenCalled();
    expect(h.runSweep).not.toHaveBeenCalled();
  });
});

// ─── Post-delay gates (scheduled, then skip inside the run) ───────────────────
describe('saleIntentSweepBoot · post-delay gates', () => {
  test('Firebase not configured / no db (lookup factory returns null) → no-op', async () => {
    const h = makeHarness({ lookupNull: true });
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    await advanceAndSettle();
    expect(h.createLookup).toHaveBeenCalledTimes(1);
    expect(h.runSweep).not.toHaveBeenCalled();
    expect(h.createJournal).not.toHaveBeenCalled();
  });

  test('createAsyncOrderServerLookup returns null → no-op (explicit)', async () => {
    const h = makeHarness({ lookupNull: true });
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    await advanceAndSettle();
    expect(h.runSweep).not.toHaveBeenCalled();
  });

  test('missing staffId claim → no-op (cached-claims pre-gate)', async () => {
    const h = makeHarness({ claims: {} });
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    await advanceAndSettle();
    expect(h.getClaims).toHaveBeenCalledTimes(1);
    expect(h.runSweep).not.toHaveBeenCalled();
  });

  test('no journal event / mutation on a skipped boot (missing claim path)', async () => {
    const h = makeHarness({ claims: {} });
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    await advanceAndSettle();
    expect(h.createJournal).not.toHaveBeenCalled();
    expect(h.runSweep).not.toHaveBeenCalled();
  });
});

// ─── Scheduling ──────────────────────────────────────────────────────────────
describe('saleIntentSweepBoot · scheduling', () => {
  test('does not run before the fixed 10s delay', async () => {
    const h = makeHarness();
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    await vi.advanceTimersByTimeAsync(SALE_INTENT_SWEEP_BOOT_DELAY_MS - 1);
    expect(h.runSweep).not.toHaveBeenCalled();
  });

  test('runs exactly once after the fixed 10s delay when all gates pass', async () => {
    const h = makeHarness();
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    await advanceAndSettle();
    expect(h.runSweep).toHaveBeenCalledTimes(1);
  });

  test('passes the created journal and the lookup adapter into runSaleIntentSweep', async () => {
    const h = makeHarness();
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    await advanceAndSettle();
    expect(h.createJournal).toHaveBeenCalledTimes(1);
    const arg = h.runSweep.mock.calls[0][0] as { journal: unknown; lookupAsyncOrder: unknown };
    expect(arg.lookupAsyncOrder).toBe(h.lookupFn);
    expect(arg).toHaveProperty('journal');
  });

  test('cleanup cancels the pending timer (no run after unmount before delay)', async () => {
    const h = makeHarness();
    const cleanup = maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    expect(cleanup).toBeTypeOf('function');
    cleanup?.();
    await advanceAndSettle();
    expect(h.runSweep).not.toHaveBeenCalled();
  });

  test('no interval / retry loop — a single pass per app start', async () => {
    const h = makeHarness();
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    await advanceAndSettle();
    // Advance an hour: no further runs may fire.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await __saleIntentSweepBootPendingRunForTests();
    expect(h.runSweep).toHaveBeenCalledTimes(1);
  });
});

// ─── Once-per-tab guard ──────────────────────────────────────────────────────
describe('saleIntentSweepBoot · once-per-tab guard', () => {
  test('StrictMode double effect (mount → unmount → mount) yields exactly one run', async () => {
    const h = makeHarness();
    const cleanup1 = maybeStartSaleIntentSweepBoot(baseCtx(), h.deps); // schedule t1
    cleanup1?.(); // StrictMode unmount clears t1
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps); // schedule t2
    await advanceAndSettle();
    expect(h.runSweep).toHaveBeenCalledTimes(1);
  });

  test('two overlapping schedules (no unmount between) still run only once', async () => {
    const h = makeHarness();
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    await advanceAndSettle();
    expect(h.runSweep).toHaveBeenCalledTimes(1);
  });

  test('a call after the guard is consumed does not reschedule', async () => {
    const h = makeHarness();
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    await advanceAndSettle();
    expect(h.runSweep).toHaveBeenCalledTimes(1);

    const cleanup2 = maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    expect(cleanup2).toBeUndefined();
    await advanceAndSettle();
    expect(h.runSweep).toHaveBeenCalledTimes(1);
  });
});

// ─── Web Locks single-flight ─────────────────────────────────────────────────
describe('saleIntentSweepBoot · Web Locks single-flight', () => {
  test('Web Locks supported + lock acquired → runs', async () => {
    const h = makeHarness({ locks: 'acquire' });
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    await advanceAndSettle();
    expect(h.lockRequest).toHaveBeenCalledWith(
      'twinpet-sale-intent-sweep',
      { ifAvailable: true },
      expect.any(Function),
    );
    expect(h.runSweep).toHaveBeenCalledTimes(1);
  });

  test('Web Locks supported + lock held elsewhere (null grant) → silent skip', async () => {
    const h = makeHarness({ locks: 'held' });
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    await advanceAndSettle();
    expect(h.lockRequest).toHaveBeenCalledTimes(1);
    expect(h.runSweep).not.toHaveBeenCalled();
  });

  test('Web Locks unsupported → runs via idempotency fallback', async () => {
    const h = makeHarness({ locks: 'none' });
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    await advanceAndSettle();
    expect(h.runSweep).toHaveBeenCalledTimes(1);
  });
});

// ─── Fail-open behavior ──────────────────────────────────────────────────────
describe('saleIntentSweepBoot · fail-open', () => {
  test('getIdTokenResult failure → fail-open, no throw, no sweep', async () => {
    const h = makeHarness({ claims: 'throw' });
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    await expect(advanceAndSettle()).resolves.toBeUndefined();
    expect(h.getClaims).toHaveBeenCalledTimes(1);
    expect(h.runSweep).not.toHaveBeenCalled();
  });

  test('runSaleIntentSweep rejection → fail-open, no throw', async () => {
    const h = makeHarness({ runSweepReject: true });
    maybeStartSaleIntentSweepBoot(baseCtx(), h.deps);
    await expect(advanceAndSettle()).resolves.toBeUndefined();
    expect(h.runSweep).toHaveBeenCalledTimes(1);
  });
});
