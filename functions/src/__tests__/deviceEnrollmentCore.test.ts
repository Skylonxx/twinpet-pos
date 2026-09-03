import { describe, expect, it } from 'vitest';
import {
  buildDeviceRegistrationSession,
  buildEnrollmentAuthorization,
  buildValidatedDeviceRegistration,
  checkDeviceRegistrationSession,
  checkDrp1NonceBinding,
  checkEnrollmentAuthorizationForIssuance,
  checkEnrollmentAuthorizationForRegistration,
  isValidBranchId,
  type EnrollmentAuthorizationRecord,
  type DeviceRegistrationSessionRecord,
} from '../deviceEnrollmentCore';
import type { DeviceRegistrationPossessionFrameV1 } from '../oacFrame';

describe('isValidBranchId', () => {
  it('accepts a normal branch id', () => expect(isValidBranchId('LDP-001')).toBe(true));
  it('rejects the reserved ALL sentinel', () => expect(isValidBranchId('ALL')).toBe(false));
  it('rejects empty/invalid ids', () => {
    expect(isValidBranchId('')).toBe(false);
    expect(isValidBranchId('has space')).toBe(false);
  });
});

describe('buildEnrollmentAuthorization', () => {
  it('mints a 32-lowercase-hex enrollmentAuthId', () => {
    const rec = buildEnrollmentAuthorization('LDP-001', 'issuer-1', 1000, Buffer.alloc(16, 0xab));
    expect(rec.enrollmentAuthId).toMatch(/^[0-9a-f]{32}$/);
    expect(rec.status).toBe('PENDING');
    expect(rec.expiresAtServerMs).toBe(1000 + 30 * 60 * 1000);
  });

  it('rejects an invalid branchId', () => {
    expect(() => buildEnrollmentAuthorization('ALL', 'issuer-1', 1, Buffer.alloc(16))).toThrow();
  });
});

describe('checkEnrollmentAuthorizationForIssuance', () => {
  const base: EnrollmentAuthorizationRecord = {
    enrollmentAuthId: 'a'.repeat(32),
    branchId: 'LDP-001',
    issuerId: 'issuer-1',
    status: 'PENDING',
    createdAtServerMs: 0,
    expiresAtServerMs: 10_000,
    issuedAtServerMs: null,
    consumedAtServerMs: null,
  };

  it('accepts a matching pending record', () => {
    expect(checkEnrollmentAuthorizationForIssuance(base, 'issuer-1', 5000)).toEqual({ ok: true });
  });
  it('rejects missing record', () => {
    expect(checkEnrollmentAuthorizationForIssuance(null, 'issuer-1', 1)).toEqual({
      ok: false,
      code: 'authorization_not_found',
    });
  });
  it('rejects wrong issuer', () => {
    expect(checkEnrollmentAuthorizationForIssuance(base, 'someone-else', 1)).toEqual({
      ok: false,
      code: 'authorization_issuer_mismatch',
    });
  });
  it('rejects wrong status', () => {
    expect(checkEnrollmentAuthorizationForIssuance({ ...base, status: 'ISSUED' }, 'issuer-1', 1)).toEqual({
      ok: false,
      code: 'authorization_wrong_status',
    });
  });
  it('rejects expired', () => {
    expect(checkEnrollmentAuthorizationForIssuance(base, 'issuer-1', 99_999)).toEqual({
      ok: false,
      code: 'authorization_expired',
    });
  });
});

