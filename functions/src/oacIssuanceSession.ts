/**
 * beginPrivilegedOacIssuanceSession / completePrivilegedOacIssuanceSession
 *
 * SEC-001 Packet C-A — online ceremony where a live manager/admin, at a
 * device that has already completed `completeDeviceRegistration`, obtains a
 * signed offline authorization capability (OAC) bound to that exact device.
 * PIN never leaves the device: the native side computes the Argon2id
 * verifier locally and submits only the verifier/salt/pepper-commitment
 * (PIN1 frame); the manager's *online* PIN is what this callable verifies,
 * exactly like requestManagerApproval, gated additionally by `canProvisionOac`
 * (PIN6-only — D13/legacy-PIN4 forbidden).
 */

import { randomBytes, randomUUID, verify as ed25519Verify } from 'node:crypto';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import bcrypt from 'bcryptjs';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import { evaluateFreshPrivilegedAuthority, type AuthLike } from './authorityFence';
import { canonicalJSON, isUsableForLogin, readUserCredential } from './credentialStore';
import { canProvisionOac, derivePinMigrationState } from './pinPolicy';
import {
  buildOacIssuanceSession,
  buildSignedSrf1ForOac,
  buildUnsignedOac,
  checkOacIssuanceSession,
  checkTupleBinding,
  pin1Tuple,
  ptp1Tuple,
  type OacIssuanceSessionRecord,
} from './oacIssuanceSessionCore';
import { decodePin1, decodePtp1, pin1SignedPrefix, ptp1SignedPrefix } from './oacFrame';
import { publicKeyFromRaw, loadActiveSigningKey, firestoreSigningKeyReaders } from './signingKeyLoader';
import { signOacEnvelope } from './oacSigner';
import { readRevocationEpoch } from './privilegedRevocationState';
import { DEVICE_REGISTRATIONS_COLLECTION } from './deviceEnrollment';
// F5 — the canonical strict device-record parser. Imported, never relocated:
// it lives in the currently-deployed adjudicator core, and moving it would put
// a live function's source out of step with its deployed bytes.
import { parseDeviceRegistration } from './adjudicateOfflinePrivilegedActionCore';

const OAC_SESSIONS_COLLECTION = 'privilegedOacIssuanceSessions';
const APPROVAL_DUMMY_PIN_HASH = '$2b$10$WCOTRHGYk1RxxHdHMy9.guo3rg259b4w/opYiC13GSmPmCmPJVYwO';

async function isLiveManagerOrAdmin(database: Firestore, staffId: string): Promise<'manager' | 'admin' | null> {
  const snap = await database.collection('users').doc(staffId).get();
  if (!snap.exists) return null;
  const user = (snap.data() ?? {}) as DocumentData;
  if (user.isActive !== true || user.deletedAt != null) return null;
  return user.role === 'manager' || user.role === 'admin' ? user.role : null;
}

function sessionFromData(data: DocumentData | undefined): OacIssuanceSessionRecord | null {
  if (!data) return null;
  if (
    typeof data.sessionId !== 'string' ||
    typeof data.managerStaffId !== 'string' ||
    typeof data.securityDeviceIdHex !== 'string' ||
    typeof data.branchId !== 'string' ||
    typeof data.nonceBase64 !== 'string' ||
    typeof data.status !== 'string' ||
    typeof data.createdAtServerMs !== 'number' ||
    typeof data.expiresAtServerMs !== 'number'
  ) {
    return null;
  }
  return {
    sessionId: data.sessionId,
    managerStaffId: data.managerStaffId,
    securityDeviceIdHex: data.securityDeviceIdHex,
    branchId: data.branchId,
    nonce: Buffer.from(data.nonceBase64, 'base64'),
    status: data.status as OacIssuanceSessionRecord['status'],
    createdAtServerMs: data.createdAtServerMs,
    expiresAtServerMs: data.expiresAtServerMs,
  };
}

// --- beginPrivilegedOacIssuanceSession --------------------------------------

export type BeginOacSessionFailureCode =
  | 'not_authorized'
  | 'device_not_registered'
  | 'device_not_active'
  | 'device_branch_mismatch';

export type BeginOacSessionResponse =
  | { ok: true; sessionId: string; nonceBase64: string; expiresAtMillis: number }
  | { ok: false; code: BeginOacSessionFailureCode };

