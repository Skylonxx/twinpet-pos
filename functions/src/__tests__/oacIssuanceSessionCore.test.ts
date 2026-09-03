import { describe, expect, it } from 'vitest';
import {
  buildOacIssuanceSession,
  buildUnsignedOac,
  checkOacIssuanceSession,
  checkTupleBinding,
  pin1Tuple,
  ptp1Tuple,
  type OacIssuanceSessionRecord,
} from '../oacIssuanceSessionCore';
import type { PinBindingFrameV1, ProvisioningTupleProofFrameV1 } from '../oacFrame';

describe('buildOacIssuanceSession', () => {
  it('builds a session with hex sessionId and 32-byte nonce', () => {
    const session = buildOacIssuanceSession('staff-1', 'a'.repeat(32), 'LDP-001', 1000, Buffer.alloc(16, 1), Buffer.alloc(32, 2));
    expect(session.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(session.nonce.length).toBe(32);
    expect(session.status).toBe('PENDING');
  });
});

describe('checkOacIssuanceSession', () => {
  const session: OacIssuanceSessionRecord = buildOacIssuanceSession(
    'staff-1',
    'a'.repeat(32),
    'LDP-001',
    1000,
    Buffer.alloc(16, 1),
    Buffer.alloc(32, 2),
  );

  it('accepts the owning manager within TTL', () => {
    expect(checkOacIssuanceSession(session, 'staff-1', 2000)).toEqual({ ok: true });
  });
  it('rejects a different manager', () => {
    expect(checkOacIssuanceSession(session, 'staff-2', 2000)).toEqual({ ok: false, code: 'session_wrong_owner' });
  });
  it('rejects an expired session', () => {
    expect(checkOacIssuanceSession(session, 'staff-1', 99_999_999)).toEqual({ ok: false, code: 'session_expired' });
  });
  it('rejects a missing session', () => {
    expect(checkOacIssuanceSession(null, 'staff-1', 1)).toEqual({ ok: false, code: 'session_not_found' });
  });
});

describe('checkTupleBinding', () => {
  const session: OacIssuanceSessionRecord = buildOacIssuanceSession(
    'staff-1',
    'a'.repeat(32),
    'LDP-001',
    1000,
    Buffer.alloc(16, 1),
    Buffer.alloc(32, 2),
  );
  const devicePublicKey = Buffer.alloc(32, 0x55);
  const validTuple = {
    securityDeviceId: Buffer.from(session.securityDeviceIdHex, 'hex'),
    oacIssuanceSessionId: session.sessionId,
    managerStaffId: 'staff-1',
    nonce: session.nonce,
    devProofPublicKey: devicePublicKey,
  };

  it('accepts a correctly-bound tuple', () => {
    expect(checkTupleBinding(validTuple, session, devicePublicKey)).toEqual({ ok: true });
  });
  it('rejects a nonce mismatch', () => {
    expect(checkTupleBinding({ ...validTuple, nonce: Buffer.alloc(32, 9) }, session, devicePublicKey)).toEqual({
      ok: false,
      code: 'tuple_nonce_mismatch',
    });
  });
  it('rejects a session mismatch', () => {
    expect(checkTupleBinding({ ...validTuple, oacIssuanceSessionId: 'wrong' }, session, devicePublicKey)).toEqual({
      ok: false,
      code: 'tuple_session_mismatch',
    });
  });
  it('rejects a device mismatch', () => {
    expect(checkTupleBinding({ ...validTuple, securityDeviceId: Buffer.alloc(16, 0xff) }, session, devicePublicKey)).toEqual({
      ok: false,
      code: 'tuple_device_mismatch',
    });
  });
  it('rejects a manager mismatch', () => {
    expect(checkTupleBinding({ ...validTuple, managerStaffId: 'staff-9' }, session, devicePublicKey)).toEqual({
      ok: false,
      code: 'tuple_manager_mismatch',
    });
  });
  it('rejects when the tuple key does not match the registered device key', () => {
    expect(checkTupleBinding(validTuple, session, Buffer.alloc(32, 0x99))).toEqual({
      ok: false,
      code: 'tuple_device_key_mismatch',
    });
  });
});

describe('buildUnsignedOac', () => {
  it('projects PIN1 verifier fields into the OAC envelope shape', () => {
    const pin1: PinBindingFrameV1 = {
      securityDeviceId: Buffer.alloc(16, 1),
      oacIssuanceSessionId: 'sess-1',
      managerStaffId: 'staff-1',
      verifierAlgo: 'argon2id',
      m: 65536,
      t: 3,
      p: 1,
      verifierSalt: Buffer.alloc(16, 2),
      verifier: Buffer.alloc(32, 3),
      pepperCommitment: Buffer.alloc(32, 4),
      devProofPublicKey: Buffer.alloc(32, 5),
      signature: Buffer.alloc(64, 6),
    };
    const unsigned = buildUnsignedOac('oac-1', pin1, 'manager', 'LDP-001', 'device-hex', 1, 2, 3, 1000);
    expect(unsigned.oacId).toBe('oac-1');
    expect(unsigned.managerStaffId).toBe('staff-1');
    expect(unsigned.verifierParams).toEqual({ m: 65536, t: 3, p: 1, saltLen: 16, hashLen: 32 });
    expect(unsigned.verifierSalt).toBe(pin1.verifierSalt.toString('base64'));
    expect(unsigned.freshnessExpiresAtServerMs).toBe(1000 + 24 * 60 * 60 * 1000);
  });
});

describe('ptp1Tuple / pin1Tuple', () => {
  it('extract the exact binding fields', () => {
    const ptp1: ProvisioningTupleProofFrameV1 = {
      securityDeviceId: Buffer.alloc(16, 1),
      oacIssuanceSessionId: 'sess-1',
      managerStaffId: 'staff-1',
      nonce: Buffer.alloc(32, 2),
      devProofPublicKey: Buffer.alloc(32, 3),
      signature: Buffer.alloc(64, 4),
    };
    expect(ptp1Tuple(ptp1)).toEqual({
      securityDeviceId: ptp1.securityDeviceId,
      oacIssuanceSessionId: 'sess-1',
      managerStaffId: 'staff-1',
      nonce: ptp1.nonce,
      devProofPublicKey: ptp1.devProofPublicKey,
    });
  });
});
