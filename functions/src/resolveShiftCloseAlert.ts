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
  commandLedgerId,
  decideAdjudicationTransition,
  isLeaseLive,
  validateAdjudicationPayload,
  type AdjudicationRejectCode,
  type AdjudicationStatus,
  type AuthTokenLike,
  type ResolveShiftCloseAlertRequest,
  type ValidatedAdjudicationRequest,
} from './resolveShiftCloseAlertCore';

const C = {
  cases: 'shiftCloseCases',
  alerts: 'shiftCloseAlerts',
  auditEvents: 'shiftCloseAuditEvents',
  adjudicationCommands: 'shiftCloseAdjudicationCommands',
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

  const validated = validateAdjudicationPayload(req);
  if (!validated.ok) {
    return reject(rawCommandId, rawShiftId, 'invalid_payload', 'payload ไม่ครบถ้วนหรือไม่ถูกต้อง');
  }
  const value: ValidatedAdjudicationRequest = validated.value;

  if (!auth) return reject(value.commandId, value.shiftId, 'unauthorized', 'ต้องเข้าสู่ระบบก่อน');

  const authority = checkAdjudicationAuthority(auth, value.branchId);
  if (authority.rejectCode) {
    return reject(value.commandId, value.shiftId, authority.rejectCode, 'ไม่มีสิทธิ์ดำเนินการ');
  }
  const managerUid = authority.managerUid as string;

  const payloadCanonical = adjudicationPayloadCanonical(value);
  const payloadHash = adjudicationPayloadHash(value);
  const commandRef = database.collection(C.adjudicationCommands).doc(commandLedgerId(value.commandId));

  try {
    return await database.runTransaction(async (tx) => {
      // ── Idempotency ledger (read first) ──
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
        // Same commandId + DIFFERENT payload → never mutate, never overwrite audit.
        return reject(
          value.commandId,
          value.shiftId,
          'invalid_payload',
          'commandId ซ้ำแต่ payload ไม่ตรงกัน',
          'conflict_requires_manual_review',
        );
      }

      // ── Case + alert reads (same shiftId doc id on both collections) ──
      const caseRef = database.collection(C.cases).doc(value.shiftId);
      const alertRef = database.collection(C.alerts).doc(value.shiftId);
      const [caseSnap, alertSnap] = await Promise.all([tx.get(caseRef), tx.get(alertRef)]);

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

      // Gemini Lease Option 1 — refuse on a live (non-expired) P5-D worker
      // lease; zero writes. Reuses 'stale_case_version' (the closest of the
      // frozen 8 reject codes: the case is not currently stable to
      // adjudicate) — distinguished by message text and status.
      const leaseExpiry = caseData.leaseExpiry as Timestamp | null | undefined;
      const nowMillis = Date.now();
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
        managerUid,
      });
      if (transition.kind === 'rejected') {
        return reject(value.commandId, value.shiftId, transition.rejectCode, 'ไม่สามารถเปลี่ยนสถานะการแจ้งเตือนได้');
      }

      // ── Writes (only after every guard above passed) ──
      const now = FieldValue.serverTimestamp();
      const confirmedAtServer = isoNow();
      const newCaseVersion = (caseData.caseVersion as number) + 1;
      const { alertProjection, newSettlementState } = transition;

      tx.update(caseRef, {
        alertState: alertProjection.alertState,
        settlementState: newSettlementState,
        caseVersion: newCaseVersion,
        updatedAt: now,
      });

      // openedAt is preserved verbatim — 'acknowledged'/'resolved' are both
      // "preserve" transitions in the frozen P5-B/P5-D rule (never 'open',
      // never 'none'; see shiftCloseValidationWorkerCore's computeOpenedAtWrite).
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
        // D5 Option C: reserved for a future step-up gate; never verified/persisted this packet.
        pinVerifiedAtServer: null,
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
