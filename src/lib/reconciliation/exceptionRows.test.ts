import { describe, expect, it, test } from 'vitest';
import {
  isV9Only,
  mapExceptionRow,
  mapV9FaultRow,
  mergeExceptionRows,
  retryDisableReason,
  RECONCILE_RETRY_CAP,
} from './exceptionRows';

describe('mapExceptionRow (query-hook mapping)', () => {
  it('maps fields, prefers lastReconcileError, derives lastErrorAtMs from a Timestamp', () => {
    const row = mapExceptionRow('o1', {
      billId: 'TW-1',
      branchId: 'LDP-001',
      staffName: 'สมชาย',
      total: 100,
      reconcileAttempts: 2,
      adminRetryCount: 1,
      reconcileError: 'first sanitized',
      lastReconcileError: 'latest sanitized',
      voidRequested: false,
      lastReconcileErrorAt: { toMillis: () => 1700 },
    });
    expect(row).toMatchObject({
      id: 'o1',
      billId: 'TW-1',
      branchId: 'LDP-001',
      staffName: 'สมชาย',
      total: 100,
      reconcileAttempts: 2,
      adminRetryCount: 1,
      lastReconcileError: 'latest sanitized',
      firstReconcileError: 'first sanitized',
      voidRequested: false,
      lastErrorAtMs: 1700,
    });
  });

  it('falls back to safe defaults when fields are absent', () => {
    const row = mapExceptionRow('o2', {});
    expect(row.billId).toBe('o2');
    expect(row.branchId).toBe('—');
    expect(row.reconcileAttempts).toBe(0);
    expect(row.adminRetryCount).toBe(0);
    expect(row.lastReconcileError).toBe('—');
    expect(row.voidRequested).toBe(false);
    expect(row.lastErrorAtMs).toBeNull();
  });
});

describe('retryDisableReason (mirrors server guards)', () => {
  it('ENABLED when below cap, not void, not in-flight', () => {
    expect(retryDisableReason({ reconcileAttempts: 1, voidRequested: false, kinds: ['exception'] }, false)).toBeNull();
  });
  it('disabled while in-flight', () => {
    expect(retryDisableReason({ reconcileAttempts: 1, voidRequested: false, kinds: ['exception'] }, true)).not.toBeNull();
  });
  it('disabled when voidRequested', () => {
    expect(retryDisableReason({ reconcileAttempts: 1, voidRequested: true, kinds: ['exception'] }, false)).not.toBeNull();
  });
  it('disabled at/over the cap', () => {
    expect(retryDisableReason({ reconcileAttempts: RECONCILE_RETRY_CAP, voidRequested: false, kinds: ['exception'] }, false)).not.toBeNull();
  });
});

describe('N07 N10 exception row merge / unknown fault', () => {
  test('N07 merge by document id without duplicate', () => {
    const ex = mapExceptionRow('o1', { billId: 'B', branchId: 'br1', total: 1 });
    const v9 = mapV9FaultRow('o1', {
      billId: 'B',
      branchId: 'br1',
      total: 1,
      voidRevisionFault: 'revision_malformed',
      voidRevisionFaultAt: { toMillis: () => 9 },
    });
    const merged = mergeExceptionRows([ex], v9 ? [v9] : []);
    expect(merged).toHaveLength(1);
    expect(merged[0].kinds.sort()).toEqual(['exception', 'void_revision_fault']);
  });

  test('N10 unknown future literal maps to unknown_fault when timestamp present', () => {
    const row = mapV9FaultRow('o2', {
      voidRevisionFault: 'future_literal',
      voidRevisionFaultAt: { toMillis: () => 1 },
    });
    expect(row?.faultDisplay).toBe('unknown_fault');
    expect(row?.rawFault).toBe('future_literal');
  });

  test('V9-only disables retry', () => {
    const row = mapV9FaultRow('o3', {
      voidRevisionFault: 'revision_overflow',
      voidRevisionFaultAt: { toMillis: () => 1 },
    })!;
    expect(isV9Only(row)).toBe(true);
    expect(retryDisableReason(row, false)).not.toBeNull();
  });
});
