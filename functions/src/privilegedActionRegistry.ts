/**
 * Privileged-action registry and SEC-001 schema contracts (pure).
 *
 * Closed allowlist. No permissive default. No Firestore, crypto, or wiring.
 * Matched client contract: `src/lib/auth/privilegedAction/privilegedActionTypes.ts`.
 */

export const PRIVILEGED_ACTION_IDS = ['VOID_PENDING_SALE', 'VOID_SETTLED_SALE'] as const;
export type PrivilegedActionId = (typeof PRIVILEGED_ACTION_IDS)[number];

export const PRIVILEGED_VOID_AUDIENCE = 'privilegedVoid' as const;
export const SHIFT_CLOSE_APPROVAL_AUDIENCE = 'resolveShiftCloseAlert' as const;
export const APPROVAL_AUDIENCES = [SHIFT_CLOSE_APPROVAL_AUDIENCE, PRIVILEGED_VOID_AUDIENCE] as const;
export type ApprovalAudience = (typeof APPROVAL_AUDIENCES)[number];

export const PRIVILEGED_APPROVER_ROLES = ['manager', 'admin'] as const;
export type PrivilegedApproverRole = (typeof PRIVILEGED_APPROVER_ROLES)[number];

export const PRIVILEGED_REQUESTER_PERMISSION = 'pos_void' as const;
export const PRIVILEGED_APPROVER_PERMISSION = 'pos_void' as const;

export interface PrivilegedActionRequirement {
  audience: typeof PRIVILEGED_VOID_AUDIENCE;
  requesterPermission: typeof PRIVILEGED_REQUESTER_PERMISSION;
  approverPermission: typeof PRIVILEGED_APPROVER_PERMISSION;
  approverRoles: readonly PrivilegedApproverRole[];
  exactBranchRequired: true;
}

function freezePrivilegedRequirement(
  requirement: PrivilegedActionRequirement,
): PrivilegedActionRequirement {
  return Object.freeze({
    audience: requirement.audience,
    requesterPermission: requirement.requesterPermission,
    approverPermission: requirement.approverPermission,
    approverRoles: Object.freeze([...requirement.approverRoles]) as readonly PrivilegedApproverRole[],
    exactBranchRequired: requirement.exactBranchRequired,
  });
}

export const ACTION_REQUIREMENTS: { readonly [K in PrivilegedActionId]: PrivilegedActionRequirement } =
  Object.freeze({
    VOID_PENDING_SALE: freezePrivilegedRequirement({
      audience: PRIVILEGED_VOID_AUDIENCE,
      requesterPermission: PRIVILEGED_REQUESTER_PERMISSION,
      approverPermission: PRIVILEGED_APPROVER_PERMISSION,
      approverRoles: PRIVILEGED_APPROVER_ROLES,
      exactBranchRequired: true,
    }),
    VOID_SETTLED_SALE: freezePrivilegedRequirement({
      audience: PRIVILEGED_VOID_AUDIENCE,
      requesterPermission: PRIVILEGED_REQUESTER_PERMISSION,
      approverPermission: PRIVILEGED_APPROVER_PERMISSION,
      approverRoles: PRIVILEGED_APPROVER_ROLES,
      exactBranchRequired: true,
    }),
  });

export type PrivilegedActionSecurityContractManifest = {
  actionIds: readonly PrivilegedActionId[];
  requirements: {
    readonly [K in PrivilegedActionId]: {
      audience: typeof PRIVILEGED_VOID_AUDIENCE;
      requesterPermission: typeof PRIVILEGED_REQUESTER_PERMISSION;
      approverPermission: typeof PRIVILEGED_APPROVER_PERMISSION;
      approverRoles: readonly PrivilegedApproverRole[];
      exactBranchRequired: true;
    };
  };
};

