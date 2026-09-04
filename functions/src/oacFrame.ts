/**
 * SEC-001 Packet C-A binary frame contracts (pure, no Firestore/crypto signing).
 *
 * Exact frozen wire contract for `DeviceRegistrationPossessionFrameV1` (DRP1) per
 * `docs/agent-workflow/CURRENT_PACKET.md` — 185 bytes, little-endian, no padding,
 * no trailing bytes. Native counterpart: `src-tauri/src/privileged_auth/frames.rs`
 * (byte-for-byte parity, proven by identical literal test vectors in both suites).
 *
 * The remaining four frames (`ProvisioningTupleProofFrameV1`, `PinBindingFrameV1`,
 * `EnrollmentProofFrameV1`, `OKS1`) are C-A-local wire formats (not given an exact
 * layout in the canonical docs); they follow the same fixed-header /
 * length-prefixed-field / trailing-signature convention as DRP1 for consistency.
 */

export const DRP1_MAGIC = 'DRP1';
export const DRP1_VERSION = 1;
export const DRP1_ENROLLMENT_AUTH_ID_LEN = 32;
export const DRP1_NONCE_LEN = 32;
export const DRP1_SECURITY_DEVICE_ID_LEN = 16;
export const DRP1_DEV_PROOF_PUBLIC_KEY_LEN = 32;
export const DRP1_SIGNATURE_LEN = 64;
export const DRP1_SIGNED_LEN = 121;
export const DRP1_TOTAL_BYTES = 185;

export interface DeviceRegistrationPossessionFrameV1 {
  enrollmentAuthId: string;
  deviceRegistrationNonce: Buffer;
  securityDeviceId: Buffer;
  devProofPublicKey: Buffer;
  signature: Buffer;
}

export type FrameDecodeFailureCode =
  | 'wrong_total_length'
  | 'bad_magic'
  | 'bad_version'
  | 'bad_field_length'
  | 'bad_field_format';

export type FrameDecodeResult<T> = { ok: true; value: T } | { ok: false; code: FrameDecodeFailureCode };

const HEX32_RE = /^[0-9a-f]{32}$/;

/** `[0,121)` — the exact bytes DRP1's signature is computed over. */
export function drp1SignedPrefix(frame: Omit<DeviceRegistrationPossessionFrameV1, 'signature'>): Buffer {
  const buf = Buffer.alloc(DRP1_SIGNED_LEN);
  let offset = 0;
  buf.write(DRP1_MAGIC, offset, 'ascii');
  offset += 4;
  buf.writeUInt8(DRP1_VERSION, offset);
  offset += 1;
  buf.writeUInt8(DRP1_ENROLLMENT_AUTH_ID_LEN, offset);
  offset += 1;
  buf.write(frame.enrollmentAuthId, offset, 'ascii');
  offset += DRP1_ENROLLMENT_AUTH_ID_LEN;
  buf.writeUInt8(DRP1_NONCE_LEN, offset);
  offset += 1;
  frame.deviceRegistrationNonce.copy(buf, offset);
  offset += DRP1_NONCE_LEN;
  buf.writeUInt8(DRP1_SECURITY_DEVICE_ID_LEN, offset);
  offset += 1;
  frame.securityDeviceId.copy(buf, offset);
  offset += DRP1_SECURITY_DEVICE_ID_LEN;
  buf.writeUInt8(DRP1_DEV_PROOF_PUBLIC_KEY_LEN, offset);
  offset += 1;
  frame.devProofPublicKey.copy(buf, offset);
  offset += DRP1_DEV_PROOF_PUBLIC_KEY_LEN;
  return buf;
}

export function encodeDrp1(frame: DeviceRegistrationPossessionFrameV1): Buffer {
  const prefix = drp1SignedPrefix(frame);
  return Buffer.concat([prefix, frame.signature]);
}

