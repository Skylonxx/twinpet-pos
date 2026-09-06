/**
 * SEC-001 Packet D-1A — pure logic for Staff Session Assertion (SSA1) and
 * Server Receipt Frame (SRF1) issuance.
 *
 * Encapsulates:
 * - Staff identity & branch compatibility validation against live user record
 * - Registered device validation against SSCP1 proof
 * - SSA1 and SRF1 construction, signing, and encoding
 */

import { createHash, randomBytes, sign as ed25519Sign, type KeyObject } from 'node:crypto';
import {
  encodeSsa1,
  encodeSrf1,
  ssa1SignaturePreimage,
  srf1SignaturePreimage,
  SRF1_OBJECT_KIND_SSA1,
  type StaffSessionAssertionFrameV1,
  type ServerReceiptFrameV1,
  type StaffSessionDeviceChallengeProofV1,
} from './staffSessionAssertionFrame';

export const SSA1_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours absolute non-sliding

export interface LiveStaffUserRecord {
  staffId: string;
  isActive: boolean;
  deletedAt: unknown | null;
  authVersion: number;
  branchId?: string;
  branchIds?: string[];
  role?: string;
}

export interface LiveDeviceRecord {
  securityDeviceIdHex: string;
  status: 'ACTIVE' | string;
  deviceKeyVersion: number;
  branchId: string;
  validatedDevProofPublicKeyBase64: string;
}

export type StaffValidationFailureCode =
  | 'staff_not_found'
  | 'staff_inactive'
  | 'staff_auth_version_mismatch'
  | 'staff_branch_mismatch';

export function validateCallerStaffIdentity(
  user: LiveStaffUserRecord | null | undefined,
  tokenStaffId: string | null | undefined,
  tokenAuthVersion: number | null | undefined,
  targetBranchId: string,
): { ok: true } | { ok: false; code: StaffValidationFailureCode } {
  if (!tokenStaffId || typeof tokenStaffId !== 'string' || tokenStaffId.trim().length === 0) {
    return { ok: false, code: 'staff_not_found' };
  }
  if (
    tokenAuthVersion === undefined ||
    tokenAuthVersion === null ||
    typeof tokenAuthVersion !== 'number' ||
    !Number.isFinite(tokenAuthVersion) ||
    !Number.isInteger(tokenAuthVersion)
  ) {
    return { ok: false, code: 'staff_auth_version_mismatch' };
  }
  if (!user || user.staffId !== tokenStaffId) {
    return { ok: false, code: 'staff_not_found' };
  }
  if (!user.isActive || user.deletedAt != null) {
    return { ok: false, code: 'staff_inactive' };
  }
  if (
    typeof user.authVersion !== 'number' ||
    !Number.isFinite(user.authVersion) ||
    !Number.isInteger(user.authVersion) ||
    user.authVersion !== tokenAuthVersion
  ) {
    return { ok: false, code: 'staff_auth_version_mismatch' };
  }
  const allowedBranchIds = Array.isArray(user.branchIds) ? user.branchIds : [];
  const primaryBranch = typeof user.branchId === 'string' ? user.branchId : undefined;
  const isBranchAllowed =
    primaryBranch === targetBranchId ||
    allowedBranchIds.includes(targetBranchId) ||
    allowedBranchIds.includes('ALL');

  if (!isBranchAllowed) {
    return { ok: false, code: 'staff_branch_mismatch' };
  }
  return { ok: true };
}

export type DeviceValidationFailureCode =
  | 'device_not_found'
  | 'device_not_active'
  | 'device_key_version_mismatch'
  | 'device_branch_mismatch'
  | 'sscp1_purpose_mismatch'
  | 'sscp1_staff_mismatch';

export function validateDeviceForSession(
  device: LiveDeviceRecord | null | undefined,
  sscp1: StaffSessionDeviceChallengeProofV1,
  expectedPurpose: number,
  expectedStaffId: string,
): { ok: true } | { ok: false; code: DeviceValidationFailureCode } {
  if (sscp1.purpose !== expectedPurpose) {
    return { ok: false, code: 'sscp1_purpose_mismatch' };
  }
  if (sscp1.intendedStaffId !== expectedStaffId) {
    return { ok: false, code: 'sscp1_staff_mismatch' };
  }
  if (!device) {
    return { ok: false, code: 'device_not_found' };
  }
  if (device.status !== 'ACTIVE') {
    return { ok: false, code: 'device_not_active' };
  }
  if (
    typeof device.deviceKeyVersion !== 'number' ||
    !Number.isFinite(device.deviceKeyVersion) ||
    !Number.isInteger(device.deviceKeyVersion) ||
    device.deviceKeyVersion <= 0 ||
    device.deviceKeyVersion !== sscp1.deviceKeyVersion
  ) {
    return { ok: false, code: 'device_key_version_mismatch' };
  }
  if (device.branchId !== sscp1.branchId) {
    return { ok: false, code: 'device_branch_mismatch' };
  }
  return { ok: true };
}

export function buildSignedSsa1(
  staffId: string,
  securityDeviceId: Buffer,
  branchId: string,
  authVersionAtIssue: number,
  nowMs: number,
  signingKeyId: string,
  privateKey: KeyObject,
  ssa1IdHex: string = randomBytes(16).toString('hex'),
  lifetimeMs: number = SSA1_LIFETIME_MS,
): { ssa1: StaffSessionAssertionFrameV1; ssa1Bytes: Buffer } {
  const unsigned = {
    ssa1Id: ssa1IdHex,
    staffId,
    securityDeviceId,
    branchId,
    authVersionAtIssue,
    issuedAtServerMs: nowMs,
    expiresAtServerMs: nowMs + lifetimeMs,
    signingKeyId,
  };
  const preimage = ssa1SignaturePreimage(unsigned);
  const signature = ed25519Sign(null, preimage, privateKey);
  const ssa1: StaffSessionAssertionFrameV1 = { ...unsigned, signature };
  const ssa1Bytes = encodeSsa1(ssa1);
  return { ssa1, ssa1Bytes };
}

export function buildSignedSrf1ForSsa1(
  challengeNonce: Buffer,
  securityDeviceId: Buffer,
  branchId: string,
  ssa1Bytes: Buffer,
  nowMs: number,
  signingKeyId: string,
  privateKey: KeyObject,
): { srf1: ServerReceiptFrameV1; srf1Bytes: Buffer } {
  const objectDigest = createHash('sha256').update(ssa1Bytes).digest();
  const unsigned = {
    challengeNonce,
    securityDeviceId,
    branchId,
    objectKind: SRF1_OBJECT_KIND_SSA1,
    objectDigest,
    serverSentAtMs: nowMs,
    signingKeyId,
  };
  const preimage = srf1SignaturePreimage(unsigned);
  const signature = ed25519Sign(null, preimage, privateKey);
  const srf1: ServerReceiptFrameV1 = { ...unsigned, signature };
  const srf1Bytes = encodeSrf1(srf1);
  return { srf1, srf1Bytes };
}