export function privilegedActionSecurityContractManifest(): PrivilegedActionSecurityContractManifest {
  const requirementManifest = (id: PrivilegedActionId) => ({
    audience: ACTION_REQUIREMENTS[id].audience,
    requesterPermission: ACTION_REQUIREMENTS[id].requesterPermission,
    approverPermission: ACTION_REQUIREMENTS[id].approverPermission,
    approverRoles: [...ACTION_REQUIREMENTS[id].approverRoles],
    exactBranchRequired: ACTION_REQUIREMENTS[id].exactBranchRequired,
  });
  return {
    actionIds: [...PRIVILEGED_ACTION_IDS],
    requirements: {
      VOID_PENDING_SALE: requirementManifest('VOID_PENDING_SALE'),
      VOID_SETTLED_SALE: requirementManifest('VOID_SETTLED_SALE'),
    },
  };
}

export function isPrivilegedActionId(value: unknown): value is PrivilegedActionId {
  return value === 'VOID_PENDING_SALE' || value === 'VOID_SETTLED_SALE';
}

export function isApprovalAudience(value: unknown): value is ApprovalAudience {
  return value === SHIFT_CLOSE_APPROVAL_AUDIENCE || value === PRIVILEGED_VOID_AUDIENCE;
}

/** Allowlist lookup. Unknown action → null. Never a permissive default. */
export function getActionRequirement(actionId: string): PrivilegedActionRequirement | null {
  if (!isPrivilegedActionId(actionId)) return null;
  return ACTION_REQUIREMENTS[actionId];
}

export function isClosedAllowedActions(actions: readonly string[]): actions is readonly PrivilegedActionId[] {
  if (!Array.isArray(actions) || actions.length === 0) return false;
  const seen = new Set<string>();
  for (const action of actions) {
    if (!isPrivilegedActionId(action)) return false;
    if (seen.has(action)) return false;
    seen.add(action);
  }
  return true;
}

export const OAC_SCHEMA_VERSION = 1 as const;
export const OAC_VERIFIER_ALGO = 'argon2id' as const;
export const OAC_BRANCH_ALL_FORBIDDEN = 'ALL' as const;

/** Argon2id contract minimums. No KDF implementation. m is KiB (64 MiB). */
export const OAC_VERIFIER_PARAM_MINIMUMS = Object.freeze({
  m: 65536,
  t: 3,
  p: 1,
  saltLen: 16,
  hashLen: 32,
});

export interface OacVerifierParamsV1 {
  m: number;
  t: number;
  p: number;
  saltLen: number;
  hashLen: number;
}

export interface OfflineAuthorizationCapabilityV1 {
  oacId: string;
  schemaVersion: typeof OAC_SCHEMA_VERSION;
  managerStaffId: string;
  managerRole: PrivilegedApproverRole;
  branchId: string;
  deviceId: string;
  allowedActions: readonly PrivilegedActionId[];
  authVersionAtIssue: number;
  credentialVersionAtIssue: number;
  revocationEpoch: number;
  issuedAtServerMs: number;
  freshnessExpiresAtServerMs: number;
  verifierAlgo: typeof OAC_VERIFIER_ALGO;
  verifierParams: OacVerifierParamsV1;
  verifierSalt: string;
  verifier: string;
  pepperCommitment: string;
  signature: string;
  signingKeyId: string;
}

export type OacValidationFailureCode =
  | 'invalid_oac_schema'
  | 'branch_all_forbidden'
  | 'unknown_action'
  | 'empty_allowed_actions';

export type OacValidationResult =
  | { ok: true; value: OfflineAuthorizationCapabilityV1 }
  | { ok: false; code: OacValidationFailureCode };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isApproverRole(value: unknown): value is PrivilegedApproverRole {
  return value === 'manager' || value === 'admin';
}

function isVerifierParams(value: unknown): value is OacVerifierParamsV1 {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return (
    isPositiveInt(p.m) &&
    p.m >= OAC_VERIFIER_PARAM_MINIMUMS.m &&
    isPositiveInt(p.t) &&
    p.t >= OAC_VERIFIER_PARAM_MINIMUMS.t &&
    isPositiveInt(p.p) &&
    p.p === OAC_VERIFIER_PARAM_MINIMUMS.p &&
    isPositiveInt(p.saltLen) &&
    p.saltLen >= OAC_VERIFIER_PARAM_MINIMUMS.saltLen &&
    isPositiveInt(p.hashLen) &&
    p.hashLen >= OAC_VERIFIER_PARAM_MINIMUMS.hashLen
  );
}

