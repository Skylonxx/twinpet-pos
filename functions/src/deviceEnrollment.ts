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
import type { DocumentData, DocumentReference, Firestore } from 'firebase-admin/firestore';
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
  checkExistingDeviceForInitialRegistration,
  buildSignedEfr1,
  completionRequestDigest,
  effectiveEnrollmentGenerationId,
  COMPLETION_REQUEST_SHA256_RE,
  type CompleteIssuanceFailureCode,
  type DeviceRegistrationSessionRecord,
  type EnrollmentAuthorizationRecord,
} from './deviceEnrollmentCore';
import { decodeDrp1, drp1SignedPrefix, enr1SignedPrefix, encodeOks1, type EnrollmentProofFrameV1 } from './oacFrame';
import { publicKeyFromRaw, loadActiveSigningKey, loadAllVerifiableSigningKeys, loadRootSigningKey, firestoreSigningKeyReaders } from './signingKeyLoader';
import { verifyIssuerSignedRequest } from './issuerSignatureAuth';
import { readRevocationEpoch } from './privilegedRevocationState';
import { buildOacKeysetManifest } from './oacKeysetManifestCore';
import { EFR1_OP_INITIAL_ENROLLMENT, isCanonicalIdentifier } from './staffSessionAssertionFrame';

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
  | {
      ok: true;
      securityDeviceIdHex: string;
      branchId: string;
      deviceKeyVersion: number;
      acceptedPublicKeyBase64: string;
      serverFinalizationReceiptBase64: string;
      oks1Base64?: string;
    }
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
  const sessionData = sessionSnap.exists ? sessionSnap.data() : undefined;
  const session = sessionFromData(sessionData);
  if (session?.status === 'CONSUMED') {
    return performConsumedCompletionReplay(database, auth.uid, raw, session, sessionData!, nowMs);
  }
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

  const activeKey = await loadActiveSigningKey(firestoreSigningKeyReaders(database));
  if (!activeKey.ok) return { ok: false, code: 'signing_key_unavailable' };

  // F3 / OPTION_A_PRECOMPUTE_BEFORE_CONSUME — every fallible operation needed
  // to build the success response runs BEFORE the one-time state is consumed.
  // Previously the keyset/root/manifest/receipt work ran after the commit, so
  // a root-key, keyset or receipt failure returned ok:false with the
  // authorization and session already CONSUMED and the device already ACTIVE —
  // a half-valid durable record the caller could never recover from. All of
  // the work below depends only on pre-transaction inputs (`registration` is
  // built above and is exactly what the transaction stores), so hoisting it
  // cannot desynchronize the receipt from the persisted record.
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

  const enrollmentGenId = effectiveEnrollmentGenerationId(raw.enrollmentGenerationId);
  // Precomputed before consume: persisted atomically with the session's
  // consumption so a lost response can later be recovered by exact replay.
  let completionRequestSha256: string;
  try {
    completionRequestSha256 = completionRequestDigest(raw.registrationSessionId, drp1Bytes, enrollmentGenId);
  } catch {
    return { ok: false, code: 'invalid_request_shape' };
  }

  const { efr1Bytes } = buildSignedEfr1(
    EFR1_OP_INITIAL_ENROLLMENT,
    enrollmentGenId,
    registration.securityDeviceIdHex,
    registration.deviceKeyVersion,
    drp1.devProofPublicKey,
    drp1.deviceRegistrationNonce,
    registration.branchId,
    nowMs,
    activeKey.signingKeyId,
    activeKey.privateKey,
  );

  // --- Durable commit. Nothing below this point may fail. ---
  try {
    await database.runTransaction(async (tx) => {
      const freshDeviceSnap = await tx.get(deviceRef);
      if (freshDeviceSnap.exists) {
        const existingCheck = checkExistingDeviceForInitialRegistration(freshDeviceSnap.data());
        if (!existingCheck.ok) throw new Error(existingCheck.code);
      }
      const freshAuthSnap = await tx.get(authRef);
      const freshAuth = enrollmentAuthFromData(freshAuthSnap.exists ? freshAuthSnap.data() : undefined);
      const freshAuthCheck = checkEnrollmentAuthorizationForRegistration(freshAuth, null, nowMs);
      if (!freshAuthCheck.ok) throw new Error(freshAuthCheck.code);
      const freshSessionSnap = await tx.get(sessionRef);
      const freshSession = sessionFromData(freshSessionSnap.exists ? freshSessionSnap.data() : undefined);
      const freshSessionCheck = checkDeviceRegistrationSession(freshSession, auth.uid as string, nowMs);
      if (!freshSessionCheck.ok) throw new Error(freshSessionCheck.code);

      tx.update(authRef, { status: 'CONSUMED', consumedAtServerMs: nowMs, consumedAt: FieldValue.serverTimestamp() });
      tx.update(sessionRef, { status: 'CONSUMED', completionRequestSha256 });
      tx.set(deviceRef, { ...registration, registeredAt: FieldValue.serverTimestamp() });
    });
  } catch (err: unknown) {
    return adjudicateRejectedCompletionTransaction(database, auth.uid, raw, sessionRef, err, nowMs);
  }

  return {
    ok: true,
    securityDeviceIdHex: registration.securityDeviceIdHex,
    branchId: registration.branchId,
    deviceKeyVersion: registration.deviceKeyVersion,
    acceptedPublicKeyBase64: drp1.devProofPublicKey.toString('base64'),
    serverFinalizationReceiptBase64: efr1Bytes.toString('base64'),
    oks1Base64,
  };
}

