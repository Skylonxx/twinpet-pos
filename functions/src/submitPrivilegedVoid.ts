/**
 * submitPrivilegedVoid — SEC-001 Packet B online mediating callable.
 *
 * Consumes a one-shot privilegedVoid manager approval and invokes the existing
 * canonical `handleVoidIntent` seam. Does not write client-trusted
 * `managerApproved`. Exact completion requires a matching server-owned
 * `privilegedVoidExecutionId` committed atomically with the canonical void.
 *
 * After a valid first consume, `privilegedActionNonces/{nonceKey}` is the
 * server-owned execution record. Exact-bound resume does not consult the
 * original approval TTL. Generic `voided` / `voidReconciled` is not
 * exact-completion evidence.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, type DocumentData, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import { evaluateFreshPrivilegedAuthority, type AuthLike } from './authorityFence';
import { isUsableForLogin, readUserCredential } from './credentialStore';
import { liveRoleHoldsPosVoid, type RolePermissionsReader } from './privilegedActionAuthority';
import { PRIVILEGED_REQUESTER_PERMISSION, PRIVILEGED_VOID_AUDIENCE } from './privilegedActionRegistry';
import {
  type ApprovalRecordView,
  type ManagerApprovalServerErrorCode,
  approverBranchEligible,
  deriveApprovalId,
  isModel2ApproverRole,
  requesterBranchEligible,
} from './requestManagerApprovalCore';
import {
  type SubmitPrivilegedVoidRequest,
  PRIVILEGED_EXECUTION_STATUS_COMPLETED,
  PRIVILEGED_EXECUTION_STATUS_PENDING,
  buildPrivilegedExecutionBinding,
  buildVoidConsumeBinding,
  consumeBindingRejectedReason,
  decideCanonicalVoidCorrelation,
  derivePrivilegedNonceKey,
  derivePrivilegedVoidExecutionId,
  isAlreadyCanonicallyVoided,
  isSameUtc7Day,
  parsePrivilegedExecutionRecord,
  resumeExecutionRejectedReason,
  timestampToMs,
  validateSubmitPrivilegedVoidRequest,
  voidActionMatchesReconcileStatus,
  type PrivilegedExecutionBinding,
} from './submitPrivilegedVoidCore';
import { handleVoidIntent, type HandleVoidIntentOptions, type VoidIntentTxnOutcome } from './voidIntent';

const C = {
  users: 'users',
  approvals: 'managerApprovals',
  asyncOrders: 'asyncOrders',
  nonces: 'privilegedActionNonces',
} as const;

export type SubmitPrivilegedVoidResponse =
  | { ok: true; orderId: string; outcome: VoidIntentTxnOutcome['kind']; idempotent: boolean }
  | { ok: false; code: ManagerApprovalServerErrorCode };

export type CanonicalVoidExecutor = (
  database: Firestore,
  orderRef: DocumentReference,
  options?: HandleVoidIntentOptions,
) => Promise<VoidIntentTxnOutcome>;

export interface SubmitPrivilegedVoidDeps {
  nowMillis?: number;
  executeCanonicalVoid?: CanonicalVoidExecutor;
  readRolePermissions?: RolePermissionsReader;
}

function fail(code: ManagerApprovalServerErrorCode): SubmitPrivilegedVoidResponse {
  return { ok: false, code };
}

function toMillis(value: unknown): number | null {
  return timestampToMs(value);
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

function tokenHasPermission(auth: AuthLike, perm: string): boolean {
  const raw = auth?.token?.permissions;
  if (!Array.isArray(raw)) return false;
  return raw.some((p) => p === perm);
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

function requesterLiveBranchOk(role: string | null, branchIds: string[], branchId: string): boolean {
  if (role === 'admin') return hasLiveBranchAccess(branchIds, branchId);
  if (role === 'manager' || role === 'staff') return requesterBranchEligible(branchIds, branchId);
  return false;
}

function asOutcomeKind(value: string | null | undefined): VoidIntentTxnOutcome['kind'] {
  if (value === 'VOID_TOMBSTONED' || value === 'VOID_APPLIED' || value === 'NOOP') return value;
  return 'NOOP';
}

/**
 * Core verifier — EXPORTED so it is unit-tested without the Functions runtime.
 */
