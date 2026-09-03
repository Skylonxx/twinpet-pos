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
  | 'permission_absent';

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
  return { allowed: true, reason: 'granted' };
}

export async function resolveLivePrivilegedPermission(
  database: Firestore,
  role: string | null | undefined,
  permission: string,
  reader?: RolePermissionsReader,
): Promise<LivePermissionDecision> {
  if (role == null || role === '') return { allowed: false, reason: 'role_absent' };
  let snapshot: RolePermissionsDocSnapshot;
  try {
    snapshot = await (reader ?? (() => readRolePermissionsDoc(database)))();
  } catch {
    return { allowed: false, reason: 'document_unreadable' };
  }
  return decideLiveRolePermission(role, permission, snapshot);
}

/** Shared requester/approver live `pos_void` decision. Never consults token claims. */
export async function resolveLivePosVoid(
  database: Firestore,
  role: string | null | undefined,
  reader?: RolePermissionsReader,
): Promise<LivePermissionDecision> {
  return resolveLivePrivilegedPermission(database, role, PRIVILEGED_REQUESTER_PERMISSION, reader);
}

export async function liveRoleHoldsPosVoid(
  database: Firestore,
  role: string | null | undefined,
  reader?: RolePermissionsReader,
): Promise<boolean> {
  const decision = await resolveLivePosVoid(database, role, reader);
  return decision.allowed;
}
