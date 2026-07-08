import { useEffect } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import { useAuth } from '../../hooks/useAuth';
import { reconcileLocalSeqWithServer } from '../posDeviceRegistry';

/**
 * Startup device-sequence watermark reconciliation boot wiring (Packet 3B-4).
 *
 * A silent, fail-open, once-per-tab background task that — after the
 * authenticated POS shell (`AppShell`) has mounted — reads this device's server
 * watermark (`posDevices/{deviceId}.lastSeq`) and fast-forwards the local
 * sequence base upward when it is behind, mitigating W-04 (stale local sequence
 * recovery after a localStorage wipe / stale IndexedDB mirror).
 *
 * Unlike the Sale Intent sweep boot (Packet 3A-2B), this task is scheduled
 * IMMEDIATELY after its gates pass — no fixed delay — and is never awaited by
 * the caller, so heavy network/Firebase latency during reconciliation can never
 * block UI readiness or checkout availability. A sale that completes before the
 * in-flight reconciliation resolves still uses the pre-reconciliation local
 * sequence base; that is an accepted residual risk (existing fail-open offline
 * numbering already tolerates this window), not a bug.
 *
 * All logic lives in the plain, node-testable `maybeStartDeviceSeqReconcile`;
 * the `useDeviceSeqReconcileBoot` hook is a one-line `useEffect` wrapper
 * (untested by design, consistent with the repo's no-DOM-harness convention —
 * vitest env is `node`).
 */

/** Mount-time auth/identity snapshot the boot decision reads (from `useAuth()`). */
export type DeviceSeqReconcileBootContext = {
  session: unknown | null;
  branchId: string | null;
  firebaseUser: FirebaseUser | null;
};

/**
 * Injectable composition seam. `reconcile` defaults to the real public API;
 * tests override it directly (no `vi.mock` of Firebase needed).
 */
export type DeviceSeqReconcileBootDeps = {
  reconcile?: () => Promise<void>;
  navigatorRef?: Navigator | undefined;
};

type ResolvedDeps = {
  reconcile: () => Promise<void>;
  navigatorRef: Navigator | undefined;
};

// Once-per-tab guard: module-level so it survives React StrictMode's double-effect
// and any AppShell remount.
let bootAttemptConsumed = false;
// Tracks the in-flight fire-and-forget run purely so tests can deterministically await it.
let pendingRun: Promise<void> | null = null;

function resolveDeps(deps?: DeviceSeqReconcileBootDeps): ResolvedDeps {
  return {
    reconcile: deps?.reconcile ?? (() => reconcileLocalSeqWithServer()),
    navigatorRef:
      deps?.navigatorRef ?? (typeof navigator !== 'undefined' ? navigator : undefined),
  };
}

/**
 * Plain, node-testable boot decision. Runs the cheap synchronous gates, and if
 * all hold, starts the reconciliation immediately as a fire-and-forget task —
 * it is never awaited here, so this function always returns synchronously
 * without blocking the caller (render / app readiness / checkout).
 */
export function maybeStartDeviceSeqReconcile(
  ctx: DeviceSeqReconcileBootContext,
  deps?: DeviceSeqReconcileBootDeps,
): void {
  const d = resolveDeps(deps);

  // Cheap synchronous gates — any failure is a silent no-op.
  if (!ctx.session) return; // session/user ready
  if (!ctx.branchId) return; // a POS branch is selected
  if (ctx.branchId === 'ALL') return; // not the global-admin sentinel
  if (!ctx.firebaseUser) return; // rules-capable token exists
  if (d.navigatorRef?.onLine === false) return; // advisory offline pre-filter
  if (bootAttemptConsumed) return; // already ran once this tab
  bootAttemptConsumed = true;

  // Fire-and-forget: intentionally NOT awaited before returning. Firebase
  // configuration / offline / missing-doc fail-open is handled inside
  // reconcileLocalSeqWithServer(); this catch is belt-and-suspenders so a
  // rejected promise can never surface as an unhandled rejection.
  pendingRun = d.reconcile().catch(() => {
    // Fail-open — a reconciliation failure must never surface to the cashier.
  });
}

/**
 * React hook: one `useEffect`, mounted once from `AppShell`. Reading the
 * mount-time auth snapshot is deliberate — the reconciliation is
 * once-per-app-start with no interval and no re-run on auth/branch change.
 */
export function useDeviceSeqReconcileBoot(deps?: DeviceSeqReconcileBootDeps): void {
  const { session, branchId, firebaseUser } = useAuth();
  useEffect(() => {
    maybeStartDeviceSeqReconcile({ session, branchId, firebaseUser }, deps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** @internal test-only — reset the once-per-tab guard between tests. Not a production API. */
export function __resetDeviceSeqReconcileBootForTests(): void {
  bootAttemptConsumed = false;
  pendingRun = null;
}

/** @internal test-only — await the in-flight fire-and-forget run, if any. Not a production API. */
export function __deviceSeqReconcileBootPendingRunForTests(): Promise<void> {
  return pendingRun ?? Promise.resolve();
}
