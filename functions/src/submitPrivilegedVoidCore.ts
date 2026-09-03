/**
 * submitPrivilegedVoidCore — Packet B pure decision helpers.
 *
 * Request validation, same-day (UTC+7) predicate, action/status matching,
 * nonce key derivation, already-voided detection. No Admin SDK, no clock reads.
 */

import { sha256Hex } from './shiftCloseValidationHash';
import {
  PRIVILEGED_VOID_AUDIENCE,
  isPrivilegedActionId,
  type PrivilegedActionId,
} from './privilegedActionRegistry';
import {
  type ApprovalBindingExpected,
  type ApprovalRecordView,
  type ManagerApprovalServerErrorCode,
  type ProtectedAction,
  checkApprovalBinding,
  isProtectedAction,
} from './requestManagerApprovalCore';

export { PRIVILEGED_VOID_AUDIENCE };

export const UTC_PLUS_7_OFFSET_MS = 7 * 60 * 60 * 1000;

export type SubmitPrivilegedVoidRequest = {
  commandId?: string;
  protectedAction?: string;
  targetEntityId?: string;
  branchId?: string;
  voidReason?: string;
  managerApproved?: unknown;
};

export type ValidatedSubmitPrivilegedVoidRequest = {
  commandId: string;
  protectedAction: PrivilegedActionId;
  targetEntityId: string;
  branchId: string;
  voidReason: string | null;
};

export type SubmitVoidStructuralResult =
  | { ok: true; value: ValidatedSubmitPrivilegedVoidRequest }
  | { ok: false; code: 'invalid_target' };

export function derivePrivilegedNonceKey(branchId: string, approvalId: string): string {
  return sha256Hex('privilegedActionNonce:v1:' + branchId + '|' + approvalId).slice(0, 40);
}

export function utcPlus7Date(ms: number): string {
  const shifted = new Date(ms + UTC_PLUS_7_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isSameUtc7Day(serverCreatedAtMs: number, nowMs: number): boolean {
  return utcPlus7Date(serverCreatedAtMs) === utcPlus7Date(nowMs);
}

export function timestampToMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === 'object' && value !== null && 'toMillis' in value) {
    const fn = (value as { toMillis?: unknown }).toMillis;
    if (typeof fn === 'function') {
      const ms = fn.call(value);
      return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
    }
  }
  return null;
}

export function validateSubmitPrivilegedVoidRequest(req: SubmitPrivilegedVoidRequest): SubmitVoidStructuralResult {
  const commandId = String(req.commandId ?? '').trim();
  const protectedAction = req.protectedAction;
  const targetEntityId = String(req.targetEntityId ?? '').trim();
  const branchId = String(req.branchId ?? '').trim();
  const rawReason = req.voidReason;
  const voidReason =
    typeof rawReason === 'string' && rawReason.trim().length > 0 ? rawReason.trim() : null;

  if (!commandId) return { ok: false, code: 'invalid_target' };
  if (!isProtectedAction(protectedAction) || !isPrivilegedActionId(protectedAction)) {
    return { ok: false, code: 'invalid_target' };
  }
  if (!targetEntityId) return { ok: false, code: 'invalid_target' };
  if (!branchId || branchId === 'ALL') return { ok: false, code: 'invalid_target' };

  return {
    ok: true,
    value: { commandId, protectedAction, targetEntityId, branchId, voidReason },
  };
}

export function voidActionMatchesReconcileStatus(
  action: PrivilegedActionId,
  reconcileStatus: unknown,
): boolean {
  if (action === 'VOID_PENDING_SALE') return reconcileStatus === 'pending_reconcile';
  if (action === 'VOID_SETTLED_SALE') return reconcileStatus === 'settled';
  return false;
}

export function isAlreadyCanonicallyVoided(order: Record<string, unknown> | null | undefined): boolean {
  if (order == null) return false;
  return order.status === 'voided' || order.voidReconciled === true;
}

