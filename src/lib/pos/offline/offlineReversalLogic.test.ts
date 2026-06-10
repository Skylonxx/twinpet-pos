import { describe, expect, test } from 'vitest';
import {
  aggregateDeltasByCounter,
  assertOfflineReversalAuthority,
  buildOfflineReversalIntent,
  classifyServerResult,
  computeReversalDelta,
  deriveReversalIds,
  invertDeltas,
  isClaimable,
  isLeaseExpired,
  isOfflineReversalAuthoritySupported,
  isRollbackSafe,
  OfflineReversalRejectedError,
  stockCounterKey,
  type ServerReversalResponse,
} from './offlineReversalLogic';
import type { CreateReversalInput } from './offlineReversalTypes';

const baseInput: CreateReversalInput = {
  businessId: 'biz-1',
  sourceType: 'receiving',
  sourceId: 'GRN-001',
  action: 'reverse',
  createdByStaffId: 'staff-1',
  actorRole: 'manager',
  branchId: 'branch-1',
  reasonCode: 'wrong_entry',
  originalEffects: [
    { productId: 'p1', locationId: 'branch-1', lotId: 'lot-1', quantity: 5 },
    { productId: 'p2', locationId: 'branch-1', quantity: 3 },
  ],
};

describe('deriveReversalIds', () => {
  test('is deterministic for the same source/action (idempotency by construction)', () => {
    const a = deriveReversalIds(baseInput);
    // reasonCode/staff differ but are NOT part of identity → same ids.
    const b = deriveReversalIds({
      businessId: baseInput.businessId,
      sourceType: baseInput.sourceType,
      sourceId: baseInput.sourceId,
      action: baseInput.action,
    });
    expect(a).toEqual(b);
    expect(a.idempotencyKey).toBe('rev:biz-1:receiving:GRN-001:reverse');
    expect(a.id.startsWith('ori_')).toBe(true);
    expect(a.localMutationId.startsWith('lmu_')).toBe(true);
  });

  test('differs across source, action, and business', () => {
    const k = (i: Partial<CreateReversalInput>) => deriveReversalIds({ ...baseInput, ...i }).id;
    const ids = new Set([
      k({}),
      k({ sourceId: 'GRN-002' }),
      k({ action: 'void' }),
      k({ sourceType: 'transfer' }),
      k({ businessId: 'biz-2' }),
    ]);
    expect(ids.size).toBe(5);
  });
});

describe('computeReversalDelta', () => {
  test('negates the original stock effect and drops zero-qty effects', () => {
    expect(
      computeReversalDelta([
        { productId: 'p1', locationId: 'b1', quantity: 5 },
        { productId: 'p2', locationId: 'b1', quantity: 0 },
        { productId: 'p3', locationId: 'b2', lotId: 'L', quantity: -2 },
      ]),
    ).toEqual([
      { productId: 'p1', locationId: 'b1', lotId: null, delta: -5 },
      { productId: 'p3', locationId: 'b2', lotId: 'L', delta: 2 },
    ]);
  });
});

describe('aggregateDeltasByCounter', () => {
  test('sums lot-level deltas into the product×location counter', () => {
    expect(
      aggregateDeltasByCounter([
        { productId: 'p1', locationId: 'b1', lotId: 'L1', delta: -3 },
        { productId: 'p1', locationId: 'b1', lotId: 'L2', delta: -2 },
        { productId: 'p1', locationId: 'b2', delta: -1 },
      ]),
    ).toEqual([
      { key: stockCounterKey('p1', 'b1'), productId: 'p1', locationId: 'b1', delta: -5 },
      { key: stockCounterKey('p1', 'b2'), productId: 'p1', locationId: 'b2', delta: -1 },
    ]);
  });
});

describe('buildOfflineReversalIntent', () => {
  test('starts queued with the correction not yet applied', () => {
    const ids = deriveReversalIds(baseInput);
    const delta = computeReversalDelta(baseInput.originalEffects);
    const intent = buildOfflineReversalIntent(ids, baseInput, delta, '2026-06-10T00:00:00.000Z');
    expect(intent.status).toBe('queued');
    expect(intent.localCorrection).toEqual({ applied: false, reversed: false, stockDelta: delta });
    expect(intent.idempotencyKey).toBe(ids.idempotencyKey);
    expect(intent.createdAt).toBe('2026-06-10T00:00:00.000Z');
  });
});

