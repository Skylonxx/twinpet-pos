/**
 * resolveShiftCloseAlert — I/O shell. [P1 offline-sync Packet 5 / P5-E]
 *
 * `onCall` wiring + the single Firestore transaction for manager/admin
 * ADJUDICATION of a shift-close alert. Every DECISION (auth, lease refusal,
 * transition legality, idempotency payload identity) is delegated to the
 * pure `resolveShiftCloseAlertCore` module — this file only reads/writes
 * Firestore and applies those decisions, mirroring `resolveReversal.ts`'s
 * shell/core split and the P5-D worker's own core/shell separation.
 *
 * Writes exactly three collections, all under one transaction:
 *   - `shiftCloseCases/{shiftId}`             — alertState/settlementState/caseVersion only.
 *   - `shiftCloseAlerts/{shiftId}`            — the frozen P5-B alert projection.
 *   - `shiftCloseAuditEvents/{eventId}`       — immutable adjudication event (tx.create).
 *   - `shiftCloseAdjudicationCommands/{id}`   — deterministic idempotency ledger.
 *
 * Never reads/writes `shifts`. Never touches P5-B/P5-C/P5-D modules or their
 * collections beyond the read-only reuse already named above.
 */
import { onCall } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp, type DocumentData, type Firestore } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import { computeP5DAuditEventId } from './shiftCloseValidationWorkerCore';
import type { AlertReasonCode, AlertState, SettlementState } from './shiftCloseValidationTypes';
import {
  adjudicationPayloadCanonical,
  adjudicationPayloadHash,
  checkAdjudicationAuthority,
  checkApprovalBinding,
  commandLedgerId,
  decideAdjudicationTransition,
  expectedActionFor,
  hasPresentPin,
  isLeaseLive,
  validateAdjudicationPayload,
  type AdjudicationRejectCode,
  type AdjudicationStatus,
  type ApprovalRecordView,
  type AuthTokenLike,
  type ResolveShiftCloseAlertRequest,
  type ValidatedAdjudicationRequest,
} from './resolveShiftCloseAlertCore';
import { evaluateFreshPrivilegedAuthority } from './authorityFence';
import { isUsableForLogin, readUserCredential } from './credentialStore';
import {
  APPROVAL_AUDIENCE,
  APPROVAL_SECURITY_MODEL,
  APPROVAL_SECURITY_MODEL_DELEGATED,
  approverBranchEligible,
  isModel2ApproverRole,
  isModel2RequesterRole,
  requesterBranchEligible,
  type ApprovalBindingExpected,
} from './requestManagerApprovalCore';

const C = {
  cases: 'shiftCloseCases',
  alerts: 'shiftCloseAlerts',
  auditEvents: 'shiftCloseAuditEvents',
  adjudicationCommands: 'shiftCloseAdjudicationCommands',
  approvals: 'managerApprovals',
  users: 'users',
} as const;

export type { ResolveShiftCloseAlertRequest };

export interface ResolveShiftCloseAlertResponse {
  ok: boolean;
  commandId: string;
  shiftId: string;
  status: AdjudicationStatus;
  rejectCode?: AdjudicationRejectCode;
  newAlertState?: AlertState;
  newSettlementState?: SettlementState;
  auditEventId?: string;
  confirmedAtServer?: string;
  message?: string;
}

function reject(
  commandId: string,
  shiftId: string,
  rejectCode: AdjudicationRejectCode,
  message: string,
  status: AdjudicationStatus = 'rejected',
): ResolveShiftCloseAlertResponse {
  return { ok: false, commandId, shiftId, status, rejectCode, message };
}

const isoNow = (): string => new Date().toISOString();

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

function liveRole(user: DocumentData): string | null {
  return typeof user.role === 'string' ? user.role : null;
}

function liveBranchIds(user: DocumentData): string[] {
  return Array.isArray(user.branchIds) ? user.branchIds.filter((v): v is string => typeof v === 'string') : [];
}

function hasLiveBranchAccess(branchIds: string[], branchId: string): boolean {
  return branchIds.includes('ALL') || branchIds.includes(branchId);
}

