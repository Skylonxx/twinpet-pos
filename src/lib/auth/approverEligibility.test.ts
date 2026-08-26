import { describe, expect, test } from 'vitest';
import {
  approverBranchEligible,
  isEligibleApproverCandidate,
  projectApproverCandidate,
  type ApproverEligibilitySource,
} from './approverEligibility';

const ctx = { branchId: 'B1', requesterStaffId: 's1' };

function source(over: Partial<ApproverEligibilitySource> = {}): ApproverEligibilitySource {
  return {
    userId: 'm1',
    firstName: 'Somchai',
    lastName: 'Manager',
    username: 'somchai',
    role: 'manager',
    isActive: true,
    deletedAt: null,
    branchIds: ['B1'],
    ...over,
  };
}

describe('approverEligibility', () => {
  test('eligible same-branch manager is accepted', () => {
    expect(isEligibleApproverCandidate(source(), ctx)).toBe(true);
  });

  test('self is rejected', () => {
    expect(isEligibleApproverCandidate(source({ userId: 's1' }), ctx)).toBe(false);
  });

  test('staff role is rejected', () => {
    expect(isEligibleApproverCandidate(source({ role: 'staff' }), ctx)).toBe(false);
  });

  test('inactive or deleted is rejected', () => {
    expect(isEligibleApproverCandidate(source({ isActive: false }), ctx)).toBe(false);
    expect(isEligibleApproverCandidate(source({ deletedAt: 1 }), ctx)).toBe(false);
  });

  test('manager wrong branch is rejected; admin ALL is accepted', () => {
    expect(isEligibleApproverCandidate(source({ branchIds: ['B2'] }), ctx)).toBe(false);
    expect(isEligibleApproverCandidate(source({ role: 'admin', branchIds: ['ALL'] }), ctx)).toBe(true);
    expect(approverBranchEligible('manager', ['ALL'], 'B1')).toBe(false);
    expect(approverBranchEligible('admin', ['ALL'], 'B1')).toBe(true);
  });

  test('projection has exactly four keys and omits forbidden fields', () => {
    const projected = projectApproverCandidate(
      source({
        userId: 'm1',
      }),
    );
    expect(Object.keys(projected).sort()).toEqual(['displayName', 'role', 'userId', 'username']);
    expect(projected).toEqual({
      userId: 'm1',
      displayName: 'Somchai Manager',
      username: 'somchai',
      role: 'manager',
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toMatch(/authVersion/);
    expect(serialized).not.toMatch(/"pin"/);
    expect(serialized).not.toMatch(/permissions/);
    expect(serialized).not.toMatch(/branchIds/);
  });

  test('displayName falls back to username when names are blank', () => {
    expect(projectApproverCandidate(source({ firstName: '', lastName: '', username: 'onlyuser' })).displayName).toBe(
      'onlyuser',
    );
  });
});
