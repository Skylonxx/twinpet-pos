/**
 * PK-3 unified sync orchestrator.
 *
 * Owns WHEN drain cycles run. Does not redefine channel business semantics.
 * Must not open an IndexedDB database. Must not import trustedOrchestrationOwner.
 */

import { useEffect, useRef } from 'react';
import { getIdTokenResult, type User as FirebaseUser } from 'firebase/auth';
import { useAuth } from '../../hooks/useAuth';
import { getDeviceId } from '../deviceId';
import {
  readShiftCloseConfirmation,
  readShiftOpenConfirmation,
  normalizeShiftCloseSyncState,
  reissueShiftOpenWrite,
} from '../shiftService';
import { createAsyncOrderServerLookup } from './asyncOrderLookup';
import { createSaleIntentJournal } from './saleIntentJournal';
import { runSaleIntentSweep } from './saleIntentSweep';
import { createIndexedDbReversalStore, type ReversalLocalStore } from './reversalLocalStore';
import { getCanonicalSyncContext } from './canonicalSyncContext';
import { listClaimable, getIntent } from './offlineReversalQueue';
import {
  getDefaultCallResolveReversal,
  syncOneReversal,
} from './syncOfflineReversals';
import { createShiftCloseIntentJournal } from './shiftCloseIntentStore';
import { createShiftOpenIntentJournal } from './shiftOpenIntentStore';
import { runShiftCloseReconciliationSweep } from './shiftCloseReconciler';
import { runShiftOpenReconciliationSweep } from './shiftOpenReconciler';
import { runTrustedResumeSweep } from './trustedSaleSubmissionOrchestrator';
import {
  clearVoidIntentBackoff,
  countTerminalVoidIntents,
  listClaimableVoidIntents,
} from './voidIntentStore';
import { drainOneVoidIntent } from '../voidPendingOrder';

export const SYNC_ORCHESTRATOR_INTERVAL_MS = 120_000;
export const SYNC_ORCHESTRATOR_BOOT_DELAY_MS = 3_000;
export const SYNC_ORCHESTRATOR_ONLINE_DEBOUNCE_MS = 1_500;
export const SYNC_ORCHESTRATOR_BACKOFF_BASE_MS = 5_000;
export const SYNC_ORCHESTRATOR_BACKOFF_MULTIPLIER = 2;
export const SYNC_ORCHESTRATOR_BACKOFF_CAP_MS = 300_000;
export const SYNC_ORCHESTRATOR_PER_CHANNEL_ITEM_CAP = 25;
export const SYNC_ORCHESTRATOR_MAX_CYCLE_DURATION_MS = 20_000;
export const SYNC_ORCHESTRATOR_MAX_ATTEMPTS = 8;
export const SYNC_ORCHESTRATOR_JITTER_PERCENT = 20;
export const SYNC_ORCHESTRATOR_LOCK = 'twinpet-sync-orchestrator';
export const SYNC_ORCHESTRATOR_CH1_LOCK = 'twinpet-sale-intent-sweep';

export const CHANNEL_ORDER = [
  'offline_reversal',
  'void_intent',
  'shift_intent',
  'sale_intent',
  'trusted_resume',
] as const;

export type SyncChannelId = (typeof CHANNEL_ORDER)[number];
export type SyncTrigger =
  | 'APP_BOOT'
  | 'WINDOW_ONLINE'
  | 'BOUNDED_INTERVAL'
  | 'MANUAL_INVOCATION';

export type GateSkipReason =
  | 'no_firebase'
  | 'no_session'
  | 'no_branch'
  | 'branch_all'
  | 'no_firebase_user'
  | 'no_staff_claim'
  | 'offline'
  | 'lock_held';

export type ChannelRunResult = {
  channel: SyncChannelId;
  status: 'ok' | 'failed' | 'skipped';
  skipReason?: 'capped' | 'lock_held' | 'boot_excluded' | 'transport_unavailable' | string;
  itemsAdvanced?: number;
  itemsAttempted?: number;
  errorClass?: string;
};

export type SyncCycleOutcome = {
  ran: boolean;
  reason?: GateSkipReason | 'in_flight' | 'cancelled';
  trigger: SyncTrigger;
  completed: boolean;
  channels: ChannelRunResult[];
};

