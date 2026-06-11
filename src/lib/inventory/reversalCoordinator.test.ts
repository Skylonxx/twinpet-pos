import { beforeEach, describe, expect, test, vi } from 'vitest';
// Raw page/source text for the H6-D2 source-level mutual-exclusion checks (Vite `?raw`).
import transferHistorySrc from '../../pages/inventory/TransferHistoryPage.tsx?raw';
import adminTransferSrc from '../../pages/admin/AdminTransferPage.tsx?raw';
import transferCrudSrc from './transferCrud.ts?raw';
import {
  assertTransferReversalInput,
  buildReceivingReversalEffects,
  buildTransferReversalEffects,
  canBranchReverseTransfer,
  decideReversalRoute,
  executeReceivingReversal,
  executeTransferReversal,
  ReceivingReversalEvidenceError,
  resolveTransferReversalEffects,
  toObservedDocumentUpdatedAtIso,
  TransferReversalEvidenceError,
  validateReceivingHeaderEvidence,
  validateTransferHeaderEvidence,
  type ReceivingReversalInput,
  type ReceivingReversalItem,
  type ReversalCoordinatorDeps,
  type TransferReversalInput,
} from './reversalCoordinator';
import { buildTransferReversalEvidence } from './transferReversalEvidence';
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
  test('receiving → queue-first; transfer → queue-first (H6-D2 route flip)', () => {
    expect(decideReversalRoute('receiving')).toBe('receiving_queue_first');
    expect(decideReversalRoute('transfer')).toBe('transfer_queue_first');
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

// ─── Phase 7B-H1: header reversal-evidence preference + fail-closed ───────────

/** A well-formed header snapshot matching `baseInput`'s effects (p1×5/lot-1, p2×3/lot-2). */
function validHeaderEvidence() {
  return {
    version: 1,
    source: 'receiving_completion',
    itemCount: 2,
    totalQtyBase: 8,
    effects: [
      { productId: 'p1', lotId: 'lot-1', qtyBase: 5 },
      { productId: 'p2', lotId: 'lot-2', qtyBase: 3 },
    ],
    createdAt: { seconds: 1 },
    createdBy: 'mgr-1',
  };
}

describe('validateReceivingHeaderEvidence (pure projection)', () => {
  test('projects each effect to +qtyBase at the branch', () => {
    expect(validateReceivingHeaderEvidence(validHeaderEvidence(), 'b1')).toEqual([
      { productId: 'p1', locationId: 'b1', lotId: 'lot-1', quantity: 5 },
      { productId: 'p2', locationId: 'b1', lotId: 'lot-2', quantity: 3 },
    ]);
  });

  test('preserves distinct lot-level segments for the same product (ghost reconcile + new lot)', () => {
    const header = {
      version: 1,
      source: 'receiving_completion',
      itemCount: 3,
      totalQtyBase: 10,
      effects: [
        { productId: 'p1', lotId: 'ghost-A', qtyBase: 3 },
        { productId: 'p1', lotId: 'ghost-B', qtyBase: 2 },
        { productId: 'p1', lotId: 'new-C', qtyBase: 5 },
      ],
    };
    expect(validateReceivingHeaderEvidence(header, 'b1')).toEqual([
      { productId: 'p1', locationId: 'b1', lotId: 'ghost-A', quantity: 3 },
      { productId: 'p1', locationId: 'b1', lotId: 'ghost-B', quantity: 2 },
      { productId: 'p1', locationId: 'b1', lotId: 'new-C', quantity: 5 },
    ]);
  });

  test('accepts duplicate (product, lot) effects and AGGREGATES them (summed once, not rejected)', () => {
    const header = {
      version: 1,
      source: 'receiving_completion',
      itemCount: 2, // raw persisted count (checksum is over raw entries)
      totalQtyBase: 8,
      effects: [
        { productId: 'p1', lotId: 'lot-1', qtyBase: 5 },
        { productId: 'p1', lotId: 'lot-1', qtyBase: 3 }, // same product+lot
      ],
    };
    expect(validateReceivingHeaderEvidence(header, 'b1')).toEqual([
      { productId: 'p1', locationId: 'b1', lotId: 'lot-1', quantity: 8 }, // 5 + 3, once
    ]);
  });
});

describe('executeReceivingReversal — header evidence is preferred (Phase 7B-H1)', () => {
  test('valid header is used and recorded as evidenceSource=header_snapshot', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 });
      await txn.put('stock', 'p2::b1', { productId: 'p2', locationId: 'b1', quantity: 4 });
    });
    const out = await executeReceivingReversal(makeDeps({ isOnline: () => false }), {
      ...baseInput,
      headerEvidence: validHeaderEvidence(),
    });

    expect(out.status).toBe('queued');
    expect(out.evidenceSource).toBe('header_snapshot');
    expect(out.intent.evidenceSource).toBe('header_snapshot'); // durably on the intent
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(5); // 10 - 5
    expect(await readLocalStock(store, 'p2', 'b1')).toBe(1); // 4 - 3
  });

  test('duplicate same-lot header evidence is accepted and does NOT double-apply beyond the summed qty (Blocker 2)', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 20 });
    });
    const out = await executeReceivingReversal(makeDeps({ isOnline: () => false }), {
      ...baseInput,
      headerEvidence: {
        version: 1,
        source: 'receiving_completion',
        itemCount: 2,
        totalQtyBase: 10,
        effects: [
          { productId: 'p1', lotId: 'lot-1', qtyBase: 6 },
          { productId: 'p1', lotId: 'lot-1', qtyBase: 4 }, // same product+lot → sums to 10
        ],
      },
    });

    expect(out.status).toBe('queued'); // accepted, not rejected
    expect(out.evidenceSource).toBe('header_snapshot');
    // Summed ONCE: 20 - 10 = 10 (not 20 - 20 from a double-apply).
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(10);
  });

  test('lot-segment header (ghost reconcile + new lot) applies the correct product-level correction', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 30 });
    });
    const out = await executeReceivingReversal(makeDeps({ isOnline: () => false }), {
      ...baseInput,
      headerEvidence: {
        version: 1,
        source: 'receiving_completion',
        itemCount: 3,
        totalQtyBase: 10,
        effects: [
          { productId: 'p1', lotId: 'ghost-A', qtyBase: 3 },
          { productId: 'p1', lotId: 'ghost-B', qtyBase: 2 },
          { productId: 'p1', lotId: 'new-C', qtyBase: 5 },
        ],
      },
    });

    expect(out.status).toBe('queued');
    expect(out.evidenceSource).toBe('header_snapshot');
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(20); // 30 - (3+2+5)
  });

  test('valid header is used even when the item subcollection is empty/garbage (no dependency on items)', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 });
      await txn.put('stock', 'p2::b1', { productId: 'p2', locationId: 'b1', quantity: 4 });
    });
    // Items that would FAIL the legacy gate — proves the header path ignores them.
    const out = await executeReceivingReversal(makeDeps({ isOnline: () => false }), {
      ...baseInput,
      items: [],
      headerEvidence: validHeaderEvidence(),
    });

    expect(out.status).toBe('queued');
    expect(out.evidenceSource).toBe('header_snapshot');
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(5);
    expect(await readLocalStock(store, 'p2', 'b1')).toBe(1);
  });

  test('missing header (null) falls back to strict legacy items → evidenceSource=legacy_subcollection', async () => {
    const out = await executeReceivingReversal(makeDeps({ isOnline: () => false }), {
      ...baseInput,
      headerEvidence: null,
    });
    expect(out.status).toBe('queued');
    expect(out.evidenceSource).toBe('legacy_subcollection');
    expect(out.intent.evidenceSource).toBe('legacy_subcollection');
  });

  test('absent header (undefined) also uses the legacy fallback', async () => {
    const out = await executeReceivingReversal(makeDeps({ isOnline: () => false }), baseInput);
    expect(out.evidenceSource).toBe('legacy_subcollection');
  });
});

