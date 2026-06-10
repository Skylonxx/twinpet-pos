import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  applyServerResult,
  claimForSync,
  claimTokenOf,
  createOfflineReversal,
  getIntent,
  listClaimable,
  listQueue,
  readLocalStock,
  type QueueDeps,
  type RollbackSafetyProof,
} from './offlineReversalQueue';
import { OfflineReversalRejectedError, type ServerReversalResponse } from './offlineReversalLogic';
import type { CreateReversalInput, LocalMutationMarker } from './offlineReversalTypes';
import {
  createInMemoryReversalStore,
  type ReversalLocalStore,
  type ReversalStoreName,
  type ReversalTxn,
} from './reversalLocalStore';
import { syncOneReversal, syncPendingReversals, toResolveRequest, type CallResolveReversal } from './syncOfflineReversals';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Monotonic deterministic clock (ISO strings ascending by 1s per call). */
function fixedClock(start = 1_000_000_000_000): QueueDeps {
  let t = start;
  return { now: () => new Date((t += 1000)).toISOString() };
}

/** Manually controllable clock for lease-expiry tests. */
function manualClock(initialMs: number) {
  let t = initialMs;
  return {
    deps: { now: () => new Date(t).toISOString() } as QueueDeps,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const receivingInput: CreateReversalInput = {
  businessId: 'biz-1',
  sourceType: 'receiving',
  sourceId: 'GRN-001',
  action: 'reverse',
  createdByStaffId: 'mgr-1',
  actorRole: 'manager',
  branchId: 'b1',
  reasonCode: 'wrong_entry',
  // Receiving added +5 of p1 and +3 of p2 to b1 → reversal subtracts.
  originalEffects: [
    { productId: 'p1', locationId: 'b1', lotId: 'lot-1', quantity: 5 },
    { productId: 'p2', locationId: 'b1', quantity: 3 },
  ],
};

const okResponse: ServerReversalResponse = {
  ok: true,
  idempotencyKey: 'rev:biz-1:receiving:GRN-001:reverse',
  status: 'confirmed',
  serverReversalId: 'REV-abc',
  confirmedAtServer: '2026-06-10T00:00:00.000Z',
};

const rejectResponse = (o: Partial<ServerReversalResponse> = {}): ServerReversalResponse => ({
  ok: false,
  idempotencyKey: 'rev:biz-1:receiving:GRN-001:reverse',
  status: 'rejected',
  rejectCode: 'stock_conflict',
  message: 'partially sold',
  ...o,
});

/** Decorator that throws on the first `put` to `faultOn` — to prove atomic abort. */
function faultingPutStore(inner: ReversalLocalStore, faultOn: ReversalStoreName): ReversalLocalStore {
  return {
    transact(stores, mode, fn) {
      return inner.transact(stores, mode, (txn: ReversalTxn) => {
        const wrapped: ReversalTxn = {
          get: (s, k) => txn.get(s, k),
          getAll: (s) => txn.getAll(s),
          put: (s, k, v) => {
            if (s === faultOn) throw new Error('induced fault');
            return txn.put(s, k, v);
          },
          delete: (s, k) => txn.delete(s, k),
        };
        return fn(wrapped);
      });
    },
  };
}

let store: ReturnType<typeof createInMemoryReversalStore>;
beforeEach(() => {
  store = createInMemoryReversalStore();
});

// ─── Create + immediate correction ───────────────────────────────────────────

describe('createOfflineReversal', () => {
  test('creates a durable queue item', async () => {
    const intent = await createOfflineReversal(store, receivingInput, fixedClock());
    expect(intent.status).toBe('queued');
    expect(intent.localCorrection.applied).toBe(true);
    expect(intent.createdByRole).toBe('manager');

    const persisted = await getIntent(store, intent.id);
    expect(persisted).not.toBeNull();
    expect(persisted!.idempotencyKey).toBe('rev:biz-1:receiving:GRN-001:reverse');
    expect((await listQueue(store)).map((i) => i.id)).toEqual([intent.id]);
  });

  test('immediately applies the local stock correction', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 });
      await txn.put('stock', 'p2::b1', { productId: 'p2', locationId: 'b1', quantity: 4 });
    });

    await createOfflineReversal(store, receivingInput, fixedClock());

    expect(await readLocalStock(store, 'p1', 'b1')).toBe(5); // 10 - 5
    expect(await readLocalStock(store, 'p2', 'b1')).toBe(1); // 4 - 3
    const ledger = await store.transact(['ledger'], 'readonly', (txn) => txn.getAll('ledger'));
    expect(ledger).toHaveLength(2);
  });

  test('queue write + stock correction are atomic — a fault writes nothing', async () => {
    const faulty = faultingPutStore(store, 'markers');
    await expect(createOfflineReversal(faulty, receivingInput, fixedClock())).rejects.toThrow();

    const dump = store.dump();
    expect(dump.intents).toEqual({});
    expect(dump.stock).toEqual({});
    expect(dump.ledger).toEqual({});
    expect(dump.markers).toEqual({});
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(0);
  });

  test('local mutation id prevents double apply (replay does not double stock)', async () => {
    const clock = fixedClock();
    const first = await createOfflineReversal(store, receivingInput, clock);
    const second = await createOfflineReversal(store, receivingInput, clock);

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(-5); // applied once only
    expect(await listQueue(store)).toHaveLength(1);

    const marker = await store.transact(['markers'], 'readonly', (txn) =>
      txn.get<LocalMutationMarker>('markers', first.localMutationId),
    );
    expect(marker?.applied).toBe(true);
  });

  test('transfer reversal flips dest (−) and source (+)', async () => {
    const intent = await createOfflineReversal(
      store,
      {
        ...receivingInput,
        sourceType: 'transfer',
        sourceId: 'TR-1',
        originalEffects: [
          { productId: 'p1', locationId: 'dest', quantity: 7 },
          { productId: 'p1', locationId: 'src', quantity: -7 },
        ],
      },
      fixedClock(),
    );
    expect(intent.status).toBe('queued');
    expect(await readLocalStock(store, 'p1', 'dest')).toBe(-7);
    expect(await readLocalStock(store, 'p1', 'src')).toBe(7);
  });
});