export type SyncOrchestratorState = {
  schemaVersion: 1;
  webLocksAvailable: boolean;
  lastCycle: {
    trigger: SyncTrigger;
    startedAtMs: number;
    durationMs: number;
    completed: boolean;
    gateOutcome: 'ran' | 'skipped';
    gateSkipReason?: GateSkipReason;
    channels: ChannelRunResult[];
  } | null;
  cycleCount: number;
  terminalVoidIntentCount: number;
  lastErrorAtMs: number | null;
  ch4AttemptExhaustedIds: string[];
};

export type SyncOrchestratorAuthContext = {
  session: unknown | null;
  branchId: string | null;
  firebaseUser: FirebaseUser | null;
};

type MinimalLockManager = {
  request: (
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown | null) => Promise<void> | void,
  ) => Promise<unknown>;
};

type RetryLedgerEntry = { attempts: number; nextEligibleAtMs: number; lastErrorClass: string };

export type SyncOrchestratorDeps = {
  now?: () => number;
  random?: () => number;
  navigatorRef?: Navigator | undefined;
  getClaims?: (user: FirebaseUser) => Promise<{ claims: Record<string, unknown> }>;
  createLookup?: typeof createAsyncOrderServerLookup;
  runCh4?: (input: ChannelAdapterInput) => Promise<ChannelRunResult>;
  runCh5?: (input: ChannelAdapterInput) => Promise<ChannelRunResult>;
  runCh2?: (input: ChannelAdapterInput) => Promise<ChannelRunResult>;
  runCh1?: (input: ChannelAdapterInput) => Promise<ChannelRunResult>;
  runCh3?: (input: ChannelAdapterInput) => Promise<ChannelRunResult>;
  countTerminal?: () => Promise<number>;
  addEventListener?: (type: 'online' | 'offline', fn: () => void) => void;
  removeEventListener?: (type: 'online' | 'offline', fn: () => void) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (id: unknown) => void;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (id: unknown) => void;
};

export type ChannelAdapterInput = {
  trigger: SyncTrigger;
  branchId: string;
  deviceId: string;
  staffId: string;
  nowMs: number;
  isOnline: boolean;
  navigatorRef?: Navigator;
  cycleToken: number;
};

const CHANNEL_RUNNERS: Record<
  SyncChannelId,
  'runCh4' | 'runCh5' | 'runCh2' | 'runCh1' | 'runCh3'
> = {
  offline_reversal: 'runCh4',
  void_intent: 'runCh5',
  shift_intent: 'runCh2',
  sale_intent: 'runCh1',
  trusted_resume: 'runCh3',
};

let mountedCtxRef: { current: SyncOrchestratorAuthContext } | null = null;
let rerunRequested = false;
let bootCycleConsumed = false;
let cancelled = false;
let cycleInFlight: Promise<SyncCycleOutcome> | null = null;
let cycleToken = 0;
const retryLedger = new Map<string, RetryLedgerEntry>();
let state: SyncOrchestratorState = emptyState(true);
const listeners = new Set<(s: SyncOrchestratorState) => void>();

function emptyState(webLocksAvailable: boolean): SyncOrchestratorState {
  return {
    schemaVersion: 1,
    webLocksAvailable,
    lastCycle: null,
    cycleCount: 0,
    terminalVoidIntentCount: 0,
    lastErrorAtMs: null,
    ch4AttemptExhaustedIds: [],
  };
}

export function computeBackoffDelayMs(
  attemptNumber: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(
    SYNC_ORCHESTRATOR_BACKOFF_BASE_MS *
      SYNC_ORCHESTRATOR_BACKOFF_MULTIPLIER ** Math.max(0, attemptNumber - 1),
    SYNC_ORCHESTRATOR_BACKOFF_CAP_MS,
  );
  const jitter = 1 + (random() * 2 - 1) * (SYNC_ORCHESTRATOR_JITTER_PERCENT / 100);
  return Math.max(0, Math.round(exp * jitter));
}

export function computeBackoffDelayMsPreJitter(attemptNumber: number): number {
  return Math.min(
    SYNC_ORCHESTRATOR_BACKOFF_BASE_MS *
      SYNC_ORCHESTRATOR_BACKOFF_MULTIPLIER ** Math.max(0, attemptNumber - 1),
    SYNC_ORCHESTRATOR_BACKOFF_CAP_MS,
  );
}

function publish(next: SyncOrchestratorState): void {
  state = next;
  for (const fn of listeners) fn(state);
}

