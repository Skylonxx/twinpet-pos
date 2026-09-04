import { describe, expect, it } from 'vitest';
import {
  DRP1_TOTAL_BYTES,
  decodeDrp1,
  decodeEnr1,
  decodeLct1,
  decodeOks1,
  decodePin1,
  decodePtp1,
  encodeDrp1,
  encodeEnr1,
  encodeLct1,
  encodeOks1,
  encodePin1,
  encodePtp1,
  lct1SignedPrefix,
  LCT1_CANONICAL_PARITY_HEX,
  LOCKOUT_CLEAR_TOKEN_TTL_MS,
  type DeviceRegistrationPossessionFrameV1,
  type LockoutClearTokenFrameV1,
} from '../oacFrame';

// Canonical DRP1 test vector — MUST stay byte-identical to the Rust vector in
// src-tauri/src/privileged_auth/frames.rs (`#[cfg(test)] mod tests`). This is
// how TS/Rust DRP1 parity is proven without a live cross-process call.
const VECTOR_ENROLLMENT_AUTH_ID = '00112233445566778899aabbccddeeff';
const VECTOR_NONCE = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const VECTOR_SECURITY_DEVICE_ID = Buffer.from(Array.from({ length: 16 }, (_, i) => 0xa0 + i));
const VECTOR_DEV_PROOF_PUBLIC_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => 0xc0 + i));
const VECTOR_SIGNATURE = Buffer.from(Array.from({ length: 64 }, (_, i) => i));

const VECTOR_FULL_HEX =
  '445250310120303031313232333334343535363637373838393961616262636364646565' +
  '666620000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f10' +
  'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf20c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2' +
  'd3d4d5d6d7d8d9dadbdcdddedf000102030405060708090a0b0c0d0e0f10111213141516' +
  '1718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a' +
  '3b3c3d3e3f';

function vectorFrame(): DeviceRegistrationPossessionFrameV1 {
  return {
    enrollmentAuthId: VECTOR_ENROLLMENT_AUTH_ID,
    deviceRegistrationNonce: VECTOR_NONCE,
    securityDeviceId: VECTOR_SECURITY_DEVICE_ID,
    devProofPublicKey: VECTOR_DEV_PROOF_PUBLIC_KEY,
    signature: VECTOR_SIGNATURE,
  };
}

describe('DRP1 (DeviceRegistrationPossessionFrameV1)', () => {
  it('encodes to the exact 185-byte canonical test vector (TS/Rust parity anchor)', () => {
    const encoded = encodeDrp1(vectorFrame());
    expect(encoded.length).toBe(DRP1_TOTAL_BYTES);
    expect(encoded.toString('hex')).toBe(VECTOR_FULL_HEX);
  });

  it('decodes the canonical vector back to the exact field values', () => {
    const result = decodeDrp1(Buffer.from(VECTOR_FULL_HEX, 'hex'));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.enrollmentAuthId).toBe(VECTOR_ENROLLMENT_AUTH_ID);
    expect(result.value.deviceRegistrationNonce.equals(VECTOR_NONCE)).toBe(true);
    expect(result.value.securityDeviceId.equals(VECTOR_SECURITY_DEVICE_ID)).toBe(true);
    expect(result.value.devProofPublicKey.equals(VECTOR_DEV_PROOF_PUBLIC_KEY)).toBe(true);
    expect(result.value.signature.equals(VECTOR_SIGNATURE)).toBe(true);
  });

  it('round-trips arbitrary valid frames', () => {
    const frame: DeviceRegistrationPossessionFrameV1 = {
      enrollmentAuthId: 'ffeeddccbbaa99887766554433221100',
      deviceRegistrationNonce: Buffer.alloc(32, 0x7a),
      securityDeviceId: Buffer.alloc(16, 0x11),
      devProofPublicKey: Buffer.alloc(32, 0x22),
      signature: Buffer.alloc(64, 0x33),
    };
    const decoded = decodeDrp1(encodeDrp1(frame));
    expect(decoded).toEqual({ ok: true, value: frame });
  });

  it('rejects any input whose length is not exactly 185 bytes', () => {
    expect(decodeDrp1(Buffer.alloc(184))).toEqual({ ok: false, code: 'wrong_total_length' });
    expect(decodeDrp1(Buffer.alloc(186))).toEqual({ ok: false, code: 'wrong_total_length' });
    expect(decodeDrp1(Buffer.alloc(0))).toEqual({ ok: false, code: 'wrong_total_length' });
  });

  it('rejects bad magic', () => {
    const bytes = Buffer.from(VECTOR_FULL_HEX, 'hex');
    bytes[0] = 0x58; // 'X'
    expect(decodeDrp1(bytes)).toEqual({ ok: false, code: 'bad_magic' });
  });

  it('rejects bad version', () => {
    const bytes = Buffer.from(VECTOR_FULL_HEX, 'hex');
    bytes[4] = 2;
    expect(decodeDrp1(bytes)).toEqual({ ok: false, code: 'bad_version' });
  });

  it('rejects a tampered field-length byte', () => {
    const bytes = Buffer.from(VECTOR_FULL_HEX, 'hex');
    bytes[5] = 31;
    expect(decodeDrp1(bytes)).toEqual({ ok: false, code: 'bad_field_length' });
  });

  it('rejects a non-hex enrollmentAuthId', () => {
    const bytes = Buffer.from(VECTOR_FULL_HEX, 'hex');
    bytes[6] = 0x5a; // 'Z' — not lowercase hex
    expect(decodeDrp1(bytes)).toEqual({ ok: false, code: 'bad_field_format' });
  });
});

