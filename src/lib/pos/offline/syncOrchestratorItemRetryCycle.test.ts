import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User as FirebaseUser } from 'firebase/auth';
import orchestratorSource from './syncOrchestrator.ts?raw';
import { createInMemoryReversalStore, type ReversalLocalStore, type ReversalStoreName } from './reversalLocalStore';
import type { OfflineReversalIntent } from './offlineReversalTypes';
import {
  CHANNEL_ORDER,
  SYNC_ORCHESTRATOR_CH1_LOCK,
  SYNC_ORCHESTRATOR_LOCK,
  SYNC_ORCHESTRATOR_MAX_ATTEMPTS,
  __getRetryLedgerForTests,
  __resetSyncOrchestratorForTests,
  __syncOrchestratorPendingCycleForTests,
  clearOfflineReversalRetryEligibility,
  readSyncOrchestratorState,
  requestSyncOrchestratorCycle,
  requestSyncOrchestratorItemRetryCycle,
  type ChannelRunResult,
  type SyncOrchestratorAuthContext,
  type SyncOrchestratorDeps,
} from './syncOrchestrator';
import * as voidStore from './voidIntentStore';
import {
  __resetCanonicalSyncContextForTests,
  __setCanonicalSyncContextForTests,
} from './canonicalSyncContext';

const FAKE_USER = { uid: 'u1' } as unknown as FirebaseUser;
const NOW = 1_700_000_000_000;

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

  const run = (channel: ChannelRunResult['channel']) => {
    calls.push(channel);
    if (channel === 'offline_reversal' && hangOnce) {
      hangOnce = false;
      hung = true;
      return new Promise<ChannelRunResult>((resolve) => {
        hangRelease = () => resolve(channelOk(channel));
      });
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
        if (name === SYNC_ORCHESTRATOR_LOCK) return cb({ name });
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
    locks = { request: async () => { throw new Error('locks exploded'); } };
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
    countTerminal: async () => 0,
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
    releaseHang: () => hangRelease?.(),
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

function reversalIntent(id: string, branchId: string, status: OfflineReversalIntent['status']): OfflineReversalIntent {
  return {
    id,
    businessId: 'biz',
    sourceType: 'receiving',
    sourceId: 'src',
    action: 'void',
    branchId,
    reasonCode: 'x',
    createdAt: new Date(NOW).toISOString(),
    createdByStaffId: 's1',
    createdByRole: 'manager',
    idempotencyKey: 'k',
    localMutationId: 'm',
    localCorrection: { applied: true, reversed: false, stockDelta: [] },
    status,
  };
}

async function putIntent(store: ReversalLocalStore, intent: OfflineReversalIntent): Promise<void> {
  await store.transact(['intents'], 'readwrite', async (txn) => {
    await txn.put('intents', intent.id, intent);
  });
}

function wrapDeferredGet(
  inner: ReversalLocalStore,
  match: (store: ReversalStoreName, key: string) => boolean,
): { store: ReversalLocalStore; release: () => void; waiting: () => boolean; ledgerSets: number } {
  let resolveHold: () => void = () => undefined;
  const hold = new Promise<void>((r) => {
    resolveHold = r;
  });
  let waiting = false;
  return {
    waiting: () => waiting,
    ledgerSets: 0,
    release: () => resolveHold(),
    store: {
      transact: (stores, mode, fn) =>
        inner.transact(stores, mode, (txn) =>
          fn({
            get: async (store, key) => {
              if (match(store, key)) {
                waiting = true;
                await hold;
              }
              return txn.get(store, key);
            },
            getAll: (store) => txn.getAll(store),
            put: (store, key, value) => txn.put(store, key, value),
            delete: (store, key) => txn.delete(store, key),
          }),
        ),
    },
  };
}

async function waitUntil(pred: () => boolean): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 2_000) throw new Error('timed out waiting for getIntent');
    await Promise.resolve();
  }
}

beforeEach(() => {
  __resetSyncOrchestratorForTests();
  __resetCanonicalSyncContextForTests();
});

afterEach(() => {
  __resetSyncOrchestratorForTests();
  __resetCanonicalSyncContextForTests();
  vi.restoreAllMocks();
});

