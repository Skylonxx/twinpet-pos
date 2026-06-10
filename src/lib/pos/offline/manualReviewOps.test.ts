import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildManualReviewResolvePayload,
  canViewManualReviewOps,
} from './manualReviewOps';
import {
  createOfflineReversal,
  listQueue,
  readLocalStock,
  resolveManualReview,
} from './offlineReversalQueue';
import { ManualReviewResolveError } from './offlineReversalLogic';
import { createInMemoryReversalStore } from './reversalLocalStore';
import type { CreateReversalInput, OfflineReversalIntent } from './offlineReversalTypes';

// ─── Authority gate ──────────────────────────────────────────────────────────

describe('canViewManualReviewOps', () => {
  test('Manager and Admin may view/execute', () => {
    expect(canViewManualReviewOps('manager')).toBe(true);
    expect(canViewManualReviewOps('admin')).toBe(true);
  });

  test('standard Staff cannot — and neither can unknown/absent roles', () => {
    expect(canViewManualReviewOps('staff')).toBe(false);
    expect(canViewManualReviewOps(null)).toBe(false);
    expect(canViewManualReviewOps(undefined)).toBe(false);
    expect(canViewManualReviewOps('cashier')).toBe(false);
  });
});

// ─── Payload mapping ─────────────────────────────────────────────────────────

describe('buildManualReviewResolvePayload', () => {
  test('Manager/Admin maps actor + form to the exact resolve payload (with note)', () => {
    const res = buildManualReviewResolvePayload(
      { id: 'mgr-1', role: 'manager' },
      { reasonCode: 'reconciled_in_firestore', note: 'นับแล้ว' },
    );
    expect(res).toEqual({
      ok: true,
      input: {
        resolvedByStaffId: 'mgr-1',
        resolvedByRole: 'manager',
        reasonCode: 'reconciled_in_firestore',
        note: 'นับแล้ว',
      },
    });
  });

  test('omits note when blank/whitespace and trims reasonCode', () => {
    const res = buildManualReviewResolvePayload(
      { id: 'admin-1', role: 'admin' },
      { reasonCode: '  fixed  ', note: '   ' },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.input.reasonCode).toBe('fixed');
      expect('note' in res.input).toBe(false);
    }
  });

  test('missing reasonCode blocks submission', () => {
    const res = buildManualReviewResolvePayload(
      { id: 'mgr-1', role: 'manager' },
      { reasonCode: '   ' },
    );
    expect(res).toEqual({ ok: false, error: 'missing_reason' });
  });

  test('Staff (or missing actor id) is unauthorized — cannot build a payload', () => {
    expect(
      buildManualReviewResolvePayload({ id: 'stf-1', role: 'staff' }, { reasonCode: 'x' }),
    ).toEqual({ ok: false, error: 'unauthorized' });
    expect(
      buildManualReviewResolvePayload({ id: null, role: 'manager' }, { reasonCode: 'x' }),
    ).toEqual({ ok: false, error: 'unauthorized' });
  });
});

// ─── Integration with the real H2 helper (device-local store, no Firestore) ──

const createInput: CreateReversalInput = {
  businessId: 'b1',
  sourceType: 'receiving',
  sourceId: 'GRN-001',
  action: 'void',
  createdByStaffId: 'mgr-1',
  actorRole: 'manager',
  branchId: 'b1',
  reasonCode: 'mis-entry',
  originalEffects: [{ productId: 'p1', locationId: 'b1', lotId: 'lot-1', quantity: 5 }],
};

let store: ReturnType<typeof createInMemoryReversalStore>;
beforeEach(() => {
  store = createInMemoryReversalStore();
});

async function seedManualReviewIntent(): Promise<OfflineReversalIntent> {
  const intent = await createOfflineReversal(store, createInput, { now: () => '2026-06-10T00:00:00.000Z' });
  return store.transact(['intents'], 'readwrite', async (txn) => {
    const manual: OfflineReversalIntent = { ...intent, status: 'manual_review_required' };
    await txn.put('intents', intent.id, manual);
    return manual;
  });
}

describe('Manual Review Ops — built payload drives resolveManualReview (local only)', () => {
  test('a Manager/Admin payload resolves the local intent and drops it from the queue', async () => {
    const seeded = await seedManualReviewIntent();
    const counterBefore = await readLocalStock(store, 'p1', 'b1'); // -5 applied at create

    const payload = buildManualReviewResolvePayload(
      { id: 'mgr-9', role: 'manager' },
      { reasonCode: 'reconciled_in_firestore', note: 'ok' },
    );
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;

    const result = await resolveManualReview(store, seeded.id, payload.input);
    expect(result.outcome).toBe('resolved');
    expect(result.intent!.status).toBe('manual_review_resolved');

    // No more manual_review_required rows for the page to show.
    expect(await listQueue(store, ['manual_review_required'])).toHaveLength(0);
    // No stock mutation by the resolve path — internal counter unchanged.
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(counterBefore);
  });

  test('a Staff attempt is blocked at the payload boundary (no resolve call possible)', async () => {
    const seeded = await seedManualReviewIntent();
    const payload = buildManualReviewResolvePayload({ id: 'stf-1', role: 'staff' }, { reasonCode: 'x' });
    expect(payload.ok).toBe(false);

    // Even if a caller bypassed the gate and forced the H2 helper with a staff role,
    // the helper itself throws — proving defense-in-depth.
    await expect(
      resolveManualReview(store, seeded.id, {
        resolvedByStaffId: 'stf-1',
        resolvedByRole: 'staff',
        reasonCode: 'x',
      }),
    ).rejects.toBeInstanceOf(ManualReviewResolveError);
    // Intent untouched.
    expect((await listQueue(store, ['manual_review_required']))[0].id).toBe(seeded.id);
  });

  test('the page data source lists ONLY manual_review_required (device-local queue)', async () => {
    await seedManualReviewIntent();
    // A second, still-queued intent must NOT appear in the manual-review view.
    await createOfflineReversal(
      store,
      { ...createInput, sourceId: 'GRN-002' },
      { now: () => '2026-06-10T00:00:01.000Z' },
    );
    const rows = await listQueue(store, ['manual_review_required']);
    expect(rows.map((r) => r.sourceId)).toEqual(['GRN-001']);
  });

  test('does not call any network/Firestore path (only the local queue helper)', async () => {
    // Guard: make any network call blow up; the local resolve must never reach one.
    const original = globalThis.fetch;
    const fetchSpy = vi.fn(() => {
      throw new Error('network not allowed in manual-review resolve');
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const seeded = await seedManualReviewIntent();
      const payload = buildManualReviewResolvePayload({ id: 'mgr-9', role: 'manager' }, { reasonCode: 'r' });
      if (!payload.ok) throw new Error('payload should be ok');
      const result = await resolveManualReview(store, seeded.id, payload.input);
      expect(result.outcome).toBe('resolved');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});
