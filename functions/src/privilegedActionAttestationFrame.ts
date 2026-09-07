/**
 * SEC-001 Packet D / D-1B — `PAA1` PrivilegedActionAttestationFrameV1 codec.
 *
 * Wire format matches `src-tauri/src/privileged_auth/frames.rs` byte-for-byte
 * (see `PAA1_CANONICAL_PARITY_HEX`, asserted identical on both sides).
 *
 * House framing, identical to SSA1/SRF1/EFR1: little-endian, fixed head, then
 * `u16`-LE-length-prefixed UTF-8 strings, then a trailing 64-byte Ed25519
 * signature. No trailing bytes are permitted. The signature preimage is
 * `PAA1_DOMAIN_SEPARATOR ‖ signed_prefix`, where `signed_prefix` is every byte
 * before the signature.
 *
 * The server treats a decoded PAA1 as *signed evidence*, never as current
 * authority: every field is cross-checked against live state by
 * `adjudicateOfflinePrivilegedActionCore.ts`.
 */

import { createHash } from 'node:crypto';
import { isCanonicalIdentifier } from './staffSessionAssertionFrame';

export const PAA1_MAGIC = 'PAA1';
export const PAA1_VERSION = 1;
export const PAA1_DOMAIN_SEPARATOR = 'TWINPET_PAA1_V1:';

export const PAA1_ATTESTATION_ID_LEN = 16;
export const PAA1_SECURITY_DEVICE_ID_LEN = 16;
export const PAA1_NONCE_LEN = 32;
export const PAA1_DIGEST_LEN = 32;
export const PAA1_SIGNATURE_LEN = 64;

/** 4+1+16+1+1+1+16+4+4+4+4+4+4+4+8+8+8+8+32+32+32+32 */
export const PAA1_FIXED_HEAD_BYTES = 228;
/** 228 + 8 empty u16 length prefixes (16) + 64 signature */
export const PAA1_MINIMUM_TOTAL_BYTES = 308;

export const PAA1_ACTION_KIND_VOID_PENDING_SALE = 0x01;
export const PAA1_ACTION_KIND_VOID_SETTLED_SALE = 0x02;

/** `PAA1` is minted only for `APPROVED_LOCAL`. A signed denial cannot exist. */
export const PAA1_APPROVAL_RESULT_APPROVED_LOCAL = 0x01;

export const PAA1_MANAGER_ROLE_MANAGER = 0x01;
export const PAA1_MANAGER_ROLE_ADMIN = 0x02;

export const PAA1_OAC_SCHEMA_VERSION = 1;

export const PAA1_UTC7_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type Paa1ActionId = 'VOID_PENDING_SALE' | 'VOID_SETTLED_SALE';
export type Paa1ManagerRole = 'manager' | 'admin';

export interface PrivilegedActionAttestationFrameV1 {
  attestationId: Buffer;
  actionKind: number;
  approvalResultKind: number;
  managerRoleKind: number;
  securityDeviceId: Buffer;
  deviceKeyVersion: number;
  oacSchemaVersion: number;
  revocationEpochAtIssue: number;
  managerAuthVersionAtIssue: number;
  managerCredentialVersionAtIssue: number;
  ssa1AuthVersionAtIssue: number;
  attemptCount: number;
  ssa1ExpiresAtServerMs: number;
  trustedApprovalLowerMs: number;
  trustedApprovalUpperMs: number;
  pendingExecutionExpiresAtMs: number;
  nonce: Buffer;
  approvalProofDigest: Buffer;
  oacDigest: Buffer;
  ssa1Digest: Buffer;
  branchId: string;
  initiatingStaffId: string;
  approvingManagerStaffId: string;
  oacId: string;
  ssa1Id: string;
  targetOrderId: string;
  targetOrderUtc7Date: string;
  localIntentId: string;
  signature: Buffer;
}

export type Paa1DecodeFailureCode =
  | 'wrong_total_length'
  | 'bad_magic'
  | 'bad_version'
  | 'bad_field_length'
  | 'bad_field_format';

export type Paa1DecodeResult =
  | { ok: true; value: PrivilegedActionAttestationFrameV1 }
  | { ok: false; code: Paa1DecodeFailureCode };

