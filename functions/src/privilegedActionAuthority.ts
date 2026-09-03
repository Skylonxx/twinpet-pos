/**
 * Shared live privileged-void authority resolver (SEC-001 Part B RC).
 *
 * Privileged `pos_void` is decided from settings/_rolePermissions, not from
 * token claims and not from login-time role defaults. Present rows are
 * authoritative, including an explicit empty array. Ambiguous or unreadable
 * sources fail closed.
 *
 * Login (`resolvePermissionKeys` in index.ts) may still bootstrap defaults so a
 * session is never stripped to zero keys. That login-only fallback MUST NOT be
 * reused here: an absent/malformed privileged source is deny, not a grant.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { PRIVILEGED_REQUESTER_PERMISSION } from './privilegedActionRegistry';

export const ROLE_PERMISSIONS_COLLECTION = 'settings';
export const ROLE_PERMISSIONS_DOC_ID = '_rolePermissions';

export type LivePermissionDenyReason =
  | 'role_absent'
  | 'document_absent'
  | 'document_unreadable'
  | 'matrix_malformed'
  | 'role_key_absent'
  | 'role_row_empty'
  | 'role_row_malformed'
  | 'permission_absent'
  | 'staged_deny_active'
  | 'staged_deny_unreadable';

export type LivePermissionDecision =
  | { allowed: true; reason: 'granted' }
  | { allowed: false; reason: LivePermissionDenyReason };

export type RolePermissionsDocSnapshot = {
  exists: boolean;
  data: unknown;
};

export type RolePermissionsReader = () => Promise<RolePermissionsDocSnapshot>;

export async function readRolePermissionsDoc(database: Firestore): Promise<RolePermissionsDocSnapshot> {
  const snap = await database.collection(ROLE_PERMISSIONS_COLLECTION).doc(ROLE_PERMISSIONS_DOC_ID).get();
  return { exists: snap.exists === true, data: snap.exists ? snap.data() : undefined };
}

// --- F7 role-permission staged-deny (SEC-001 Packet C-A) -------------------
//
// Persisted states, head and job, no exception: DRAINING -> VERIFYING ->
// CONVERGED -> COMPLETED. STAGED is not a persisted state. While a role's
// permission removal is being staged/swept (any state before COMPLETED), the
// removed permission must fail closed immediately here, at read time —
// enforcement does not wait for the sweep to finish or for a session to
// refresh its claims.

export const STAGED_ROLE_DENY_COLLECTION = 'privilegedStagedRoleDeny';

export type StagedRoleDenyState = 'DRAINING' | 'VERIFYING' | 'CONVERGED' | 'COMPLETED';

export interface StagedRoleDenyHead {
  roleId: string;
  state: StagedRoleDenyState;
  changeId: string;
  deniedPermissions: readonly string[];
}

const ACTIVE_STAGED_DENY_STATES: readonly StagedRoleDenyState[] = ['DRAINING', 'VERIFYING', 'CONVERGED'];

/**
 * Returns the denied-permission list iff `head.state` is one of
 * `{DRAINING, VERIFYING, CONVERGED}` and `head.changeId === expectedChangeId`;
 * otherwise `[]`. A `null` head (no active staging round) always reads as `[]`.
 */
export function stagedDenyReader(head: StagedRoleDenyHead | null, expectedChangeId: string): readonly string[] {
  if (!head) return [];
  if (head.changeId !== expectedChangeId) return [];
  if (!ACTIVE_STAGED_DENY_STATES.includes(head.state)) return [];
  return head.deniedPermissions;
}

export type StagedRoleDenyHeadReader = (roleId: string) => Promise<StagedRoleDenyHead | null>;

