import { describe, it, expect } from 'vitest';
import { canViewReconciliationExceptions, shouldStartExceptionsQuery } from './adminGate';

// Route / admin-gate: the page uses this to degrade safely for non-admins who
// reach the direct URL (independent of the AdminLayout route guard).
describe('canViewReconciliationExceptions (admin-gate)', () => {
  it('is true ONLY for admin', () => {
    expect(canViewReconciliationExceptions('admin')).toBe(true);
  });
  it('is false for manager, staff, and missing role', () => {
    expect(canViewReconciliationExceptions('manager')).toBe(false);
    expect(canViewReconciliationExceptions('staff')).toBe(false);
    expect(canViewReconciliationExceptions(null)).toBe(false);
    expect(canViewReconciliationExceptions(undefined)).toBe(false);
  });
});

// SECURITY: prove a non-admin never starts the exception Firestore query.
// `enabled` is fed by `canViewReconciliationExceptions(role)`, so a non-admin
// → enabled=false → shouldStartExceptionsQuery=false → the hook issues no read.
describe('shouldStartExceptionsQuery (non-admin must NOT start the query)', () => {
  it('is FALSE when disabled (non-admin), even if Firestore is ready', () => {
    expect(shouldStartExceptionsQuery(false, true, true)).toBe(false);
  });
  it('end-to-end: a non-admin role yields no query start', () => {
    for (const role of ['manager', 'staff', null, undefined] as const) {
      const enabled = canViewReconciliationExceptions(role);
      expect(shouldStartExceptionsQuery(enabled, true, true)).toBe(false);
    }
  });
  it('is TRUE only when admin-enabled AND Firestore is configured', () => {
    const enabled = canViewReconciliationExceptions('admin');
    expect(shouldStartExceptionsQuery(enabled, true, true)).toBe(true);
    // admin but no Firestore (dev) → still no query
    expect(shouldStartExceptionsQuery(enabled, false, false)).toBe(false);
    expect(shouldStartExceptionsQuery(enabled, true, false)).toBe(false);
  });
});
