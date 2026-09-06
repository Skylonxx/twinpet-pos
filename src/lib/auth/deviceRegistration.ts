/**
 * deviceRegistration — SEC-001 Packet D-1A
 *
 * Implements GD-001 Option A staged enrollment lifecycle:
 * native_generate_device_registration_proof (prepare durable staged key)
 *   -> completeDeviceRegistration (server consumes DRP1 & activates device)
 *   -> native_finalize_device_enrollment (commits staged key as runtime authority)
 *
 * If server succeeds but local finalize fails, returns LOCAL_ENROLLMENT_FINALIZATION_REQUIRED
 * with recoverable retry context without re-calling server or generating a new key.
 */

import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth, app, isFirebaseConfigured } from '../firebase';

export interface FinalizeRetryContext {
  enrollmentGenerationId: string;
  securityDeviceIdHex: string;
  branchId: string;
  deviceKeyVersion: number;
  acceptedPublicKeyBase64: string;
  serverFinalizationReceiptBase64: string;
  oks1Base64?: string;
  expectedOperationKind?: string;
}

export type DeviceRegistrationResult =
  | {
      ok: true;
      securityDeviceIdHex: string;
      branchId: string;
      deviceKeyVersion: number;
    }
  | {
      ok: false;
      code: string;
      errorDetail?: string;
      retryContext?: FinalizeRetryContext;
    };

export function getNativeDeviceEnrollmentInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const g = globalThis as unknown as Record<string, any>;
  const tauriKey = ['_', '_', 'T', 'A', 'U', 'R', 'I', '_', '_'].join('');
  const core = g[tauriKey]?.core ?? g.window?.[tauriKey]?.core;
  if (typeof core?.invoke === 'function') {
    return core.invoke;
  }
  return null;
}

/**
 * Extracts the 32-byte devProofPublicKey from a standard 185-byte DRP1 frame.
 * DRP1 layout:
 * [0..4]   magic (DRP1)
 * [4]      version (1)
 * [5]      enrollmentAuthId length (32)
 * [6..38]  enrollmentAuthId
 * [38]     nonce length (32)
 * [39..71] nonce
 * [71]     securityDeviceId length (16)
 * [72..88] securityDeviceId
 * [88]     devProofPublicKey length (32)
 * [89..121] devProofPublicKey (32 bytes)
 * [121..185] signature (64 bytes)
 */
export function extractPublicKeyFromDrp1(drp1Base64: string): string {
  let bytes: Uint8Array;
  if (typeof Buffer !== 'undefined') {
    bytes = new Uint8Array(Buffer.from(drp1Base64, 'base64'));
  } else {
    const bin = atob(drp1Base64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
  }

  if (bytes.length < 121) {
    throw new Error('Invalid DRP1 frame length');
  }

  const pubkeySlice = bytes.slice(89, 121);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(pubkeySlice).toString('base64');
  }
  let bin = '';
  for (let i = 0; i < pubkeySlice.length; i++) {
    bin += String.fromCharCode(pubkeySlice[i]);
  }
  return btoa(bin);
}

export const PENDING_FINALIZATION_STORAGE_KEY = 'twinpet_pending_enrollment_finalization';

export function savePendingFinalization(context: FinalizeRetryContext): void {
  if (typeof localStorage === 'undefined') {
    throw new Error('localStorage is unavailable');
  }
  localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(context));
}