describe('executeReceivingReversal — present-but-invalid header fails closed (no fallback)', () => {
  // Even with a PERFECTLY VALID item subcollection, a present-but-malformed header
  // must reject before any write — a corrupt/partial header is a danger signal.
  async function expectHeaderRejectedNoFallback(
    headerEvidence: unknown,
  ): Promise<ReceivingReversalEvidenceError> {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 });
    });
    const call = vi.fn<CallResolveReversal>();
    let caught: unknown;
    try {
      await executeReceivingReversal(makeDeps({ isOnline: () => true, call }), {
        ...baseInput, // items are VALID — the header invalidity must still win
        headerEvidence,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReceivingReversalEvidenceError);
    expect(call).not.toHaveBeenCalled(); // resolver never reached
    expect(await listQueue(store)).toHaveLength(0); // no queue write
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(10); // no local mutation
    return caught as ReceivingReversalEvidenceError;
  }

  test('non-object header rejects', async () => {
    expect((await expectHeaderRejectedNoFallback('corrupt')).code).toBe('header_not_object');
    expect((await expectHeaderRejectedNoFallback([])).code).toBe('header_not_object');
  });

  test('unsupported version rejects', async () => {
    const err = await expectHeaderRejectedNoFallback({ ...validHeaderEvidence(), version: 2 });
    expect(err.code).toBe('header_unsupported_version');
  });

  test('empty effects rejects', async () => {
    const err = await expectHeaderRejectedNoFallback({
      ...validHeaderEvidence(),
      itemCount: 0,
      totalQtyBase: 0,
      effects: [],
    });
    expect(err.code).toBe('header_empty_effects');
  });

  test('missing productId rejects', async () => {
    const err = await expectHeaderRejectedNoFallback({
      version: 1,
      source: 'receiving_completion',
      itemCount: 1,
      totalQtyBase: 5,
      effects: [{ lotId: 'lot-1', qtyBase: 5 }],
    });
    expect(err.code).toBe('header_missing_product_id');
  });

  test('missing lotId rejects', async () => {
    const err = await expectHeaderRejectedNoFallback({
      version: 1,
      source: 'receiving_completion',
      itemCount: 1,
      totalQtyBase: 5,
      effects: [{ productId: 'p1', qtyBase: 5 }],
    });
    expect(err.code).toBe('header_missing_lot_id');
  });

  test('non-finite qtyBase rejects', async () => {
    const err = await expectHeaderRejectedNoFallback({
      version: 1,
      source: 'receiving_completion',
      itemCount: 1,
      totalQtyBase: 5,
      effects: [{ productId: 'p1', lotId: 'lot-1', qtyBase: Number.NaN }],
    });
    expect(err.code).toBe('header_non_finite_qty');
  });

  test('non-positive qtyBase rejects', async () => {
    const err = await expectHeaderRejectedNoFallback({
      version: 1,
      source: 'receiving_completion',
      itemCount: 1,
      totalQtyBase: 0,
      effects: [{ productId: 'p1', lotId: 'lot-1', qtyBase: 0 }],
    });
    expect(err.code).toBe('header_non_positive_qty');
  });

  test('itemCount mismatch rejects', async () => {
    const err = await expectHeaderRejectedNoFallback({ ...validHeaderEvidence(), itemCount: 3 });
    expect(err.code).toBe('header_item_count_mismatch');
  });

  test('totalQtyBase mismatch rejects', async () => {
    const err = await expectHeaderRejectedNoFallback({ ...validHeaderEvidence(), totalQtyBase: 99 });
    expect(err.code).toBe('header_total_qty_mismatch');
  });
});

