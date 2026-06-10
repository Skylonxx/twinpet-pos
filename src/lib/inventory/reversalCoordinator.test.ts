import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildReceivingReversalEffects,
  decideReversalRoute,
  executeReceivingReversal,
  ReceivingReversalEvidenceError,
  TRANSFER_REVERSAL_DEFERRED_NOTE,
  type ReceivingReversalInput,
  type ReceivingReversalItem,
  type ReversalCoordinatorDeps,
} from './reversalCoordinator';
import { OfflineReversalRejectedError, type ServerReversalResponse } from '../pos/offline/offlineReversalLogic';
import { listQueue, readLocalStock } from '../pos/offline/offlineReversalQueue';
import { createInMemoryReversalStore } from '../pos/offline/reversalLocalStore';
import type { CallResolveReversal } from '../pos/offline/syncOfflineReversals';

function fixedClock(start = 1_000_000_000_000) {
  let t = start;
  return () => new Date((t += 1000)).toISOString();
}

const baseInput: ReceivingReversalInput = {
  receivingId: 'GRN-001',
  branchId: 'b1',
  actorRole: 'manager',
  staffId: 'mgr-1',
  reason: 'บันทึกผิด',
  note: 'ทดสอบ',
  items: [
    { productId: 'p1', qtyBase: 5, lotId: 'lot-1' },
    { productId: 'p2', qtyBase: 3, lotId: 'lot-2' },
  ],
};

const okResponse: ServerReversalResponse = {
  ok: true,
  idempotencyKey: 'rev:b1:receiving:GRN-001:void',
  status: 'confirmed',
  serverReversalId: 'REV-1',
};

let store: ReturnType<typeof createInMemoryReversalStore>;
function makeDeps(over: Partial<ReversalCoordinatorDeps> = {}): ReversalCoordinatorDeps {
  return {
    store,
    isOnline: () => false,
    call: vi.fn<CallResolveReversal>().mockResolvedValue(okResponse),
    now: fixedClock(),
    ...over,
  };
}

beforeEach(() => {
  store = createInMemoryReversalStore();
});

// ─── Pure routing / effect building ──────────────────────────────────────────

describe('decideReversalRoute', () => {
  test('receiving → queue-first; transfer → legacy executor', () => {
    expect(decideReversalRoute('receiving')).toBe('receiving_queue_first');
    expect(decideReversalRoute('transfer')).toBe('transfer_legacy_executor');
  });

  test('the transfer deferral note documents why completed transfers stay legacy', () => {
    expect(TRANSFER_REVERSAL_DEFERRED_NOTE).toMatch(/sent.*received/);
    expect(TRANSFER_REVERSAL_DEFERRED_NOTE).toMatch(/cancelBranchTransfer/);
  });
});

describe('buildReceivingReversalEffects', () => {
  test('maps each line to +qtyBase at the branch and drops zero-qty lines', () => {
    expect(
      buildReceivingReversalEffects(
        [
          { productId: 'p1', qtyBase: 5, lotId: 'lot-1' },
          { productId: 'p2', qtyBase: 0 },
          { productId: 'p3', qtyBase: 2 },
        ],
        'b1',
      ),
    ).toEqual([
      { productId: 'p1', locationId: 'b1', lotId: 'lot-1', quantity: 5 },
      { productId: 'p3', locationId: 'b1', lotId: null, quantity: 2 },
    ]);
  });
});

// ─── executeReceivingReversal ────────────────────────────────────────────────

describe('executeReceivingReversal — offline (no instant resolver call)', () => {
  test('manager offline: queues + applies immediate local IndexedDB correction, no sync', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 });
      await txn.put('stock', 'p2::b1', { productId: 'p2', locationId: 'b1', quantity: 4 });
    });
    const call = vi.fn<CallResolveReversal>();
    const out = await executeReceivingReversal(makeDeps({ isOnline: () => false, call }), baseInput);

    expect(out.status).toBe('queued');
    expect(out.synced).toBe(false);
    expect(call).not.toHaveBeenCalled(); // no resolver call while offline
    // Immediate local correction applied to the queue's IndexedDB counters.
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(5); // 10 - 5
    expect(await readLocalStock(store, 'p2', 'b1')).toBe(1); // 4 - 3
    expect(await listQueue(store)).toHaveLength(1);
  });
});

describe('executeReceivingReversal — online sync', () => {
  test('manager online: syncs to resolver and confirms (server_accepted)', async () => {
    const call = vi.fn<CallResolveReversal>().mockResolvedValue(okResponse);
    const out = await executeReceivingReversal(makeDeps({ isOnline: () => true, call }), baseInput);

    expect(call).toHaveBeenCalledTimes(1);
    expect(out.synced).toBe(true);
    expect(out.status).toBe('server_accepted');
    expect(out.manualReviewRequired).toBe(false);
    // Local correction is NOT re-applied on accept (server is authoritative).
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(-5);
  });

  test('server rejection (no safety proof) is preserved as manual_review_required', async () => {
    const call = vi.fn<CallResolveReversal>().mockResolvedValue({
      ok: false,
      idempotencyKey: 'rev:b1:receiving:GRN-001:void',
      status: 'rejected',
      rejectCode: 'stock_conflict',
      message: 'partially sold',
    });
    const out = await executeReceivingReversal(makeDeps({ isOnline: () => true, call }), baseInput);

    expect(out.status).toBe('manual_review_required');
    expect(out.manualReviewRequired).toBe(true);
    expect(out.intent.rejectionCode).toBe('stock_conflict');
    // Fail-closed: the local correction is preserved (no auto-rollback).
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(-5);
  });

  test('network error during online sync stays retryable_error (correction preserved)', async () => {
    const call = vi.fn<CallResolveReversal>().mockRejectedValue(new Error('ERR_INTERNET_DISCONNECTED'));
    const out = await executeReceivingReversal(makeDeps({ isOnline: () => true, call }), baseInput);

    expect(out.status).toBe('retryable_error');
    expect(out.manualReviewRequired).toBe(false);
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(-5);
  });
});