/**
 * Core resolver — EXPORTED so it is unit-tested without the Functions
 * runtime (see `__tests__/resolveShiftCloseAlert.test.ts`), mirroring
 * `resolveReversal.ts`'s `performResolveReversal` shape.
 */
export async function performResolveShiftCloseAlert(
  database: Firestore,
  req: ResolveShiftCloseAlertRequest,
  auth: AuthTokenLike,
): Promise<ResolveShiftCloseAlertResponse> {
  const rawCommandId = String(req.commandId ?? '').trim();
  const rawShiftId = String(req.shiftId ?? '').trim();

  if (hasPresentPin(req)) {
    return reject(rawCommandId, rawShiftId, 'invalid_payload', 'payload ไม่ครบถ้วนหรือไม่ถูกต้อง');
  }

  if (!auth) return reject(rawCommandId, rawShiftId, 'unauthorized', 'ต้องเข้าสู่ระบบก่อน');

  const freshness = await evaluateFreshPrivilegedAuthority(database, auth);
  if (!freshness.ok) {
    return reject(rawCommandId, rawShiftId, 'unauthorized', 'ไม่มีสิทธิ์ดำเนินการ');
  }

  const validated = validateAdjudicationPayload(req);
  if (!validated.ok) {
    return reject(rawCommandId, rawShiftId, 'invalid_payload', 'payload ไม่ครบถ้วนหรือไม่ถูกต้อง');
  }
  const value: ValidatedAdjudicationRequest = validated.value;

  const authority = checkAdjudicationAuthority(auth, value.branchId, true, true);
  if (authority.rejectCode) {
    return reject(value.commandId, value.shiftId, authority.rejectCode, 'ไม่มีสิทธิ์ดำเนินการ');
  }
  const managerUid = authority.managerUid as string;

  const payloadCanonical = adjudicationPayloadCanonical(value);
  const payloadHash = adjudicationPayloadHash(value);
  const commandRef = database.collection(C.adjudicationCommands).doc(commandLedgerId(value.commandId));

  try {
    return await database.runTransaction(async (tx) => {
      // R1 — Idempotency ledger first. Duplicate short-circuits before approval.
      const commandSnap = await tx.get(commandRef);
      if (commandSnap.exists) {
        const command = commandSnap.data() as DocumentData;
        if (command.payloadHash === payloadHash) {
          return {
            ok: true,
            commandId: value.commandId,
            shiftId: value.shiftId,
            status: 'duplicate_confirmed' as AdjudicationStatus,
            newAlertState: command.newAlertState as AlertState | undefined,
            newSettlementState: command.newSettlementState as SettlementState | undefined,
            auditEventId: command.auditEventId as string | undefined,
            confirmedAtServer: (command.confirmedAtServer as string) ?? undefined,
          };
        }
        return reject(
          value.commandId,
          value.shiftId,
          'invalid_payload',
          'commandId ซ้ำแต่ payload ไม่ตรงกัน',
          'conflict_requires_manual_review',
        );
      }

      // R2 approval, R3 live caller, then model-discriminated credential + case/alert.
      const approvalRef = database.collection(C.approvals).doc(value.approvalId);
      const userRef = database.collection(C.users).doc(managerUid);
      const caseRef = database.collection(C.cases).doc(value.shiftId);
      const alertRef = database.collection(C.alerts).doc(value.shiftId);

      const approvalSnap = await tx.get(approvalRef);
      const userSnap = await tx.get(userRef);

      // C1–C2 live caller (document, never token)
      if (!userSnap.exists) {
        return reject(value.commandId, value.shiftId, 'unauthorized', 'ไม่มีสิทธิ์ดำเนินการ');
      }
      const liveUser = (userSnap.data() ?? {}) as DocumentData;
      if (liveUser.isActive !== true || liveUser.deletedAt != null) {
        return reject(value.commandId, value.shiftId, 'unauthorized', 'ไม่มีสิทธิ์ดำเนินการ');
      }
      const liveAuthVersion =
        typeof liveUser.authVersion === 'number' && Number.isFinite(liveUser.authVersion) ? liveUser.authVersion : 0;
      const tokenAuthVersion =
        typeof auth?.token?.authVersion === 'number' && Number.isFinite(auth.token.authVersion)
          ? auth.token.authVersion
          : -1;
      if (liveAuthVersion !== tokenAuthVersion) {
        return reject(value.commandId, value.shiftId, 'unauthorized', 'ไม่มีสิทธิ์ดำเนินการ');
      }

      const approval = approvalViewFromData(approvalSnap.exists ? approvalSnap.data() : undefined);
      if (!approval) {
        return reject(value.commandId, value.shiftId, 'invalid_pin', 'ต้องยืนยัน PIN ใหม่ก่อนดำเนินการ');
      }

      const role = liveRole(liveUser);
      let credentialSubjectId = managerUid;
      let projectionManagerUid = managerUid;

      if (approval.securityModel === APPROVAL_SECURITY_MODEL) {
        if (role !== 'admin' && role !== 'manager') {
          return reject(value.commandId, value.shiftId, 'unauthorized', 'ไม่มีสิทธิ์ดำเนินการ');
        }
        if (!hasLiveBranchAccess(liveBranchIds(liveUser), value.branchId)) {
          return reject(value.commandId, value.shiftId, 'unauthorized', 'ไม่มีสิทธิ์ดำเนินการ');
        }
      } else if (approval.securityModel === APPROVAL_SECURITY_MODEL_DELEGATED) {
        if (!isModel2RequesterRole(role)) {
          return reject(value.commandId, value.shiftId, 'unauthorized', 'ไม่มีสิทธิ์ดำเนินการ');
        }
        if (!requesterBranchEligible(liveBranchIds(liveUser), value.branchId)) {
          return reject(value.commandId, value.shiftId, 'unauthorized', 'ไม่มีสิทธิ์ดำเนินการ');
        }
        if (managerUid !== approval.requesterStaffId || managerUid !== approval.executorStaffId) {
          return reject(value.commandId, value.shiftId, 'unauthorized', 'ไม่มีสิทธิ์ดำเนินการ');
        }
        const approverId =
          typeof approval.approverStaffId === 'string' && approval.approverStaffId.length > 0
            ? approval.approverStaffId
            : '';
        if (!approverId) {
          return reject(value.commandId, value.shiftId, 'invalid_pin', 'ต้องยืนยัน PIN ใหม่ก่อนดำเนินการ');
        }
        const approverSnap = await tx.get(database.collection(C.users).doc(approverId));
        if (!approverSnap.exists) {
          return reject(value.commandId, value.shiftId, 'invalid_pin', 'ต้องยืนยัน PIN ใหม่ก่อนดำเนินการ');
        }
        const liveApprover = (approverSnap.data() ?? {}) as DocumentData;
        if (liveApprover.isActive !== true || liveApprover.deletedAt != null) {
          return reject(value.commandId, value.shiftId, 'invalid_pin', 'ต้องยืนยัน PIN ใหม่ก่อนดำเนินการ');
        }
        const approverRole = liveRole(liveApprover);
        if (!isModel2ApproverRole(approverRole)) {
          return reject(value.commandId, value.shiftId, 'invalid_pin', 'ต้องยืนยัน PIN ใหม่ก่อนดำเนินการ');
        }
        if (!approverBranchEligible(approverRole, liveBranchIds(liveApprover), value.branchId)) {
          return reject(value.commandId, value.shiftId, 'invalid_pin', 'ต้องยืนยัน PIN ใหม่ก่อนดำเนินการ');
        }
        const liveApproverAuthVersion =
          typeof liveApprover.authVersion === 'number' && Number.isFinite(liveApprover.authVersion)
            ? liveApprover.authVersion
            : 0;
        if (liveApproverAuthVersion !== approval.approverAuthVersionAtIssue) {
          return reject(value.commandId, value.shiftId, 'invalid_pin', 'ต้องยืนยัน PIN ใหม่ก่อนดำเนินการ');
        }
        credentialSubjectId = approverId;
        // Alert projection records under whose authority the alert was adjudicated.
        projectionManagerUid = approverId;
      } else {
        return reject(value.commandId, value.shiftId, 'invalid_pin', 'ต้องยืนยัน PIN ใหม่ก่อนดำเนินการ');
      }

      const cred = await readUserCredential(database, credentialSubjectId, tx);
      const [caseSnap, alertSnap] = await Promise.all([tx.get(caseRef), tx.get(alertRef)]);

      if (!isUsableForLogin(cred) || cred.credentialState !== 'rotated_authoritative') {
        return reject(value.commandId, value.shiftId, 'invalid_pin', 'ต้องยืนยัน PIN ใหม่ก่อนดำเนินการ');
      }
      if (cred.credentialVersion !== approval.credentialVersionAtIssue) {
        return reject(value.commandId, value.shiftId, 'invalid_pin', 'ต้องยืนยัน PIN ใหม่ก่อนดำเนินการ');
      }

      const bindingExpected: ApprovalBindingExpected = {
        audience: APPROVAL_AUDIENCE,
        protectedAction: expectedActionFor(value.requestedOutcome),
        targetEntityId: value.shiftId,
        branchId: value.branchId,
        commandId: value.commandId,
        staffId: managerUid,
        authVersion: liveAuthVersion,
      };
      if (!checkApprovalBinding(approval, bindingExpected)) {
        return reject(value.commandId, value.shiftId, 'invalid_pin', 'ต้องยืนยัน PIN ใหม่ก่อนดำเนินการ');
      }
      if (approval.consumedAt != null) {
        return reject(value.commandId, value.shiftId, 'invalid_pin', 'ต้องยืนยัน PIN ใหม่ก่อนดำเนินการ');
      }
      const nowMillis = Date.now();
      if (approval.expiresAtMillis == null || approval.expiresAtMillis <= nowMillis) {
        return reject(value.commandId, value.shiftId, 'invalid_pin', 'ต้องยืนยัน PIN ใหม่ก่อนดำเนินการ');
      }

      if (!caseSnap.exists) {
        return reject(value.commandId, value.shiftId, 'case_not_found', 'ไม่พบเคสปิดกะนี้');
      }
      const caseData = caseSnap.data() as DocumentData;

      if (caseData.branchId !== value.branchId) {
        return reject(value.commandId, value.shiftId, 'unauthorized', 'สาขาไม่ตรงกับเคส');
      }

      if (typeof caseData.caseVersion !== 'number' || caseData.caseVersion !== value.expectedCaseVersion) {
        return reject(
          value.commandId,
          value.shiftId,
          'stale_case_version',
          'เวอร์ชันเคสไม่ตรงกับปัจจุบัน — โปรดโหลดข้อมูลใหม่',
          'conflict_requires_manual_review',
        );
      }

      const leaseExpiry = caseData.leaseExpiry as Timestamp | null | undefined;
      if (
        isLeaseLive(
          { leaseOwner: (caseData.leaseOwner as string | null) ?? null, leaseExpiryMillis: leaseExpiry ? leaseExpiry.toMillis() : null },
          nowMillis,
        )
      ) {
        return reject(
          value.commandId,
          value.shiftId,
          'stale_case_version',
          'เคสกำลังถูกประมวลผลโดยระบบอยู่ — โปรดลองใหม่ภายหลัง',
          'conflict_requires_manual_review',
        );
      }

      if (!alertSnap.exists) {
        return reject(value.commandId, value.shiftId, 'alert_not_open', 'ไม่พบการแจ้งเตือนสำหรับเคสนี้');
      }
      const alertData = alertSnap.data() as DocumentData;

      const transition = decideAdjudicationTransition({
        caseView: {
          alertState: (caseData.alertState as AlertState) ?? 'none',
          settlementState: (caseData.settlementState as SettlementState) ?? 'unsettled',
        },
        alertView: {
          alertState: (alertData.alertState as AlertState) ?? 'none',
          reasonCode: (alertData.reasonCode as AlertReasonCode | null) ?? null,
          acknowledgedByActor: (alertData.acknowledgedByActor as never) ?? null,
        },
        requestedOutcome: value.requestedOutcome,
        managerUid: projectionManagerUid,
      });
      if (transition.kind === 'rejected') {
        return reject(value.commandId, value.shiftId, transition.rejectCode, 'ไม่สามารถเปลี่ยนสถานะการแจ้งเตือนได้');
      }

      const now = FieldValue.serverTimestamp();
      const confirmedAtServer = isoNow();
      const newCaseVersion = (caseData.caseVersion as number) + 1;
      const { alertProjection, newSettlementState } = transition;

      tx.update(approvalRef, {
        consumedAt: now,
        consumedByStaffId: managerUid,
        consumingAudience: APPROVAL_AUDIENCE,
        consumedCaseVersion: newCaseVersion,
      });

      tx.update(caseRef, {
        alertState: alertProjection.alertState,
        settlementState: newSettlementState,
        caseVersion: newCaseVersion,
        updatedAt: now,
      });

      tx.update(alertRef, {
        alertState: alertProjection.alertState,
        reasonCode: alertProjection.reasonCode,
        acknowledgedByActor: alertProjection.acknowledgedByActor,
        resolvedByActor: alertProjection.resolvedByActor,
        caseVersion: newCaseVersion,
        updatedAt: now,
      });

      const auditEventId = computeP5DAuditEventId({
        shiftId: value.shiftId,
        eventKey: value.commandId,
        transitionType: `adjudication_${value.requestedOutcome}`,
        targetCaseVersion: newCaseVersion,
      });
      const approvalData = (approvalSnap.data() ?? {}) as DocumentData;
      tx.create(database.collection(C.auditEvents).doc(auditEventId), {
        eventId: auditEventId,
        shiftId: value.shiftId,
        caseVersion: newCaseVersion,
        runId: (caseData.selectedRunId as string | null) ?? null,
        transitionType: `adjudication_${value.requestedOutcome}`,
        actor: alertProjection.acknowledgedByActor && alertProjection.alertState === 'acknowledged'
          ? alertProjection.acknowledgedByActor
          : alertProjection.resolvedByActor,
        reasonCode: value.reasonCode,
        note: value.reasonNote,
        branchId: value.branchId,
        schemaVersion: 1,
        pinVerifiedAtServer: approvalData.issuedAt ?? null,
        approvalId: value.approvalId,
        securityModel: approval.securityModel,
        requesterStaffId: approval.requesterStaffId,
        approverStaffId: approval.approverStaffId,
        executorStaffId: approval.executorStaffId,
        commandId: value.commandId,
        createdAt: now,
      });

      tx.set(commandRef, {
        commandId: value.commandId,
        payloadHash,
        payloadCanonical,
        shiftId: value.shiftId,
        branchId: value.branchId,
        requestedOutcome: value.requestedOutcome,
        approvalId: value.approvalId,
        newAlertState: alertProjection.alertState,
        newSettlementState,
        auditEventId,
        actorUid: managerUid,
        confirmedAtServer,
        createdAtServer: now,
      });

      return {
        ok: true,
        commandId: value.commandId,
        shiftId: value.shiftId,
        status: 'confirmed' as AdjudicationStatus,
        newAlertState: alertProjection.alertState,
        newSettlementState,
        auditEventId,
        confirmedAtServer,
      };
    });
  } catch (err) {
    console.error('[resolveShiftCloseAlert] unexpected error', err);
    return reject(value.commandId, value.shiftId, 'server_error', 'เกิดข้อผิดพลาดภายในระบบ');
  }
}

export const resolveShiftCloseAlert = onCall(
  {
    region: FUNCTIONS_REGION,
    cors: [/^https?:\/\/localhost:\d+$/, /^https:\/\/.*\.firebaseapp\.com$/, /^https:\/\/.*\.web\.app$/],
  },
  async (request) => {
    return performResolveShiftCloseAlert(db, (request.data ?? {}) as ResolveShiftCloseAlertRequest, request.auth as AuthTokenLike);
  },
);
