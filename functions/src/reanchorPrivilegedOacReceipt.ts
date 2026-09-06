/**
 * reanchorPrivilegedOacReceipt — SEC-001 Packet D-1A
 *
 * Re-anchors an existing, still-fresh OAC envelope with a new SRF1 receipt
 * bound to a fresh native device challenge.
 *
 * Requirements:
 * - Authenticated manager caller with non-empty staffId claim
 * - Caller staffId == oac.managerStaffId
 * - Live active manager check (not deleted, authVersion matches token & OAC)
 * - Credential version and revocation epoch still valid (no revocation)
 * - Original OAC still within its signed freshness window (NEVER extends freshness)
 * - SSCP1 purpose strictly == OAC_REANCHOR (3)
 * - SSCP1 intendedStaffId strictly == managerStaffId
 * - Active registered device matching deviceKeyVersion and signature
 * - Produces fresh SRF1-OAC receipt bound to exact sha256(rawOacBytes)
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import type { AuthLike } from './authorityFence';
import {
  decodeSscp1,
  sscp1SignedPrefix,
  SSCP1_PURPOSE_OAC_REANCHOR,
} from './staffSessionAssertionFrame';
import { buildSignedSrf1ForOac } from './oacIssuanceSessionCore';
import { verifyOacEnvelopeSignature } from './oacSigner';
import {
  firestoreSigningKeyReaders,
  loadActiveSigningKey,
  loadAllVerifiableSigningKeys,
  publicKeyFromRaw,
} from './signingKeyLoader';
import { readUserCredential, isUsableForLogin } from './credentialStore';
import { readRevocationEpoch } from './privilegedRevocationState';
import { DEVICE_REGISTRATIONS_COLLECTION } from './deviceEnrollment';
import type { OfflineAuthorizationCapabilityV1 } from './privilegedActionRegistry';
import { verify as ed25519Verify } from 'node:crypto';

export type ReanchorOacResponse =
  | { ok: true; srf1OacBase64: string; oacId: string }
  | { ok: false; code: string };

export async function performReanchorPrivilegedOacReceipt(
  database: Firestore,
  auth: AuthLike,
  requestData: unknown,
  nowMs: number = Date.now(),
): Promise<ReanchorOacResponse> {
  if (!auth?.uid) return { ok: false, code: 'not_authorized' };

  const staffId = auth.token?.staffId as string;
  if (!staffId || typeof staffId !== 'string' || staffId.trim().length === 0) {
    return { ok: false, code: 'not_authorized' };
  }
  const tokenAuthVersion = auth.token?.authVersion;
  if (
    typeof tokenAuthVersion !== 'number' ||
    !Number.isFinite(tokenAuthVersion) ||
    !Number.isInteger(tokenAuthVersion)
  ) {
    return { ok: false, code: 'not_authorized' };
  }

  const raw = (requestData ?? {}) as Record<string, unknown>;
  if (typeof raw.oacEnvelopeBytesBase64 !== 'string' || typeof raw.sscp1Base64 !== 'string') {
    return { ok: false, code: 'invalid_request_shape' };
  }

  let oacBytes: Buffer;
  let oac: OfflineAuthorizationCapabilityV1;
  try {
    oacBytes = Buffer.from(raw.oacEnvelopeBytesBase64, 'base64');
    oac = JSON.parse(oacBytes.toString('utf8')) as OfflineAuthorizationCapabilityV1;
  } catch {
    return { ok: false, code: 'oac_decode_failed' };
  }

  if (
    typeof oac.oacId !== 'string' ||
    typeof oac.managerStaffId !== 'string' ||
    typeof oac.freshnessExpiresAtServerMs !== 'number'
  ) {
    return { ok: false, code: 'oac_malformed' };
  }

  // Caller binding
  if (staffId !== oac.managerStaffId) {
    return { ok: false, code: 'manager_mismatch' };
  }

  // Freshness check — re-anchor NEVER extends freshness
  if (nowMs > oac.freshnessExpiresAtServerMs) {
    return { ok: false, code: 'oac_freshness_expired' };
  }

  // Decode SSCP1
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

  if (sscp1.purpose !== SSCP1_PURPOSE_OAC_REANCHOR) {
    return { ok: false, code: 'sscp1_purpose_mismatch' };
  }
  if (sscp1.intendedStaffId !== staffId) {
    return { ok: false, code: 'sscp1_staff_mismatch' };
  }
  if (sscp1.branchId !== oac.branchId) {
    return { ok: false, code: 'branch_mismatch' };
  }
  if (sscp1.securityDeviceId.toString('hex') !== oac.deviceId) {
    return { ok: false, code: 'device_mismatch' };
  }

  // Verify OAC signature against verifiable signing keys
  const verifiableKeys = await loadAllVerifiableSigningKeys(database, nowMs);
  const signingKey = verifiableKeys.find((k) => k.signingKeyId === oac.signingKeyId);
  if (!signingKey) {
    return { ok: false, code: 'oac_signing_key_not_verifiable' };
  }
  if (!verifyOacEnvelopeSignature(oac, signingKey.publicKey)) {
    return { ok: false, code: 'oac_signature_invalid' };
  }

  // Verify live manager user record
  const userSnap = await database.collection('users').doc(staffId).get();
  if (!userSnap.exists) {
    return { ok: false, code: 'manager_not_found' };
  }
  const userData = (userSnap.data() ?? {}) as DocumentData;
  if (
    userData.isActive !== true ||
    userData.deletedAt != null ||
    (userData.role !== 'manager' && userData.role !== 'admin')
  ) {
    return { ok: false, code: 'manager_inactive_or_not_privileged' };
  }
  if (
    typeof userData.authVersion !== 'number' ||
    !Number.isFinite(userData.authVersion) ||
    !Number.isInteger(userData.authVersion) ||
    userData.authVersion !== tokenAuthVersion ||
    userData.authVersion !== oac.authVersionAtIssue
  ) {
    return { ok: false, code: 'manager_auth_version_mismatch' };
  }

  // Verify manager branch authorization for OAC branch
  const allowedBranchIds = Array.isArray(userData.branchIds) ? userData.branchIds : [];
  const managerBranch = typeof userData.branchId === 'string' ? userData.branchId : undefined;
  const isBranchAllowed =
    managerBranch === oac.branchId ||
    allowedBranchIds.includes(oac.branchId) ||
    allowedBranchIds.includes('ALL');
  if (!isBranchAllowed) {
    return { ok: false, code: 'manager_branch_mismatch' };
  }

  // Verify manager credential status
  const cred = await readUserCredential(database, staffId);
  if (!isUsableForLogin(cred) || cred.credentialVersion !== oac.credentialVersionAtIssue) {
    return { ok: false, code: 'manager_credential_invalid' };
  }

  // Verify revocation epoch
  const currentEpoch = await readRevocationEpoch(database);
  if (currentEpoch !== oac.revocationEpoch) {
    return { ok: false, code: 'revocation_epoch_mismatch' };
  }

  // Verify registered device
  const deviceSnap = await database.collection(DEVICE_REGISTRATIONS_COLLECTION).doc(oac.deviceId).get();
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
    deviceData.deviceKeyVersion <= 0 ||
    deviceData.deviceKeyVersion !== sscp1.deviceKeyVersion
  ) {
    return { ok: false, code: 'device_key_version_mismatch' };
  }
  if (deviceData.branchId !== oac.branchId || sscp1.branchId !== oac.branchId) {
    return { ok: false, code: 'device_branch_mismatch' };
  }
  const registeredDeviceId = (deviceData.securityDeviceIdHex as string | undefined) ?? deviceSnap.id;
  if (registeredDeviceId !== oac.deviceId || sscp1.securityDeviceId.toString('hex') !== oac.deviceId) {
    return { ok: false, code: 'device_mismatch' };
  }

  let sscp1Valid: boolean;
  try {
    const rawPub = Buffer.from(deviceData.validatedDevProofPublicKeyBase64 ?? '', 'base64');
    const devicePubKey = publicKeyFromRaw(rawPub.toString('base64url'));
    sscp1Valid = ed25519Verify(null, sscp1SignedPrefix(sscp1), devicePubKey, sscp1.signature);
  } catch {
    sscp1Valid = false;
  }
  if (!sscp1Valid) {
    return { ok: false, code: 'sscp1_signature_invalid' };
  }

  // Load active signing key to sign fresh SRF1 receipt
  const activeKey = await loadActiveSigningKey(firestoreSigningKeyReaders(database));
  if (!activeKey.ok) {
    return { ok: false, code: 'signing_key_unavailable' };
  }

  const { srf1Bytes } = buildSignedSrf1ForOac(
    sscp1.challengeNonce,
    sscp1.securityDeviceId,
    sscp1.branchId,
    oacBytes,
    nowMs,
    activeKey.signingKeyId,
    activeKey.privateKey,
  );

  return {
    ok: true,
    srf1OacBase64: srf1Bytes.toString('base64'),
    oacId: oac.oacId,
  };
}

export const reanchorPrivilegedOacReceipt = onCall({ region: FUNCTIONS_REGION }, async (request) => {
  try {
    return await performReanchorPrivilegedOacReceipt(db, request.auth as AuthLike, request.data);
  } catch {
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
});
