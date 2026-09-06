import { describe, expect, it } from 'vitest';
import { validateRefreshProofAndDevice } from '../staffSessionRefreshCore';
import { SSCP1_PURPOSE_LOGIN, SSCP1_PURPOSE_REFRESH, type StaffSessionDeviceChallengeProofV1 } from '../staffSessionAssertionFrame';
import type { LiveDeviceRecord } from '../staffSessionIssuerCore';

describe('staffSessionRefreshCore', () => {
  const validDevice: LiveDeviceRecord = {
    securityDeviceIdHex: '11'.repeat(16),
    status: 'ACTIVE',
    deviceKeyVersion: 1,
    branchId: 'B-HQ',
    validatedDevProofPublicKeyBase64: 'pub',
  };

  const validRefreshProof: StaffSessionDeviceChallengeProofV1 = {
    purpose: SSCP1_PURPOSE_REFRESH,
    challengeNonce: Buffer.alloc(32, 0x11),
    securityDeviceId: Buffer.alloc(16, 0x11),
    deviceKeyVersion: 1,
    branchId: 'B-HQ',
    challengeGeneration: BigInt(1),
    intendedStaffId: 'staff-1',
    signature: Buffer.alloc(64, 0x22),
  };

  it('accepts valid refresh proof with purpose REFRESH', () => {
    const res = validateRefreshProofAndDevice(validDevice, validRefreshProof, 'staff-1');
    expect(res).toEqual({ ok: true });
  });

  it('rejects LOGIN proof submitted for refresh', () => {
    const res = validateRefreshProofAndDevice(
      validDevice,
      { ...validRefreshProof, purpose: SSCP1_PURPOSE_LOGIN },
      'staff-1',
    );
    expect(res).toEqual({ ok: false, code: 'sscp1_purpose_mismatch' });
  });

  it('rejects if intendedStaffId does not match caller staffId', () => {
    const res = validateRefreshProofAndDevice(
      validDevice,
      validRefreshProof,
      'other-staff',
    );
    expect(res).toEqual({ ok: false, code: 'sscp1_staff_mismatch' });
  });
});
