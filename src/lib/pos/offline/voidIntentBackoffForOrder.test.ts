import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryReversalStore, type ReversalLocalStore, type ReversalStoreName } from './reversalLocalStore';
import {
  clearVoidIntentBackoffForOrder,
  getVoidIntent,
  subscribeVoidIntentStore,
  __resetVoidIntentStoreListenersForTests,
  type VoidIntentRecord,
} from './voidIntentStore';
import {
  __resetCanonicalSyncContextForTests,
  __setCanonicalSyncContextForTests,
} from './canonicalSyncContext';

const NOW = 1_700_000_000_000;

function delayedVoid(
  over: Partial<VoidIntentRecord> & Pick<VoidIntentRecord, 'orderId' | 'branchId' | 'deviceId'>,
): VoidIntentRecord {
  return {
    reason: 'x',
    note: null,
    voidedBy: 's',
    status: 'pending',
    attempts: 2,
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
    ...over,
  };
}

async function putVoid(store: ReversalLocalStore, rec: VoidIntentRecord): Promise<void> {
  await store.transact(['voidIntents'], 'readwrite', async (txn) => {
    await txn.put('voidIntents', rec.orderId, rec);
  });
}

function wrapDeferredGet(
  inner: ReversalLocalStore,
  match: (store: ReversalStoreName, key: string) => boolean,
): { store: ReversalLocalStore; release: () => void; waiting: () => boolean; puts: Array<{ store: string; key: string }> } {
  let resolveHold: () => void = () => undefined;
  const hold = new Promise<void>((r) => {
    resolveHold = r;
  });
  let waiting = false;
  const puts: Array<{ store: string; key: string }> = [];
  return {
    puts,
    waiting: () => waiting,
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
            put: async (store, key, value) => {
              puts.push({ store, key });
              return txn.put(store, key, value);
            },
            delete: (store, key) => txn.delete(store, key),
          }),
        ),
    },
  };
}

async function waitUntil(pred: () => boolean): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 2_000) throw new Error('timed out waiting for txn.get');
    await Promise.resolve();
  }
}

afterEach(() => {
  __resetCanonicalSyncContextForTests();
  __resetVoidIntentStoreListenersForTests();
});

