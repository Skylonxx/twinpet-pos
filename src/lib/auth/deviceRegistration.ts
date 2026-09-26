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

// --- Durable completion intent (response-loss recovery) --------------------
//
// Persisted BEFORE the first `completeDeviceRegistration` call so that a
// server commit whose response is lost (crash, network, app restart) can be
// recovered by replaying the EXACT same request. Holds only the public
// request fields plus the staged public-key echo — no private key, token,
// or ENR1 payload.

export const PENDING_COMPLETION_INTENT_STORAGE_KEY = 'twinpet_pending_enrollment_completion_intent_v1';
export const PENDING_COMPLETION_INTENT_SCHEMA = 'twinpet.pendingCompletionIntent';

export interface PendingCompletionIntentV1 {
  schema: typeof PENDING_COMPLETION_INTENT_SCHEMA;
  version: 1;
  registrationSessionId: string;
  drp1Base64: string;
  enrollmentGenerationId: string;
  stagedPublicKeyBase64: string;
}

const COMPLETION_INTENT_KEYS = [
  'drp1Base64',
  'enrollmentGenerationId',
  'registrationSessionId',
  'schema',
  'stagedPublicKeyBase64',
  'version',
];
const DRP1_TOTAL_BYTES = 185;
const LOWER_HEX32_RE = /^[0-9a-f]{32}$/;
const STD_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decoded byte length of a CANONICAL standard-base64 string, else null. */
function canonicalStdBase64ByteLength(value: string): number | null {
  if (!STD_BASE64_RE.test(value)) return null;
  try {
    if (typeof Buffer !== 'undefined') {
      const bytes = Buffer.from(value, 'base64');
      return bytes.toString('base64') === value ? bytes.length : null;
    }
    const bin = atob(value);
    return btoa(bin) === value ? bin.length : null;
  } catch {
    return null;
  }
}

/**
 * The native proof command returns DRP1 as unpadded base64url; the server
 * decodes either alphabet to the same bytes. The intent stores the canonical
 * standard-base64 form of those exact bytes. Returns null if `value` is not
 * strictly valid base64/base64url.
 */
function toCanonicalStdBase64(value: string): string | null {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) return null;
  const unpadded = value.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (unpadded.length % 4 === 1) return null;
  const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
  if (!STD_BASE64_RE.test(padded)) return null;
  try {
    if (typeof Buffer !== 'undefined') {
      const bytes = Buffer.from(padded, 'base64');
      const canonical = bytes.toString('base64');
      return canonical.replace(/=+$/, '') === unpadded ? canonical : null;
    }
    const canonical = btoa(atob(padded));
    return canonical.replace(/=+$/, '') === unpadded ? canonical : null;
  } catch {
    return null;
  }
}

/** Strict parser: exact key set, exact schema/version, exact field grammar. No repair. */
export function parseCompletionIntent(value: unknown): PendingCompletionIntentV1 | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const keys = Object.keys(r).sort();
  if (keys.length !== COMPLETION_INTENT_KEYS.length || keys.some((k, i) => k !== COMPLETION_INTENT_KEYS[i])) {
    return null;
  }
  if (
    r.schema !== PENDING_COMPLETION_INTENT_SCHEMA ||
    r.version !== 1 ||
    typeof r.registrationSessionId !== 'string' ||
    !LOWER_HEX32_RE.test(r.registrationSessionId) ||
    typeof r.enrollmentGenerationId !== 'string' ||
    !LOWER_HEX32_RE.test(r.enrollmentGenerationId) ||
    typeof r.drp1Base64 !== 'string' ||
    canonicalStdBase64ByteLength(r.drp1Base64) !== DRP1_TOTAL_BYTES ||
    typeof r.stagedPublicKeyBase64 !== 'string' ||
    canonicalStdBase64ByteLength(r.stagedPublicKeyBase64) !== 32
  ) {
    return null;
  }
  return {
    schema: PENDING_COMPLETION_INTENT_SCHEMA,
    version: 1,
    registrationSessionId: r.registrationSessionId,
    drp1Base64: r.drp1Base64,
    enrollmentGenerationId: r.enrollmentGenerationId,
    stagedPublicKeyBase64: r.stagedPublicKeyBase64,
  };
}

export function loadCompletionIntent(): PendingCompletionIntentV1 | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(PENDING_COMPLETION_INTENT_STORAGE_KEY);
    return raw ? parseCompletionIntent(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

type CompletionIntentInspection =
  | { state: 'ABSENT' }
  | { state: 'PRESENT_VALID'; intent: PendingCompletionIntentV1 }
  | { state: 'PRESENT_MALFORMED' }
  | { state: 'READ_FAILED' };

/**
 * Outcome-bearing storage inspection for authority decisions. Unlike the
 * tolerant `loadCompletionIntent`, it never maps an unreadable or malformed
 * record to "absent": ABSENT is returned ONLY when storage is readable and
 * `getItem` completes with a raw `null`. Malformed bytes are reported, never
 * repaired or deleted.
 */
function inspectCompletionIntent(): CompletionIntentInspection {
  let raw: string | null;
  try {
    if (typeof localStorage === 'undefined') return { state: 'READ_FAILED' };
    raw = localStorage.getItem(PENDING_COMPLETION_INTENT_STORAGE_KEY);
  } catch {
    return { state: 'READ_FAILED' };
  }
  if (raw === null) return { state: 'ABSENT' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'PRESENT_MALFORMED' };
  }
  const intent = parseCompletionIntent(parsed);
  return intent ? { state: 'PRESENT_VALID', intent } : { state: 'PRESENT_MALFORMED' };
}