describe('executeReceivingReversal — header absent AND legacy invalid fails closed', () => {
  test('no header + empty items rejects before any write', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 });
    });
    const call = vi.fn<CallResolveReversal>();
    let caught: unknown;
    try {
      await executeReceivingReversal(makeDeps({ isOnline: () => true, call }), {
        ...baseInput,
        headerEvidence: null,
        items: [],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReceivingReversalEvidenceError);
    expect((caught as ReceivingReversalEvidenceError).code).toBe('empty_items');
    expect(call).not.toHaveBeenCalled();
    expect(await listQueue(store)).toHaveLength(0);
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(10);
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

// ─── Phase 7B-H5: client-observed timestamp capture + wiring ──────────────────

describe('toObservedDocumentUpdatedAtIso (defensive Timestamp→ISO)', () => {
  const ms = 1_700_000_000_000;
  const iso = new Date(ms).toISOString();

  test('converts a Firestore Timestamp (toDate) to ISO', () => {
    expect(toObservedDocumentUpdatedAtIso({ toDate: () => new Date(ms) })).toBe(iso);
  });
  test('converts a Timestamp exposing only toMillis to ISO', () => {
    expect(toObservedDocumentUpdatedAtIso({ toMillis: () => ms })).toBe(iso);
  });
  test('converts a plain { seconds, nanoseconds } shape to ISO', () => {
    expect(toObservedDocumentUpdatedAtIso({ seconds: ms / 1000, nanoseconds: 0 })).toBe(iso);
  });
  test('converts a Date, epoch millis, and ISO string', () => {
    expect(toObservedDocumentUpdatedAtIso(new Date(ms))).toBe(iso);
    expect(toObservedDocumentUpdatedAtIso(ms)).toBe(iso);
    expect(toObservedDocumentUpdatedAtIso(iso)).toBe(iso);
  });
  test('returns undefined (omit) for missing / malformed / unconvertible values', () => {
    expect(toObservedDocumentUpdatedAtIso(null)).toBeUndefined();
    expect(toObservedDocumentUpdatedAtIso(undefined)).toBeUndefined();
    expect(toObservedDocumentUpdatedAtIso('not-a-date')).toBeUndefined();
    expect(toObservedDocumentUpdatedAtIso(Number.NaN)).toBeUndefined();
    expect(toObservedDocumentUpdatedAtIso({ toDate: () => new Date(Number.NaN) })).toBeUndefined();
    expect(toObservedDocumentUpdatedAtIso({})).toBeUndefined();
  });
});

describe('executeReceivingReversal — H5 observed-timestamp wiring', () => {
  const observed = '2026-06-09T12:00:00.000Z';

  test('threads observed timestamp onto the intent and into the synced resolver request', async () => {
    const call = vi.fn<CallResolveReversal>().mockResolvedValue(okResponse);
    const out = await executeReceivingReversal(makeDeps({ isOnline: () => true, call }), {
      ...baseInput,
      observedDocumentUpdatedAt: observed,
    });
    expect(out.intent.observedDocumentUpdatedAt).toBe(observed); // durable on the intent
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toMatchObject({ clientObservedDocumentUpdatedAt: observed });
  });

  test('omits the field from the intent and request when not supplied (legacy/unconvertible)', async () => {
    const call = vi.fn<CallResolveReversal>().mockResolvedValue(okResponse);
    const out = await executeReceivingReversal(makeDeps({ isOnline: () => true, call }), baseInput);
    expect('observedDocumentUpdatedAt' in out.intent).toBe(false);
    expect('clientObservedDocumentUpdatedAt' in call.mock.calls[0][0]).toBe(false);
  });

  test('observed timestamp does not change the immediate local stock correction', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 });
      await txn.put('stock', 'p2::b1', { productId: 'p2', locationId: 'b1', quantity: 4 });
    });
    await executeReceivingReversal(makeDeps({ isOnline: () => false }), {
      ...baseInput,
      observedDocumentUpdatedAt: observed,
    });
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(5); // 10 - 5 (unchanged by H5)
    expect(await readLocalStock(store, 'p2', 'b1')).toBe(1); // 4 - 3
  });
});

// ─── Phase 7B-H6-D1: LATENT queue-first transfer reversal executor ────────────

const transferInput: TransferReversalInput = {
  transferId: 'T1',
  fromBranchId: 'b1', // source
  toBranchId: 'b2', // destination
  actorRole: 'manager',
  staffId: 'mgr-1',
  reason: 'wrong_entry',
  note: 'ทดสอบ',
  items: [
    { productId: 'p1', transferQty: 5, sourceLotDetails: [{ lotId: 'lot-1' }] },
    { productId: 'p2', transferQty: 3 },
  ],
};

describe('H6-D1: buildTransferReversalEffects (dual-branch original effects)', () => {
  test('destination original gain is +qty; source original loss is -qty', () => {
    expect(buildTransferReversalEffects(transferInput.items, 'b1', 'b2')).toEqual([
      { productId: 'p1', locationId: 'b2', lotId: null, quantity: 5 }, // dest gained +5
      { productId: 'p1', locationId: 'b1', lotId: 'lot-1', quantity: -5 }, // source lost -5
      { productId: 'p2', locationId: 'b2', lotId: null, quantity: 3 },
      { productId: 'p2', locationId: 'b1', lotId: null, quantity: -3 }, // no single lot → null
    ]);
  });
  test('drops zero-qty lines; source lotId null when not exactly one detail', () => {
    expect(
      buildTransferReversalEffects(
        [
          { productId: 'p1', transferQty: 0, sourceLotDetails: [{ lotId: 'lot-1' }] },
          { productId: 'p2', transferQty: 4, sourceLotDetails: [{ lotId: 'a' }, { lotId: 'b' }] },
        ],
        'b1',
        'b2',
      ),
    ).toEqual([
      { productId: 'p2', locationId: 'b2', lotId: null, quantity: 4 },
      { productId: 'p2', locationId: 'b1', lotId: null, quantity: -4 }, // two details → null
    ]);
  });
});