export function decodeDrp1(bytes: Buffer): FrameDecodeResult<DeviceRegistrationPossessionFrameV1> {
  if (bytes.length !== DRP1_TOTAL_BYTES) return { ok: false, code: 'wrong_total_length' };
  if (bytes.toString('ascii', 0, 4) !== DRP1_MAGIC) return { ok: false, code: 'bad_magic' };
  if (bytes.readUInt8(4) !== DRP1_VERSION) return { ok: false, code: 'bad_version' };
  if (bytes.readUInt8(5) !== DRP1_ENROLLMENT_AUTH_ID_LEN) return { ok: false, code: 'bad_field_length' };
  const enrollmentAuthId = bytes.toString('ascii', 6, 38);
  if (!HEX32_RE.test(enrollmentAuthId)) return { ok: false, code: 'bad_field_format' };
  if (bytes.readUInt8(38) !== DRP1_NONCE_LEN) return { ok: false, code: 'bad_field_length' };
  const deviceRegistrationNonce = Buffer.from(bytes.subarray(39, 71));
  if (bytes.readUInt8(71) !== DRP1_SECURITY_DEVICE_ID_LEN) return { ok: false, code: 'bad_field_length' };
  const securityDeviceId = Buffer.from(bytes.subarray(72, 88));
  if (bytes.readUInt8(88) !== DRP1_DEV_PROOF_PUBLIC_KEY_LEN) return { ok: false, code: 'bad_field_length' };
  const devProofPublicKey = Buffer.from(bytes.subarray(89, 121));
  const signature = Buffer.from(bytes.subarray(121, 185));
  return {
    ok: true,
    value: { enrollmentAuthId, deviceRegistrationNonce, securityDeviceId, devProofPublicKey, signature },
  };
}

// --- ProvisioningTupleProofFrameV1 ("PTP1") --------------------------------
// Device-signed proof binding (securityDeviceId, oacIssuanceSessionId,
// managerStaffId, devProofPublicKey) at OAC-provisioning completion time, so
// the server can never bind a provisioned OAC to the wrong device/session/manager.

export interface ProvisioningTupleProofFrameV1 {
  securityDeviceId: Buffer;
  oacIssuanceSessionId: string;
  managerStaffId: string;
  nonce: Buffer;
  devProofPublicKey: Buffer;
  signature: Buffer;
}

const PTP1_MAGIC = 'PTP1';
const PTP1_VERSION = 1;
const PTP1_NONCE_LEN = 32;

const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export const CANONICAL_IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isCanonicalIdentifier(s: unknown): s is string {
  return typeof s === 'string' && CANONICAL_IDENTIFIER_RE.test(s);
}

function writeLenPrefixedAscii(chunks: Buffer[], value: string): void {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length > 255) throw new RangeError('length-prefixed field exceeds 255 bytes');
  const lenBuf = Buffer.alloc(1);
  lenBuf.writeUInt8(encoded.length);
  chunks.push(lenBuf, encoded);
}

function readLenPrefixedStrictUtf8(
  bytes: Buffer,
  offset: number
): { ok: true; value: string; next: number } | { ok: false; code: 'bad_field_length' | 'bad_field_format' } {
  if (offset >= bytes.length) return { ok: false, code: 'bad_field_length' };
  const len = bytes.readUInt8(offset);
  const start = offset + 1;
  const end = start + len;
  if (end > bytes.length) return { ok: false, code: 'bad_field_length' };
  try {
    const value = STRICT_UTF8_DECODER.decode(bytes.subarray(start, end));
    return { ok: true, value, next: end };
  } catch {
    return { ok: false, code: 'bad_field_format' };
  }
}

function readLenPrefixedAscii(bytes: Buffer, offset: number): { value: string; next: number } | null {
  const res = readLenPrefixedStrictUtf8(bytes, offset);
  if (!res.ok) return null;
  return { value: res.value, next: res.next };
}

