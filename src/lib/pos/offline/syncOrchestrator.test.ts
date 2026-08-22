import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { User as FirebaseUser } from 'firebase/auth';
import appShellSource from '../../../components/AppShell.tsx?raw';
import orchestratorSource from './syncOrchestrator.ts?raw';
import {
  CHANNEL_ORDER,
  SYNC_ORCHESTRATOR_BACKOFF_CAP_MS,
  SYNC_ORCHESTRATOR_BOOT_DELAY_MS,
  SYNC_ORCHESTRATOR_CH1_LOCK,
  SYNC_ORCHESTRATOR_INTERVAL_MS,
  SYNC_ORCHESTRATOR_LOCK,
  SYNC_ORCHESTRATOR_MAX_ATTEMPTS,
  SYNC_ORCHESTRATOR_MAX_CYCLE_DURATION_MS,
  SYNC_ORCHESTRATOR_ONLINE_DEBOUNCE_MS,
  SYNC_ORCHESTRATOR_PER_CHANNEL_ITEM_CAP,
  __getRetryLedgerForTests,
  __resetSyncOrchestratorForTests,
  __syncOrchestratorPendingCycleForTests,
  computeBackoffDelayMs,
  computeBackoffDelayMsPreJitter,
  maybeStartSyncOrchestrator,
  readSyncOrchestratorState,
  requestSyncOrchestratorCycle,
  type ChannelRunResult,
  type SyncOrchestratorAuthContext,
  type SyncOrchestratorDeps,
} from './syncOrchestrator';

const FAKE_USER = { uid: 'u1' } as unknown as FirebaseUser;

function baseCtx(
  over: Partial<SyncOrchestratorAuthContext> = {},
): { current: SyncOrchestratorAuthContext } {
  return {
    current: {
      session: {},
      branchId: 'LDP-001',
      firebaseUser: FAKE_USER,
      ...over,
    },
  };
}

type Scheduled = { id: number; ms: number; fn: () => void; kind: 'timeout' | 'interval'; cleared?: boolean };

function channelOk(channel: ChannelRunResult['channel']): ChannelRunResult {
  return { channel, status: 'ok', itemsAdvanced: 0 };
}

