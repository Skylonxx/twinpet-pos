/**
 * SEC-001 Packet D-1A — Staff Session Assertion (SSA1), Server Receipt Frame (SRF1),
 * and Staff Session Device Challenge Proof (SSCP1) binary frame contracts.
 *
 * Wire formats match `src-tauri/src/privileged_auth/frames.rs` byte-for-byte.
 */

export const SSA1_MAGIC = 'SSA1';
export const SSA1_VERSION = 1;
export const SSA1_SECURITY_DEVICE_ID_LEN = 16;
export const SSA1_SIGNATURE_LEN = 64;
export const SSA1_DOMAIN_SEPARATOR = 'TWINPET_SSA1_V1:';

export const SRF1_MAGIC = 'SRF1';
export const SRF1_VERSION = 1;
export const SRF1_NONCE_LEN = 32;
export const SRF1_SECURITY_DEVICE_ID_LEN = 16;
export const SRF1_DIGEST_LEN = 32;
export const SRF1_SIGNATURE_LEN = 64;
export const SRF1_DOMAIN_SEPARATOR = 'TWINPET_SRF1_V1:';
export const SRF1_OBJECT_KIND_SSA1 = 1;
export const SRF1_OBJECT_KIND_OAC = 2;

export const SSCP1_MAGIC = 'SSCP';
export const SSCP1_VERSION = 1;
export const SSCP1_NONCE_LEN = 32;
export const SSCP1_SECURITY_DEVICE_ID_LEN = 16;
export const SSCP1_SIGNATURE_LEN = 64;
export const SSCP1_PURPOSE_LOGIN = 1;
export const SSCP1_PURPOSE_REFRESH = 2;
export const SSCP1_PURPOSE_OAC_REANCHOR = 3;

export const EFR1_MAGIC = 'EFR1';
export const EFR1_VERSION = 1;
export const EFR1_GENERATION_ID_LEN = 16;
export const EFR1_SECURITY_DEVICE_ID_LEN = 16;
export const EFR1_PUBLIC_KEY_LEN = 32;
export const EFR1_RECEIPT_NONCE_LEN = 32;
export const EFR1_SIGNATURE_LEN = 64;
export const EFR1_DOMAIN_SEPARATOR = 'TWINPET_EFR1_V1:';
export const EFR1_OP_INITIAL_ENROLLMENT = 1;
export const EFR1_OP_RE_ENROLLMENT = 2;

export interface StaffSessionAssertionFrameV1 {
  ssa1Id: string;
  staffId: string;
  securityDeviceId: Buffer;
  branchId: string;
  authVersionAtIssue: number;
  issuedAtServerMs: number;
  expiresAtServerMs: number;
  signingKeyId: string;
  signature: Buffer;
}

export interface ServerReceiptFrameV1 {
  challengeNonce: Buffer;
  securityDeviceId: Buffer;
  branchId: string;
  objectKind: number;
  objectDigest: Buffer;
  serverSentAtMs: number;
  signingKeyId: string;
  signature: Buffer;
}

export interface StaffSessionDeviceChallengeProofV1 {
  purpose: number;
  challengeNonce: Buffer;
  securityDeviceId: Buffer;
  deviceKeyVersion: number;
  branchId: string;
  challengeGeneration: bigint | number;
  intendedStaffId: string;
  signature: Buffer;
}

export interface EnrollmentFinalizationReceiptFrameV1 {
  operationKind: number;
  enrollmentGenerationId: Buffer;
  securityDeviceId: Buffer;
  deviceKeyVersion: number;
  acceptedPublicKey: Buffer;
  receiptNonce: Buffer;
  serverSentAtMs: number;
  branchId: string;
  signingKeyId: string;
  signature: Buffer;
}

export type FrameDecodeFailureCode =
  | 'wrong_total_length'
  | 'bad_magic'
  | 'bad_version'
  | 'bad_field_length'
  | 'bad_field_format';

export type FrameDecodeResult<T> = { ok: true; value: T } | { ok: false; code: FrameDecodeFailureCode };

export const IDENTIFIER_MAX_BYTES = 1500;
const CANONICAL_ID_RE = /^[a-zA-Z0-9_\-]+$/;