export async function performBeginPrivilegedOacIssuanceSession(
  database: Firestore,
  auth: AuthLike,
  requestData: unknown,
  nowMs: number = Date.now(),
): Promise<BeginOacSessionResponse> {
  const freshness = await evaluateFreshPrivilegedAuthority(database, auth);
  if (!freshness.ok) return { ok: false, code: 'not_authorized' };
  const role = await isLiveManagerOrAdmin(database, freshness.staffId);
  if (!role) return { ok: false, code: 'not_authorized' };

  const raw = (requestData ?? {}) as { securityDeviceIdHex?: unknown };
  if (typeof raw.securityDeviceIdHex !== 'string' || !/^[0-9a-f]{32}$/.test(raw.securityDeviceIdHex)) {
    return { ok: false, code: 'device_not_registered' };
  }
  const deviceSnap = await database.collection(DEVICE_REGISTRATIONS_COLLECTION).doc(raw.securityDeviceIdHex).get();
  if (!deviceSnap.exists) return { ok: false, code: 'device_not_registered' };
  // F5 — strict canonical parse: a malformed, legacy or status-less record is
  // not a device we will mint an offline capability for. Issuance is a
  // privileged capability boundary and must fail closed at provisioning, not
  // only at redemption.
  const device = parseDeviceRegistration(deviceSnap.data());
  if (!device) return { ok: false, code: 'device_not_registered' };
  if (device.status !== 'ACTIVE') return { ok: false, code: 'device_not_active' };

  const userSnap = await database.collection('users').doc(freshness.staffId).get();
  const branchIds: string[] = Array.isArray(userSnap.data()?.branchIds) ? (userSnap.data()!.branchIds as string[]) : [];
  if (!branchIds.includes('ALL') && !branchIds.includes(device.branchId)) {
    return { ok: false, code: 'device_branch_mismatch' };
  }

  const session = buildOacIssuanceSession(
    freshness.staffId,
    raw.securityDeviceIdHex,
    device.branchId,
    nowMs,
    randomBytes(16),
    randomBytes(32),
  );
  await database.collection(OAC_SESSIONS_COLLECTION).doc(session.sessionId).set({
    sessionId: session.sessionId,
    managerStaffId: session.managerStaffId,
    securityDeviceIdHex: session.securityDeviceIdHex,
    branchId: session.branchId,
    nonceBase64: session.nonce.toString('base64'),
    status: session.status,
    createdAtServerMs: session.createdAtServerMs,
    expiresAtServerMs: session.expiresAtServerMs,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { ok: true, sessionId: session.sessionId, nonceBase64: session.nonce.toString('base64'), expiresAtMillis: session.expiresAtServerMs };
}

// --- completePrivilegedOacIssuanceSession -----------------------------------

export type CompleteOacSessionFailureCode =
  | 'not_authorized'
  | 'invalid_request_shape'
  | 'session_not_found'
  | 'session_wrong_owner'
  | 'session_already_consumed'
  | 'session_expired'
  | 'ptp1_decode_failed'
  | 'pin1_decode_failed'
  | 'ptp1_bad_self_signature'
  | 'pin1_bad_self_signature'
  | 'tuple_nonce_mismatch'
  | 'tuple_session_mismatch'
  | 'tuple_device_mismatch'
  | 'tuple_manager_mismatch'
  | 'tuple_device_key_mismatch'
  | 'device_not_registered'
  | 'device_not_active'
  | 'device_branch_mismatch'
  | 'invalid_pin'
  | 'oac_provision_forbidden_legacy_pin4'
  | 'signing_key_unavailable';

export type CompleteOacSessionResponse =
  | {
      ok: true;
      oac: ReturnType<typeof signOacEnvelope>;
      oacEnvelopeBytesBase64: string;
      srf1OacBase64: string;
    }
  | { ok: false; code: CompleteOacSessionFailureCode };

/**
 * Carries an expected completion failure out of the one-winner consume
 * transaction. The losing side of a concurrent completion is an *expected*
 * outcome and must surface as the existing `{ok:false, code}` contract rather
 * than a generic `HttpsError('internal')` from the onCall wrapper.
 */
class CompleteOacSessionTransactionError extends Error {
  constructor(public readonly code: CompleteOacSessionFailureCode) {
    super(code);
    this.name = 'CompleteOacSessionTransactionError';
  }
}

export async function performCompletePrivilegedOacIssuanceSession(
  database: Firestore,
  auth: AuthLike,
  requestData: unknown,
  nowMs: number = Date.now(),
): Promise<CompleteOacSessionResponse> {
  const freshness = await evaluateFreshPrivilegedAuthority(database, auth);
  if (!freshness.ok) return { ok: false, code: 'not_authorized' };
  const role = await isLiveManagerOrAdmin(database, freshness.staffId);
  if (!role) return { ok: false, code: 'not_authorized' };

  const raw = (requestData ?? {}) as Record<string, unknown>;
  if (
    typeof raw.sessionId !== 'string' ||
    typeof raw.pin !== 'string' ||
    typeof raw.ptp1Base64 !== 'string' ||
    typeof raw.pin1Base64 !== 'string'
  ) {
    return { ok: false, code: 'invalid_request_shape' };
  }

  const sessionRef = database.collection(OAC_SESSIONS_COLLECTION).doc(raw.sessionId);
  const sessionSnap = await sessionRef.get();
  const session = sessionFromData(sessionSnap.exists ? sessionSnap.data() : undefined);
  const sessionCheck = checkOacIssuanceSession(session, freshness.staffId, nowMs);
  if (!sessionCheck.ok) return { ok: false, code: sessionCheck.code };

  const decodedPtp1 = decodePtp1(Buffer.from(raw.ptp1Base64, 'base64'));
  if (!decodedPtp1.ok) return { ok: false, code: 'ptp1_decode_failed' };
  const decodedPin1 = decodePin1(Buffer.from(raw.pin1Base64, 'base64'));
  if (!decodedPin1.ok) return { ok: false, code: 'pin1_decode_failed' };
  const ptp1 = decodedPtp1.value;
  const pin1 = decodedPin1.value;

  const deviceRef = database.collection(DEVICE_REGISTRATIONS_COLLECTION).doc(session!.securityDeviceIdHex);
  const deviceSnap = await deviceRef.get();
  if (!deviceSnap.exists) return { ok: false, code: 'device_not_registered' };
  // F5 — advisory strict parse. The deciding re-validation happens inside the
  // consume transaction below, where the device document is in the read set.
  const device = parseDeviceRegistration(deviceSnap.data());
  if (!device) return { ok: false, code: 'device_not_registered' };
  if (device.status !== 'ACTIVE') return { ok: false, code: 'device_not_active' };
  if (device.branchId !== session!.branchId) return { ok: false, code: 'device_branch_mismatch' };
  const registeredDevProofPublicKey = Buffer.from(device.validatedDevProofPublicKeyBase64, 'base64');

  const ptp1Check = checkTupleBinding(ptp1Tuple(ptp1), session!, registeredDevProofPublicKey);
  if (!ptp1Check.ok) return { ok: false, code: ptp1Check.code };
  const pin1Check = checkTupleBinding(pin1Tuple(pin1), session!, registeredDevProofPublicKey);
  if (!pin1Check.ok) return { ok: false, code: pin1Check.code };

  let ptp1SignatureValid: boolean;
  try {
    const devicePublicKey = publicKeyFromRaw(ptp1.devProofPublicKey.toString('base64url'));
    ptp1SignatureValid = ed25519Verify(null, ptp1SignedPrefix(ptp1), devicePublicKey, ptp1.signature);
  } catch {
    ptp1SignatureValid = false;
  }
  if (!ptp1SignatureValid) return { ok: false, code: 'ptp1_bad_self_signature' };

  let pin1SignatureValid: boolean;
  try {
    const devicePublicKey = publicKeyFromRaw(pin1.devProofPublicKey.toString('base64url'));
    pin1SignatureValid = ed25519Verify(null, pin1SignedPrefix(pin1), devicePublicKey, pin1.signature);
  } catch {
    pin1SignatureValid = false;
  }
  if (!pin1SignatureValid) return { ok: false, code: 'pin1_bad_self_signature' };

  const cred = await readUserCredential(database, freshness.staffId);
  const compareHash = isUsableForLogin(cred) ? cred.pinHash : APPROVAL_DUMMY_PIN_HASH;
  const compareOk = await bcrypt.compare(raw.pin, compareHash);
  if (!compareOk || !isUsableForLogin(cred)) return { ok: false, code: 'invalid_pin' };

  const classification = derivePinMigrationState({
    persistedCredentialState: cred.credentialState,
    disabled: cred.disabled,
    presentedPin: raw.pin,
  });
  if (!canProvisionOac(classification)) return { ok: false, code: 'oac_provision_forbidden_legacy_pin4' };

  const activeKey = await loadActiveSigningKey(firestoreSigningKeyReaders(database));
  if (!activeKey.ok) return { ok: false, code: 'signing_key_unavailable' };
  const revocationEpoch = await readRevocationEpoch(database);

  const unsigned = buildUnsignedOac(
    randomUUID(),
    pin1,
    role,
    session!.branchId,
    session!.securityDeviceIdHex,
    freshness.authVersion,
    cred.credentialVersion,
    revocationEpoch,
    nowMs,
  );
  const oac = signOacEnvelope(
    { ...unsigned, allowedActions: ['VOID_PENDING_SALE', 'VOID_SETTLED_SALE'], schemaVersion: 1, verifierAlgo: 'argon2id' },
    activeKey.signingKeyId,
    activeKey.privateKey,
  );

  const oacBytes = Buffer.from(canonicalJSON(oac), 'utf8');
  const oacEnvelopeBytesBase64 = oacBytes.toString('base64');

  const { srf1Bytes } = buildSignedSrf1ForOac(
    session!.nonce,
    ptp1.securityDeviceId,
    session!.branchId,
    oacBytes,
    nowMs,
    activeKey.signingKeyId,
    activeKey.privateKey,
  );
  const srf1OacBase64 = srf1Bytes.toString('base64');

  // --- F6 one-winner consume + F5 completion-time revalidation -------------
  //
  // The OAC and SRF1 above are already built and signed, deliberately: if the
  // consume were committed first, a signing failure would burn a one-shot
  // session and return no capability — Finding 3's shape all over again. The
  // loser of a concurrent completion discards its envelope in memory and
  // returns `session_already_consumed`, so at most one OAC is ever emitted.
  // Nothing about the OAC is persisted.
  //
  // The device document is in the transaction read set so a revocation, branch
  // change, deletion or key rotation landing between the advisory checks and
  // the commit forces a retry and is observed.
  try {
    await database.runTransaction(async (tx) => {
      const freshSessionSnap = await tx.get(sessionRef);
      const freshSession = sessionFromData(freshSessionSnap.exists ? freshSessionSnap.data() : undefined);
      const freshSessionCheck = checkOacIssuanceSession(freshSession, freshness.staffId, nowMs);
      if (!freshSessionCheck.ok) throw new CompleteOacSessionTransactionError(freshSessionCheck.code);

      const freshDeviceSnap = await tx.get(deviceRef);
      if (!freshDeviceSnap.exists) throw new CompleteOacSessionTransactionError('device_not_registered');
      const freshDevice = parseDeviceRegistration(freshDeviceSnap.data());
      if (!freshDevice) throw new CompleteOacSessionTransactionError('device_not_registered');
      if (freshDevice.status !== 'ACTIVE') throw new CompleteOacSessionTransactionError('device_not_active');
      if (freshDevice.branchId !== freshSession!.branchId) {
        throw new CompleteOacSessionTransactionError('device_branch_mismatch');
      }
      // The signed PTP1/PIN1 tuples were bound to this exact key; a
      // re-enrollment between the advisory read and the commit must not be
      // able to slip a different device key under an already-signed proof.
      if (freshDevice.validatedDevProofPublicKeyBase64 !== device.validatedDevProofPublicKeyBase64) {
        throw new CompleteOacSessionTransactionError('tuple_device_key_mismatch');
      }

      tx.update(sessionRef, {
        status: 'CONSUMED',
        consumedAtServerMs: nowMs,
        consumedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (err: unknown) {
    if (err instanceof CompleteOacSessionTransactionError) return { ok: false, code: err.code };
    throw err;
  }

  return { ok: true, oac, oacEnvelopeBytesBase64, srf1OacBase64 };
}

export const beginPrivilegedOacIssuanceSession = onCall({ region: FUNCTIONS_REGION }, async (request) => {
  try {
    return await performBeginPrivilegedOacIssuanceSession(db, request.auth as AuthLike, request.data);
  } catch {
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
});

export const completePrivilegedOacIssuanceSession = onCall({ region: FUNCTIONS_REGION }, async (request) => {
  try {
    return await performCompletePrivilegedOacIssuanceSession(db, request.auth as AuthLike, request.data);
  } catch {
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
});
