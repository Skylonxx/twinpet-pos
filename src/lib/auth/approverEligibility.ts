/**
 * Pure Model 2 approver eligibility / projection boundary.
 * Firebase-free so it is node-unit-testable. The client list is never
 * authority — the server re-evaluates every predicate at mint and consume.
 */

export type ApproverCandidate = {
  userId: string;
  displayName: string;
  username: string;
  role: 'manager' | 'admin';
};

export type ApproverEligibilitySource = {
  userId: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  role?: string;
  isActive?: boolean;
  deletedAt?: unknown;
  branchIds?: unknown;
};

export function approverBranchEligible(
  role: string | null | undefined,
  liveBranchIds: readonly string[],
  branchId: string,
): boolean {
  if (role === 'manager') return liveBranchIds.includes(branchId);
  if (role === 'admin') return liveBranchIds.includes('ALL') || liveBranchIds.includes(branchId);
  return false;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function isEligibleApproverCandidate(
  u: ApproverEligibilitySource,
  ctx: { branchId: string; requesterStaffId: string },
): boolean {
  if (!u.userId || u.userId === ctx.requesterStaffId) return false;
  if (u.role !== 'manager' && u.role !== 'admin') return false;
  if (u.isActive !== true) return false;
  if (u.deletedAt != null) return false;
  return approverBranchEligible(u.role, asStringArray(u.branchIds), ctx.branchId);
}

export function projectApproverCandidate(u: ApproverEligibilitySource): ApproverCandidate {
  const firstName = typeof u.firstName === 'string' ? u.firstName : '';
  const lastName = typeof u.lastName === 'string' ? u.lastName : '';
  const username = typeof u.username === 'string' ? u.username : '';
  const displayName = `${firstName} ${lastName}`.trim() || username;
  const role: 'manager' | 'admin' = u.role === 'admin' ? 'admin' : 'manager';
  return {
    userId: u.userId,
    displayName,
    username,
    role,
  };
}
