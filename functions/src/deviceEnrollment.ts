/**
 * beginDeviceEnrollmentAuthorizationIssuance / completeDeviceEnrollmentAuthorizationIssuance
 * beginDeviceRegistration / completeDeviceRegistration
 *
 * SEC-001 Packet C-A device-enrollment lifecycle (D17 —
 * `DEVICE_ENROLLMENT_CEREMONY = OPTION_A_ENROLLMENT_FILE`). The first pair
 * runs on the Admin Issuance Console side (Admin auth + issuer-signed
 * request) and mints/signs the ENR1 frame embedded in the exported
 * enrollment file. The second pair runs on the native POS terminal side and
 * consumes the DRP1 possession proof the terminal generates from that file,
 * persisting `validatedSecurityDeviceId` / `validatedDevProofPublicKeyBase64`
 * / `devProofRegistrationNonce`.
 */

import { randomBytes, sign as ed25519Sign, verify as ed25519Verify } from 'node:crypto';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import type { AuthLike } from './authorityFence';
import { canonicalJSON } from './credentialStore';
import {
  buildDeviceRegistrationSession,
  buildEnrollmentAuthorization,
  buildValidatedDeviceRegistration,
  checkDeviceRegistrationSession,
  checkDrp1NonceBinding,
  checkEnrollmentAuthorizationForIssuance,
  checkEnrollmentAuthorizationForRegistration,
  type CompleteIssuanceFailureCode,
  type DeviceRegistrationSessionRecord,
  type EnrollmentAuthorizationRecord,
} from './deviceEnrollmentCore';
import { decodeDrp1, drp1SignedPrefix, enr1SignedPrefix, type EnrollmentProofFrameV1 } from './oacFrame';
import { publicKeyFromRaw, loadActiveSigningKey, firestoreSigningKeyReaders } from './signingKeyLoader';
import { verifyIssuerSignedRequest } from './issuerSignatureAuth';

export const ENROLLMENT_AUTHORIZATIONS_COLLECTION = 'privilegedDeviceEnrollmentAuthorizations';
export const REGISTRATION_SESSIONS_COLLECTION = 'privilegedDeviceRegistrationSessions';
export const DEVICE_REGISTRATIONS_COLLECTION = 'privilegedDeviceRegistrations';

async function isLiveAdmin(database: Firestore, uid: string): Promise<boolean> {
  const snap = await database.collection('users').doc(uid).get();
  if (!snap.exists) return false;
  const user = (snap.data() ?? {}) as DocumentData;
  return user.role === 'admin' && user.isActive === true && user.deletedAt == null;
}

