/**
 * SEC-001 Packet D-1A — pure logic for PIN-less authenticated Staff Session Assertion (SSA1) refresh.
 *
 * Validates that:
 * - SSCP1 purpose is strictly REFRESH (2)
 * - SSCP1 intendedStaffId strictly matches the caller staffId
 * - Live staff user is active, not deleted, authVersion matches token
 * - Device is active, version matches, and signature verifies
 */

import {
  validateCallerStaffIdentity,
  validateDeviceForSession,
  buildSignedSsa1,
  buildSignedSrf1ForSsa1,
  type LiveDeviceRecord,
} from './staffSessionIssuerCore';
import {
  SSCP1_PURPOSE_REFRESH,
  type StaffSessionDeviceChallengeProofV1,
} from './staffSessionAssertionFrame';

export function validateRefreshProofAndDevice(
  device: LiveDeviceRecord | null | undefined,
  sscp1: StaffSessionDeviceChallengeProofV1,
  callerStaffId: string,
) {
  return validateDeviceForSession(device, sscp1, SSCP1_PURPOSE_REFRESH, callerStaffId);
}

export {
  validateCallerStaffIdentity,
  validateDeviceForSession,
  buildSignedSsa1,
  buildSignedSrf1ForSsa1,
  SSCP1_PURPOSE_REFRESH,
};