// ─── Staff authority guard (Blocker 2) ───────────────────────────────────────

describe('offline staff authority (Blocker 2)', () => {
  test('staff offline reversal is rejected before the queue write', async () => {
    const staffInput: CreateReversalInput = { ...receivingInput, actorRole: 'staff' };
    await expect(createOfflineReversal(store, staffInput, fixedClock())).rejects.toBeInstanceOf(
      OfflineReversalRejectedError,
    );

    const dump = store.dump();
    expect(dump.intents).toEqual({}); // no queue item
    expect(dump.markers).toEqual({}); // no mutation marker
  });

  test('staff rejection does NOT apply any local stock correction', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 });
    });
    await expect(
      createOfflineReversal(store, { ...receivingInput, actorRole: 'staff' }, fixedClock()),
    ).rejects.toThrow(OfflineReversalRejectedError);

    expect(await readLocalStock(store, 'p1', 'b1')).toBe(10); // untouched
    const ledger = await store.transact(['ledger'], 'readonly', (txn) => txn.getAll('ledger'));
    expect(ledger).toHaveLength(0);
  });

  test('manager and admin offline reversals can be queued', async () => {
    const mgr = await createOfflineReversal(store, { ...receivingInput, actorRole: 'manager' }, fixedClock());
    const admin = await createOfflineReversal(
      store,
      { ...receivingInput, sourceId: 'GRN-ADM', actorRole: 'admin' },
      fixedClock(),
    );
    expect(mgr.status).toBe('queued');
    expect(admin.status).toBe('queued');
  });

  test('supported intent maps to a server payload the resolver accepts (no PIN needed for mgr/admin)', async () => {
    const intent = await createOfflineReversal(store, receivingInput, fixedClock());
    const req = toResolveRequest(intent);
    expect(req).toMatchObject({
      idempotencyKey: 'rev:biz-1:receiving:GRN-001:reverse',
      actionType: 'receiving_reversal',
      sourceDocumentId: 'GRN-001',
      sourceDocumentType: 'receiving',
      branchId: 'b1',
      reasonCode: 'wrong_entry',
      localIntentId: intent.id,
    });
  });
});

// ─── claimForSync + recoverable lease (Blocker 1) ────────────────────────────