export function ptp1SignedPrefix(frame: Omit<ProvisioningTupleProofFrameV1, 'signature'>): Buffer {
  if (frame.securityDeviceId.length !== DRP1_SECURITY_DEVICE_ID_LEN) {
    throw new RangeError('securityDeviceId must be 16 bytes');
  }
  if (frame.nonce.length !== PTP1_NONCE_LEN) throw new RangeError('nonce must be 32 bytes');
  if (frame.devProofPublicKey.length !== DRP1_DEV_PROOF_PUBLIC_KEY_LEN) {
    throw new RangeError('devProofPublicKey must be 32 bytes');
  }
  const chunks: Buffer[] = [Buffer.from(PTP1_MAGIC, 'ascii'), Buffer.from([PTP1_VERSION])];
  chunks.push(frame.securityDeviceId);
  writeLenPrefixedAscii(chunks, frame.oacIssuanceSessionId);
  writeLenPrefixedAscii(chunks, frame.managerStaffId);
  chunks.push(frame.nonce);
  chunks.push(frame.devProofPublicKey);
  return Buffer.concat(chunks);
}

export function encodePtp1(frame: ProvisioningTupleProofFrameV1): Buffer {
  return Buffer.concat([ptp1SignedPrefix(frame), frame.signature]);
}

export function decodePtp1(bytes: Buffer): FrameDecodeResult<ProvisioningTupleProofFrameV1> {
  if (bytes.length < 4 + 1 + 16 + 1 + 1 + 32 + 32 + 64) return { ok: false, code: 'wrong_total_length' };
  if (bytes.toString('ascii', 0, 4) !== PTP1_MAGIC) return { ok: false, code: 'bad_magic' };
  if (bytes.readUInt8(4) !== PTP1_VERSION) return { ok: false, code: 'bad_version' };
  let offset = 5;
  const securityDeviceId = Buffer.from(bytes.subarray(offset, offset + DRP1_SECURITY_DEVICE_ID_LEN));
  offset += DRP1_SECURITY_DEVICE_ID_LEN;
  const sessionField = readLenPrefixedAscii(bytes, offset);
  if (!sessionField) return { ok: false, code: 'bad_field_length' };
  offset = sessionField.next;
  const staffField = readLenPrefixedAscii(bytes, offset);
  if (!staffField) return { ok: false, code: 'bad_field_length' };
  offset = staffField.next;
  if (offset + PTP1_NONCE_LEN + DRP1_DEV_PROOF_PUBLIC_KEY_LEN + DRP1_SIGNATURE_LEN !== bytes.length) {
    return { ok: false, code: 'wrong_total_length' };
  }
  const nonce = Buffer.from(bytes.subarray(offset, offset + PTP1_NONCE_LEN));
  offset += PTP1_NONCE_LEN;
  const devProofPublicKey = Buffer.from(bytes.subarray(offset, offset + DRP1_DEV_PROOF_PUBLIC_KEY_LEN));
  offset += DRP1_DEV_PROOF_PUBLIC_KEY_LEN;
  const signature = Buffer.from(bytes.subarray(offset, offset + DRP1_SIGNATURE_LEN));
  if (!sessionField.value || !staffField.value) return { ok: false, code: 'bad_field_format' };
  return {
    ok: true,
    value: {
      securityDeviceId,
      oacIssuanceSessionId: sessionField.value,
      managerStaffId: staffField.value,
      nonce,
      devProofPublicKey,
      signature,
    },
  };
}

// --- PinBindingFrameV1 ("PIN1") --------------------------------------------
// Device-signed binding of the natively-computed Argon2id verifier to a
// specific (securityDeviceId, oacIssuanceSessionId, managerStaffId), so the
// server can never sign an OAC whose verifier was computed for a different
// session/device/manager than the one it is issuing for.

export interface PinBindingFrameV1 {
  securityDeviceId: Buffer;
  oacIssuanceSessionId: string;
  managerStaffId: string;
  verifierAlgo: string;
  m: number;
  t: number;
  p: number;
  verifierSalt: Buffer;
  verifier: Buffer;
  pepperCommitment: Buffer;
  devProofPublicKey: Buffer;
  signature: Buffer;
}

const PIN1_MAGIC = 'PIN1';
const PIN1_VERSION = 1;