/**
 * Durably records the intent, verified by read-back. Throws (fail closed) if
 * storage is unavailable, the intent is malformed, a valid intent is already
 * pending (never overwritten), or the read-back does not match exactly.
 */
export function saveCompletionIntent(intent: PendingCompletionIntentV1): void {
  if (typeof localStorage === 'undefined') throw new Error('localStorage is unavailable');
  const parsed = parseCompletionIntent(intent);
  if (!parsed) throw new Error('completion_intent_invalid');
  if (loadCompletionIntent()) throw new Error('completion_intent_already_pending');
  const serialized = JSON.stringify(parsed);
  localStorage.setItem(PENDING_COMPLETION_INTENT_STORAGE_KEY, serialized);
  const readBack = loadCompletionIntent();
  if (!readBack || JSON.stringify(readBack) !== serialized) {
    throw new Error('completion_intent_readback_mismatch');
  }
}

/** Best effort: a failed removal is swallowed; callers must not assume it succeeded. */
export function clearCompletionIntent(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(PENDING_COMPLETION_INTENT_STORAGE_KEY);
    }
  } catch {
    // Non-fatal
  }
}

export type EnrollmentRecoveryState =
  | { kind: 'none' }
  | { kind: 'finalization_pending'; context: FinalizeRetryContext }
  | { kind: 'completion_pending'; intent: PendingCompletionIntentV1 }
  | { kind: 'conflict' };

/**
 * Precedence: FinalizeRetryContext > PendingCompletionIntentV1. Both present
 * for the SAME generation → finalization wins (no server replay). Both present
 * for DIFFERENT generations → `conflict`: fail closed, delete neither.
 */
export function loadEnrollmentRecoveryState(): EnrollmentRecoveryState {
  const context = loadPendingFinalization();
  const intent = loadCompletionIntent();
  if (context) {
    if (intent && intent.enrollmentGenerationId !== context.enrollmentGenerationId.toLowerCase()) {
      return { kind: 'conflict' };
    }
    return { kind: 'finalization_pending', context };
  }
  return intent ? { kind: 'completion_pending', intent } : { kind: 'none' };
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
  return finalizeSavedContext(context, customInvoke);
}

/** Native finalize for a context that is ALREADY durably saved. */
async function finalizeSavedContext(
  context: FinalizeRetryContext,
  customInvoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): Promise<DeviceRegistrationResult> {
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

    // Native commit is verified. The finalize context is the only authority
    // that can finish this enrollment locally, so it is released ONLY after a
    // strict storage inspection PROVES the completion intent key absent (raw
    // null) — never on an unreadable or malformed record, and never on trust
    // in removeItem. Otherwise a surviving intent would later offer a server
    // replay whose fresh OKS1 the committed native state rejects. Every
    // unproven outcome keeps the context; a retry reuses the original
    // receipt/OKS1 (native ALREADY_COMMITTED) and repeats this gate.
    const keepContext = (errorDetail: string): DeviceRegistrationResult => ({
      ok: false,
      code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
      errorDetail,
      retryContext: context,
    });
    let inspection = inspectCompletionIntent();
    if (inspection.state === 'PRESENT_VALID') {
      if (inspection.intent.enrollmentGenerationId !== context.enrollmentGenerationId.toLowerCase()) {
        // Different generation: fail closed, clear neither record.
        return keepContext('completion_intent_generation_conflict');
      }
      clearCompletionIntent();
      inspection = inspectCompletionIntent();
      if (inspection.state === 'PRESENT_VALID') return keepContext('completion_intent_cleanup_failed');
    }
    if (inspection.state === 'READ_FAILED') return keepContext('completion_intent_read_failed');
    if (inspection.state === 'PRESENT_MALFORMED') return keepContext('completion_intent_malformed');
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

  // 3. Durably record the exact completion request BEFORE calling the server.
  // If this fails the server is never called (nothing is consumed; the staged
  // generation is orphaned but harmless).
  const drp1Base64 = toCanonicalStdBase64(proof.drp1Base64);
  if (!drp1Base64) {
    return { ok: false, code: 'proof_generation_failed' };
  }
  const intent: PendingCompletionIntentV1 = {
    schema: PENDING_COMPLETION_INTENT_SCHEMA,
    version: 1,
    registrationSessionId,
    drp1Base64,
    enrollmentGenerationId: proof.enrollmentGenerationId,
    stagedPublicKeyBase64: proof.stagedPublicKeyBase64,
  };
  try {
    saveCompletionIntent(intent);
  } catch (err: unknown) {
    return { ok: false, code: 'completion_intent_save_failed', errorDetail: String(err) };
  }

  // 4. Complete registration on server. A transport error propagates to the
  // caller with the durable intent preserved for explicit recovery.
  const completeResData = await callCompleteDeviceRegistration(intent, options);
  if ((completeResData as { ok?: unknown } | null | undefined)?.ok === false) {
    // An explicit first-call rejection is definitive: the server validates and
    // precomputes everything before its single atomic commit, so ok:false means
    // nothing was consumed and there is nothing to recover. (An ok:true response
    // that fails client validation below DID commit, so its intent is kept.)
    clearCompletionIntent();
  }
  return await processCompletionResponse(intent, completeResData, invoke);
}