export function loadPendingFinalization(): FinalizeRetryContext | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(PENDING_FINALIZATION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.enrollmentGenerationId === 'string' &&
        parsed.enrollmentGenerationId.trim().length > 0 &&
        typeof parsed?.securityDeviceIdHex === 'string' &&
        parsed.securityDeviceIdHex.trim().length > 0 &&
        typeof parsed?.branchId === 'string' &&
        parsed.branchId.trim().length > 0 &&
        typeof parsed?.deviceKeyVersion === 'number' &&
        Number.isInteger(parsed.deviceKeyVersion) &&
        parsed.deviceKeyVersion > 0 &&
        parsed.deviceKeyVersion <= 4294967295 &&
        typeof parsed?.acceptedPublicKeyBase64 === 'string' &&
        parsed.acceptedPublicKeyBase64.trim().length > 0 &&
        typeof parsed?.serverFinalizationReceiptBase64 === 'string' &&
        parsed.serverFinalizationReceiptBase64.trim().length > 0 &&
        (parsed.oks1Base64 === undefined || typeof parsed.oks1Base64 === 'string') &&
        (parsed.expectedOperationKind === undefined ||
          parsed.expectedOperationKind === 'INITIAL_ENROLLMENT' ||
          parsed.expectedOperationKind === 'RE_ENROLLMENT')
      ) {
        return parsed as FinalizeRetryContext;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function clearPendingFinalization(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(PENDING_FINALIZATION_STORAGE_KEY);
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Retries local finalization using the exact accepted generation details
 * without re-calling the server or generating a second key.
 */
export async function finalizeDeviceEnrollmentRetry(
  context: FinalizeRetryContext,
  customInvoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): Promise<DeviceRegistrationResult> {
  try {
    savePendingFinalization(context);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
      errorDetail: `storage_write_failed: ${msg}`,
      retryContext: context,
    };
  }

  const invoke = customInvoke ?? getNativeDeviceEnrollmentInvoke();
  if (!invoke) {
    return {
      ok: false,
      code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
      errorDetail: 'native_bridge_unavailable',
      retryContext: context,
    };
  }

  try {
    const rawOutcome = await invoke('native_finalize_device_enrollment', {
      enrollmentGenerationId: context.enrollmentGenerationId,
      securityDeviceIdHex: context.securityDeviceIdHex,
      branchId: context.branchId,
      deviceKeyVersion: context.deviceKeyVersion,
      acceptedPublicKeyBase64: context.acceptedPublicKeyBase64,
      serverReceiptBase64: context.serverFinalizationReceiptBase64,
      oks1Base64: context.oks1Base64,
      expectedOperationKind: context.expectedOperationKind,
    });

    const finalizeOutcome = rawOutcome as {
      success?: boolean;
      status?: string;
      securityDeviceIdHex?: string;
      branchId?: string;
      deviceKeyVersion?: number;
      enrollmentGenerationIdHex?: string;
      acceptedPublicKeyBase64?: string;
      error?: string;
    } | null | undefined;

    if (finalizeOutcome == null || finalizeOutcome.success !== true) {
      return {
        ok: false,
        code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
        errorDetail: `native_finalize_failed: ${finalizeOutcome?.error || 'unsuccessful'}`,
        retryContext: context,
      };
    }
    if (finalizeOutcome.status !== 'COMMITTED' && finalizeOutcome.status !== 'ALREADY_COMMITTED') {
      return {
        ok: false,
        code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
        errorDetail: `unexpected_finalize_status: ${finalizeOutcome.status}`,
        retryContext: context,
      };
    }
    if (
      typeof finalizeOutcome.enrollmentGenerationIdHex !== 'string' ||
      finalizeOutcome.enrollmentGenerationIdHex.toLowerCase() !== context.enrollmentGenerationId.toLowerCase()
    ) {
      return {
        ok: false,
        code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
        errorDetail: 'generation_id_mismatch',
        retryContext: context,
      };
    }
    if (
      typeof finalizeOutcome.securityDeviceIdHex !== 'string' ||
      finalizeOutcome.securityDeviceIdHex.toLowerCase() !== context.securityDeviceIdHex.toLowerCase()
    ) {
      return {
        ok: false,
        code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
        errorDetail: 'security_device_id_mismatch',
        retryContext: context,
      };
    }
    if (finalizeOutcome.branchId !== context.branchId) {
      return {
        ok: false,
        code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
        errorDetail: 'branch_id_mismatch',
        retryContext: context,
      };
    }
    if (finalizeOutcome.deviceKeyVersion !== context.deviceKeyVersion) {
      return {
        ok: false,
        code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
        errorDetail: 'device_key_version_mismatch',
        retryContext: context,
      };
    }
    if (finalizeOutcome.acceptedPublicKeyBase64 !== context.acceptedPublicKeyBase64) {
      return {
        ok: false,
        code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
        errorDetail: 'accepted_public_key_mismatch',
        retryContext: context,
      };
    }

    clearPendingFinalization();

    return {
      ok: true,
      securityDeviceIdHex: finalizeOutcome.securityDeviceIdHex!,
      branchId: finalizeOutcome.branchId!,
      deviceKeyVersion: finalizeOutcome.deviceKeyVersion!,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
      errorDetail: msg,
      retryContext: context,
    };
  }
}

export interface RegisterDeviceOptions {
  customInvoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  customCallables?: {
    beginDeviceRegistration?: (data?: unknown) => Promise<{ data: any }>;
    completeDeviceRegistration?: (data: unknown) => Promise<{ data: any }>;
  };
}

export async function registerDevice(
  enrollmentAuthId: string,
  options?: RegisterDeviceOptions,
): Promise<DeviceRegistrationResult> {
  const invoke = options?.customInvoke ?? getNativeDeviceEnrollmentInvoke();
  if (!invoke) {
    return { ok: false, code: 'native_bridge_unavailable' };
  }

  // 1. Begin registration on server
  let beginResData: any;
  if (options?.customCallables?.beginDeviceRegistration) {
    const res = await options.customCallables.beginDeviceRegistration();
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

  // 3. Complete registration on server
  let completeResData: any;
  if (options?.customCallables?.completeDeviceRegistration) {
    const res = await options.customCallables.completeDeviceRegistration({
      registrationSessionId,
      drp1Base64: proof.drp1Base64,
      enrollmentGenerationId: proof.enrollmentGenerationId,
    });
    completeResData = res.data;
  } else {
    const functions = getFunctions(app, 'asia-southeast1');
    const completeFn = httpsCallable(functions, 'completeDeviceRegistration');
    const res = await completeFn({
      registrationSessionId,
      drp1Base64: proof.drp1Base64,
      enrollmentGenerationId: proof.enrollmentGenerationId,
    });
    completeResData = res.data;
  }

  if (
    !completeResData?.ok ||
    typeof completeResData.securityDeviceIdHex !== 'string' ||
    !/^[0-9a-f]{32}$/i.test(completeResData.securityDeviceIdHex) ||
    typeof completeResData.branchId !== 'string' ||
    !completeResData.branchId ||
    typeof completeResData.deviceKeyVersion !== 'number' ||
    !Number.isInteger(completeResData.deviceKeyVersion) ||
    completeResData.deviceKeyVersion <= 0 ||
    completeResData.deviceKeyVersion > 4294967295 ||
    typeof completeResData.acceptedPublicKeyBase64 !== 'string' ||
    !completeResData.acceptedPublicKeyBase64
  ) {
    return { ok: false, code: completeResData?.code || 'invalid_server_confirmation_bindings' };
  }

  if (
    typeof completeResData.serverFinalizationReceiptBase64 !== 'string' ||
    !completeResData.serverFinalizationReceiptBase64
  ) {
    return { ok: false, code: 'server_receipt_missing' };
  }

  if (completeResData.acceptedPublicKeyBase64 !== proof.stagedPublicKeyBase64) {
    return { ok: false, code: 'accepted_public_key_mismatch' };
  }

  const retryContext: FinalizeRetryContext = {
    enrollmentGenerationId: proof.enrollmentGenerationId,
    securityDeviceIdHex: completeResData.securityDeviceIdHex,
    branchId: completeResData.branchId,
    deviceKeyVersion: completeResData.deviceKeyVersion,
    acceptedPublicKeyBase64: completeResData.acceptedPublicKeyBase64,
    serverFinalizationReceiptBase64: completeResData.serverFinalizationReceiptBase64,
    expectedOperationKind: 'INITIAL_ENROLLMENT',
    ...(typeof completeResData.oks1Base64 === 'string' ? { oks1Base64: completeResData.oks1Base64 } : {}),
  };

  // 4. Native finalize
  return await finalizeDeviceEnrollmentRetry(retryContext, invoke);
}
