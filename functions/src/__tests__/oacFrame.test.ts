import { describe, expect, it } from 'vitest';
import {
  DRP1_TOTAL_BYTES,
  decodeDrp1,
  decodeEnr1,
  decodeOks1,
  decodePin1,
  decodePtp1,
  encodeDrp1,
  encodeEnr1,
  encodeOks1,
  encodePin1,
  encodePtp1,
  type DeviceRegistrationPossessionFrameV1,
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