function writeLenPrefixedBytes(chunks: Buffer[], value: Buffer): void {
  if (value.length > 255) throw new RangeError('length-prefixed field exceeds 255 bytes');
  chunks.push(Buffer.from([value.length]), value);
}

function readLenPrefixedBytes(bytes: Buffer, offset: number): { value: Buffer; next: number } | null {
  if (offset >= bytes.length) return null;
  const len = bytes.readUInt8(offset);
  const start = offset + 1;
  const end = start + len;
  if (end > bytes.length) return null;
  return { value: Buffer.from(bytes.subarray(start, end)), next: end };
}

export function pin1SignedPrefix(frame: Omit<PinBindingFrameV1, 'signature'>): Buffer {
  if (frame.securityDeviceId.length !== DRP1_SECURITY_DEVICE_ID_LEN) {
    throw new RangeError('securityDeviceId must be 16 bytes');
  }
  if (frame.devProofPublicKey.length !== DRP1_DEV_PROOF_PUBLIC_KEY_LEN) {
    throw new RangeError('devProofPublicKey must be 32 bytes');
  }
  const chunks: Buffer[] = [Buffer.from(PIN1_MAGIC, 'ascii'), Buffer.from([PIN1_VERSION])];
  chunks.push(frame.securityDeviceId);
  writeLenPrefixedAscii(chunks, frame.oacIssuanceSessionId);
  writeLenPrefixedAscii(chunks, frame.managerStaffId);
  writeLenPrefixedAscii(chunks, frame.verifierAlgo);
  const u32 = Buffer.alloc(4);
  u32.writeUInt32LE(frame.m);
  chunks.push(Buffer.from(u32));
  const t32 = Buffer.alloc(4);
  t32.writeUInt32LE(frame.t);
  chunks.push(Buffer.from(t32));
  const p32 = Buffer.alloc(4);
  p32.writeUInt32LE(frame.p);
  chunks.push(Buffer.from(p32));
  writeLenPrefixedBytes(chunks, frame.verifierSalt);
  writeLenPrefixedBytes(chunks, frame.verifier);
  writeLenPrefixedBytes(chunks, frame.pepperCommitment);
  chunks.push(frame.devProofPublicKey);
  return Buffer.concat(chunks);
}

export function encodePin1(frame: PinBindingFrameV1): Buffer {
  return Buffer.concat([pin1SignedPrefix(frame), frame.signature]);
}

export function decodePin1(bytes: Buffer): FrameDecodeResult<PinBindingFrameV1> {
  if (bytes.length < 4 + 1 + 16) return { ok: false, code: 'wrong_total_length' };
  if (bytes.toString('ascii', 0, 4) !== PIN1_MAGIC) return { ok: false, code: 'bad_magic' };
  if (bytes.readUInt8(4) !== PIN1_VERSION) return { ok: false, code: 'bad_version' };
  let offset = 5;
  const securityDeviceId = Buffer.from(bytes.subarray(offset, offset + DRP1_SECURITY_DEVICE_ID_LEN));
  offset += DRP1_SECURITY_DEVICE_ID_LEN;
  const sessionField = readLenPrefixedAscii(bytes, offset);
  if (!sessionField) return { ok: false, code: 'bad_field_length' };
  offset = sessionField.next;
  const staffField = readLenPrefixedAscii(bytes, offset);
  if (!staffField) return { ok: false, code: 'bad_field_length' };
  offset = staffField.next;
  const algoField = readLenPrefixedAscii(bytes, offset);
  if (!algoField) return { ok: false, code: 'bad_field_length' };
  offset = algoField.next;
  if (offset + 12 > bytes.length) return { ok: false, code: 'wrong_total_length' };
  const m = bytes.readUInt32LE(offset);
  offset += 4;
  const t = bytes.readUInt32LE(offset);
  offset += 4;
  const p = bytes.readUInt32LE(offset);
  offset += 4;
  const saltField = readLenPrefixedBytes(bytes, offset);
  if (!saltField) return { ok: false, code: 'bad_field_length' };
  offset = saltField.next;
  const verifierField = readLenPrefixedBytes(bytes, offset);
  if (!verifierField) return { ok: false, code: 'bad_field_length' };
  offset = verifierField.next;
  const pepperField = readLenPrefixedBytes(bytes, offset);
  if (!pepperField) return { ok: false, code: 'bad_field_length' };
  offset = pepperField.next;
  if (offset + DRP1_DEV_PROOF_PUBLIC_KEY_LEN + DRP1_SIGNATURE_LEN !== bytes.length) {
    return { ok: false, code: 'wrong_total_length' };
  }
  const devProofPublicKey = Buffer.from(bytes.subarray(offset, offset + DRP1_DEV_PROOF_PUBLIC_KEY_LEN));
  offset += DRP1_DEV_PROOF_PUBLIC_KEY_LEN;
  const signature = Buffer.from(bytes.subarray(offset, offset + DRP1_SIGNATURE_LEN));
  if (!sessionField.value || !staffField.value || !algoField.value) {
    return { ok: false, code: 'bad_field_format' };
  }
  return {
    ok: true,
    value: {
      securityDeviceId,
      oacIssuanceSessionId: sessionField.value,
      managerStaffId: staffField.value,
      verifierAlgo: algoField.value,
      m,
      t,
      p,
      verifierSalt: saltField.value,
      verifier: verifierField.value,
      pepperCommitment: pepperField.value,
      devProofPublicKey,
      signature,
    },
  };
}

