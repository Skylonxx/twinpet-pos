/**
 * requestManagerApprovalCore — Packet 2A pure decision core.
 *
 * Claim-neutral PIN step-up: payload validation, deterministic ids,
 * lockout policy math, approval-document builder, binding predicate,
 * and mint-outcome selection AFTER the single bcrypt compare.
 * No Admin SDK, no clock reads, no network.
 */

import { sha256Hex } from './shiftCloseValidationHash';
import { isLiveManagerApprovalPinCompareEligible, isWellFormedPin } from './pinPolicy';
import {
  PRIVILEGED_ACTION_IDS,
  PRIVILEGED_VOID_AUDIENCE,
  isApprovalAudience,
  isPrivilegedActionId,
} from './privilegedActionRegistry';

export { isLiveManagerApprovalPinCompareEligible, isWellFormedPin };
export { PRIVILEGED_VOID_AUDIENCE, isApprovalAudience };

export const APPROVAL_SCHEMA_VERSION = 1;
export const APPROVAL_AUDIENCE = 'resolveShiftCloseAlert';
export const APPROVAL_AUDIENCES = [APPROVAL_AUDIENCE, PRIVILEGED_VOID_AUDIENCE] as const;
export type ApprovalAudience = (typeof APPROVAL_AUDIENCES)[number];
export const APPROVAL_SECURITY_MODELS = ['reauth', 'delegated'] as const;
export type ApprovalSecurityModel = (typeof APPROVAL_SECURITY_MODELS)[number];
export const APPROVAL_SECURITY_MODEL: 'reauth' = 'reauth';
export const APPROVAL_SECURITY_MODEL_DELEGATED: 'delegated' = 'delegated';
export const MODEL2_REQUESTER_ROLES = ['staff'] as const;
export const MODEL2_APPROVER_ROLES = ['manager', 'admin'] as const;
export const APPROVAL_TTL_MS = 120_000;
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_WINDOW_MS = 900_000;
export const ATTEMPTS_SCHEMA_VERSION = 1;

export function isApprovalSecurityModel(value: unknown): value is ApprovalSecurityModel {
  return value === 'reauth' || value === 'delegated';
}

export function isModel2RequesterRole(role: string | null | undefined): boolean {
  return role === 'staff';
}

export function isModel2ApproverRole(role: string | null | undefined): boolean {
  return role === 'manager' || role === 'admin';
}

/** Staff requester: exact physical branch only. Never admits token `ALL`. */
export function requesterBranchEligible(liveBranchIds: readonly string[], branchId: string): boolean {
  return liveBranchIds.includes(branchId);
}

/** Manager: exact branch only. Admin: exact branch OR live `ALL`. */
export function approverBranchEligible(
  role: string | null | undefined,
  liveBranchIds: readonly string[],
  branchId: string,
): boolean {
  if (role === 'manager') return liveBranchIds.includes(branchId);
  if (role === 'admin') return liveBranchIds.includes('ALL') || liveBranchIds.includes(branchId);
  return false;
}

export const SHIFT_CLOSE_PROTECTED_ACTIONS = [
  'shift_close_alert_acknowledge',
  'shift_close_alert_resolve',
] as const;

/** Live wrapper accept-set. Packet B widens this to include closed void actions. */
export const LIVE_MANAGER_APPROVAL_ACTIONS = [
  ...SHIFT_CLOSE_PROTECTED_ACTIONS,
  ...PRIVILEGED_ACTION_IDS,
] as const;
export type LiveManagerApprovalAction = (typeof LIVE_MANAGER_APPROVAL_ACTIONS)[number];

export const PROTECTED_ACTIONS = [
  ...SHIFT_CLOSE_PROTECTED_ACTIONS,
  ...PRIVILEGED_ACTION_IDS,
] as const;

export type ProtectedAction = (typeof PROTECTED_ACTIONS)[number];

export type ManagerApprovalServerErrorCode =
  | 'invalid_credentials'
  | 'not_authorized'
  | 'branch_mismatch'
  | 'invalid_target'
  | 'locked'
  | 'expired_approval'
  | 'replayed_approval'
  | 'self_approval_not_permitted'
  | 'approver_not_eligible';

export type AdjudicationOutcome = 'acknowledge' | 'resolve';

export interface RequestManagerApprovalRequest {
  commandId?: string;
  protectedAction?: string;
  targetEntityId?: string;
  branchId?: string;
  pin?: string;
  securityModel?: string;
  approverStaffId?: string;
}