describe('H6-D1/D2: executeTransferReversal — queue-first transfer reversal', () => {
  test('decideReversalRoute routes transfer to the queue-first executor (H6-D2 flip)', () => {
    expect(decideReversalRoute('transfer')).toBe('transfer_queue_first');
  });

  test('creates a transfer intent: sourceType=transfer, branchId=fromBranchId, observed preserved', async () => {
    const observed = '2026-06-09T12:00:00.000Z';
    const out = await executeTransferReversal(makeDeps({ isOnline: () => false }), {
      ...transferInput,
      observedDocumentUpdatedAt: observed,
    });
    expect(out.status).toBe('queued');
    expect(out.intent.sourceType).toBe('transfer');
    expect(out.intent.sourceId).toBe('T1');
    expect(out.intent.branchId).toBe('b1'); // fromBranchId (origin) — matches server authority
    expect(out.intent.observedDocumentUpdatedAt).toBe(observed);
    expect(out.intent.idempotencyKey).toBe('rev:b1:transfer:T1:reverse');
    expect(await listQueue(store)).toHaveLength(1);
  });

  test('local correction: destination -qty, source +qty (dual-branch), aggregated by product×branch', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 }); // source
      await txn.put('stock', 'p1::b2', { productId: 'p1', locationId: 'b2', quantity: 10 }); // dest
      await txn.put('stock', 'p2::b1', { productId: 'p2', locationId: 'b1', quantity: 4 });
      await txn.put('stock', 'p2::b2', { productId: 'p2', locationId: 'b2', quantity: 4 });
    });
    await executeTransferReversal(makeDeps({ isOnline: () => false }), transferInput);
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(15); // source restored +5
    expect(await readLocalStock(store, 'p1', 'b2')).toBe(5); // dest removed -5
    expect(await readLocalStock(store, 'p2', 'b1')).toBe(7); // source restored +3
    expect(await readLocalStock(store, 'p2', 'b2')).toBe(1); // dest removed -3
  });

  test('multiple lines of the SAME product aggregate onto the right branch counters', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 0 });
      await txn.put('stock', 'p1::b2', { productId: 'p1', locationId: 'b2', quantity: 10 });
    });
    await executeTransferReversal(makeDeps({ isOnline: () => false }), {
      ...transferInput,
      items: [
        { productId: 'p1', transferQty: 2 },
        { productId: 'p1', transferQty: 3 },
      ],
    });
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(5); // source +2+3
    expect(await readLocalStock(store, 'p1', 'b2')).toBe(5); // dest -(2+3)
  });

  test('online: syncs to resolver and confirms (server_accepted)', async () => {
    const call = vi.fn<CallResolveReversal>().mockResolvedValue({
      ok: true,
      idempotencyKey: 'rev:b1:transfer:T1:reverse',
      status: 'confirmed',
      serverReversalId: 'REV-T1',
    });
    const out = await executeTransferReversal(makeDeps({ isOnline: () => true, call }), transferInput);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toMatchObject({
      actionType: 'transfer_reversal',
      sourceDocumentType: 'transfer',
      sourceDocumentId: 'T1',
      branchId: 'b1',
    });
    expect(out.synced).toBe(true);
    expect(out.status).toBe('server_accepted');
  });

  test('idempotency identity is stable for the same transfer/action', async () => {
    const a = createInMemoryReversalStore();
    const b = createInMemoryReversalStore();
    const r1 = await executeTransferReversal(makeDeps({ store: a, isOnline: () => false }), transferInput);
    const r2 = await executeTransferReversal(makeDeps({ store: b, isOnline: () => false }), transferInput);
    expect(r1.intent.idempotencyKey).toBe(r2.intent.idempotencyKey);
    expect(r1.intent.id).toBe(r2.intent.id);
  });
});

describe('H6-D1: executeTransferReversal — fail-closed before any write', () => {
  async function expectRejectedBeforeAnyWrite(
    over: Partial<TransferReversalInput>,
  ): Promise<TransferReversalEvidenceError> {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 });
      await txn.put('stock', 'p1::b2', { productId: 'p1', locationId: 'b2', quantity: 10 });
    });
    const call = vi.fn<CallResolveReversal>();
    let caught: unknown;
    try {
      await executeTransferReversal(makeDeps({ isOnline: () => true, call }), { ...transferInput, ...over });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TransferReversalEvidenceError);
    expect(call).not.toHaveBeenCalled(); // resolver never reached
    expect(await listQueue(store)).toHaveLength(0); // no durable queue item
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(10); // source untouched
    expect(await readLocalStock(store, 'p1', 'b2')).toBe(10); // dest untouched
    return caught as TransferReversalEvidenceError;
  }

  test('empty items → empty_items', async () => {
    expect((await expectRejectedBeforeAnyWrite({ items: [] })).code).toBe('empty_items');
  });
  test('missing productId → missing_product_id', async () => {
    expect((await expectRejectedBeforeAnyWrite({ items: [{ productId: '', transferQty: 5 }] })).code).toBe('missing_product_id');
  });
  test('whitespace-only productId → missing_product_id (D2-α tightening)', async () => {
    expect((await expectRejectedBeforeAnyWrite({ items: [{ productId: '   ', transferQty: 5 }] })).code).toBe('missing_product_id');
  });
  test('non-positive qty → non_positive_qty', async () => {
    expect((await expectRejectedBeforeAnyWrite({ items: [{ productId: 'p1', transferQty: 0 }] })).code).toBe('non_positive_qty');
  });
  test('non-finite qty → non_finite_qty', async () => {
    expect((await expectRejectedBeforeAnyWrite({ items: [{ productId: 'p1', transferQty: Number.NaN }] })).code).toBe('non_finite_qty');
  });
  test('same source/dest branch → same_branch', async () => {
    expect((await expectRejectedBeforeAnyWrite({ toBranchId: 'b1' })).code).toBe('same_branch');
  });
  test('trim-equal source/dest branch ids → same_branch (D2-α tightening)', async () => {
    expect((await expectRejectedBeforeAnyWrite({ fromBranchId: 'b1 ', toBranchId: ' b1' })).code).toBe('same_branch');
  });
  test('missing reason → missing_reason', async () => {
    expect((await expectRejectedBeforeAnyWrite({ reason: '   ' })).code).toBe('missing_reason');
  });
  test('missing transferId → missing_transfer_id', async () => {
    expect((await expectRejectedBeforeAnyWrite({ transferId: '' })).code).toBe('missing_transfer_id');
  });
});