export function isCanonicalIdentifier(id: string): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= IDENTIFIER_MAX_BYTES && CANONICAL_ID_RE.test(id);
}

function writeU16LePrefixedStr(str: string): Buffer {
  const strBuf = Buffer.from(str, 'utf8');
  if (strBuf.length > 0xffff) {
    throw new Error('string exceeds u16 max length');
  }
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
  const str = bytes.toString('utf8', start, end);
  return { str, nextOffset: end };
}

// --- SSA1 Codec ---

export function ssa1SignedPrefix(frame: Omit<StaffSessionAssertionFrameV1, 'signature'>): Buffer {
  if (!isCanonicalIdentifier(frame.ssa1Id) ||
      !isCanonicalIdentifier(frame.staffId) ||
      !isCanonicalIdentifier(frame.branchId) ||
      !isCanonicalIdentifier(frame.signingKeyId)) {
    throw new Error('SSA1 field format invalid: must be canonical identifier');
  }
  if (frame.expiresAtServerMs <= frame.issuedAtServerMs) {
    throw new Error('SSA1 expiration must be strictly greater than issuance');
  }
  if (frame.securityDeviceId.length !== SSA1_SECURITY_DEVICE_ID_LEN) {
    throw new Error('SSA1 securityDeviceId must be 16 bytes');
  }

  const parts: Buffer[] = [];
  parts.push(Buffer.from(SSA1_MAGIC, 'ascii'));
  parts.push(Buffer.from([SSA1_VERSION]));
  parts.push(writeU16LePrefixedStr(frame.ssa1Id));
  parts.push(writeU16LePrefixedStr(frame.staffId));
  parts.push(frame.securityDeviceId);
  parts.push(writeU16LePrefixedStr(frame.branchId));

  const numBuf = Buffer.alloc(4 + 8 + 8);
  numBuf.writeUInt32LE(frame.authVersionAtIssue, 0);
  numBuf.writeBigUInt64LE(BigInt(frame.issuedAtServerMs), 4);
  numBuf.writeBigUInt64LE(BigInt(frame.expiresAtServerMs), 12);
  parts.push(numBuf);

  parts.push(writeU16LePrefixedStr(frame.signingKeyId));

  return Buffer.concat(parts);
}

export function ssa1SignaturePreimage(frame: Omit<StaffSessionAssertionFrameV1, 'signature'>): Buffer {
  const prefix = ssa1SignedPrefix(frame);
  return Buffer.concat([Buffer.from(SSA1_DOMAIN_SEPARATOR, 'ascii'), prefix]);
}

export function encodeSsa1(frame: StaffSessionAssertionFrameV1): Buffer {
  if (frame.signature.length !== SSA1_SIGNATURE_LEN) {
    throw new Error('SSA1 signature must be 64 bytes');
  }
  const prefix = ssa1SignedPrefix(frame);
  return Buffer.concat([prefix, frame.signature]);
}