function enrollmentAuthFromData(data: DocumentData | undefined): EnrollmentAuthorizationRecord | null {
  if (!data) return null;
  if (
    typeof data.enrollmentAuthId !== 'string' ||
    typeof data.branchId !== 'string' ||
    typeof data.issuerId !== 'string' ||
    typeof data.status !== 'string' ||
    typeof data.createdAtServerMs !== 'number' ||
    typeof data.expiresAtServerMs !== 'number'
  ) {
    return null;
  }
  return {
    enrollmentAuthId: data.enrollmentAuthId,
    branchId: data.branchId,
    issuerId: data.issuerId,
    status: data.status as EnrollmentAuthorizationRecord['status'],
    createdAtServerMs: data.createdAtServerMs,
    expiresAtServerMs: data.expiresAtServerMs,
    issuedAtServerMs: typeof data.issuedAtServerMs === 'number' ? data.issuedAtServerMs : null,
    consumedAtServerMs: typeof data.consumedAtServerMs === 'number' ? data.consumedAtServerMs : null,
  };
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

// --- beginDeviceEnrollmentAuthorizationIssuance -----------------------------

export type BeginIssuanceFailureCode = 'not_authorized' | 'invalid_request_shape' | 'issuer_auth_failed';

export type BeginIssuanceResponse =
  | { ok: true; enrollmentAuthId: string; expiresAtMillis: number }
  | { ok: false; code: BeginIssuanceFailureCode };

export async function performBeginDeviceEnrollmentAuthorizationIssuance(
  database: Firestore,
  auth: AuthLike,
  requestData: unknown,
  nowMs: number = Date.now(),
): Promise<BeginIssuanceResponse> {
  if (!auth?.uid || auth.token?.role !== 'admin' || !(await isLiveAdmin(database, auth.uid))) {
    return { ok: false, code: 'not_authorized' };
  }
  const raw = (requestData ?? {}) as Record<string, unknown>;
  if (
    typeof raw.issuerId !== 'string' ||
    typeof raw.requestId !== 'string' ||
    typeof raw.branchId !== 'string' ||
    typeof raw.signature !== 'string'
  ) {
    return { ok: false, code: 'invalid_request_shape' };
  }

  const payload = Buffer.from(
    canonicalJSON({
      purpose: 'beginDeviceEnrollmentAuthorizationIssuance',
      issuerId: raw.issuerId,
      requestId: raw.requestId,
      branchId: raw.branchId,
    }),
    'utf8',
  );
  let signature: Buffer;
  try {
    signature = Buffer.from(raw.signature, 'base64');
  } catch {
    return { ok: false, code: 'invalid_request_shape' };
  }
  const issuerCheck = await verifyIssuerSignedRequest(database, {
    issuerId: raw.issuerId,
    requestId: raw.requestId,
    purpose: 'beginDeviceEnrollmentAuthorizationIssuance',
    payload,
    signature,
    nowMs,
  });
  if (!issuerCheck.ok) return { ok: false, code: 'issuer_auth_failed' };

  let record: EnrollmentAuthorizationRecord;
  try {
    record = buildEnrollmentAuthorization(raw.branchId, raw.issuerId, nowMs, randomBytes(16));
  } catch {
    return { ok: false, code: 'invalid_request_shape' };
  }

  await database.collection(ENROLLMENT_AUTHORIZATIONS_COLLECTION).doc(record.enrollmentAuthId).set({
    ...record,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { ok: true, enrollmentAuthId: record.enrollmentAuthId, expiresAtMillis: record.expiresAtServerMs };
}

// --- completeDeviceEnrollmentAuthorizationIssuance --------------------------

export type CompleteIssuanceResponse =
  | { ok: true; enr1Base64: string }
  | {
      ok: false;
      code: 'not_authorized' | 'invalid_request_shape' | 'issuer_auth_failed' | 'signing_key_unavailable' | CompleteIssuanceFailureCode;
    };

export async function performCompleteDeviceEnrollmentAuthorizationIssuance(
  database: Firestore,
  auth: AuthLike,
  requestData: unknown,
  nowMs: number = Date.now(),
): Promise<CompleteIssuanceResponse> {
  if (!auth?.uid || auth.token?.role !== 'admin' || !(await isLiveAdmin(database, auth.uid))) {
    return { ok: false, code: 'not_authorized' };
  }
  const raw = (requestData ?? {}) as Record<string, unknown>;
  if (
    typeof raw.issuerId !== 'string' ||
    typeof raw.requestId !== 'string' ||
    typeof raw.enrollmentAuthId !== 'string' ||
    typeof raw.signature !== 'string'
  ) {
    return { ok: false, code: 'invalid_request_shape' };
  }

  const payload = Buffer.from(
    canonicalJSON({
      purpose: 'completeDeviceEnrollmentAuthorizationIssuance',
      issuerId: raw.issuerId,
      requestId: raw.requestId,
      enrollmentAuthId: raw.enrollmentAuthId,
    }),
    'utf8',
  );
  let signature: Buffer;
  try {
    signature = Buffer.from(raw.signature, 'base64');
  } catch {
    return { ok: false, code: 'invalid_request_shape' };
  }
  const issuerCheck = await verifyIssuerSignedRequest(database, {
    issuerId: raw.issuerId,
    requestId: raw.requestId,
    purpose: 'completeDeviceEnrollmentAuthorizationIssuance',
    payload,
    signature,
    nowMs,
  });
  if (!issuerCheck.ok) return { ok: false, code: 'issuer_auth_failed' };

  const ref = database.collection(ENROLLMENT_AUTHORIZATIONS_COLLECTION).doc(raw.enrollmentAuthId);
  const snap = await ref.get();
  const record = enrollmentAuthFromData(snap.exists ? snap.data() : undefined);
  const check = checkEnrollmentAuthorizationForIssuance(record, raw.issuerId, nowMs);
  if (!check.ok) return { ok: false, code: check.code };

  const activeKey = await loadActiveSigningKey(firestoreSigningKeyReaders(database));
  if (!activeKey.ok) return { ok: false, code: 'signing_key_unavailable' };

  const unsignedEnr1: Omit<EnrollmentProofFrameV1, 'signature'> = {
    enrollmentAuthId: record!.enrollmentAuthId,
    branchId: record!.branchId,
    issuedAtServerMs: nowMs,
    expiresAtServerMs: record!.expiresAtServerMs,
    issuerId: record!.issuerId,
  };
  const enr1Signature = ed25519Sign(null, enr1SignedPrefix(unsignedEnr1), activeKey.privateKey);
  const enr1 = Buffer.concat([enr1SignedPrefix(unsignedEnr1), enr1Signature]);

  await database.runTransaction(async (tx) => {
    const freshSnap = await tx.get(ref);
    const fresh = enrollmentAuthFromData(freshSnap.exists ? freshSnap.data() : undefined);
    const freshCheck = checkEnrollmentAuthorizationForIssuance(fresh, raw.issuerId as string, nowMs);
    if (!freshCheck.ok) throw new Error(freshCheck.code);
    tx.update(ref, { status: 'ISSUED', issuedAtServerMs: nowMs, issuedAt: FieldValue.serverTimestamp() });
  });

  return { ok: true, enr1Base64: enr1.toString('base64') };
}

// --- beginDeviceRegistration -------------------------------------------------

export type BeginRegistrationResponse =
  | { ok: true; registrationSessionId: string; deviceRegistrationNonceBase64: string; expiresAtMillis: number }
  | { ok: false; code: 'not_authorized' };

export async function performBeginDeviceRegistration(
  database: Firestore,
  auth: AuthLike,
  nowMs: number = Date.now(),
): Promise<BeginRegistrationResponse> {
  if (!auth?.uid) return { ok: false, code: 'not_authorized' };
  const session = buildDeviceRegistrationSession(auth.uid, nowMs, randomBytes(16), randomBytes(32));
  await database.collection(REGISTRATION_SESSIONS_COLLECTION).doc(session.registrationSessionId).set({
    registrationSessionId: session.registrationSessionId,
    requesterUid: session.requesterUid,
    deviceRegistrationNonceBase64: session.deviceRegistrationNonce.toString('base64'),
    status: session.status,
    createdAtServerMs: session.createdAtServerMs,
    expiresAtServerMs: session.expiresAtServerMs,
    createdAt: FieldValue.serverTimestamp(),
  });
  return {
    ok: true,
    registrationSessionId: session.registrationSessionId,
    deviceRegistrationNonceBase64: session.deviceRegistrationNonce.toString('base64'),
    expiresAtMillis: session.expiresAtServerMs,
  };
}

// --- completeDeviceRegistration ----------------------------------------------

export type CompleteRegistrationResponse =
  | { ok: true; securityDeviceIdHex: string; branchId: string }
  | { ok: false; code: string };

export async function performCompleteDeviceRegistration(
  database: Firestore,
  auth: AuthLike,
  requestData: unknown,
  nowMs: number = Date.now(),
): Promise<CompleteRegistrationResponse> {
  if (!auth?.uid) return { ok: false, code: 'not_authorized' };
  const raw = (requestData ?? {}) as Record<string, unknown>;
  if (typeof raw.registrationSessionId !== 'string' || typeof raw.drp1Base64 !== 'string') {
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

  const authRef = database.collection(ENROLLMENT_AUTHORIZATIONS_COLLECTION).doc(drp1.enrollmentAuthId);
  const authSnap = await authRef.get();
  const authRecord = enrollmentAuthFromData(authSnap.exists ? authSnap.data() : undefined);
  const authCheck = checkEnrollmentAuthorizationForRegistration(authRecord, null, nowMs);
  if (!authCheck.ok) return { ok: false, code: authCheck.code };

  const registration = buildValidatedDeviceRegistration(drp1, authRecord!.branchId, nowMs);
  const deviceRef = database.collection(DEVICE_REGISTRATIONS_COLLECTION).doc(registration.securityDeviceIdHex);

  await database.runTransaction(async (tx) => {
    const freshAuthSnap = await tx.get(authRef);
    const freshAuth = enrollmentAuthFromData(freshAuthSnap.exists ? freshAuthSnap.data() : undefined);
    const freshAuthCheck = checkEnrollmentAuthorizationForRegistration(freshAuth, null, nowMs);
    if (!freshAuthCheck.ok) throw new Error(freshAuthCheck.code);
    const freshSessionSnap = await tx.get(sessionRef);
    const freshSession = sessionFromData(freshSessionSnap.exists ? freshSessionSnap.data() : undefined);
    const freshSessionCheck = checkDeviceRegistrationSession(freshSession, auth.uid as string, nowMs);
    if (!freshSessionCheck.ok) throw new Error(freshSessionCheck.code);

    tx.update(authRef, { status: 'CONSUMED', consumedAtServerMs: nowMs, consumedAt: FieldValue.serverTimestamp() });
    tx.update(sessionRef, { status: 'CONSUMED' });
    tx.set(deviceRef, { ...registration, registeredAt: FieldValue.serverTimestamp() });
  });

  return { ok: true, securityDeviceIdHex: registration.securityDeviceIdHex, branchId: registration.branchId };
}

export const beginDeviceEnrollmentAuthorizationIssuance = onCall({ region: FUNCTIONS_REGION }, async (request) => {
  try {
    return await performBeginDeviceEnrollmentAuthorizationIssuance(db, request.auth as AuthLike, request.data);
  } catch {
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
});

export const completeDeviceEnrollmentAuthorizationIssuance = onCall({ region: FUNCTIONS_REGION }, async (request) => {
  try {
    return await performCompleteDeviceEnrollmentAuthorizationIssuance(db, request.auth as AuthLike, request.data);
  } catch {
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
});

export const beginDeviceRegistration = onCall({ region: FUNCTIONS_REGION }, async (request) => {
  try {
    return await performBeginDeviceRegistration(db, request.auth as AuthLike);
  } catch {
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
});

export const completeDeviceRegistration = onCall({ region: FUNCTIONS_REGION }, async (request) => {
  try {
    return await performCompleteDeviceRegistration(db, request.auth as AuthLike, request.data);
  } catch {
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
});
