/**
 * requestManagerApproval — Packet 2A claim-neutral I/O shell.
 *
 * Verifies the current principal's canonical PIN and mints a one-shot
 * managerApprovals/{approvalId} record. Never mutates custom claims,
 * never writes lastLoginAt, never stores or echoes the PIN.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp, type DocumentData, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import bcrypt from 'bcryptjs';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import { evaluateFreshPrivilegedAuthority, type AuthLike } from './authorityFence';
import { isUsableForLogin, readUserCredential } from './credentialStore';
import {
  APPROVAL_SECURITY_MODEL_DELEGATED,
  APPROVAL_TTL_MS,
  type ApprovalBindingExpected,
  type ApprovalRecordView,
  type ManagerApprovalServerErrorCode,
  type NextAttemptState,
  type RequestManagerApprovalRequest,
  audienceForProtectedAction,
  approverBranchEligible,
  buildApprovalDocument,
  deriveApprovalId,
  deriveAttemptScopeKey,
  isLockoutActive,
  isModel2ApproverRole,
  isModel2RequesterRole,
  nextFailureAttemptState,
  requesterBranchEligible,
  resetAttemptState,
  selectMintOutcome,
  shouldApplyAttemptReset,
  shouldUseRealPinCompare,
  validateManagerApprovalRequest,
} from './requestManagerApprovalCore';
import { isPrivilegedActionId, PRIVILEGED_REQUESTER_PERMISSION } from './privilegedActionRegistry';
import { liveRoleHoldsPosVoid, type RolePermissionsReader } from './privilegedActionAuthority';

const C = {
  users: 'users',
  approvals: 'managerApprovals',
  attempts: 'managerApprovalAttempts',
  audit: 'managerApprovalAuditEvents',
} as const;

/** Fixed dummy bcrypt hash — never a stored credential. */
export const APPROVAL_DUMMY_PIN_HASH =
  '$2b$10$WCOTRHGYk1RxxHdHMy9.guo3rg259b4w/opYiC13GSmPmCmPJVYwO';

export type RequestManagerApprovalResponse =
  | { ok: true; approvalId: string; expiresAtMillis: number }
  | { ok: false; code: ManagerApprovalServerErrorCode };

export type PinCompareFn = (pin: string, hash: string) => Promise<boolean>;

export interface RequestManagerApprovalDeps {
  nowMillis?: number;
  comparePin?: PinCompareFn;
  dummyPinHash?: string;
  readRolePermissions?: RolePermissionsReader;
}

function fail(code: ManagerApprovalServerErrorCode): RequestManagerApprovalResponse {
  return { ok: false, code };
}

function toMillis(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'object' && value !== null && 'toMillis' in value) {
    const fn = (value as { toMillis?: unknown }).toMillis;
    if (typeof fn === 'function') {
      const ms = fn.call(value);
      return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
    }
  }
  return null;
}

function approvalViewFromData(data: DocumentData | undefined): ApprovalRecordView | null {
  if (!data) return null;
  return {
    audience: data.audience,
    protectedAction: data.protectedAction,
    targetEntityId: data.targetEntityId,
    branchId: data.branchId,
    commandId: data.commandId,
    requesterStaffId: data.requesterStaffId,
    approverStaffId: data.approverStaffId,
    executorStaffId: data.executorStaffId,
    securityModel: data.securityModel,
    authVersionAtIssue: data.authVersionAtIssue,
    credentialVersionAtIssue: data.credentialVersionAtIssue,
    consumedAt: data.consumedAt ?? null,
    expiresAtMillis: toMillis(data.expiresAt),
    approverAuthVersionAtIssue: data.approverAuthVersionAtIssue,
  };
}

function attemptViewFromData(data: DocumentData | undefined): {
  consecutiveFailures: number;
  firstFailureAtMillis: number | null;
  lockedUntilMillis: number | null;
} | null {
  if (!data) return null;
  return {
    consecutiveFailures: typeof data.consecutiveFailures === 'number' ? data.consecutiveFailures : 0,
    firstFailureAtMillis: toMillis(data.firstFailureAt),
    lockedUntilMillis: toMillis(data.lockedUntil),
  };
}

