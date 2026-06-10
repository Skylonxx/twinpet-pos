import { beforeEach, describe, expect, test } from 'vitest';
import {
  createOfflineReversal,
  listClaimable,
  listQueue,
  readLocalStock,
  resolveManualReview,
} from './offlineReversalQueue';
import {
  ManualReviewResolveError,
  isManualReviewResolvable,
  type ManualReviewResolveInput,
} from './offlineReversalLogic';
import { createInMemoryReversalStore } from './reversalLocalStore';
import { buildReversalOverlay } from './reversalStockOverlay';
import type {
  CreateReversalInput,
  OfflineReversalIntent,
  OfflineReversalStatus,
} from './offlineReversalTypes';

function fixedClock(start = 1_700_000_000_000) {
  let t = start;
  return () => new Date((t += 1000)).toISOString();
}

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

const resolveInput: ManualReviewResolveInput = {
  resolvedByStaffId: 'mgr-9',
  resolvedByRole: 'manager',
  reasonCode: 'reconciled_in_firestore',
  note: 'นับสต็อกแล้ว',
};

let store: ReturnType<typeof createInMemoryReversalStore>;
beforeEach(() => {
  store = createInMemoryReversalStore();
});

/** Create an intent and force it into `manual_review_required` (correction still applied). */
async function seedManualReviewIntent(): Promise<OfflineReversalIntent> {
  const intent = await createOfflineReversal(store, createInput, { now: fixedClock() });
  return store.transact(['intents'], 'readwrite', async (txn) => {
    const manual: OfflineReversalIntent = { ...intent, status: 'manual_review_required' };
    await txn.put('intents', intent.id, manual);
    return manual;
  });
}

// ─── Pure eligibility predicate ──────────────────────────────────────────────

function fakeIntent(
  status: OfflineReversalStatus,
  correction: { applied?: boolean; reversed?: boolean } = {},
): Pick<OfflineReversalIntent, 'status' | 'localCorrection'> {
  return {
    status,
    localCorrection: {
      applied: correction.applied ?? true,
      reversed: correction.reversed ?? false,
      stockDelta: [],
    },
  };
}

describe('isManualReviewResolvable', () => {
  test('only manual_review_required with applied && !reversed is resolvable', () => {
    expect(isManualReviewResolvable(fakeIntent('manual_review_required'))).toBe(true);
  });

  test('every other status is not resolvable', () => {
    for (const s of [
      'queued',
      'syncing',
      'retryable_error',
      'server_accepted',
      'server_rejected',
      'manual_review_resolved',
    ] as const) {
      expect(isManualReviewResolvable(fakeIntent(s))).toBe(false);
    }
  });

  test('unapplied or already-reversed correction is not resolvable even if status matches', () => {
    expect(isManualReviewResolvable(fakeIntent('manual_review_required', { applied: false }))).toBe(false);
    expect(isManualReviewResolvable(fakeIntent('manual_review_required', { reversed: true }))).toBe(false);
  });
});

// ─── resolveManualReview — happy path + overlay drop ─────────────────────────

