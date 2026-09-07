/**
 * offlineAttestation — SEC-001 Packet D / D-1B client boundary.
 *
 * Thin, non-authoritative wrapper over the one new native command
 * `native_attest_privileged_action`. Everything security-relevant happens in
 * native code behind that call: offline manager PIN verification, trusted
 * approval-time bounds, the frozen pending-execution lifetime, and PAA1
 * sealing with the enrolled per-device key.
 *
 * This module deliberately does NOT:
 * - decide any verdict, expiry, or authority;
 * - read or write a wall clock for any terminal purpose;
 * - re-derive, re-serialize, or re-mint any attestation field;
 * - retain, log, or return the PIN.
 *
 * D-2 owns the durable journal and the retry schedule. D-1B only produces the
 * attestation and hands the exact bytes over, once.
 */

import {
  isPrivilegedActionId,
  type PrivilegedActionId,
  type PrivilegedApprovalResult,
} from './privilegedActionTypes';

export const NATIVE_ATTEST_PRIVILEGED_ACTION_COMMAND = 'native_attest_privileged_action' as const;

export type NativeInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface PrivilegedEvidenceSeed {
  oacId: string;
  oacSchemaVersion: number;
  revocationEpochAtIssue: number;
  managerAuthVersionAtIssue: number;
  managerCredentialVersionAtIssue: number;
  nonce: string;
  attemptCount: number;
  approvalResult: PrivilegedApprovalResult;
  approvalProofDigest: string;
}

/** The exact payload D-2 must persist verbatim and resubmit byte-identically. */
export interface OfflineAttestationEnvelope {
  attestationIdHex: string;
  paa1Base64: string;
  ssa1Base64: string;
  oacEnvelopeBytesBase64: string;
  verifiedBranchId: string;
  evidenceSeed: PrivilegedEvidenceSeed;
  trustedApprovalLowerMs: number;
  trustedApprovalUpperMs: number;
  pendingExecutionExpiresAtMs: number;
  localIntentId: string;
  actionId: PrivilegedActionId;
  targetOrderId: string;
  targetOrderUtc7Date: string;
  approvingManagerStaffId: string;
}

export type OfflineAttestationResult =
  | { ok: true; attestation: OfflineAttestationEnvelope }
  | {
      ok: false;
      errorCode: string;
      /** Present on a denial the native verifier could still evidence (never on APPROVED_LOCAL). */
      verifiedBranchId?: string;
      evidenceSeed?: PrivilegedEvidenceSeed;
    };

export interface RequestOfflineAttestationInput {
  managerStaffId: string;
  actionId: PrivilegedActionId;
  targetOrderId: string;
  targetOrderUtc7Date: string;
  localIntentId: string;
  pin: string;
}

export const OFFLINE_ATTESTATION_UNAVAILABLE = 'DENIED_UNVERIFIABLE' as const;

const UTC7_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CANONICAL_ID_RE = /^[A-Za-z0-9_-]{1,1500}$/;

type TauriBridge = { core?: { invoke?: unknown } } | undefined;