// --- EnrollmentProofFrameV1 ("ENR1") ---------------------------------------
// Server/issuer-issued enrollment authorization embedded in the enrollment
// file the Admin Console exports and the native POS terminal imports. The
// terminal is not a trust anchor for this frame (D17 — untrusted POS WebView
// cannot mint or present issuer/enrollment trust material); it extracts
// `enrollmentAuthId`/`branchId`/expiry to embed in the DRP1 it later
// generates, and the server is the one that authoritatively re-validates the
// enrollment authorization (and this frame's signature) at
// `completeDeviceRegistration` time.

export interface EnrollmentProofFrameV1 {
  enrollmentAuthId: string;
  branchId: string;
  issuedAtServerMs: number;
  expiresAtServerMs: number;
  issuerId: string;
  signature: Buffer;
}

const ENR1_MAGIC = 'ENR1';
const ENR1_VERSION = 1;

export function enr1SignedPrefix(frame: Omit<EnrollmentProofFrameV1, 'signature'>): Buffer {
  if (!HEX32_RE.test(frame.enrollmentAuthId)) throw new RangeError('enrollmentAuthId must be 32 lowercase hex chars');
  const chunks: Buffer[] = [Buffer.from(ENR1_MAGIC, 'ascii'), Buffer.from([ENR1_VERSION])];
  chunks.push(Buffer.from(frame.enrollmentAuthId, 'ascii'));
  writeLenPrefixedAscii(chunks, frame.branchId);
  const issuedBuf = Buffer.alloc(8);
  issuedBuf.writeBigUInt64LE(BigInt(frame.issuedAtServerMs));
  chunks.push(Buffer.from(issuedBuf));
  const expiresBuf = Buffer.alloc(8);
  expiresBuf.writeBigUInt64LE(BigInt(frame.expiresAtServerMs));
  chunks.push(Buffer.from(expiresBuf));
  writeLenPrefixedAscii(chunks, frame.issuerId);
  return Buffer.concat(chunks);
}

export function encodeEnr1(frame: EnrollmentProofFrameV1): Buffer {
  return Buffer.concat([enr1SignedPrefix(frame), frame.signature]);
}

