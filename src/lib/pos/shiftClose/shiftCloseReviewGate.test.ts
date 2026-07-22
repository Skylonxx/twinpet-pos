import { describe, it, expect } from 'vitest';
import { canViewShiftCloseReview, shouldStartShiftCloseReviewQuery } from './shiftCloseReviewGate';

describe('canViewShiftCloseReview (manager/admin gate)', () => {
  it('is true for manager and admin', () => {
    expect(canViewShiftCloseReview('manager')).toBe(true);
    expect(canViewShiftCloseReview('admin')).toBe(true);
  });

  it('is false for staff, cashier, null, undefined, and unknown roles', () => {
    expect(canViewShiftCloseReview('staff')).toBe(false);
    expect(canViewShiftCloseReview('cashier')).toBe(false);
    expect(canViewShiftCloseReview(null)).toBe(false);
    expect(canViewShiftCloseReview(undefined)).toBe(false);
    expect(canViewShiftCloseReview('some-unknown-role')).toBe(false);
  });
});

// SECURITY: prove the query never starts for a non-manager/admin, unconfigured
// Firestore, missing db, missing branchId, or the unscoped 'ALL' pseudo-branch.
describe('shouldStartShiftCloseReviewQuery (must NOT start under any disqualifying condition)', () => {
  it('is FALSE for a non-manager/admin role, even with everything else ready', () => {
    for (const role of ['staff', 'cashier', null, undefined] as const) {
      expect(shouldStartShiftCloseReviewQuery(role, true, true, 'BR-001')).toBe(false);
    }
  });

  it('is FALSE when Firebase is not configured', () => {
    expect(shouldStartShiftCloseReviewQuery('manager', false, true, 'BR-001')).toBe(false);
  });

  it('is FALSE when db is missing', () => {
    expect(shouldStartShiftCloseReviewQuery('manager', true, false, 'BR-001')).toBe(false);
  });

  it('is FALSE when branchId is null', () => {
    expect(shouldStartShiftCloseReviewQuery('manager', true, true, null)).toBe(false);
  });

  it('is FALSE when branchId is undefined', () => {
    expect(shouldStartShiftCloseReviewQuery('manager', true, true, undefined)).toBe(false);
  });

  it("is FALSE when branchId === 'ALL' (unscoped global-admin pseudo-branch)", () => {
    expect(shouldStartShiftCloseReviewQuery('admin', true, true, 'ALL')).toBe(false);
  });

  it('is TRUE only when every condition holds: manager/admin, Firebase ready, db present, real branchId', () => {
    expect(shouldStartShiftCloseReviewQuery('manager', true, true, 'BR-001')).toBe(true);
    expect(shouldStartShiftCloseReviewQuery('admin', true, true, 'BR-002')).toBe(true);
  });
});