export function validateOacEnvelopeV1(input: unknown): OacValidationResult {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'invalid_oac_schema' };
  }
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== OAC_SCHEMA_VERSION) return { ok: false, code: 'invalid_oac_schema' };
  if (!isNonEmptyString(raw.branchId)) return { ok: false, code: 'invalid_oac_schema' };
  if (raw.branchId === OAC_BRANCH_ALL_FORBIDDEN) return { ok: false, code: 'branch_all_forbidden' };
  if (!Array.isArray(raw.allowedActions)) return { ok: false, code: 'invalid_oac_schema' };
  if (raw.allowedActions.length === 0) return { ok: false, code: 'empty_allowed_actions' };
  if (!isClosedAllowedActions(raw.allowedActions)) return { ok: false, code: 'unknown_action' };

  if (
    !isNonEmptyString(raw.oacId) ||
    !isNonEmptyString(raw.managerStaffId) ||
    !isApproverRole(raw.managerRole) ||
    !isNonEmptyString(raw.deviceId) ||
    !isNonNegativeInt(raw.authVersionAtIssue) ||
    !isNonNegativeInt(raw.credentialVersionAtIssue) ||
    !isNonNegativeInt(raw.revocationEpoch) ||
    !isPositiveInt(raw.issuedAtServerMs) ||
    !isPositiveInt(raw.freshnessExpiresAtServerMs) ||
    raw.verifierAlgo !== OAC_VERIFIER_ALGO ||
    !isVerifierParams(raw.verifierParams) ||
    !isNonEmptyString(raw.verifierSalt) ||
    !isNonEmptyString(raw.verifier) ||
    !isNonEmptyString(raw.pepperCommitment) ||
    !isNonEmptyString(raw.signature) ||
    !isNonEmptyString(raw.signingKeyId)
  ) {
    return { ok: false, code: 'invalid_oac_schema' };
  }

  const value: OfflineAuthorizationCapabilityV1 = {
    oacId: raw.oacId,
    schemaVersion: OAC_SCHEMA_VERSION,
    managerStaffId: raw.managerStaffId,
    managerRole: raw.managerRole,
    branchId: raw.branchId,
    deviceId: raw.deviceId,
    allowedActions: raw.allowedActions,
    authVersionAtIssue: raw.authVersionAtIssue,
    credentialVersionAtIssue: raw.credentialVersionAtIssue,
    revocationEpoch: raw.revocationEpoch,
    issuedAtServerMs: raw.issuedAtServerMs,
    freshnessExpiresAtServerMs: raw.freshnessExpiresAtServerMs,
    verifierAlgo: OAC_VERIFIER_ALGO,
    verifierParams: {
      m: raw.verifierParams.m,
      t: raw.verifierParams.t,
      p: raw.verifierParams.p,
      saltLen: raw.verifierParams.saltLen,
      hashLen: raw.verifierParams.hashLen,
    },
    verifierSalt: raw.verifierSalt,
    verifier: raw.verifier,
    pepperCommitment: raw.pepperCommitment,
    signature: raw.signature,
    signingKeyId: raw.signingKeyId,
  };
  return { ok: true, value };
}

export const EVIDENCE_SCHEMA_VERSION = 1 as const;

export const PRIVILEGED_APPROVAL_RESULTS = [
  'APPROVED_LOCAL',
  'DENIED_INVALID_PIN',
  'DENIED_LOCKED',
  'DENIED_STALE',
  'DENIED_UNVERIFIABLE',
] as const;
export type PrivilegedApprovalResult = (typeof PRIVILEGED_APPROVAL_RESULTS)[number];