function writeU16LePrefixedStr(str: string): Buffer {
  const strBuf = Buffer.from(str, 'utf8');
  if (strBuf.length > 0xffff) throw new Error('string exceeds u16 max length');
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16LE(strBuf.length, 0);
  return Buffer.concat([lenBuf, strBuf]);
}

function readU16LePrefixedStr(bytes: Buffer, offset: number): { str: string; nextOffset: number } | null {
  if (offset + 2 > bytes.length) return null;
  const len = bytes.readUInt16LE(offset);
  const start = offset + 2;
  const end = start + len;
  if (end > bytes.length) return null;
  return { str: bytes.toString('utf8', start, end), nextOffset: end };
}

function isU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function isSafeU64(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isAllZero(buf: Buffer): boolean {
  return buf.every((b) => b === 0);
}

export function isPaa1ActionKind(value: number): boolean {
  return value === PAA1_ACTION_KIND_VOID_PENDING_SALE || value === PAA1_ACTION_KIND_VOID_SETTLED_SALE;
}

export function isPaa1ManagerRoleKind(value: number): boolean {
  return value === PAA1_MANAGER_ROLE_MANAGER || value === PAA1_MANAGER_ROLE_ADMIN;
}

export function paa1ActionKindToActionId(kind: number): Paa1ActionId | null {
  if (kind === PAA1_ACTION_KIND_VOID_PENDING_SALE) return 'VOID_PENDING_SALE';
  if (kind === PAA1_ACTION_KIND_VOID_SETTLED_SALE) return 'VOID_SETTLED_SALE';
  return null;
}

export function paa1ManagerRoleKindToRole(kind: number): Paa1ManagerRole | null {
  if (kind === PAA1_MANAGER_ROLE_MANAGER) return 'manager';
  if (kind === PAA1_MANAGER_ROLE_ADMIN) return 'admin';
  return null;
}

/**
 * Structural invariants shared by encode and strict decode. Every one of these
 * is a pure function of the frame's own bytes — no server state is consulted,
 * which is what makes `attestation_malformed` a `PERMANENT` classification.
 */
function structuralFailure(frame: Omit<PrivilegedActionAttestationFrameV1, 'signature'>): Paa1DecodeFailureCode | null {
  if (frame.attestationId.length !== PAA1_ATTESTATION_ID_LEN) return 'bad_field_length';
  if (frame.securityDeviceId.length !== PAA1_SECURITY_DEVICE_ID_LEN) return 'bad_field_length';
  if (frame.nonce.length !== PAA1_NONCE_LEN) return 'bad_field_length';
  if (frame.approvalProofDigest.length !== PAA1_DIGEST_LEN) return 'bad_field_length';
  if (frame.oacDigest.length !== PAA1_DIGEST_LEN) return 'bad_field_length';
  if (frame.ssa1Digest.length !== PAA1_DIGEST_LEN) return 'bad_field_length';

  if (isAllZero(frame.attestationId)) return 'bad_field_format';
  if (!isPaa1ActionKind(frame.actionKind)) return 'bad_field_format';
  if (frame.approvalResultKind !== PAA1_APPROVAL_RESULT_APPROVED_LOCAL) return 'bad_field_format';
  if (!isPaa1ManagerRoleKind(frame.managerRoleKind)) return 'bad_field_format';

  if (!isU32(frame.deviceKeyVersion) || frame.deviceKeyVersion === 0) return 'bad_field_format';
  if (frame.oacSchemaVersion !== PAA1_OAC_SCHEMA_VERSION) return 'bad_field_format';
  if (!isU32(frame.revocationEpochAtIssue)) return 'bad_field_format';
  if (!isU32(frame.managerAuthVersionAtIssue)) return 'bad_field_format';
  if (!isU32(frame.managerCredentialVersionAtIssue)) return 'bad_field_format';
  if (!isU32(frame.ssa1AuthVersionAtIssue)) return 'bad_field_format';
  if (!isU32(frame.attemptCount)) return 'bad_field_format';

  if (!isSafeU64(frame.ssa1ExpiresAtServerMs)) return 'bad_field_format';
  if (!isSafeU64(frame.trustedApprovalLowerMs)) return 'bad_field_format';
  if (!isSafeU64(frame.trustedApprovalUpperMs)) return 'bad_field_format';
  if (!isSafeU64(frame.pendingExecutionExpiresAtMs)) return 'bad_field_format';

  if (frame.trustedApprovalLowerMs === 0) return 'bad_field_format';
  if (frame.trustedApprovalUpperMs < frame.trustedApprovalLowerMs) return 'bad_field_format';
  if (frame.pendingExecutionExpiresAtMs <= frame.trustedApprovalLowerMs) return 'bad_field_format';
  if (frame.ssa1ExpiresAtServerMs <= frame.trustedApprovalUpperMs) return 'bad_field_format';

  const identifiers = [
    frame.branchId,
    frame.initiatingStaffId,
    frame.approvingManagerStaffId,
    frame.oacId,
    frame.ssa1Id,
    frame.targetOrderId,
    frame.targetOrderUtc7Date,
    frame.localIntentId,
  ];
  for (const id of identifiers) {
    if (!isCanonicalIdentifier(id)) return 'bad_field_format';
  }
  if (frame.branchId === 'ALL') return 'bad_field_format';
  // D1 self-approval bar is bound into the bytes, not only enforced live.
  if (frame.approvingManagerStaffId === frame.initiatingStaffId) return 'bad_field_format';
  if (!PAA1_UTC7_DATE_RE.test(frame.targetOrderUtc7Date)) return 'bad_field_format';
  return null;
}

export function paa1SignedPrefix(frame: Omit<PrivilegedActionAttestationFrameV1, 'signature'>): Buffer {
  const failure = structuralFailure(frame);
  if (failure) throw new Error(`PAA1 field invalid: ${failure}`);

  const head = Buffer.alloc(PAA1_FIXED_HEAD_BYTES);
  head.write(PAA1_MAGIC, 0, 4, 'ascii');
  head.writeUInt8(PAA1_VERSION, 4);
  frame.attestationId.copy(head, 5);
  head.writeUInt8(frame.actionKind, 21);
  head.writeUInt8(frame.approvalResultKind, 22);
  head.writeUInt8(frame.managerRoleKind, 23);
  frame.securityDeviceId.copy(head, 24);
  head.writeUInt32LE(frame.deviceKeyVersion, 40);
  head.writeUInt32LE(frame.oacSchemaVersion, 44);
  head.writeUInt32LE(frame.revocationEpochAtIssue, 48);
  head.writeUInt32LE(frame.managerAuthVersionAtIssue, 52);
  head.writeUInt32LE(frame.managerCredentialVersionAtIssue, 56);
  head.writeUInt32LE(frame.ssa1AuthVersionAtIssue, 60);
  head.writeUInt32LE(frame.attemptCount, 64);
  head.writeBigUInt64LE(BigInt(frame.ssa1ExpiresAtServerMs), 68);
  head.writeBigUInt64LE(BigInt(frame.trustedApprovalLowerMs), 76);
  head.writeBigUInt64LE(BigInt(frame.trustedApprovalUpperMs), 84);
  head.writeBigUInt64LE(BigInt(frame.pendingExecutionExpiresAtMs), 92);
  frame.nonce.copy(head, 100);
  frame.approvalProofDigest.copy(head, 132);
  frame.oacDigest.copy(head, 164);
  frame.ssa1Digest.copy(head, 196);

  return Buffer.concat([
    head,
    writeU16LePrefixedStr(frame.branchId),
    writeU16LePrefixedStr(frame.initiatingStaffId),
    writeU16LePrefixedStr(frame.approvingManagerStaffId),
    writeU16LePrefixedStr(frame.oacId),
    writeU16LePrefixedStr(frame.ssa1Id),
    writeU16LePrefixedStr(frame.targetOrderId),
    writeU16LePrefixedStr(frame.targetOrderUtc7Date),
    writeU16LePrefixedStr(frame.localIntentId),
  ]);
}

export function paa1SignaturePreimage(frame: Omit<PrivilegedActionAttestationFrameV1, 'signature'>): Buffer {
  return Buffer.concat([Buffer.from(PAA1_DOMAIN_SEPARATOR, 'ascii'), paa1SignedPrefix(frame)]);
}

export function encodePaa1(frame: PrivilegedActionAttestationFrameV1): Buffer {
  if (frame.signature.length !== PAA1_SIGNATURE_LEN) {
    throw new Error('PAA1 signature must be 64 bytes');
  }
  return Buffer.concat([paa1SignedPrefix(frame), frame.signature]);
}

/**
 * Strict structural decode — Stage P3. Bytes-only: no Firestore access, no
 * signature verification, no clock read. A failure here is
 * `attestation_malformed` / `PERMANENT`.
 */
export function decodePaa1(bytes: Buffer): Paa1DecodeResult {
  if (bytes.length < PAA1_MINIMUM_TOTAL_BYTES) return { ok: false, code: 'wrong_total_length' };
  if (bytes.toString('ascii', 0, 4) !== PAA1_MAGIC) return { ok: false, code: 'bad_magic' };
  if (bytes.readUInt8(4) !== PAA1_VERSION) return { ok: false, code: 'bad_version' };

  const attestationId = Buffer.from(bytes.subarray(5, 5 + PAA1_ATTESTATION_ID_LEN));
  const actionKind = bytes.readUInt8(21);
  const approvalResultKind = bytes.readUInt8(22);
  const managerRoleKind = bytes.readUInt8(23);
  const securityDeviceId = Buffer.from(bytes.subarray(24, 24 + PAA1_SECURITY_DEVICE_ID_LEN));
  const deviceKeyVersion = bytes.readUInt32LE(40);
  const oacSchemaVersion = bytes.readUInt32LE(44);
  const revocationEpochAtIssue = bytes.readUInt32LE(48);
  const managerAuthVersionAtIssue = bytes.readUInt32LE(52);
  const managerCredentialVersionAtIssue = bytes.readUInt32LE(56);
  const ssa1AuthVersionAtIssue = bytes.readUInt32LE(60);
  const attemptCount = bytes.readUInt32LE(64);

  const ssa1ExpiresAtServerMsRaw = bytes.readBigUInt64LE(68);
  const trustedApprovalLowerMsRaw = bytes.readBigUInt64LE(76);
  const trustedApprovalUpperMsRaw = bytes.readBigUInt64LE(84);
  const pendingExecutionExpiresAtMsRaw = bytes.readBigUInt64LE(92);
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (
    ssa1ExpiresAtServerMsRaw > maxSafe ||
    trustedApprovalLowerMsRaw > maxSafe ||
    trustedApprovalUpperMsRaw > maxSafe ||
    pendingExecutionExpiresAtMsRaw > maxSafe
  ) {
    return { ok: false, code: 'bad_field_format' };
  }

  const nonce = Buffer.from(bytes.subarray(100, 100 + PAA1_NONCE_LEN));
  const approvalProofDigest = Buffer.from(bytes.subarray(132, 132 + PAA1_DIGEST_LEN));
  const oacDigest = Buffer.from(bytes.subarray(164, 164 + PAA1_DIGEST_LEN));
  const ssa1Digest = Buffer.from(bytes.subarray(196, 196 + PAA1_DIGEST_LEN));

  let offset = PAA1_FIXED_HEAD_BYTES;
  const tail: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const read = readU16LePrefixedStr(bytes, offset);
    if (!read) return { ok: false, code: 'bad_field_length' };
    tail.push(read.str);
    offset = read.nextOffset;
  }

  // No trailing bytes are permitted.
  if (offset + PAA1_SIGNATURE_LEN !== bytes.length) return { ok: false, code: 'wrong_total_length' };
  const signature = Buffer.from(bytes.subarray(offset, offset + PAA1_SIGNATURE_LEN));

  const candidate: Omit<PrivilegedActionAttestationFrameV1, 'signature'> = {
    attestationId,
    actionKind,
    approvalResultKind,
    managerRoleKind,
    securityDeviceId,
    deviceKeyVersion,
    oacSchemaVersion,
    revocationEpochAtIssue,
    managerAuthVersionAtIssue,
    managerCredentialVersionAtIssue,
    ssa1AuthVersionAtIssue,
    attemptCount,
    ssa1ExpiresAtServerMs: Number(ssa1ExpiresAtServerMsRaw),
    trustedApprovalLowerMs: Number(trustedApprovalLowerMsRaw),
    trustedApprovalUpperMs: Number(trustedApprovalUpperMsRaw),
    pendingExecutionExpiresAtMs: Number(pendingExecutionExpiresAtMsRaw),
    nonce,
    approvalProofDigest,
    oacDigest,
    ssa1Digest,
    branchId: tail[0],
    initiatingStaffId: tail[1],
    approvingManagerStaffId: tail[2],
    oacId: tail[3],
    ssa1Id: tail[4],
    targetOrderId: tail[5],
    targetOrderUtc7Date: tail[6],
    localIntentId: tail[7],
  };

  const failure = structuralFailure(candidate);
  if (failure) return { ok: false, code: failure };

  return { ok: true, value: { ...candidate, signature } };
}

