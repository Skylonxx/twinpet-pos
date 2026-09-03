/**
 * SEC-001 Packet C-A — pure logic for `setRolePermissions`: F7
 * `DRAINING`-only staging entrypoint for role permission changes. Additions
 * apply immediately (a session having *more* live authority than it expects
 * is not the risk this guards against); removals go through the staged-deny
 * state machine so they fail closed immediately at read time
 * (`privilegedActionAuthority.ts`'s `stagedDenyReader`) while
 * `roleSweepScheduler.ts` sweeps the change to completion.
 */

export const ROLE_IDS = ['staff', 'manager', 'admin'] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export function isRoleId(value: unknown): value is RoleId {
  return value === 'staff' || value === 'manager' || value === 'admin';
}

export function isValidPermissionsArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (!value.every((p) => typeof p === 'string' && p.trim().length > 0)) return false;
  return new Set(value).size === value.length;
}

export interface RolePermissionChange {
  currentRow: readonly string[];
  nextRow: readonly string[];
  addedPermissions: readonly string[];
  removedPermissions: readonly string[];
  requiresStaging: boolean;
}

export function computeRolePermissionChange(currentRow: readonly string[], nextRow: readonly string[]): RolePermissionChange {
  const currentSet = new Set(currentRow);
  const nextSet = new Set(nextRow);
  const added = nextRow.filter((p) => !currentSet.has(p));
  const removed = currentRow.filter((p) => !nextSet.has(p));
  return {
    currentRow,
    nextRow,
    addedPermissions: added,
    removedPermissions: removed,
    requiresStaging: removed.length > 0,
  };
}

/** The matrix row written immediately (before any sweep completes): current ∪ additions, removals still present. */
export function interimMatrixRow(change: RolePermissionChange): readonly string[] {
  return [...new Set([...change.currentRow, ...change.addedPermissions])];
}

export type StagingState = 'DRAINING' | 'VERIFYING' | 'CONVERGED' | 'COMPLETED';

export interface StagedRoleDenyHeadDoc {
  roleId: RoleId;
  state: StagingState;
  changeId: string;
  deniedPermissions: readonly string[];
  targetRow: readonly string[];
  stagedAtServerMs: number;
}

export interface RoleSweepJobDoc {
  jobId: string;
  roleId: RoleId;
  changeId: string;
  state: StagingState;
  targetRow: readonly string[];
  startedAtServerMs: number;
}

export type StageChangeFailureCode = 'staging_already_active';

const ACTIVE_STATES: readonly StagingState[] = ['DRAINING', 'VERIFYING', 'CONVERGED'];

export function checkNoActiveStaging(
  existingHead: { state: StagingState } | null,
): { ok: true } | { ok: false; code: StageChangeFailureCode } {
  if (existingHead && ACTIVE_STATES.includes(existingHead.state)) {
    return { ok: false, code: 'staging_already_active' };
  }
  return { ok: true };
}

export function buildStagedRoleDenyDocs(
  roleId: RoleId,
  change: RolePermissionChange,
  nowMs: number,
  randomChangeIdBytes: Buffer,
  randomJobIdBytes: Buffer,
): { head: StagedRoleDenyHeadDoc; job: RoleSweepJobDoc } {
  if (randomChangeIdBytes.length !== 16) throw new RangeError('randomChangeIdBytes must be 16 bytes');
  if (randomJobIdBytes.length !== 16) throw new RangeError('randomJobIdBytes must be 16 bytes');
  const changeId = randomChangeIdBytes.toString('hex');
  const jobId = randomJobIdBytes.toString('hex');
  return {
    head: {
      roleId,
      state: 'DRAINING',
      changeId,
      deniedPermissions: change.removedPermissions,
      targetRow: change.nextRow,
      stagedAtServerMs: nowMs,
    },
    job: {
      jobId,
      roleId,
      changeId,
      state: 'DRAINING',
      targetRow: change.nextRow,
      startedAtServerMs: nowMs,
    },
  };
}
