/**
 * SEC-001 Packet C-A — pure logic for `beginPrivilegedOacIssuanceSession` /
 * `completePrivilegedOacIssuanceSession`: the online ceremony where a live
 * manager/admin, at a device that has already completed
 * `completeDeviceRegistration`, provisions a signed offline authorization
 * capability (OAC) bound to that exact device.
 *
 * No Firestore/crypto side effects here; see `oacIssuanceSession.ts`.
 */

import type { ProvisioningTupleProofFrameV1, PinBindingFrameV1 } from './oacFrame';

export const OAC_SESSION_DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const OAC_FRESHNESS_TTL_MS = 24 * 60 * 60 * 1000; // D3: OAC freshness 24h

export interface OacIssuanceSessionRecord {
  sessionId: string;
  managerStaffId: string;
  securityDeviceIdHex: string;
  branchId: string;
  nonce: Buffer;
  status: 'PENDING' | 'CONSUMED';
  createdAtServerMs: number;
  expiresAtServerMs: number;
}

export function buildOacIssuanceSession(
  managerStaffId: string,
  securityDeviceIdHex: string,
  branchId: string,
  nowMs: number,
  randomSessionIdBytes: Buffer,
  randomNonceBytes: Buffer,
  ttlMs: number = OAC_SESSION_DEFAULT_TTL_MS,
): OacIssuanceSessionRecord {
  if (randomSessionIdBytes.length !== 16) throw new RangeError('randomSessionIdBytes must be 16 bytes');
  if (randomNonceBytes.length !== 32) throw new RangeError('randomNonceBytes must be 32 bytes');
  return {
    sessionId: randomSessionIdBytes.toString('hex'),
    managerStaffId,
    securityDeviceIdHex,
    branchId,
    nonce: randomNonceBytes,
    status: 'PENDING',
    createdAtServerMs: nowMs,
    expiresAtServerMs: nowMs + ttlMs,
  };
}

export type SessionCheckFailureCode =
  | 'session_not_found'
  | 'session_wrong_owner'
  | 'session_already_consumed'
  | 'session_expired';

export function checkOacIssuanceSession(
  session: OacIssuanceSessionRecord | null,
  managerStaffId: string,
  nowMs: number,
): { ok: true } | { ok: false; code: SessionCheckFailureCode } {
  if (!session) return { ok: false, code: 'session_not_found' };
  if (session.managerStaffId !== managerStaffId) return { ok: false, code: 'session_wrong_owner' };
  if (session.status !== 'PENDING') return { ok: false, code: 'session_already_consumed' };
  if (nowMs > session.expiresAtServerMs) return { ok: false, code: 'session_expired' };
  return { ok: true };
}

export type TupleBindingFailureCode =
  | 'tuple_nonce_mismatch'
  | 'tuple_session_mismatch'
  | 'tuple_device_mismatch'
  | 'tuple_manager_mismatch'
  | 'tuple_device_key_mismatch';

/** Checks a PTP1 or PIN1 frame is bound to exactly this session and device. */
export function checkTupleBinding(
  tuple: { securityDeviceId: Buffer; oacIssuanceSessionId: string; managerStaffId: string; nonce?: Buffer; devProofPublicKey: Buffer },
  session: OacIssuanceSessionRecord,
  registeredDevProofPublicKey: Buffer,
): { ok: true } | { ok: false; code: TupleBindingFailureCode } {
  if (tuple.nonce != null && !tuple.nonce.equals(session.nonce)) return { ok: false, code: 'tuple_nonce_mismatch' };
  if (tuple.oacIssuanceSessionId !== session.sessionId) return { ok: false, code: 'tuple_session_mismatch' };
  if (tuple.securityDeviceId.toString('hex') !== session.securityDeviceIdHex) {
    return { ok: false, code: 'tuple_device_mismatch' };
  }
  if (tuple.managerStaffId !== session.managerStaffId) return { ok: false, code: 'tuple_manager_mismatch' };
  if (!tuple.devProofPublicKey.equals(registeredDevProofPublicKey)) return { ok: false, code: 'tuple_device_key_mismatch' };
  return { ok: true };
}

export interface UnsignedOacFields {
  oacId: string;
  managerStaffId: string;
  managerRole: 'manager' | 'admin';
  branchId: string;
  deviceId: string;
  authVersionAtIssue: number;
  credentialVersionAtIssue: number;
  revocationEpoch: number;
  issuedAtServerMs: number;
  freshnessExpiresAtServerMs: number;
  verifierParams: { m: number; t: number; p: number; saltLen: number; hashLen: number };
  verifierSalt: string;
  verifier: string;
  pepperCommitment: string;
}

export function buildUnsignedOac(
  oacId: string,
  pin1: PinBindingFrameV1,
  managerRole: 'manager' | 'admin',
  branchId: string,
  deviceId: string,
  authVersionAtIssue: number,
  credentialVersionAtIssue: number,
  revocationEpoch: number,
  nowMs: number,
): UnsignedOacFields {
  return {
    oacId,
    managerStaffId: pin1.managerStaffId,
    managerRole,
    branchId,
    deviceId,
    authVersionAtIssue,
    credentialVersionAtIssue,
    revocationEpoch,
    issuedAtServerMs: nowMs,
    freshnessExpiresAtServerMs: nowMs + OAC_FRESHNESS_TTL_MS,
    verifierParams: { m: pin1.m, t: pin1.t, p: pin1.p, saltLen: pin1.verifierSalt.length, hashLen: pin1.verifier.length },
    verifierSalt: pin1.verifierSalt.toString('base64'),
    verifier: pin1.verifier.toString('base64'),
    pepperCommitment: pin1.pepperCommitment.toString('base64'),
  };
}

export function ptp1Tuple(ptp1: ProvisioningTupleProofFrameV1) {
  return {
    securityDeviceId: ptp1.securityDeviceId,
    oacIssuanceSessionId: ptp1.oacIssuanceSessionId,
    managerStaffId: ptp1.managerStaffId,
    nonce: ptp1.nonce,
    devProofPublicKey: ptp1.devProofPublicKey,
  };
}

export function pin1Tuple(pin1: PinBindingFrameV1) {
  return {
    securityDeviceId: pin1.securityDeviceId,
    oacIssuanceSessionId: pin1.oacIssuanceSessionId,
    managerStaffId: pin1.managerStaffId,
    devProofPublicKey: pin1.devProofPublicKey,
  };
}
