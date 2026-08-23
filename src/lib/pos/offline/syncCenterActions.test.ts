import { afterEach, describe, expect, it, vi } from 'vitest';
import { retrySyncCenterItem, triggerSyncCenterResweep } from './syncCenterActions';
import * as voidStore from './voidIntentStore';
import * as orch from './syncOrchestrator';
import {
  resolveActiveSyncScope,
  type SyncCenterRow,
} from './syncCenterModel';
import {
  __resetCanonicalSyncContextForTests,
  __setCanonicalSyncContextForTests,
} from './canonicalSyncContext';
import { createInMemoryReversalStore } from './reversalLocalStore';

const NOW = 1_700_000_000_000;

function scopeA() {
  const r = resolveActiveSyncScope('A', 'X');
  if (!r.ok) throw new Error(r.reason);
  return r.scope;
}

function waitingVoid(): SyncCenterRow {
  return {
    channel: 'void_intent',
    id: 'v1',
    state: 'waiting_retry',
    scopeKind: 'branch_device',
    branchId: 'A',
    deviceId: 'X',
    createdAtMs: NOW,
    updatedAtMs: NOW,
    attempts: 1,
    nextEligibleAtMs: NOW + 9_000,
    reasonCode: 'pending',
    reasonTh: 'รอรอบถัดไป',
    lastErrorAtMs: null,
    isStale: false,
    attemptCeilingReached: false,
    shiftKind: null,
    actionable: ['item_retry_now'],
  };
}

function queuedReversal(): SyncCenterRow {
  return {
    ...waitingVoid(),
    channel: 'offline_reversal',
    id: 'r1',
    state: 'pending',
    scopeKind: 'branch',
    deviceId: null,
    reasonCode: 'queued',
    nextEligibleAtMs: null,
  };
}

afterEach(() => {
  __resetCanonicalSyncContextForTests();
  vi.restoreAllMocks();
});

describe('syncCenterActions', () => {
  it('void out_of_scope object result does not request an item cycle', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const record = { orderId: 'v1' } as voidStore.VoidIntentRecord;
    const backoff = vi.spyOn(voidStore, 'clearVoidIntentBackoffForOrder').mockResolvedValue({
      outcome: 'out_of_scope',
      record,
    });
    const cycle = vi.spyOn(orch, 'requestSyncOrchestratorItemRetryCycle').mockResolvedValue({
      ran: false,
      trigger: 'MANUAL_INVOCATION',
      completed: true,
      channels: [],
    });
    const result = await retrySyncCenterItem({
      actor: { role: 'manager' },
      row: waitingVoid(),
      scope: scopeA(),
      isOnline: true,
      nowMs: NOW,
      store: createInMemoryReversalStore(),
    });
    expect(backoff).toHaveBeenCalled();
    expect(cycle).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mutation: 'noop', mutationReason: 'out_of_scope', cycle: 'not_run', rowAfter: record });
  });

  it('reversal out_of_scope string result does not request an item cycle', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const reversal = vi.spyOn(orch, 'clearOfflineReversalRetryEligibility').mockResolvedValue('out_of_scope');
    const cycle = vi.spyOn(orch, 'requestSyncOrchestratorItemRetryCycle').mockResolvedValue({
      ran: false,
      trigger: 'MANUAL_INVOCATION',
      completed: true,
      channels: [],
    });
    const result = await retrySyncCenterItem({
      actor: { role: 'manager' },
      row: queuedReversal(),
      scope: scopeA(),
      isOnline: true,
      nowMs: NOW,
      store: createInMemoryReversalStore(),
    });
    expect(reversal).toHaveBeenCalled();
    expect(cycle).not.toHaveBeenCalled();
    expect(result.cycle).toBe('not_run');
    expect(result.mutationReason).toBe('out_of_scope');
  });

  it('void already_eligible still requests exactly one bounded cycle', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    vi.spyOn(voidStore, 'clearVoidIntentBackoffForOrder').mockResolvedValue({
      outcome: 'already_eligible',
      record: { orderId: 'v1' } as voidStore.VoidIntentRecord,
    });
    const cycle = vi.spyOn(orch, 'requestSyncOrchestratorItemRetryCycle').mockResolvedValue({
      ran: true,
      trigger: 'MANUAL_INVOCATION',
      completed: true,
      channels: [],
    });
    const result = await retrySyncCenterItem({
      actor: { role: 'manager' },
      row: waitingVoid(),
      scope: scopeA(),
      isOnline: true,
      nowMs: NOW,
      store: createInMemoryReversalStore(),
    });
    expect(cycle).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ mutation: 'noop', mutationReason: 'already_eligible', cycle: 'requested' });
  });

  it('offline S3 refuses before S4', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const backoff = vi.spyOn(voidStore, 'clearVoidIntentBackoffForOrder');
    const cycle = vi.spyOn(orch, 'requestSyncOrchestratorItemRetryCycle');
    const result = await retrySyncCenterItem({
      actor: { role: 'manager' },
      row: waitingVoid(),
      scope: scopeA(),
      isOnline: false,
      nowMs: NOW,
      store: createInMemoryReversalStore(),
    });
    expect(result).toMatchObject({ mutation: 'noop', mutationReason: 'offline', cycle: 'not_run' });
    expect(backoff).not.toHaveBeenCalled();
    expect(cycle).not.toHaveBeenCalled();
  });

  it('global resweep uses the global API not the item cycle', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const global = vi.spyOn(orch, 'requestSyncOrchestratorCycle').mockResolvedValue({
      ran: true,
      trigger: 'MANUAL_INVOCATION',
      completed: true,
      channels: [],
    });
    const item = vi.spyOn(orch, 'requestSyncOrchestratorItemRetryCycle');
    const result = await triggerSyncCenterResweep({
      actor: { role: 'staff' },
      scope: scopeA(),
      isOnline: true,
    });
    expect(result.accepted).toBe(true);
    expect(global).toHaveBeenCalledTimes(1);
    expect(item).not.toHaveBeenCalled();
  });
});