export interface ValidatedManagerApprovalRequest {
  commandId: string;
  protectedAction: ProtectedAction;
  targetEntityId: string;
  branchId: string;
  pin: string;
  securityModel: ApprovalSecurityModel;
  approverStaffId: string | null;
}

export type StructuralValidationResult =
  | { ok: true; value: ValidatedManagerApprovalRequest }
  | { ok: false; code: 'invalid_target' };

export interface ApprovalBindingExpected {
  audience: ApprovalAudience;
  protectedAction: ProtectedAction;
  targetEntityId: string;
  branchId: string;
  commandId: string;
  staffId: string;
  authVersion: number;
  /** Mint-only Model 2 expected approver. Omit at consume. */
  approverStaffId?: string;
  /** Mint-only Model 2 expected approver authVersion. Omit at consume. */
  approverAuthVersion?: number;
}

export interface ApprovalRecordView {
  audience: unknown;
  protectedAction: unknown;
  targetEntityId: unknown;
  branchId: unknown;
  commandId: unknown;
  requesterStaffId: unknown;
  approverStaffId: unknown;
  executorStaffId: unknown;
  securityModel: unknown;
  authVersionAtIssue: unknown;
  credentialVersionAtIssue: unknown;
  consumedAt: unknown;
  expiresAtMillis: number | null;
  approverAuthVersionAtIssue?: unknown;
}

export type MintOutcomeKind =
  | 'new_mint'
  | 'idempotent'
  | 'invalid_credentials'
  | 'replayed_approval'
  | 'expired_approval'
  | 'invalid_target';

export interface AttemptCounterView {
  consecutiveFailures: number;
  firstFailureAtMillis: number | null;
  lockedUntilMillis: number | null;
}

export interface NextAttemptState {
  consecutiveFailures: number;
  firstFailureAtMillis: number | null;
  lastFailureAtMillis: number | null;
  lockedUntilMillis: number | null;
}

export interface ApprovalDocumentFields {
  schemaVersion: number;
  audience: ApprovalAudience;
  protectedAction: ProtectedAction;
  targetEntityId: string;
  branchId: string;
  commandId: string;
  requesterStaffId: string;
  approverStaffId: string;
  executorStaffId: string;
  approverRole: string;
  securityModel: ApprovalSecurityModel;
  authVersionAtIssue: number;
  credentialVersionAtIssue: number;
  /** Model-2-only. Absent on reauth documents. */
  approverAuthVersionAtIssue?: number;
  consumedAt: null;
  consumedByStaffId: null;
  consumingAudience: null;
  consumedCaseVersion: null;
}

function slice40(preimage: string): string {
  return sha256Hex(preimage).slice(0, 40);
}

export function deriveApprovalId(commandId: string): string {
  return slice40('managerApproval:v1:' + commandId);
}

export function deriveAttemptScopeKey(branchId: string, staffId: string): string {
  return slice40('managerApprovalAttempts:v1:' + branchId + '|' + staffId);
}

export function isProtectedAction(value: unknown): value is ProtectedAction {
  return (PROTECTED_ACTIONS as readonly string[]).includes(value as string);
}

export function isLiveManagerApprovalAction(value: unknown): value is LiveManagerApprovalAction {
  return (LIVE_MANAGER_APPROVAL_ACTIONS as readonly string[]).includes(value as string);
}

/**
 * Total action→audience map. Unknown/unregistered → null (fail closed).
 * Privileged void is checked first so widening the live accept-set cannot
 * collapse void into the shift-close audience. Never defaults to shift-close.
 * Callers cannot override the derived audience.
 */
export function audienceForProtectedAction(action: string): ApprovalAudience | null {
  if (isPrivilegedActionId(action)) return PRIVILEGED_VOID_AUDIENCE;
  if ((SHIFT_CLOSE_PROTECTED_ACTIONS as readonly string[]).includes(action)) return APPROVAL_AUDIENCE;
  return null;
}

export function expectedActionFor(outcome: AdjudicationOutcome): ProtectedAction {
  return outcome === 'acknowledge' ? 'shift_close_alert_acknowledge' : 'shift_close_alert_resolve';
}