describe('resolveManualReview — transition and overlay drop', () => {
  test('manual_review_required overlays while unresolved', async () => {
    const intent = await seedManualReviewIntent();
    const overlay = buildReversalOverlay([intent], 'b1');
    expect(overlay.get('p1')).toBe(-5); // reversal of +5 receiving
  });

  test('transitions to manual_review_resolved and the overlay drops the delta', async () => {
    const seeded = await seedManualReviewIntent();
    const res = await resolveManualReview(store, seeded.id, resolveInput, { now: fixedClock(2_000_000_000_000) });

    expect(res.outcome).toBe('resolved');
    expect(res.intent!.status).toBe('manual_review_resolved');

    // Overlay now excludes it → no pending delta for p1.
    const all = await listQueue(store);
    expect(buildReversalOverlay(all, 'b1').size).toBe(0);
  });

  test('records resolvedAt/resolvedByStaffId/resolvedByRole/reasonCode/note', async () => {
    const seeded = await seedManualReviewIntent();
    const res = await resolveManualReview(store, seeded.id, resolveInput, { now: () => '2026-06-10T00:00:00.000Z' });

    expect(res.intent!.manualReviewResolution).toEqual({
      resolvedAt: '2026-06-10T00:00:00.000Z',
      resolvedByStaffId: 'mgr-9',
      resolvedByRole: 'manager',
      reasonCode: 'reconciled_in_firestore',
      note: 'นับสต็อกแล้ว',
    });
  });

  test('does NOT set localCorrection.reversed and does NOT touch the internal stock counter', async () => {
    const seeded = await seedManualReviewIntent();
    // createOfflineReversal already applied the -5 correction to the internal counter.
    const counterBefore = await readLocalStock(store, 'p1', 'b1');
    expect(counterBefore).toBe(-5);

    const res = await resolveManualReview(store, seeded.id, resolveInput, { now: fixedClock() });

    expect(res.intent!.localCorrection.reversed).toBe(false); // not rolled back
    expect(res.intent!.localCorrection.applied).toBe(true); // history preserved
    expect(await readLocalStock(store, 'p1', 'b1')).toBe(counterBefore); // counter unchanged by resolve
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe('resolveManualReview — idempotency', () => {
  test('second resolve returns already_resolved and preserves the original metadata', async () => {
    const seeded = await seedManualReviewIntent();
    const first = await resolveManualReview(store, seeded.id, resolveInput, { now: () => '2026-06-10T00:00:00.000Z' });
    expect(first.outcome).toBe('resolved');

    // A second call with DIFFERENT actor/reason must not overwrite the original audit.
    const second = await resolveManualReview(
      store,
      seeded.id,
      { resolvedByStaffId: 'admin-2', resolvedByRole: 'admin', reasonCode: 'second-call' },
      { now: () => '2027-01-01T00:00:00.000Z' },
    );
    expect(second.outcome).toBe('already_resolved');
    expect(second.intent!.manualReviewResolution).toEqual(first.intent!.manualReviewResolution);
    expect(buildReversalOverlay(await listQueue(store), 'b1').size).toBe(0); // overlay stays dropped
  });
});

// ─── Authority + required-field guards (throw) ───────────────────────────────

describe('resolveManualReview — authority and field guards throw', () => {
  test('staff role throws ManualReviewResolveError and does not mutate', async () => {
    const seeded = await seedManualReviewIntent();
    await expect(
      resolveManualReview(store, seeded.id, { ...resolveInput, resolvedByRole: 'staff' }),
    ).rejects.toBeInstanceOf(ManualReviewResolveError);
    expect((await listQueue(store))[0].status).toBe('manual_review_required'); // untouched
  });

  test('missing actor id throws', async () => {
    const seeded = await seedManualReviewIntent();
    await expect(
      resolveManualReview(store, seeded.id, { ...resolveInput, resolvedByStaffId: '  ' }),
    ).rejects.toBeInstanceOf(ManualReviewResolveError);
  });

  test('missing reason code throws', async () => {
    const seeded = await seedManualReviewIntent();
    await expect(
      resolveManualReview(store, seeded.id, { ...resolveInput, reasonCode: '' }),
    ).rejects.toBeInstanceOf(ManualReviewResolveError);
  });
});

// ─── State-case outcomes (no throw) ──────────────────────────────────────────

describe('resolveManualReview — state-case outcomes', () => {
  test('unknown intentId returns not_found', async () => {
    const res = await resolveManualReview(store, 'does-not-exist', resolveInput);
    expect(res.outcome).toBe('not_found');
    expect(res.intent).toBeNull();
  });

  test('a non-eligible status returns not_eligible and does not mutate', async () => {
    // A freshly created intent is `queued`, not manual_review_required.
    const queued = await createOfflineReversal(store, createInput, { now: fixedClock() });
    const res = await resolveManualReview(store, queued.id, resolveInput, { now: fixedClock() });

    expect(res.outcome).toBe('not_eligible');
    expect(res.intent!.status).toBe('queued'); // unchanged
    expect((await listQueue(store))[0].status).toBe('queued');
  });

  test('server_rejected is not resolvable (returns not_eligible)', async () => {
    const intent = await createOfflineReversal(store, createInput, { now: fixedClock() });
    await store.transact(['intents'], 'readwrite', async (txn) => {
      const rejected: OfflineReversalIntent = {
        ...intent,
        status: 'server_rejected',
        localCorrection: { ...intent.localCorrection, reversed: true },
      };
      await txn.put('intents', intent.id, rejected);
    });
    const res = await resolveManualReview(store, intent.id, resolveInput, { now: fixedClock() });
    expect(res.outcome).toBe('not_eligible');
  });
});

// ─── Sync-path inertness ─────────────────────────────────────────────────────

describe('resolveManualReview — terminal/inert to sync', () => {
  test('a manual_review_resolved intent is NOT claimable by the sync worker', async () => {
    const seeded = await seedManualReviewIntent();
    await resolveManualReview(store, seeded.id, resolveInput, { now: fixedClock() });

    const claimable = await listClaimable(store, { now: fixedClock() });
    expect(claimable.map((i) => i.id)).not.toContain(seeded.id);
  });
});
