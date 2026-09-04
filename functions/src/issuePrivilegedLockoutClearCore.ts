/**
 * SEC-001 Packet C-B — Core logic for issuing Lockout Clear Token (LCT1).
 *
 * Pure validation, signing, and frame construction. Zero direct Firestore
 * mutations or HTTP handling.
 */

import { randomBytes, sign as ed25519Sign, type KeyObject } from 'node:crypto';
import {
  encodeLct1,
  isCanonicalIdentifier,
  lct1SignedPrefix,
  type LockoutClearTokenFrameV1,
} from './oacFrame';

export const LOCKOUT_CLEAR_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes narrow window

export type IssuePrivilegedLockoutClearFailureCode =
  | 'not_authorized'
  | 'invalid_request_shape'
  | 'device_not_registered'
  | 'device_inactive'
  | 'manager_not_found'
  | 'manager_inactive';

export interface IssuePrivilegedLockoutClearRequest {
  securityDeviceIdHex: string;
  managerStaffId: string;
  lockoutIdHex: string;
}

export type IssuePrivilegedLockoutClearResponse =
  | {
      ok: true;
      lct1Base64: string;
      securityDeviceIdHex: string;
      managerStaffId: string;
      lockoutIdHex: string;
      issuedAtServerMs: number;
      expiresAtServerMs: number;
    }
  | {
      ok: false;
      code: IssuePrivilegedLockoutClearFailureCode;
    };

const HEX32_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

export function validateIssueLockoutClearRequest(
  input: unknown,
): { ok: true; value: IssuePrivilegedLockoutClearRequest } | { ok: false; code: 'invalid_request_shape' } {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'invalid_request_shape' };
  }
  const raw = input as Record<string, unknown>;
  if (
    typeof raw.securityDeviceIdHex !== 'string' ||
    !HEX32_RE.test(raw.securityDeviceIdHex) ||
    typeof raw.managerStaffId !== 'string' ||
    !isCanonicalIdentifier(raw.managerStaffId) ||
    typeof raw.lockoutIdHex !== 'string' ||
    !HEX64_RE.test(raw.lockoutIdHex)
  ) {
    return { ok: false, code: 'invalid_request_shape' };
  }

  return {
    ok: true,
    value: {
      securityDeviceIdHex: raw.securityDeviceIdHex,
      managerStaffId: raw.managerStaffId,
      lockoutIdHex: raw.lockoutIdHex,
    },
  };
}

export function buildAndSignLct1(params: {
  securityDeviceIdHex: string;
  managerStaffId: string;
  lockoutIdHex: string;
  signingKeyId: string;
  privateKey: KeyObject;
  nowMs?: number;
  nonce?: Buffer;
}): LockoutClearTokenFrameV1 {
  const nowMs = params.nowMs ?? Date.now();
  const expiresAtServerMs = nowMs + LOCKOUT_CLEAR_TOKEN_TTL_MS;
  const securityDeviceId = Buffer.from(params.securityDeviceIdHex, 'hex');
  const lockoutId = Buffer.from(params.lockoutIdHex, 'hex');
  const tokenNonce = params.nonce ?? randomBytes(32);

  const unsigned: Omit<LockoutClearTokenFrameV1, 'signature'> = {
    securityDeviceId,
    managerStaffId: params.managerStaffId,
    lockoutId,
    issuedAtServerMs: nowMs,
    expiresAtServerMs,
    tokenNonce,
    signingKeyId: params.signingKeyId,
  };

  const payload = lct1SignedPrefix(unsigned);
  const signature = ed25519Sign(null, payload, params.privateKey);

  return {
    ...unsigned,
    signature,
  };
}

export function buildLct1Response(frame: LockoutClearTokenFrameV1): IssuePrivilegedLockoutClearResponse {
  const encoded = encodeLct1(frame);
  return {
    ok: true,
    lct1Base64: encoded.toString('base64'),
    securityDeviceIdHex: frame.securityDeviceId.toString('hex'),
    managerStaffId: frame.managerStaffId,
    lockoutIdHex: frame.lockoutId.toString('hex'),
    issuedAtServerMs: frame.issuedAtServerMs,
    expiresAtServerMs: frame.expiresAtServerMs,
  };
}