// --- completeDeviceRegistration: rejected-transaction outcome adjudication ----

/** Thrown (never returned) when a completion's durable outcome cannot be proven. */
const COMPLETION_OUTCOME_UNKNOWN = 'completion_outcome_unknown';

/**
 * A rejected `runTransaction` does NOT prove that nothing committed: the
 * commit may have been applied and only its acknowledgement lost, and a
 * retry then observes the attempt's own writes (ACTIVE device / CONSUMED
 * session) and rejects. Returning a structured `{ok:false}` there would let
 * the client discard its only completion intent. So the outcome is
 * adjudicated from a fresh read of the SAME session:
 *
 *  - CONSUMED → possibly our commit: exact consumed replay (called directly —
 *    it never re-enters this transaction path). Success is returned; any
 *    replay failure is thrown as ambiguity, because on this first-call path
 *    a structured rejection would release the client's intent.
 *  - exactly PENDING, same session and owner → no consume happened: the
 *    ORIGINAL semantic error keeps its existing structured mapping.
 *  - anything else (read failure, missing, malformed, other status) →
 *    ambiguous: thrown, so the callable fails as internal and the client
 *    keeps its durable intent.
 *
 * Read-only: nothing is mutated here.
 */
async function adjudicateRejectedCompletionTransaction(
  database: Firestore,
  requesterUid: string,
  raw: Record<string, unknown>,
  sessionRef: DocumentReference,
  transactionError: unknown,
  nowMs: number,
): Promise<CompleteRegistrationResponse> {
  let rereadData: DocumentData | undefined;
  try {
    const snap = await sessionRef.get();
    rereadData = snap.exists ? snap.data() : undefined;
  } catch {
    throw new Error(COMPLETION_OUTCOME_UNKNOWN);
  }
  const reread = sessionFromData(rereadData);
  if (reread == null || reread.registrationSessionId !== raw.registrationSessionId) {
    throw new Error(COMPLETION_OUTCOME_UNKNOWN);
  }

  if (reread.status === 'CONSUMED') {
    const replay = await performConsumedCompletionReplay(database, requesterUid, raw, reread, rereadData!, nowMs);
    if (replay.ok) return replay;
    throw new Error(COMPLETION_OUTCOME_UNKNOWN);
  }
  if (reread.status === 'PENDING' && reread.requesterUid === requesterUid) {
    const msg = transactionError instanceof Error ? transactionError.message : String(transactionError);
    return { ok: false, code: msg };
  }
  throw new Error(COMPLETION_OUTCOME_UNKNOWN);
}

// --- completeDeviceRegistration: consumed-session exact replay ---------------

/**
 * Response-loss recovery for `completeDeviceRegistration` (SEC-001
 * Gemini-178/180). The first call committed — session and authorization
 * CONSUMED, device ACTIVE at version 1 — but the caller never received the
 * response. The caller replays the EXACT same request; this branch proves it
 * is the same requester, the same request (stored digest), and that the
 * device is still exactly as that request committed it, then recomputes a
 * fresh OKS1 + INITIAL_ENROLLMENT EFR1 for the SAME committed bindings.
 *
 * Read-only: no transaction, no write, no timestamp, no audit. Deliberately
 * NOT bounded by the session's original 10-minute expiry (restart recovery),
 * and deliberately does NOT use the initial-registration "device must not
 * exist" gate — the committed device is exactly what it must find.
 */