export function validateManagerApprovalRequest(req: RequestManagerApprovalRequest): StructuralValidationResult {
  const commandId = String(req.commandId ?? '').trim();
  const protectedAction = req.protectedAction;
  const targetEntityId = String(req.targetEntityId ?? '').trim();
  const branchId = String(req.branchId ?? '').trim();
  const pin = typeof req.pin === 'string' ? req.pin : '';
  const rawModel = req.securityModel;

  if (!commandId) return { ok: false, code: 'invalid_target' };
  if (!isProtectedAction(protectedAction)) return { ok: false, code: 'invalid_target' };
  if (!targetEntityId) return { ok: false, code: 'invalid_target' };
  if (!branchId || branchId === 'ALL') return { ok: false, code: 'invalid_target' };
  if (audienceForProtectedAction(protectedAction) == null) return { ok: false, code: 'invalid_target' };

  let securityModel: ApprovalSecurityModel;
  if (rawModel === undefined || rawModel === null || rawModel === '') {
    securityModel = APPROVAL_SECURITY_MODEL;
  } else if (isApprovalSecurityModel(rawModel)) {
    securityModel = rawModel;
  } else {
    return { ok: false, code: 'invalid_target' };
  }

  let approverStaffId: string | null = null;
  if (securityModel === APPROVAL_SECURITY_MODEL_DELEGATED) {
    const trimmed = String(req.approverStaffId ?? '').trim();
    if (!trimmed) return { ok: false, code: 'invalid_target' };
    approverStaffId = trimmed;
  }

  return {
    ok: true,
    value: { commandId, protectedAction, targetEntityId, branchId, pin, securityModel, approverStaffId },
  };
}

export function shouldUseRealPinCompare(params: {
  credentialExists: boolean;
  usableForLogin: boolean;
  disabled: boolean;
  credentialState: string | null;
  pin: string;
}): boolean {
  return (
    params.credentialExists &&
    params.usableForLogin &&
    params.disabled !== true &&
    params.credentialState === 'rotated_authoritative' &&
    isLiveManagerApprovalPinCompareEligible(params.pin)
  );
}

export function isLockoutActive(lockedUntilMillis: number | null, nowMillis: number): boolean {
  return lockedUntilMillis != null && lockedUntilMillis > nowMillis;
}

export function nextFailureAttemptState(
  current: AttemptCounterView | null,
  nowMillis: number,
): NextAttemptState {
  const windowExpired =
    current == null ||
    current.firstFailureAtMillis == null ||
    nowMillis - current.firstFailureAtMillis > LOCKOUT_WINDOW_MS;
  const consecutiveFailures = windowExpired ? 1 : current.consecutiveFailures + 1;
  const firstFailureAtMillis = windowExpired ? nowMillis : current.firstFailureAtMillis;
  const priorLock = windowExpired ? null : current.lockedUntilMillis;
  const lockedUntilMillis =
    consecutiveFailures >= LOCKOUT_THRESHOLD ? nowMillis + LOCKOUT_WINDOW_MS : priorLock;
  return {
    consecutiveFailures,
    firstFailureAtMillis,
    lastFailureAtMillis: nowMillis,
    lockedUntilMillis: lockedUntilMillis ?? null,
  };
}

export function resetAttemptState(): NextAttemptState {
  return {
    consecutiveFailures: 0,
    firstFailureAtMillis: null,
    lastFailureAtMillis: null,
    lockedUntilMillis: null,
  };
}

/**
 * CAS for a successful reset: skip if a newer failure (higher counter or a
 * newly established/extended lock) committed after the pre-bcrypt snapshot.
 * Prevents a stale success from unlocking or wiping later attempt state.
 */
export function shouldApplyAttemptReset(
  observed: AttemptCounterView | null,
  latest: AttemptCounterView | null,
): boolean {
  const observedCount = observed?.consecutiveFailures ?? 0;
  const latestCount = latest?.consecutiveFailures ?? 0;
  if (latestCount > observedCount) return false;
  const observedLock = observed?.lockedUntilMillis ?? null;
  const latestLock = latest?.lockedUntilMillis ?? null;
  if (latestLock != null && latestLock > (observedLock ?? 0)) return false;
  return true;
}

