import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, verify as ed25519Verify } from 'node:crypto';
import {
  buildAndSignLct1,
  buildLct1Response,
  LOCKOUT_CLEAR_TOKEN_TTL_MS,
  validateIssueLockoutClearRequest,
} from '../issuePrivilegedLockoutClearCore';
import { decodeLct1, lct1SignedPrefix } from '../oacFrame';

const VALID_DEV_ID = '0123456789abcdef0123456789abcdef';
const VALID_LOCKOUT_ID = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const VALID_STAFF_ID = 'mgr_123';

describe('issuePrivilegedLockoutClearCore', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  describe('validateIssueLockoutClearRequest', () => {
    it('accepts valid request', () => {
      const result = validateIssueLockoutClearRequest({
        securityDeviceIdHex: VALID_DEV_ID,
        managerStaffId: VALID_STAFF_ID,
        lockoutIdHex: VALID_LOCKOUT_ID,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.securityDeviceIdHex).toBe(VALID_DEV_ID);
      expect(result.value.managerStaffId).toBe(VALID_STAFF_ID);
      expect(result.value.lockoutIdHex).toBe(VALID_LOCKOUT_ID);
    });

    it('rejects null or non-object', () => {
      expect(validateIssueLockoutClearRequest(null)).toEqual({ ok: false, code: 'invalid_request_shape' });
      expect(validateIssueLockoutClearRequest('string')).toEqual({ ok: false, code: 'invalid_request_shape' });
    });

    it('rejects invalid securityDeviceIdHex length or chars', () => {
      expect(
        validateIssueLockoutClearRequest({
          securityDeviceIdHex: 'not-hex',
          managerStaffId: VALID_STAFF_ID,
          lockoutIdHex: VALID_LOCKOUT_ID,
        }),
      ).toEqual({ ok: false, code: 'invalid_request_shape' });

      expect(
        validateIssueLockoutClearRequest({
          securityDeviceIdHex: VALID_DEV_ID + '00',
          managerStaffId: VALID_STAFF_ID,
          lockoutIdHex: VALID_LOCKOUT_ID,
        }),
      ).toEqual({ ok: false, code: 'invalid_request_shape' });
    });

    it('rejects empty or whitespace managerStaffId', () => {
      expect(
        validateIssueLockoutClearRequest({
          securityDeviceIdHex: VALID_DEV_ID,
          managerStaffId: '   ',
          lockoutIdHex: VALID_LOCKOUT_ID,
        }),
      ).toEqual({ ok: false, code: 'invalid_request_shape' });
    });

    it('rejects non-canonical managerStaffId with spaces, symbols, or over 64 chars', () => {
      expect(
        validateIssueLockoutClearRequest({
          securityDeviceIdHex: VALID_DEV_ID,
          managerStaffId: 'mgr 123',
          lockoutIdHex: VALID_LOCKOUT_ID,
        }),
      ).toEqual({ ok: false, code: 'invalid_request_shape' });

      expect(
        validateIssueLockoutClearRequest({
          securityDeviceIdHex: VALID_DEV_ID,
          managerStaffId: 'mgr@admin',
          lockoutIdHex: VALID_LOCKOUT_ID,
        }),
      ).toEqual({ ok: false, code: 'invalid_request_shape' });

      expect(
        validateIssueLockoutClearRequest({
          securityDeviceIdHex: VALID_DEV_ID,
          managerStaffId: 'm'.repeat(65),
          lockoutIdHex: VALID_LOCKOUT_ID,
        }),
      ).toEqual({ ok: false, code: 'invalid_request_shape' });
    });

    it('rejects invalid lockoutIdHex', () => {
      expect(
        validateIssueLockoutClearRequest({
          securityDeviceIdHex: VALID_DEV_ID,
          managerStaffId: VALID_STAFF_ID,
          lockoutIdHex: 'short',
        }),
      ).toEqual({ ok: false, code: 'invalid_request_shape' });
    });
  });

  describe('buildAndSignLct1 and buildLct1Response', () => {
    it('constructs, signs, and decodes LCT1 successfully', () => {
      const nowMs = 1_700_000_000_000;
      const frame = buildAndSignLct1({
        securityDeviceIdHex: VALID_DEV_ID,
        managerStaffId: VALID_STAFF_ID,
        lockoutIdHex: VALID_LOCKOUT_ID,
        signingKeyId: 'signing_key_001',
        privateKey,
        nowMs,
      });

      expect(frame.securityDeviceId.toString('hex')).toBe(VALID_DEV_ID);
      expect(frame.managerStaffId).toBe(VALID_STAFF_ID);
      expect(frame.lockoutId.toString('hex')).toBe(VALID_LOCKOUT_ID);
      expect(frame.issuedAtServerMs).toBe(nowMs);
      expect(frame.expiresAtServerMs).toBe(nowMs + LOCKOUT_CLEAR_TOKEN_TTL_MS);
      expect(frame.signingKeyId).toBe('signing_key_001');
      expect(frame.signature.length).toBe(64);

      // Verify Ed25519 signature
      const payload = lct1SignedPrefix(frame);
      const isValid = ed25519Verify(null, payload, publicKey, frame.signature);
      expect(isValid).toBe(true);

      // Verify response formatting and decode
      const res = buildLct1Response(frame);
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      expect(res.securityDeviceIdHex).toBe(VALID_DEV_ID);
      expect(res.managerStaffId).toBe(VALID_STAFF_ID);
      expect(res.lockoutIdHex).toBe(VALID_LOCKOUT_ID);

      const decoded = decodeLct1(Buffer.from(res.lct1Base64, 'base64'));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) throw new Error('unreachable');
      expect(decoded.value.managerStaffId).toBe(VALID_STAFF_ID);
      expect(decoded.value.lockoutId.toString('hex')).toBe(VALID_LOCKOUT_ID);
    });
  });
});
