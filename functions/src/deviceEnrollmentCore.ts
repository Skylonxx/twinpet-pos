/**
 * SEC-001 Packet C-A — pure logic for the device-enrollment lifecycle:
 *
 *   beginDeviceEnrollmentAuthorizationIssuance  (Admin Console, issuer-signed)
 *   completeDeviceEnrollmentAuthorizationIssuance
 *   beginDeviceRegistration                     (native POS terminal)
 *   completeDeviceRegistration
 *
 * See `deviceEnrollment.ts` for the wired callables. No Firestore/crypto side
 * effects here.
 */

import type { DeviceRegistrationPossessionFrameV1 } from './oacFrame';

// --- Enrollment authorization issuance (Admin Console side) ---------------

export const ENROLLMENT_AUTH_DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes — single enrollment-file ceremony window

export type EnrollmentAuthStatus = 'PENDING' | 'ISSUED' | 'CONSUMED' | 'EXPIRED';

export interface EnrollmentAuthorizationRecord {
  enrollmentAuthId: string;
  branchId: string;
  issuerId: string;
  status: EnrollmentAuthStatus;
  createdAtServerMs: number;
  expiresAtServerMs: number;
  issuedAtServerMs: number | null;
  consumedAtServerMs: number | null;
}

const BRANCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidBranchId(branchId: unknown): branchId is string {
  return typeof branchId === 'string' && BRANCH_ID_RE.test(branchId) && branchId !== 'ALL';
}

/** Pure core: build a fresh PENDING enrollment-authorization record. */
export function buildEnrollmentAuthorization(
  branchId: string,
  issuerId: string,
  nowMs: number,
  randomIdBytes: Buffer,
  ttlMs: number = ENROLLMENT_AUTH_DEFAULT_TTL_MS,
): EnrollmentAuthorizationRecord {
  if (!isValidBranchId(branchId)) throw new Error(`invalid branchId: "${branchId}"`);
  if (randomIdBytes.length !== 16) throw new RangeError('randomIdBytes must be 16 bytes (32 lowercase hex chars)');
  return {
    enrollmentAuthId: randomIdBytes.toString('hex'),
    branchId,
    issuerId,
    status: 'PENDING',
    createdAtServerMs: nowMs,
    expiresAtServerMs: nowMs + ttlMs,
    issuedAtServerMs: null,
    consumedAtServerMs: null,
  };
}

export type CompleteIssuanceFailureCode =
  | 'authorization_not_found'
  | 'authorization_issuer_mismatch'
  | 'authorization_wrong_status'
  | 'authorization_expired';

export function checkEnrollmentAuthorizationForIssuance(
  record: EnrollmentAuthorizationRecord | null,
  issuerId: string,
  nowMs: number,
): { ok: true } | { ok: false; code: CompleteIssuanceFailureCode } {
  if (!record) return { ok: false, code: 'authorization_not_found' };
  if (record.issuerId !== issuerId) return { ok: false, code: 'authorization_issuer_mismatch' };
  if (record.status !== 'PENDING') return { ok: false, code: 'authorization_wrong_status' };
  if (nowMs > record.expiresAtServerMs) return { ok: false, code: 'authorization_expired' };
  return { ok: true };
}

// --- Device registration (native POS terminal side) ------------------------

export const REGISTRATION_SESSION_DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface DeviceRegistrationSessionRecord {
  registrationSessionId: string;
  requesterUid: string;
  deviceRegistrationNonce: Buffer;
  status: 'PENDING' | 'CONSUMED';
  createdAtServerMs: number;
  expiresAtServerMs: number;
}

export function buildDeviceRegistrationSession(
  requesterUid: string,
  nowMs: number,
  randomSessionIdBytes: Buffer,
  randomNonceBytes: Buffer,
  ttlMs: number = REGISTRATION_SESSION_DEFAULT_TTL_MS,
): DeviceRegistrationSessionRecord {
  if (randomSessionIdBytes.length !== 16) throw new RangeError('randomSessionIdBytes must be 16 bytes');
  if (randomNonceBytes.length !== 32) throw new RangeError('randomNonceBytes must be 32 bytes');
  return {
    registrationSessionId: randomSessionIdBytes.toString('hex'),
    requesterUid,
    deviceRegistrationNonce: randomNonceBytes,
    status: 'PENDING',
    createdAtServerMs: nowMs,
    expiresAtServerMs: nowMs + ttlMs,
  };
}

export type CompleteRegistrationFailureCode =
  | 'session_not_found'
  | 'session_wrong_owner'
  | 'session_already_consumed'
  | 'session_expired'
  | 'drp1_decode_failed'
  | 'drp1_nonce_mismatch'
  | 'drp1_bad_self_signature'
  | 'enrollment_authorization_not_found'
  | 'enrollment_authorization_wrong_status'
  | 'enrollment_authorization_expired'
  | 'enrollment_authorization_branch_mismatch';

export function checkDeviceRegistrationSession(
  session: DeviceRegistrationSessionRecord | null,
  requesterUid: string,
  nowMs: number,
): { ok: true } | { ok: false; code: CompleteRegistrationFailureCode } {
  if (!session) return { ok: false, code: 'session_not_found' };
  if (session.requesterUid !== requesterUid) return { ok: false, code: 'session_wrong_owner' };
  if (session.status !== 'PENDING') return { ok: false, code: 'session_already_consumed' };
  if (nowMs > session.expiresAtServerMs) return { ok: false, code: 'session_expired' };
  return { ok: true };
}

export function checkDrp1NonceBinding(
  drp1: DeviceRegistrationPossessionFrameV1,
  session: DeviceRegistrationSessionRecord,
): { ok: true } | { ok: false; code: 'drp1_nonce_mismatch' } {
  return drp1.deviceRegistrationNonce.equals(session.deviceRegistrationNonce)
    ? { ok: true }
    : { ok: false, code: 'drp1_nonce_mismatch' };
}

export function checkEnrollmentAuthorizationForRegistration(
  record: EnrollmentAuthorizationRecord | null,
  expectedBranchId: string | null,
  nowMs: number,
): { ok: true } | { ok: false; code: CompleteRegistrationFailureCode } {
  if (!record) return { ok: false, code: 'enrollment_authorization_not_found' };
  if (record.status !== 'ISSUED') return { ok: false, code: 'enrollment_authorization_wrong_status' };
  if (nowMs > record.expiresAtServerMs) return { ok: false, code: 'enrollment_authorization_expired' };
  if (expectedBranchId != null && record.branchId !== expectedBranchId) {
    return { ok: false, code: 'enrollment_authorization_branch_mismatch' };
  }
  return { ok: true };
}

export interface ValidatedDeviceRegistration {
  securityDeviceIdHex: string;
  validatedSecurityDeviceId: string;
  validatedDevProofPublicKeyBase64: string;
  devProofRegistrationNonce: string;
  branchId: string;
  registeredAtServerMs: number;
}

export function buildValidatedDeviceRegistration(
  drp1: DeviceRegistrationPossessionFrameV1,
  branchId: string,
  nowMs: number,
): ValidatedDeviceRegistration {
  return {
    securityDeviceIdHex: drp1.securityDeviceId.toString('hex'),
    validatedSecurityDeviceId: drp1.securityDeviceId.toString('base64'),
    validatedDevProofPublicKeyBase64: drp1.devProofPublicKey.toString('base64'),
    devProofRegistrationNonce: drp1.deviceRegistrationNonce.toString('base64'),
    branchId,
    registeredAtServerMs: nowMs,
  };
}
