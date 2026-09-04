/**
 * SEC-001 Packet C-B — issuePrivilegedLockoutClear
 *
 * Admin-only entrypoint for minting a replay-safe signed LockoutClearTokenFrameV1 (LCT1)
 * bound to an exact securityDeviceId, managerStaffId, and CSPRNG lockoutId generation.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import type { AuthLike } from './authorityFence';
import { DEVICE_REGISTRATIONS_COLLECTION } from './deviceEnrollment';
import {
  buildAndSignLct1,
  buildLct1Response,
  validateIssueLockoutClearRequest,
  type IssuePrivilegedLockoutClearResponse,
} from './issuePrivilegedLockoutClearCore';
import { firestoreSigningKeyReaders, loadActiveSigningKey } from './signingKeyLoader';

async function isLiveAdmin(database: Firestore, uid: string): Promise<boolean> {
  const snap = await database.collection('users').doc(uid).get();
  if (!snap.exists) return false;
  const user = (snap.data() ?? {}) as DocumentData;
  return user.role === 'admin' && user.isActive === true && user.deletedAt == null;
}

export async function performIssuePrivilegedLockoutClear(
  database: Firestore,
  auth: AuthLike,
  requestData: unknown,
  nowMs: number = Date.now(),
): Promise<IssuePrivilegedLockoutClearResponse> {
  // Admin role only
  if (!auth?.uid || auth.token?.role !== 'admin' || !(await isLiveAdmin(database, auth.uid))) {
    return { ok: false, code: 'not_authorized' };
  }

  const validation = validateIssueLockoutClearRequest(requestData);
  if (!validation.ok) {
    return { ok: false, code: validation.code };
  }
  const { securityDeviceIdHex, managerStaffId, lockoutIdHex } = validation.value;

  // Device registration check
  const deviceSnap = await database.collection(DEVICE_REGISTRATIONS_COLLECTION).doc(securityDeviceIdHex).get();
  if (!deviceSnap.exists) {
    return { ok: false, code: 'device_not_registered' };
  }
  const deviceData = (deviceSnap.data() ?? {}) as DocumentData;
  if (
    deviceData.securityDeviceIdHex !== securityDeviceIdHex ||
    typeof deviceData.branchId !== 'string' ||
    !deviceData.branchId ||
    deviceData.branchId === 'ALL' ||
    (deviceData.registeredAtServerMs == null && deviceData.registeredAt == null)
  ) {
    return { ok: false, code: 'device_not_registered' };
  }
  if (
    deviceData.status === 'INACTIVE' ||
    deviceData.status === 'REVOKED' ||
    deviceData.status === 'inactive' ||
    deviceData.status === 'revoked' ||
    deviceData.isActive === false
  ) {
    return { ok: false, code: 'device_inactive' };
  }

  // Manager exists and active status check
  const managerSnap = await database.collection('users').doc(managerStaffId).get();
  if (!managerSnap.exists) {
    return { ok: false, code: 'manager_not_found' };
  }
  const managerData = (managerSnap.data() ?? {}) as DocumentData;
  if (managerData.role !== 'manager' && managerData.role !== 'admin') {
    return { ok: false, code: 'manager_not_found' };
  }
  if (
    managerData.isActive !== true ||
    managerData.deletedAt != null ||
    managerData.disabled === true
  ) {
    return { ok: false, code: 'manager_inactive' };
  }

  // Active signing key
  const signingKey = await loadActiveSigningKey(firestoreSigningKeyReaders(database));
  if (!signingKey.ok) {
    throw new HttpsError('failed-precondition', `No active OAC signing key configured: ${signingKey.code}`);
  }

  const frame = buildAndSignLct1({
    securityDeviceIdHex,
    managerStaffId,
    lockoutIdHex,
    signingKeyId: signingKey.signingKeyId,
    privateKey: signingKey.privateKey,
    nowMs,
  });

  return buildLct1Response(frame);
}

export const issuePrivilegedLockoutClear = onCall(
  { region: FUNCTIONS_REGION },
  async (request): Promise<IssuePrivilegedLockoutClearResponse> => {
    try {
      const response = await performIssuePrivilegedLockoutClear(db, request.auth, request.data);
      return response;
    } catch (err: unknown) {
      if (err instanceof HttpsError) throw err;
      const message = err instanceof Error ? err.message : 'internal error';
      throw new HttpsError('internal', message);
    }
  },
);