describe('claimForSync (recoverable lease)', () => {
  test('an unexpired-lease syncing item cannot be claimed by a concurrent worker', async () => {
    const intent = await createOfflineReversal(store, receivingInput, fixedClock());
    const clk = manualClock(2_000_000_000_000);
    const first = await claimForSync(store, intent.id, { owner: 'A', leaseMs: 60_000, deps: clk.deps });
    expect(first?.status).toBe('syncing');
    expect(first?.syncLeaseOwner).toBe('A');

    clk.advance(10_000); // still within the 60s lease
    const second = await claimForSync(store, intent.id, { owner: 'B', leaseMs: 60_000, deps: clk.deps });
    expect(second).toBeNull(); // worker B is locked out
  });

  test('a syncing item with an EXPIRED lease is reclaimed after crash/reload', async () => {
    const intent = await createOfflineReversal(store, receivingInput, fixedClock());
    const clk = manualClock(2_000_000_000_000);
    // Worker A claims, then "crashes" before applyServerResult.
    const a = await claimForSync(store, intent.id, { owner: 'A', leaseMs: 60_000, deps: clk.deps });
    expect(a?.syncAttempt).toBe(1);

    clk.advance(120_000); // lease (60s) has now expired
    const recovered = await claimForSync(store, intent.id, { owner: 'B', leaseMs: 60_000, deps: clk.deps });
    expect(recovered).not.toBeNull();
    expect(recovered!.syncLeaseOwner).toBe('B');
    expect(recovered!.syncAttempt).toBe(2); // attempt count carried forward

    // ...and it can be driven to completion safely by the reclaiming worker.
    const done = await applyServerResult(
      store,
      claimTokenOf(recovered!),
      { kind: 'response', response: okResponse },
      { deps: clk.deps },
    );
    expect(done.outcome).toBe('applied');
    expect(done.intent!.status).toBe('server_accepted');
  });

  test('drainable list includes expired-lease syncing items but not live ones', async () => {
    const intent = await createOfflineReversal(store, receivingInput, fixedClock());
    const clk = manualClock(2_000_000_000_000);
    await claimForSync(store, intent.id, { owner: 'A', leaseMs: 60_000, deps: clk.deps });

    clk.advance(10_000);
    expect(await listClaimable(store, clk.deps)).toHaveLength(0); // live lease → not drainable
    clk.advance(120_000);
    expect((await listClaimable(store, clk.deps)).map((i) => i.id)).toEqual([intent.id]); // expired → drainable
  });

  test('returns null for a terminal (server_accepted) item', async () => {
    const intent = await createOfflineReversal(store, receivingInput, fixedClock());
    const claimed = await claimForSync(store, intent.id, { deps: fixedClock() });
    await applyServerResult(store, claimTokenOf(claimed!), { kind: 'response', response: okResponse }, { deps: fixedClock() });
    expect(await claimForSync(store, intent.id, { deps: fixedClock() })).toBeNull();
  });
});

// ─── Stale-worker race (claim-token verification) ────────────────────────────