export function decodeSsa1(bytes: Buffer): FrameDecodeResult<StaffSessionAssertionFrameV1> {
  const minLen = 4 + 1 + 2 + 2 + 16 + 2 + 4 + 8 + 8 + 2 + 64;
  if (bytes.length < minLen) return { ok: false, code: 'wrong_total_length' };
  if (bytes.toString('ascii', 0, 4) !== SSA1_MAGIC) return { ok: false, code: 'bad_magic' };
  if (bytes.readUInt8(4) !== SSA1_VERSION) return { ok: false, code: 'bad_version' };

  let offset = 5;
  const ssa1IdRes = readU16LePrefixedStr(bytes, offset);
  if (!ssa1IdRes) return { ok: false, code: 'bad_field_length' };
  const ssa1Id = ssa1IdRes.str;
  offset = ssa1IdRes.nextOffset;

  const staffIdRes = readU16LePrefixedStr(bytes, offset);
  if (!staffIdRes) return { ok: false, code: 'bad_field_length' };
  const staffId = staffIdRes.str;
  offset = staffIdRes.nextOffset;

  if (offset + SSA1_SECURITY_DEVICE_ID_LEN > bytes.length) return { ok: false, code: 'wrong_total_length' };
  const securityDeviceId = Buffer.from(bytes.subarray(offset, offset + SSA1_SECURITY_DEVICE_ID_LEN));
  offset += SSA1_SECURITY_DEVICE_ID_LEN;

  const branchIdRes = readU16LePrefixedStr(bytes, offset);
  if (!branchIdRes) return { ok: false, code: 'bad_field_length' };
  const branchId = branchIdRes.str;
  offset = branchIdRes.nextOffset;

  if (offset + 4 + 8 + 8 > bytes.length) return { ok: false, code: 'wrong_total_length' };
  const authVersionAtIssue = bytes.readUInt32LE(offset);
  offset += 4;
  const issuedAtServerMs = Number(bytes.readBigUInt64LE(offset));
  offset += 8;
  const expiresAtServerMs = Number(bytes.readBigUInt64LE(offset));
  offset += 8;

  const keyIdRes = readU16LePrefixedStr(bytes, offset);
  if (!keyIdRes) return { ok: false, code: 'bad_field_length' };
  const signingKeyId = keyIdRes.str;
  offset = keyIdRes.nextOffset;

  if (offset + SSA1_SIGNATURE_LEN !== bytes.length) return { ok: false, code: 'wrong_total_length' };
  const signature = Buffer.from(bytes.subarray(offset, offset + SSA1_SIGNATURE_LEN));

  if (!isCanonicalIdentifier(ssa1Id) ||
      !isCanonicalIdentifier(staffId) ||
      !isCanonicalIdentifier(branchId) ||
      !isCanonicalIdentifier(signingKeyId)) {
    return { ok: false, code: 'bad_field_format' };
  }
  if (expiresAtServerMs <= issuedAtServerMs) {
    return { ok: false, code: 'bad_field_format' };
  }

  return {
    ok: true,
    value: {
      ssa1Id,
      staffId,
      securityDeviceId,
      branchId,
      authVersionAtIssue,
      issuedAtServerMs,
      expiresAtServerMs,
      signingKeyId,
      signature,
    },
  };
}

// --- SRF1 Codec ---

export function srf1SignedPrefix(frame: Omit<ServerReceiptFrameV1, 'signature'>): Buffer {
  if (!isCanonicalIdentifier(frame.branchId) || !isCanonicalIdentifier(frame.signingKeyId)) {
    throw new Error('SRF1 field format invalid: must be canonical identifier');
  }
  if (frame.objectKind !== SRF1_OBJECT_KIND_SSA1 && frame.objectKind !== SRF1_OBJECT_KIND_OAC) {
    throw new Error('SRF1 objectKind must be SSA1 (1) or OAC (2)');
  }
  if (frame.challengeNonce.length !== SRF1_NONCE_LEN) {
    throw new Error('SRF1 challengeNonce must be 32 bytes');
  }
  if (frame.securityDeviceId.length !== SRF1_SECURITY_DEVICE_ID_LEN) {
    throw new Error('SRF1 securityDeviceId must be 16 bytes');
  }
  if (frame.objectDigest.length !== SRF1_DIGEST_LEN) {
    throw new Error('SRF1 objectDigest must be 32 bytes');
  }

  const parts: Buffer[] = [];
  parts.push(Buffer.from(SRF1_MAGIC, 'ascii'));
  parts.push(Buffer.from([SRF1_VERSION]));
  parts.push(frame.challengeNonce);
  parts.push(frame.securityDeviceId);
  parts.push(writeU16LePrefixedStr(frame.branchId));
  parts.push(Buffer.from([frame.objectKind]));
  parts.push(frame.objectDigest);

  const numBuf = Buffer.alloc(8);
  numBuf.writeBigUInt64LE(BigInt(frame.serverSentAtMs), 0);
  parts.push(numBuf);

  parts.push(writeU16LePrefixedStr(frame.signingKeyId));

  return Buffer.concat(parts);
}

export function srf1SignaturePreimage(frame: Omit<ServerReceiptFrameV1, 'signature'>): Buffer {
  const prefix = srf1SignedPrefix(frame);
  return Buffer.concat([Buffer.from(SRF1_DOMAIN_SEPARATOR, 'ascii'), prefix]);
}

export function encodeSrf1(frame: ServerReceiptFrameV1): Buffer {
  if (frame.signature.length !== SRF1_SIGNATURE_LEN) {
    throw new Error('SRF1 signature must be 64 bytes');
  }
  const prefix = srf1SignedPrefix(frame);
  return Buffer.concat([prefix, frame.signature]);
}

