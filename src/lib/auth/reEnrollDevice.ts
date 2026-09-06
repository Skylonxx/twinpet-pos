/**
 * reEnrollDevice — SEC-001 Packet D-1A
 *
 * Implements GD-001 Option A staged enrollment lifecycle for re-enrollment:
 * native_generate_device_registration_proof (prepare durable staged key)
 *   -> reEnrollPrivilegedDevice (server consumes DRP1, verifies expectedDeviceKeyVersion, increments version)
 *   -> native_finalize_device_enrollment (commits new staged key as runtime authority)
 *
 * Invariants:
 * - Old committed generation remains untouched and active until local finalization succeeds.
 * - If server succeeds but local finalize fails, returns LOCAL_ENROLLMENT_FINALIZATION_REQUIRED
 *   with recoverable retry context without re-calling server or incrementing version again.
 */

import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth, app, isFirebaseConfigured } from '../firebase';
import {
  type DeviceRegistrationResult,
  type FinalizeRetryContext,
  getNativeDeviceEnrollmentInvoke,
  finalizeDeviceEnrollmentRetry,
} from './deviceRegistration';

export interface ReEnrollDeviceOptions {
  enrollmentAuthId: string;
  expectedDeviceKeyVersion: number;
  customInvoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  customCallables?: {
    beginDeviceRegistration?: (data?: unknown) => Promise<{ data: any }>;
    reEnrollPrivilegedDevice?: (data: unknown) => Promise<{ data: any }>;
  };
}

export async function reEnrollDevice(
  options: ReEnrollDeviceOptions,
): Promise<DeviceRegistrationResult> {
  const { enrollmentAuthId, expectedDeviceKeyVersion, customInvoke, customCallables } = options;

  const invoke = customInvoke ?? getNativeDeviceEnrollmentInvoke();
  if (!invoke) {
    return { ok: false, code: 'native_bridge_unavailable' };
  }

  if (
    typeof expectedDeviceKeyVersion !== 'number' ||
    !Number.isFinite(expectedDeviceKeyVersion) ||
    !Number.isSafeInteger(expectedDeviceKeyVersion) ||
    expectedDeviceKeyVersion <= 0 ||
    expectedDeviceKeyVersion > 4294967295
  ) {
    return { ok: false, code: 'invalid_device_key_version' };
  }

  // 1. Begin registration session
  let beginResData: any;
  if (customCallables?.beginDeviceRegistration) {
    const res = await customCallables.beginDeviceRegistration();
    beginResData = res.data;
  } else {
    if (!isFirebaseConfigured || !auth?.currentUser || !app) {
      return { ok: false, code: 'not_authenticated' };
    }
    const functions = getFunctions(app, 'asia-southeast1');
    const beginFn = httpsCallable(functions, 'beginDeviceRegistration');
    const res = await beginFn();
    beginResData = res.data;
  }

  if (!beginResData?.ok || !beginResData?.registrationSessionId || !beginResData?.deviceRegistrationNonceBase64) {
    return { ok: false, code: beginResData?.code || 'begin_registration_failed' };
  }

  const { registrationSessionId, deviceRegistrationNonceBase64 } = beginResData;

  // 2. Prepare durable staged generation via native command
  let proof: {
    drp1Base64: string;
    enrollmentGenerationId: string;
    stagedPublicKeyBase64: string;
  };
  try {
    const proofRaw = (await invoke('native_generate_device_registration_proof', {
      enrollmentAuthId,
      deviceRegistrationNonceBase64,
    })) as any;
    if (
      !proofRaw ||
      typeof proofRaw.drp1Base64 !== 'string' ||
      typeof proofRaw.enrollmentGenerationId !== 'string' ||
      typeof proofRaw.stagedPublicKeyBase64 !== 'string'
    ) {
      return { ok: false, code: 'proof_generation_failed' };
    }
    proof = proofRaw;
  } catch (err: unknown) {
    return { ok: false, code: 'proof_generation_failed', errorDetail: String(err) };
  }

  // 3. Re-enroll on server
  let reEnrollResData: any;
  if (customCallables?.reEnrollPrivilegedDevice) {
    const res = await customCallables.reEnrollPrivilegedDevice({
      registrationSessionId,
      drp1Base64: proof.drp1Base64,
      expectedDeviceKeyVersion,
      enrollmentGenerationId: proof.enrollmentGenerationId,
    });
    reEnrollResData = res.data;
  } else {
    const functions = getFunctions(app, 'asia-southeast1');
    const reEnrollFn = httpsCallable(functions, 'reEnrollPrivilegedDevice');
    const res = await reEnrollFn({
      registrationSessionId,
      drp1Base64: proof.drp1Base64,
      expectedDeviceKeyVersion,
      enrollmentGenerationId: proof.enrollmentGenerationId,
    });
    reEnrollResData = res.data;
  }

  if (
    !reEnrollResData?.ok ||
    typeof reEnrollResData.securityDeviceIdHex !== 'string' ||
    !/^[0-9a-f]{32}$/i.test(reEnrollResData.securityDeviceIdHex) ||
    typeof reEnrollResData.branchId !== 'string' ||
    !reEnrollResData.branchId ||
    typeof reEnrollResData.newDeviceKeyVersion !== 'number' ||
    !Number.isInteger(reEnrollResData.newDeviceKeyVersion) ||
    reEnrollResData.newDeviceKeyVersion <= 0 ||
    reEnrollResData.newDeviceKeyVersion > 4294967295 ||
    typeof reEnrollResData.acceptedPublicKeyBase64 !== 'string' ||
    !reEnrollResData.acceptedPublicKeyBase64
  ) {
    return { ok: false, code: reEnrollResData?.code || 'invalid_server_confirmation_bindings' };
  }

  if (
    typeof reEnrollResData.serverFinalizationReceiptBase64 !== 'string' ||
    !reEnrollResData.serverFinalizationReceiptBase64
  ) {
    return { ok: false, code: 'server_receipt_missing' };
  }

  if (reEnrollResData.acceptedPublicKeyBase64 !== proof.stagedPublicKeyBase64) {
    return { ok: false, code: 'accepted_public_key_mismatch' };
  }

  const retryContext: FinalizeRetryContext = {
    enrollmentGenerationId: proof.enrollmentGenerationId,
    securityDeviceIdHex: reEnrollResData.securityDeviceIdHex,
    branchId: reEnrollResData.branchId,
    deviceKeyVersion: reEnrollResData.newDeviceKeyVersion,
    acceptedPublicKeyBase64: reEnrollResData.acceptedPublicKeyBase64,
    serverFinalizationReceiptBase64: reEnrollResData.serverFinalizationReceiptBase64,
    expectedOperationKind: 'RE_ENROLLMENT',
    ...(typeof reEnrollResData.oks1Base64 === 'string' ? { oks1Base64: reEnrollResData.oks1Base64 } : {}),
  };

  // 4. Native finalize (switches active generation fence to new generation)
  return await finalizeDeviceEnrollmentRetry(retryContext, invoke);
}