/** Calls the EXISTING completeDeviceRegistration callable with exactly the intent's request fields. */
async function callCompleteDeviceRegistration(
  intent: PendingCompletionIntentV1,
  options?: RegisterDeviceOptions,
): Promise<unknown> {
  const request = {
    registrationSessionId: intent.registrationSessionId,
    drp1Base64: intent.drp1Base64,
    enrollmentGenerationId: intent.enrollmentGenerationId,
  };
  if (options?.customCallables?.completeDeviceRegistration) {
    return (await options.customCallables.completeDeviceRegistration(request)).data;
  }
  const functions = getFunctions(app, 'asia-southeast1');
  const completeFn = httpsCallable(functions, 'completeDeviceRegistration');
  return (await completeFn(request)).data;
}

/**
 * Shared by first completion and explicit recovery: validates the server
 * response against the intent, durably saves the FinalizeRetryContext, only
 * THEN clears the completion intent, and finalizes locally. Any rejection
 * returns without touching the intent (terminal evidence is never deleted).
 */
async function processCompletionResponse(
  intent: PendingCompletionIntentV1,
  completeResData: any,
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): Promise<DeviceRegistrationResult> {
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

  if (completeResData.acceptedPublicKeyBase64 !== intent.stagedPublicKeyBase64) {
    return { ok: false, code: 'accepted_public_key_mismatch' };
  }

  const retryContext: FinalizeRetryContext = {
    enrollmentGenerationId: intent.enrollmentGenerationId,
    securityDeviceIdHex: completeResData.securityDeviceIdHex,
    branchId: completeResData.branchId,
    deviceKeyVersion: completeResData.deviceKeyVersion,
    acceptedPublicKeyBase64: completeResData.acceptedPublicKeyBase64,
    serverFinalizationReceiptBase64: completeResData.serverFinalizationReceiptBase64,
    expectedOperationKind: 'INITIAL_ENROLLMENT',
    ...(typeof completeResData.oks1Base64 === 'string' ? { oks1Base64: completeResData.oks1Base64 } : {}),
  };

  // Finalize context must be durable before the intent is released; if the
  // save fails, keep the intent and skip native finalize (no second server call).
  try {
    savePendingFinalization(retryContext);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 'LOCAL_ENROLLMENT_FINALIZATION_REQUIRED',
      errorDetail: `storage_write_failed: ${msg}`,
      retryContext,
    };
  }
  clearCompletionIntent();

  // Native finalize
  return await finalizeSavedContext(retryContext, invoke);
}

/**
 * Explicit, operator-triggered recovery of a completion whose response was
 * lost. Replays the EXACT saved request to the existing
 * `completeDeviceRegistration` exactly once — no begin, no native proof, no
 * ENR1 import, no re-enroll, no automatic retry — then finalizes locally via
 * the same path as a first completion. A pending FinalizeRetryContext always
 * takes precedence (no server replay).
 */
export async function recoverDeviceRegistrationCompletion(
  options?: RegisterDeviceOptions,
): Promise<DeviceRegistrationResult> {
  const state = loadEnrollmentRecoveryState();
  if (state.kind === 'conflict') return { ok: false, code: 'recovery_state_conflict' };
  if (state.kind === 'finalization_pending') return { ok: false, code: 'finalization_pending' };
  if (state.kind !== 'completion_pending') return { ok: false, code: 'no_completion_intent' };

  const invoke = options?.customInvoke ?? getNativeDeviceEnrollmentInvoke();
  if (!invoke) {
    return { ok: false, code: 'native_bridge_unavailable' };
  }
  if (!options?.customCallables?.completeDeviceRegistration && (!isFirebaseConfigured || !auth?.currentUser || !app)) {
    return { ok: false, code: 'not_authenticated' };
  }

  let completeResData: unknown;
  try {
    completeResData = await callCompleteDeviceRegistration(state.intent, options);
  } catch (err: unknown) {
    return { ok: false, code: 'completion_transport_failed', errorDetail: String(err) };
  }
  return await processCompletionResponse(state.intent, completeResData, invoke);
}