describe('stale-worker race', () => {
  /** Set up: worker A claims, stalls past lease; worker B reclaims and reaches `terminal`. */
  async function reclaimedTerminal(terminal: 'accepted' | 'rejected_manual') {
    const intent = await createOfflineReversal(store, receivingInput, fixedClock());
    const clk = manualClock(2_000_000_000_000);
    const a = await claimForSync(store, intent.id, { owner: 'A', leaseMs: 60_000, deps: clk.deps });
    const tokenA = claimTokenOf(a!); // attempt 1, owner A

    clk.advance(120_000); // A's lease expires
    const b = await claimForSync(store, intent.id, { owner: 'B', leaseMs: 60_000, deps: clk.deps });
    const tokenB = claimTokenOf(b!); // attempt 2, owner B

    const outcome =
      terminal === 'accepted'
        ? { kind: 'response' as const, response: okResponse }
        : { kind: 'response' as const, response: rejectResponse() };
    const applied = await applyServerResult(store, tokenB, outcome, { deps: clk.deps });
    expect(applied.outcome).toBe('applied');
    return { intentId: intent.id, tokenA, clk };
  }

  test('stale network_error from an old worker cannot overwrite a newer server_accepted', async () => {
    const { intentId, tokenA, clk } = await reclaimedTerminal('accepted');
    const stale = await applyServerResult(store, tokenA, { kind: 'network_error' }, { deps: clk.deps });
    expect(stale.outcome).toBe('stale_noop');
    expect(stale.intent!.status).toBe('server_accepted');
    expect((await getIntent(store, intentId))!.status).toBe('server_accepted'); // unchanged
  });

  test('stale rejection from an old worker cannot overwrite a newer server_accepted', async () => {
    const { intentId, tokenA, clk } = await reclaimedTerminal('accepted');
    const stale = await applyServerResult(
      store,
      tokenA,
      { kind: 'response', response: rejectResponse() },
      { deps: clk.deps },
    );
    expect(stale.outcome).toBe('stale_noop');
    expect((await getIntent(store, intentId))!.status).toBe('server_accepted');
  });

  test('stale accepted result cannot overwrite a newer terminal owned by another claim', async () => {
    // Worker B drove the item to manual_review_required (rejection, no proof).
    const { intentId, tokenA, clk } = await reclaimedTerminal('rejected_manual');
    expect((await getIntent(store, intentId))!.status).toBe('manual_review_required');

    const stale = await applyServerResult(store, tokenA, { kind: 'response', response: okResponse }, { deps: clk.deps });
    expect(stale.outcome).toBe('stale_noop');
    expect((await getIntent(store, intentId))!.status).toBe('manual_review_required'); // not downgraded
  });

  test('no-ops when the claim token owner/attempt does not match', async () => {
    const intent = await createOfflineReversal(store, receivingInput, fixedClock());
    const claimed = await claimForSync(store, intent.id, { owner: 'A', deps: fixedClock() });
    const wrongToken = { ...claimTokenOf(claimed!), syncLeaseOwner: 'someone-else', syncAttempt: 99 };
    const res = await applyServerResult(store, wrongToken, { kind: 'response', response: okResponse }, { deps: fixedClock() });
    expect(res.outcome).toBe('stale_noop');
    expect((await getIntent(store, intent.id))!.status).toBe('syncing'); // still owned by A's claim
  });

  test('no-ops when the current status is not syncing (never claimed)', async () => {
    const intent = await createOfflineReversal(store, receivingInput, fixedClock());
    const token = { intentId: intent.id, syncLeaseOwner: 'A', syncAttempt: 1 };
    const res = await applyServerResult(store, token, { kind: 'response', response: okResponse }, { deps: fixedClock() });
    expect(res.outcome).toBe('stale_noop');
    expect((await getIntent(store, intent.id))!.status).toBe('queued'); // untouched
  });
});

// ─── applyServerResult ───────────────────────────────────────────────────────

