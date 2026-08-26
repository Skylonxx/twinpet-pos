/**
 * requestManagerApprovalCore — Packet 2A pure decision core.
 *
 * Claim-neutral PIN step-up: payload validation, deterministic ids,
 * lockout policy math, approval-document builder, binding predicate,
 * and mint-outcome selection AFTER the single bcrypt compare.
 * No Admin SDK, no clock reads, no network.
 */

import { sha256Hex } from './shiftCloseValidationHash';

export const APPROVAL_SCHEMA_VERSION = 1;
export const APPROVAL_AUDIENCE = 'resolveShiftCloseAlert';
export const APPROVAL_SECURITY_MODEL = 'reauth';
export const APPROVAL_TTL_MS = 120_000;
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_WINDOW_MS = 900_000;
export const ATTEMPTS_SCHEMA_VERSION = 1;

export const PROTECTED_ACTIONS = [
  'shift_close_alert_acknowledge',
  'shift_close_alert_resolve',
] as const;

export type ProtectedAction = (typeof PROTECTED_ACTIONS)[number];

export type ManagerApprovalServerErrorCode =
  | 'invalid_credentials'
  | 'not_authorized'
  | 'branch_mismatch'
  | 'invalid_target'
  | 'locked'
  | 'expired_approval'
  | 'replayed_approval';

export type AdjudicationOutcome = 'acknowledge' | 'resolve';

export interface RequestManagerApprovalRequest {
  commandId?: string;
  protectedAction?: string;
  targetEntityId?: string;
  branchId?: string;
  pin?: string;
}

export interface ValidatedManagerApprovalRequest {
  commandId: string;
  protectedAction: ProtectedAction;
  targetEntityId: string;
  branchId: string;
  pin: string;
}

export type StructuralValidationResult =
  | { ok: true; value: ValidatedManagerApprovalRequest }
  | { ok: false; code: 'invalid_target' };

export interface ApprovalBindingExpected {
  audience: typeof APPROVAL_AUDIENCE;
  protectedAction: ProtectedAction;
  targetEntityId: string;
  branchId: string;
  commandId: string;
  staffId: string;
  authVersion: number;
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
  audience: typeof APPROVAL_AUDIENCE;
  protectedAction: ProtectedAction;
  targetEntityId: string;
  branchId: string;
  commandId: string;
  requesterStaffId: string;
  approverStaffId: string;
  executorStaffId: string;
  approverRole: string;
  securityModel: typeof APPROVAL_SECURITY_MODEL;
  authVersionAtIssue: number;
  credentialVersionAtIssue: number;
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
  return value === 'shift_close_alert_acknowledge' || value === 'shift_close_alert_resolve';
}

export function expectedActionFor(outcome: AdjudicationOutcome): ProtectedAction {
  return outcome === 'acknowledge' ? 'shift_close_alert_acknowledge' : 'shift_close_alert_resolve';
}

export function isWellFormedPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

export function validateManagerApprovalRequest(req: RequestManagerApprovalRequest): StructuralValidationResult {
  const commandId = String(req.commandId ?? '').trim();
  const protectedAction = req.protectedAction;
  const targetEntityId = String(req.targetEntityId ?? '').trim();
  const branchId = String(req.branchId ?? '').trim();
  const pin = typeof req.pin === 'string' ? req.pin : '';

  if (!commandId) return { ok: false, code: 'invalid_target' };
  if (!isProtectedAction(protectedAction)) return { ok: false, code: 'invalid_target' };
  if (!targetEntityId) return { ok: false, code: 'invalid_target' };
  if (!branchId || branchId === 'ALL') return { ok: false, code: 'invalid_target' };

  return {
    ok: true,
    value: { commandId, protectedAction, targetEntityId, branchId, pin },
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
    isWellFormedPin(params.pin)
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
}): ApprovalDocumentFields {
  return {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    audience: APPROVAL_AUDIENCE,
    protectedAction: params.protectedAction,
    targetEntityId: params.targetEntityId,
    branchId: params.branchId,
    commandId: params.commandId,
    requesterStaffId: params.staffId,
    approverStaffId: params.staffId,
    executorStaffId: params.staffId,
    approverRole: params.approverRole,
    securityModel: APPROVAL_SECURITY_MODEL,
    authVersionAtIssue: params.authVersionAtIssue,
    credentialVersionAtIssue: params.credentialVersionAtIssue,
    consumedAt: null,
    consumedByStaffId: null,
    consumingAudience: null,
    consumedCaseVersion: null,
  };
}

export function approvalDocHasPinAdjacentField(doc: Record<string, unknown>): boolean {
  const forbidden = ['pin', 'pinHash', 'partialPin', 'pinDigest', 'pinPrefix'];
  return forbidden.some((key) => Object.prototype.hasOwnProperty.call(doc, key));
}