export function decodeSrf1(bytes: Buffer): FrameDecodeResult<ServerReceiptFrameV1> {
  const minLen = 4 + 1 + 32 + 16 + 2 + 1 + 32 + 8 + 2 + 64;
  if (bytes.length < minLen) return { ok: false, code: 'wrong_total_length' };
  if (bytes.toString('ascii', 0, 4) !== SRF1_MAGIC) return { ok: false, code: 'bad_magic' };
  if (bytes.readUInt8(4) !== SRF1_VERSION) return { ok: false, code: 'bad_version' };

  let offset = 5;
  const challengeNonce = Buffer.from(bytes.subarray(offset, offset + SRF1_NONCE_LEN));
  offset += SRF1_NONCE_LEN;

  const securityDeviceId = Buffer.from(bytes.subarray(offset, offset + SRF1_SECURITY_DEVICE_ID_LEN));
  offset += SRF1_SECURITY_DEVICE_ID_LEN;

  const branchIdRes = readU16LePrefixedStr(bytes, offset);
  if (!branchIdRes) return { ok: false, code: 'bad_field_length' };
  const branchId = branchIdRes.str;
  offset = branchIdRes.nextOffset;

  if (offset + 1 + SRF1_DIGEST_LEN + 8 > bytes.length) return { ok: false, code: 'wrong_total_length' };
  const objectKind = bytes.readUInt8(offset);
  offset += 1;

  const objectDigest = Buffer.from(bytes.subarray(offset, offset + SRF1_DIGEST_LEN));
  offset += SRF1_DIGEST_LEN;

  const serverSentAtMs = Number(bytes.readBigUInt64LE(offset));
  offset += 8;

  const keyIdRes = readU16LePrefixedStr(bytes, offset);
  if (!keyIdRes) return { ok: false, code: 'bad_field_length' };
  const signingKeyId = keyIdRes.str;
  offset = keyIdRes.nextOffset;

  if (offset + SRF1_SIGNATURE_LEN !== bytes.length) return { ok: false, code: 'wrong_total_length' };
  const signature = Buffer.from(bytes.subarray(offset, offset + SRF1_SIGNATURE_LEN));

  if (!isCanonicalIdentifier(branchId) || !isCanonicalIdentifier(signingKeyId)) {
    return { ok: false, code: 'bad_field_format' };
  }
  if (objectKind !== SRF1_OBJECT_KIND_SSA1 && objectKind !== SRF1_OBJECT_KIND_OAC) {
    return { ok: false, code: 'bad_field_format' };
  }

  return {
    ok: true,
    value: {
      challengeNonce,
      securityDeviceId,
      branchId,
      objectKind,
      objectDigest,
      serverSentAtMs,
      signingKeyId,
      signature,
    },
  };
}

// --- SSCP1 Codec ---

export function sscp1SignedPrefix(frame: Omit<StaffSessionDeviceChallengeProofV1, 'signature'>): Buffer {
  if (!isCanonicalIdentifier(frame.branchId)) {
    throw new Error('SSCP1 branchId invalid');
  }
  if (frame.intendedStaffId && !isCanonicalIdentifier(frame.intendedStaffId)) {
    throw new Error('SSCP1 intendedStaffId invalid');
  }
  if (frame.purpose !== SSCP1_PURPOSE_LOGIN &&
      frame.purpose !== SSCP1_PURPOSE_REFRESH &&
      frame.purpose !== SSCP1_PURPOSE_OAC_REANCHOR) {
    throw new Error('SSCP1 purpose invalid');
  }
  if (frame.challengeNonce.length !== SSCP1_NONCE_LEN) {
    throw new Error('SSCP1 challengeNonce must be 32 bytes');
  }
  if (frame.securityDeviceId.length !== SSCP1_SECURITY_DEVICE_ID_LEN) {
    throw new Error('SSCP1 securityDeviceId must be 16 bytes');
  }

  const parts: Buffer[] = [];
  parts.push(Buffer.from(SSCP1_MAGIC, 'ascii'));
  parts.push(Buffer.from([SSCP1_VERSION]));
  parts.push(Buffer.from([frame.purpose]));
  parts.push(frame.challengeNonce);
  parts.push(frame.securityDeviceId);

  const verBuf = Buffer.alloc(4);
  verBuf.writeUInt32LE(frame.deviceKeyVersion, 0);
  parts.push(verBuf);

  parts.push(writeU16LePrefixedStr(frame.branchId));

  const genBuf = Buffer.alloc(8);
  genBuf.writeBigUInt64LE(BigInt(frame.challengeGeneration), 0);
  parts.push(genBuf);

  parts.push(writeU16LePrefixedStr(frame.intendedStaffId));

  return Buffer.concat(parts);
}