export function readSyncOrchestratorState(): SyncOrchestratorState {
  return state;
}

export function subscribeSyncOrchestratorState(
  fn: (s: SyncOrchestratorState) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function defaultNavigator(): Navigator | undefined {
  return typeof navigator !== 'undefined' ? navigator : undefined;
}

async function defaultRunCh4(input: ChannelAdapterInput): Promise<ChannelRunResult> {
  let call;
  try {
    call = await getDefaultCallResolveReversal();
  } catch {
    return { channel: 'offline_reversal', status: 'skipped', skipReason: 'transport_unavailable' };
  }
  const store = createIndexedDbReversalStore();
  const claimable = await listClaimable(store);
  const eligible = claimable.filter((item) => {
    const key = `offline_reversal:${item.id}`;
    const entry = retryLedger.get(key);
    if (!entry) return true;
    if (entry.attempts >= SYNC_ORCHESTRATOR_MAX_ATTEMPTS) return false;
    return entry.nextEligibleAtMs <= input.nowMs;
  });
  const batch = eligible.slice(0, SYNC_ORCHESTRATOR_PER_CHANNEL_ITEM_CAP);
  let advanced = 0;
  for (const item of batch) {
    const result = await syncOneReversal(store, item.id, call, { owner: input.deviceId });
    const key = `offline_reversal:${item.id}`;
    if (input.cycleToken !== cycleToken) {
      continue;
    }
    if (result.intent?.status === 'retryable_error') {
      const prev = retryLedger.get(key);
      const attempts = (prev?.attempts ?? 0) + 1;
      retryLedger.set(key, {
        attempts,
        nextEligibleAtMs: input.nowMs + computeBackoffDelayMs(attempts),
        lastErrorClass: 'transport',
      });
    } else if (result.claimed) {
      retryLedger.delete(key);
      if (result.intent) advanced += 1;
    }
  }
  return {
    channel: 'offline_reversal',
    status: 'ok',
    itemsAttempted: batch.length,
    itemsAdvanced: advanced,
  };
}

async function defaultRunCh5(input: ChannelAdapterInput): Promise<ChannelRunResult> {
  const store = createIndexedDbReversalStore();
  const claimable = await listClaimableVoidIntents(store, input.nowMs, {
    branchId: input.branchId,
    deviceId: input.deviceId,
  });
  const batch = claimable.slice(0, SYNC_ORCHESTRATOR_PER_CHANNEL_ITEM_CAP);
  let advanced = 0;
  let attempted = 0;
  for (const rec of batch) {
    if (input.cycleToken !== cycleToken) break;
    attempted += 1;
    const result = await drainOneVoidIntent(rec.orderId, {
      store,
      nowMs: input.nowMs,
      isOnline: input.isOnline,
      owner: `sync-orch:${input.deviceId}`,
      intervalMs: SYNC_ORCHESTRATOR_INTERVAL_MS,
      currentStaffId: input.staffId,
      backoffMs: (n) => computeBackoffDelayMs(n),
      maxAttempts: SYNC_ORCHESTRATOR_MAX_ATTEMPTS,
    });
    if (result === 'confirmed' || result === 'terminal') advanced += 1;
  }
  return {
    channel: 'void_intent',
    status: 'ok',
    itemsAttempted: attempted,
    itemsAdvanced: advanced,
  };
}

async function defaultRunCh2(input: ChannelAdapterInput): Promise<ChannelRunResult> {
  await runShiftCloseReconciliationSweep({
    journal: createShiftCloseIntentJournal(),
    readConfirmation: readShiftCloseConfirmation,
    normalizeSyncState: normalizeShiftCloseSyncState,
    deviceId: input.deviceId,
  });
  await runShiftOpenReconciliationSweep({
    journal: createShiftOpenIntentJournal(),
    readConfirmation: readShiftOpenConfirmation,
    deviceId: input.deviceId,
    reissueOpenWrite: reissueShiftOpenWrite,
  });
  return { channel: 'shift_intent', status: 'ok', itemsAdvanced: 0 };
}

async function defaultRunCh1(_input: ChannelAdapterInput): Promise<ChannelRunResult> {
  const lookup = createAsyncOrderServerLookup();
  if (!lookup) {
    return { channel: 'sale_intent', status: 'skipped', skipReason: 'transport_unavailable' };
  }
  await runSaleIntentSweep({
    journal: createSaleIntentJournal(),
    lookupAsyncOrder: lookup,
  });
  return { channel: 'sale_intent', status: 'ok' };
}

async function defaultRunCh3(input: ChannelAdapterInput): Promise<ChannelRunResult> {
  const result = await runTrustedResumeSweep({
    branchId: input.branchId,
    deviceId: input.deviceId,
  });
  if (!result.ok) {
    return { channel: 'trusted_resume', status: 'failed', errorClass: result.reason };
  }
  return { channel: 'trusted_resume', status: 'ok', itemsAdvanced: result.outcome === 'released' ? 1 : 0 };
}

function resolveDeps(deps?: SyncOrchestratorDeps) {
  return {
    now: deps?.now ?? Date.now,
    random: deps?.random ?? Math.random,
    navigatorRef: deps?.navigatorRef ?? defaultNavigator(),
    getClaims: deps?.getClaims ?? ((user: FirebaseUser) => getIdTokenResult(user)),
    createLookup: deps?.createLookup ?? createAsyncOrderServerLookup,
    runCh4: deps?.runCh4 ?? defaultRunCh4,
    runCh5: deps?.runCh5 ?? defaultRunCh5,
    runCh2: deps?.runCh2 ?? defaultRunCh2,
    runCh1: deps?.runCh1 ?? defaultRunCh1,
    runCh3: deps?.runCh3 ?? defaultRunCh3,
    countTerminal:
      deps?.countTerminal ??
      (() => countTerminalVoidIntents(createIndexedDbReversalStore())),
    addEventListener:
      deps?.addEventListener ??
      ((type, fn) => {
        if (typeof window !== 'undefined') window.addEventListener(type, fn);
      }),
    removeEventListener:
      deps?.removeEventListener ??
      ((type, fn) => {
        if (typeof window !== 'undefined') window.removeEventListener(type, fn);
      }),
    setTimeoutFn: deps?.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimeoutFn: deps?.clearTimeoutFn ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>)),
    setIntervalFn: deps?.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms)),
    clearIntervalFn:
      deps?.clearIntervalFn ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>)),
  };
}