export function checkApprovalBinding(
  record: ApprovalRecordView,
  expected: ApprovalBindingExpected,
): boolean {
  if (record.securityModel === APPROVAL_SECURITY_MODEL) {
    if (record.audience !== expected.audience) return false;
    if (record.protectedAction !== expected.protectedAction) return false;
    if (record.targetEntityId !== expected.targetEntityId) return false;
    if (record.branchId !== expected.branchId) return false;
    if (record.commandId !== expected.commandId) return false;
    if (record.requesterStaffId !== expected.staffId) return false;
    if (record.approverStaffId !== expected.staffId) return false;
    if (record.executorStaffId !== expected.staffId) return false;
    if (record.requesterStaffId !== record.approverStaffId) return false;
    if (record.approverStaffId !== record.executorStaffId) return false;
    if (record.securityModel !== APPROVAL_SECURITY_MODEL) return false;
    if (record.authVersionAtIssue !== expected.authVersion) return false;
    return true;
  }
  if (record.securityModel === APPROVAL_SECURITY_MODEL_DELEGATED) {
    if (record.audience !== expected.audience) return false;
    if (record.protectedAction !== expected.protectedAction) return false;
    if (record.targetEntityId !== expected.targetEntityId) return false;
    if (record.branchId !== expected.branchId) return false;
    if (record.commandId !== expected.commandId) return false;
    if (record.requesterStaffId !== expected.staffId) return false;
    if (typeof record.approverStaffId !== 'string' || record.approverStaffId.length === 0) return false;
    if (record.executorStaffId !== expected.staffId) return false;
    if (record.requesterStaffId === record.approverStaffId) return false;
    if (record.executorStaffId !== record.requesterStaffId) return false;
    if (record.securityModel !== APPROVAL_SECURITY_MODEL_DELEGATED) return false;
    if (record.authVersionAtIssue !== expected.authVersion) return false;
    if (expected.approverStaffId !== undefined && record.approverStaffId !== expected.approverStaffId) return false;
    if (
      expected.approverAuthVersion !== undefined &&
      record.approverAuthVersionAtIssue !== expected.approverAuthVersion
    ) {
      return false;
    }
    return true;
  }
  return false;
}

export function selectMintOutcome(
  compareOk: boolean,
  record: ApprovalRecordView | null,
  expected: ApprovalBindingExpected,
  nowMillis: number,
): MintOutcomeKind {
  if (!compareOk) return 'invalid_credentials';
  if (record == null) return 'new_mint';
  if (!checkApprovalBinding(record, expected)) return 'invalid_target';
  if (record.consumedAt != null) return 'replayed_approval';
  if (record.expiresAtMillis == null || record.expiresAtMillis <= nowMillis) return 'expired_approval';
  return 'idempotent';
}

export function buildApprovalDocument(params: {
  commandId: string;
  protectedAction: ProtectedAction;
  targetEntityId: string;
  branchId: string;
  staffId: string;
  approverRole: string;
  authVersionAtIssue: number;
  credentialVersionAtIssue: number;
  securityModel?: ApprovalSecurityModel;
  approverStaffId?: string;
  approverAuthVersionAtIssue?: number;
}): ApprovalDocumentFields {
  const securityModel = params.securityModel ?? APPROVAL_SECURITY_MODEL;
  const requesterStaffId = params.staffId;
  const approverStaffId =
    securityModel === APPROVAL_SECURITY_MODEL_DELEGATED ? (params.approverStaffId ?? '') : params.staffId;
  const audience = audienceForProtectedAction(params.protectedAction);
  if (audience == null) {
    throw new Error('unregistered_protected_action');
  }
  const fields: ApprovalDocumentFields = {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    audience,
    protectedAction: params.protectedAction,
    targetEntityId: params.targetEntityId,
    branchId: params.branchId,
    commandId: params.commandId,
    requesterStaffId,
    approverStaffId,
    executorStaffId: requesterStaffId,
    approverRole: params.approverRole,
    securityModel,
    authVersionAtIssue: params.authVersionAtIssue,
    credentialVersionAtIssue: params.credentialVersionAtIssue,
    consumedAt: null,
    consumedByStaffId: null,
    consumingAudience: null,
    consumedCaseVersion: null,
  };
  if (securityModel === APPROVAL_SECURITY_MODEL_DELEGATED) {
    fields.approverAuthVersionAtIssue = params.approverAuthVersionAtIssue ?? 0;
  }
  return fields;
}

export function approvalDocHasPinAdjacentField(doc: Record<string, unknown>): boolean {
  const forbidden = ['pin', 'pinHash', 'partialPin', 'pinDigest', 'pinPrefix'];
  return forbidden.some((key) => Object.prototype.hasOwnProperty.call(doc, key));
}