export function decodeEnr1(bytes: Buffer): FrameDecodeResult<EnrollmentProofFrameV1> {
  if (bytes.length < 4 + 1 + 32) return { ok: false, code: 'wrong_total_length' };
  if (bytes.toString('ascii', 0, 4) !== ENR1_MAGIC) return { ok: false, code: 'bad_magic' };
  if (bytes.readUInt8(4) !== ENR1_VERSION) return { ok: false, code: 'bad_version' };
  const enrollmentAuthId = bytes.toString('ascii', 5, 37);
  if (!HEX32_RE.test(enrollmentAuthId)) return { ok: false, code: 'bad_field_format' };
  let offset = 37;
  const branchField = readLenPrefixedAscii(bytes, offset);
  if (!branchField) return { ok: false, code: 'bad_field_length' };
  offset = branchField.next;
  if (offset + 16 > bytes.length) return { ok: false, code: 'wrong_total_length' };
  const issuedAtServerMs = Number(bytes.readBigUInt64LE(offset));
  offset += 8;
  const expiresAtServerMs = Number(bytes.readBigUInt64LE(offset));
  offset += 8;
  const issuerField = readLenPrefixedAscii(bytes, offset);
  if (!issuerField) return { ok: false, code: 'bad_field_length' };
  offset = issuerField.next;
  if (offset + DRP1_SIGNATURE_LEN !== bytes.length) return { ok: false, code: 'wrong_total_length' };
  const signature = Buffer.from(bytes.subarray(offset, offset + DRP1_SIGNATURE_LEN));
  if (!branchField.value || !issuerField.value) return { ok: false, code: 'bad_field_format' };
  return {
    ok: true,
    value: {
      enrollmentAuthId,
      branchId: branchField.value,
      issuedAtServerMs,
      expiresAtServerMs,
      issuerId: issuerField.value,
      signature,
    },
  };
}

// --- OKS1 (OacKeysetManifestFrameV1) ---------------------------------------
// Native-consumed manifest of active OAC-signing public keys + the current
// revocation epoch, fetched (while online, over authenticated HTTPS) via
// `getOacKeysetManifest` and cached on-device so offline OAC-signature
// verification has a public key to check against. Self-signed by the
// manifest's own primary (index 0) signing key as an at-rest integrity check
// for the cached copy — transport authenticity is already provided by the
// authenticated Functions-callable/TLS channel that delivered it.

export interface OacKeysetManifestKeyV1 {
  signingKeyId: string;
  publicKey: Buffer;
}

export interface OacKeysetManifestFrameV1 {
  revocationEpoch: number;
  generatedAtServerMs: number;
  keys: readonly OacKeysetManifestKeyV1[];
  signature: Buffer;
}

const OKS1_MAGIC = 'OKS1';
const OKS1_VERSION = 1;

export function oks1SignedPrefix(frame: Omit<OacKeysetManifestFrameV1, 'signature'>): Buffer {
  if (frame.keys.length === 0 || frame.keys.length > 255) {
    throw new RangeError('OKS1 keys must be 1-255 entries');
  }
  const chunks: Buffer[] = [Buffer.from(OKS1_MAGIC, 'ascii'), Buffer.from([OKS1_VERSION])];
  const epochBuf = Buffer.alloc(4);
  epochBuf.writeUInt32LE(frame.revocationEpoch);
  chunks.push(Buffer.from(epochBuf));
  const genBuf = Buffer.alloc(8);
  genBuf.writeBigUInt64LE(BigInt(frame.generatedAtServerMs));
  chunks.push(Buffer.from(genBuf));
  chunks.push(Buffer.from([frame.keys.length]));
  for (const key of frame.keys) {
    if (key.publicKey.length !== DRP1_DEV_PROOF_PUBLIC_KEY_LEN) {
      throw new RangeError('OKS1 public key must be 32 bytes');
    }
    writeLenPrefixedAscii(chunks, key.signingKeyId);
    chunks.push(key.publicKey);
  }
  return Buffer.concat(chunks);
}

export function encodeOks1(frame: OacKeysetManifestFrameV1): Buffer {
  return Buffer.concat([oks1SignedPrefix(frame), frame.signature]);
}

