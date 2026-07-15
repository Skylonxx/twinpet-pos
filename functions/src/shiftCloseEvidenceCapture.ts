/**
 * shiftCloseEvidenceCapture — P5-C-1. [P1 offline-sync Packet 5]
 *
 * Firestore `onDocumentWritten` trigger on `shifts/{shiftId}` that captures
 * immutable evidence for the FIRST server-visible transition to closed. Pure
 * canonicalization/decision logic lives in `shiftCloseEvidenceCaptureCore.ts`
 * — this file is I/O wiring only: trigger options, transaction read/write.
 *
 * Frozen invariants (P5-C plan + R1/R2/R3 remediations):
 *  - retry:true — capture is loss-sensitive (v2 default is false).
 *  - Structural refusals/anomalies ACK without throwing (no writes, no retry
 *    burn — a redelivery would re-fail identically against the same facts).
 *  - Retry/throw is CODE-BASED (`isRetryableFirestoreError`, in the core
 *    module), never inferred from `error.message` text: a stable coded
 *    transient Firestore/gRPC failure (DEADLINE_EXCEEDED/RESOURCE_EXHAUSTED/
 *    ABORTED/UNAVAILABLE) is rethrown so retry:true redelivers; every other
 *    rejection — including local invariant/schema/programmer errors thrown
 *    while building a write shape — is structured-logged (identifiers/code
 *    only) and ACKed, never retried.
 *  - Never mutates `shifts`. Never writes `shiftCloseValidationRuns`. Never
 *    uses a `sourceManifest`.
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { FieldValue, type DocumentData } from 'firebase-admin/firestore';
import { db } from './db';
import { FIRESTORE_DATABASE_ID, FUNCTIONS_REGION } from './deployConfig';
import {
  planCapture,
  decideCapture,
  buildInitWrites,
  buildConflictWrites,
  isRetryableFirestoreError,
  describeErrorCode,
  type ExistingEvidenceView,
  type ExistingCaseView,
} from './shiftCloseEvidenceCaptureCore';

const EVIDENCE_COLLECTION = 'shiftCloseEvidence';
const CASE_COLLECTION = 'shiftCloseCases';
const AUDIT_COLLECTION = 'shiftCloseAuditEvents';
const ALERT_COLLECTION = 'shiftCloseAlerts';

/** Minimal shape the handler reads — the real FirestoreEvent is assignable to it. */
export type WrittenEvent = {
  params: { shiftId: string };
  time: string;
  data?: {
    before?: { exists: boolean; data: () => DocumentData | undefined };
    after?: { exists: boolean; data: () => DocumentData | undefined };
  };
};

/**
 * Trigger handler — EXTRACTED and EXPORTED so routing/decision wiring is
 * unit-testable without an emulator (mirrors `reconcileOnWrite`'s pattern in
 * `reconcileOrder.ts`).
 */
export async function captureOnWrite(event: WrittenEvent): Promise<void> {
  const shiftId = event.params.shiftId;
  const beforeData = event.data?.before?.exists ? event.data.before.data() : undefined;
  const afterData = event.data?.after?.exists ? event.data.after.data() : undefined;

  const plan = planCapture({ shiftId, before: beforeData, after: afterData, eventTimeIso: event.time });

  if (plan.kind === 'not_close_transition') return;

  if (plan.kind === 'refused') {
    console.warn(`[shiftCloseEvidenceCapture] ${plan.code}`, plan.fields);
    return;
  }

  const capture = plan.capture;
  const evidenceRef = db.collection(EVIDENCE_COLLECTION).doc(capture.evidenceId);
  const caseRef = db.collection(CASE_COLLECTION).doc(capture.shiftId);

  try {
    await db.runTransaction(async (tx) => {
      const [caseSnap, evidenceSnap] = await tx.getAll(caseRef, evidenceRef);

      const existingEvidence: ExistingEvidenceView = evidenceSnap.exists
        ? {
            exists: true,
            id: evidenceSnap.id,
            evidenceId: evidenceSnap.get('evidenceId'),
            shiftId: evidenceSnap.get('shiftId'),
            closeHash: evidenceSnap.get('closeHash'),
            sourceCloseDocPath: evidenceSnap.get('sourceCloseDocPath'),
            branchId: evidenceSnap.get('branchId'),
            staffId: evidenceSnap.get('staffId'),
            deviceId: evidenceSnap.get('deviceId'),
            schemaVersion: evidenceSnap.get('schemaVersion'),
          }
        : { exists: false };

      const existingCase: ExistingCaseView = caseSnap.exists
        ? {
            exists: true,
            shiftId: caseSnap.get('shiftId'),
            branchId: caseSnap.get('branchId'),
            staffId: caseSnap.get('staffId'),
            deviceId: caseSnap.get('deviceId'),
            schemaVersion: caseSnap.get('schemaVersion'),
            caseVersion: caseSnap.get('caseVersion'),
            sourceRevision: caseSnap.get('sourceRevision'),
          }
        : { exists: false };

      const decision = decideCapture(capture, existingEvidence, existingCase);

      if (decision.kind === 'anomaly') {
        console.warn(`[shiftCloseEvidenceCapture] ${decision.code}`, decision.fields);
        return;
      }

      if (decision.kind === 'noop') {
        return;
      }

      const now = FieldValue.serverTimestamp();

      if (decision.kind === 'init') {
        const { evidenceFields, caseFields, auditFields, alertFields, auditEventId } = buildInitWrites(capture);
        tx.create(evidenceRef, { ...evidenceFields, capturedAt: now, createdAt: now });
        tx.create(caseRef, { ...caseFields, nextEligibleAt: now, createdAt: now, updatedAt: now });
        tx.create(db.collection(AUDIT_COLLECTION).doc(auditEventId), { ...auditFields, createdAt: now });
        tx.create(db.collection(ALERT_COLLECTION).doc(capture.shiftId), { ...alertFields, updatedAt: now });
        return;
      }

      // decision.kind === 'conflict'
      const { evidenceFields, auditFields, caseUpdateFields, auditEventId } = buildConflictWrites(
        capture,
        decision.nextCaseVersion,
        decision.nextSourceRevision,
      );
      tx.create(evidenceRef, { ...evidenceFields, capturedAt: now, createdAt: now });
      tx.create(db.collection(AUDIT_COLLECTION).doc(auditEventId), { ...auditFields, createdAt: now });
      tx.update(caseRef, { ...caseUpdateFields, updatedAt: now });
    });
  } catch (err) {
    if (isRetryableFirestoreError(err)) {
      // Stable coded transient Firestore/gRPC failure — rethrow so retry:true redelivers.
      throw err;
    }
    // Permanent/local/schema/programmer/unknown-non-coded — ACK, do not burn the retry window.
    console.error('[shiftCloseEvidenceCapture] capture_transaction_error_permanent', {
      shiftId: capture.shiftId,
      code: describeErrorCode(err),
    });
  }
}

export const shiftCloseEvidenceCapture = onDocumentWritten(
  {
    document: 'shifts/{shiftId}',
    database: FIRESTORE_DATABASE_ID,
    region: FUNCTIONS_REGION,
    retry: true,
  },
  (event) => captureOnWrite(event as unknown as WrittenEvent),
);