describe('ProvisioningTupleProofFrameV1 (PTP1)', () => {
  it('round-trips', () => {
    const frame = {
      securityDeviceId: Buffer.alloc(16, 0x09),
      oacIssuanceSessionId: 'sess-abc123',
      managerStaffId: 'staff-xyz789',
      nonce: Buffer.alloc(32, 0x44),
      devProofPublicKey: Buffer.alloc(32, 0x55),
      signature: Buffer.alloc(64, 0x66),
    };
    const decoded = decodePtp1(encodePtp1(frame));
    expect(decoded).toEqual({ ok: true, value: frame });
  });

  it('rejects truncated input', () => {
    expect(decodePtp1(Buffer.alloc(3))).toEqual({ ok: false, code: 'wrong_total_length' });
  });
});

describe('PinBindingFrameV1 (PIN1)', () => {
  it('round-trips', () => {
    const frame = {
      securityDeviceId: Buffer.alloc(16, 0x01),
      oacIssuanceSessionId: 'sess-1',
      managerStaffId: 'staff-1',
      verifierAlgo: 'argon2id',
      m: 65536,
      t: 3,
      p: 1,
      verifierSalt: Buffer.alloc(16, 0x02),
      verifier: Buffer.alloc(32, 0x03),
      pepperCommitment: Buffer.alloc(32, 0x04),
      devProofPublicKey: Buffer.alloc(32, 0x05),
      signature: Buffer.alloc(64, 0x06),
    };
    const decoded = decodePin1(encodePin1(frame));
    expect(decoded).toEqual({ ok: true, value: frame });
  });
});

describe('EnrollmentProofFrameV1 (ENR1)', () => {
  it('round-trips', () => {
    const frame = {
      enrollmentAuthId: '00112233445566778899aabbccddeeff',
      branchId: 'branch-001',
      issuedAtServerMs: 1_772_000_000_000,
      expiresAtServerMs: 1_772_000_600_000,
      issuerId: 'issuer-001',
      signature: Buffer.alloc(64, 0x07),
    };
    const decoded = decodeEnr1(encodeEnr1(frame));
    expect(decoded).toEqual({ ok: true, value: frame });
  });

  it('rejects a non-hex enrollmentAuthId at construction', () => {
    expect(() =>
      encodeEnr1({
        enrollmentAuthId: 'not-hex',
        branchId: 'b',
        issuedAtServerMs: 1,
        expiresAtServerMs: 2,
        issuerId: 'i',
        signature: Buffer.alloc(64),
      }),
    ).toThrow();
  });
});

describe('OacKeysetManifestFrameV1 (OKS1)', () => {
  it('round-trips a multi-key manifest', () => {
    const frame = {
      revocationEpoch: 7,
      generatedAtServerMs: 1_772_000_000_000,
      keys: [
        { signingKeyId: 'key-1', publicKey: Buffer.alloc(32, 0x08) },
        { signingKeyId: 'key-2', publicKey: Buffer.alloc(32, 0x09) },
      ],
      signature: Buffer.alloc(64, 0x0a),
    };
    const decoded = decodeOks1(encodeOks1(frame));
    expect(decoded).toEqual({ ok: true, value: frame });
  });

  it('rejects zero keys', () => {
    expect(() =>
      encodeOks1({ revocationEpoch: 0, generatedAtServerMs: 0, keys: [], signature: Buffer.alloc(64) }),
    ).toThrow();
  });
});