export function decodeOks1(bytes: Buffer): FrameDecodeResult<OacKeysetManifestFrameV1> {
  if (bytes.length < 4 + 1 + 4 + 8 + 1) return { ok: false, code: 'wrong_total_length' };
  if (bytes.toString('ascii', 0, 4) !== OKS1_MAGIC) return { ok: false, code: 'bad_magic' };
  if (bytes.readUInt8(4) !== OKS1_VERSION) return { ok: false, code: 'bad_version' };
  let offset = 5;
  const revocationEpoch = bytes.readUInt32LE(offset);
  offset += 4;
  const generatedAtServerMs = Number(bytes.readBigUInt64LE(offset));
  offset += 8;
  const keyCount = bytes.readUInt8(offset);
  offset += 1;
  if (keyCount === 0) return { ok: false, code: 'bad_field_length' };
  const keys: OacKeysetManifestKeyV1[] = [];
  for (let i = 0; i < keyCount; i += 1) {
    const idField = readLenPrefixedAscii(bytes, offset);
    if (!idField || !idField.value) return { ok: false, code: 'bad_field_length' };
    offset = idField.next;
    if (offset + DRP1_DEV_PROOF_PUBLIC_KEY_LEN > bytes.length) return { ok: false, code: 'wrong_total_length' };
    const publicKey = Buffer.from(bytes.subarray(offset, offset + DRP1_DEV_PROOF_PUBLIC_KEY_LEN));
    offset += DRP1_DEV_PROOF_PUBLIC_KEY_LEN;
    keys.push({ signingKeyId: idField.value, publicKey });
  }
  if (offset + DRP1_SIGNATURE_LEN !== bytes.length) return { ok: false, code: 'wrong_total_length' };
  const signature = Buffer.from(bytes.subarray(offset, offset + DRP1_SIGNATURE_LEN));
  return { ok: true, value: { revocationEpoch, generatedAtServerMs, keys, signature } };
}

// --- LockoutClearTokenFrameV1 ("LCT1") --------------------------------------

export const LCT1_MAGIC = 'LCT1';
export const LCT1_VERSION = 1;
export const LCT1_SECURITY_DEVICE_ID_LEN = 16;
export const LCT1_LOCKOUT_ID_LEN = 32;
export const LCT1_NONCE_LEN = 32;
export const LCT1_SIGNATURE_LEN = 64;
export const LOCKOUT_CLEAR_TOKEN_TTL_MS = 15 * 60 * 1000; // 900_000 ms

export const LCT1_CANONICAL_PARITY_HEX =
  '4c43543101101112131415161718191a1b1c1d1e1f076d67725f303031202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f0068e5cf8b010000a023f3cf8b010000303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f076b65795f303031404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f';

export interface LockoutClearTokenFrameV1 {
  securityDeviceId: Buffer;
  managerStaffId: string;
  lockoutId: Buffer;
  issuedAtServerMs: number;
  expiresAtServerMs: number;
  tokenNonce: Buffer;
  signingKeyId: string;
  signature: Buffer;
}

export function lct1SignedPrefix(frame: Omit<LockoutClearTokenFrameV1, 'signature'>): Buffer {
  if (!isCanonicalIdentifier(frame.managerStaffId) || !isCanonicalIdentifier(frame.signingKeyId)) {
    throw new RangeError('managerStaffId and signingKeyId must be canonical identifiers');
  }
  if (frame.expiresAtServerMs <= frame.issuedAtServerMs) {
    throw new RangeError('expiresAtServerMs must be greater than issuedAtServerMs');
  }
  if (frame.expiresAtServerMs - frame.issuedAtServerMs > LOCKOUT_CLEAR_TOKEN_TTL_MS) {
    throw new RangeError(`expiresAtServerMs exceeds maximum TTL of ${LOCKOUT_CLEAR_TOKEN_TTL_MS} ms`);
  }
  const chunks: Buffer[] = [Buffer.from(LCT1_MAGIC, 'ascii'), Buffer.from([LCT1_VERSION])];
  if (frame.securityDeviceId.length !== LCT1_SECURITY_DEVICE_ID_LEN) {
    throw new RangeError('securityDeviceId must be 16 bytes');
  }
  chunks.push(frame.securityDeviceId);
  writeLenPrefixedAscii(chunks, frame.managerStaffId);
  if (frame.lockoutId.length !== LCT1_LOCKOUT_ID_LEN) {
    throw new RangeError('lockoutId must be 32 bytes');
  }
  chunks.push(frame.lockoutId);
  const issuedBuf = Buffer.alloc(8);
  issuedBuf.writeBigUInt64LE(BigInt(frame.issuedAtServerMs));
  chunks.push(issuedBuf);
  const expiresBuf = Buffer.alloc(8);
  expiresBuf.writeBigUInt64LE(BigInt(frame.expiresAtServerMs));
  chunks.push(expiresBuf);
  if (frame.tokenNonce.length !== LCT1_NONCE_LEN) {
    throw new RangeError('tokenNonce must be 32 bytes');
  }
  chunks.push(frame.tokenNonce);
  writeLenPrefixedAscii(chunks, frame.signingKeyId);
  return Buffer.concat(chunks);
}