type ResolvedDeps = ReturnType<typeof resolveDeps>;

function webLocksOf(nav: Navigator | undefined): MinimalLockManager | undefined {
  return (nav as unknown as { locks?: MinimalLockManager } | undefined)?.locks;
}

type GateEvaluation =
  | { skip: GateSkipReason; staffId: null }
  | { skip: null; staffId: string };

async function evaluateGates(
  ctx: SyncOrchestratorAuthContext,
  d: ResolvedDeps,
): Promise<GateEvaluation> {
  if (d.createLookup() === null) return { skip: 'no_firebase', staffId: null };
  if (ctx.session == null) return { skip: 'no_session', staffId: null };
  if (ctx.branchId == null) return { skip: 'no_branch', staffId: null };
  if (ctx.branchId === 'ALL') return { skip: 'branch_all', staffId: null };
  if (ctx.firebaseUser == null) return { skip: 'no_firebase_user', staffId: null };
  if (d.navigatorRef?.onLine === false) return { skip: 'offline', staffId: null };
  try {
    const token = await d.getClaims(ctx.firebaseUser);
    if (token?.claims?.staffId == null) return { skip: 'no_staff_claim', staffId: null };
    return { skip: null, staffId: String(token.claims.staffId) };
  } catch {
    return { skip: 'no_staff_claim', staffId: null };
  }
}

async function awaitWithCycleDeadline<T>(
  work: Promise<T>,
  remainingMs: number,
  d: ResolvedDeps,
): Promise<{ status: 'settled'; value: T } | { status: 'timeout' }> {
  if (remainingMs <= 0) {
    void work.then(
      () => undefined,
      () => undefined,
    );
    return { status: 'timeout' };
  }
  let timeoutId: unknown;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeoutId = d.setTimeoutFn(() => resolve('timeout'), remainingMs);
  });
  try {
    const winner = await Promise.race([
      work.then((value) => ({ kind: 'settled' as const, value })),
      timeoutPromise.then(() => ({ kind: 'timeout' as const })),
    ]);
    if (winner.kind === 'timeout') {
      void work.then(
        () => undefined,
        () => undefined,
      );
      return { status: 'timeout' };
    }
    return { status: 'settled', value: winner.value };
  } finally {
    if (timeoutId != null) d.clearTimeoutFn(timeoutId);
  }
}