function parseStagedRoleDenyHead(roleId: string, data: unknown): StagedRoleDenyHead | null {
  if (data == null || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  if (typeof raw.changeId !== 'string' || !raw.changeId) return null;
  if (
    raw.state !== 'DRAINING' &&
    raw.state !== 'VERIFYING' &&
    raw.state !== 'CONVERGED' &&
    raw.state !== 'COMPLETED'
  ) {
    return null;
  }
  if (!Array.isArray(raw.deniedPermissions) || !raw.deniedPermissions.every((p) => typeof p === 'string')) {
    return null;
  }
  return { roleId, state: raw.state, changeId: raw.changeId, deniedPermissions: raw.deniedPermissions as string[] };
}

export function firestoreStagedRoleDenyHeadReader(database: Firestore): StagedRoleDenyHeadReader {
  return async (roleId: string) => {
    const snap = await database.collection(STAGED_ROLE_DENY_COLLECTION).doc(roleId).get();
    if (!snap.exists) return null;
    const parsed = parseStagedRoleDenyHead(roleId, snap.data());
    if (parsed == null) {
      // A present staged-deny head that fails to parse (malformed changeId,
      // state, or deniedPermissions) is not the same as no staged deny round
      // existing. Collapsing it to `null` here would let resolveLivePrivilegedPermission
      // read it as absence and fall through to granting. Throw so the caller's
      // existing fail-closed catch (staged_deny_unreadable) applies instead.
      throw new Error(`staged-deny head for role "${roleId}" exists but is malformed/unverifiable`);
    }
    return parsed;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isStringPermissionArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function decideLiveRolePermission(
  role: string | null | undefined,
  permission: string,
  snapshot: RolePermissionsDocSnapshot,
  stagedDenyHead: StagedRoleDenyHead | null = null,
): LivePermissionDecision {
  if (role == null || role === '') return { allowed: false, reason: 'role_absent' };
  if (!snapshot.exists) return { allowed: false, reason: 'document_absent' };
  if (!isPlainObject(snapshot.data)) return { allowed: false, reason: 'matrix_malformed' };

  const matrix = snapshot.data.rolePermissions;
  if (!isPlainObject(matrix)) return { allowed: false, reason: 'matrix_malformed' };
  if (!Object.prototype.hasOwnProperty.call(matrix, role)) {
    return { allowed: false, reason: 'role_key_absent' };
  }

  const row = matrix[role];
  if (Array.isArray(row) && row.length === 0) return { allowed: false, reason: 'role_row_empty' };
  if (!isStringPermissionArray(row)) return { allowed: false, reason: 'role_row_malformed' };
  if (!row.includes(permission)) return { allowed: false, reason: 'permission_absent' };

  if (stagedDenyHead && stagedDenyHead.roleId === role) {
    const denied = stagedDenyReader(stagedDenyHead, stagedDenyHead.changeId);
    if (denied.includes(permission)) return { allowed: false, reason: 'staged_deny_active' };
  }

  return { allowed: true, reason: 'granted' };
}

export async function resolveLivePrivilegedPermission(
  database: Firestore,
  role: string | null | undefined,
  permission: string,
  reader?: RolePermissionsReader,
  readStagedDenyHead?: StagedRoleDenyHeadReader,
): Promise<LivePermissionDecision> {
  if (role == null || role === '') return { allowed: false, reason: 'role_absent' };
  let snapshot: RolePermissionsDocSnapshot;
  try {
    snapshot = await (reader ?? (() => readRolePermissionsDoc(database)))();
  } catch {
    return { allowed: false, reason: 'document_unreadable' };
  }
  let stagedDenyHead: StagedRoleDenyHead | null;
  try {
    stagedDenyHead = await (readStagedDenyHead ?? firestoreStagedRoleDenyHeadReader(database))(role);
  } catch {
    // A staged-deny reader failure must never be interpreted as "no staged
    // deny": during DRAINING/VERIFYING/CONVERGED that would permit a
    // permission that is actively being removed. Fail closed instead of
    // falling through to decideLiveRolePermission with a null head.
    return { allowed: false, reason: 'staged_deny_unreadable' };
  }
  return decideLiveRolePermission(role, permission, snapshot, stagedDenyHead);
}

/** Shared requester/approver live `pos_void` decision. Never consults token claims. */
export async function resolveLivePosVoid(
  database: Firestore,
  role: string | null | undefined,
  reader?: RolePermissionsReader,
  readStagedDenyHead?: StagedRoleDenyHeadReader,
): Promise<LivePermissionDecision> {
  return resolveLivePrivilegedPermission(database, role, PRIVILEGED_REQUESTER_PERMISSION, reader, readStagedDenyHead);
}

export async function liveRoleHoldsPosVoid(
  database: Firestore,
  role: string | null | undefined,
  reader?: RolePermissionsReader,
  readStagedDenyHead?: StagedRoleDenyHeadReader,
): Promise<boolean> {
  const decision = await resolveLivePosVoid(database, role, reader, readStagedDenyHead);
  return decision.allowed;
}