export const PRIVILEGED_EVIDENCE_SYNC_STATUSES = [
  'LOCAL_AUTH_PENDING',
  'LOCAL_AUTH_ACCEPTED',
  'PRIVILEGED_INTENT_QUEUED',
  'SYNCING',
  'SERVER_ACCEPTED',
  'SERVER_REJECTED',
  'MANUAL_ATTENTION',
] as const;
export type PrivilegedEvidenceSyncStatus = (typeof PRIVILEGED_EVIDENCE_SYNC_STATUSES)[number];

export const PRIVILEGED_SERVER_VERDICTS = ['ACCEPTED', 'REJECTED'] as const;
export type PrivilegedServerVerdict = (typeof PRIVILEGED_SERVER_VERDICTS)[number];

export const PRIVILEGED_MANUAL_REVIEW_STATUSES = ['NOT_REQUIRED', 'REQUIRED', 'RESOLVED'] as const;
export type PrivilegedManualReviewStatus = (typeof PRIVILEGED_MANUAL_REVIEW_STATUSES)[number];

export interface PrivilegedActionEvidenceV1 {
  evidenceId: string;
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  privilegedActionRequestId: string;
  actionId: PrivilegedActionId;
  targetOrderId: string;
  branchId: string;
  initiatingStaffId: string;
  approvingManagerId: string;
  deviceId: string;
  localSeq: number;
  localObservedAtMs: number;
  anchorServerMs: number;
  anchorSeq: number;
  estimatedApprovalMs: number;
  managerAuthVersionAtIssue: number;
  managerCredentialVersionAtIssue: number;
  oacId: string;
  oacSchemaVersion: typeof OAC_SCHEMA_VERSION;
  revocationEpochAtIssue: number;
  nonce: string;
  attemptCount: number;
  approvalResult: PrivilegedApprovalResult;
  approvalProofDigest: string;
  localIntentId: string;
  resultingVoidIntentId: string | null;
  syncStatus: PrivilegedEvidenceSyncStatus;
  serverVerdict: PrivilegedServerVerdict | null;
  serverRejectionReason: string | null;
  manualReviewStatus: PrivilegedManualReviewStatus;
}

export type EvidenceValidationFailureCode = 'invalid_evidence_schema' | 'branch_all_forbidden' | 'unknown_action';

export type EvidenceValidationResult =
  | { ok: true; value: PrivilegedActionEvidenceV1 }
  | { ok: false; code: EvidenceValidationFailureCode };

function isApprovalResult(value: unknown): value is PrivilegedApprovalResult {
  return (
    value === 'APPROVED_LOCAL' ||
    value === 'DENIED_INVALID_PIN' ||
    value === 'DENIED_LOCKED' ||
    value === 'DENIED_STALE' ||
    value === 'DENIED_UNVERIFIABLE'
  );
}

function isSyncStatus(value: unknown): value is PrivilegedEvidenceSyncStatus {
  return (PRIVILEGED_EVIDENCE_SYNC_STATUSES as readonly string[]).includes(value as string);
}

function isManualReviewStatus(value: unknown): value is PrivilegedManualReviewStatus {
  return value === 'NOT_REQUIRED' || value === 'REQUIRED' || value === 'RESOLVED';
}

function isServerVerdict(value: unknown): value is PrivilegedServerVerdict | null {
  return value === null || value === 'ACCEPTED' || value === 'REJECTED';
}