async function runChannels(
  trigger: SyncTrigger,
  ctx: SyncOrchestratorAuthContext,
  d: ResolvedDeps,
  startedAtMs: number,
  staffId: string,
  token: number,
): Promise<ChannelRunResult[]> {
  const results: ChannelRunResult[] = [];
  const deadlineMs = startedAtMs + SYNC_ORCHESTRATOR_MAX_CYCLE_DURATION_MS;
  const deviceId = getDeviceId();
  const input: ChannelAdapterInput = {
    trigger,
    branchId: ctx.branchId as string,
    deviceId,
    staffId,
    nowMs: d.now(),
    isOnline: d.navigatorRef?.onLine !== false,
    navigatorRef: d.navigatorRef,
    cycleToken: token,
  };
  const locks = webLocksOf(d.navigatorRef);
  let capped = false;

  for (const channel of CHANNEL_ORDER) {
    if (capped || d.now() >= deadlineMs) {
      results.push({ channel, status: 'skipped', skipReason: 'capped' });
      continue;
    }
    if (trigger === 'APP_BOOT' && channel === 'sale_intent') {
      results.push({ channel, status: 'skipped', skipReason: 'boot_excluded' });
      continue;
    }
    try {
      const remainingMs = deadlineMs - d.now();
      const work =
        channel === 'sale_intent' && locks && typeof locks.request === 'function'
          ? (async () => {
              let nested: ChannelRunResult | null = null;
              await locks.request(SYNC_ORCHESTRATOR_CH1_LOCK, { ifAvailable: true }, async (lock) => {
                if (!lock) {
                  nested = { channel, status: 'skipped', skipReason: 'lock_held' };
                  return;
                }
                nested = await d.runCh1(input);
              });
              return nested ?? { channel, status: 'skipped' as const, skipReason: 'lock_held' };
            })()
          : d[CHANNEL_RUNNERS[channel]](input);
      const raced = await awaitWithCycleDeadline(work, remainingMs, d);
      if (raced.status === 'timeout') {
        results.push({ channel, status: 'skipped', skipReason: 'capped' });
        capped = true;
        continue;
      }
      results.push(raced.value);
    } catch (err) {
      results.push({
        channel,
        status: 'failed',
        errorClass: err instanceof Error ? err.message : 'unknown',
      });
    }
  }
  return results;
}

function publishIfCurrent(token: number, next: SyncOrchestratorState): void {
  if (token !== cycleToken) return;
  publish(next);
}

async function runCycleBody(
  trigger: SyncTrigger,
  ctx: SyncOrchestratorAuthContext,
  d: ResolvedDeps,
  token: number,
): Promise<SyncCycleOutcome> {
  const startedAtMs = d.now();
  const gate = await evaluateGates(ctx, d);
  let terminalCount = 0;
  try {
    terminalCount = await d.countTerminal();
  } catch {
    terminalCount = state.terminalVoidIntentCount;
  }

  if (gate.skip) {
    const outcome: SyncCycleOutcome = {
      ran: false,
      reason: gate.skip,
      trigger,
      completed: true,
      channels: [],
    };
    publishIfCurrent(token, {
      ...state,
      webLocksAvailable: Boolean(webLocksOf(d.navigatorRef)),
      terminalVoidIntentCount: terminalCount,
      lastCycle: {
        trigger,
        startedAtMs,
        durationMs: d.now() - startedAtMs,
        completed: true,
        gateOutcome: 'skipped',
        gateSkipReason: gate.skip,
        channels: [],
      },
      cycleCount: state.cycleCount + 1,
    });
    return outcome;
  }

  const locks = webLocksOf(d.navigatorRef);
  const run = async (): Promise<ChannelRunResult[]> =>
    runChannels(trigger, ctx, d, startedAtMs, gate.staffId, token);

  let channels: ChannelRunResult[] = [];
  if (locks && typeof locks.request === 'function') {
    try {
      let ran = false;
      await locks.request(SYNC_ORCHESTRATOR_LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        ran = true;
        channels = await run();
      });
      if (!ran) {
        publishIfCurrent(token, {
          ...state,
          webLocksAvailable: true,
          terminalVoidIntentCount: terminalCount,
          lastCycle: {
            trigger,
            startedAtMs,
            durationMs: d.now() - startedAtMs,
            completed: true,
            gateOutcome: 'skipped',
            gateSkipReason: 'lock_held',
            channels: [],
          },
          cycleCount: state.cycleCount + 1,
        });
        return { ran: false, reason: 'lock_held', trigger, completed: true, channels: [] };
      }
    } catch {
      channels = await run();
    }
  } else {
    channels = await run();
  }

  try {
    terminalCount = await d.countTerminal();
  } catch {
    /* keep previous */
  }

  const completed = channels.every((c) => c.skipReason !== 'capped');
  const failed = channels.some((c) => c.status === 'failed');
  const exhausted = [...retryLedger.entries()]
    .filter(([, e]) => e.attempts >= SYNC_ORCHESTRATOR_MAX_ATTEMPTS)
    .map(([k]) => k);
  publishIfCurrent(token, {
    schemaVersion: 1,
    webLocksAvailable: Boolean(webLocksOf(d.navigatorRef)),
    lastCycle: {
      trigger,
      startedAtMs,
      durationMs: d.now() - startedAtMs,
      completed,
      gateOutcome: 'ran',
      channels,
    },
    cycleCount: state.cycleCount + 1,
    terminalVoidIntentCount: terminalCount,
    lastErrorAtMs: failed ? d.now() : state.lastErrorAtMs,
    ch4AttemptExhaustedIds: exhausted,
  });
  return { ran: true, trigger, completed, channels };
}

