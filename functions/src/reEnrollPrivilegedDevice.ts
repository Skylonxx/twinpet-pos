/**
 * reEnrollPrivilegedDevice — SEC-001 Packet D-1A
 *
 * Dedicated authorized online path for explicit device key rotation/re-enrollment.
 * Requires:
 * - Live active Admin caller (Firebase custom claim staffId matching live user doc)
 * - Fresh device registration session with cryptographic nonce binding
 * - Fresh DRP1 possession proof signed by the new device key
 * - Expected current deviceKeyVersion matching live registration
 * - Atomic increment of deviceKeyVersion in Firestore transaction
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import type { AuthLike } from './authorityFence';
import {
  checkDeviceRegistrationSession,
  checkDrp1NonceBinding,
  buildSignedEfr1,
  type DeviceRegistrationSessionRecord,
} from './deviceEnrollmentCore';
import { decodeDrp1, drp1SignedPrefix, encodeOks1 } from './oacFrame';
import { EFR1_OP_RE_ENROLLMENT, isCanonicalIdentifier } from './staffSessionAssertionFrame';
import {
  firestoreSigningKeyReaders,
  loadActiveSigningKey,
  loadAllVerifiableSigningKeys,
  loadRootSigningKey,
  publicKeyFromRaw,
} from './signingKeyLoader';
import { buildOacKeysetManifest } from './oacKeysetManifestCore';
import { readRevocationEpoch } from './privilegedRevocationState';
import { verify as ed25519Verify } from 'node:crypto';

export const REGISTRATION_SESSIONS_COLLECTION = 'privilegedDeviceRegistrationSessions';
export const DEVICE_REGISTRATIONS_COLLECTION = 'privilegedDeviceRegistrations';
export const MAX_DEVICE_KEY_VERSION = 4294967295;

async function isLiveAdmin(
  database: Firestore,
  staffId: string,
  tokenAuthVersion: number,
): Promise<boolean> {
  const snap = await database.collection('users').doc(staffId).get();
  if (!snap.exists) return false;
  const user = (snap.data() ?? {}) as DocumentData;
  if (user.role !== 'admin' || user.isActive !== true || user.deletedAt != null) {
    return false;
  }
  if (
    typeof user.authVersion !== 'number' ||
    !Number.isFinite(user.authVersion) ||
    !Number.isInteger(user.authVersion) ||
    user.authVersion !== tokenAuthVersion
  ) {
    return false;
  }
  return true;
}

function sessionFromData(data: DocumentData | undefined): DeviceRegistrationSessionRecord | null {
  if (!data) return null;
  if (
    typeof data.registrationSessionId !== 'string' ||
    typeof data.requesterUid !== 'string' ||
    typeof data.deviceRegistrationNonceBase64 !== 'string' ||
    typeof data.status !== 'string' ||
    typeof data.createdAtServerMs !== 'number' ||
    typeof data.expiresAtServerMs !== 'number'
  ) {
    return null;
  }
  return {
    registrationSessionId: data.registrationSessionId,
    requesterUid: data.requesterUid,
    deviceRegistrationNonce: Buffer.from(data.deviceRegistrationNonceBase64, 'base64'),
    status: data.status as DeviceRegistrationSessionRecord['status'],
    createdAtServerMs: data.createdAtServerMs,
    expiresAtServerMs: data.expiresAtServerMs,
  };
}

export type ReEnrollPrivilegedDeviceResponse =
  | {
      ok: true;
      securityDeviceIdHex: string;
      branchId: string;
      newDeviceKeyVersion: number;
      acceptedPublicKeyBase64: string;
      serverFinalizationReceiptBase64: string;
      oks1Base64?: string;
    }
  | { ok: false; code: string };

export async function performReEnrollPrivilegedDevice(
  database: Firestore,
  auth: AuthLike,
  requestData: unknown,
  nowMs: number = Date.now(),
): Promise<ReEnrollPrivilegedDeviceResponse> {
  if (!auth?.uid) return { ok: false, code: 'not_authorized' };

  const staffId = auth.token?.staffId;
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

  const adminOk = await isLiveAdmin(database, staffId, tokenAuthVersion);
  if (!adminOk) return { ok: false, code: 'not_authorized' };

  const raw = (requestData ?? {}) as Record<string, unknown>;
  if (
    typeof raw.registrationSessionId !== 'string' ||
    typeof raw.drp1Base64 !== 'string' ||
    typeof raw.expectedDeviceKeyVersion !== 'number' ||
    !Number.isFinite(raw.expectedDeviceKeyVersion) ||
    !Number.isSafeInteger(raw.expectedDeviceKeyVersion) ||
    raw.expectedDeviceKeyVersion <= 0 ||
    raw.expectedDeviceKeyVersion > MAX_DEVICE_KEY_VERSION
  ) {
    return { ok: false, code: 'invalid_request_shape' };
  }

  const sessionRef = database.collection(REGISTRATION_SESSIONS_COLLECTION).doc(raw.registrationSessionId);
  const sessionSnap = await sessionRef.get();
  const session = sessionFromData(sessionSnap.exists ? sessionSnap.data() : undefined);
  const sessionCheck = checkDeviceRegistrationSession(session, auth.uid, nowMs);
  if (!sessionCheck.ok) return { ok: false, code: sessionCheck.code };

  let drp1Bytes: Buffer;
  try {
    drp1Bytes = Buffer.from(raw.drp1Base64, 'base64');
  } catch {
    return { ok: false, code: 'drp1_decode_failed' };
  }
  const decoded = decodeDrp1(drp1Bytes);
  if (!decoded.ok) return { ok: false, code: 'drp1_decode_failed' };
  const drp1 = decoded.value;

  const nonceCheck = checkDrp1NonceBinding(drp1, session!);
  if (!nonceCheck.ok) return { ok: false, code: nonceCheck.code };

  let selfSignatureValid: boolean;
  try {
    const devicePublicKey = publicKeyFromRaw(drp1.devProofPublicKey.toString('base64url'));
    selfSignatureValid = ed25519Verify(null, drp1SignedPrefix(drp1), devicePublicKey, drp1.signature);
  } catch {
    selfSignatureValid = false;
  }
  if (!selfSignatureValid) return { ok: false, code: 'drp1_bad_self_signature' };

  const securityDeviceIdHex = drp1.securityDeviceId.toString('hex');
  const deviceRef = database.collection(DEVICE_REGISTRATIONS_COLLECTION).doc(securityDeviceIdHex);

  const activeKey = await loadActiveSigningKey(firestoreSigningKeyReaders(database));
  if (!activeKey.ok) return { ok: false, code: 'signing_key_unavailable' };

  let newDeviceKeyVersion = 0;
  let branchId = '';
  try {
    await database.runTransaction(async (tx) => {
      const freshDeviceSnap = await tx.get(deviceRef);
      if (!freshDeviceSnap.exists) {
        throw new Error('device_not_found');
      }
      const deviceData = (freshDeviceSnap.data() ?? {}) as DocumentData;
      if (deviceData.status !== 'ACTIVE') {
        throw new Error('device_not_active');
      }
      if (
        typeof deviceData.deviceKeyVersion !== 'number' ||
        !Number.isFinite(deviceData.deviceKeyVersion) ||
        !Number.isSafeInteger(deviceData.deviceKeyVersion) ||
        deviceData.deviceKeyVersion <= 0 ||
        deviceData.deviceKeyVersion > MAX_DEVICE_KEY_VERSION
      ) {
        throw new Error('device_key_version_invalid');
      }
      if (deviceData.deviceKeyVersion !== raw.expectedDeviceKeyVersion) {
        throw new Error('device_key_version_mismatch');
      }
      if (deviceData.deviceKeyVersion >= MAX_DEVICE_KEY_VERSION) {
        throw new Error('device_key_version_overflow');
      }
      const nextVersion = deviceData.deviceKeyVersion + 1;
      if (!Number.isSafeInteger(nextVersion) || nextVersion <= deviceData.deviceKeyVersion || nextVersion > MAX_DEVICE_KEY_VERSION) {
        throw new Error('device_key_version_overflow');
      }

      const freshSessionSnap = await tx.get(sessionRef);
      const freshSession = sessionFromData(freshSessionSnap.exists ? freshSessionSnap.data() : undefined);
      const freshSessionCheck = checkDeviceRegistrationSession(freshSession, auth.uid as string, nowMs);
      if (!freshSessionCheck.ok) throw new Error(freshSessionCheck.code);

      if (typeof deviceData.branchId !== 'string' || !isCanonicalIdentifier(deviceData.branchId)) {
        throw new Error('device_branch_invalid');
      }
      branchId = deviceData.branchId;
      newDeviceKeyVersion = nextVersion;
      tx.update(sessionRef, { status: 'CONSUMED' });
      tx.update(deviceRef, {
        validatedDevProofPublicKeyBase64: drp1.devProofPublicKey.toString('base64'),
        devProofRegistrationNonce: drp1.deviceRegistrationNonce.toString('base64'),
        deviceKeyVersion: newDeviceKeyVersion,
        status: 'ACTIVE',
        reEnrolledAtServerMs: nowMs,
        reEnrolledByStaffId: staffId,
        reEnrolledAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: msg };
  }

  const [verifiableKeys, revocationEpoch, rootKey] = await Promise.all([
    loadAllVerifiableSigningKeys(database, nowMs),
    readRevocationEpoch(database),
    loadRootSigningKey(),
  ]);

  if (!rootKey.ok) {
    return { ok: false, code: rootKey.code };
  }

  const manifestRes = buildOacKeysetManifest(
    verifiableKeys.map((k) => ({
      signingKeyId: k.signingKeyId,
      publicKeyBase64Url: k.publicKeyBase64Url,
      status: k.status,
      verifyUntilServerMs: k.verifyUntilServerMs,
    })),
    revocationEpoch,
    nowMs,
    activeKey.signingKeyId,
    rootKey.rootPrivateKey,
  );
  if (!manifestRes.ok) {
    return { ok: false, code: manifestRes.code };
  }
  const oks1Base64 = encodeOks1(manifestRes.manifest).toString('base64');

  const enrollmentGenId =
    typeof raw.enrollmentGenerationId === 'string' && /^[0-9a-f]{32}$/i.test(raw.enrollmentGenerationId)
      ? raw.enrollmentGenerationId
      : '00000000000000000000000000000000';

  const { efr1Bytes } = buildSignedEfr1(
    EFR1_OP_RE_ENROLLMENT,
    enrollmentGenId,
    securityDeviceIdHex,
    newDeviceKeyVersion,
    drp1.devProofPublicKey,
    drp1.deviceRegistrationNonce,
    branchId,
    nowMs,
    activeKey.signingKeyId,
    activeKey.privateKey,
  );

  return {
    ok: true,
    securityDeviceIdHex,
    branchId,
    newDeviceKeyVersion,
    acceptedPublicKeyBase64: drp1.devProofPublicKey.toString('base64'),
    serverFinalizationReceiptBase64: efr1Bytes.toString('base64'),
    oks1Base64,
  };
}

export const reEnrollPrivilegedDevice = onCall({ region: FUNCTIONS_REGION }, async (request) => {
  try {
    return await performReEnrollPrivilegedDevice(db, request.auth as AuthLike, request.data);
  } catch {
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
});