export function validatePrivilegedActionEvidenceV1(input: unknown): EvidenceValidationResult {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'invalid_evidence_schema' };
  }
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== EVIDENCE_SCHEMA_VERSION) return { ok: false, code: 'invalid_evidence_schema' };
  if (!isNonEmptyString(raw.branchId)) return { ok: false, code: 'invalid_evidence_schema' };
  if (raw.branchId === OAC_BRANCH_ALL_FORBIDDEN) return { ok: false, code: 'branch_all_forbidden' };
  if (!isPrivilegedActionId(raw.actionId)) return { ok: false, code: 'unknown_action' };

  if (
    !isNonEmptyString(raw.evidenceId) ||
    !isNonEmptyString(raw.privilegedActionRequestId) ||
    !isNonEmptyString(raw.targetOrderId) ||
    !isNonEmptyString(raw.initiatingStaffId) ||
    !isNonEmptyString(raw.approvingManagerId) ||
    !isNonEmptyString(raw.deviceId) ||
    !isNonNegativeInt(raw.localSeq) ||
    !isPositiveInt(raw.localObservedAtMs) ||
    !isPositiveInt(raw.anchorServerMs) ||
    !isNonNegativeInt(raw.anchorSeq) ||
    !isPositiveInt(raw.estimatedApprovalMs) ||
    !isNonNegativeInt(raw.managerAuthVersionAtIssue) ||
    !isNonNegativeInt(raw.managerCredentialVersionAtIssue) ||
    !isNonEmptyString(raw.oacId) ||
    raw.oacSchemaVersion !== OAC_SCHEMA_VERSION ||
    !isNonNegativeInt(raw.revocationEpochAtIssue) ||
    !isNonEmptyString(raw.nonce) ||
    !isNonNegativeInt(raw.attemptCount) ||
    !isApprovalResult(raw.approvalResult) ||
    !isNonEmptyString(raw.approvalProofDigest) ||
    !isNonEmptyString(raw.localIntentId) ||
    !(raw.resultingVoidIntentId === null || isNonEmptyString(raw.resultingVoidIntentId)) ||
    !isSyncStatus(raw.syncStatus) ||
    !isServerVerdict(raw.serverVerdict) ||
    !(raw.serverRejectionReason === null || isNonEmptyString(raw.serverRejectionReason)) ||
    !isManualReviewStatus(raw.manualReviewStatus)
  ) {
    return { ok: false, code: 'invalid_evidence_schema' };
  }

  const value: PrivilegedActionEvidenceV1 = {
    evidenceId: raw.evidenceId,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    privilegedActionRequestId: raw.privilegedActionRequestId,
    actionId: raw.actionId,
    targetOrderId: raw.targetOrderId,
    branchId: raw.branchId,
    initiatingStaffId: raw.initiatingStaffId,
    approvingManagerId: raw.approvingManagerId,
    deviceId: raw.deviceId,
    localSeq: raw.localSeq,
    localObservedAtMs: raw.localObservedAtMs,
    anchorServerMs: raw.anchorServerMs,
    anchorSeq: raw.anchorSeq,
    estimatedApprovalMs: raw.estimatedApprovalMs,
    managerAuthVersionAtIssue: raw.managerAuthVersionAtIssue,
    managerCredentialVersionAtIssue: raw.managerCredentialVersionAtIssue,
    oacId: raw.oacId,
    oacSchemaVersion: OAC_SCHEMA_VERSION,
    revocationEpochAtIssue: raw.revocationEpochAtIssue,
    nonce: raw.nonce,
    attemptCount: raw.attemptCount,
    approvalResult: raw.approvalResult,
    approvalProofDigest: raw.approvalProofDigest,
    localIntentId: raw.localIntentId,
    resultingVoidIntentId: raw.resultingVoidIntentId,
    syncStatus: raw.syncStatus,
    serverVerdict: raw.serverVerdict,
    serverRejectionReason: raw.serverRejectionReason,
    manualReviewStatus: raw.manualReviewStatus,
  };
  return { ok: true, value };
}

export const PRIVILEGED_ACTION_ERROR_CODES = [
  'DENIED_INVALID_PIN',
  'DENIED_LOCKED',
  'DENIED_STALE',
  'DENIED_UNVERIFIABLE',
  'CREDENTIAL_STALE',
  'APPROVAL_UNAVAILABLE',
  'TOO_MANY_ATTEMPTS',
  'MANAGER_NOT_AUTHORIZED',
  'SERVER_REJECTED',
  'LEGACY_PIN4_REQUIRES_ROTATION',
  'OAC_PROVISION_FORBIDDEN_LEGACY_PIN4',
] as const;
export type PrivilegedActionErrorCode = (typeof PRIVILEGED_ACTION_ERROR_CODES)[number];

