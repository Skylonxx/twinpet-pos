import { useEffect } from 'react';
import { getIdTokenResult, type User as FirebaseUser } from 'firebase/auth';
import { useAuth } from '../../hooks/useAuth';
import { createAsyncOrderServerLookup } from './asyncOrderLookup';
import { createSaleIntentJournal } from './saleIntentJournal';
import { runSaleIntentSweep } from './saleIntentSweep';

/**
 * Startup Sale Intent sweep boot wiring (Packet 3A-2B).
 *
 * A silent, fail-open, once-per-tab background task that — after the authenticated
 * POS shell (`AppShell`) has mounted and a fixed delay has elapsed — runs the
 * Packet 3A-1 `runSaleIntentSweep` exactly once, composing only public APIs:
 *   createAsyncOrderServerLookup() + createSaleIntentJournal() + runSaleIntentSweep().
 *
 * It never blocks the cashier UI, never renders, never writes React state, never
 * changes checkout/cart/payment/stock/drawer behavior, never retries/resends an
 * `asyncOrders` write, and never reads an `asyncOrder` payload. Every skip path is a
 * silent no-op — no console noise, no journal event, no UI surface.
 *
 * All logic lives in the plain, node-testable `maybeStartSaleIntentSweepBoot`; the
 * `useSaleIntentSweepBoot` hook is a one-line `useEffect` wrapper (untested by design,
 * consistent with the repo's no-DOM-harness convention — vitest env is `node`).
 */

/** Fixed post-mount delay before the one-shot background sweep fires. */
export const SALE_INTENT_SWEEP_BOOT_DELAY_MS = 10_000;

/** Cross-tab best-effort single-flight lock name (Web Locks, `ifAvailable`). */
export const SALE_INTENT_SWEEP_BOOT_LOCK = 'twinpet-sale-intent-sweep';

// Web Locks is not present in every TS `lib.dom` target and may be absent at
// runtime (older browsers, some webviews). A narrow local shape — accessed via
// an `unknown` cast — avoids a tsconfig change or a global declaration and never
// conflicts with a `lib.dom`-provided `LockManager` type.
type MinimalLockManager = {
  request: (
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown | null) => Promise<void> | void,
  ) => Promise<unknown>;
};

/** Mount-time auth/identity snapshot the boot decision reads (from `useAuth()`). */
export type SaleIntentSweepBootContext = {
  session: unknown | null;
  branchId: string | null;
  firebaseUser: FirebaseUser | null;
};

/**
 * Injectable composition seam. Every field defaults to the real public API; tests
 * override them (no `vi.mock` of Firebase needed). Kept structural so the boot
 * module retains zero import-time coupling that a test must fight.
 */
export type SaleIntentSweepBootDeps = {
  createLookup?: typeof createAsyncOrderServerLookup;
  createJournal?: typeof createSaleIntentJournal;
  runSweep?: typeof runSaleIntentSweep;
  getClaims?: (user: FirebaseUser) => Promise<{ claims: Record<string, unknown> }>;
  navigatorRef?: Navigator | undefined;
};

type ResolvedDeps = {
  createLookup: typeof createAsyncOrderServerLookup;
  createJournal: typeof createSaleIntentJournal;
  runSweep: typeof runSaleIntentSweep;
  getClaims: (user: FirebaseUser) => Promise<{ claims: Record<string, unknown> }>;
  navigatorRef: Navigator | undefined;
};

// Once-per-tab guard: module-level so it survives React StrictMode's double-effect
// and any AppShell remount. Consumed when the scheduled work actually starts (not
// at schedule time), so a StrictMode mount→unmount→mount still yields exactly one run.
let bootAttemptConsumed = false;
// Tracks the in-flight scheduled run purely so tests can deterministically await it.
let pendingRun: Promise<void> | null = null;

function resolveDeps(deps?: SaleIntentSweepBootDeps): ResolvedDeps {
  return {
    createLookup: deps?.createLookup ?? createAsyncOrderServerLookup,
    createJournal: deps?.createJournal ?? createSaleIntentJournal,
    runSweep: deps?.runSweep ?? runSaleIntentSweep,
    getClaims: deps?.getClaims ?? ((user: FirebaseUser) => getIdTokenResult(user)),
    navigatorRef:
      deps?.navigatorRef ?? (typeof navigator !== 'undefined' ? navigator : undefined),
  };
}

/**
 * The gated work itself. Runs only after every identity/config gate holds; every
 * failure path is a silent, fail-open return (the 3A-1 runner is already internally
 * fail-open — the try/catch here is belt-and-suspenders around composition).
 */