export const PRIVILEGED_VOID_EXECUTION_ID_FIELD = 'privilegedVoidExecutionId' as const;

export function derivePrivilegedVoidExecutionId(binding: PrivilegedExecutionBinding): string {
  return sha256Hex(
    'privilegedVoidExecution:v1:' +
      [
        binding.approvalId,
        binding.commandId,
        binding.protectedAction,
        binding.targetEntityId,
        binding.branchId,
        binding.requesterStaffId,
        binding.approvingManagerId,
        binding.audience,
      ].join('|'),
  ).slice(0, 40);
}

export function readPrivilegedVoidExecutionId(
  order: Record<string, unknown> | null | undefined,
): string | null {
  if (order == null) return null;
  const raw = order[PRIVILEGED_VOID_EXECUTION_ID_FIELD];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export type CanonicalVoidCorrelationDecision = 'NOT_VOIDED' | 'MATCHING' | 'MISSING' | 'DIFFERENT';

/**
 * Generic `voided` / `voidReconciled` is never exact-completion evidence.
 * Only a matching server-owned privilegedVoidExecutionId proves this execution won.
 */
export function decideCanonicalVoidCorrelation(
  order: Record<string, unknown> | null | undefined,
  expectedExecutionId: string,
): CanonicalVoidCorrelationDecision {
  if (!isAlreadyCanonicallyVoided(order)) return 'NOT_VOIDED';
  const existing = readPrivilegedVoidExecutionId(order);
  if (existing == null) return 'MISSING';
  if (existing === expectedExecutionId) return 'MATCHING';
  return 'DIFFERENT';
}

export function buildVoidConsumeBinding(params: {
  protectedAction: ProtectedAction;
  targetEntityId: string;
  branchId: string;
  commandId: string;
  staffId: string;
  authVersion: number;
}): ApprovalBindingExpected {
  return {
    audience: PRIVILEGED_VOID_AUDIENCE,
    protectedAction: params.protectedAction,
    targetEntityId: params.targetEntityId,
    branchId: params.branchId,
    commandId: params.commandId,
    staffId: params.staffId,
    authVersion: params.authVersion,
  };
}

export function approvalIsSelfApproved(record: ApprovalRecordView): boolean {
  return record.requesterStaffId === record.approverStaffId;
}

export type SubmitPrivilegedVoidRejectCode = ManagerApprovalServerErrorCode;

export function consumeBindingRejectedReason(
  record: ApprovalRecordView | null,
  expected: ApprovalBindingExpected,
  nowMillis: number,
): SubmitPrivilegedVoidRejectCode | null {
  if (record == null) return 'invalid_target';
  if (approvalIsSelfApproved(record)) return 'self_approval_not_permitted';
  if (!checkApprovalBinding(record, expected)) return 'invalid_target';
  if (record.expiresAtMillis == null || record.expiresAtMillis <= nowMillis) return 'expired_approval';
  return null;
}

export const PRIVILEGED_EXECUTION_STATUS_PENDING = 'CONSUMED_PENDING_EXECUTION' as const;
export const PRIVILEGED_EXECUTION_STATUS_COMPLETED = 'COMPLETED' as const;
export type PrivilegedExecutionStatus =
  | typeof PRIVILEGED_EXECUTION_STATUS_PENDING
  | typeof PRIVILEGED_EXECUTION_STATUS_COMPLETED;

export type PrivilegedExecutionRecordView = {
  schemaVersion: 1;
  status: PrivilegedExecutionStatus;
  nonceKey: string;
  approvalId: string;
  commandId: string;
  protectedAction: string;
  targetEntityId: string;
  branchId: string;
  requesterStaffId: string;
  approvingManagerId: string;
  audience: string;
  consumedAtMillis: number | null;
  completedAtMillis: number | null;
  outcomeKind: string | null;
};

export type PrivilegedExecutionBinding = {
  nonceKey: string;
  approvalId: string;
  commandId: string;
  protectedAction: string;
  targetEntityId: string;
  branchId: string;
  requesterStaffId: string;
  approvingManagerId: string;
  audience: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parsePrivilegedExecutionRecord(data: unknown): PrivilegedExecutionRecordView | null {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return null;
  const raw = data as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return null;
  if (
    raw.status !== PRIVILEGED_EXECUTION_STATUS_PENDING &&
    raw.status !== PRIVILEGED_EXECUTION_STATUS_COMPLETED
  ) {
    return null;
  }
  if (!isNonEmptyString(raw.nonceKey)) return null;
  if (!isNonEmptyString(raw.approvalId)) return null;
  if (!isNonEmptyString(raw.commandId)) return null;
  if (!isNonEmptyString(raw.protectedAction)) return null;
  if (!isNonEmptyString(raw.targetEntityId)) return null;
  if (!isNonEmptyString(raw.branchId)) return null;
  if (!isNonEmptyString(raw.requesterStaffId)) return null;
  if (!isNonEmptyString(raw.approvingManagerId)) return null;
  if (!isNonEmptyString(raw.audience)) return null;
  const consumedAtMillis =
    raw.consumedAtMillis == null
      ? null
      : typeof raw.consumedAtMillis === 'number' && Number.isFinite(raw.consumedAtMillis)
        ? raw.consumedAtMillis
        : null;
  if (raw.consumedAtMillis != null && consumedAtMillis == null) return null;
  const completedAtMillis =
    raw.completedAtMillis == null
      ? null
      : typeof raw.completedAtMillis === 'number' && Number.isFinite(raw.completedAtMillis)
        ? raw.completedAtMillis
        : null;
  if (raw.completedAtMillis != null && completedAtMillis == null) return null;
  const outcomeKind =
    raw.outcomeKind == null ? null : typeof raw.outcomeKind === 'string' ? raw.outcomeKind : null;
  if (raw.outcomeKind != null && outcomeKind == null) return null;
  return {
    schemaVersion: 1,
    status: raw.status,
    nonceKey: raw.nonceKey,
    approvalId: raw.approvalId,
    commandId: raw.commandId,
    protectedAction: raw.protectedAction,
    targetEntityId: raw.targetEntityId,
    branchId: raw.branchId,
    requesterStaffId: raw.requesterStaffId,
    approvingManagerId: raw.approvingManagerId,
    audience: raw.audience,
    consumedAtMillis,
    completedAtMillis,
    outcomeKind,
  };
}

export function buildPrivilegedExecutionBinding(params: PrivilegedExecutionBinding): PrivilegedExecutionBinding {
  return {
    nonceKey: params.nonceKey,
    approvalId: params.approvalId,
    commandId: params.commandId,
    protectedAction: params.protectedAction,
    targetEntityId: params.targetEntityId,
    branchId: params.branchId,
    requesterStaffId: params.requesterStaffId,
    approvingManagerId: params.approvingManagerId,
    audience: params.audience,
  };
}

export function executionRecordMatchesBinding(
  record: PrivilegedExecutionRecordView,
  expected: PrivilegedExecutionBinding,
): boolean {
  return (
    record.nonceKey === expected.nonceKey &&
    record.approvalId === expected.approvalId &&
    record.commandId === expected.commandId &&
    record.protectedAction === expected.protectedAction &&
    record.targetEntityId === expected.targetEntityId &&
    record.branchId === expected.branchId &&
    record.requesterStaffId === expected.requesterStaffId &&
    record.approvingManagerId === expected.approvingManagerId &&
    record.audience === expected.audience
  );
}

/** Resume of a consumed execution never consults the original approval TTL. */
export function resumeExecutionRejectedReason(
  record: PrivilegedExecutionRecordView | null,
  expected: PrivilegedExecutionBinding,
): Extract<SubmitPrivilegedVoidRejectCode, 'invalid_target'> | null {
  if (record == null) return 'invalid_target';
  if (!executionRecordMatchesBinding(record, expected)) return 'invalid_target';
  return null;
}
