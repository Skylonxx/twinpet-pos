/**
 * setRolePermissions — SEC-001 Packet C-A / F7. Admin-only entrypoint for
 * changing a role's permission row in `settings/_rolePermissions`. Pure
 * additions apply immediately; any removal stages a `DRAINING` deny round
 * (`privilegedStagedRoleDeny/{roleId}` + `privilegedRoleSweepJobs/{jobId}`)
 * that `roleSweepScheduler.ts` sweeps to `COMPLETED`.
 */

import { randomBytes } from 'node:crypto';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import type { AuthLike } from './authorityFence';
import {
  buildStagedRoleDenyDocs,
  checkNoActiveStaging,
  computeRolePermissionChange,
  interimMatrixRow,
  isRoleId,
  isValidPermissionsArray,
  type RoleId,
  type StagingState,
} from './setRolePermissionsCore';
import { STAGED_ROLE_DENY_COLLECTION } from './privilegedActionAuthority';

export const ROLE_SWEEP_JOBS_COLLECTION = 'privilegedRoleSweepJobs';
const ROLE_PERMISSIONS_DOC_PATH = ['settings', '_rolePermissions'] as const;

async function isLiveAdmin(database: Firestore, uid: string): Promise<boolean> {
  const snap = await database.collection('users').doc(uid).get();
  if (!snap.exists) return false;
  const user = (snap.data() ?? {}) as DocumentData;
  return user.role === 'admin' && user.isActive === true && user.deletedAt == null;
}

export type SetRolePermissionsFailureCode = 'not_authorized' | 'invalid_request_shape' | 'staging_already_active';

export type SetRolePermissionsResponse =
  | { ok: true; requiresStaging: false }
  | { ok: true; requiresStaging: true; changeId: string }
  | { ok: false; code: SetRolePermissionsFailureCode };

export async function performSetRolePermissions(
  database: Firestore,
  auth: AuthLike,
  requestData: unknown,
  nowMs: number = Date.now(),
): Promise<SetRolePermissionsResponse> {
  if (!auth?.uid || auth.token?.role !== 'admin' || !(await isLiveAdmin(database, auth.uid))) {
    return { ok: false, code: 'not_authorized' };
  }
  const raw = (requestData ?? {}) as { roleId?: unknown; permissions?: unknown };
  if (!isRoleId(raw.roleId) || !isValidPermissionsArray(raw.permissions)) {
    return { ok: false, code: 'invalid_request_shape' };
  }
  const roleId: RoleId = raw.roleId;
  const nextRow = raw.permissions;

  const matrixRef = database.collection(ROLE_PERMISSIONS_DOC_PATH[0]).doc(ROLE_PERMISSIONS_DOC_PATH[1]);
  const headRef = database.collection(STAGED_ROLE_DENY_COLLECTION).doc(roleId);

  const [matrixSnap, headSnap] = await Promise.all([matrixRef.get(), headRef.get()]);
  const matrix = (matrixSnap.exists ? matrixSnap.data() : {}) as { rolePermissions?: Record<string, unknown> };
  const currentRowRaw = matrix.rolePermissions?.[roleId];
  const currentRow: string[] = Array.isArray(currentRowRaw) ? currentRowRaw.filter((p): p is string => typeof p === 'string') : [];

  const change = computeRolePermissionChange(currentRow, nextRow);

  if (!change.requiresStaging) {
    await matrixRef.set(
      { rolePermissions: { [roleId]: interimMatrixRow(change) }, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { ok: true, requiresStaging: false };
  }

  const existingHead = headSnap.exists ? (headSnap.data() as { state?: StagingState }) : null;
  const activeCheck = checkNoActiveStaging(existingHead && existingHead.state ? { state: existingHead.state } : null);
  if (!activeCheck.ok) return { ok: false, code: activeCheck.code };

  const { head, job } = buildStagedRoleDenyDocs(roleId, change, nowMs, randomBytes(16), randomBytes(16));
  const jobRef = database.collection(ROLE_SWEEP_JOBS_COLLECTION).doc(job.jobId);

  await database.runTransaction(async (tx) => {
    const freshHeadSnap = await tx.get(headRef);
    const freshHead = freshHeadSnap.exists ? (freshHeadSnap.data() as { state?: StagingState }) : null;
    const freshCheck = checkNoActiveStaging(freshHead && freshHead.state ? { state: freshHead.state } : null);
    if (!freshCheck.ok) throw new Error(freshCheck.code);
    tx.set(headRef, { ...head, updatedAt: FieldValue.serverTimestamp() });
    tx.set(jobRef, { ...job, updatedAt: FieldValue.serverTimestamp() });
    // Additions apply immediately; removed permissions stay present in the
    // matrix (protected instead by the staged-deny read-time fail-closed
    // check) until the sweep finalizes and overwrites the row with targetRow.
    tx.set(
      matrixRef,
      { rolePermissions: { [roleId]: interimMatrixRow(change) }, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  });

  return { ok: true, requiresStaging: true, changeId: head.changeId };
}

export const setRolePermissions = onCall({ region: FUNCTIONS_REGION }, async (request) => {
  try {
    return await performSetRolePermissions(db, request.auth as AuthLike, request.data);
  } catch {
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
});