/** `adjudicationId` — the durable record key. Stable, native-CSPRNG-seeded, 32 hex chars. */
export function paa1AdjudicationId(frame: PrivilegedActionAttestationFrameV1): string {
  return frame.attestationId.toString('hex');
}

/** `attestationDigest` — the anti-substitution anchor over the *exact* submitted bytes. */
export function paa1AttestationDigest(paa1Bytes: Buffer): string {
  return createHash('sha256').update(paa1Bytes).digest('hex');
}

export function paa1SecurityDeviceIdHex(frame: PrivilegedActionAttestationFrameV1): string {
  return frame.securityDeviceId.toString('hex');
}

/**
 * Canonical byte-parity vector. `PAA1_CANONICAL_PARITY_HEX` must equal the
 * value produced by `paa1_canonical_parity_frame()` in
 * `src-tauri/src/privileged_auth/frames.rs`, byte for byte.
 */
export function paa1CanonicalParityFrame(): PrivilegedActionAttestationFrameV1 {
  return {
    attestationId: Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'),
    actionKind: PAA1_ACTION_KIND_VOID_SETTLED_SALE,
    approvalResultKind: PAA1_APPROVAL_RESULT_APPROVED_LOCAL,
    managerRoleKind: PAA1_MANAGER_ROLE_MANAGER,
    securityDeviceId: Buffer.from('101112131415161718191a1b1c1d1e1f', 'hex'),
    deviceKeyVersion: 3,
    oacSchemaVersion: 1,
    revocationEpochAtIssue: 7,
    managerAuthVersionAtIssue: 11,
    managerCredentialVersionAtIssue: 13,
    ssa1AuthVersionAtIssue: 17,
    attemptCount: 0,
    ssa1ExpiresAtServerMs: 1_700_000_900_000,
    trustedApprovalLowerMs: 1_700_000_000_000,
    trustedApprovalUpperMs: 1_700_000_000_250,
    pendingExecutionExpiresAtMs: 1_700_060_400_000,
    nonce: Buffer.alloc(PAA1_NONCE_LEN, 0x21),
    approvalProofDigest: Buffer.alloc(PAA1_DIGEST_LEN, 0x22),
    oacDigest: Buffer.alloc(PAA1_DIGEST_LEN, 0x23),
    ssa1Digest: Buffer.alloc(PAA1_DIGEST_LEN, 0x24),
    branchId: 'LDP-001',
    initiatingStaffId: 'staff-1',
    approvingManagerStaffId: 'manager-1',
    oacId: 'oac-1',
    ssa1Id: 'ssa1-1',
    targetOrderId: 'order-1',
    targetOrderUtc7Date: '2025-11-14',
    localIntentId: 'intent-1',
    signature: Buffer.alloc(PAA1_SIGNATURE_LEN, 0x5a),
  };
}

export const PAA1_CANONICAL_PARITY_HEX =
  '5041413101000102030405060708090a0b0c0d0e0f020101101112131415161718191a1b1c1d1e1f0300000001000000070000000b0000000d0000001100000000000000a023f3cf8b0100000068e5cf8b010000fa68e5cf8b01000080097fd38b010000212121212121212121212121212121212121212121212121212121212121212122222222222222222222222222222222222222222222222222222222222222222323232323232323232323232323232323232323232323232323232323232323242424242424242424242424242424242424242424242424242424242424242407004c44502d303031070073746166662d3109006d616e616765722d3105006f61632d310600737361312d3107006f726465722d310a00323032352d31312d31340800696e74656e742d315a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
