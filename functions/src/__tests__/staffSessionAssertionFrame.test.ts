import { describe, it, expect } from 'vitest';
import {
  encodeSsa1,
  decodeSsa1,
  encodeSrf1,
  decodeSrf1,
  encodeSscp1,
  decodeSscp1,
  ssa1SignaturePreimage,
  srf1SignaturePreimage,
  sscp1SignedPrefix,
  SSCP1_PURPOSE_LOGIN,
  SSCP1_PURPOSE_REFRESH,
  SRF1_OBJECT_KIND_SSA1,
  SRF1_OBJECT_KIND_OAC,
  StaffSessionAssertionFrameV1,
  ServerReceiptFrameV1,
  StaffSessionDeviceChallengeProofV1,
  encodeEfr1,
  decodeEfr1,
  efr1SignaturePreimage,
  efr1SignedPrefix,
  EFR1_OP_INITIAL_ENROLLMENT,
  EFR1_OP_RE_ENROLLMENT,
  EnrollmentFinalizationReceiptFrameV1,
} from '../staffSessionAssertionFrame';

describe('StaffSessionAssertionFrame wire codecs', () => {
  describe('SSA1', () => {
    it('round trips valid frame', () => {
      const frame: StaffSessionAssertionFrameV1 = {
        ssa1Id: 'SSA-01',
        staffId: 'STAFF-1',
        securityDeviceId: Buffer.alloc(16, 0x11),
        branchId: 'B-HQ',
        authVersionAtIssue: 1,
        issuedAtServerMs: 1_700_000_000_000,
        expiresAtServerMs: 1_700_086_400_000,
        signingKeyId: 'KEY-01',
        signature: Buffer.alloc(64, 0x99),
      };

      const encoded = encodeSsa1(frame);
      const decoded = decodeSsa1(encoded);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value).toEqual(frame);
      }
    });

    it('rejects invalid timestamps', () => {
      const frame: StaffSessionAssertionFrameV1 = {
        ssa1Id: 'SSA-01',
        staffId: 'STAFF-1',
        securityDeviceId: Buffer.alloc(16, 0x11),
        branchId: 'B-HQ',
        authVersionAtIssue: 1,
        issuedAtServerMs: 2000,
        expiresAtServerMs: 1000, // expired before issue
        signingKeyId: 'KEY-01',
        signature: Buffer.alloc(64, 0x99),
      };
      expect(() => encodeSsa1(frame)).toThrow();
    });

    it('preimage starts with TWINPET_SSA1_V1:', () => {
      const frame = {
        ssa1Id: 'SSA-01',
        staffId: 'STAFF-1',
        securityDeviceId: Buffer.alloc(16, 0x11),
        branchId: 'B-HQ',
        authVersionAtIssue: 1,
        issuedAtServerMs: 1000,
        expiresAtServerMs: 2000,
        signingKeyId: 'KEY-01',
      };
      const preimage = ssa1SignaturePreimage(frame);
      expect(preimage.toString('ascii', 0, 16)).toBe('TWINPET_SSA1_V1:');
    });
  });

  describe('SRF1', () => {
    it('round trips valid frame', () => {
      const frame: ServerReceiptFrameV1 = {
        challengeNonce: Buffer.alloc(32, 0x22),
        securityDeviceId: Buffer.alloc(16, 0x33),
        branchId: 'B-BRANCH',
        objectKind: SRF1_OBJECT_KIND_SSA1,
        objectDigest: Buffer.alloc(32, 0x44),
        serverSentAtMs: 1_700_000_005_000,
        signingKeyId: 'KEY-01',
        signature: Buffer.alloc(64, 0x88),
      };

      const encoded = encodeSrf1(frame);
      const decoded = decodeSrf1(encoded);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value).toEqual(frame);
      }
    });

    it('preimage starts with TWINPET_SRF1_V1:', () => {
      const frame = {
        challengeNonce: Buffer.alloc(32, 0x22),
        securityDeviceId: Buffer.alloc(16, 0x33),
        branchId: 'B-BRANCH',
        objectKind: SRF1_OBJECT_KIND_OAC,
        objectDigest: Buffer.alloc(32, 0x44),
        serverSentAtMs: 1000,
        signingKeyId: 'KEY-01',
      };
      const preimage = srf1SignaturePreimage(frame);
      expect(preimage.toString('ascii', 0, 16)).toBe('TWINPET_SRF1_V1:');
    });
  });

  describe('SSCP1', () => {
    it('round trips valid frame', () => {
      const frame: StaffSessionDeviceChallengeProofV1 = {
        purpose: SSCP1_PURPOSE_LOGIN,
        challengeNonce: Buffer.alloc(32, 0x55),
        securityDeviceId: Buffer.alloc(16, 0x66),
        deviceKeyVersion: 1,
        branchId: 'B-LDP',
        challengeGeneration: BigInt(42),
        intendedStaffId: 'STAFF-123',
        signature: Buffer.alloc(64, 0x77),
      };

      const encoded = encodeSscp1(frame);
      const decoded = decodeSscp1(encoded);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value).toEqual(frame);
      }
    });

    it('supports empty intendedStaffId for purpose if needed', () => {
      const frame: StaffSessionDeviceChallengeProofV1 = {
        purpose: SSCP1_PURPOSE_REFRESH,
        challengeNonce: Buffer.alloc(32, 0x55),
        securityDeviceId: Buffer.alloc(16, 0x66),
        deviceKeyVersion: 2,
        branchId: 'B-LDP',
        challengeGeneration: BigInt(1),
        intendedStaffId: '',
        signature: Buffer.alloc(64, 0x77),
      };

      const encoded = encodeSscp1(frame);
      const decoded = decodeSscp1(encoded);
      expect(decoded.ok).toBe(true);
    });

    const SSCP1_GOLDEN_HEX =
      '535343500101111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222010000000a006272616e63682d3030312a00000000000000090073746166662d39393933333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333';
    const SSCP1_PREIMAGE_GOLDEN_HEX =
      '535343500101111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222010000000a006272616e63682d3030312a00000000000000090073746166662d393939';
    const SSA1_GOLDEN_HEX =
      '535341310120006131623263336434653566363037313832393361346235633664376538663930090073746166662d313233444444444444444444444444444444440a006272616e63682d30303102000000a086010000000000a0e22705000000000c006b65792d6163746976652d3155555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555555';
    const SSA1_PREIMAGE_GOLDEN_HEX =
      '5457494e5045545f535341315f56313a535341310120006131623263336434653566363037313832393361346235633664376538663930090073746166662d313233444444444444444444444444444444440a006272616e63682d30303102000000a086010000000000a0e22705000000000c006b65792d6163746976652d31';
    const SRF1_GOLDEN_HEX =
      '53524631016666666666666666666666666666666666666666666666666666666666666666777777777777777777777777777777770a006272616e63682d303031018888888888888888888888888888888888888888888888888888888888888888400d0300000000000c006b65792d6163746976652d3199999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999';
    const SRF1_PREIMAGE_GOLDEN_HEX =
      '5457494e5045545f535246315f56313a53524631016666666666666666666666666666666666666666666666666666666666666666777777777777777777777777777777770a006272616e63682d303031018888888888888888888888888888888888888888888888888888888888888888400d0300000000000c006b65792d6163746976652d31';
    const EFR1_GOLDEN_HEX =
      '454652310101aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01000000cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccceeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0930400000000000a006272616e63682d3030310c006b65792d6163746976652d31dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
    const EFR1_PREIMAGE_GOLDEN_HEX =
      '5457494e5045545f454652315f56313a454652310101aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb01000000cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccceeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0930400000000000a006272616e63682d3030310c006b65792d6163746976652d31';

    it('matches literal golden byte vectors exactly across TS and Rust', () => {
      const sscp1Frame: StaffSessionDeviceChallengeProofV1 = {
        purpose: SSCP1_PURPOSE_LOGIN,
        challengeNonce: Buffer.alloc(32, 0x11),
        securityDeviceId: Buffer.alloc(16, 0x22),
        deviceKeyVersion: 1,
        branchId: 'branch-001',
        challengeGeneration: BigInt(42),
        intendedStaffId: 'staff-999',
        signature: Buffer.alloc(64, 0x33),
      };

      const sscp1Encoded = encodeSscp1(sscp1Frame);
      expect(sscp1Encoded.toString('hex')).toBe(SSCP1_GOLDEN_HEX);
      expect(sscp1SignedPrefix(sscp1Frame).toString('hex')).toBe(SSCP1_PREIMAGE_GOLDEN_HEX);
      const sscp1Decoded = decodeSscp1(Buffer.from(SSCP1_GOLDEN_HEX, 'hex'));
      expect(sscp1Decoded.ok).toBe(true);
      if (sscp1Decoded.ok) {
        expect(sscp1Decoded.value).toEqual(sscp1Frame);
      }

      const ssa1Frame: StaffSessionAssertionFrameV1 = {
        ssa1Id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        staffId: 'staff-123',
        securityDeviceId: Buffer.alloc(16, 0x44),
        branchId: 'branch-001',
        authVersionAtIssue: 2,
        issuedAtServerMs: 100_000,
        expiresAtServerMs: 100_000 + 86_400_000,
        signingKeyId: 'key-active-1',
        signature: Buffer.alloc(64, 0x55),
      };
      const ssa1Encoded = encodeSsa1(ssa1Frame);
      expect(ssa1Encoded.toString('hex')).toBe(SSA1_GOLDEN_HEX);
      expect(ssa1SignaturePreimage(ssa1Frame).toString('hex')).toBe(SSA1_PREIMAGE_GOLDEN_HEX);
      const ssa1Decoded = decodeSsa1(Buffer.from(SSA1_GOLDEN_HEX, 'hex'));
      expect(ssa1Decoded.ok).toBe(true);
      if (ssa1Decoded.ok) {
        expect(ssa1Decoded.value).toEqual(ssa1Frame);
      }

      const srf1Frame: ServerReceiptFrameV1 = {
        challengeNonce: Buffer.alloc(32, 0x66),
        securityDeviceId: Buffer.alloc(16, 0x77),
        branchId: 'branch-001',
        objectKind: SRF1_OBJECT_KIND_SSA1,
        objectDigest: Buffer.alloc(32, 0x88),
        serverSentAtMs: 200_000,
        signingKeyId: 'key-active-1',
        signature: Buffer.alloc(64, 0x99),
      };
      const srf1Encoded = encodeSrf1(srf1Frame);
      expect(srf1Encoded.toString('hex')).toBe(SRF1_GOLDEN_HEX);
      expect(srf1SignaturePreimage(srf1Frame).toString('hex')).toBe(SRF1_PREIMAGE_GOLDEN_HEX);
      const srf1Decoded = decodeSrf1(Buffer.from(SRF1_GOLDEN_HEX, 'hex'));
      expect(srf1Decoded.ok).toBe(true);
      if (srf1Decoded.ok) {
        expect(srf1Decoded.value).toEqual(srf1Frame);
      }

      const efr1Frame: EnrollmentFinalizationReceiptFrameV1 = {
        operationKind: EFR1_OP_INITIAL_ENROLLMENT,
        enrollmentGenerationId: Buffer.alloc(16, 0xaa),
        securityDeviceId: Buffer.alloc(16, 0xbb),
        deviceKeyVersion: 1,
        acceptedPublicKey: Buffer.alloc(32, 0xcc),
        receiptNonce: Buffer.alloc(32, 0xee),
        serverSentAtMs: 300_000,
        branchId: 'branch-001',
        signingKeyId: 'key-active-1',
        signature: Buffer.alloc(64, 0xdd),
      };
      const efr1Encoded = encodeEfr1(efr1Frame);
      expect(efr1Encoded.toString('hex')).toBe(EFR1_GOLDEN_HEX);
      expect(efr1SignaturePreimage(efr1Frame).toString('hex')).toBe(EFR1_PREIMAGE_GOLDEN_HEX);
      const efr1Decoded = decodeEfr1(Buffer.from(EFR1_GOLDEN_HEX, 'hex'));
      expect(efr1Decoded.ok).toBe(true);
      if (efr1Decoded.ok) {
        expect(efr1Decoded.value).toEqual(efr1Frame);
      }
    });

    it('enforces 1500-byte identifier boundary strictly', () => {
      const id64 = 'a'.repeat(64);
      const id65 = 'a'.repeat(65);
      const id1499 = 'a'.repeat(1499);
      const id1500 = 'a'.repeat(1500);
      const id1501 = 'a'.repeat(1501);

      const makeFrame = (branchId: string, intendedStaffId: string): StaffSessionDeviceChallengeProofV1 => ({
        purpose: SSCP1_PURPOSE_LOGIN,
        challengeNonce: Buffer.alloc(32, 0x11),
        securityDeviceId: Buffer.alloc(16, 0x22),
        deviceKeyVersion: 1,
        branchId,
        challengeGeneration: BigInt(1),
        intendedStaffId,
        signature: Buffer.alloc(64, 0x33),
      });

      expect(() => encodeSscp1(makeFrame(id64, id64))).not.toThrow();
      expect(() => encodeSscp1(makeFrame(id65, id65))).not.toThrow();
      expect(() => encodeSscp1(makeFrame(id1499, id1499))).not.toThrow();
      expect(() => encodeSscp1(makeFrame(id1500, id1500))).not.toThrow();

      expect(() => encodeSscp1(makeFrame(id1501, id1500))).toThrow();
      expect(() => encodeSscp1(makeFrame(id1500, id1501))).toThrow();
      expect(() => encodeSscp1(makeFrame('', id1500))).toThrow();
      expect(() => encodeSscp1(makeFrame('invalid id!', id1500))).toThrow();
    });
  });
});