describe('requestSyncOrchestratorItemRetryCycle', () => {
  it('source: item cycle uses none; global uses global_eligibility_reset; policy is private', () => {
    expect(orchestratorSource).toMatch(/requestCycleWithPolicy\('none'/);
    expect(orchestratorSource).toMatch(/requestCycleWithPolicy\('global_eligibility_reset'/);
    expect(orchestratorSource).not.toMatch(/export type PreCycleResetPolicy/);
  });

  it('N-R2-2 target reversal ledger is cleared; unrelated below-ceiling entry is unchanged', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    await putIntent(store, reversalIntent('r1', 'A', 'queued'));
    const ledger = __getRetryLedgerForTests();
    ledger.set('offline_reversal:r1', { attempts: 3, nextEligibleAtMs: 9_999, lastErrorClass: 'transport' });
    ledger.set('offline_reversal:r2', { attempts: 2, nextEligibleAtMs: 8_888, lastErrorClass: 'transport' });
    const outcome = await clearOfflineReversalRetryEligibility(store, 'r1', NOW);
    expect(outcome).toBe('cleared');
    expect(ledger.get('offline_reversal:r1')).toEqual({
      attempts: 3,
      nextEligibleAtMs: 0,
      lastErrorClass: 'transport',
    });
    expect(ledger.get('offline_reversal:r2')).toEqual({
      attempts: 2,
      nextEligibleAtMs: 8_888,
      lastErrorClass: 'transport',
    });
  });

  it('N-R2-3 item cycle does not invoke global clearVoidIntentBackoff', async () => {
    const spy = vi.spyOn(voidStore, 'clearVoidIntentBackoff').mockResolvedValue(0);
    const h = makeHarness();
    const ctx = baseCtx();
    const outcome = await requestSyncOrchestratorItemRetryCycle(ctx, h.deps);
    expect(outcome.ran).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('N-R2-4 item cycle still applies the gate ladder', async () => {
    const cases: Array<{
      name: string;
      over: Partial<SyncOrchestratorAuthContext>;
      extra?: Parameters<typeof makeHarness>[0];
      reason: string;
    }> = [
      { name: 'no_firebase', over: {}, extra: { lookupNull: true }, reason: 'no_firebase' },
      { name: 'no_session', over: { session: null }, reason: 'no_session' },
      { name: 'no_branch', over: { branchId: null }, reason: 'no_branch' },
      { name: 'branch_all', over: { branchId: 'ALL' }, reason: 'branch_all' },
      { name: 'no_firebase_user', over: { firebaseUser: null }, reason: 'no_firebase_user' },
      { name: 'no_staff_claim', over: {}, extra: { claims: {} }, reason: 'no_staff_claim' },
    ];
    for (const row of cases) {
      __resetSyncOrchestratorForTests();
      const h = makeHarness(row.extra);
      const ctx = baseCtx(row.over);
      const outcome = await requestSyncOrchestratorItemRetryCycle(ctx, h.deps);
      expect(outcome.ran, row.name).toBe(false);
      expect(outcome.reason, row.name).toBe(row.reason);
      expect(readSyncOrchestratorState().lastCycle?.gateOutcome, row.name).toBe('skipped');
      expect(h.calls, row.name).toEqual([]);
    }
    const offline = makeHarness({ onLine: false });
    const offOutcome = await requestSyncOrchestratorItemRetryCycle(baseCtx(), offline.deps);
    expect(offOutcome).toMatchObject({ ran: false, reason: 'offline' });
    expect(offline.calls).toEqual([]);
  });

  it('N-R2-5 item cycle preserves channel order and both Web Locks', async () => {
    const h = makeHarness({ locks: 'acquire' });
    const outcome = await requestSyncOrchestratorItemRetryCycle(baseCtx(), h.deps);
    expect(outcome.ran).toBe(true);
    expect(h.calls).toEqual([...CHANNEL_ORDER]);
    expect(h.lockNames).toContain(SYNC_ORCHESTRATOR_LOCK);
    expect(h.lockNames).toContain(SYNC_ORCHESTRATOR_CH1_LOCK);
  });

  it('N-R2-8 in-flight item cycle reruns as WINDOW_ONLINE with no global reset', async () => {
    const spy = vi.spyOn(voidStore, 'clearVoidIntentBackoff').mockResolvedValue(0);
    const ledger = __getRetryLedgerForTests();
    ledger.set('offline_reversal:keep', { attempts: 2, nextEligibleAtMs: 7_777, lastErrorClass: 'transport' });
    const h = makeHarness({ hangCh4: true });
    const ctx = baseCtx();
    const first = requestSyncOrchestratorItemRetryCycle(ctx, h.deps);
    await h.waitUntilHung();
    const second = requestSyncOrchestratorItemRetryCycle(ctx, h.deps);
    expect(second).toBe(first);
    h.releaseHang();
    await first;
    await Promise.resolve();
    await h.awaitCycle();
    expect(ledger.get('offline_reversal:keep')?.nextEligibleAtMs).toBe(7_777);
    expect(spy).not.toHaveBeenCalled();
    expect(readSyncOrchestratorState().lastCycle?.trigger).toBe('WINDOW_ONLINE');
  });

  it('N-R2-10 global resweep still resets below-ceiling ledger and calls clearVoidIntentBackoff', async () => {
    const spy = vi.spyOn(voidStore, 'clearVoidIntentBackoff').mockResolvedValue(0);
    const ledger = __getRetryLedgerForTests();
    ledger.set('offline_reversal:x', { attempts: 2, nextEligibleAtMs: 9_999, lastErrorClass: 'transport' });
    ledger.set('offline_reversal:y', {
      attempts: SYNC_ORCHESTRATOR_MAX_ATTEMPTS,
      nextEligibleAtMs: 9_999,
      lastErrorClass: 'transport',
    });
    const h = makeHarness();
    await requestSyncOrchestratorCycle('operator', baseCtx(), h.deps);
    expect(ledger.get('offline_reversal:x')?.nextEligibleAtMs).toBe(0);
    expect(ledger.get('offline_reversal:x')?.attempts).toBe(2);
    expect(ledger.get('offline_reversal:y')?.nextEligibleAtMs).toBe(9_999);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('clearOfflineReversalRetryEligibility', () => {
  it('N-R3-8 exhausted CH-4 entry cannot be reset', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    await putIntent(store, reversalIntent('ex', 'A', 'queued'));
    const ledger = __getRetryLedgerForTests();
    ledger.set('offline_reversal:ex', {
      attempts: SYNC_ORCHESTRATOR_MAX_ATTEMPTS,
      nextEligibleAtMs: 4_444,
      lastErrorClass: 'transport',
    });
    const outcome = await clearOfflineReversalRetryEligibility(store, 'ex', NOW);
    expect(outcome).toBe('attempt_ceiling_reached');
    expect(ledger.get('offline_reversal:ex')).toEqual({
      attempts: SYNC_ORCHESTRATOR_MAX_ATTEMPTS,
      nextEligibleAtMs: 4_444,
      lastErrorClass: 'transport',
    });
    const h = makeHarness();
    await requestSyncOrchestratorItemRetryCycle(baseCtx(), h.deps);
    expect(readSyncOrchestratorState().ch4AttemptExhaustedIds).toContain('offline_reversal:ex');
  });

  it('N-R3-9 non-exhausted entry is cleared without deleting or incrementing attempts', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    await putIntent(store, reversalIntent('keep', 'A', 'retryable_error'));
    const ledger = __getRetryLedgerForTests();
    ledger.set('offline_reversal:keep', { attempts: 3, nextEligibleAtMs: 5_555, lastErrorClass: 'transport' });
    const outcome = await clearOfflineReversalRetryEligibility(store, 'keep', NOW);
    expect(outcome).toBe('cleared');
    expect(ledger.get('offline_reversal:keep')).toEqual({
      attempts: 3,
      nextEligibleAtMs: 0,
      lastErrorClass: 'transport',
    });
  });

  it('N-R3-10 out_of_scope / intent_absent / not_eligible_state leave the ledger untouched', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    await putIntent(store, reversalIntent('b', 'B', 'queued'));
    await putIntent(store, reversalIntent('mr', 'A', 'manual_review_required'));
    const ledger = __getRetryLedgerForTests();
    ledger.set('offline_reversal:b', { attempts: 1, nextEligibleAtMs: 1, lastErrorClass: 'transport' });
    ledger.set('offline_reversal:mr', { attempts: 1, nextEligibleAtMs: 1, lastErrorClass: 'transport' });
    expect(await clearOfflineReversalRetryEligibility(store, 'b', NOW)).toBe('out_of_scope');
    expect(await clearOfflineReversalRetryEligibility(store, 'missing', NOW)).toBe('intent_absent');
    expect(await clearOfflineReversalRetryEligibility(store, 'mr', NOW)).toBe('not_eligible_state');
    expect(ledger.get('offline_reversal:b')?.nextEligibleAtMs).toBe(1);
    expect(ledger.get('offline_reversal:mr')?.nextEligibleAtMs).toBe(1);
  });

  it('no_ledger_entry does not invent a ledger row', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    await putIntent(store, reversalIntent('bare', 'A', 'queued'));
    expect(await clearOfflineReversalRetryEligibility(store, 'bare', NOW)).toBe('no_ledger_entry');
    expect(__getRetryLedgerForTests().has('offline_reversal:bare')).toBe(false);
  });

  it('T-RACE-REV-1 branch switch B→A after getIntent hold is out_of_scope', async () => {
    __setCanonicalSyncContextForTests('B', 'X');
    const inner = createInMemoryReversalStore();
    await putIntent(inner, reversalIntent('race', 'B', 'queued'));
    const ledger = __getRetryLedgerForTests();
    const snapshot = { attempts: 2, nextEligibleAtMs: 3_333, lastErrorClass: 'transport' as const };
    ledger.set('offline_reversal:race', { ...snapshot });
    const wrapped = wrapDeferredGet(inner, (store, key) => store === 'intents' && key === 'race');
    const pending = clearOfflineReversalRetryEligibility(wrapped.store, 'race', NOW);
    await waitUntil(wrapped.waiting);
    __setCanonicalSyncContextForTests('A', 'X');
    wrapped.release();
    expect(await pending).toBe('out_of_scope');
    expect(ledger.get('offline_reversal:race')).toEqual(snapshot);
  });

  it('T-RACE-OK honest in-scope queued reversal still clears', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    await putIntent(store, reversalIntent('ok', 'A', 'queued'));
    const ledger = __getRetryLedgerForTests();
    ledger.set('offline_reversal:ok', { attempts: 1, nextEligibleAtMs: 9, lastErrorClass: 'transport' });
    expect(await clearOfflineReversalRetryEligibility(store, 'ok', NOW)).toBe('cleared');
    expect(ledger.get('offline_reversal:ok')?.nextEligibleAtMs).toBe(0);
    expect(ledger.get('offline_reversal:ok')?.attempts).toBe(1);
  });
});