export const PRIVILEGED_ACTION_ERROR_LABELS: Record<PrivilegedActionErrorCode, string> = {
  DENIED_INVALID_PIN: 'PIN ไม่ถูกต้อง',
  DENIED_LOCKED: 'ถูกล็อกชั่วคราว กรุณาติดต่อผู้ดูแล',
  DENIED_STALE: 'การอนุมัติออฟไลน์หมดอายุ กรุณาเชื่อมต่อเพื่ออนุมัติใหม่',
  DENIED_UNVERIFIABLE: 'ไม่สามารถตรวจสอบสิทธิ์อนุมัติได้',
  CREDENTIAL_STALE: 'สิทธิ์อนุมัติออฟไลน์หมดอายุ กรุณาเชื่อมต่อเพื่ออนุมัติใหม่',
  APPROVAL_UNAVAILABLE: 'ออฟไลน์ — ขออนุมัติไม่ได้ตอนนี้ ไม่มีคำขอถูกส่ง',
  TOO_MANY_ATTEMPTS: 'ถูกล็อกชั่วคราว กรุณาติดต่อผู้ดูแล',
  MANAGER_NOT_AUTHORIZED: 'ไม่มีสิทธิ์อนุมัติรายการนี้',
  SERVER_REJECTED: 'ระบบปฏิเสธคำขอยกเลิก บิลยังไม่ถูกยกเลิก',
  LEGACY_PIN4_REQUIRES_ROTATION: 'ต้องตั้ง PIN 6 หลักใหม่ที่หลังบ้านก่อนใช้สิทธิ์นี้',
  OAC_PROVISION_FORBIDDEN_LEGACY_PIN4: 'PIN เดิม 4 หลักไม่สามารถออกสิทธิ์อนุมัติออฟไลน์ได้',
};

export const PRIVILEGED_ACTION_OPERATOR_STATES = [
  'ONLINE_APPROVAL',
  'OFFLINE_APPROVAL',
  'APPROVAL_UNAVAILABLE',
  'CREDENTIAL_STALE',
  'TOO_MANY_ATTEMPTS',
  'MANAGER_NOT_AUTHORIZED',
  'PENDING_PRIVILEGED_INTENT',
  'SERVER_ACCEPTED',
  'SERVER_REJECTED',
  'MANUAL_ATTENTION',
] as const;
export type PrivilegedActionOperatorState = (typeof PRIVILEGED_ACTION_OPERATOR_STATES)[number];

export const PRIVILEGED_ACTION_OPERATOR_STATE_LABELS: Record<PrivilegedActionOperatorState, string> = {
  ONLINE_APPROVAL: 'ขออนุมัติจากผู้จัดการ',
  OFFLINE_APPROVAL: 'อนุมัติออฟไลน์ — จะตรวจสอบเมื่อระบบออนไลน์',
  APPROVAL_UNAVAILABLE: 'ออฟไลน์ — ขออนุมัติไม่ได้ตอนนี้ ไม่มีคำขอถูกส่ง',
  CREDENTIAL_STALE: 'สิทธิ์อนุมัติออฟไลน์หมดอายุ กรุณาเชื่อมต่อเพื่ออนุมัติใหม่',
  TOO_MANY_ATTEMPTS: 'ถูกล็อกชั่วคราว กรุณาติดต่อผู้ดูแล',
  MANAGER_NOT_AUTHORIZED: 'ไม่มีสิทธิ์อนุมัติรายการนี้',
  PENDING_PRIVILEGED_INTENT: 'รอการอนุมัติจากระบบ',
  SERVER_ACCEPTED: 'ระบบรับคำขอยกเลิกแล้ว',
  SERVER_REJECTED: 'ระบบปฏิเสธคำขอยกเลิก บิลยังไม่ถูกยกเลิก',
  MANUAL_ATTENTION: 'ต้องตรวจสอบด้วยมือ',
};