function startCycle(
  trigger: SyncTrigger,
  ctxRef: { current: SyncOrchestratorAuthContext },
  d: ResolvedDeps,
): Promise<SyncCycleOutcome> {
  if (cancelled) {
    return Promise.resolve({
      ran: false,
      reason: 'cancelled',
      trigger,
      completed: true,
      channels: [],
    });
  }
  if (cycleInFlight !== null) {
    if (trigger === 'WINDOW_ONLINE' || trigger === 'MANUAL_INVOCATION') {
      rerunRequested = true;
    }
    return cycleInFlight;
  }
  const token = ++cycleToken;
  cycleInFlight = runCycleBody(trigger, ctxRef.current, d, token).finally(() => {
    cycleInFlight = null;
    if (rerunRequested && !cancelled) {
      rerunRequested = false;
      void startCycle('WINDOW_ONLINE', ctxRef, d);
    }
  });
  return cycleInFlight;
}

type PreCycleResetPolicy = 'global_eligibility_reset' | 'none';

function applyPreCycleReset(policy: PreCycleResetPolicy, d: ResolvedDeps): void {
  if (policy !== 'global_eligibility_reset') return;
  for (const [key, entry] of retryLedger) {
    if (entry.attempts >= SYNC_ORCHESTRATOR_MAX_ATTEMPTS) continue;
    retryLedger.set(key, { ...entry, nextEligibleAtMs: 0 });
  }
  void clearVoidIntentBackoff(createIndexedDbReversalStore(), d.now()).catch(() => {
    /* best-effort: IDB may be absent in tests / private mode */
  });
}

function requestCycleWithPolicy(
  policy: PreCycleResetPolicy,
  ctxRef?: { current: SyncOrchestratorAuthContext },
  deps?: SyncOrchestratorDeps,
): Promise<SyncCycleOutcome> {
  const d = resolveDeps(deps);
  if (d.navigatorRef?.onLine === false) {
    return Promise.resolve({
      ran: false,
      reason: 'offline',
      trigger: 'MANUAL_INVOCATION',
      completed: true,
      channels: [],
    });
  }
  applyPreCycleReset(policy, d);
  const ref =
    ctxRef ?? mountedCtxRef ?? { current: { session: null, branchId: null, firebaseUser: null } };
  return startCycle('MANUAL_INVOCATION', ref, d);
}

export function requestSyncOrchestratorItemRetryCycle(
  ctxRef?: { current: SyncOrchestratorAuthContext },
  deps?: SyncOrchestratorDeps,
): Promise<SyncCycleOutcome> {
  return requestCycleWithPolicy('none', ctxRef, deps);
}

export function requestSyncOrchestratorCycle(
  _reason: string,
  ctxRef?: { current: SyncOrchestratorAuthContext },
  deps?: SyncOrchestratorDeps,
): Promise<SyncCycleOutcome> {
  return requestCycleWithPolicy('global_eligibility_reset', ctxRef, deps);
}