describe('device registration session', () => {
  it('builds a session with a 32-byte nonce', () => {
    const session = buildDeviceRegistrationSession('uid-1', 1000, Buffer.alloc(16, 1), Buffer.alloc(32, 2));
    expect(session.deviceRegistrationNonce.length).toBe(32);
    expect(session.registrationSessionId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('checkDeviceRegistrationSession accepts a fresh, owned, pending session', () => {
    const session = buildDeviceRegistrationSession('uid-1', 1000, Buffer.alloc(16, 1), Buffer.alloc(32, 2));
    expect(checkDeviceRegistrationSession(session, 'uid-1', 2000)).toEqual({ ok: true });
  });

  it('checkDeviceRegistrationSession rejects a different requester', () => {
    const session = buildDeviceRegistrationSession('uid-1', 1000, Buffer.alloc(16, 1), Buffer.alloc(32, 2));
    expect(checkDeviceRegistrationSession(session, 'uid-2', 2000)).toEqual({
      ok: false,
      code: 'session_wrong_owner',
    });
  });

  it('checkDeviceRegistrationSession rejects an expired session', () => {
    const session = buildDeviceRegistrationSession('uid-1', 1000, Buffer.alloc(16, 1), Buffer.alloc(32, 2));
    expect(checkDeviceRegistrationSession(session, 'uid-1', 99_999_999)).toEqual({
      ok: false,
      code: 'session_expired',
    });
  });

  it('checkDeviceRegistrationSession rejects a null session', () => {
    expect(checkDeviceRegistrationSession(null, 'uid-1', 1)).toEqual({ ok: false, code: 'session_not_found' });
  });

  it('checkDrp1NonceBinding accepts a matching nonce and rejects a mismatched one', () => {
    const session: DeviceRegistrationSessionRecord = buildDeviceRegistrationSession(
      'uid-1',
      1000,
      Buffer.alloc(16, 1),
      Buffer.alloc(32, 2),
    );
    const matchingDrp1 = { deviceRegistrationNonce: Buffer.alloc(32, 2) } as DeviceRegistrationPossessionFrameV1;
    const mismatchedDrp1 = { deviceRegistrationNonce: Buffer.alloc(32, 9) } as DeviceRegistrationPossessionFrameV1;
    expect(checkDrp1NonceBinding(matchingDrp1, session)).toEqual({ ok: true });
    expect(checkDrp1NonceBinding(mismatchedDrp1, session)).toEqual({ ok: false, code: 'drp1_nonce_mismatch' });
  });
});

describe('checkEnrollmentAuthorizationForRegistration', () => {
  const issued: EnrollmentAuthorizationRecord = {
    enrollmentAuthId: 'a'.repeat(32),
    branchId: 'LDP-001',
    issuerId: 'issuer-1',
    status: 'ISSUED',
    createdAtServerMs: 0,
    expiresAtServerMs: 10_000,
    issuedAtServerMs: 100,
    consumedAtServerMs: null,
  };

  it('accepts an ISSUED, unexpired authorization', () => {
    expect(checkEnrollmentAuthorizationForRegistration(issued, 'LDP-001', 5000)).toEqual({ ok: true });
  });
  it('rejects a PENDING (not yet issued) authorization', () => {
    expect(checkEnrollmentAuthorizationForRegistration({ ...issued, status: 'PENDING' }, null, 1)).toEqual({
      ok: false,
      code: 'enrollment_authorization_wrong_status',
    });
  });
  it('rejects a branch mismatch', () => {
    expect(checkEnrollmentAuthorizationForRegistration(issued, 'OTHER-BRANCH', 5000)).toEqual({
      ok: false,
      code: 'enrollment_authorization_branch_mismatch',
    });
  });
  it('rejects an expired authorization', () => {
    expect(checkEnrollmentAuthorizationForRegistration(issued, null, 99_999)).toEqual({
      ok: false,
      code: 'enrollment_authorization_expired',
    });
  });
});

describe('buildValidatedDeviceRegistration', () => {
  it('extracts the exact fields named in the C-A allowlist', () => {
    const drp1 = {
      securityDeviceId: Buffer.alloc(16, 0xaa),
      devProofPublicKey: Buffer.alloc(32, 0xbb),
      deviceRegistrationNonce: Buffer.alloc(32, 0xcc),
    } as DeviceRegistrationPossessionFrameV1;
    const record = buildValidatedDeviceRegistration(drp1, 'LDP-001', 1000);
    expect(record.securityDeviceIdHex).toBe(Buffer.alloc(16, 0xaa).toString('hex'));
    expect(record.validatedSecurityDeviceId).toBe(Buffer.alloc(16, 0xaa).toString('base64'));
    expect(record.validatedDevProofPublicKeyBase64).toBe(Buffer.alloc(32, 0xbb).toString('base64'));
    expect(record.devProofRegistrationNonce).toBe(Buffer.alloc(32, 0xcc).toString('base64'));
    expect(record.branchId).toBe('LDP-001');
  });
});