describe('applyServerResult', () => {
  /** Create + claim, returning the claim token the active worker would hold. */
  async function created() {
    const intent = await createOfflineReversal(store, receivingInput, fixedClock());
    const claimed = await claimForSync(store, intent.id, { deps: fixedClock() });
    return { intent, token: claimTokenOf(claimed!) };
  }

  test('server accepted does not re-apply local stock and marks queue confirmed', async () => {
    const { token } = await created();
    const before = await readLocalStock(store, 'p1', 'b1'); // -5

    const res = await applyServerResult(store, token, { kind: 'response', response: okResponse }, { deps: fixedClock() });

    expect(res.outcome).toBe('applied');
    expect(res.intent!.status).toBe('server_accepted');
    expect(res.intent!.syncLeaseOwner).toBeNull(); // lease released
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(before); // NOT re-applied
    const marker = await store.transact(['markers'], 'readonly', (txn) =>
      txn.get<LocalMutationMarker>('markers', res.intent!.localMutationId),
    );
    expect(marker?.serverConfirmed).toBe(true);
  });

  test('network error becomes retryable_error, keeps the correction, and releases the lease', async () => {
    const { token } = await created();
    const res = await applyServerResult(
      store,
      token,
      { kind: 'network_error', error: new Error('offline') },
      { deps: fixedClock() },
    );
    expect(res.intent!.status).toBe('retryable_error');
    expect(res.intent!.localCorrection.applied).toBe(true);
    expect(res.intent!.localCorrection.reversed).toBe(false);
    expect(res.intent!.syncLeaseExpiresAt).toBeNull(); // immediately re-claimable
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(-5);
  });

  test('server-side conflict_requires_manual_review → manual_review_required (no rollback)', async () => {
    const { token } = await created();
    const res = await applyServerResult(
      store,
      token,
      { kind: 'response', response: rejectResponse({ status: 'conflict_requires_manual_review' }) },
      { deps: fixedClock() },
    );
    expect(res.intent!.status).toBe('manual_review_required');
    expect(res.intent!.rejectionCode).toBe('stock_conflict');
    expect(res.intent!.errorMessage).toBe('partially sold');
    expect(res.intent!.localCorrection.reversed).toBe(false);
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(-5);
  });

  // ── Blocker 3: fail-closed rollback ──
  test('server rejection does NOT auto-rollback by default (no safety proof)', async () => {
    const { token } = await created();
    const res = await applyServerResult(
      store,
      token,
      { kind: 'response', response: rejectResponse() },
      { deps: fixedClock() }, // no proveRollbackSafe → fail closed
    );
    expect(res.intent!.status).toBe('manual_review_required');
    expect(res.intent!.localCorrection.reversed).toBe(false);
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(-5); // correction preserved
  });

  test('rejection with UNKNOWN dependency state (throwing proof) → manual_review_required', async () => {
    const { token } = await created();
    const throwingProof: RollbackSafetyProof = () => {
      throw new Error('cannot determine');
    };
    const res = await applyServerResult(
      store,
      token,
      { kind: 'response', response: rejectResponse() },
      { proveRollbackSafe: throwingProof, deps: fixedClock() },
    );
    expect(res.intent!.status).toBe('manual_review_required');
    expect(res.intent!.localCorrection.reversed).toBe(false);
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(-5);
  });

  test('rejection with proof returning false → manual_review_required', async () => {
    const { token } = await created();
    const res = await applyServerResult(
      store,
      token,
      { kind: 'response', response: rejectResponse() },
      { proveRollbackSafe: () => false, deps: fixedClock() },
    );
    expect(res.intent!.status).toBe('manual_review_required');
    expect(res.intent!.localCorrection.reversed).toBe(false);
  });

  test('rollback happens ONLY when safety is explicitly proven (proof === true)', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 });
      await txn.put('stock', 'p2::b1', { productId: 'p2', locationId: 'b1', quantity: 4 });
    });
    const intent = await createOfflineReversal(store, receivingInput, fixedClock());
    const claimed = await claimForSync(store, intent.id, { deps: fixedClock() });
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(5); // corrected

    const out = await applyServerResult(
      store,
      claimTokenOf(claimed!),
      { kind: 'response', response: rejectResponse() },
      { proveRollbackSafe: () => true, deps: fixedClock() },
    );
    expect(out.intent!.status).toBe('server_rejected');
    expect(out.intent!.localCorrection.reversed).toBe(true);
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(10); // restored
    expect(await readLocalStock(store, 'p2', 'b1')).toBe(4);

    const marker = await store.transact(['markers'], 'readonly', (txn) =>
      txn.get<LocalMutationMarker>('markers', intent.localMutationId),
    );
    expect(marker?.reversed).toBe(true);
  });
});

// ─── Sync worker ─────────────────────────────────────────────────────────────

describe('syncOneReversal / syncPendingReversals', () => {
  test('a transport throw is captured as retryable, never a rejection', async () => {
    const intent = await createOfflineReversal(store, receivingInput, fixedClock());
    const call: CallResolveReversal = vi.fn().mockRejectedValue(new Error('ERR_INTERNET_DISCONNECTED'));

    const res = await syncOneReversal(store, intent.id, call, { deps: fixedClock() });
    expect(res.claimed).toBe(true);
    expect(res.intent!.status).toBe('retryable_error');
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(-5);
  });

  test('an item with a live lease (held by another worker) is not processed twice', async () => {
    const intent = await createOfflineReversal(store, receivingInput, fixedClock());
    const clk = manualClock(2_000_000_000_000);
    await claimForSync(store, intent.id, { owner: 'A', leaseMs: 60_000, deps: clk.deps }); // other worker
    const call = vi.fn<CallResolveReversal>().mockResolvedValue(okResponse);

    clk.advance(5_000); // lease still live
    const res = await syncOneReversal(store, intent.id, call, { owner: 'B', leaseMs: 60_000, deps: clk.deps });
    expect(res.claimed).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  test('drains queued items and accepts them', async () => {
    const clock = fixedClock();
    await createOfflineReversal(store, receivingInput, clock);
    await createOfflineReversal(
      store,
      { ...receivingInput, sourceId: 'GRN-002', originalEffects: [{ productId: 'p9', locationId: 'b1', quantity: 2 }] },
      clock,
    );
    const call = vi.fn<CallResolveReversal>().mockImplementation(async (req) => ({
      ...okResponse,
      idempotencyKey: req.idempotencyKey,
    }));

    const results = await syncPendingReversals(store, call, { deps: clock });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.intent?.status === 'server_accepted')).toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
    expect(await listClaimable(store, clock)).toHaveLength(0);
  });
});
