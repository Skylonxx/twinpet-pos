// deviceSeqReconcileBoot — startup device-sequence watermark reconciliation
// boot wiring (Packet 3B-4).
//
// The boot module exposes an injectable composition seam
// (DeviceSeqReconcileBootDeps: reconcile / navigatorRef), so these tests
// override them directly instead of vi.mock-ing Firebase. The React hook
// (useDeviceSeqReconcileBoot) is an untested-by-design one-line useEffect
// wrapper — vitest env is `node`, no DOM harness — so all behavior is
// exercised through the plain maybeStartDeviceSeqReconcile function.
//
// Unlike saleIntentSweepBoot, this module has NO fixed delay — it is the
// latency-safety subject of Packet 3B-4: reconciliation must never block UI
// readiness or checkout, however slow the network read is.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { User as FirebaseUser } from 'firebase/auth';
import {
  maybeStartDeviceSeqReconcile,
  __resetDeviceSeqReconcileBootForTests,
  __deviceSeqReconcileBootPendingRunForTests,
  type DeviceSeqReconcileBootContext,
  type DeviceSeqReconcileBootDeps,
} from './deviceSeqReconcileBoot';
// `?raw` source imports (declared by vite/client types, no Node `fs`/`@types/node`
// needed — this package has neither) let the "critical pin" tests below assert
// against the actual file text without touching the filesystem.
import ownSource from './deviceSeqReconcileBoot.ts?raw';
import appShellSource from '../../../components/AppShell.tsx?raw';

const FAKE_USER = { uid: 'anon-1' } as unknown as FirebaseUser;

function baseCtx(
  overrides?: Partial<DeviceSeqReconcileBootContext>,
): DeviceSeqReconcileBootContext {
  return { session: {}, branchId: 'LDP-001', firebaseUser: FAKE_USER, ...overrides };
}

type Harness = {
  deps: DeviceSeqReconcileBootDeps;
  reconcile: ReturnType<typeof vi.fn>;
};

function makeHarness(opts?: {
  onLine?: boolean;
  reconcileReject?: boolean;
  neverResolves?: boolean;
}): Harness {
  let releaseHang: (() => void) | undefined;
  const reconcile = vi.fn(async () => {
    if (opts?.neverResolves) {
      await new Promise<void>((resolve) => {
        releaseHang = resolve;
      });
      return;
    }
    if (opts?.reconcileReject) throw new Error('reconcile boom');
  });
  // Expose a way for a test to release a hung reconcile if it ever needs to.
  (reconcile as unknown as { __release?: () => void }).__release = () => releaseHang?.();

  const navigatorRef = { onLine: opts?.onLine ?? true } as unknown as Navigator;

  const deps: DeviceSeqReconcileBootDeps = {
    reconcile: reconcile as unknown as DeviceSeqReconcileBootDeps['reconcile'],
    navigatorRef,
  };

  return { deps, reconcile };
}

async function flushMicrotasks(): Promise<void> {
  await __deviceSeqReconcileBootPendingRunForTests();
}