export function getNativePrivilegedAttestationInvoke(): NativeInvoke | null {
  const g = globalThis as unknown as Record<string, unknown>;
  const tauriKey = ['_', '_', 'T', 'A', 'U', 'R', 'I', '_', '_'].join('');
  const win = g.window as Record<string, unknown> | undefined;
  const bridge = (g[tauriKey] ?? win?.[tauriKey]) as TauriBridge;
  const invoke = bridge?.core?.invoke;
  return typeof invoke === 'function' ? (invoke as NativeInvoke) : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Structural pre-check of the four renderer-declared values. This is a UX
 * guard only — native revalidates all four, and the server revalidates or
 * recomputes every one of them again.
 */
export function isWellFormedAttestationRequest(input: RequestOfflineAttestationInput): boolean {
  return (
    isPrivilegedActionId(input.actionId) &&
    CANONICAL_ID_RE.test(input.managerStaffId ?? '') &&
    CANONICAL_ID_RE.test(input.targetOrderId ?? '') &&
    CANONICAL_ID_RE.test(input.localIntentId ?? '') &&
    UTC7_DATE_RE.test(input.targetOrderUtc7Date ?? '') &&
    typeof input.pin === 'string' &&
    input.pin.length > 0
  );
}

function parseEvidenceSeed(raw: unknown): PrivilegedEvidenceSeed | null {
  if (raw == null || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (
    !isNonEmptyString(s.oacId) ||
    !isFiniteNumber(s.oacSchemaVersion) ||
    !isFiniteNumber(s.revocationEpochAtIssue) ||
    !isFiniteNumber(s.managerAuthVersionAtIssue) ||
    !isFiniteNumber(s.managerCredentialVersionAtIssue) ||
    !isNonEmptyString(s.nonce) ||
    !isFiniteNumber(s.attemptCount) ||
    !isNonEmptyString(s.approvalResult) ||
    !isNonEmptyString(s.approvalProofDigest)
  ) {
    return null;
  }
  return {
    oacId: s.oacId,
    oacSchemaVersion: s.oacSchemaVersion,
    revocationEpochAtIssue: s.revocationEpochAtIssue,
    managerAuthVersionAtIssue: s.managerAuthVersionAtIssue,
    managerCredentialVersionAtIssue: s.managerCredentialVersionAtIssue,
    nonce: s.nonce,
    attemptCount: s.attemptCount,
    approvalResult: s.approvalResult as PrivilegedApprovalResult,
    approvalProofDigest: s.approvalProofDigest,
  };
}

/**
 * Mints one action-bound offline attestation.
 *
 * Fails closed on every path: an absent native bridge, a malformed request, a
 * thrown invoke, or an unrecognised DTO all resolve to a non-approving result
 * with no attestation material.
 */
export async function requestOfflineAttestation(
  input: RequestOfflineAttestationInput,
  customInvoke?: NativeInvoke,
): Promise<OfflineAttestationResult> {
  if (!isWellFormedAttestationRequest(input)) {
    return { ok: false, errorCode: OFFLINE_ATTESTATION_UNAVAILABLE };
  }
  const invoke = customInvoke ?? getNativePrivilegedAttestationInvoke();
  if (!invoke) return { ok: false, errorCode: OFFLINE_ATTESTATION_UNAVAILABLE };

  let raw: unknown;
  try {
    raw = await invoke(NATIVE_ATTEST_PRIVILEGED_ACTION_COMMAND, {
      managerStaffId: input.managerStaffId,
      actionId: input.actionId,
      targetOrderId: input.targetOrderId,
      targetOrderUtc7Date: input.targetOrderUtc7Date,
      localIntentId: input.localIntentId,
      pin: input.pin,
    });
  } catch {
    return { ok: false, errorCode: OFFLINE_ATTESTATION_UNAVAILABLE };
  }

  if (raw == null || typeof raw !== 'object') {
    return { ok: false, errorCode: OFFLINE_ATTESTATION_UNAVAILABLE };
  }
  const dto = raw as Record<string, unknown>;
  const evidenceSeed = parseEvidenceSeed(dto.evidenceSeed);

  if (dto.ok !== true) {
    const errorCode = isNonEmptyString(dto.errorCode) ? dto.errorCode : OFFLINE_ATTESTATION_UNAVAILABLE;
    return {
      ok: false,
      errorCode,
      ...(isNonEmptyString(dto.verifiedBranchId) ? { verifiedBranchId: dto.verifiedBranchId } : {}),
      ...(evidenceSeed ? { evidenceSeed } : {}),
    };
  }

  // An approving DTO must carry every field D-2 has to persist verbatim.
  if (
    !isNonEmptyString(dto.attestationIdHex) ||
    !isNonEmptyString(dto.paa1Base64) ||
    !isNonEmptyString(dto.ssa1Base64) ||
    !isNonEmptyString(dto.oacEnvelopeBytesBase64) ||
    !isNonEmptyString(dto.verifiedBranchId) ||
    evidenceSeed == null ||
    evidenceSeed.approvalResult !== 'APPROVED_LOCAL' ||
    !isFiniteNumber(dto.trustedApprovalLowerMs) ||
    !isFiniteNumber(dto.trustedApprovalUpperMs) ||
    !isFiniteNumber(dto.pendingExecutionExpiresAtMs) ||
    dto.trustedApprovalUpperMs < dto.trustedApprovalLowerMs ||
    dto.pendingExecutionExpiresAtMs <= dto.trustedApprovalLowerMs
  ) {
    return { ok: false, errorCode: OFFLINE_ATTESTATION_UNAVAILABLE };
  }

  return {
    ok: true,
    attestation: {
      attestationIdHex: dto.attestationIdHex,
      paa1Base64: dto.paa1Base64,
      ssa1Base64: dto.ssa1Base64,
      oacEnvelopeBytesBase64: dto.oacEnvelopeBytesBase64,
      verifiedBranchId: dto.verifiedBranchId,
      evidenceSeed,
      trustedApprovalLowerMs: dto.trustedApprovalLowerMs,
      trustedApprovalUpperMs: dto.trustedApprovalUpperMs,
      pendingExecutionExpiresAtMs: dto.pendingExecutionExpiresAtMs,
      localIntentId: input.localIntentId,
      actionId: input.actionId,
      targetOrderId: input.targetOrderId,
      targetOrderUtc7Date: input.targetOrderUtc7Date,
      approvingManagerStaffId: input.managerStaffId,
    },
  };
}

/**
 * The adjudication request body, built once from the stored attestation.
 * D-2 must resubmit this object byte-identically on every retry and must never
 * re-mint or re-serialize any of it.
 */
export function buildOfflineAdjudicationRequest(attestation: OfflineAttestationEnvelope): {
  paa1Base64: string;
  ssa1Base64: string;
  oacEnvelopeBytesBase64: string;
} {
  return {
    paa1Base64: attestation.paa1Base64,
    ssa1Base64: attestation.ssa1Base64,
    oacEnvelopeBytesBase64: attestation.oacEnvelopeBytesBase64,
  };
}