async function defaultCompare(pin: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(pin, hash);
  } catch {
    return false;
  }
}

function timestampFromMillis(ms: number): Timestamp {
  return Timestamp.fromMillis(ms);
}

function attemptWritePayload(state: NextAttemptState, branchId: string, staffId: string): DocumentData {
  return {
    schemaVersion: 1,
    branchId,
    staffId,
    consecutiveFailures: state.consecutiveFailures,
    firstFailureAt: state.firstFailureAtMillis != null ? timestampFromMillis(state.firstFailureAtMillis) : null,
    lastFailureAt: state.lastFailureAtMillis != null ? timestampFromMillis(state.lastFailureAtMillis) : null,
    lockedUntil: state.lockedUntilMillis != null ? timestampFromMillis(state.lockedUntilMillis) : null,
  };
}

/**
 * Atomic increment + lock transition from the latest committed attempt doc.
 * bcrypt must never run inside this callback (retries would multiply compares).
 */
async function commitAttemptFailure(
  database: Firestore,
  attemptRef: DocumentReference,
  branchId: string,
  staffId: string,
  nowMillis: number,
): Promise<NextAttemptState> {
  let committed: NextAttemptState = resetAttemptState();
  await database.runTransaction(async (tx) => {
    const snap = await tx.get(attemptRef);
    committed = nextFailureAttemptState(attemptViewFromData(snap.data()), nowMillis);
    tx.set(attemptRef, attemptWritePayload(committed, branchId, staffId));
  });
  return committed;
}

async function commitAttemptResetIfCurrent(
  database: Firestore,
  attemptRef: DocumentReference,
  observed: ReturnType<typeof attemptViewFromData>,
  branchId: string,
  staffId: string,
): Promise<void> {
  await database.runTransaction(async (tx) => {
    const snap = await tx.get(attemptRef);
    if (!shouldApplyAttemptReset(observed, attemptViewFromData(snap.data()))) return;
    tx.set(attemptRef, attemptWritePayload(resetAttemptState(), branchId, staffId));
  });
}

async function writeAudit(
  database: Firestore,
  params: {
    eventType: string;
    category: string;
    staffId: string;
    branchId: string;
    commandId: string;
    nowMillis: number;
  },
): Promise<void> {
  const auditId = deriveApprovalId(`${params.eventType}:${params.commandId}:${params.nowMillis}:${params.staffId}`);
  await database.collection(C.audit).doc(auditId).set({
    eventType: params.eventType,
    category: params.category,
    staffId: params.staffId,
    branchId: params.branchId,
    commandId: params.commandId,
    schemaVersion: 1,
    createdAt: FieldValue.serverTimestamp(),
    createdAtMillis: params.nowMillis,
  });
}

function liveRole(user: DocumentData): string | null {
  return typeof user.role === 'string' ? user.role : null;
}

function liveBranchIds(user: DocumentData): string[] {
  return Array.isArray(user.branchIds) ? user.branchIds.filter((v): v is string => typeof v === 'string') : [];
}

function hasLiveBranchAccess(branchIds: string[], branchId: string): boolean {
  return branchIds.includes('ALL') || branchIds.includes(branchId);
}

function tokenHasPermission(auth: AuthLike, perm: string): boolean {
  const raw = auth?.token?.permissions;
  if (!Array.isArray(raw)) return false;
  return raw.some((p) => p === perm);
}

/**
 * Core verifier — EXPORTED so it is unit-tested without the Functions runtime.
 */