export function encodeSscp1(frame: StaffSessionDeviceChallengeProofV1): Buffer {
  if (frame.signature.length !== SSCP1_SIGNATURE_LEN) {
    throw new Error('SSCP1 signature must be 64 bytes');
  }
  const prefix = sscp1SignedPrefix(frame);
  return Buffer.concat([prefix, frame.signature]);
}

export function decodeSscp1(bytes: Buffer): FrameDecodeResult<StaffSessionDeviceChallengeProofV1> {
  const minLen = 4 + 1 + 1 + 32 + 16 + 4 + 2 + 8 + 2 + 64;
  if (bytes.length < minLen) return { ok: false, code: 'wrong_total_length' };
  if (bytes.toString('ascii', 0, 4) !== SSCP1_MAGIC) return { ok: false, code: 'bad_magic' };
  if (bytes.readUInt8(4) !== SSCP1_VERSION) return { ok: false, code: 'bad_version' };

  let offset = 5;
  const purpose = bytes.readUInt8(offset);
  offset += 1;
  if (purpose !== SSCP1_PURPOSE_LOGIN &&
      purpose !== SSCP1_PURPOSE_REFRESH &&
      purpose !== SSCP1_PURPOSE_OAC_REANCHOR) {
    return { ok: false, code: 'bad_field_format' };
  }

  const challengeNonce = Buffer.from(bytes.subarray(offset, offset + SSCP1_NONCE_LEN));
  offset += SSCP1_NONCE_LEN;

  const securityDeviceId = Buffer.from(bytes.subarray(offset, offset + SSCP1_SECURITY_DEVICE_ID_LEN));
  offset += SSCP1_SECURITY_DEVICE_ID_LEN;

  const deviceKeyVersion = bytes.readUInt32LE(offset);
  offset += 4;

  const branchIdRes = readU16LePrefixedStr(bytes, offset);
  if (!branchIdRes) return { ok: false, code: 'bad_field_length' };
  const branchId = branchIdRes.str;
  offset = branchIdRes.nextOffset;

  if (offset + 8 > bytes.length) return { ok: false, code: 'wrong_total_length' };
  const challengeGeneration = bytes.readBigUInt64LE(offset);
  offset += 8;

  const staffIdRes = readU16LePrefixedStr(bytes, offset);
  if (!staffIdRes) return { ok: false, code: 'bad_field_length' };
  const intendedStaffId = staffIdRes.str;
  offset = staffIdRes.nextOffset;

  if (offset + SSCP1_SIGNATURE_LEN !== bytes.length) return { ok: false, code: 'wrong_total_length' };
  const signature = Buffer.from(bytes.subarray(offset, offset + SSCP1_SIGNATURE_LEN));

  if (!isCanonicalIdentifier(branchId)) return { ok: false, code: 'bad_field_format' };
  if (intendedStaffId && !isCanonicalIdentifier(intendedStaffId)) return { ok: false, code: 'bad_field_format' };

  return {
    ok: true,
    value: {
      purpose,
      challengeNonce,
      securityDeviceId,
      deviceKeyVersion,
      branchId,
      challengeGeneration,
      intendedStaffId,
      signature,
    },
  };
}

// --- EFR1 Codec ---