async function performConsumedCompletionReplay(
  database: Firestore,
  requesterUid: string,
  raw: Record<string, unknown>,
  session: DeviceRegistrationSessionRecord,
  sessionData: DocumentData,
  nowMs: number,
): Promise<CompleteRegistrationResponse> {
  if (session.requesterUid !== requesterUid) return { ok: false, code: 'session_wrong_owner' };

  const drp1Bytes = Buffer.from(raw.drp1Base64 as string, 'base64');
  const decoded = decodeDrp1(drp1Bytes);
  if (!decoded.ok) return { ok: false, code: 'drp1_decode_failed' };
  const drp1 = decoded.value;

  const nonceCheck = checkDrp1NonceBinding(drp1, session);
  if (!nonceCheck.ok) return { ok: false, code: nonceCheck.code };

  let selfSignatureValid: boolean;
  try {
    const devicePublicKey = publicKeyFromRaw(drp1.devProofPublicKey.toString('base64url'));
    selfSignatureValid = ed25519Verify(null, drp1SignedPrefix(drp1), devicePublicKey, drp1.signature);
  } catch {
    selfSignatureValid = false;
  }
  if (!selfSignatureValid) return { ok: false, code: 'drp1_bad_self_signature' };

  const enrollmentGenId = effectiveEnrollmentGenerationId(raw.enrollmentGenerationId);
  let replayDigest: string;
  try {
    replayDigest = completionRequestDigest(raw.registrationSessionId as string, drp1Bytes, enrollmentGenId);
  } catch {
    return { ok: false, code: 'invalid_request_shape' };
  }
  const storedDigest = sessionData.completionRequestSha256;
  if (typeof storedDigest !== 'string' || !COMPLETION_REQUEST_SHA256_RE.test(storedDigest)) {
    return { ok: false, code: 'legacy_session_unrecoverable' };
  }
  if (storedDigest !== replayDigest) return { ok: false, code: 'completion_replay_mismatch' };

  const securityDeviceIdHex = drp1.securityDeviceId.toString('hex');
  const acceptedPublicKeyBase64 = drp1.devProofPublicKey.toString('base64');

  const deviceSnap = await database.collection(DEVICE_REGISTRATIONS_COLLECTION).doc(securityDeviceIdHex).get();
  const device = deviceSnap.exists ? ((deviceSnap.data() ?? {}) as DocumentData) : undefined;
  if (
    !device ||
    device.status !== 'ACTIVE' ||
    device.deviceKeyVersion !== 1 ||
    device.validatedDevProofPublicKeyBase64 !== acceptedPublicKeyBase64 ||
    device.devProofRegistrationNonce !== session.deviceRegistrationNonce.toString('base64') ||
    typeof device.branchId !== 'string' ||
    !isCanonicalIdentifier(device.branchId) ||
    device.reEnrolledAtServerMs !== undefined
  ) {
    return { ok: false, code: 'device_state_changed' };
  }
  const branchId: string = device.branchId;

  const authSnap = await database.collection(ENROLLMENT_AUTHORIZATIONS_COLLECTION).doc(drp1.enrollmentAuthId).get();
  const authRecord = enrollmentAuthFromData(authSnap.exists ? authSnap.data() : undefined);
  if (!authRecord || authRecord.status !== 'CONSUMED' || authRecord.branchId !== branchId) {
    return { ok: false, code: 'device_state_changed' };
  }

  const activeKey = await loadActiveSigningKey(firestoreSigningKeyReaders(database));
  if (!activeKey.ok) return { ok: false, code: 'signing_key_unavailable' };
  const [verifiableKeys, revocationEpoch, rootKey] = await Promise.all([
    loadAllVerifiableSigningKeys(database, nowMs),
    readRevocationEpoch(database),
    loadRootSigningKey(),
  ]);
  if (!rootKey.ok) return { ok: false, code: rootKey.code };
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
  if (!manifestRes.ok) return { ok: false, code: manifestRes.code };

  const { efr1Bytes } = buildSignedEfr1(
    EFR1_OP_INITIAL_ENROLLMENT,
    enrollmentGenId,
    securityDeviceIdHex,
    1,
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
    deviceKeyVersion: 1,
    acceptedPublicKeyBase64,
    serverFinalizationReceiptBase64: efr1Bytes.toString('base64'),
    oks1Base64: encodeOks1(manifestRes.manifest).toString('base64'),
  };
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

export const completeDeviceRegistration = onCall({ region: FUNCTIONS_REGION, secrets: ['OAC_ROOT_PRIVATE_KEY_BASE64URL'] }, async (request) => {
  try {
    return await performCompleteDeviceRegistration(db, request.auth as AuthLike, request.data);
  } catch {
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
});
