import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildSignedSsa1,
  buildSignedSrf1ForSsa1,
  validateCallerStaffIdentity,
  validateDeviceForSession,
  SSA1_LIFETIME_MS,
  type LiveStaffUserRecord,
  type LiveDeviceRecord,
} from '../staffSessionIssuerCore';
import {
  decodeSsa1,
  decodeSrf1,
  SSCP1_PURPOSE_LOGIN,
  SSCP1_PURPOSE_REFRESH,
  SRF1_OBJECT_KIND_SSA1,
  type StaffSessionDeviceChallengeProofV1,
} from '../staffSessionAssertionFrame';
import { privateKeyFromRaw, publicKeyFromRaw } from '../signingKeyLoader';
import { verify as ed25519Verify } from 'node:crypto';
import { ssa1SignaturePreimage, srf1SignaturePreimage } from '../staffSessionAssertionFrame';

function rawKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const d = (privateKey.export({ format: 'jwk' }) as { d: string }).d;
  return { publicKeyBase64Url: x, privateKeyBase64Url: d };
}

describe('staffSessionIssuerCore', () => {
  describe('validateCallerStaffIdentity', () => {
    const validUser: LiveStaffUserRecord = {
      staffId: 'staff-1',
      isActive: true,
      deletedAt: null,
      authVersion: 2,
      branchId: 'B-HQ',
    };

    it('accepts a valid, active user with matching branch and authVersion', () => {
      const res = validateCallerStaffIdentity(validUser, 'staff-1', 2, 'B-HQ');
      expect(res).toEqual({ ok: true });
    });

    it('rejects if user is inactive', () => {
      const res = validateCallerStaffIdentity({ ...validUser, isActive: false }, 'staff-1', 2, 'B-HQ');
      expect(res).toEqual({ ok: false, code: 'staff_inactive' });
    });

    it('rejects if user is soft deleted', () => {
      const res = validateCallerStaffIdentity({ ...validUser, deletedAt: 12345 }, 'staff-1', 2, 'B-HQ');
      expect(res).toEqual({ ok: false, code: 'staff_inactive' });
    });

    it('rejects if authVersion does not match', () => {
      const res = validateCallerStaffIdentity(validUser, 'staff-1', 1, 'B-HQ');
      expect(res).toEqual({ ok: false, code: 'staff_auth_version_mismatch' });
    });

    it('rejects if branch does not match', () => {
      const res = validateCallerStaffIdentity(validUser, 'staff-1', 2, 'B-OTHER');
      expect(res).toEqual({ ok: false, code: 'staff_branch_mismatch' });
    });

    it('rejects missing or non-finite token authVersion', () => {
      expect(validateCallerStaffIdentity(validUser, 'staff-1', undefined as any, 'B-HQ')).toEqual({
        ok: false,
        code: 'staff_auth_version_mismatch',
      });
      expect(validateCallerStaffIdentity(validUser, 'staff-1', NaN as any, 'B-HQ')).toEqual({
        ok: false,
        code: 'staff_auth_version_mismatch',
      });
      expect(validateCallerStaffIdentity(validUser, 'staff-1', 1.5 as any, 'B-HQ')).toEqual({
        ok: false,
        code: 'staff_auth_version_mismatch',
      });
    });

    it('rejects missing or non-finite live authVersion', () => {
      expect(validateCallerStaffIdentity({ ...validUser, authVersion: undefined as any }, 'staff-1', 2, 'B-HQ')).toEqual({
        ok: false,
        code: 'staff_auth_version_mismatch',
      });
      expect(validateCallerStaffIdentity({ ...validUser, authVersion: NaN as any }, 'staff-1', 2, 'B-HQ')).toEqual({
        ok: false,
        code: 'staff_auth_version_mismatch',
      });
    });

    it('rejects branchIds=["B-A"] targeting B-B', () => {
      const crossBranchUser: LiveStaffUserRecord = {
        ...validUser,
        branchId: undefined,
        branchIds: ['B-A'],
      };
      expect(validateCallerStaffIdentity(crossBranchUser, 'staff-1', 2, 'B-B')).toEqual({
        ok: false,
        code: 'staff_branch_mismatch',
      });
    });

    it('accepts branchIds=["ALL"]', () => {
      const allBranchUser: LiveStaffUserRecord = {
        ...validUser,
        branchId: undefined,
        branchIds: ['ALL'],
      };
      expect(validateCallerStaffIdentity(allBranchUser, 'staff-1', 2, 'B-B')).toEqual({
        ok: true,
      });
    });
  });

  describe('validateDeviceForSession', () => {
    const validDevice: LiveDeviceRecord = {
      securityDeviceIdHex: '11'.repeat(16),
      status: 'ACTIVE',
      deviceKeyVersion: 1,
      branchId: 'B-HQ',
      validatedDevProofPublicKeyBase64: 'pub',
    };

    const validProof: StaffSessionDeviceChallengeProofV1 = {
      purpose: SSCP1_PURPOSE_LOGIN,
      challengeNonce: Buffer.alloc(32, 0x11),
      securityDeviceId: Buffer.alloc(16, 0x11),
      deviceKeyVersion: 1,
      branchId: 'B-HQ',
      challengeGeneration: BigInt(1),
      intendedStaffId: 'staff-1',
      signature: Buffer.alloc(64, 0x22),
    };

    it('accepts matching device and proof', () => {
      const res = validateDeviceForSession(validDevice, validProof, SSCP1_PURPOSE_LOGIN, 'staff-1');
      expect(res).toEqual({ ok: true });
    });

    it('rejects purpose mismatch', () => {
      const res = validateDeviceForSession(validDevice, validProof, SSCP1_PURPOSE_REFRESH, 'staff-1');
      expect(res).toEqual({ ok: false, code: 'sscp1_purpose_mismatch' });
    });

    it('rejects staff mismatch', () => {
      const res = validateDeviceForSession(validDevice, validProof, SSCP1_PURPOSE_LOGIN, 'staff-2');
      expect(res).toEqual({ ok: false, code: 'sscp1_staff_mismatch' });
    });

    it('rejects deviceKeyVersion mismatch', () => {
      const res = validateDeviceForSession(
        { ...validDevice, deviceKeyVersion: 2 },
        validProof,
        SSCP1_PURPOSE_LOGIN,
        'staff-1',
      );
      expect(res).toEqual({ ok: false, code: 'device_key_version_mismatch' });
    });

    it('rejects missing or non-ACTIVE device status', () => {
      expect(
        validateDeviceForSession(
          { ...validDevice, status: undefined as any },
          validProof,
          SSCP1_PURPOSE_LOGIN,
          'staff-1',
        ),
      ).toEqual({ ok: false, code: 'device_not_active' });
      expect(
        validateDeviceForSession(
          { ...validDevice, status: 'SUSPENDED' as any },
          validProof,
          SSCP1_PURPOSE_LOGIN,
          'staff-1',
        ),
      ).toEqual({ ok: false, code: 'device_not_active' });
    });

    it('rejects missing or non-positive deviceKeyVersion', () => {
      expect(
        validateDeviceForSession(
          { ...validDevice, deviceKeyVersion: undefined as any },
          validProof,
          SSCP1_PURPOSE_LOGIN,
          'staff-1',
        ),
      ).toEqual({ ok: false, code: 'device_key_version_mismatch' });
      expect(
        validateDeviceForSession(
          { ...validDevice, deviceKeyVersion: 0 },
          validProof,
          SSCP1_PURPOSE_LOGIN,
          'staff-1',
        ),
      ).toEqual({ ok: false, code: 'device_key_version_mismatch' });
      expect(
        validateDeviceForSession(
          { ...validDevice, deviceKeyVersion: -1 },
          validProof,
          SSCP1_PURPOSE_LOGIN,
          'staff-1',
        ),
      ).toEqual({ ok: false, code: 'device_key_version_mismatch' });
    });

    it('rejects device branch mismatch', () => {
      const res = validateDeviceForSession(
        { ...validDevice, branchId: 'B-OTHER' },
        validProof,
        SSCP1_PURPOSE_LOGIN,
        'staff-1',
      );
      expect(res).toEqual({ ok: false, code: 'device_branch_mismatch' });
    });
  });

  describe('SSA1 and SRF1 minting and verification', () => {
    it('mints verifiable SSA1 and SRF1 bound to each other', () => {
      const key = rawKeypair();
      const priv = privateKeyFromRaw(key.publicKeyBase64Url, key.privateKeyBase64Url);
      const pub = publicKeyFromRaw(key.publicKeyBase64Url);

      const nowMs = 1_700_000_000_000;
      const secDevId = Buffer.alloc(16, 0x77);
      const nonce = Buffer.alloc(32, 0x88);

      const { ssa1, ssa1Bytes } = buildSignedSsa1('staff-1', secDevId, 'B-HQ', 1, nowMs, 'KEY-01', priv);
      expect(ssa1.expiresAtServerMs).toBe(nowMs + SSA1_LIFETIME_MS);

      const decodedSsa1 = decodeSsa1(ssa1Bytes);
      expect(decodedSsa1.ok).toBe(true);
      if (!decodedSsa1.ok) throw new Error('fail');

      const ssa1Preimage = ssa1SignaturePreimage(decodedSsa1.value);
      expect(ed25519Verify(null, ssa1Preimage, pub, decodedSsa1.value.signature)).toBe(true);

      const { srf1, srf1Bytes } = buildSignedSrf1ForSsa1(nonce, secDevId, 'B-HQ', ssa1Bytes, nowMs, 'KEY-01', priv);
      const decodedSrf1 = decodeSrf1(srf1Bytes);
      expect(decodedSrf1.ok).toBe(true);
      if (!decodedSrf1.ok) throw new Error('fail');
      expect(decodedSrf1.value.objectKind).toBe(SRF1_OBJECT_KIND_SSA1);

      const srf1Preimage = srf1SignaturePreimage(decodedSrf1.value);
      expect(ed25519Verify(null, srf1Preimage, pub, decodedSrf1.value.signature)).toBe(true);
    });
  });
});
