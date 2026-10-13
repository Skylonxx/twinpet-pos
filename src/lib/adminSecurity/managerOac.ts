/**
 * Admin & Security Center V1 — per-manager local OAC status + local revoke.
 *
 * Bridges exactly two native commands, each taking only the canonical
 * manager id:
 *   - `native_get_manager_oac_status` (read-only display-safe projection);
 *   - `native_revoke_manager_oac`     (removes ONLY that manager's active
 *                                      OAC slot — a capability reduction).
 * Neither returns or accepts an OAC id, device id, lockout id, verifier,
 * salt, pepper, signature or token. Results are projected to coarse states
 * before reaching any UI.
 */

import { getPrivilegedLockoutRecoveryInvoke, type NativeInvoke } from '../auth/privilegedLockoutRecovery';

export const NATIVE_MANAGER_OAC_STATUS_COMMAND = 'native_get_manager_oac_status' as const;
export const NATIVE_REVOKE_MANAGER_OAC_COMMAND = 'native_revoke_manager_oac' as const;

const CANONICAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type NativeManagerOacStatus =
  | {
      kind: 'read';
      capability: 'PRESENT' | 'MISSING' | 'INVALID';
      branchId: string | null;
      fresh: boolean;
      authVersionAtIssue: number | null;
      lockedOut: boolean;
      consecutiveFailedAttempts: number;
      maxFailedAttempts: number;
    }
  | { kind: 'unavailable' };

export type ManagerOacRevokeResult = 'revoked' | 'none' | 'failed' | 'not_native';

/** The single coarse state the Admin Center renders for a manager/admin row. */
export type ApprovalCapabilityState = 'ready' | 'reissue_required' | 'expired' | 'missing' | 'locked' | 'unknown';

export function getManagerOacInvoke(): NativeInvoke | null {
  return getPrivilegedLockoutRecoveryInvoke();
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

export async function readManagerOacStatus(
  managerStaffId: string,
  invoke: NativeInvoke | null = getManagerOacInvoke(),
): Promise<NativeManagerOacStatus> {
  if (!invoke || !CANONICAL_ID_RE.test(managerStaffId)) return { kind: 'unavailable' };
  let raw: unknown;
  try {
    raw = await invoke(NATIVE_MANAGER_OAC_STATUS_COMMAND, { managerStaffId });
  } catch {
    return { kind: 'unavailable' };
  }
  if (raw == null || typeof raw !== 'object') return { kind: 'unavailable' };
  const r = raw as Record<string, unknown>;
  if (r.ok !== true || r.managerStaffId !== managerStaffId) return { kind: 'unavailable' };
  const capability = r.capability;
  if (capability !== 'PRESENT' && capability !== 'MISSING' && capability !== 'INVALID') return { kind: 'unavailable' };
  if (!isFiniteNonNegative(r.consecutiveFailedAttempts) || !isFiniteNonNegative(r.maxFailedAttempts)) {
    return { kind: 'unavailable' };
  }
  return {
    kind: 'read',
    capability,
    branchId: typeof r.branchId === 'string' ? r.branchId : null,
    fresh: r.fresh === true,
    authVersionAtIssue: isFiniteNonNegative(r.authVersionAtIssue) ? r.authVersionAtIssue : null,
    lockedOut: r.lockedOut === true,
    consecutiveFailedAttempts: r.consecutiveFailedAttempts,
    maxFailedAttempts: r.maxFailedAttempts,
  };
}

/**
 * Removes only `managerStaffId`'s local active OAC slot. Idempotent. Safe to
 * call for any target (a user without a slot is a no-op). Never throws.
 */
export async function revokeManagerOac(
  managerStaffId: string,
  invoke: NativeInvoke | null = getManagerOacInvoke(),
): Promise<ManagerOacRevokeResult> {
  if (!invoke) return 'not_native';
  if (!CANONICAL_ID_RE.test(managerStaffId)) return 'failed';
  let raw: unknown;
  try {
    raw = await invoke(NATIVE_REVOKE_MANAGER_OAC_COMMAND, { managerStaffId });
  } catch {
    return 'failed';
  }
  if (raw == null || typeof raw !== 'object') return 'failed';
  const r = raw as Record<string, unknown>;
  if (r.ok !== true || r.managerStaffId !== managerStaffId) return 'failed';
  return r.revoked === true ? 'revoked' : 'none';
}

export type CapabilityProjectionInput = {
  status: NativeManagerOacStatus;
  /** Live server facts for the target (from the admin overview). */
  role: string;
  isActive: boolean;
  branchIds: readonly string[];
  liveAuthVersion: number;
  /** This terminal's current concrete branch. */
  terminalBranchId: string | null;
};

/**
 * Fail-closed projection. `ready` requires an exact binding: present, signed,
 * fresh, this terminal's branch, an approver role with access to that
 * branch, active, and an authVersion equal to the one the OAC was issued at
 * (every server-accepted account mutation bumps it, and server adjudication
 * rejects an OAC whose authVersion changed).
 */
export function projectApprovalCapability(input: CapabilityProjectionInput): ApprovalCapabilityState {
  const { status } = input;
  if (status.kind !== 'read') return 'unknown';
  if (status.lockedOut) return 'locked';
  if (status.capability === 'MISSING') return 'missing';
  if (status.capability === 'INVALID') return 'reissue_required';
  const terminal = input.terminalBranchId;
  const eligibleRole = input.role === 'manager' || input.role === 'admin';
  const hasBranch = !!terminal && (input.branchIds.includes(terminal) || input.branchIds.includes('ALL'));
  const exact =
    eligibleRole &&
    input.isActive &&
    hasBranch &&
    status.branchId === terminal &&
    status.authVersionAtIssue !== null &&
    status.authVersionAtIssue === input.liveAuthVersion;
  if (!exact) return 'reissue_required';
  return status.fresh ? 'ready' : 'expired';
}
