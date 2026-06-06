import { describe, it, expect } from 'vitest';
import { mapExceptionRow, retryDisableReason, RECONCILE_RETRY_CAP } from './exceptionRows';

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
    expect(row.billId).toBe('o2'); // doc id fallback
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
    expect(retryDisableReason({ reconcileAttempts: 1, voidRequested: false }, false)).toBeNull();
  });
  it('disabled while in-flight', () => {
    expect(retryDisableReason({ reconcileAttempts: 1, voidRequested: false }, true)).not.toBeNull();
  });
  it('disabled when voidRequested', () => {
    expect(retryDisableReason({ reconcileAttempts: 1, voidRequested: true }, false)).not.toBeNull();
  });
  it('disabled at/over the cap', () => {
    expect(retryDisableReason({ reconcileAttempts: RECONCILE_RETRY_CAP, voidRequested: false }, false)).not.toBeNull();
  });
});