export type ClearReversalRetryEligibilityOutcome =
  | 'cleared'
  | 'no_ledger_entry'
  | 'attempt_ceiling_reached'
  | 'not_eligible_state'
  | 'out_of_scope'
  | 'intent_absent';

export async function clearOfflineReversalRetryEligibility(
  store: ReversalLocalStore,
  intentId: string,
  nowMs: number,
): Promise<ClearReversalRetryEligibilityOutcome> {
  void nowMs;
  const early = getCanonicalSyncContext();
  if (!early) return 'out_of_scope';

  const intent = await getIntent(store, intentId);
  const canonical = getCanonicalSyncContext();
  if (!intent) return 'intent_absent';
  if (!canonical || intent.branchId !== canonical.branchId) return 'out_of_scope';
  if (!(intent.status === 'queued' || intent.status === 'retryable_error')) {
    return 'not_eligible_state';
  }
  const key = `offline_reversal:${intentId}`;
  const entry = retryLedger.get(key);
  if (!entry) return 'no_ledger_entry';
  if (entry.attempts >= SYNC_ORCHESTRATOR_MAX_ATTEMPTS) return 'attempt_ceiling_reached';
  retryLedger.set(key, { ...entry, nextEligibleAtMs: 0 });
  return 'cleared';
}

export function maybeStartSyncOrchestrator(
  ctxRef: { current: SyncOrchestratorAuthContext },
  deps?: SyncOrchestratorDeps,
): () => void {
  const d = resolveDeps(deps);
  cancelled = false;
  mountedCtxRef = ctxRef;
  let onlineTimer: unknown = null;
  let bootTimer: unknown = null;

  const onOnline = () => {
    if (onlineTimer != null) d.clearTimeoutFn(onlineTimer);
    onlineTimer = d.setTimeoutFn(() => {
      if (d.navigatorRef?.onLine === false) return;
      void startCycle('WINDOW_ONLINE', ctxRef, d);
    }, SYNC_ORCHESTRATOR_ONLINE_DEBOUNCE_MS);
  };
  const onOffline = () => {
    if (onlineTimer != null) d.clearTimeoutFn(onlineTimer);
    onlineTimer = null;
  };

  d.addEventListener('online', onOnline);
  d.addEventListener('offline', onOffline);

  bootTimer = d.setTimeoutFn(() => {
    if (bootCycleConsumed) return;
    bootCycleConsumed = true;
    if (cycleInFlight !== null) return;
    void startCycle('APP_BOOT', ctxRef, d);
  }, SYNC_ORCHESTRATOR_BOOT_DELAY_MS);

  const interval = d.setIntervalFn(() => {
    if (cycleInFlight !== null) return;
    void startCycle('BOUNDED_INTERVAL', ctxRef, d);
  }, SYNC_ORCHESTRATOR_INTERVAL_MS);

  publish({
    ...state,
    webLocksAvailable: Boolean(webLocksOf(d.navigatorRef)),
  });

  return () => {
    cancelled = true;
    d.removeEventListener('online', onOnline);
    d.removeEventListener('offline', onOffline);
    if (bootTimer != null) d.clearTimeoutFn(bootTimer);
    if (onlineTimer != null) d.clearTimeoutFn(onlineTimer);
    d.clearIntervalFn(interval);
    if (mountedCtxRef === ctxRef) mountedCtxRef = null;
  };
}

export function useSyncOrchestrator(deps?: SyncOrchestratorDeps): void {
  const { session, branchId, firebaseUser } = useAuth();
  const ctxRef = useRef<SyncOrchestratorAuthContext>({ session, branchId, firebaseUser });
  ctxRef.current = { session, branchId, firebaseUser };
  useEffect(() => {
    return maybeStartSyncOrchestrator(ctxRef, deps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** @internal test-only */
export function __resetSyncOrchestratorForTests(): void {
  cycleInFlight = null;
  rerunRequested = false;
  bootCycleConsumed = false;
  cancelled = false;
  cycleToken = 0;
  retryLedger.clear();
  mountedCtxRef = null;
  state = emptyState(true);
  listeners.clear();
}

/** @internal test-only */
export function __syncOrchestratorPendingCycleForTests(): Promise<SyncCycleOutcome> | null {
  return cycleInFlight;
}

/** @internal test-only */
export function __getRetryLedgerForTests(): Map<string, RetryLedgerEntry> {
  return retryLedger;
}