describe('clearVoidIntentBackoffForOrder', () => {
  it('N-R3-1 terminal void cannot be targeted', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    const rec = delayedVoid({
      orderId: 't1',
      branchId: 'A',
      deviceId: 'X',
      status: 'terminal',
      terminalReason: 'authority_refused',
      nextEligibleAtMs: NOW + 9_000,
    });
    await putVoid(store, rec);
    const notify = vi.fn();
    subscribeVoidIntentStore(notify);
    const result = await clearVoidIntentBackoffForOrder(store, 't1', NOW);
    expect(result.outcome).toBe('terminal');
    expect(await getVoidIntent(store, 't1')).toEqual(rec);
    expect(notify).not.toHaveBeenCalled();
  });

  it('N-R3-2 confirmed void cannot be targeted', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    const rec = delayedVoid({
      orderId: 'c1',
      branchId: 'A',
      deviceId: 'X',
      status: 'confirmed',
      confirmedAtMs: NOW,
      nextEligibleAtMs: 0,
    });
    await putVoid(store, rec);
    const result = await clearVoidIntentBackoffForOrder(store, 'c1', NOW);
    expect(result.outcome).toBe('confirmed');
    expect(await getVoidIntent(store, 'c1')).toEqual(rec);
  });

  it('N-R3-3 live in-flight claim cannot be targeted', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    const rec = delayedVoid({
      orderId: 'f1',
      branchId: 'A',
      deviceId: 'X',
      status: 'in_flight',
      claimOwner: 'owner',
      claimExpiresAtMs: NOW + 60_000,
      nextEligibleAtMs: 0,
    });
    await putVoid(store, rec);
    const result = await clearVoidIntentBackoffForOrder(store, 'f1', NOW);
    expect(result.outcome).toBe('in_flight_claim_live');
    expect(await getVoidIntent(store, 'f1')).toEqual(rec);
  });

  it('N-R3-4 wrong branch and wrong device are out_of_scope', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    const wrongBranch = delayedVoid({ orderId: 'b', branchId: 'B', deviceId: 'X' });
    const wrongDevice = delayedVoid({ orderId: 'd', branchId: 'A', deviceId: 'Y' });
    await putVoid(store, wrongBranch);
    await putVoid(store, wrongDevice);
    expect((await clearVoidIntentBackoffForOrder(store, 'b', NOW)).outcome).toBe('out_of_scope');
    expect((await clearVoidIntentBackoffForOrder(store, 'd', NOW)).outcome).toBe('out_of_scope');
    expect(await getVoidIntent(store, 'b')).toEqual(wrongBranch);
    expect(await getVoidIntent(store, 'd')).toEqual(wrongDevice);
  });

  it('N-R3-5 already-eligible void does not write or notify', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    const rec = delayedVoid({ orderId: 'e1', branchId: 'A', deviceId: 'X', nextEligibleAtMs: 0 });
    await putVoid(store, rec);
    const notify = vi.fn();
    subscribeVoidIntentStore(notify);
    const result = await clearVoidIntentBackoffForOrder(store, 'e1', NOW);
    expect(result.outcome).toBe('already_eligible');
    expect(await getVoidIntent(store, 'e1')).toEqual(rec);
    expect(notify).not.toHaveBeenCalled();
  });

  it('N-R3-6 / N-R3-7 cleared retains attempts and notifies once; unrelated delayed void is unchanged', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    const target = delayedVoid({ orderId: 'keep-attempts', branchId: 'A', deviceId: 'X', attempts: 4 });
    const other = delayedVoid({ orderId: 'other', branchId: 'A', deviceId: 'X', attempts: 3, nextEligibleAtMs: NOW + 12_000 });
    await putVoid(store, target);
    await putVoid(store, other);
    const notify = vi.fn();
    subscribeVoidIntentStore(notify);
    const result = await clearVoidIntentBackoffForOrder(store, 'keep-attempts', NOW);
    expect(result.outcome).toBe('cleared');
    expect(result.record?.attempts).toBe(4);
    expect(result.record?.nextEligibleAtMs).toBe(0);
    expect((await getVoidIntent(store, 'other'))?.nextEligibleAtMs).toBe(NOW + 12_000);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('absent record returns absent', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    const result = await clearVoidIntentBackoffForOrder(store, 'missing', NOW);
    expect(result).toEqual({ outcome: 'absent', record: null });
  });

  it('N-R2-1 item path clears only the selected delayed void', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    await putVoid(store, delayedVoid({ orderId: 'a', branchId: 'A', deviceId: 'X' }));
    await putVoid(store, delayedVoid({ orderId: 'b', branchId: 'A', deviceId: 'X' }));
    await clearVoidIntentBackoffForOrder(store, 'a', NOW);
    expect((await getVoidIntent(store, 'a'))?.nextEligibleAtMs).toBe(0);
    expect((await getVoidIntent(store, 'b'))?.nextEligibleAtMs).toBe(NOW + 9_000);
  });

  it('early null canonical refuses before any durable read', async () => {
    const store = createInMemoryReversalStore();
    await putVoid(store, delayedVoid({ orderId: 'z', branchId: 'A', deviceId: 'X' }));
    const result = await clearVoidIntentBackoffForOrder(store, 'z', NOW);
    expect(result).toEqual({ outcome: 'out_of_scope', record: null });
    expect((await getVoidIntent(store, 'z'))?.nextEligibleAtMs).toBe(NOW + 9_000);
  });

  it('T-RACE-VOID-1 branch switch B→A after durable hold is out_of_scope', async () => {
    __setCanonicalSyncContextForTests('B', 'X');
    const inner = createInMemoryReversalStore();
    const rec = delayedVoid({ orderId: 'race-b', branchId: 'B', deviceId: 'X' });
    await putVoid(inner, rec);
    const wrapped = wrapDeferredGet(inner, (store, key) => store === 'voidIntents' && key === 'race-b');
    const notify = vi.fn();
    subscribeVoidIntentStore(notify);
    const pending = clearVoidIntentBackoffForOrder(wrapped.store, 'race-b', NOW);
    await waitUntil(wrapped.waiting);
    __setCanonicalSyncContextForTests('A', 'X');
    wrapped.release();
    const result = await pending;
    expect(result.outcome).toBe('out_of_scope');
    expect(wrapped.puts).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(await getVoidIntent(inner, 'race-b')).toEqual(rec);
  });

  it('T-RACE-VOID-2 device axis: X→Y against A/Y is accepted; Y→X against A/X refuse is proven', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const inner = createInMemoryReversalStore();
    const recY = delayedVoid({ orderId: 'dev-y', branchId: 'A', deviceId: 'Y' });
    await putVoid(inner, recY);
    const wrappedY = wrapDeferredGet(inner, (store, key) => store === 'voidIntents' && key === 'dev-y');
    const pendingY = clearVoidIntentBackoffForOrder(wrappedY.store, 'dev-y', NOW);
    await waitUntil(wrappedY.waiting);
    __setCanonicalSyncContextForTests('A', 'Y');
    wrappedY.release();
    const accepted = await pendingY;
    expect(accepted.outcome).toBe('cleared');
    expect(accepted.record?.attempts).toBe(2);

    const recX = delayedVoid({ orderId: 'dev-x', branchId: 'A', deviceId: 'X' });
    await putVoid(inner, recX);
    __setCanonicalSyncContextForTests('A', 'Y');
    const wrappedX = wrapDeferredGet(inner, (store, key) => store === 'voidIntents' && key === 'dev-x');
    const pendingX = clearVoidIntentBackoffForOrder(wrappedX.store, 'dev-x', NOW);
    await waitUntil(wrappedX.waiting);
    __setCanonicalSyncContextForTests('A', 'X');
    wrappedX.release();
    const afterSwitchToMatch = await pendingX;
    expect(afterSwitchToMatch.outcome).toBe('cleared');

    const recRefuse = delayedVoid({ orderId: 'dev-refuse', branchId: 'A', deviceId: 'X' });
    await putVoid(inner, recRefuse);
    __setCanonicalSyncContextForTests('A', 'X');
    const wrappedR = wrapDeferredGet(inner, (store, key) => store === 'voidIntents' && key === 'dev-refuse');
    const pendingR = clearVoidIntentBackoffForOrder(wrappedR.store, 'dev-refuse', NOW);
    await waitUntil(wrappedR.waiting);
    __setCanonicalSyncContextForTests('A', 'Y');
    wrappedR.release();
    const refused = await pendingR;
    expect(refused.outcome).toBe('out_of_scope');
    expect(await getVoidIntent(inner, 'dev-refuse')).toEqual(recRefuse);
  });

  it('T-RACE-OK honest in-scope delayed void still clears', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const store = createInMemoryReversalStore();
    await putVoid(store, delayedVoid({ orderId: 'ok', branchId: 'A', deviceId: 'X', attempts: 5 }));
    const result = await clearVoidIntentBackoffForOrder(store, 'ok', NOW);
    expect(result.outcome).toBe('cleared');
    expect(result.record?.attempts).toBe(5);
    expect(result.record?.nextEligibleAtMs).toBe(0);
  });
});