export function efr1SignedPrefix(frame: Omit<EnrollmentFinalizationReceiptFrameV1, 'signature'>): Buffer {
  if (!isCanonicalIdentifier(frame.branchId) || !isCanonicalIdentifier(frame.signingKeyId)) {
    throw new Error('EFR1 field format invalid: must be canonical identifier');
  }
  if (frame.operationKind !== EFR1_OP_INITIAL_ENROLLMENT && frame.operationKind !== EFR1_OP_RE_ENROLLMENT) {
    throw new Error('EFR1 operationKind must be INITIAL_ENROLLMENT (1) or RE_ENROLLMENT (2)');
  }
  if (frame.enrollmentGenerationId.length !== EFR1_GENERATION_ID_LEN) {
    throw new Error('EFR1 enrollmentGenerationId must be 16 bytes');
  }
  if (frame.securityDeviceId.length !== EFR1_SECURITY_DEVICE_ID_LEN) {
    throw new Error('EFR1 securityDeviceId must be 16 bytes');
  }
  if (
    typeof frame.deviceKeyVersion !== 'number' ||
    !Number.isInteger(frame.deviceKeyVersion) ||
    frame.deviceKeyVersion <= 0 ||
    frame.deviceKeyVersion > 4294967295
  ) {
    throw new Error('EFR1 deviceKeyVersion must be valid u32');
  }
  if (frame.acceptedPublicKey.length !== EFR1_PUBLIC_KEY_LEN) {
    throw new Error('EFR1 acceptedPublicKey must be 32 bytes');
  }
  if (frame.receiptNonce.length !== EFR1_RECEIPT_NONCE_LEN) {
    throw new Error('EFR1 receiptNonce must be 32 bytes');
  }

  const parts: Buffer[] = [];
  parts.push(Buffer.from(EFR1_MAGIC, 'ascii'));
  parts.push(Buffer.from([EFR1_VERSION]));
  parts.push(Buffer.from([frame.operationKind]));
  parts.push(frame.enrollmentGenerationId);
  parts.push(frame.securityDeviceId);

  const verBuf = Buffer.alloc(4);
  verBuf.writeUInt32LE(frame.deviceKeyVersion, 0);
  parts.push(verBuf);

  parts.push(frame.acceptedPublicKey);
  parts.push(frame.receiptNonce);

  const timeBuf = Buffer.alloc(8);
  timeBuf.writeBigUInt64LE(BigInt(frame.serverSentAtMs), 0);
  parts.push(timeBuf);

  parts.push(writeU16LePrefixedStr(frame.branchId));
  parts.push(writeU16LePrefixedStr(frame.signingKeyId));

  return Buffer.concat(parts);
}

export function efr1SignaturePreimage(frame: Omit<EnrollmentFinalizationReceiptFrameV1, 'signature'>): Buffer {
  const prefix = efr1SignedPrefix(frame);
  return Buffer.concat([Buffer.from(EFR1_DOMAIN_SEPARATOR, 'ascii'), prefix]);
}

export function encodeEfr1(frame: EnrollmentFinalizationReceiptFrameV1): Buffer {
  if (frame.signature.length !== EFR1_SIGNATURE_LEN) {
    throw new Error('EFR1 signature must be 64 bytes');
  }
  const prefix = efr1SignedPrefix(frame);
  return Buffer.concat([prefix, frame.signature]);
}