describe('LockoutClearTokenFrameV1 (LCT1)', () => {
  function canonicalLct1Vector(): LockoutClearTokenFrameV1 {
    return {
      securityDeviceId: Buffer.from(Array.from({ length: 16 }, (_, i) => 0x10 + i)),
      managerStaffId: 'mgr_001',
      lockoutId: Buffer.from(Array.from({ length: 32 }, (_, i) => 0x20 + i)),
      issuedAtServerMs: 1_700_000_000_000,
      expiresAtServerMs: 1_700_000_900_000,
      tokenNonce: Buffer.from(Array.from({ length: 32 }, (_, i) => 0x30 + i)),
      signingKeyId: 'key_001',
      signature: Buffer.from(Array.from({ length: 64 }, (_, i) => 0x40 + (i % 64))),
    };
  }

  it('encodes canonical vector to exact 181 bytes and matches literal parity hex (TS/Rust anchor)', () => {
    const frame = canonicalLct1Vector();
    const encoded = encodeLct1(frame);
    expect(encoded.length).toBe(181);
    expect(encoded.toString('hex')).toBe(LCT1_CANONICAL_PARITY_HEX);

    const prefix = lct1SignedPrefix(frame);
    expect(prefix.length).toBe(117);

    const fromHex = decodeLct1(Buffer.from(LCT1_CANONICAL_PARITY_HEX, 'hex'));
    expect(fromHex.ok).toBe(true);
    if (!fromHex.ok) throw new Error('unreachable');
    expect(fromHex.value.securityDeviceId.equals(frame.securityDeviceId)).toBe(true);
    expect(fromHex.value.managerStaffId).toBe(frame.managerStaffId);
    expect(fromHex.value.lockoutId.equals(frame.lockoutId)).toBe(true);
    expect(fromHex.value.issuedAtServerMs).toBe(frame.issuedAtServerMs);
    expect(fromHex.value.expiresAtServerMs).toBe(frame.expiresAtServerMs);
    expect(fromHex.value.tokenNonce.equals(frame.tokenNonce)).toBe(true);
    expect(fromHex.value.signingKeyId).toBe(frame.signingKeyId);
    expect(fromHex.value.signature.equals(frame.signature)).toBe(true);
  });

  it('rejects truncated bytes', () => {
    const frame = canonicalLct1Vector();
    const encoded = encodeLct1(frame);
    expect(decodeLct1(encoded.subarray(0, encoded.length - 1))).toEqual({ ok: false, code: 'wrong_total_length' });
  });

  it('rejects trailing bytes', () => {
    const frame = canonicalLct1Vector();
    const encoded = encodeLct1(frame);
    expect(decodeLct1(Buffer.concat([encoded, Buffer.from([0x00])]))).toEqual({
      ok: false,
      code: 'wrong_total_length',
    });
  });

  it('rejects bad magic', () => {
    const frame = canonicalLct1Vector();
    const encoded = encodeLct1(frame);
    encoded[0] = 0x58; // 'X'
    expect(decodeLct1(encoded)).toEqual({ ok: false, code: 'bad_magic' });
  });

  it('rejects bad version', () => {
    const frame = canonicalLct1Vector();
    const encoded = encodeLct1(frame);
    encoded[4] = 2;
    expect(decodeLct1(encoded)).toEqual({ ok: false, code: 'bad_version' });
  });

  it('strictly rejects invalid non-UTF8 bytes in identifiers with bad_field_format', () => {
    const frame = canonicalLct1Vector();
    const encoded = encodeLct1(frame);
    // Replace bytes in managerStaffId (offset 5 + 16 = 21 is length byte (7), bytes 22..28 are "mgr_001")
    // Set invalid UTF-8 byte 0xFF at byte 22
    const corrupted = Buffer.from(encoded);
    corrupted[22] = 0xff;
    expect(decodeLct1(corrupted)).toEqual({ ok: false, code: 'bad_field_format' });
  });

  it('rejects non-canonical identifiers', () => {
    const frame = canonicalLct1Vector();
    expect(() =>
      lct1SignedPrefix({ ...frame, managerStaffId: 'bad id with space' }),
    ).toThrow();
    expect(() =>
      lct1SignedPrefix({ ...frame, signingKeyId: 'k'.repeat(65) }),
    ).toThrow();
  });

  it('rejects timestamp inversion and oversized TTL', () => {
    const frame = canonicalLct1Vector();
    expect(() =>
      lct1SignedPrefix({ ...frame, expiresAtServerMs: frame.issuedAtServerMs - 1 }),
    ).toThrow();
    expect(() =>
      lct1SignedPrefix({ ...frame, expiresAtServerMs: frame.issuedAtServerMs }),
    ).toThrow();
    expect(() =>
      lct1SignedPrefix({
        ...frame,
        expiresAtServerMs: frame.issuedAtServerMs + LOCKOUT_CLEAR_TOKEN_TTL_MS + 1,
      }),
    ).toThrow();
  });
});