export async function performSubmitPrivilegedVoid(
  database: Firestore,
  req: SubmitPrivilegedVoidRequest,
  auth: AuthLike,
  deps: SubmitPrivilegedVoidDeps = {},
): Promise<SubmitPrivilegedVoidResponse> {
  const nowMillis = deps.nowMillis ?? Date.now();
  const executeCanonicalVoid = deps.executeCanonicalVoid ?? handleVoidIntent;
  const readRolePermissions = deps.readRolePermissions;

  if (!auth) return fail('not_authorized');

  const freshness = await evaluateFreshPrivilegedAuthority(database, auth);
  if (!freshness.ok) return fail('not_authorized');
  const staffId = freshness.staffId;
  const liveAuthVersion = freshness.authVersion;

  const validated = validateSubmitPrivilegedVoidRequest(req);
  if (!validated.ok) return fail('invalid_target');
  const value = validated.value;

  // managerApproved is never read as authority. Extra client flags are ignored.
  void req.managerApproved;

  const approvalId = deriveApprovalId(value.commandId);
  const approvalRef = database.collection(C.approvals).doc(approvalId);
  const nonceKey = derivePrivilegedNonceKey(value.branchId, approvalId);
  const nonceRef = database.collection(C.nonces).doc(nonceKey);
  const orderRef = database.collection(C.asyncOrders).doc(value.targetEntityId);

  const nonceSnap = await nonceRef.get();
  const existingExecution = nonceSnap.exists
    ? parsePrivilegedExecutionRecord(nonceSnap.data())
    : null;

  const markCompleted = async (outcomeKind: VoidIntentTxnOutcome['kind']): Promise<void> => {
    await nonceRef.set(
      {
        status: PRIVILEGED_EXECUTION_STATUS_COMPLETED,
        completedAtMillis: nowMillis,
        outcomeKind,
      },
      { merge: true },
    );
  };

  const applyVoidAttribution = async (): Promise<void> => {
    await orderRef.set(
      {
        voidedBy: staffId,
        voidReason: value.voidReason,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  };

  const finishCanonical = async (
    binding: PrivilegedExecutionBinding,
    idempotent: boolean,
  ): Promise<SubmitPrivilegedVoidResponse> => {
    const executionId = derivePrivilegedVoidExecutionId(binding);
    const latestOrderSnap = await orderRef.get();
    const latestOrder = latestOrderSnap.exists ? ((latestOrderSnap.data() ?? {}) as DocumentData) : null;
    const decision = decideCanonicalVoidCorrelation(latestOrder, executionId);

    if (decision === 'MATCHING') {
      await markCompleted('NOOP');
      return { ok: true, orderId: value.targetEntityId, outcome: 'NOOP', idempotent: true };
    }
    if (decision === 'MISSING' || decision === 'DIFFERENT') {
      return fail('invalid_target');
    }

    const outcome = await executeCanonicalVoid(database, orderRef, {
      privilegedVoidExecutionId: executionId,
    });

    const afterSnap = await orderRef.get();
    const afterOrder = afterSnap.exists ? ((afterSnap.data() ?? {}) as DocumentData) : null;
    const afterDecision = decideCanonicalVoidCorrelation(afterOrder, executionId);

    if (outcome.kind === 'VOID_TOMBSTONED' || outcome.kind === 'VOID_APPLIED') {
      if (afterDecision !== 'MATCHING') return fail('invalid_target');
      await applyVoidAttribution();
      await markCompleted(outcome.kind);
      return { ok: true, orderId: value.targetEntityId, outcome: outcome.kind, idempotent };
    }
    if (outcome.kind === 'NOOP' && (outcome.reason === 'already_reconciled' || outcome.reason === 'absent')) {
      if (outcome.reason === 'absent') return fail('invalid_target');
      if (afterDecision === 'MATCHING') {
        await markCompleted('NOOP');
        return { ok: true, orderId: value.targetEntityId, outcome: 'NOOP', idempotent: true };
      }
      return fail('invalid_target');
    }
    await markCompleted(outcome.kind);
    return { ok: true, orderId: value.targetEntityId, outcome: asOutcomeKind(outcome.kind), idempotent };
  };

  if (nonceSnap.exists) {
    if (existingExecution == null) return fail('replayed_approval');
    const expectedExecution = buildPrivilegedExecutionBinding({
      nonceKey,
      approvalId,
      commandId: value.commandId,
      protectedAction: value.protectedAction,
      targetEntityId: value.targetEntityId,
      branchId: value.branchId,
      requesterStaffId: staffId,
      approvingManagerId: existingExecution.approvingManagerId,
      audience: PRIVILEGED_VOID_AUDIENCE,
    });
    const resumeReject = resumeExecutionRejectedReason(existingExecution, expectedExecution);
    if (resumeReject) return fail(resumeReject);
    if (existingExecution.status === PRIVILEGED_EXECUTION_STATUS_COMPLETED) {
      return {
        ok: true,
        orderId: value.targetEntityId,
        outcome: asOutcomeKind(existingExecution.outcomeKind),
        idempotent: true,
      };
    }
    return finishCanonical(expectedExecution, true);
  }

  if (!tokenHasPermission(auth, PRIVILEGED_REQUESTER_PERMISSION)) {
    return fail('not_authorized');
  }

  const requesterSnap = await database.collection(C.users).doc(staffId).get();
  if (!requesterSnap.exists) return fail('not_authorized');
  const requester = (requesterSnap.data() ?? {}) as DocumentData;
  const requesterRole = liveRole(requester);
  if (requesterRole !== 'admin' && requesterRole !== 'manager' && requesterRole !== 'staff') {
    return fail('not_authorized');
  }
  const requesterHasVoid = await liveRoleHoldsPosVoid(database, requesterRole, readRolePermissions);
  if (!requesterHasVoid) return fail('not_authorized');
  if (!requesterLiveBranchOk(requesterRole, liveBranchIds(requester), value.branchId)) {
    return fail('branch_mismatch');
  }

  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) return fail('invalid_target');
  const order = (orderSnap.data() ?? {}) as DocumentData;
  if (order.branchId !== value.branchId) return fail('branch_mismatch');

  const createdMs = timestampToMs(order.serverCreatedAt);
  if (createdMs == null || !isSameUtc7Day(createdMs, nowMillis)) {
    return fail('invalid_target');
  }

  if (isAlreadyCanonicallyVoided(order)) {
    return fail('invalid_target');
  }

  if (!voidActionMatchesReconcileStatus(value.protectedAction, order.reconcileStatus)) {
    return fail('invalid_target');
  }

  const approvalSnap = await approvalRef.get();
  const record = approvalViewFromData(approvalSnap.exists ? approvalSnap.data() : undefined);
  if (record == null) return fail('invalid_target');
  if (record.audience !== PRIVILEGED_VOID_AUDIENCE) return fail('invalid_target');
  if (record.protectedAction !== value.protectedAction) return fail('invalid_target');
  if (record.requesterStaffId === record.approverStaffId) return fail('self_approval_not_permitted');
  if (record.approverStaffId === staffId) return fail('self_approval_not_permitted');
  if (record.consumedAt != null) return fail('replayed_approval');

  const expected = buildVoidConsumeBinding({
    protectedAction: value.protectedAction,
    targetEntityId: value.targetEntityId,
    branchId: value.branchId,
    commandId: value.commandId,
    staffId,
    authVersion: liveAuthVersion,
  });

  const reject = consumeBindingRejectedReason(record, expected, nowMillis);
  if (reject) return fail(reject);

  const approverId = typeof record.approverStaffId === 'string' ? record.approverStaffId : '';
  if (!approverId) return fail('approver_not_eligible');
  const approverSnap = await database.collection(C.users).doc(approverId).get();
  if (!approverSnap.exists) return fail('approver_not_eligible');
  const approver = (approverSnap.data() ?? {}) as DocumentData;
  if (approver.isActive !== true || approver.deletedAt != null) return fail('approver_not_eligible');
  const approverRole = liveRole(approver);
  if (!isModel2ApproverRole(approverRole)) return fail('approver_not_eligible');
  if (!approverBranchEligible(approverRole, liveBranchIds(approver), value.branchId)) {
    return fail('approver_not_eligible');
  }
  const liveApproverAuthVersion =
    typeof approver.authVersion === 'number' && Number.isFinite(approver.authVersion) ? approver.authVersion : 0;
  if (
    typeof record.approverAuthVersionAtIssue === 'number' &&
    liveApproverAuthVersion !== record.approverAuthVersionAtIssue
  ) {
    return fail('not_authorized');
  }
  const approverHasVoid = await liveRoleHoldsPosVoid(database, approverRole, readRolePermissions);
  if (!approverHasVoid) return fail('approver_not_eligible');

  const cred = await readUserCredential(database, approverId);
  if (!isUsableForLogin(cred) || cred.credentialState !== 'rotated_authoritative') {
    return fail('not_authorized');
  }
  if (cred.credentialVersion !== record.credentialVersionAtIssue) {
    return fail('not_authorized');
  }

  try {
    await database.runTransaction(async (tx) => {
      const freshApproval = await tx.get(approvalRef);
      const freshNonce = await tx.get(nonceRef);
      const freshOrder = await tx.get(orderRef);
      const latest = approvalViewFromData(freshApproval.exists ? freshApproval.data() : undefined);
      if (latest == null || latest.consumedAt != null) {
        throw Object.assign(new Error('replayed_approval'), { code: 'replayed_approval' });
      }
      if (freshNonce.exists) {
        throw Object.assign(new Error('replayed_approval'), { code: 'replayed_approval' });
      }
      if (!freshOrder.exists) {
        throw Object.assign(new Error('invalid_target'), { code: 'invalid_target' });
      }
      const latestOrder = (freshOrder.data() ?? {}) as DocumentData;
      if (isAlreadyCanonicallyVoided(latestOrder)) {
        throw Object.assign(new Error('invalid_target'), { code: 'invalid_target' });
      }
      tx.update(approvalRef, {
        consumedAt: FieldValue.serverTimestamp(),
        consumedByStaffId: staffId,
        consumingAudience: PRIVILEGED_VOID_AUDIENCE,
        consumedCaseVersion: null,
      });
      tx.create(nonceRef, {
        schemaVersion: 1,
        status: PRIVILEGED_EXECUTION_STATUS_PENDING,
        nonceKey,
        branchId: value.branchId,
        approvalId,
        commandId: value.commandId,
        protectedAction: value.protectedAction,
        targetEntityId: value.targetEntityId,
        requesterStaffId: staffId,
        approvingManagerId: approverId,
        audience: PRIVILEGED_VOID_AUDIENCE,
        consumedAtMillis: nowMillis,
        completedAtMillis: null,
        outcomeKind: null,
      });
      if (latestOrder.reconcileStatus === 'settled') {
        tx.set(
          orderRef,
          {
            voidedBy: staffId,
            voidReason: value.voidReason,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
    });
  } catch (err: unknown) {
    const code =
      typeof err === 'object' && err != null && 'code' in err ? String((err as { code: unknown }).code) : '';
    if (code === 'replayed_approval') return fail('replayed_approval');
    if (code === 'invalid_target') return fail('invalid_target');
    throw err;
  }

  return finishCanonical(
    buildPrivilegedExecutionBinding({
      nonceKey,
      approvalId,
      commandId: value.commandId,
      protectedAction: value.protectedAction,
      targetEntityId: value.targetEntityId,
      branchId: value.branchId,
      requesterStaffId: staffId,
      approvingManagerId: approverId,
      audience: PRIVILEGED_VOID_AUDIENCE,
    }),
    false,
  );
}

export const submitPrivilegedVoid = onCall(
  {
    region: FUNCTIONS_REGION,
    cors: [/^https?:\/\/localhost:\d+$/, /^https:\/\/.*\.firebaseapp\.com$/, /^https:\/\/.*\.web\.app$/],
  },
  async (request) => {
    try {
      return await performSubmitPrivilegedVoid(
        db,
        (request.data ?? {}) as SubmitPrivilegedVoidRequest,
        request.auth as AuthLike,
      );
    } catch (err) {
      const code = typeof err === 'object' && err != null && 'code' in err ? String((err as { code: unknown }).code) : '';
      if (code === 'replayed_approval') return fail('replayed_approval');
      if (code === 'invalid_target') return fail('invalid_target');
      throw new HttpsError('internal', 'ระบบอนุมัติขัดข้อง กรุณาลองใหม่');
    }
  },
);
