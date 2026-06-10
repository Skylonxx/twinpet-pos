import { beforeEach, describe, expect, test } from 'vitest';
import {
  buildReversalOverlay,
  isOverlayEligible,
  readReversalOverlay,
} from './reversalStockOverlay';
import { createOfflineReversal, listQueue } from './offlineReversalQueue';
import { createInMemoryReversalStore } from './reversalLocalStore';
import type {
  CreateReversalInput,
  LocalStockDelta,
  OfflineReversalIntent,
  OfflineReversalStatus,
} from './offlineReversalTypes';

// ─── Pure overlay builder ────────────────────────────────────────────────────

function intent(
  status: OfflineReversalStatus,
  stockDelta: LocalStockDelta[],
  correction: { applied?: boolean; reversed?: boolean } = {},
): OfflineReversalIntent {
  return {
    id: `ori_${status}_${stockDelta.map((d) => d.productId).join('-')}`,
    businessId: 'b1',
    sourceType: 'receiving',
    sourceId: 'GRN-x',
    action: 'void',
    branchId: 'b1',
    reasonCode: 'r',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdByStaffId: 'mgr-1',
    createdByRole: 'manager',
    idempotencyKey: 'k',
    localMutationId: 'm',
    status,
    localCorrection: {
      applied: correction.applied ?? true,
      reversed: correction.reversed ?? false,
      stockDelta,
    },
  };
}

const d = (productId: string, delta: number, locationId = 'b1'): LocalStockDelta => ({
  productId,
  locationId,
  lotId: null,
  delta,
});

describe('isOverlayEligible', () => {
  test('queued / syncing / retryable_error / manual_review_required are eligible', () => {
    for (const s of ['queued', 'syncing', 'retryable_error', 'manual_review_required'] as const) {
      expect(isOverlayEligible(intent(s, [d('p1', -5)]))).toBe(true);
    }
  });

  test('server_accepted is NOT eligible (Firestore is authoritative — no permanent double-count)', () => {
    expect(isOverlayEligible(intent('server_accepted', [d('p1', -5)]))).toBe(false);
  });

  test('server_rejected is NOT eligible', () => {
    expect(isOverlayEligible(intent('server_rejected', [d('p1', -5)], { reversed: true }))).toBe(false);
  });

  test('an unapplied or reversed correction is excluded even when status is eligible', () => {
    expect(isOverlayEligible(intent('queued', [d('p1', -5)], { applied: false }))).toBe(false);
    expect(isOverlayEligible(intent('manual_review_required', [d('p1', -5)], { reversed: true }))).toBe(false);
  });
});

describe('buildReversalOverlay', () => {
  test('no intents → empty overlay', () => {
    expect(buildReversalOverlay([], 'b1').size).toBe(0);
  });

  test('queued reversal delta is included, keyed by productId', () => {
    const overlay = buildReversalOverlay([intent('queued', [d('p1', -5), d('p2', -3)])], 'b1');
    expect(overlay.get('p1')).toBe(-5);
    expect(overlay.get('p2')).toBe(-3);
  });

  test('only deltas at the requested branch are overlaid', () => {
    const overlay = buildReversalOverlay(
      [intent('queued', [d('p1', -5, 'b1'), d('p9', -2, 'b2')])],
      'b1',
    );
    expect(overlay.get('p1')).toBe(-5);
    expect(overlay.has('p9')).toBe(false);
  });

  test('retryable_error keeps its delta in the overlay (correction still applied)', () => {
    expect(buildReversalOverlay([intent('retryable_error', [d('p1', -5)])], 'b1').get('p1')).toBe(-5);
  });

  test('manual_review_required keeps its delta while the local correction remains applied', () => {
    expect(
      buildReversalOverlay([intent('manual_review_required', [d('p1', -5)])], 'b1').get('p1'),
    ).toBe(-5);
  });

  test('server_accepted contributes nothing → no permanent double correction', () => {
    expect(buildReversalOverlay([intent('server_accepted', [d('p1', -5)])], 'b1').size).toBe(0);
  });

  test('a safely rolled-back (reversed) correction is excluded', () => {
    expect(
      buildReversalOverlay(
        [intent('server_rejected', [d('p1', -5)], { reversed: true })],
        'b1',
      ).size,
    ).toBe(0);
  });

  test('multiple eligible intents on the same product sum their deltas', () => {
    const overlay = buildReversalOverlay(
      [intent('queued', [d('p1', -5)]), intent('retryable_error', [d('p1', -2)])],
      'b1',
    );
    expect(overlay.get('p1')).toBe(-7);
  });

  test('a mix: only eligible intents contribute (accepted + reversed dropped)', () => {
    const overlay = buildReversalOverlay(
      [
        intent('queued', [d('p1', -5)]),
        intent('server_accepted', [d('p1', -100)]), // excluded
        intent('server_rejected', [d('p2', -9)], { reversed: true }), // excluded
        intent('manual_review_required', [d('p2', -3)]), // included
      ],
      'b1',
    );
    expect(overlay.get('p1')).toBe(-5);
    expect(overlay.get('p2')).toBe(-3);
  });
});

// ─── readReversalOverlay over the durable queue (integration) ────────────────

describe('readReversalOverlay — durable queue integration', () => {
  let store: ReturnType<typeof createInMemoryReversalStore>;
  beforeEach(() => {
    store = createInMemoryReversalStore();
  });

  const receivingInput = (): CreateReversalInput => ({
    businessId: 'b1',
    sourceType: 'receiving',
    sourceId: 'GRN-001',
    action: 'void',
    createdByStaffId: 'mgr-1',
    actorRole: 'manager',
    branchId: 'b1',
    reasonCode: 'mis-entry',
    originalEffects: [
      { productId: 'p1', locationId: 'b1', lotId: 'lot-1', quantity: 5 },
      { productId: 'p2', locationId: 'b1', lotId: 'lot-2', quantity: 3 },
    ],
  });

  test('no pending reversals → empty overlay (POS reads plain Firestore stock)', async () => {
    expect((await readReversalOverlay('b1', store)).size).toBe(0);
  });

  test('POS-visible delta appears immediately after an offline receiving reversal', async () => {
    await createOfflineReversal(store, receivingInput(), { now: () => '2026-01-01T00:00:00.000Z' });

    const overlay = await readReversalOverlay('b1', store);
    // Receiving ADDED +5/+3; the reversal correction is the negation.
    expect(overlay.get('p1')).toBe(-5);
    expect(overlay.get('p2')).toBe(-3);
  });

  test('a reversal at another branch does not bleed into this branch overlay', async () => {
    await createOfflineReversal(store, receivingInput(), { now: () => '2026-01-01T00:00:00.000Z' });
    expect((await readReversalOverlay('other-branch', store)).size).toBe(0);
  });

  test('idempotent replay does not double the overlay delta', async () => {
    const now = () => '2026-01-01T00:00:00.000Z';
    await createOfflineReversal(store, receivingInput(), { now });
    await createOfflineReversal(store, receivingInput(), { now }); // replay (same source/action)

    expect(await listQueue(store)).toHaveLength(1); // one intent only
    expect((await readReversalOverlay('b1', store)).get('p1')).toBe(-5); // not -10
  });

  test('fail-safe: a throwing store yields an empty overlay (POS never breaks)', async () => {
    const brokenStore = {
      transact: () => Promise.reject(new Error('IndexedDB unavailable')),
    };
    expect((await readReversalOverlay('b1', brokenStore as never)).size).toBe(0);
  });
});