// ─── Fail-closed receiving evidence gate (Track A blocker) ───────────────────

describe('executeReceivingReversal — incomplete item/lot evidence fails closed', () => {
  // Each rejection must prove: no resolver call, no queue item, no local stock
  // mutation — i.e. the gate runs BEFORE createOfflineReversal touches anything.
  async function expectRejectedBeforeAnyWrite(
    items: ReceivingReversalInput['items'] | null | undefined,
  ): Promise<ReceivingReversalEvidenceError> {
    // Seed stock so we can prove it is left untouched on rejection.
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 });
    });
    const call = vi.fn<CallResolveReversal>();
    // Online so a passing path WOULD call the resolver — proving the gate fired first.
    const input = { ...baseInput, items: items as ReceivingReversalInput['items'] };
    let caught: unknown;
    try {
      await executeReceivingReversal(makeDeps({ isOnline: () => true, call }), input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReceivingReversalEvidenceError);
    expect(call).not.toHaveBeenCalled(); // syncOneReversal → resolver never reached
    expect(await listQueue(store)).toHaveLength(0); // no durable queue item
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(10); // no local correction
    return caught as ReceivingReversalEvidenceError;
  }

  test('missing items (undefined) rejects before any queue write', async () => {
    const err = await expectRejectedBeforeAnyWrite(undefined);
    expect(err.code).toBe('missing_items');
  });

  test('empty receiving items rejects before any queue write', async () => {
    const err = await expectRejectedBeforeAnyWrite([]);
    expect(err.code).toBe('empty_items');
  });

  test('missing productId rejects before any queue write', async () => {
    const err = await expectRejectedBeforeAnyWrite([
      { productId: '', qtyBase: 5, lotId: 'lot-1' },
    ]);
    expect(err.code).toBe('missing_product_id');
  });

  test('missing lotId rejects before any queue write (never coerced to null)', async () => {
    const err = await expectRejectedBeforeAnyWrite([
      { productId: 'p1', qtyBase: 5 } as ReceivingReversalItem, // lotId absent
    ]);
    expect(err.code).toBe('missing_lot_id');
  });

  test('null lotId rejects before any queue write', async () => {
    const err = await expectRejectedBeforeAnyWrite([
      { productId: 'p1', qtyBase: 5, lotId: null },
    ]);
    expect(err.code).toBe('missing_lot_id');
  });

  test('qtyBase = 0 rejects before any queue write', async () => {
    const err = await expectRejectedBeforeAnyWrite([
      { productId: 'p1', qtyBase: 0, lotId: 'lot-1' },
    ]);
    expect(err.code).toBe('non_positive_qty');
  });

  test('qtyBase < 0 rejects before any queue write', async () => {
    const err = await expectRejectedBeforeAnyWrite([
      { productId: 'p1', qtyBase: -3, lotId: 'lot-1' },
    ]);
    expect(err.code).toBe('non_positive_qty');
  });

  test('qtyBase = NaN rejects before any queue write', async () => {
    const err = await expectRejectedBeforeAnyWrite([
      { productId: 'p1', qtyBase: Number.NaN, lotId: 'lot-1' },
    ]);
    expect(err.code).toBe('non_finite_qty');
  });

  test('qtyBase = Infinity rejects before any queue write', async () => {
    const err = await expectRejectedBeforeAnyWrite([
      { productId: 'p1', qtyBase: Number.POSITIVE_INFINITY, lotId: 'lot-1' },
    ]);
    expect(err.code).toBe('non_finite_qty');
  });

  test('mixed valid + invalid set rejects all-or-nothing (no valid line is queued)', async () => {
    // First line is fully valid; second is malformed. The whole set must reject.
    const err = await expectRejectedBeforeAnyWrite([
      { productId: 'p1', qtyBase: 5, lotId: 'lot-1' },
      { productId: 'p2', qtyBase: 0, lotId: 'lot-2' },
    ]);
    expect(err.code).toBe('non_positive_qty');
  });

  test('valid lot-backed positive item set still queues and applies local correction', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 });
      await txn.put('stock', 'p2::b1', { productId: 'p2', locationId: 'b1', quantity: 4 });
    });
    const call = vi.fn<CallResolveReversal>();
    const out = await executeReceivingReversal(makeDeps({ isOnline: () => false, call }), baseInput);

    expect(out.status).toBe('queued');
    expect(await listQueue(store)).toHaveLength(1);
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(5); // 10 - 5
    expect(await readLocalStock(store, 'p2', 'b1')).toBe(1); // 4 - 3
  });
});

describe('executeReceivingReversal — Staff authority (Blocker 2 preserved)', () => {
  test('Staff is rejected BEFORE any queue write or local stock mutation', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 });
    });
    const call = vi.fn<CallResolveReversal>();
    await expect(
      executeReceivingReversal(makeDeps({ isOnline: () => true, call }), { ...baseInput, actorRole: 'staff' }),
    ).rejects.toBeInstanceOf(OfflineReversalRejectedError);

    expect(call).not.toHaveBeenCalled(); // never reached the resolver
    expect(await listQueue(store)).toHaveLength(0); // no queue item
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(10); // stock untouched
  });
});
