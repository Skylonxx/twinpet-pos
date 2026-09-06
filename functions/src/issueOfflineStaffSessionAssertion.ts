/**
 * issueOfflineStaffSessionAssertion — SEC-001 Packet D-1A
 *
 * Stage-2 PIN-login offline staff session issuance.
 * Requires:
 * - Refreshed Firebase custom claims with non-empty trusted staffId
 * - Live user record check (active, not deleted, authVersion match, branch match)
 * - Valid SSCP1 challenge possession proof with purpose == LOGIN (1)
 * - Active registered device matching SSCP1 deviceKeyVersion, branchId, and signature
 * - Mints 24h absolute SSA1 frame and bound SRF1 receipt signed with active OAC/staff signing key
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import type { AuthLike } from './authorityFence';
import {
  decodeSscp1,
  sscp1SignedPrefix,
  SSCP1_PURPOSE_LOGIN,
} from './staffSessionAssertionFrame';
import {
  buildSignedSsa1,
  buildSignedSrf1ForSsa1,
  validateCallerStaffIdentity,
  validateDeviceForSession,
  type LiveStaffUserRecord,
  type LiveDeviceRecord,
} from './staffSessionIssuerCore';
import { firestoreSigningKeyReaders, loadActiveSigningKey, publicKeyFromRaw } from './signingKeyLoader';
import { verify as ed25519Verify } from 'node:crypto';

export const DEVICE_REGISTRATIONS_COLLECTION = 'privilegedDeviceRegistrations';

export type IssueOfflineStaffSessionResponse =
  | { ok: true; ssa1Base64: string; srf1Base64: string }
  | { ok: false; code: string };

export async function performIssueOfflineStaffSessionAssertion(
  database: Firestore,
  auth: AuthLike,
  requestData: unknown,
  nowMs: number = Date.now(),
): Promise<IssueOfflineStaffSessionResponse> {
  if (!auth?.uid) return { ok: false, code: 'not_authorized' };

  // Never use anonymous Firebase UID as staff authority:
  const staffId = auth.token?.staffId as string;
  if (!staffId || typeof staffId !== 'string' || staffId.trim().length === 0) {
    return { ok: false, code: 'staff_identity_claim_missing' };
  }

  const raw = (requestData ?? {}) as Record<string, unknown>;
  if (typeof raw.sscp1Base64 !== 'string') {
    return { ok: false, code: 'invalid_request_shape' };
  }

  let sscp1Bytes: Buffer;
  try {
    sscp1Bytes = Buffer.from(raw.sscp1Base64, 'base64');
  } catch {
    return { ok: false, code: 'sscp1_decode_failed' };
  }
  const decodedProof = decodeSscp1(sscp1Bytes);
  if (!decodedProof.ok) {
    return { ok: false, code: 'sscp1_decode_failed' };
  }
  const sscp1 = decodedProof.value;

  // Validate live user record
  const tokenAuthVersion =
    typeof auth.token?.authVersion === 'number' &&
    Number.isFinite(auth.token.authVersion) &&
    Number.isInteger(auth.token.authVersion)
      ? auth.token.authVersion
      : undefined;
  if (tokenAuthVersion === undefined) {
    return { ok: false, code: 'staff_auth_version_mismatch' };
  }

  const userSnap = await database.collection('users').doc(staffId).get();
  if (!userSnap.exists) {
    return { ok: false, code: 'staff_not_found' };
  }
  const userData = (userSnap.data() ?? {}) as DocumentData;
  if (
    typeof userData.authVersion !== 'number' ||
    !Number.isFinite(userData.authVersion) ||
    !Number.isInteger(userData.authVersion)
  ) {
    return { ok: false, code: 'staff_auth_version_mismatch' };
  }

  const liveUser: LiveStaffUserRecord = {
    staffId,
    isActive: userData.isActive === true,
    deletedAt: userData.deletedAt ?? null,
    authVersion: userData.authVersion,
    branchId: typeof userData.branchId === 'string' ? userData.branchId : undefined,
    branchIds: Array.isArray(userData.branchIds) ? userData.branchIds : undefined,
    role: typeof userData.role === 'string' ? userData.role : undefined,
  };

  const staffCheck = validateCallerStaffIdentity(liveUser, staffId, tokenAuthVersion, sscp1.branchId);
  if (!staffCheck.ok) {
    return { ok: false, code: staffCheck.code };
  }

  // Validate device registration
  const securityDeviceIdHex = sscp1.securityDeviceId.toString('hex');
  const deviceSnap = await database.collection(DEVICE_REGISTRATIONS_COLLECTION).doc(securityDeviceIdHex).get();
  if (!deviceSnap.exists) {
    return { ok: false, code: 'device_not_found' };
  }
  const deviceData = (deviceSnap.data() ?? {}) as DocumentData;
  if (deviceData.status !== 'ACTIVE') {
    return { ok: false, code: 'device_not_active' };
  }
  if (
    typeof deviceData.deviceKeyVersion !== 'number' ||
    !Number.isFinite(deviceData.deviceKeyVersion) ||
    !Number.isInteger(deviceData.deviceKeyVersion) ||
    deviceData.deviceKeyVersion <= 0
  ) {
    return { ok: false, code: 'device_key_version_mismatch' };
  }

  const liveDevice: LiveDeviceRecord = {
    securityDeviceIdHex,
    status: deviceData.status,
    deviceKeyVersion: deviceData.deviceKeyVersion,
    branchId: typeof deviceData.branchId === 'string' ? deviceData.branchId : '',
    validatedDevProofPublicKeyBase64: typeof deviceData.validatedDevProofPublicKeyBase64 === 'string' ? deviceData.validatedDevProofPublicKeyBase64 : '',
  };

  const deviceCheck = validateDeviceForSession(liveDevice, sscp1, SSCP1_PURPOSE_LOGIN, staffId);
  if (!deviceCheck.ok) {
    return { ok: false, code: deviceCheck.code };
  }

  // Verify SSCP1 signature with registered device public key
  let sscp1Valid: boolean;
  try {
    const rawPub = Buffer.from(liveDevice.validatedDevProofPublicKeyBase64, 'base64');
    const devicePubKey = publicKeyFromRaw(rawPub.toString('base64url'));
    sscp1Valid = ed25519Verify(null, sscp1SignedPrefix(sscp1), devicePubKey, sscp1.signature);
  } catch {
    sscp1Valid = false;
  }
  if (!sscp1Valid) {
    return { ok: false, code: 'sscp1_signature_invalid' };
  }

  // Load active signing key
  const activeKey = await loadActiveSigningKey(firestoreSigningKeyReaders(database));
  if (!activeKey.ok) {
    return { ok: false, code: 'signing_key_unavailable' };
  }

  // Mint signed SSA1 & signed SRF1
  const { ssa1Bytes } = buildSignedSsa1(
    staffId,
    sscp1.securityDeviceId,
    sscp1.branchId,
    liveUser.authVersion,
    nowMs,
    activeKey.signingKeyId,
    activeKey.privateKey,
  );

  const { srf1Bytes } = buildSignedSrf1ForSsa1(
    sscp1.challengeNonce,
    sscp1.securityDeviceId,
    sscp1.branchId,
    ssa1Bytes,
    nowMs,
    activeKey.signingKeyId,
    activeKey.privateKey,
  );

  return {
    ok: true,
    ssa1Base64: ssa1Bytes.toString('base64'),
    srf1Base64: srf1Bytes.toString('base64'),
  };
}

export const issueOfflineStaffSessionAssertion = onCall({ region: FUNCTIONS_REGION }, async (request) => {
  try {
    return await performIssueOfflineStaffSessionAssertion(db, request.auth as AuthLike, request.data);
  } catch {
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
});