describe('classifyServerResult', () => {
  const resp = (o: Partial<ServerReversalResponse>): ServerReversalResponse => ({
    ok: false,
    idempotencyKey: 'k',
    status: 'rejected',
    ...o,
  });

  test('network error (null response) → retryable, never a rejection', () => {
    expect(classifyServerResult(null)).toBe('retryable');
    expect(classifyServerResult(undefined)).toBe('retryable');
  });

  test('ok confirmed / duplicate_confirmed → accepted', () => {
    expect(classifyServerResult(resp({ ok: true, status: 'confirmed' }))).toBe('accepted');
    expect(classifyServerResult(resp({ ok: true, status: 'duplicate_confirmed' }))).toBe('accepted');
  });

  test('server conflict_requires_manual_review → manual_review', () => {
    expect(classifyServerResult(resp({ status: 'conflict_requires_manual_review' }))).toBe('manual_review');
  });

  test('server_error reject code → retryable (transient)', () => {
    expect(classifyServerResult(resp({ rejectCode: 'server_error' }))).toBe('retryable');
  });

  test('definitive rejects → rejected_rollback_eligible', () => {
    for (const rejectCode of ['stock_conflict', 'lot_conflict', 'already_reversed', 'invalid_pin']) {
      expect(classifyServerResult(resp({ rejectCode }))).toBe('rejected_rollback_eligible');
    }
  });
});

describe('isRollbackSafe (fail-closed)', () => {
  test('safe ONLY when safety is explicitly proven (true)', () => {
    expect(isRollbackSafe(true)).toBe(true);
    expect(isRollbackSafe(false)).toBe(false); // missing/unknown evidence → not safe
  });
});

describe('invertDeltas', () => {
  test('flips the sign of every delta', () => {
    expect(invertDeltas([{ productId: 'p', locationId: 'b', lotId: null, delta: -5 }])).toEqual([
      { productId: 'p', locationId: 'b', lotId: null, delta: 5 },
    ]);
  });
});

// ─── Offline actor authority (Blocker 2) ─────────────────────────────────────

describe('offline reversal authority', () => {
  test('manager/admin are supported; staff is not', () => {
    expect(isOfflineReversalAuthoritySupported('admin')).toBe(true);
    expect(isOfflineReversalAuthoritySupported('manager')).toBe(true);
    expect(isOfflineReversalAuthoritySupported('staff')).toBe(false);
  });

  test('assert throws a structured rejection for staff and passes for manager/admin', () => {
    expect(() => assertOfflineReversalAuthority('manager')).not.toThrow();
    expect(() => assertOfflineReversalAuthority('admin')).not.toThrow();
    try {
      assertOfflineReversalAuthority('staff');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OfflineReversalRejectedError);
      expect((err as OfflineReversalRejectedError).code).toBe('offline_staff_authority_unsupported');
    }
  });
});

// ─── Recoverable sync lease (Blocker 1) ──────────────────────────────────────

describe('lease / claimability', () => {
  const now = '2026-06-10T00:00:10.000Z';

  test('isLeaseExpired: absent or past expiry is expired; future is not', () => {
    expect(isLeaseExpired(undefined, now)).toBe(true);
    expect(isLeaseExpired(null, now)).toBe(true);
    expect(isLeaseExpired('2026-06-10T00:00:05.000Z', now)).toBe(true); // past
    expect(isLeaseExpired('2026-06-10T00:00:30.000Z', now)).toBe(false); // future
  });

  test('isClaimable: queued/retryable always; syncing only when lease expired; terminal never', () => {
    expect(isClaimable({ status: 'queued', syncLeaseExpiresAt: null }, now)).toBe(true);
    expect(isClaimable({ status: 'retryable_error', syncLeaseExpiresAt: null }, now)).toBe(true);
    expect(isClaimable({ status: 'syncing', syncLeaseExpiresAt: '2026-06-10T00:00:05.000Z' }, now)).toBe(true);
    expect(isClaimable({ status: 'syncing', syncLeaseExpiresAt: '2026-06-10T00:00:30.000Z' }, now)).toBe(false);
    expect(isClaimable({ status: 'server_accepted', syncLeaseExpiresAt: null }, now)).toBe(false);
    expect(isClaimable({ status: 'manual_review_required', syncLeaseExpiresAt: null }, now)).toBe(false);
  });
});
