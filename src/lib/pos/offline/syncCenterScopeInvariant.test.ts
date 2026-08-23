import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryReversalStore } from './reversalLocalStore';
import { retrySyncCenterItem } from './syncCenterActions';
import * as voidStore from './voidIntentStore';
import * as orch from './syncOrchestrator';
import * as authority from './syncCenterAuthority';
import {
  resolveActiveSyncScope,
  type SyncCenterRow,
} from './syncCenterModel';
import {
  __resetCanonicalSyncContextForTests,
  __setCanonicalSyncContextForTests,
} from './canonicalSyncContext';
import type { VoidIntentRecord } from './voidIntentStore';

const NOW = 1_700_000_000_000;

function scopeOf(branchId: string, deviceId: string) {
  const r = resolveActiveSyncScope(branchId, deviceId);
  if (!r.ok) throw new Error(r.reason);
  return r.scope;
}

function waitingVoid(over: Partial<SyncCenterRow> = {}): SyncCenterRow {
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
    ...over,
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

const cycleOutcome = {
  ran: true,
  trigger: 'MANUAL_INVOCATION' as const,
  completed: true,
  channels: [],
};

afterEach(() => {
  __resetCanonicalSyncContextForTests();
  vi.restoreAllMocks();
});

describe('syncCenterScopeInvariant', () => {
  it('T-ACT-OUTCOME-1 void object out_of_scope does not request an item cycle', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const record = { orderId: 'v1' } as VoidIntentRecord;
    vi.spyOn(voidStore, 'clearVoidIntentBackoffForOrder').mockResolvedValue({
      outcome: 'out_of_scope',
      record,
    });
    const cycle = vi.spyOn(orch, 'requestSyncOrchestratorItemRetryCycle').mockResolvedValue(cycleOutcome);
    const result = await retrySyncCenterItem({
      actor: { role: 'manager' },
      row: waitingVoid(),
      scope: scopeOf('A', 'X'),
      isOnline: true,
      nowMs: NOW,
      store: createInMemoryReversalStore(),
    });
    expect(result).toMatchObject({
      mutation: 'noop',
      mutationReason: 'out_of_scope',
      cycle: 'not_run',
      rowAfter: record,
    });
    expect(cycle).not.toHaveBeenCalled();
  });

  it('T-ACT-OUTCOME-2 reversal bare out_of_scope string does not request an item cycle', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    vi.spyOn(orch, 'clearOfflineReversalRetryEligibility').mockResolvedValue('out_of_scope');
    const cycle = vi.spyOn(orch, 'requestSyncOrchestratorItemRetryCycle').mockResolvedValue(cycleOutcome);
    const result = await retrySyncCenterItem({
      actor: { role: 'manager' },
      row: queuedReversal(),
      scope: scopeOf('A', 'X'),
      isOnline: true,
      nowMs: NOW,
      store: createInMemoryReversalStore(),
    });
    expect(result.mutationReason).toBe('out_of_scope');
    expect(result.cycle).toBe('not_run');
    expect(cycle).not.toHaveBeenCalled();
  });

  it('T-ACT-OUTCOME-3 void already_eligible requests exactly one bounded cycle', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    vi.spyOn(voidStore, 'clearVoidIntentBackoffForOrder').mockResolvedValue({
      outcome: 'already_eligible',
      record: { orderId: 'v1' } as VoidIntentRecord,
    });
    const cycle = vi.spyOn(orch, 'requestSyncOrchestratorItemRetryCycle').mockResolvedValue(cycleOutcome);
    const result = await retrySyncCenterItem({
      actor: { role: 'manager' },
      row: waitingVoid(),
      scope: scopeOf('A', 'X'),
      isOnline: true,
      nowMs: NOW,
      store: createInMemoryReversalStore(),
    });
    expect(result).toMatchObject({
      mutation: 'noop',
      mutationReason: 'already_eligible',
      cycle: 'requested',
    });
    expect(cycle).toHaveBeenCalledTimes(1);
  });

  it('T-ACT-OUTCOME-4 reversal no_ledger_entry requests exactly one bounded cycle', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    vi.spyOn(orch, 'clearOfflineReversalRetryEligibility').mockResolvedValue('no_ledger_entry');
    const cycle = vi.spyOn(orch, 'requestSyncOrchestratorItemRetryCycle').mockResolvedValue(cycleOutcome);
    const result = await retrySyncCenterItem({
      actor: { role: 'manager' },
      row: queuedReversal(),
      scope: scopeOf('A', 'X'),
      isOnline: true,
      nowMs: NOW,
      store: createInMemoryReversalStore(),
    });
    expect(result.mutationReason).toBe('no_ledger_entry');
    expect(result.cycle).toBe('requested');
    expect(cycle).toHaveBeenCalledTimes(1);
  });

  it('T-ACT-OUTCOME-5 S3 stale_scope calls neither S4 nor the item cycle', async () => {
    vi.spyOn(authority, 'buildItemRetryRequest').mockReturnValue({
      ok: false,
      error: 'stale_scope',
    });
    const voidS4 = vi.spyOn(voidStore, 'clearVoidIntentBackoffForOrder');
    const revS4 = vi.spyOn(orch, 'clearOfflineReversalRetryEligibility');
    const cycle = vi.spyOn(orch, 'requestSyncOrchestratorItemRetryCycle');
    const result = await retrySyncCenterItem({
      actor: { role: 'manager' },
      row: waitingVoid(),
      scope: scopeOf('A', 'X'),
      isOnline: true,
      nowMs: NOW,
      store: createInMemoryReversalStore(),
    });
    expect(result).toMatchObject({ mutation: 'noop', mutationReason: 'stale_scope', cycle: 'not_run' });
    expect(voidS4).not.toHaveBeenCalled();
    expect(revS4).not.toHaveBeenCalled();
    expect(cycle).not.toHaveBeenCalled();
  });

  it('T-PROV-1 view scope B/X with canonical A/X is stale_scope; direct S4 is out_of_scope', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const cycle = vi.spyOn(orch, 'requestSyncOrchestratorItemRetryCycle');
    const result = await retrySyncCenterItem({
      actor: { role: 'manager' },
      row: waitingVoid({ branchId: 'B' }),
      scope: scopeOf('B', 'X'),
      isOnline: true,
      nowMs: NOW,
      store: createInMemoryReversalStore(),
    });
    expect(result.mutationReason).toBe('stale_scope');
    expect(cycle).not.toHaveBeenCalled();

    const store = createInMemoryReversalStore();
    await store.transact(['voidIntents'], 'readwrite', async (txn) => {
      await txn.put('voidIntents', 'bx', {
        orderId: 'bx',
        branchId: 'B',
        deviceId: 'X',
        reason: 'x',
        note: null,
        voidedBy: 's',
        status: 'pending',
        attempts: 1,
        createdAtMs: NOW,
        updatedAtMs: NOW,
        nextEligibleAtMs: NOW + 9_000,
        claimOwner: null,
        claimExpiresAtMs: null,
        lastErrorClass: null,
        lastErrorAtMs: null,
        terminalReason: null,
        confirmedAtMs: null,
        observedServerCreatedAtMs: null,
        schemaVersion: 1,
      });
    });
    const s4 = await voidStore.clearVoidIntentBackoffForOrder(store, 'bx', NOW);
    expect(s4.outcome).toBe('out_of_scope');
  });

  it('T-PROV-2 void device mismatch A/Y against canonical A/X is out_of_scope at S4', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    await store.transact(['voidIntents'], 'readwrite', async (txn) => {
      await txn.put('voidIntents', 'ay', {
        orderId: 'ay',
        branchId: 'A',
        deviceId: 'Y',
        reason: 'x',
        note: null,
        voidedBy: 's',
        status: 'pending',
        attempts: 1,
        createdAtMs: NOW,
        updatedAtMs: NOW,
        nextEligibleAtMs: NOW + 9_000,
        claimOwner: null,
        claimExpiresAtMs: null,
        lastErrorClass: null,
        lastErrorAtMs: null,
        terminalReason: null,
        confirmedAtMs: null,
        observedServerCreatedAtMs: null,
        schemaVersion: 1,
      });
    });
    const s4 = await voidStore.clearVoidIntentBackoffForOrder(store, 'ay', NOW);
    expect(s4.outcome).toBe('out_of_scope');
    const action = await retrySyncCenterItem({
      actor: { role: 'manager' },
      row: waitingVoid({ id: 'ay', deviceId: 'Y' }),
      scope: scopeOf('A', 'X'),
      isOnline: true,
      nowMs: NOW,
      store,
    });
    expect(action.mutationReason).toBe('out_of_scope');
    expect(action.cycle).toBe('not_run');
  });

  it('T-PROV-3 forged extra argument cannot influence the parameter-less seam', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    await store.transact(['voidIntents'], 'readwrite', async (txn) => {
      await txn.put('voidIntents', 'v1', {
        orderId: 'v1',
        branchId: 'A',
        deviceId: 'X',
        reason: 'x',
        note: null,
        voidedBy: 's',
        status: 'pending',
        attempts: 1,
        createdAtMs: NOW,
        updatedAtMs: NOW,
        nextEligibleAtMs: NOW + 9_000,
        claimOwner: null,
        claimExpiresAtMs: null,
        lastErrorClass: null,
        lastErrorAtMs: null,
        terminalReason: null,
        confirmedAtMs: null,
        observedServerCreatedAtMs: null,
        schemaVersion: 1,
      });
    });
    const forged = { branchId: 'B', deviceId: 'X' };
    const result = await (
      voidStore.clearVoidIntentBackoffForOrder as unknown as (
        store: unknown,
        orderId: string,
        nowMs: number,
        extra?: unknown,
      ) => ReturnType<typeof voidStore.clearVoidIntentBackoffForOrder>
    )(store, 'v1', NOW, forged);
    expect(result.outcome).toBe('cleared');
    expect(result.record?.branchId).toBe('A');
  });

  it('T-PROV-4 captured closure re-reads canonical context at call time', async () => {
    __setCanonicalSyncContextForTests('B', 'X');
    const store = createInMemoryReversalStore();
    const captured = () =>
      retrySyncCenterItem({
        actor: { role: 'manager' },
        row: waitingVoid({ branchId: 'B' }),
        scope: scopeOf('B', 'X'),
        isOnline: true,
        nowMs: NOW,
        store,
      });
    __setCanonicalSyncContextForTests('A', 'X');
    const result = await captured();
    expect(result.mutationReason).toBe('stale_scope');
    expect(result.cycle).toBe('not_run');
  });

  it('T-PROV-5 honest A/X path still proceeds to S4', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    vi.spyOn(voidStore, 'clearVoidIntentBackoffForOrder').mockResolvedValue({
      outcome: 'cleared',
      record: { orderId: 'v1' } as VoidIntentRecord,
    });
    const cycle = vi.spyOn(orch, 'requestSyncOrchestratorItemRetryCycle').mockResolvedValue(cycleOutcome);
    const result = await retrySyncCenterItem({
      actor: { role: 'manager' },
      row: waitingVoid(),
      scope: scopeOf('A', 'X'),
      isOnline: true,
      nowMs: NOW,
      store: createInMemoryReversalStore(),
    });
    expect(result.mutation).toBe('cleared');
    expect(cycle).toHaveBeenCalledTimes(1);
  });

  it('T-PROV-6 reversal branch B is refused while canonical branch is A', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    await store.transact(['intents'], 'readwrite', async (txn) => {
      await txn.put('intents', 'rb', {
        id: 'rb',
        businessId: 'biz',
        sourceType: 'receiving',
        sourceId: 'src',
        action: 'void',
        branchId: 'B',
        reasonCode: 'x',
        createdAt: new Date(NOW).toISOString(),
        createdByStaffId: 's1',
        createdByRole: 'manager',
        idempotencyKey: 'k',
        localMutationId: 'm',
        localCorrection: { applied: true, reversed: false, stockDelta: [] },
        status: 'queued',
      });
    });
    expect(await orch.clearOfflineReversalRetryEligibility(store, 'rb', NOW)).toBe('out_of_scope');
  });
});