export async function performRequestManagerApproval(
  database: Firestore,
  req: RequestManagerApprovalRequest,
  auth: AuthLike,
  deps: RequestManagerApprovalDeps = {},
): Promise<RequestManagerApprovalResponse> {
  const nowMillis = deps.nowMillis ?? Date.now();
  const comparePin = deps.comparePin ?? defaultCompare;
  const dummyPinHash = deps.dummyPinHash ?? APPROVAL_DUMMY_PIN_HASH;
  const readRolePermissions = deps.readRolePermissions;

  // M1
  if (!auth) return fail('not_authorized');

  // M2
  const freshness = await evaluateFreshPrivilegedAuthority(database, auth);
  if (!freshness.ok) return fail('not_authorized');
  const staffId = freshness.staffId;
  const liveAuthVersion = freshness.authVersion;

  // M3
  const validated = validateManagerApprovalRequest(req);
  if (!validated.ok) return fail('invalid_target');
  const value = validated.value;
  const delegated = value.securityModel === APPROVAL_SECURITY_MODEL_DELEGATED;

  // M3b — self-approval is structural, before any approver read or bcrypt.
  if (delegated && value.approverStaffId === staffId) {
    return fail('self_approval_not_permitted');
  }

  const voidAction = isPrivilegedActionId(value.protectedAction);
  // D1: void reauth is the requester approving themselves.
  if (voidAction && !delegated) {
    return fail('self_approval_not_permitted');
  }

  const userSnap = await database.collection(C.users).doc(staffId).get();
  if (!userSnap.exists) return fail('not_authorized');
  const user = (userSnap.data() ?? {}) as DocumentData;
  const role = liveRole(user);
  const branchIds = liveBranchIds(user);

  const failWithAttempt = async (
    code: Extract<ManagerApprovalServerErrorCode, 'not_authorized' | 'branch_mismatch' | 'approver_not_eligible'>,
    category: string,
  ): Promise<RequestManagerApprovalResponse> => {
    const attemptScopeKey = deriveAttemptScopeKey(value.branchId, staffId);
    const failAttemptRef = database.collection(C.attempts).doc(attemptScopeKey);
    await commitAttemptFailure(database, failAttemptRef, value.branchId, staffId, nowMillis);
    await writeAudit(database, {
      eventType: 'manager_approval_failed',
      category,
      staffId,
      branchId: value.branchId,
      commandId: value.commandId,
      nowMillis,
    });
    return fail(code);
  };

  // M4′ — Model 1: manager/admin. Model 2 shift-close: staff requester only.
  // Void: any live role may request if they hold fresh pos_void (checked below).
  const requesterRoleOk = voidAction
    ? role === 'admin' || role === 'manager' || role === 'staff'
    : delegated
      ? isModel2RequesterRole(role)
      : role === 'admin' || role === 'manager';
  if (!requesterRoleOk) {
    return failWithAttempt('not_authorized', 'authorization');
  }

  // M5 — Model 1 keeps the shared ALL-admitting helper; Model 2 is exact-only.
  // Void requesters: staff/manager exact membership; admin may use live ALL.
  const requesterBranchOk = voidAction
    ? role === 'admin'
      ? hasLiveBranchAccess(branchIds, value.branchId)
      : requesterBranchEligible(branchIds, value.branchId)
    : delegated
      ? requesterBranchEligible(branchIds, value.branchId)
      : hasLiveBranchAccess(branchIds, value.branchId);
  if (!requesterBranchOk) {
    return failWithAttempt('branch_mismatch', 'authorization');
  }

  if (voidAction && !tokenHasPermission(auth, PRIVILEGED_REQUESTER_PERMISSION)) {
    return failWithAttempt('not_authorized', 'authorization');
  }
  if (voidAction) {
    const requesterHasVoid = await liveRoleHoldsPosVoid(database, role, readRolePermissions);
    if (!requesterHasVoid) {
      return failWithAttempt('not_authorized', 'authorization');
    }
  }

  const scopeKey = deriveAttemptScopeKey(value.branchId, staffId);
  const attemptRef = database.collection(C.attempts).doc(scopeKey);
  const attemptSnap = await attemptRef.get();
  const observedAttempt = attemptViewFromData(attemptSnap.data());

  // M6 — lockout before any bcrypt; keyed on requester only.
  if (isLockoutActive(observedAttempt?.lockedUntilMillis ?? null, nowMillis)) {
    await writeAudit(database, {
      eventType: 'manager_approval_failed',
      category: 'locked',
      staffId,
      branchId: value.branchId,
      commandId: value.commandId,
      nowMillis,
    });
    return fail('locked');
  }

  let credentialSubjectId = staffId;
  let mintedApproverRole = role as string;
  let mintedApproverAuthVersion: number | undefined;
  if (delegated) {
    const namedApproverId = value.approverStaffId as string;
    const approverSnap = await database.collection(C.users).doc(namedApproverId).get();
    const approver = approverSnap.exists ? ((approverSnap.data() ?? {}) as DocumentData) : null;
    const approverRole = approver ? liveRole(approver) : null;
    const approverEligible =
      approverSnap.exists &&
      approver != null &&
      approver.isActive === true &&
      approver.deletedAt == null &&
      isModel2ApproverRole(approverRole) &&
      approverBranchEligible(approverRole, liveBranchIds(approver), value.branchId);
    if (!approverEligible) {
      return failWithAttempt('approver_not_eligible', 'authorization');
    }
    if (voidAction) {
      const approverHasVoid = await liveRoleHoldsPosVoid(database, approverRole, readRolePermissions);
      if (!approverHasVoid) {
        return failWithAttempt('approver_not_eligible', 'authorization');
      }
    }
    credentialSubjectId = namedApproverId;
    mintedApproverRole = approverRole as string;
    mintedApproverAuthVersion =
      typeof approver!.authVersion === 'number' && Number.isFinite(approver!.authVersion)
        ? approver!.authVersion
        : 0;
  }

  // M7 — real vs dummy selection (caller credential for reauth, named approver for delegated)
  const cred = await readUserCredential(database, credentialSubjectId);
  const useReal = shouldUseRealPinCompare({
    credentialExists: cred != null,
    usableForLogin: isUsableForLogin(cred),
    disabled: cred?.disabled === true,
    credentialState: cred?.credentialState ?? null,
    pin: value.pin,
  });

  // M8 — exactly one compare
  const compareHash = useReal && cred ? cred.pinHash : dummyPinHash;
  const compareOk = await comparePin(value.pin, compareHash);

  const approvalId = deriveApprovalId(value.commandId);
  const approvalRef = database.collection(C.approvals).doc(approvalId);
  const approvalSnap = await approvalRef.get();
  const record = approvalViewFromData(approvalSnap.exists ? approvalSnap.data() : undefined);

  const derivedAudience = audienceForProtectedAction(value.protectedAction);
  if (derivedAudience == null) return fail('invalid_target');

  const expected: ApprovalBindingExpected = {
    audience: derivedAudience,
    protectedAction: value.protectedAction,
    targetEntityId: value.targetEntityId,
    branchId: value.branchId,
    commandId: value.commandId,
    staffId,
    authVersion: liveAuthVersion,
    ...(delegated
      ? { approverStaffId: value.approverStaffId as string, approverAuthVersion: mintedApproverAuthVersion }
      : {}),
  };

  // M9 — outcome only after compare
  const outcome = selectMintOutcome(compareOk, record, expected, nowMillis);

  if (outcome === 'invalid_credentials') {
    await commitAttemptFailure(database, attemptRef, value.branchId, staffId, nowMillis);
    await writeAudit(database, {
      eventType: 'manager_approval_failed',
      category: 'credential',
      staffId,
      branchId: value.branchId,
      commandId: value.commandId,
      nowMillis,
    });
    return fail('invalid_credentials');
  }

  const reset = resetAttemptState();
  const expiresAtMillis = nowMillis + APPROVAL_TTL_MS;

  if (outcome === 'replayed_approval') {
    await commitAttemptResetIfCurrent(database, attemptRef, observedAttempt, value.branchId, staffId);
    await writeAudit(database, {
      eventType: 'manager_approval_denied_replayed',
      category: 'denied_replayed',
      staffId,
      branchId: value.branchId,
      commandId: value.commandId,
      nowMillis,
    });
    return fail('replayed_approval');
  }

  if (outcome === 'expired_approval') {
    await commitAttemptResetIfCurrent(database, attemptRef, observedAttempt, value.branchId, staffId);
    await writeAudit(database, {
      eventType: 'manager_approval_denied_expired',
      category: 'denied_expired',
      staffId,
      branchId: value.branchId,
      commandId: value.commandId,
      nowMillis,
    });
    return fail('expired_approval');
  }

  if (outcome === 'invalid_target') {
    await commitAttemptResetIfCurrent(database, attemptRef, observedAttempt, value.branchId, staffId);
    await writeAudit(database, {
      eventType: 'manager_approval_denied_binding_mismatch',
      category: 'denied_binding_mismatch',
      staffId,
      branchId: value.branchId,
      commandId: value.commandId,
      nowMillis,
    });
    return fail('invalid_target');
  }

  if (outcome === 'idempotent') {
    await commitAttemptResetIfCurrent(database, attemptRef, observedAttempt, value.branchId, staffId);
    await writeAudit(database, {
      eventType: 'manager_approval_granted',
      category: 'granted',
      staffId,
      branchId: value.branchId,
      commandId: value.commandId,
      nowMillis,
    });
    const existingExpiry = record?.expiresAtMillis ?? expiresAtMillis;
    return { ok: true, approvalId, expiresAtMillis: existingExpiry };
  }

  // M10 — new mint in one transaction. bcrypt is already done; retries must
  // not compare again. Concurrent same-command mints: create-if-absent, keep
  // deterministic approvalId, skip duplicate audit create.
  const credentialVersionAtIssue = cred?.credentialVersion ?? 0;
  const fields = buildApprovalDocument({
    commandId: value.commandId,
    protectedAction: value.protectedAction,
    targetEntityId: value.targetEntityId,
    branchId: value.branchId,
    staffId,
    approverRole: mintedApproverRole,
    authVersionAtIssue: liveAuthVersion,
    credentialVersionAtIssue,
    ...(delegated
      ? {
          securityModel: APPROVAL_SECURITY_MODEL_DELEGATED,
          approverStaffId: value.approverStaffId as string,
          approverAuthVersionAtIssue: mintedApproverAuthVersion,
        }
      : {}),
  });

  const grantAuditId = deriveApprovalId(`manager_approval_granted:new:${value.commandId}:${nowMillis}:${staffId}`);
  const auditRef = database.collection(C.audit).doc(grantAuditId);

  await database.runTransaction(async (tx) => {
    const freshSnap = await tx.get(approvalRef);
    const latestAttemptSnap = await tx.get(attemptRef);
    const auditSnap = await tx.get(auditRef);
    if (!freshSnap.exists) {
      tx.create(approvalRef, {
        ...fields,
        issuedAt: FieldValue.serverTimestamp(),
        expiresAt: timestampFromMillis(expiresAtMillis),
      });
    }
    if (shouldApplyAttemptReset(observedAttempt, attemptViewFromData(latestAttemptSnap.data()))) {
      tx.set(attemptRef, attemptWritePayload(reset, value.branchId, staffId));
    }
    if (!auditSnap.exists) {
      tx.create(auditRef, {
        eventType: 'manager_approval_granted',
        category: 'granted',
        staffId,
        branchId: value.branchId,
        commandId: value.commandId,
        schemaVersion: 1,
        createdAt: FieldValue.serverTimestamp(),
        createdAtMillis: nowMillis,
      });
    }
  });

  return { ok: true, approvalId, expiresAtMillis };
}

export const requestManagerApproval = onCall(
  {
    region: FUNCTIONS_REGION,
    cors: [/^https?:\/\/localhost:\d+$/, /^https:\/\/.*\.firebaseapp\.com$/, /^https:\/\/.*\.web\.app$/],
  },
  async (request) => {
    try {
      return await performRequestManagerApproval(
        db,
        (request.data ?? {}) as RequestManagerApprovalRequest,
        request.auth as AuthLike,
      );
    } catch {
      throw new HttpsError('internal', 'ระบบอนุมัติขัดข้อง กรุณาลองใหม่');
    }
  },
);