async function runGatedSweep(ctx: SaleIntentSweepBootContext, d: ResolvedDeps): Promise<void> {
  // Gate 1: Firebase configured + db available — the lookup factory is the single
  // authority for this (returns null in dev / no-Firebase, mirroring the observer).
  const lookup = d.createLookup();
  if (!lookup) return;

  // Gate 5 (defensive re-check): a rules-capable token must exist.
  if (!ctx.firebaseUser) return;

  // Gate 6: cached custom-claims must carry a staffId. `getIdTokenResult` is not
  // force-refreshed (cached, no network). This is what makes the post-auth-wipe
  // "fresh anonymous user, no claims" boot a single silent skip instead of up to
  // 50 futile permission-denied reads.
  let staffId: unknown;
  try {
    const token = await d.getClaims(ctx.firebaseUser);
    staffId = token?.claims?.staffId;
  } catch {
    // Fail-open: a token read failure is never a reason to throw into the UI.
    return;
  }
  if (staffId == null) return;

  try {
    const journal = d.createJournal();
    // 3A-1 defaults for thresholdMs (10 min) and batchLimit (50) are intentionally
    // left implicit — the boot layer adds no new bounds policy of its own.
    await d.runSweep({ journal, lookupAsyncOrder: lookup });
  } catch {
    // Fail-open — a sweep failure must never surface to the cashier.
  }
}

/**
 * Cross-tab single-flight wrapper. Web Locks (`ifAvailable`) is best-effort: if the
 * lock is held by another tab, skip silently; if Web Locks is unsupported, fall back
 * to the runner's own idempotency (matrix-guarded transitions).
 */
async function runWithSingleFlight(ctx: SaleIntentSweepBootContext, d: ResolvedDeps): Promise<void> {
  const locks = (d.navigatorRef as unknown as { locks?: MinimalLockManager } | undefined)?.locks;

  if (locks && typeof locks.request === 'function') {
    try {
      await locks.request(SALE_INTENT_SWEEP_BOOT_LOCK, { ifAvailable: true }, async (lock) => {
        // `ifAvailable` hands back null when the lock is already held elsewhere.
        if (!lock) return;
        await runGatedSweep(ctx, d);
      });
    } catch {
      // Fail-open — lock acquisition failure must never throw.
    }
    return;
  }

  // Web Locks unsupported → idempotency fallback.
  await runGatedSweep(ctx, d);
}

/**
 * Plain, node-testable boot decision. Runs the cheap synchronous gates, and if all
 * hold, schedules a single fire-and-forget background sweep after the fixed delay.
 * Returns a cleanup that cancels the pending timer (for `useEffect`), or `undefined`
 * when a gate short-circuits (nothing was scheduled).
 */
export function maybeStartSaleIntentSweepBoot(
  ctx: SaleIntentSweepBootContext,
  deps?: SaleIntentSweepBootDeps,
): (() => void) | undefined {
  const d = resolveDeps(deps);

  // Cheap synchronous gates — any failure is a silent no-op (no schedule).
  if (!ctx.session) return; // Gate 2: app session present
  if (!ctx.branchId) return; // Gate 3: a POS branch is selected
  if (ctx.branchId === 'ALL') return; // Gate 4: not the global-admin sentinel
  if (!ctx.firebaseUser) return; // Gate 5: rules-capable token exists
  if (d.navigatorRef?.onLine === false) return; // Gate 7: advisory offline pre-filter
  if (bootAttemptConsumed) return; // Gate 8: already ran once this tab

  const handle = setTimeout(() => {
    // Consume the once-per-tab guard at run time so StrictMode's mount→unmount→mount
    // (whose first timer is cleared on unmount) still produces exactly one run.
    if (bootAttemptConsumed) return;
    bootAttemptConsumed = true;
    pendingRun = runWithSingleFlight(ctx, d);
    void pendingRun;
  }, SALE_INTENT_SWEEP_BOOT_DELAY_MS);

  return () => clearTimeout(handle);
}

/**
 * React hook: one `useEffect`, mounted once from `AppShell`. Reading the mount-time
 * auth snapshot is deliberate — the sweep is once-per-app-start with no interval and
 * no re-run on auth/branch change (re-evaluation, if ever wanted, is a later packet).
 */
export function useSaleIntentSweepBoot(deps?: SaleIntentSweepBootDeps): void {
  const { session, branchId, firebaseUser } = useAuth();
  useEffect(() => {
    return maybeStartSaleIntentSweepBoot({ session, branchId, firebaseUser }, deps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** @internal test-only — reset the once-per-tab guard between tests. Not a production API. */
export function __resetSaleIntentSweepBootForTests(): void {
  bootAttemptConsumed = false;
  pendingRun = null;
}

/** @internal test-only — await the in-flight scheduled run, if any. Not a production API. */
export function __saleIntentSweepBootPendingRunForTests(): Promise<void> {
  return pendingRun ?? Promise.resolve();
}