export function encodeLct1(frame: LockoutClearTokenFrameV1): Buffer {
  return Buffer.concat([lct1SignedPrefix(frame), frame.signature]);
}

export function decodeLct1(bytes: Buffer): FrameDecodeResult<LockoutClearTokenFrameV1> {
  if (bytes.length < 4 + 1 + 16 + 1 + 32 + 8 + 8 + 32 + 1 + 64) {
    return { ok: false, code: 'wrong_total_length' };
  }
  if (bytes.toString('ascii', 0, 4) !== LCT1_MAGIC) return { ok: false, code: 'bad_magic' };
  if (bytes.readUInt8(4) !== LCT1_VERSION) return { ok: false, code: 'bad_version' };
  let offset = 5;
  const securityDeviceId = Buffer.from(bytes.subarray(offset, offset + LCT1_SECURITY_DEVICE_ID_LEN));
  offset += LCT1_SECURITY_DEVICE_ID_LEN;
  const staffField = readLenPrefixedStrictUtf8(bytes, offset);
  if (!staffField.ok) return { ok: false, code: staffField.code };
  offset = staffField.next;
  if (offset + LCT1_LOCKOUT_ID_LEN + 8 + 8 + LCT1_NONCE_LEN > bytes.length) {
    return { ok: false, code: 'wrong_total_length' };
  }
  const lockoutId = Buffer.from(bytes.subarray(offset, offset + LCT1_LOCKOUT_ID_LEN));
  offset += LCT1_LOCKOUT_ID_LEN;
  const issuedAtServerMs = Number(bytes.readBigUInt64LE(offset));
  offset += 8;
  const expiresAtServerMs = Number(bytes.readBigUInt64LE(offset));
  offset += 8;
  const tokenNonce = Buffer.from(bytes.subarray(offset, offset + LCT1_NONCE_LEN));
  offset += LCT1_NONCE_LEN;
  const keyIdField = readLenPrefixedStrictUtf8(bytes, offset);
  if (!keyIdField.ok) return { ok: false, code: keyIdField.code };
  offset = keyIdField.next;
  if (offset + LCT1_SIGNATURE_LEN !== bytes.length) {
    return { ok: false, code: 'wrong_total_length' };
  }
  const signature = Buffer.from(bytes.subarray(offset, offset + LCT1_SIGNATURE_LEN));
  if (!isCanonicalIdentifier(staffField.value) || !isCanonicalIdentifier(keyIdField.value)) {
    return { ok: false, code: 'bad_field_format' };
  }
  if (expiresAtServerMs <= issuedAtServerMs) {
    return { ok: false, code: 'bad_field_format' };
  }
  if (expiresAtServerMs - issuedAtServerMs > LOCKOUT_CLEAR_TOKEN_TTL_MS) {
    return { ok: false, code: 'bad_field_format' };
  }
  return {
    ok: true,
    value: {
      securityDeviceId,
      managerStaffId: staffField.value,
      lockoutId,
      issuedAtServerMs,
      expiresAtServerMs,
      tokenNonce,
      signingKeyId: keyIdField.value,
      signature,
    },
  };
}