describe('H6-D1: executeTransferReversal — Staff authority (Blocker 2 mirror)', () => {
  test('Staff is rejected BEFORE any queue write or local stock mutation', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 });
      await txn.put('stock', 'p1::b2', { productId: 'p1', locationId: 'b2', quantity: 10 });
    });
    const call = vi.fn<CallResolveReversal>();
    await expect(
      executeTransferReversal(makeDeps({ isOnline: () => true, call }), { ...transferInput, actorRole: 'staff' }),
    ).rejects.toBeInstanceOf(OfflineReversalRejectedError);
    expect(call).not.toHaveBeenCalled();
    expect(await listQueue(store)).toHaveLength(0);
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(10);
    expect(await readLocalStock(store, 'p1', 'b2')).toBe(10);
  });
});

describe('H6-D1: assertTransferReversalInput is pure (throws, no side effects)', () => {
  test('valid input passes; invalid throws TransferReversalEvidenceError', () => {
    expect(() => assertTransferReversalInput(transferInput)).not.toThrow();
    expect(() => assertTransferReversalInput({ ...transferInput, fromBranchId: '' })).toThrow(TransferReversalEvidenceError);
  });
});

// ─── Phase 7B-H6-E2-C: transfer header evidence coordinator validation ─────────
// The coordinator now PREFERS a present transfer header `reversalEvidence` snapshot over
// the (possibly partial) fetched item subcollection, validating it fail-closed, and only
// falls back to items when no header is present. `header_snapshot` vs `legacy_subcollection`
// is tagged on the outcome. Server authority is unchanged (it re-reads items, ignores this).
describe('H6-E2-C: transfer header evidence is preferred + validated', () => {
  /** A real E2-B-shaped snapshot built by the SAME builder the write path uses (round-trip). */
  function validHeaderEvidence(
    over: Partial<Parameters<typeof buildTransferReversalEvidence>[0]> = {},
  ) {
    return buildTransferReversalEvidence({
      fromBranchId: 'b1',
      toBranchId: 'b2',
      items: [
        { productId: 'p1', transferQty: 5, sourceLotDetails: [{ lotId: 'lot-1' }] },
        { productId: 'p2', transferQty: 3 },
      ],
      createdAt: '2026-06-11T00:00:00.000Z',
      createdBy: 'mgr-1',
      ...over,
    });
  }

  async function seedDualBranch() {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 }); // source
      await txn.put('stock', 'p1::b2', { productId: 'p1', locationId: 'b2', quantity: 10 }); // dest
      await txn.put('stock', 'p2::b1', { productId: 'p2', locationId: 'b1', quantity: 4 });
      await txn.put('stock', 'p2::b2', { productId: 'p2', locationId: 'b2', quantity: 4 });
    });
  }

  test('valid header evidence is PREFERRED and applied even when items is empty/partial', async () => {
    await seedDualBranch();
    const out = await executeTransferReversal(makeDeps({ isOnline: () => false }), {
      ...transferInput,
      items: [], // simulate a partial/empty subcollection fetch — must NOT matter on header path
      transferHeaderEvidence: validHeaderEvidence(),
    });
    expect(out.evidenceSource).toBe('header_snapshot');
    expect(out.status).toBe('queued');
    // Dual-branch local correction proven from the header, not the (empty) items:
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(15); // source restored +5
    expect(await readLocalStock(store, 'p1', 'b2')).toBe(5); // dest removed -5
    expect(await readLocalStock(store, 'p2', 'b1')).toBe(7); // source restored +3
    expect(await readLocalStock(store, 'p2', 'b2')).toBe(1); // dest removed -3
    expect(await listQueue(store)).toHaveLength(1);
  });

  test('absent header evidence FALLS BACK to the legacy item-subcollection path', async () => {
    await seedDualBranch();
    const out = await executeTransferReversal(makeDeps({ isOnline: () => false }), transferInput);
    expect(out.evidenceSource).toBe('legacy_subcollection');
    expect(out.status).toBe('queued');
    // Legacy item-derived correction still applies the same dual-branch math.
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(15);
    expect(await readLocalStock(store, 'p1', 'b2')).toBe(5);
    expect(await readLocalStock(store, 'p2', 'b1')).toBe(7);
    expect(await readLocalStock(store, 'p2', 'b2')).toBe(1);
    expect(await listQueue(store)).toHaveLength(1);
  });

  test('legacy no-evidence transfer remains reversible (explicit, single product)', async () => {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 0 });
      await txn.put('stock', 'p1::b2', { productId: 'p1', locationId: 'b2', quantity: 10 });
    });
    const out = await executeTransferReversal(makeDeps({ isOnline: () => false }), {
      ...transferInput,
      items: [{ productId: 'p1', transferQty: 5, sourceLotDetails: [{ lotId: 'lot-1' }] }],
      // no transferHeaderEvidence → legacy
    });
    expect(out.evidenceSource).toBe('legacy_subcollection');
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(5); // +5 source
    expect(await readLocalStock(store, 'p1', 'b2')).toBe(5); // -5 dest
  });

  // ── Present-but-invalid header rejects, NO fallback, NO write ──────────────────
  async function expectHeaderRejectedNoFallback(
    headerEvidence: unknown,
  ): Promise<TransferReversalEvidenceError> {
    await store.transact(['stock'], 'readwrite', async (txn) => {
      await txn.put('stock', 'p1::b1', { productId: 'p1', locationId: 'b1', quantity: 10 });
      await txn.put('stock', 'p1::b2', { productId: 'p1', locationId: 'b2', quantity: 10 });
    });
    const call = vi.fn<CallResolveReversal>();
    let caught: unknown;
    try {
      await executeTransferReversal(makeDeps({ isOnline: () => true, call }), {
        ...transferInput,
        items: transferInput.items, // VALID items present — must STILL not be consulted (no fallback)
        transferHeaderEvidence: headerEvidence,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TransferReversalEvidenceError);
    expect(call).not.toHaveBeenCalled(); // resolver never reached
    expect(await listQueue(store)).toHaveLength(0); // no durable queue item
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(10); // source untouched
    expect(await readLocalStock(store, 'p1', 'b2')).toBe(10); // dest untouched
    return caught as TransferReversalEvidenceError;
  }

  test('not an object → header_not_object', async () => {
    expect((await expectHeaderRejectedNoFallback('nope')).code).toBe('header_not_object');
    expect((await expectHeaderRejectedNoFallback([])).code).toBe('header_not_object');
  });
  test('bad version → header_unsupported_version', async () => {
    expect((await expectHeaderRejectedNoFallback({ ...validHeaderEvidence(), version: 2 })).code).toBe(
      'header_unsupported_version',
    );
  });
  test('wrong source → header_wrong_source', async () => {
    expect(
      (await expectHeaderRejectedNoFallback({ ...validHeaderEvidence(), source: 'receiving_completion' })).code,
    ).toBe('header_wrong_source');
  });
  test('branch mismatch → header_branch_mismatch', async () => {
    expect((await expectHeaderRejectedNoFallback({ ...validHeaderEvidence(), fromBranchId: 'bX' })).code).toBe(
      'header_branch_mismatch',
    );
  });
  test('swapped branch direction (dest_gain pointed at source branch) → header_invalid_branch', async () => {
    const ev = validHeaderEvidence();
    const tampered = {
      ...ev,
      effects: ev.effects.map((e) => (e.direction === 'dest_gain' ? { ...e, branchId: 'b1' } : e)),
    };
    expect((await expectHeaderRejectedNoFallback(tampered)).code).toBe('header_invalid_branch');
  });
  test('itemCount checksum mismatch → header_item_count_mismatch', async () => {
    expect((await expectHeaderRejectedNoFallback({ ...validHeaderEvidence(), itemCount: 99 })).code).toBe(
      'header_item_count_mismatch',
    );
  });
  test('totalQtyBase checksum mismatch → header_total_qty_mismatch', async () => {
    const ev = validHeaderEvidence();
    expect((await expectHeaderRejectedNoFallback({ ...ev, totalQtyBase: ev.totalQtyBase + 1 })).code).toBe(
      'header_total_qty_mismatch',
    );
  });
  // Codex blocker: `typeof NaN === 'number'` + `Math.abs(NaN) > EPSILON === false` must NOT slip
  // a non-finite checksum through. Every non-finite `totalQtyBase` must fail closed.
  test('NaN totalQtyBase → header_total_qty_mismatch (non-finite guard)', async () => {
    expect((await expectHeaderRejectedNoFallback({ ...validHeaderEvidence(), totalQtyBase: Number.NaN })).code).toBe(
      'header_total_qty_mismatch',
    );
  });
  test('Infinity totalQtyBase → header_total_qty_mismatch (non-finite guard)', async () => {
    expect(
      (await expectHeaderRejectedNoFallback({ ...validHeaderEvidence(), totalQtyBase: Number.POSITIVE_INFINITY })).code,
    ).toBe('header_total_qty_mismatch');
  });
  test('-Infinity totalQtyBase → header_total_qty_mismatch (non-finite guard)', async () => {
    expect(
      (await expectHeaderRejectedNoFallback({ ...validHeaderEvidence(), totalQtyBase: Number.NEGATIVE_INFINITY })).code,
    ).toBe('header_total_qty_mismatch');
  });
  test('dual-branch imbalance (dest qty ≠ source qty for a product) → header_balance_mismatch', async () => {
    const ev = validHeaderEvidence();
    const tampered = {
      ...ev,
      effects: ev.effects.map((e) =>
        e.direction === 'dest_gain' && e.productId === 'p1' ? { ...e, qtyBase: 6 } : e,
      ),
    };
    expect((await expectHeaderRejectedNoFallback(tampered)).code).toBe('header_balance_mismatch');
  });
  test('non-positive effect qty → header_non_positive_qty', async () => {
    const ev = validHeaderEvidence();
    const tampered = { ...ev, effects: ev.effects.map((e) => ({ ...e, qtyBase: 0 })) };
    expect((await expectHeaderRejectedNoFallback(tampered)).code).toBe('header_non_positive_qty');
  });
  test('non-finite effect qty → header_non_finite_qty', async () => {
    const ev = validHeaderEvidence();
    const tampered = { ...ev, effects: ev.effects.map((e) => ({ ...e, qtyBase: Number.NaN })) };
    expect((await expectHeaderRejectedNoFallback(tampered)).code).toBe('header_non_finite_qty');
  });
  test('malformed (null) effect entry → header_malformed_effect', async () => {
    const ev = validHeaderEvidence();
    expect((await expectHeaderRejectedNoFallback({ ...ev, effects: [...ev.effects, null] })).code).toBe(
      'header_malformed_effect',
    );
  });
  test('empty effects → header_empty_effects', async () => {
    expect((await expectHeaderRejectedNoFallback({ ...validHeaderEvidence(), effects: [] })).code).toBe(
      'header_empty_effects',
    );
  });
  test('effect missing productId → header_missing_product_id', async () => {
    const ev = validHeaderEvidence();
    const tampered = { ...ev, effects: ev.effects.map((e) => ({ ...e, productId: '' })) };
    expect((await expectHeaderRejectedNoFallback(tampered)).code).toBe('header_missing_product_id');
  });
  test('effect invalid direction → header_invalid_direction', async () => {
    const ev = validHeaderEvidence();
    const tampered = { ...ev, effects: ev.effects.map((e) => ({ ...e, direction: 'sideways' })) };
    expect((await expectHeaderRejectedNoFallback(tampered)).code).toBe('header_invalid_direction');
  });
  test('effect non-string lotId → header_invalid_lot_id', async () => {
    const ev = validHeaderEvidence();
    const tampered = {
      ...ev,
      effects: ev.effects.map((e) => (e.direction === 'source_loss' ? { ...e, lotId: 123 } : e)),
    };
    expect((await expectHeaderRejectedNoFallback(tampered)).code).toBe('header_invalid_lot_id');
  });

  // ── Mapping fidelity ──────────────────────────────────────────────────────────
  function sortEffects<T extends { productId: string; locationId: string; quantity: number }>(rows: readonly T[]): T[] {
    return [...rows].sort((a, b) => {
      const ka = `${a.productId}|${a.locationId}|${a.quantity}`;
      const kb = `${b.productId}|${b.locationId}|${b.quantity}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  test('header path and legacy path produce EQUIVALENT OriginalStockEffect[] for the same transfer', () => {
    const fromHeader = validateTransferHeaderEvidence(validHeaderEvidence(), 'b1', 'b2');
    const fromItems = buildTransferReversalEffects(transferInput.items, 'b1', 'b2');
    expect(sortEffects(fromHeader)).toEqual(sortEffects(fromItems));
  });

  test('single-lot source carries lotId on source_loss; multi-lot/no-lot → null', () => {
    const effects = validateTransferHeaderEvidence(
      validHeaderEvidence({
        items: [
          { productId: 'p1', transferQty: 5, sourceLotDetails: [{ lotId: 'lot-1' }] }, // single lot
          { productId: 'p2', transferQty: 4, sourceLotDetails: [{ lotId: 'a' }, { lotId: 'b' }] }, // multi → null
          { productId: 'p3', transferQty: 2 }, // no details → null
        ],
      }),
      'b1',
      'b2',
    );
    const sourceOf = (pid: string) =>
      effects.find((e) => e.productId === pid && e.locationId === 'b1' && e.quantity < 0);
    expect(sourceOf('p1')?.lotId).toBe('lot-1');
    expect(sourceOf('p2')?.lotId).toBeNull();
    expect(sourceOf('p3')?.lotId).toBeNull();
  });

  test('E2-B-shaped header (real builder output) validates cleanly through the consume path', () => {
    const effects = validateTransferHeaderEvidence(validHeaderEvidence(), 'b1', 'b2');
    expect(effects).toHaveLength(4); // 2 items × (dest + source)
  });

  test('resolveTransferReversalEffects tags header_snapshot vs legacy_subcollection', () => {
    expect(
      resolveTransferReversalEffects({ ...transferInput, transferHeaderEvidence: validHeaderEvidence() })
        .evidenceSource,
    ).toBe('header_snapshot');
    expect(resolveTransferReversalEffects(transferInput).evidenceSource).toBe('legacy_subcollection');
  });

  // ── Authority + header-field validation still enforced on the header path ──────
  test('Staff actor is rejected BEFORE any write even on the header-evidence path', async () => {
    await seedDualBranch();
    const call = vi.fn<CallResolveReversal>();
    await expect(
      executeTransferReversal(makeDeps({ isOnline: () => true, call }), {
        ...transferInput,
        items: [],
        transferHeaderEvidence: validHeaderEvidence(),
        actorRole: 'staff',
      }),
    ).rejects.toBeInstanceOf(OfflineReversalRejectedError);
    expect(call).not.toHaveBeenCalled();
    expect(await listQueue(store)).toHaveLength(0);
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(10);
    expect(await readLocalStock(store, 'p1', 'b2')).toBe(10);
  });

  test('header-field validation still runs on the header path (missing reason rejects)', async () => {
    let caught: unknown;
    try {
      await executeTransferReversal(makeDeps({ isOnline: () => false }), {
        ...transferInput,
        reason: '   ',
        items: [],
        transferHeaderEvidence: validHeaderEvidence(),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TransferReversalEvidenceError);
    expect((caught as TransferReversalEvidenceError).code).toBe('missing_reason');
  });
});

// ─── Phase 7B-H6-D2: UI route wiring & legacy-path retirement (source-level) ───
// The two transfer cancellation PAGES carry a heavy runtime harness (Firebase,
// react-router, AuthProvider, modal stack), so the legacy-path-retirement and
// queue-first-wiring guarantees are proven by inspecting the page SOURCE for
// import/call shape rather than mounting the components. This is the deliberately
// targeted approach noted in the H6-D2 self-review (page-harness limitation).
describe('H6-D2: legacy cancelBranchTransfer retired from the two cancel UI surfaces', () => {
  const transferHistory = transferHistorySrc;
  const adminTransfer = adminTransferSrc;
  const transferCrud = transferCrudSrc;

  // A named-import binding of cancelBranchTransfer, e.g. `import { cancelBranchTransfer } from ...`.
  const importsCancel = /import\s+\{[^}]*\bcancelBranchTransfer\b[^}]*\}/;
  // A call of cancelBranchTransfer(...) — distinct from a prose mention in a comment.
  const callsCancel = /\bcancelBranchTransfer\s*\(/;

  test('TransferHistoryPage neither imports nor calls cancelBranchTransfer', () => {
    expect(transferHistory).not.toMatch(importsCancel);
    expect(transferHistory).not.toMatch(callsCancel);
    // It no longer pulls anything from transferCrud at all.
    expect(transferHistory).not.toMatch(/from\s+['"][^'"]*\/transferCrud['"]/);
  });

  test('AdminTransferPage neither imports nor calls cancelBranchTransfer (but keeps editBranchTransfer)', () => {
    expect(adminTransfer).not.toMatch(importsCancel);
    expect(adminTransfer).not.toMatch(callsCancel);
    expect(adminTransfer).toMatch(/import\s+\{\s*editBranchTransfer\s*\}\s+from\s+['"][^'"]*\/transferCrud['"]/);
    expect(adminTransfer).toMatch(/\beditBranchTransfer\s*\(/); // edit flow still calls it
  });

  test('both pages route the confirmed cancel through the queue-first executeTransferReversal', () => {
    expect(transferHistory).toMatch(/executeTransferReversal\(/);
    expect(adminTransfer).toMatch(/executeTransferReversal\(/);
  });

  test('both pages build the executor payload with the required transfer fields', () => {
    for (const src of [transferHistory, adminTransfer]) {
      expect(src).toMatch(/transferId:\s*cancelTarget\.id/);
      expect(src).toMatch(/fromBranchId:\s*cancelTarget\.fromBranchId/);
      expect(src).toMatch(/toBranchId:\s*cancelTarget\.toBranchId/);
      expect(src).toMatch(/sourceLotDetails:\s*it\.sourceLotDetails/);
      expect(src).toMatch(/transferQty:\s*it\.transferQty/);
      // observedDocumentUpdatedAt captured (when available) via the defensive converter.
      expect(src).toMatch(/observedDocumentUpdatedAt:\s*toObservedDocumentUpdatedAtIso\(cancelTarget\.updatedAt\)/);
    }
    // TransferHistory threads the note; Admin's dialog supplies reason only.
    expect(transferHistory).toMatch(/\breason,/);
    expect(transferHistory).toMatch(/\bnote,/);
    expect(adminTransfer).toMatch(/\breason,/);
  });

  test('editBranchTransfer in transferCrud still preserves its internal cancelBranchTransfer step', () => {
    expect(transferCrud).toMatch(/export async function editBranchTransfer/);
    // The cancel-then-recreate edit path must keep awaiting cancelBranchTransfer internally.
    const editBody = transferCrud.slice(transferCrud.indexOf('export async function editBranchTransfer'));
    expect(editBody).toMatch(/await cancelBranchTransfer\(/);
  });
});

// ─── Phase 7B-H6-D2 (Codex blocker fix): origin-branch preflight gate ──────────

describe('canBranchReverseTransfer (origin-branch preflight, pure + fail-closed)', () => {
  test('true only when the active branch trim-equals the transfer origin (fromBranchId)', () => {
    expect(canBranchReverseTransfer('b1', 'b1')).toBe(true);
    expect(canBranchReverseTransfer(' b1 ', 'b1')).toBe(true); // trim-tolerant
  });
  test('false for a destination-only branch (current is toBranchId, not fromBranchId)', () => {
    // The transfer feed lists incoming transfers too; a dest-branch user must be blocked.
    expect(canBranchReverseTransfer('b2', 'b1')).toBe(false);
  });
  test('fail-closed for any missing / empty / whitespace branch id', () => {
    expect(canBranchReverseTransfer(null, 'b1')).toBe(false);
    expect(canBranchReverseTransfer(undefined, 'b1')).toBe(false);
    expect(canBranchReverseTransfer('', 'b1')).toBe(false);
    expect(canBranchReverseTransfer('   ', 'b1')).toBe(false);
    expect(canBranchReverseTransfer('b1', null)).toBe(false);
    expect(canBranchReverseTransfer('b1', '')).toBe(false);
    expect(canBranchReverseTransfer('b1', '   ')).toBe(false);
  });
});

describe('H6-D2 blocker fix: TransferHistoryPage gates the reversal on origin-branch authority', () => {
  test('TransferHistoryPage imports and uses canBranchReverseTransfer', () => {
    expect(transferHistorySrc).toMatch(/canBranchReverseTransfer/);
  });

  test('the modal cancel entry point is gated by canBranchReverseTransfer(branchId, …fromBranchId)', () => {
    // onCancelTransfer is only wired when the active branch is the transfer origin, so a
    // destination-branch user viewing an incoming transfer never gets a reversal entry point.
    expect(transferHistorySrc).toMatch(
      /onCancelTransfer=\{[\s\S]*canBranchReverseTransfer\(branchId,\s*detail\.fromBranchId\)[\s\S]*setCancelTarget\(detail\)/,
    );
  });

  test('handleCancel hard-guards on origin branch BEFORE reaching executeTransferReversal', () => {
    const handlerStart = transferHistorySrc.indexOf('const handleCancel');
    const executorCall = transferHistorySrc.indexOf('executeTransferReversal(', handlerStart);
    const guard = transferHistorySrc.indexOf('canBranchReverseTransfer(branchId, cancelTarget.fromBranchId)', handlerStart);
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(executorCall).toBeGreaterThanOrEqual(0);
    // The fail-closed guard must appear BEFORE the executor call in the handler body.
    expect(guard).toBeLessThan(executorCall);
    // And the guard early-returns (no local correction / queue write on the dest path).
    const guardBlock = transferHistorySrc.slice(guard, executorCall);
    expect(guardBlock).toMatch(/return;/);
  });

  test('AdminTransferPage is a global-admin surface and does NOT add the branch-origin gate', () => {
    // Admin tokens have cross-branch authority server-side (hasBranchAccess → true), so the
    // HQ surface must remain able to reverse any branch transfer.
    expect(adminTransferSrc).not.toMatch(/canBranchReverseTransfer/);
    expect(adminTransferSrc).toMatch(/executeTransferReversal\(/);
  });
});
