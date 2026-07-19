/**
 * shiftCloseSourceEvents — P5-D-2. [P1 offline-sync Packet 5]
 *
 * Four Firestore `onDocumentWritten` triggers (asyncOrders/orders/
 * cashTransactions/creditPayments) that convert relevant source-document
 * changes into low-latency enqueue/requeue updates on the existing
 * `shiftCloseCases/{shiftId}` case model. Pure canonicalization/decision
 * logic lives in `shiftCloseSourceEventsCore.ts` — this file is I/O wiring
 * only: trigger options, one case `get` + one CAS `update` per route target.
 *
 * Frozen invariants (P5-D-2 authorization):
 *  - retry:true — a dropped enqueue delays revalidation until the P5-D-1
 *    sweep's own periodic recheck admits the case again; loss-sensitive
 *    enough to warrant redelivery, and idempotent (frozen watermark rule) so
 *    redelivery is always safe.
 *  - Never validates inline, never creates a validation run, never writes
 *    evidence/run/audit/alert/cursor docs. Only ever touches
 *    `shiftCloseCases/{shiftId}` via the exact allowed enqueue field set.
 *  - `shifts` is NEVER read or written by these triggers.
 *  - Retry/throw is CODE-BASED (`isRetryableFirestoreError`, mirrored in the
 *    core module), never inferred from `error.message` text.
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { FieldValue, Timestamp, type DocumentData } from 'firebase-admin/firestore';
import { db } from './db';
import { FIRESTORE_DATABASE_ID, FUNCTIONS_REGION } from './deployConfig';
import {
  planSourceEventRouting,
  decideTargetOutcome,
  microsFromSecondsNanos,
  microsFromIsoString,
  isRetryableFirestoreError,
  describeErrorCode,
  type SourceKind,
  type RawImage,
  type RouteTarget,
  type CaseSnapshotView,
} from './shiftCloseSourceEventsCore';

const CASE_COLLECTION = 'shiftCloseCases';

/** Minimal shape the handler reads — the real FirestoreEvent is assignable to it. */
export type WrittenEvent = {
  params: Record<string, string>;
  time: string;
  /** CloudEvent envelope `id` — a globally unique, per-delivery-stable token. Threaded into the ledger dedup key only (see `RouteTarget.eventId`). */
  id: string;
  data?: {
    before?: { exists: boolean; data: () => DocumentData | undefined };
    after?: {
      exists: boolean;
      data: () => DocumentData | undefined;
      updateTime?: { seconds: number; nanoseconds: number };
    };
  };
};

function toRawImage(data: DocumentData | undefined): RawImage | undefined {
  return data as RawImage | undefined;
}

/**
 * Reads the case doc, decides the outcome (branch check + frozen watermark
 * rule, delegated entirely to the pure core), and performs at most ONE CAS
 * `update` — never anything outside `shiftCloseCases/{shiftId}`, never any
 * of the red-zone fields (§8/§12 of the P5-D-2 authorization).
 */