export function decodeEfr1(bytes: Buffer): FrameDecodeResult<EnrollmentFinalizationReceiptFrameV1> {
  const minLen = 4 + 1 + 1 + 16 + 16 + 4 + 32 + 32 + 8 + 2 + 2 + 64;
  if (bytes.length < minLen) return { ok: false, code: 'wrong_total_length' };
  if (bytes.toString('ascii', 0, 4) !== EFR1_MAGIC) return { ok: false, code: 'bad_magic' };
  if (bytes.readUInt8(4) !== EFR1_VERSION) return { ok: false, code: 'bad_version' };

  let offset = 5;
  const operationKind = bytes.readUInt8(offset);
  offset += 1;
  if (operationKind !== EFR1_OP_INITIAL_ENROLLMENT && operationKind !== EFR1_OP_RE_ENROLLMENT) {
    return { ok: false, code: 'bad_field_format' };
  }

  const enrollmentGenerationId = Buffer.from(bytes.subarray(offset, offset + EFR1_GENERATION_ID_LEN));
  offset += EFR1_GENERATION_ID_LEN;

  const securityDeviceId = Buffer.from(bytes.subarray(offset, offset + EFR1_SECURITY_DEVICE_ID_LEN));
  offset += EFR1_SECURITY_DEVICE_ID_LEN;

  const deviceKeyVersion = bytes.readUInt32LE(offset);
  offset += 4;
  if (deviceKeyVersion === 0) return { ok: false, code: 'bad_field_format' };

  const acceptedPublicKey = Buffer.from(bytes.subarray(offset, offset + EFR1_PUBLIC_KEY_LEN));
  offset += EFR1_PUBLIC_KEY_LEN;

  const receiptNonce = Buffer.from(bytes.subarray(offset, offset + EFR1_RECEIPT_NONCE_LEN));
  offset += EFR1_RECEIPT_NONCE_LEN;

  const serverSentAtMs = Number(bytes.readBigUInt64LE(offset));
  offset += 8;

  const branchIdRes = readU16LePrefixedStr(bytes, offset);
  if (!branchIdRes) return { ok: false, code: 'bad_field_length' };
  const branchId = branchIdRes.str;
  offset = branchIdRes.nextOffset;

  const keyIdRes = readU16LePrefixedStr(bytes, offset);
  if (!keyIdRes) return { ok: false, code: 'bad_field_length' };
  const signingKeyId = keyIdRes.str;
  offset = keyIdRes.nextOffset;

  if (offset + EFR1_SIGNATURE_LEN !== bytes.length) return { ok: false, code: 'wrong_total_length' };
  const signature = Buffer.from(bytes.subarray(offset, offset + EFR1_SIGNATURE_LEN));

  if (!isCanonicalIdentifier(branchId)) return { ok: false, code: 'bad_field_format' };
  if (!isCanonicalIdentifier(signingKeyId)) return { ok: false, code: 'bad_field_format' };

  return {
    ok: true,
    value: {
      operationKind,
      enrollmentGenerationId,
      securityDeviceId,
      deviceKeyVersion,
      acceptedPublicKey,
      receiptNonce,
      serverSentAtMs,
      branchId,
      signingKeyId,
      signature,
    },
  };
}

// --- OAC Key Lifecycle Status Helpers ---

export type OacKeyLifecycleStatus = 'ACTIVE' | 'VERIFY_ONLY' | 'RETIRED';

export interface ParsedOacSigningKeyLifecycle {
  keyId: string;
  status: OacKeyLifecycleStatus;
  verifyUntilServerMs?: number;
}

export function formatOacSigningKeyIdWithLifecycle(
  keyId: string,
  status: OacKeyLifecycleStatus = 'ACTIVE',
  verifyUntilServerMs?: number
): string {
  if (status === 'ACTIVE') {
    return keyId;
  }
  if (status === 'VERIFY_ONLY') {
    if (typeof verifyUntilServerMs !== 'number' || !Number.isFinite(verifyUntilServerMs)) {
      throw new Error('VERIFY_ONLY status requires verifyUntilServerMs');
    }
    return `${keyId}|VERIFY_ONLY|${Math.floor(verifyUntilServerMs)}`;
  }
  if (status === 'RETIRED') {
    return `${keyId}|RETIRED`;
  }
  throw new Error(`Unknown lifecycle status: ${status}`);
}

export function parseOacSigningKeyIdLifecycle(rawKeyId: string): ParsedOacSigningKeyLifecycle {
  const parts = rawKeyId.split('|');
  if (parts.length === 1) {
    return { keyId: parts[0], status: 'ACTIVE' };
  }
  const statusStr = parts[1].toUpperCase();
  if (statusStr === 'ACTIVE') {
    return { keyId: parts[0], status: 'ACTIVE' };
  }
  if (statusStr === 'VERIFY_ONLY') {
    if (parts.length < 3 || !parts[2].trim()) {
      throw new Error(`Invalid VERIFY_ONLY keyId format: missing verifyUntilServerMs in ${rawKeyId}`);
    }
    const ms = Number(parts[2].trim());
    if (isNaN(ms)) {
      throw new Error(`Invalid verifyUntilServerMs in ${rawKeyId}`);
    }
    return { keyId: parts[0], status: 'VERIFY_ONLY', verifyUntilServerMs: ms };
  }
  if (statusStr === 'RETIRED') {
    return { keyId: parts[0], status: 'RETIRED' };
  }
  throw new Error(`Unknown lifecycle status in keyId: ${parts[1]}`);
}