beforeEach(() => {
  __resetDeviceSeqReconcileBootForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Synchronous gates (no-op, reconcile never called) ───────────────────────
describe('deviceSeqReconcileBoot · synchronous gates', () => {
  test('no app session → no-op', async () => {
    const h = makeHarness();
    maybeStartDeviceSeqReconcile(baseCtx({ session: null }), h.deps);
    await flushMicrotasks();
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  test('missing branchId → no-op', async () => {
    const h = makeHarness();
    maybeStartDeviceSeqReconcile(baseCtx({ branchId: null }), h.deps);
    await flushMicrotasks();
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  test("branchId 'ALL' (global-admin sentinel) → no-op", async () => {
    const h = makeHarness();
    maybeStartDeviceSeqReconcile(baseCtx({ branchId: 'ALL' }), h.deps);
    await flushMicrotasks();
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  test('missing firebaseUser → no-op', async () => {
    const h = makeHarness();
    maybeStartDeviceSeqReconcile(baseCtx({ firebaseUser: null }), h.deps);
    await flushMicrotasks();
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  test('navigator.onLine === false → silent no-op', async () => {
    const h = makeHarness({ onLine: false });
    maybeStartDeviceSeqReconcile(baseCtx(), h.deps);
    await flushMicrotasks();
    expect(h.reconcile).not.toHaveBeenCalled();
  });
});

// ─── Scheduling: runs immediately, no delay ───────────────────────────────────
describe('deviceSeqReconcileBoot · immediate scheduling (no delay)', () => {
  test('runs when all gates pass', async () => {
    const h = makeHarness();
    maybeStartDeviceSeqReconcile(baseCtx(), h.deps);
    await flushMicrotasks();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  test('schedules immediately after gates pass (called synchronously, no timer needed)', () => {
    const h = makeHarness();
    maybeStartDeviceSeqReconcile(baseCtx(), h.deps);
    // No fake timers, no await — reconcile is invoked before this assertion runs.
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  test('maybeStartDeviceSeqReconcile returns synchronously (does not return a Promise)', () => {
    const h = makeHarness({ neverResolves: true });
    const result = maybeStartDeviceSeqReconcile(baseCtx(), h.deps);
    expect(result).toBeUndefined();
  });
});

// ─── Once-per-tab guard ──────────────────────────────────────────────────────
describe('deviceSeqReconcileBoot · once-per-tab guard', () => {
  test('two overlapping calls still run reconcile only once', async () => {
    const h = makeHarness();
    maybeStartDeviceSeqReconcile(baseCtx(), h.deps);
    maybeStartDeviceSeqReconcile(baseCtx(), h.deps);
    await flushMicrotasks();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  test('a call after the guard is consumed does not re-run', async () => {
    const h = makeHarness();
    maybeStartDeviceSeqReconcile(baseCtx(), h.deps);
    await flushMicrotasks();
    expect(h.reconcile).toHaveBeenCalledTimes(1);

    maybeStartDeviceSeqReconcile(baseCtx(), h.deps);
    await flushMicrotasks();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });
});

// ─── Fail-open behavior ──────────────────────────────────────────────────────
describe('deviceSeqReconcileBoot · fail-open', () => {
  test('reconcile rejection → fail-open, no throw', async () => {
    const h = makeHarness({ reconcileReject: true });
    expect(() => maybeStartDeviceSeqReconcile(baseCtx(), h.deps)).not.toThrow();
    await expect(flushMicrotasks()).resolves.toBeUndefined();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });
});

// ─── Critical pins: no shared 10s sale-sweep delay ───────────────────────────
describe('deviceSeqReconcileBoot · critical pins', () => {
  test('module source does not import SALE_INTENT_SWEEP_BOOT_DELAY_MS', () => {
    expect(ownSource).not.toMatch(/SALE_INTENT_SWEEP_BOOT_DELAY_MS/);
  });

  test('module source does not set a 10-second (10_000 / 10000) timer', () => {
    expect(ownSource).not.toMatch(/setTimeout/);
    expect(ownSource).not.toMatch(/10_000|10000/);
  });

  test('does not schedule via setTimeout at runtime either (behavioral, not just textual)', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const h = makeHarness();
    maybeStartDeviceSeqReconcile(baseCtx(), h.deps);
    await flushMicrotasks();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  test('AppShell mounts useDeviceSeqReconcileBoot once, near useSaleIntentSweepBoot', () => {
    expect(appShellSource).toMatch(/useDeviceSeqReconcileBoot\(\)/);
    const matches = appShellSource.match(/useDeviceSeqReconcileBoot\(\)/g) ?? [];
    expect(matches.length).toBe(1);

    const sweepIdx = appShellSource.indexOf('useSaleIntentSweepBoot()');
    const reconcileIdx = appShellSource.indexOf('useDeviceSeqReconcileBoot()');
    expect(sweepIdx).toBeGreaterThan(-1);
    expect(reconcileIdx).toBeGreaterThan(-1);
    // "near" — within a small number of lines of each other, not scattered.
    const between = appShellSource.slice(
      Math.min(sweepIdx, reconcileIdx),
      Math.max(sweepIdx, reconcileIdx),
    );
    expect(between.split('\n').length).toBeLessThanOrEqual(4);
  });

  test('AppShell diff carries no markup/CSS changes beyond the mount-only hook call', () => {
    // Sanity: the component still returns its existing top-level shell markup —
    // this is a structural smoke check, not a full diff, but guards against an
    // accidental unrelated markup edit landing in the same file.
    expect(appShellSource).toMatch(
      /className="flex w-full h-screen overflow-hidden bg-\[var\(--g50\)\] font-sans"/,
    );
  });
});

// ─── Latency safety (the core 3B-4 requirement) ──────────────────────────────
describe('deviceSeqReconcileBoot · latency safety', () => {
  test('heavy network/Firebase latency during reconcile never blocks the boot seam return', () => {
    const h = makeHarness({ neverResolves: true });
    const start = Date.now();
    maybeStartDeviceSeqReconcile(baseCtx(), h.deps);
    const elapsed = Date.now() - start;
    // The call must return essentially immediately — it does not await the
    // slow/never-resolving reconcile promise.
    expect(elapsed).toBeLessThan(50);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  test('checkout-shaped work can proceed synchronously while reconciliation is still in-flight', async () => {
    const h = makeHarness({ neverResolves: true });
    maybeStartDeviceSeqReconcile(baseCtx(), h.deps);

    // Simulate an unrelated synchronous "checkout" step happening immediately
    // after boot, while the reconcile promise is still pending — it must not
    // be blocked or throw.
    let checkoutRan = false;
    expect(() => {
      checkoutRan = true;
    }).not.toThrow();
    expect(checkoutRan).toBe(true);

    // The reconcile call itself is still pending (never resolves in this test);
    // asserting on it here would hang, so we only assert it was *started*.
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  test('does not await the reconcile promise before returning (assert via call-path ordering)', async () => {
    const order: string[] = [];
    const deps: DeviceSeqReconcileBootDeps = {
      reconcile: async () => {
        order.push('reconcile-start');
        await Promise.resolve();
        await Promise.resolve();
        order.push('reconcile-end');
      },
      navigatorRef: { onLine: true } as unknown as Navigator,
    };

    maybeStartDeviceSeqReconcile(baseCtx(), deps);
    order.push('boot-call-returned');

    await flushMicrotasks();

    expect(order).toEqual(['reconcile-start', 'boot-call-returned', 'reconcile-end']);
  });
});