function makeHarness(opts?: {
  onLine?: boolean;
  locks?: 'acquire' | 'held' | 'none' | 'throw';
  ch1Held?: boolean;
  claims?: Record<string, unknown> | 'throw';
  lookupNull?: boolean;
  hangCh4?: boolean;
  neverSettleCh4?: boolean;
  throwCh4?: boolean;
  rejectCh4?: boolean;
  failCh3?: boolean;
  countTerminal?: number;
}) {
  const calls: ChannelRunResult['channel'][] = [];
  const lockNames: string[] = [];
  const listeners: Record<string, Array<() => void>> = { online: [], offline: [] };
  const timeouts: Scheduled[] = [];
  const intervals: Scheduled[] = [];
  let nextId = 1;
  let hangRelease: (() => void) | null = null;
  let hung = false;
  let hangOnce = opts?.hangCh4 === true;
  let cycleLockHeld = false;
  let cycleLockReleaseCount = 0;

  const run = (channel: ChannelRunResult['channel']) => {
    if (channel === 'offline_reversal' && opts?.throwCh4) throw new Error('ch4 boom');
    calls.push(channel);
    if (channel === 'offline_reversal' && opts?.rejectCh4) {
      return Promise.reject(new Error('ch4 reject'));
    }
    if (channel === 'offline_reversal' && opts?.neverSettleCh4) {
      return new Promise<ChannelRunResult>(() => {});
    }
    if (channel === 'offline_reversal' && hangOnce) {
      hangOnce = false;
      hung = true;
      return new Promise<ChannelRunResult>((resolve) => {
        hangRelease = () => resolve(channelOk(channel));
      });
    }
    if (channel === 'trusted_resume' && opts?.failCh3) {
      return Promise.resolve({ channel, status: 'failed' as const, errorClass: 'orchestration_error' });
    }
    return Promise.resolve(channelOk(channel));
  };

  let locks: unknown;
  if (opts?.locks === 'acquire' || opts?.ch1Held) {
    locks = {
      request: async (
        name: string,
        options: { ifAvailable?: boolean },
        cb: (lock: unknown | null) => Promise<void> | void,
      ) => {
        lockNames.push(name);
        expect(options.ifAvailable).toBe(true);
        if (opts?.ch1Held && name === SYNC_ORCHESTRATOR_CH1_LOCK) return cb(null);
        if (name === SYNC_ORCHESTRATOR_LOCK) {
          cycleLockHeld = true;
          try {
            return await cb({ name });
          } finally {
            cycleLockHeld = false;
            cycleLockReleaseCount += 1;
          }
        }
        return cb({ name });
      },
    };
  } else if (opts?.locks === 'held') {
    locks = {
      request: async (
        name: string,
        options: { ifAvailable?: boolean },
        cb: (lock: unknown | null) => Promise<void> | void,
      ) => {
        lockNames.push(name);
        expect(options.ifAvailable).toBe(true);
        return cb(null);
      },
    };
  } else if (opts?.locks === 'throw') {
    locks = {
      request: async () => {
        throw new Error('locks exploded');
      },
    };
  } else {
    locks = undefined;
  }

  const navigatorRef = {
    onLine: opts?.onLine ?? true,
    ...(locks ? { locks } : {}),
  } as unknown as Navigator;

  const deps: SyncOrchestratorDeps = {
    now: () => Date.now(),
    random: () => 0.5,
    navigatorRef,
    getClaims: async () => {
      if (opts?.claims === 'throw') throw new Error('token boom');
      return { claims: (opts?.claims as Record<string, unknown>) ?? { staffId: 'staff-1' } };
    },
    createLookup: (() => (opts?.lookupNull ? null : async () => ({ exists: true }))) as SyncOrchestratorDeps['createLookup'],
    runCh4: () => run('offline_reversal'),
    runCh5: () => run('void_intent'),
    runCh2: () => run('shift_intent'),
    runCh1: () => run('sale_intent'),
    runCh3: () => run('trusted_resume'),
    countTerminal: async () => opts?.countTerminal ?? 0,
    addEventListener: (type, fn) => {
      listeners[type].push(fn);
    },
    removeEventListener: (type, fn) => {
      listeners[type] = listeners[type].filter((x) => x !== fn);
    },
    setTimeoutFn: (fn, ms) => {
      const id = nextId++;
      timeouts.push({ id, ms, fn, kind: 'timeout' });
      return id;
    },
    clearTimeoutFn: (id) => {
      const row = timeouts.find((t) => t.id === id);
      if (row) row.cleared = true;
    },
    setIntervalFn: (fn, ms) => {
      const id = nextId++;
      intervals.push({ id, ms, fn, kind: 'interval' });
      return id;
    },
    clearIntervalFn: (id) => {
      const row = intervals.find((t) => t.id === id);
      if (row) row.cleared = true;
    },
  };

  return {
    deps,
    calls,
    lockNames,
    listeners,
    timeouts,
    intervals,
    fireBoot: () => {
      const boot = timeouts.find((t) => t.ms === SYNC_ORCHESTRATOR_BOOT_DELAY_MS && !t.cleared);
      boot?.fn();
    },
    fireOnlineDebounce: () => {
      const row = timeouts.find((t) => t.ms === SYNC_ORCHESTRATOR_ONLINE_DEBOUNCE_MS && !t.cleared);
      row?.fn();
    },
    fireInterval: () => {
      const row = intervals.find((t) => t.ms === SYNC_ORCHESTRATOR_INTERVAL_MS && !t.cleared);
      row?.fn();
    },
    releaseHang: () => hangRelease?.(),
    isCycleLockHeld: () => cycleLockHeld,
    cycleLockReleaseCount: () => cycleLockReleaseCount,
    waitUntilHung: async () => {
      const start = Date.now();
      while (!hung) {
        if (Date.now() - start > 2_000) throw new Error('CH-4 did not hang');
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    awaitCycle: async () => {
      const p = __syncOrchestratorPendingCycleForTests();
      if (p) await p;
    },
  };
}

beforeEach(() => {
  __resetSyncOrchestratorForTests();
});

afterEach(() => {
  __resetSyncOrchestratorForTests();
});

describe('syncOrchestrator source / AppShell placement', () => {
  it('does not call indexedDB.open or import trustedOrchestrationOwner', () => {
    expect(orchestratorSource).not.toMatch(/indexedDB\.open\s*\(/);
    expect(orchestratorSource).not.toMatch(/from\s+['"][^'"]*trustedOrchestrationOwner['"]/);
    expect(orchestratorSource).not.toMatch(/\binitializeActiveCartSaleSubmission\b/);
    expect(orchestratorSource).not.toMatch(/proveRollbackSafe/);
  });

  it('CH-4 default drain omits proveRollbackSafe and uses the item cap', () => {
    expect(orchestratorSource).toMatch(
      /syncOneReversal\(store, item\.id, call, \{ owner: input\.deviceId \}\)/,
    );
    expect(orchestratorSource).toMatch(/slice\(0, SYNC_ORCHESTRATOR_PER_CHANNEL_ITEM_CAP\)/);
    expect(SYNC_ORCHESTRATOR_PER_CHANNEL_ITEM_CAP).toBe(25);
  });

  it('mounts useSyncOrchestrator above the sweep/reconcile pair, never between them', () => {
    const orch = appShellSource.indexOf('useSyncOrchestrator()');
    const sweep = appShellSource.indexOf('useSaleIntentSweepBoot()');
    const recon = appShellSource.indexOf('useDeviceSeqReconcileBoot()');
    expect(orch).toBeGreaterThan(-1);
    expect(orch).toBeLessThan(sweep);
    expect(sweep).toBeLessThan(recon);
    const between = appShellSource.slice(sweep, recon);
    expect(between).not.toMatch(/useSyncOrchestrator/);
    expect(between.split('\n').length).toBeLessThanOrEqual(4);
  });

  it('uses the documented channel order', () => {
    expect([...CHANNEL_ORDER]).toEqual([
      'offline_reversal',
      'void_intent',
      'shift_intent',
      'sale_intent',
      'trusted_resume',
    ]);
  });
});

describe('syncOrchestrator backoff', () => {
  it('produces the documented pre-jitter schedule and cap', () => {
    expect(computeBackoffDelayMsPreJitter(1)).toBe(5_000);
    expect(computeBackoffDelayMsPreJitter(2)).toBe(10_000);
    expect(computeBackoffDelayMsPreJitter(3)).toBe(20_000);
    expect(computeBackoffDelayMsPreJitter(4)).toBe(40_000);
    expect(computeBackoffDelayMsPreJitter(5)).toBe(80_000);
    expect(computeBackoffDelayMsPreJitter(6)).toBe(160_000);
    expect(computeBackoffDelayMsPreJitter(7)).toBe(SYNC_ORCHESTRATOR_BACKOFF_CAP_MS);
    expect(computeBackoffDelayMsPreJitter(8)).toBe(SYNC_ORCHESTRATOR_BACKOFF_CAP_MS);
  });

  it('keeps jitter within +/-20%', () => {
    const pre = computeBackoffDelayMsPreJitter(3);
    expect(computeBackoffDelayMs(3, () => 0)).toBe(Math.round(pre * 0.8));
    expect(computeBackoffDelayMs(3, () => 1)).toBe(Math.round(pre * 1.2));
    expect(computeBackoffDelayMs(3, () => 0.5)).toBe(pre);
  });
});

describe('syncOrchestrator triggers', () => {
  it('T-01/T-02 APP_BOOT fires once after the boot delay, not before', async () => {
    const h = makeHarness();
    maybeStartSyncOrchestrator(baseCtx(), h.deps);
    expect(h.calls).toEqual([]);
    h.fireBoot();
    await h.awaitCycle();
    expect(h.calls[0]).toBe('offline_reversal');
    expect(h.calls).toContain('void_intent');
    expect(h.calls).not.toContain('sale_intent');
  });

  it('T-03/T-04 online debounce coalesces to one cycle', async () => {
    const h = makeHarness();
    maybeStartSyncOrchestrator(baseCtx(), h.deps);
    h.listeners.online.forEach((fn) => fn());
    h.listeners.online.forEach((fn) => fn());
    h.listeners.online.forEach((fn) => fn());
    const pendingDebounce = h.timeouts.filter(
      (t) => t.ms === SYNC_ORCHESTRATOR_ONLINE_DEBOUNCE_MS && !t.cleared,
    );
    expect(pendingDebounce).toHaveLength(1);
    h.fireOnlineDebounce();
    await h.awaitCycle();
    expect(h.calls.filter((c) => c === 'offline_reversal')).toHaveLength(1);
  });

  it('T-05 offline flap inside the debounce window cancels the cycle', async () => {
    const h = makeHarness();
    maybeStartSyncOrchestrator(baseCtx(), h.deps);
    h.listeners.online.forEach((fn) => fn());
    h.listeners.offline.forEach((fn) => fn());
    const live = h.timeouts.filter(
      (t) => t.ms === SYNC_ORCHESTRATOR_ONLINE_DEBOUNCE_MS && !t.cleared,
    );
    expect(live).toHaveLength(0);
    expect(h.calls).toEqual([]);
  });

  it('T-06 interval fires a cycle', async () => {
    const h = makeHarness();
    maybeStartSyncOrchestrator(baseCtx(), h.deps);
    h.fireInterval();
    await h.awaitCycle();
    expect(h.calls[0]).toBe('offline_reversal');
    expect(h.calls).toContain('sale_intent');
  });

  it('T-07/T-08 manual fires immediately; offline is refused with a reason', async () => {
    const online = makeHarness();
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, online.deps);
    const outcome = await requestSyncOrchestratorCycle('ops', ctx, online.deps);
    expect(outcome.trigger).toBe('MANUAL_INVOCATION');
    expect(outcome.ran).toBe(true);

    const offline = makeHarness({ onLine: false });
    const refused = await requestSyncOrchestratorCycle('ops', baseCtx(), offline.deps);
    expect(refused.ran).toBe(false);
    expect(refused.reason).toBe('offline');
    expect(offline.calls).toEqual([]);
  });

  it('T-12 CH-1 is excluded on APP_BOOT and included on interval', async () => {
    const h = makeHarness();
    maybeStartSyncOrchestrator(baseCtx(), h.deps);
    h.fireBoot();
    await h.awaitCycle();
    expect(h.calls).not.toContain('sale_intent');
    h.calls.length = 0;
    h.fireInterval();
    await h.awaitCycle();
    expect(h.calls).toContain('sale_intent');
  });
});

describe('syncOrchestrator gates', () => {
  const cases: Array<{ name: string; over: Partial<SyncOrchestratorAuthContext>; extra?: Parameters<typeof makeHarness>[0]; reason: string }> = [
    { name: 'no_firebase', over: {}, extra: { lookupNull: true }, reason: 'no_firebase' },
    { name: 'no_session', over: { session: null }, reason: 'no_session' },
    { name: 'no_branch', over: { branchId: null }, reason: 'no_branch' },
    { name: 'branch_all', over: { branchId: 'ALL' }, reason: 'branch_all' },
    { name: 'no_firebase_user', over: { firebaseUser: null }, reason: 'no_firebase_user' },
    { name: 'no_staff_claim', over: {}, extra: { claims: {} }, reason: 'no_staff_claim' },
    { name: 'offline', over: {}, extra: { onLine: false }, reason: 'offline' },
  ];

  for (const row of cases) {
    it(`T-09 ${row.name} skips every adapter`, async () => {
      const h = makeHarness(row.extra);
      const ctx = baseCtx(row.over);
      maybeStartSyncOrchestrator(ctx, h.deps);
      h.fireBoot();
      await h.awaitCycle();
      expect(h.calls).toEqual([]);
      expect(readSyncOrchestratorState().lastCycle?.gateSkipReason).toBe(row.reason);
    });
  }

  it('T-10 gates are re-evaluated every cycle from the live ctx ref', async () => {
    const h = makeHarness();
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    const first = await requestSyncOrchestratorCycle('a', ctx, h.deps);
    expect(first.ran).toBe(true);
    ctx.current = { ...ctx.current, branchId: 'ALL' };
    h.calls.length = 0;
    const second = await requestSyncOrchestratorCycle('b', ctx, h.deps);
    expect(second.ran).toBe(false);
    expect(second.reason).toBe('branch_all');
    expect(h.calls).toEqual([]);
  });
});

describe('syncOrchestrator StrictMode / re-entrancy', () => {
  it('T-13/T-16 mount-unmount-mount fires exactly one boot cycle (flag at fire time)', async () => {
    const h = makeHarness();
    const ctx = baseCtx();
    const stop = maybeStartSyncOrchestrator(ctx, h.deps);
    stop();
    const stop2 = maybeStartSyncOrchestrator(ctx, h.deps);
    const boots = h.timeouts.filter((t) => t.ms === SYNC_ORCHESTRATOR_BOOT_DELAY_MS);
    expect(boots[0]?.cleared).toBe(true);
    boots[1]?.fn();
    await h.awaitCycle();
    expect(h.calls.filter((c) => c === 'offline_reversal')).toHaveLength(1);
    stop2();
  });

  it('T-14/T-15 double mount nets one online listener and one interval', () => {
    const h = makeHarness();
    const ctx = baseCtx();
    const stop = maybeStartSyncOrchestrator(ctx, h.deps);
    stop();
    maybeStartSyncOrchestrator(ctx, h.deps);
    expect(h.listeners.online).toHaveLength(1);
    expect(h.intervals.filter((i) => !i.cleared)).toHaveLength(1);
  });

  it('T-17 second start while in-flight returns the same promise', async () => {
    const h = makeHarness({ hangCh4: true });
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    const a = requestSyncOrchestratorCycle('a', ctx, h.deps);
    await h.waitUntilHung();
    const b = requestSyncOrchestratorCycle('b', ctx, h.deps);
    expect(b).toBe(a);
    h.releaseHang();
    await a;
  });

  it('T-18 interval during in-flight is dropped', async () => {
    const h = makeHarness({ hangCh4: true });
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    const p = requestSyncOrchestratorCycle('a', ctx, h.deps);
    await h.waitUntilHung();
    h.fireInterval();
    h.releaseHang();
    await p;
    expect(h.calls.filter((c) => c === 'offline_reversal')).toHaveLength(1);
  });

  it('T-19/T-20 coalesced online requests produce at most one follow-up', async () => {
    const h = makeHarness({ hangCh4: true });
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    const first = requestSyncOrchestratorCycle('a', ctx, h.deps);
    await h.waitUntilHung();
    h.listeners.online.forEach((fn) => fn());
    h.fireOnlineDebounce();
    h.listeners.online.forEach((fn) => fn());
    h.fireOnlineDebounce();
    h.releaseHang();
    await first;
    await h.awaitCycle();
    expect(h.calls.filter((c) => c === 'offline_reversal').length).toBeLessThanOrEqual(2);
  });
});

describe('syncOrchestrator locks', () => {
  it('T-21/T-22 held cycle lock skips all adapters and uses the documented name', async () => {
    const h = makeHarness({ locks: 'held' });
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    await requestSyncOrchestratorCycle('a', ctx, h.deps);
    expect(h.calls).toEqual([]);
    expect(h.lockNames).toEqual([SYNC_ORCHESTRATOR_LOCK]);
    expect(readSyncOrchestratorState().lastCycle?.gateSkipReason).toBe('lock_held');
  });

  it('T-23 CH-1 nested lock held skips only CH-1', async () => {
    const h = makeHarness({ locks: 'acquire', ch1Held: true });
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    await requestSyncOrchestratorCycle('a', ctx, h.deps);
    expect(h.lockNames).toContain(SYNC_ORCHESTRATOR_LOCK);
    expect(h.lockNames).toContain(SYNC_ORCHESTRATOR_CH1_LOCK);
    expect(h.calls).toEqual(['offline_reversal', 'void_intent', 'shift_intent', 'trusted_resume']);
    const ch1 = readSyncOrchestratorState().lastCycle?.channels.find((c) => c.channel === 'sale_intent');
    expect(ch1).toMatchObject({ status: 'skipped', skipReason: 'lock_held' });
  });

  it('T-24/T-27 locks unavailable still runs and records webLocksAvailable false', async () => {
    const h = makeHarness({ locks: 'none' });
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    await requestSyncOrchestratorCycle('a', ctx, h.deps);
    expect(h.calls).toContain('offline_reversal');
    expect(readSyncOrchestratorState().webLocksAvailable).toBe(false);
  });

  it('T-25 locks.request throw fail-opens', async () => {
    const h = makeHarness({ locks: 'throw' });
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    const outcome = await requestSyncOrchestratorCycle('a', ctx, h.deps);
    expect(outcome.ran).toBe(true);
    expect(h.calls[0]).toBe('offline_reversal');
  });
});

describe('syncOrchestrator channels', () => {
  it('T-31 runs CH-4 → CH-5 → CH-2 → CH-1 → CH-3', async () => {
    const h = makeHarness();
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    await requestSyncOrchestratorCycle('a', ctx, h.deps);
    expect(h.calls).toEqual([
      'offline_reversal',
      'void_intent',
      'shift_intent',
      'sale_intent',
      'trusted_resume',
    ]);
  });

  it('T-32/T-33 a thrown channel is failed and the cycle continues', async () => {
    const h = makeHarness({ throwCh4: true });
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    const outcome = await requestSyncOrchestratorCycle('a', ctx, h.deps);
    expect(outcome.ran).toBe(true);
    expect(h.calls).toEqual(['void_intent', 'shift_intent', 'sale_intent', 'trusted_resume']);
    expect(outcome.channels[0]).toMatchObject({ channel: 'offline_reversal', status: 'failed' });
  });

  it('T-33 a rejected channel promise does not reject the cycle', async () => {
    const h = makeHarness({ rejectCh4: true });
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    await expect(requestSyncOrchestratorCycle('a', ctx, h.deps)).resolves.toMatchObject({ ran: true });
    expect(h.calls).toContain('void_intent');
  });

  it('T-42 wall-clock cap marks remaining channels skipped/capped', async () => {
    let t = 1_000;
    const h = makeHarness();
    h.deps.now = () => t;
    const originalCh4 = h.deps.runCh4!;
    h.deps.runCh4 = async (input) => {
      const result = await originalCh4(input);
      t += SYNC_ORCHESTRATOR_MAX_CYCLE_DURATION_MS;
      return result;
    };
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    const outcome = await requestSyncOrchestratorCycle('a', ctx, h.deps);
    expect(outcome.channels.slice(1).every((c) => c.skipReason === 'capped')).toBe(true);
    expect(outcome.completed).toBe(false);
  });

  it('T-44 MANUAL clears nextEligibleAtMs but not attempts; T-46 exhausted stays distinguishable', async () => {
    const ledger = __getRetryLedgerForTests();
    ledger.set('offline_reversal:x', {
      attempts: 2,
      nextEligibleAtMs: 9_999_999,
      lastErrorClass: 'transport',
    });
    ledger.set('offline_reversal:y', {
      attempts: SYNC_ORCHESTRATOR_MAX_ATTEMPTS,
      nextEligibleAtMs: 9_999_999,
      lastErrorClass: 'transport',
    });
    const h = makeHarness();
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    await requestSyncOrchestratorCycle('a', ctx, h.deps);
    expect(ledger.get('offline_reversal:x')?.attempts).toBe(2);
    expect(ledger.get('offline_reversal:x')?.nextEligibleAtMs).toBe(0);
    expect(ledger.get('offline_reversal:y')?.attempts).toBe(SYNC_ORCHESTRATOR_MAX_ATTEMPTS);
    expect(ledger.get('offline_reversal:y')?.nextEligibleAtMs).toBe(9_999_999);
    expect(readSyncOrchestratorState().ch4AttemptExhaustedIds).toContain('offline_reversal:y');
  });

  it('T-45 WINDOW_ONLINE does not reset backoff', async () => {
    const ledger = __getRetryLedgerForTests();
    ledger.set('offline_reversal:x', {
      attempts: 3,
      nextEligibleAtMs: 8_888,
      lastErrorClass: 'transport',
    });
    const h = makeHarness();
    maybeStartSyncOrchestrator(baseCtx(), h.deps);
    h.listeners.online.forEach((fn) => fn());
    h.fireOnlineDebounce();
    await h.awaitCycle();
    expect(ledger.get('offline_reversal:x')?.attempts).toBe(3);
    expect(ledger.get('offline_reversal:x')?.nextEligibleAtMs).toBe(8_888);
  });

  it('T-50/T-51/T-52/T-53 state export is serializable, pure, and CH-3 console-only', async () => {
    const h = makeHarness({ failCh3: true, countTerminal: 4 });
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    const before = readSyncOrchestratorState().cycleCount;
    structuredClone(readSyncOrchestratorState());
    expect(readSyncOrchestratorState().cycleCount).toBe(before);
    await requestSyncOrchestratorCycle('a', ctx, h.deps);
    const state = readSyncOrchestratorState();
    expect(() => structuredClone(state)).not.toThrow();
    expect(state.terminalVoidIntentCount).toBe(4);
    const ch3 = state.lastCycle?.channels.find((c) => c.channel === 'trusted_resume');
    expect(ch3?.status).toBe('failed');
    expect(JSON.stringify(state)).not.toMatch(/toast|operatorMessage|manualReview/);
  });

  it('T-29 unmount clears the interval', () => {
    const h = makeHarness();
    const stop = maybeStartSyncOrchestrator(baseCtx(), h.deps);
    stop();
    expect(h.intervals.every((i) => i.cleared)).toBe(true);
  });

  it('T-36 source: CH-4 transport construction failure is skipped, not aborted', () => {
    expect(orchestratorSource).toMatch(/skipReason: 'transport_unavailable'/);
  });

  it('RC-2 CH-5 default drain is scoped to current branch/device and current-cycle staffId', () => {
    expect(orchestratorSource).toMatch(
      /listClaimableVoidIntents\(\s*store,\s*input\.nowMs,\s*\{[\s\S]*branchId:\s*input\.branchId[\s\S]*deviceId:\s*input\.deviceId/,
    );
    expect(orchestratorSource).toMatch(/currentStaffId:\s*input\.staffId/);
  });

  it('re-evaluates current staff identity every cycle and passes it to CH-5', async () => {
    const seen: string[] = [];
    let staffId = 'staff-A';
    const h = makeHarness();
    h.deps.getClaims = async () => ({ claims: { staffId } });
    h.deps.runCh5 = async (input) => {
      seen.push(input.staffId);
      return channelOk('void_intent');
    };
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    await requestSyncOrchestratorCycle('a', ctx, h.deps);
    staffId = 'staff-B';
    await requestSyncOrchestratorCycle('b', ctx, h.deps);
    expect(seen).toEqual(['staff-A', 'staff-B']);
  });
});

describe('syncOrchestrator RC-1 true cycle deadline', () => {
  it('a never-settling CH-4 is capped at 20s, remaining channels skipped, lock released, next cycle runs', async () => {
    const h = makeHarness({ neverSettleCh4: true, locks: 'acquire' });
    let now = 1_000;
    h.deps.now = () => now;
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    const first = requestSyncOrchestratorCycle('hang', ctx, h.deps);
    const waitStart = Date.now();
    while (
      !h.timeouts.some((t) => t.ms === SYNC_ORCHESTRATOR_MAX_CYCLE_DURATION_MS && !t.cleared)
    ) {
      if (Date.now() - waitStart > 2_000) throw new Error('deadline timer was not scheduled');
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(h.isCycleLockHeld()).toBe(true);
    expect(__syncOrchestratorPendingCycleForTests()).not.toBeNull();
    const deadline = h.timeouts.find(
      (t) => t.ms === SYNC_ORCHESTRATOR_MAX_CYCLE_DURATION_MS && !t.cleared,
    );
    expect(deadline).toBeTruthy();
    deadline!.fn();
    const outcome = await first;
    expect(outcome.ran).toBe(true);
    expect(outcome.completed).toBe(false);
    expect(outcome.channels).toHaveLength(CHANNEL_ORDER.length);
    expect(outcome.channels.every((c) => c.skipReason === 'capped')).toBe(true);
    expect(h.isCycleLockHeld()).toBe(false);
    expect(h.cycleLockReleaseCount()).toBeGreaterThanOrEqual(1);
    expect(__syncOrchestratorPendingCycleForTests()).toBeNull();
    expect(h.calls.filter((c) => c === 'offline_reversal')).toHaveLength(1);
    expect(h.calls).not.toContain('void_intent');

    h.deps.runCh4 = async () => channelOk('offline_reversal');
    const second = await requestSyncOrchestratorCycle('after-timeout', ctx, h.deps);
    expect(second.ran).toBe(true);
    expect(second.channels[0]).toMatchObject({ channel: 'offline_reversal', status: 'ok' });
    expect(second.channels.some((c) => c.channel === 'void_intent' && c.status === 'ok')).toBe(true);
  });

  it('late settlement of an abandoned runner cannot corrupt a newer cycle state or retry ledger', async () => {
    const h = makeHarness({ hangCh4: true, locks: 'acquire', countTerminal: 1 });
    const now = 1_000;
    h.deps.now = () => now;
    const ctx = baseCtx();
    maybeStartSyncOrchestrator(ctx, h.deps);
    const first = requestSyncOrchestratorCycle('hang', ctx, h.deps);
    await h.waitUntilHung();
    const deadline = h.timeouts.find(
      (t) => t.ms === SYNC_ORCHESTRATOR_MAX_CYCLE_DURATION_MS && !t.cleared,
    );
    expect(deadline).toBeTruthy();
    deadline!.fn();
    await first;
    expect(__syncOrchestratorPendingCycleForTests()).toBeNull();

    h.deps.countTerminal = async () => 9;
    h.deps.runCh4 = async () => ({
      channel: 'offline_reversal',
      status: 'ok',
      itemsAdvanced: 4,
    });
    const second = await requestSyncOrchestratorCycle('fresh', ctx, h.deps);
    expect(second.ran).toBe(true);
    expect(readSyncOrchestratorState().terminalVoidIntentCount).toBe(9);
    expect(readSyncOrchestratorState().lastCycle?.channels[0]).toMatchObject({
      channel: 'offline_reversal',
      status: 'ok',
      itemsAdvanced: 4,
    });
    const ledger = __getRetryLedgerForTests();
    ledger.set('offline_reversal:next', {
      attempts: 3,
      nextEligibleAtMs: 42,
      lastErrorClass: 'transport',
    });

    h.releaseHang();
    await Promise.resolve();
    await Promise.resolve();
    expect(readSyncOrchestratorState().terminalVoidIntentCount).toBe(9);
    expect(readSyncOrchestratorState().lastCycle?.channels[0]).toMatchObject({
      status: 'ok',
      itemsAdvanced: 4,
    });
    expect(ledger.get('offline_reversal:next')).toEqual({
      attempts: 3,
      nextEligibleAtMs: 42,
      lastErrorClass: 'transport',
    });
  });
});