export async function processRouteTarget(target: RouteTarget, nowMillis: number): Promise<void> {
  const caseRef = db.collection(CASE_COLLECTION).doc(target.shiftId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(caseRef);
      const view: CaseSnapshotView | null = snap.exists
        ? {
            caseVersion: typeof snap.get('caseVersion') === 'number' ? (snap.get('caseVersion') as number) : 0,
            sourceRevision: typeof snap.get('sourceRevision') === 'number' ? (snap.get('sourceRevision') as number) : 0,
            pendingRevalidation: Boolean(snap.get('pendingRevalidation')),
            lastObservedCommitMicros:
              typeof snap.get('lastObservedCommitMicros') === 'string' ? (snap.get('lastObservedCommitMicros') as string) : '0',
            commitBoundaryDocKeys: Array.isArray(snap.get('commitBoundaryDocKeys')) ? (snap.get('commitBoundaryDocKeys') as string[]) : [],
            branchId: typeof snap.get('branchId') === 'string' ? (snap.get('branchId') as string) : null,
            lastEnqueuedSourceEventId: typeof snap.get('lastEnqueuedSourceEventId') === 'string' ? (snap.get('lastEnqueuedSourceEventId') as string) : null,
            // [RC-RR1] Defensive default, mirroring the existing commitBoundaryDocKeys
            // pattern: a case created before this remediation (or any malformed shape)
            // is simply treated as an empty ledger, never a crash or false-negative dedup.
            recentEnqueuedSourceEventIds: Array.isArray(snap.get('recentEnqueuedSourceEventIds'))
              ? (snap.get('recentEnqueuedSourceEventIds') as string[])
              : [],
          }
        : null;

      const outcome = decideTargetOutcome({ target, caseView: view, nowMillis });

      if (outcome.kind === 'case_absent' || outcome.kind === 'noop_watermark' || outcome.kind === 'noop_duplicate_source_event') {
        return;
      }

      if (outcome.kind === 'branch_mismatch') {
        console.warn('[shiftCloseSourceEvents] source_event_branch_mismatch', {
          shiftId: target.shiftId,
          sourceKind: target.sourceKind,
          sourceId: target.sourceId,
          caseBranchId: outcome.caseBranchId,
          targetBranchId: outcome.targetBranchId,
        });
        return;
      }

      const update: Record<string, unknown> = {
        caseVersion: outcome.write.caseVersion,
        sourceRevision: outcome.write.sourceRevision,
        pendingRevalidation: outcome.write.pendingRevalidation,
        processingState: outcome.write.processingState,
        lastObservedCommitMicros: outcome.write.lastObservedCommitMicros,
        commitBoundaryDocKeys: outcome.write.commitBoundaryDocKeys,
        lastEnqueuedSourceEventId: outcome.write.lastEnqueuedSourceEventId,
        recentEnqueuedSourceEventIds: outcome.write.recentEnqueuedSourceEventIds,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (outcome.write.nextEligibleAtMillis !== undefined) {
        update.nextEligibleAt = Timestamp.fromMillis(outcome.write.nextEligibleAtMillis);
      }
      tx.update(caseRef, update);
    });
  } catch (err) {
    if (isRetryableFirestoreError(err)) {
      // Stable coded transient Firestore/gRPC failure — rethrow so retry:true redelivers.
      throw err;
    }
    // Permanent/local/schema/programmer/unknown-non-coded — ACK, do not burn the retry window.
    console.error('[shiftCloseSourceEvents] source_event_transaction_error_permanent', {
      shiftId: target.shiftId,
      sourceKind: target.sourceKind,
      sourceId: target.sourceId,
      code: describeErrorCode(err),
    });
  }
}

/**
 * Trigger handler — EXTRACTED and EXPORTED so routing/decision wiring is
 * unit-testable without an emulator (mirrors `captureOnWrite`'s pattern in
 * `shiftCloseEvidenceCapture.ts`). Targets are processed sequentially, one
 * case `get` + one CAS transaction each — never in parallel, so two targets
 * sharing a shiftId never race each other within a single invocation.
 */
export async function sourceEventOnWrite(sourceKind: SourceKind, sourceId: string, event: WrittenEvent): Promise<void> {
  const beforeExists = event.data?.before?.exists ?? false;
  const afterExists = event.data?.after?.exists ?? false;

  const before = beforeExists ? toRawImage(event.data?.before?.data()) : undefined;
  const after = afterExists ? toRawImage(event.data?.after?.data()) : undefined;

  const afterUpdateTime = event.data?.after?.updateTime;
  const updateTimeMicros = afterExists && afterUpdateTime ? microsFromSecondsNanos(afterUpdateTime.seconds, afterUpdateTime.nanoseconds) : null;
  const eventTimeMicros = microsFromIsoString(event.time);

  const routing = planSourceEventRouting({ sourceKind, sourceId, before, after, updateTimeMicros, eventTimeMicros, eventId: event.id });
  if (routing.kind === 'no_targets') return;

  const nowMillis = Date.now();
  for (const target of routing.targets) {
    await processRouteTarget(target, nowMillis);
  }
}

export const shiftCloseSourceEventAsyncOrders = onDocumentWritten(
  { document: 'asyncOrders/{orderId}', database: FIRESTORE_DATABASE_ID, region: FUNCTIONS_REGION, retry: true },
  (event) => {
    const e = event as unknown as WrittenEvent;
    return sourceEventOnWrite('asyncOrders', e.params.orderId, e);
  },
);

export const shiftCloseSourceEventOrders = onDocumentWritten(
  { document: 'orders/{orderId}', database: FIRESTORE_DATABASE_ID, region: FUNCTIONS_REGION, retry: true },
  (event) => {
    const e = event as unknown as WrittenEvent;
    return sourceEventOnWrite('orders', e.params.orderId, e);
  },
);

export const shiftCloseSourceEventCashTransactions = onDocumentWritten(
  { document: 'cashTransactions/{txId}', database: FIRESTORE_DATABASE_ID, region: FUNCTIONS_REGION, retry: true },
  (event) => {
    const e = event as unknown as WrittenEvent;
    return sourceEventOnWrite('cashTransactions', e.params.txId, e);
  },
);

export const shiftCloseSourceEventCreditPayments = onDocumentWritten(
  { document: 'creditPayments/{paymentId}', database: FIRESTORE_DATABASE_ID, region: FUNCTIONS_REGION, retry: true },
  (event) => {
    const e = event as unknown as WrittenEvent;
    return sourceEventOnWrite('creditPayments', e.params.paymentId, e);
  },
);
