/**
 * shiftCloseValidationWorker — P5-D-1. [P1 offline-sync Packet 5]
 *
 * Scheduled validation worker + routine sweep. I/O wiring only: Firestore
 * transactions, queries, cursor CAS. Every DECISION (what to write) is
 * delegated to the pure `shiftCloseValidationWorkerCore` /
 * `shiftCloseValidationDrawerFold` / P5-B modules — this file never encodes
 * verdict/retry/ownership logic itself.
 *
 * Frozen invariants (see the six governing P5-D architecture addenda under
 * OneDrive Ai-Report\twinpet-pos\Architect, read-only inputs to this file):
 *  - T1 (lease acquisition) is the only case-writing transaction that may run
 *    without prior self-ownership; every other case-writing transaction
 *    checks `leaseOwner == self` FIRST, inside its own transaction, before
 *    any write (Gate 1 / Option A).
 *  - Gate 1 (owner mismatch, incl. observedOwner==null after Q7) is a PURE
 *    transaction return value (`OWNER_MISMATCH`), never a throw inside the
 *    retryable callback. `StopStreamUnowned` is thrown by the adapter only
 *    AFTER the transaction resolves, and is caught only at the per-stream
 *    drain boundary — it never reaches `stepStream`/`process`, never becomes
 *    a `DurableOutcome`, never touches the invocation cache or cursor, and
 *    never persists a cursor-document write for the affected stream.
 *  - Gate 2 (stale case/source revision, owner intact) performs its
 *    four-field release in the SAME T3 transaction — never a nested
 *    `runTransaction`.
 *  - Q7 (expired-lease recovery) is cause-agnostic and non-counting.
 *  - `shifts` is NEVER read or written by this worker.
 */

import { onSchedule, type ScheduledEvent } from 'firebase-functions/v2/scheduler';
import { FieldValue, FieldPath, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import {
  createInvocationResultCache,
  initialStreamCursor,
  stepStream,
  type CaseId,
  type DurableOutcome,
  type InvocationResultCache,
  type StreamCursor,
  type StreamOrder,
} from './shiftCloseValidationState';
import { foldDeviceScopedDrawer, type RawAsyncOrderForFold } from './shiftCloseValidationDrawerFold';
import { foldCashEntriesSnapshot, drawerCashParityMatches } from './shiftCloseValidationCore';
import { classifyCashPairs, type CashPairEntrySide, type CashPairAuditSide } from './shiftCloseValidationCashPairs';
import {
  computeAsyncOrderRelevantFieldsDigest,
  computeCashTransactionRelevantFieldsDigest,
  computeCreditPaymentRelevantFieldsDigest,
  computeOrderRelevantFieldsDigest,
  orderManifestDocs,
} from './shiftCloseValidationManifest';
import { SCHEMA_VERSION } from './shiftCloseEvidenceCaptureCore';
import {
  StopStreamUnowned,
  decideT1Lease,
  evaluateT3Gates,
  decideQ7Recovery,
  classifyWorkerFailure,
  isRetryableFirestoreError,
  isCasContentionError,
  describeErrorCode,
  buildCategoryAOutcome,
  buildCategoryDOutcome,
  compareRecheckDigest,
  buildRecheckEqualCaseUpdate,
  computeInputsDigestAtRevision,
  truncateManifestForPayloadGuard,
  buildSourceManifest,
  decideValidationVerdict,
  validateAlertInvariants,
  computeOpenedAtWrite,
  computeRunTransition,
  buildRunFields,
  buildSelectionCaseUpdate,
  computeP5DAuditEventId,
  canAdmitAnotherCase,
  MAX_SOURCE_DOCS,
  RUN_PAYLOAD_GUARD_BYTES,
  type T1CaseSnapshot,
  type T3CaseSnapshot,
  type Q7CaseSnapshot,
  type CreditDebtReceiptsObserved,
  type InputsDigestSnapshotComponents,
  type ProcessingState,
  type VerdictResult,
} from './shiftCloseValidationWorkerCore';
import type { SourceManifest, SourceManifestDoc, SourceManifestCapReachedBySource } from './shiftCloseValidationTypes';

const CASE_COLLECTION = 'shiftCloseCases';
const EVIDENCE_COLLECTION = 'shiftCloseEvidence';
const ALERT_COLLECTION = 'shiftCloseAlerts';
const RUN_COLLECTION = 'shiftCloseValidationRuns';
const AUDIT_COLLECTION = 'shiftCloseAuditEvents';
const CURSOR_COLLECTION = 'shiftCloseSweepCursor';
/** Q1-Q4 worst-case reads (1,412) + T1/T3 control docs, per case, admission accounting. */
const WORST_CASE_CASE_READS = 1412;

function microsOf(ts: { seconds: number; nanoseconds: number } | undefined): string {
  if (!ts) return '0';
  return (BigInt(ts.seconds) * 1_000_000n + BigInt(Math.floor(ts.nanoseconds / 1000))).toString();
}

function bigIntMaxDecimalStr(values: readonly string[]): string {
  let max = 0n;
  for (const v of values) {
    const n = BigInt(v);
    if (n > max) max = n;
  }
  return max.toString();
}

function describeCode(err: unknown): string | number {
  if (err !== null && typeof err === 'object' && 'code' in err) return (err as { code: string | number }).code;
  return 'unknown';
}

/** Converts the pure core's `leaseExpiryMillis`/`nextEligibleAtMillis` shape into Firestore Timestamp fields. */
function toFirestoreCaseUpdate(update: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...update };
  if ('leaseExpiryMillis' in out) {
    const v = out.leaseExpiryMillis;
    delete out.leaseExpiryMillis;
    out.leaseExpiry = v === null ? null : Timestamp.fromMillis(v as number);
  }
  if ('nextEligibleAtMillis' in out) {
    const v = out.nextEligibleAtMillis as number;
    delete out.nextEligibleAtMillis;
    out.nextEligibleAt = Timestamp.fromMillis(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// T1 — lease acquisition. Exact frozen four-field write only (BF-2): no
// `updatedAt`. `skip_live_owner` / `not_admissible` / a pre-commit
// transaction failure never fabricate a durable, cacheable outcome (BF-2) —
// each is reported as a distinct, honestly-labeled T1Outcome variant that
// `attemptCase`/`drainOneStep` handle without ever calling `stepStream` with
// a synthesized `DurableOutcome`.
// ---------------------------------------------------------------------------

interface T1Acquired {
  isRecheck: boolean;
  expectedCaseVersion: number;
  targetSourceRevision: number;
  targetCloseHash: string;
  selectedRunId: string | null;
  branchId: string;
  staffId: string;
  deviceId: string;
  caseSchemaVersion: unknown;
  latestEvidenceId: string;
  /** BF-9: the case doc's own stored `shiftId` field, for document-id coherence checking (a corrupt stored `shiftId` must not silently pass). */
  caseStoredShiftId: unknown;
  /** The case's `processingState` as read at T1, BEFORE the acquisition write overwrote it to `'validating'` (BF-6 equal-path preservation). */
  priorProcessingState: ProcessingState;
}

type T1Outcome =
  | { kind: 'acquired'; result: T1Acquired }
  /** live-owner skip / not-yet-admissible / case-doc-absent — own-head consumption, no cache (accepted `skipped_leased` rule, extended). */
  | { kind: 'own_head_no_cache' }
  /** pre-commit transaction failure (F1: case-non-counting) — no outcome at all; the row is left exactly where it is for the next attempt. */
  | { kind: 'no_progress' };

async function runT1(firestore: Firestore, shiftId: string, invocationId: string, nowMillis: number): Promise<T1Outcome> {
  const caseRef = firestore.collection(CASE_COLLECTION).doc(shiftId);
  try {
    return await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(caseRef);
      if (!snap.exists) return { kind: 'own_head_no_cache' };
      const data = snap.data() as Record<string, unknown>;
      const leaseExpiry = data.leaseExpiry as Timestamp | null;
      const snapshot: T1CaseSnapshot = {
        pendingRevalidation: data.pendingRevalidation === true,
        selectedCloseHash: (data.selectedCloseHash as string | null) ?? null,
        latestCloseHash: data.latestCloseHash as string,
        leaseOwner: (data.leaseOwner as string | null) ?? null,
        leaseExpiryMillis: leaseExpiry ? leaseExpiry.toMillis() : null,
        nextEligibleAtMillis: (data.nextEligibleAt as Timestamp).toMillis(),
        caseVersion: data.caseVersion as number,
        sourceRevision: data.sourceRevision as number,
        sweepEligible: data.sweepEligible === true,
        selectedRunId: (data.selectedRunId as string | null) ?? null,
      };
      const decision = decideT1Lease({ case: snapshot, nowMillis, invocationId });
      if (decision.kind !== 'acquire') {
        // `skip_live_owner` and `not_admissible` are both zero-write,
        // own-head consumption: the row is legitimately at this stream's
        // head, but there is nothing durable for THIS invocation to do to
        // it — never cached, per the accepted `skipped_leased` rule.
        return { kind: 'own_head_no_cache' };
      }
      tx.update(caseRef, {
        leaseOwner: decision.caseUpdate.leaseOwner,
        leaseExpiry: Timestamp.fromMillis(decision.caseUpdate.leaseExpiryMillis),
        processingState: decision.caseUpdate.processingState,
        caseVersion: decision.caseUpdate.caseVersion,
      });
      return {
        kind: 'acquired',
        result: {
          isRecheck: decision.isRecheck,
          expectedCaseVersion: decision.expectedCaseVersion,
          targetSourceRevision: decision.targetSourceRevision,
          targetCloseHash: decision.targetCloseHash,
          selectedRunId: decision.selectedRunId,
          branchId: data.branchId as string,
          staffId: data.staffId as string,
          deviceId: data.deviceId as string,
          caseSchemaVersion: data.schemaVersion,
          latestEvidenceId: data.latestEvidenceId as string,
          caseStoredShiftId: data.shiftId,
          priorProcessingState: data.processingState as ProcessingState,
        },
      };
    });
  } catch (err) {
    // T1 failures before a committed acquisition are case-non-counting (F1)
    // AND produce no durable outcome of any kind (BF-2) — the row is left
    // exactly where it is; the caller stops this stream for the rest of the
    // invocation so a persistently-failing acquisition cannot spin forever.
    console.warn('[shiftCloseValidationWorker] lease_acquisition_failed', { shiftId, code: describeCode(err) });
    return { kind: 'no_progress' };
  }
}

// ---------------------------------------------------------------------------
// T2 — consistent verdict snapshot (Admin SDK readOnly transaction; not
// retried). Reads the selected-run doc HERE (BF-6: the frozen T2 read-only
// snapshot/read set, not a T3 side-read) when this is a recheck attempt.
// Also computes the identity/schema invariants (BF-9) and the real
// commit-boundary doc keys (BF-10).
// ---------------------------------------------------------------------------

interface T2Result {
  evidenceExists: boolean;
  evidenceIdentityMatches: boolean;
  evidenceDeviceId: string | null;
  legacyMissingRequiredField: boolean;
  capReachedBySource: SourceManifestCapReachedBySource;
  cashEntriesOverflowed: boolean;
  cashEntriesFoldBlockingCount: number;
  manifestDocs: SourceManifestDoc[];
  tenderFold: ReturnType<typeof foldDeviceScopedDrawer>;
  cashPairClassification: ReturnType<typeof classifyCashPairs>;
  drawerCashVerdict: 'match' | 'discrepancy' | 'insufficient_evidence';
  perFieldDeltas: Record<string, number | null>;
  serverComputedDrawer: Record<string, number | null>;
  creditDebtReceiptsObserved: CreditDebtReceiptsObserved;
  computedAtCommitMicros: string;
  /** Source-doc keys (asyncOrders/orders/cashTransactions/creditPayments only) whose updateTime equals the max observed among those four collections (BF-10). Empty when no source docs were read. */
  commitBoundaryDocKeys: string[];
  payInMinor: number;
  payOutMinor: number;
  /** Copied verbatim from the immutable evidence doc (P5-C-computed at capture) — never re-derived. */
  cashEntriesDigest: string;
  cashEntriesFullDigest: string;
  sourceEntryCount: number;
  /** BF-6: read here (frozen T2 snapshot), never in T3. Undefined when not a recheck attempt. */
  selectedRun?: { exists: boolean; inputsDigest: string | null };
}

async function runT2(params: {
  firestore: Firestore;
  shiftId: string;
  branchId: string;
  staffId: string;
  deviceId: string;
  caseSchemaVersion: unknown;
  latestEvidenceId: string;
  caseStoredShiftId: unknown;
  targetCloseHash: string;
  targetSourceRevision: number;
  isRecheck: boolean;
  selectedRunId: string | null;
}): Promise<T2Result> {
  const {
    firestore,
    shiftId,
    branchId,
    staffId,
    deviceId,
    caseSchemaVersion,
    latestEvidenceId,
    caseStoredShiftId,
    targetCloseHash,
    targetSourceRevision,
    isRecheck,
    selectedRunId,
  } = params;
  return firestore.runTransaction(
    async (tx) => {
      const evidenceRef = firestore.collection(EVIDENCE_COLLECTION).doc(`${shiftId}_${targetCloseHash}`);
      const evidenceSnap = await tx.get(evidenceRef);
      const selectedRunSnap = isRecheck && selectedRunId !== null ? await tx.get(firestore.collection(RUN_COLLECTION).doc(selectedRunId)) : null;

      const asyncOrdersQuery = firestore
        .collection('asyncOrders')
        .where('branchId', '==', branchId)
        .where('shiftId', '==', shiftId)
        .orderBy(FieldPath.documentId())
        .limit(MAX_SOURCE_DOCS.asyncOrders + 1);
      const ordersQuery = firestore
        .collection('orders')
        .where('branchId', '==', branchId)
        .where('shiftId', '==', shiftId)
        .orderBy(FieldPath.documentId())
        .limit(MAX_SOURCE_DOCS.orders + 1);
      const cashTxQuery = firestore
        .collection('cashTransactions')
        .where('branchId', '==', branchId)
        .where('shiftId', '==', shiftId)
        .orderBy(FieldPath.documentId())
        .limit(MAX_SOURCE_DOCS.cashTransactions + 1);
      const creditQuery = firestore
        .collection('creditPayments')
        .where('shiftId', '==', shiftId)
        .orderBy(FieldPath.documentId())
        .limit(MAX_SOURCE_DOCS.creditPayments + 1);

      const [asyncOrdersSnap, ordersSnap, cashTxSnap, creditSnap] = await Promise.all([
        tx.get(asyncOrdersQuery),
        tx.get(ordersQuery),
        tx.get(cashTxQuery),
        tx.get(creditQuery),
      ]);

      const capReachedBySource: SourceManifestCapReachedBySource = {
        asyncOrders: asyncOrdersSnap.size > MAX_SOURCE_DOCS.asyncOrders,
        orders: ordersSnap.size > MAX_SOURCE_DOCS.orders,
        cashTransactions: cashTxSnap.size > MAX_SOURCE_DOCS.cashTransactions,
        creditPayments: creditSnap.size > MAX_SOURCE_DOCS.creditPayments,
      };

      const manifestDocs: SourceManifestDoc[] = [];
      const allMicros: string[] = [];
      // BF-10: track (key, micros) for the four ROUTED source collections
      // only (evidence is not a routed/watermarked source) so the true
      // maximum-commit-micros boundary key set can be computed below.
      const sourceBoundaryEntries: Array<{ key: string; micros: string }> = [];

      const asyncOrderFolds: RawAsyncOrderForFold[] = [];
      for (const doc of asyncOrdersSnap.docs) {
        const d = doc.data();
        asyncOrderFolds.push({
          id: doc.id,
          shiftId: d.shiftId,
          branchId: d.branchId,
          deviceId: d.deviceId,
          status: d.status,
          voidRequested: d.voidRequested,
          reconcileStatus: d.reconcileStatus,
          changeAmt: d.changeAmt,
          payments: d.payments,
        });
        const micros = microsOf(doc.updateTime);
        allMicros.push(micros);
        sourceBoundaryEntries.push({ key: `asyncOrders:${doc.id}`, micros });
        manifestDocs.push({
          collection: 'asyncOrders',
          docId: doc.id,
          updateTimeMicros: micros,
          relevantFieldsDigest: computeAsyncOrderRelevantFieldsDigest({
            shiftId: d.shiftId,
            branchId: d.branchId,
            deviceId: d.deviceId,
            status: d.status,
            voidRequested: d.voidRequested,
            voidedAt: d.voidedAt,
            reconcileStatus: d.reconcileStatus,
            changeAmt: d.changeAmt,
            payments: d.payments,
          }),
        });
      }

      for (const doc of ordersSnap.docs) {
        const d = doc.data();
        const micros = microsOf(doc.updateTime);
        allMicros.push(micros);
        sourceBoundaryEntries.push({ key: `orders:${doc.id}`, micros });
        manifestDocs.push({
          collection: 'orders',
          docId: doc.id,
          updateTimeMicros: micros,
          relevantFieldsDigest: computeOrderRelevantFieldsDigest({
            shiftId: d.shiftId,
            branchId: d.branchId,
            deviceId: d.deviceId,
            status: d.status,
            voidRequested: d.voidRequested,
            reconcileStatus: d.reconcileStatus,
          }),
        });
      }

      const cashPairAuditSides: CashPairAuditSide[] = [];
      for (const doc of cashTxSnap.docs) {
        const d = doc.data();
        const micros = microsOf(doc.updateTime);
        allMicros.push(micros);
        sourceBoundaryEntries.push({ key: `cashTransactions:${doc.id}`, micros });
        manifestDocs.push({
          collection: 'cashTransactions',
          docId: doc.id,
          updateTimeMicros: micros,
          relevantFieldsDigest: computeCashTransactionRelevantFieldsDigest({
            id: d.id,
            shiftId: d.shiftId,
            branchId: d.branchId,
            type: d.type,
            amount: d.amount,
          }),
        });
        cashPairAuditSides.push({ id: doc.id, type: d.type, amount: d.amount });
      }

      let creditCashTotal = 0;
      let creditTransferTotal = 0;
      for (const doc of creditSnap.docs) {
        const d = doc.data();
        const micros = microsOf(doc.updateTime);
        allMicros.push(micros);
        sourceBoundaryEntries.push({ key: `creditPayments:${doc.id}`, micros });
        manifestDocs.push({
          collection: 'creditPayments',
          docId: doc.id,
          updateTimeMicros: micros,
          relevantFieldsDigest: computeCreditPaymentRelevantFieldsDigest({
            id: d.id,
            shiftId: d.shiftId,
            paymentMethod: d.paymentMethod,
            amount: d.amount,
          }),
        });
        const amountMinor = typeof d.amount === 'number' ? Math.round(d.amount * 100) : 0;
        if (d.paymentMethod === 'cash') creditCashTotal += amountMinor;
        else creditTransferTotal += amountMinor;
      }

      // BF-10: boundary keys = source docs (of the four routed collections
      // only) whose updateTime equals the maximum observed AMONG THOSE
      // SOURCES. Empty when no source docs were read.
      let commitBoundaryDocKeys: string[] = [];
      if (sourceBoundaryEntries.length > 0) {
        const sourceMaxMicros = bigIntMaxDecimalStr(sourceBoundaryEntries.map((e) => e.micros));
        commitBoundaryDocKeys = sourceBoundaryEntries.filter((e) => e.micros === sourceMaxMicros).map((e) => e.key);
      }

      const selectedRunResult: T2Result['selectedRun'] = isRecheck
        ? selectedRunSnap && selectedRunSnap.exists
          ? { exists: true, inputsDigest: (selectedRunSnap.data() as Record<string, unknown>).inputsDigest as string }
          : { exists: false, inputsDigest: null }
        : undefined;

      if (!evidenceSnap.exists) {
        const result: T2Result = {
          evidenceExists: false,
          evidenceIdentityMatches: false,
          evidenceDeviceId: null,
          legacyMissingRequiredField: false,
          capReachedBySource,
          cashEntriesOverflowed: false,
          cashEntriesFoldBlockingCount: 0,
          manifestDocs,
          tenderFold: foldDeviceScopedDrawer([], ''),
          cashPairClassification: [],
          drawerCashVerdict: 'insufficient_evidence',
          perFieldDeltas: {},
          serverComputedDrawer: {},
          creditDebtReceiptsObserved: {
            cashTotalMinor: creditCashTotal,
            transferTotalMinor: creditTransferTotal,
            count: creditSnap.size,
            linkedShiftIdCount: creditSnap.size,
            observedAsOfSourceRevision: targetSourceRevision,
            classification: 'financially_relevant_not_in_frozen_expected',
          },
          computedAtCommitMicros: bigIntMaxDecimalStr(allMicros.length > 0 ? allMicros : ['0']),
          commitBoundaryDocKeys,
          payInMinor: 0,
          payOutMinor: 0,
          cashEntriesDigest: '',
          cashEntriesFullDigest: '',
          sourceEntryCount: 0,
          selectedRun: selectedRunResult,
        };
        return result;
      }

      const evidence = evidenceSnap.data() as Record<string, unknown>;
      const evidenceDeviceId = evidence.deviceId as string;
      const legacyMissingRequiredField = [
        'startingCash',
        'actualCashCount',
        'expectedCash',
        'expectedQr',
        'expectedKbank',
        'expectedCard',
        'expectedCredit',
        'payInTotal',
        'payOutTotal',
      ].some((field) => evidence[field] === null);

      const cashEntriesSnapshotMeta = evidence.cashEntriesSnapshotMeta as {
        foldBlockingCount: number;
        cashEntriesOverflowed: boolean;
      };
      const cashFold = foldCashEntriesSnapshot((evidence.cashEntriesSnapshot as never[]) ?? []);
      const tenderFold = foldDeviceScopedDrawer(asyncOrderFolds, evidenceDeviceId);

      const entrySides: CashPairEntrySide[] = cashFold.storedSubset
        .filter((e) => e.type !== null && e.amountMinor !== null)
        .map((e) => ({ id: e.orderingId, type: e.type as 'pay_in' | 'pay_out', amount: e.raw.amount as number }));
      const cashPairClassification = classifyCashPairs(entrySides, cashPairAuditSides);

      const parityMatches = drawerCashParityMatches(cashFold, (evidence.payInTotal as number) ?? 0, (evidence.payOutTotal as number) ?? 0);
      const drawerCashVerdict: 'match' | 'discrepancy' | 'insufficient_evidence' =
        parityMatches === null ? 'insufficient_evidence' : parityMatches ? 'match' : 'discrepancy';

      const serverComputedDrawer = {
        expectedCashMinor: tenderFold.expectedCashMinor,
        expectedQrMinor: tenderFold.expectedQrMinor,
        expectedKbankMinor: tenderFold.expectedKbankMinor,
        expectedCardMinor: tenderFold.expectedCardMinor,
        expectedCreditMinor: tenderFold.expectedCreditMinor,
        payInMinor: cashFold.payInMinor !== null ? Number(cashFold.payInMinor) : null,
        payOutMinor: cashFold.payOutMinor !== null ? Number(cashFold.payOutMinor) : null,
        totalBills: tenderFold.totalBills,
      };

      function delta(evidenceField: string, computed: number | null): number | null {
        const evidenceValue = evidence[evidenceField] as number | null;
        if (computed === null || typeof evidenceValue !== 'number') return null;
        return computed - Math.round(evidenceValue * 100);
      }

      // BF-10: complete per-field delta projection, including pay-in/pay-out.
      const perFieldDeltas: Record<string, number | null> = {
        expectedCashMinor: delta('expectedCash', serverComputedDrawer.expectedCashMinor),
        expectedQrMinor: delta('expectedQr', serverComputedDrawer.expectedQrMinor),
        expectedKbankMinor: delta('expectedKbank', serverComputedDrawer.expectedKbankMinor),
        expectedCardMinor: delta('expectedCard', serverComputedDrawer.expectedCardMinor),
        expectedCreditMinor: delta('expectedCredit', serverComputedDrawer.expectedCreditMinor),
        payInMinorDelta: delta('payInTotal', serverComputedDrawer.payInMinor),
        payOutMinorDelta: delta('payOutTotal', serverComputedDrawer.payOutMinor),
        totalBillsDelta:
          serverComputedDrawer.totalBills === null || typeof evidence.totalBills !== 'number'
            ? null
            : serverComputedDrawer.totalBills - (evidence.totalBills as number),
      };

      // BF-9: full immutable identity/schema invariant — staffId, deviceId,
      // both schema versions, the case's own `latestEvidenceId` pointer,
      // AND document-id coherence for both docs: the case doc's own stored
      // `shiftId` field must match its document id (a corrupted stored
      // `shiftId` must not silently pass just because the OTHER fields
      // agree), and the evidence doc's own stored `evidenceId` must match
      // its deterministic document id. Any divergence fails closed into V2
      // (`identity_mismatch`), never a silent select.
      const identityMatches =
        evidence.shiftId === shiftId &&
        evidence.branchId === branchId &&
        evidence.closeHash === targetCloseHash &&
        evidence.staffId === staffId &&
        evidence.deviceId === deviceId &&
        evidence.schemaVersion === SCHEMA_VERSION &&
        caseSchemaVersion === SCHEMA_VERSION &&
        latestEvidenceId === evidenceSnap.id &&
        caseStoredShiftId === shiftId &&
        evidence.evidenceId === evidenceSnap.id;

      allMicros.push(microsOf(evidenceSnap.updateTime));

      const result: T2Result = {
        evidenceExists: true,
        evidenceIdentityMatches: identityMatches,
        evidenceDeviceId,
        legacyMissingRequiredField,
        capReachedBySource,
        cashEntriesOverflowed: cashEntriesSnapshotMeta.cashEntriesOverflowed,
        cashEntriesFoldBlockingCount: cashEntriesSnapshotMeta.foldBlockingCount,
        manifestDocs,
        tenderFold,
        cashPairClassification,
        drawerCashVerdict,
        perFieldDeltas,
        serverComputedDrawer,
        creditDebtReceiptsObserved: {
          cashTotalMinor: creditCashTotal,
          transferTotalMinor: creditTransferTotal,
          count: creditSnap.size,
          linkedShiftIdCount: creditSnap.size,
          observedAsOfSourceRevision: targetSourceRevision,
          classification: 'financially_relevant_not_in_frozen_expected',
        },
        computedAtCommitMicros: bigIntMaxDecimalStr(allMicros),
        commitBoundaryDocKeys,
        payInMinor: cashFold.payInMinor !== null ? Number(cashFold.payInMinor) : 0,
        payOutMinor: cashFold.payOutMinor !== null ? Number(cashFold.payOutMinor) : 0,
        cashEntriesDigest: (evidence.cashEntriesDigest as string) ?? '',
        cashEntriesFullDigest: (evidence.cashEntriesFullDigest as string) ?? '',
        sourceEntryCount: (evidence.sourceEntryCount as number) ?? 0,
        selectedRun: selectedRunResult,
      };
      return result;
    },
    { readOnly: true },
  );
}

// ---------------------------------------------------------------------------
// T3 — selection (Gate 1 / Gate 2 / Gate 3, one flat transaction, never
// nested). Every anomaly branch (missing/invalid alert doc, missing
// selected-run for a recheck) performs ZERO case writes and returns a named
// ANOMALY (BF-6/BF-7) — the Category-D deferral for an anomaly is applied by
// the CALLER (`attemptCase`), in its own ownership-gated transaction, never
// inside T3.
// ---------------------------------------------------------------------------

type T3TxResult =
  | { kind: 'OWNER_MISMATCH'; observedOwner: string | null }
  | { kind: 'STALE_REVISION_RELEASED'; nextEligibleAtMillis: number }
  | { kind: 'RECHECK_EQUAL_DEFERRED'; nextEligibleAtMillis: number }
  | { kind: 'SELECTED' }
  | { kind: 'ANOMALY'; reason: 'missing_alert_doc' | 'alert_invariant' | 'missing_selected_run' | 'run_payload_guard_unfittable' };

/** Pure byte-size baseline + candidate run assembly, reused for the pass-1 guard measurement and the final build (BF-5). */
function assembleCandidateRun(params: {
  shiftId: string;
  branchId: string;
  targetCloseHash: string;
  sourceRevision: number;
  t2: T2Result;
  cashPairHasValueMismatch: boolean;
  perFieldDeltasAllZero: boolean;
  digestComponents: InputsDigestSnapshotComponents;
  sourceManifest: SourceManifest;
  manifestSizeTruncated: boolean;
  sourceManifestFullDigest: string;
  sourceManifestObservedDocsCount: number;
  sourceManifestStoredDocsCount: number;
}): { verdict: VerdictResult; runId: string; fields: Record<string, unknown> } {
  const { shiftId, branchId, targetCloseHash, sourceRevision, t2, cashPairHasValueMismatch, perFieldDeltasAllZero } = params;
  const verdict = decideValidationVerdict({
    evidenceExists: t2.evidenceExists,
    evidenceIdentityMatches: t2.evidenceIdentityMatches,
    legacyMissingRequiredField: t2.legacyMissingRequiredField,
    capReachedAnySource: Object.values(t2.capReachedBySource).some(Boolean),
    cashEntriesOverflowed: t2.cashEntriesOverflowed,
    manifestSizeTruncated: params.manifestSizeTruncated,
    cashEntriesFoldBlockingCount: t2.cashEntriesFoldBlockingCount,
    tenderFoldBlocked: t2.tenderFold.foldBlocked,
    cashPairHasValueMismatch,
    drawerCashVerdict: t2.drawerCashVerdict,
    perFieldDeltasAllZero,
  });
  const errorClassification = verdict.verdict === 'insufficient_evidence' ? verdict.cause : null;
  const inputsDigest = computeInputsDigestAtRevision(params.digestComponents, sourceRevision);
  const { runId, fields } = buildRunFields({
    shiftId,
    branchId,
    closeHash: targetCloseHash,
    sourceRevision,
    validationVerdict: verdict.verdict,
    errorClassification,
    drawerCashVerdict: t2.drawerCashVerdict,
    serverComputedDrawer: t2.serverComputedDrawer,
    perFieldDeltas: t2.perFieldDeltas,
    creditDebtReceiptsObserved: { ...t2.creditDebtReceiptsObserved, observedAsOfSourceRevision: sourceRevision },
    crossDeviceSalesObserved: t2.tenderFold.crossDeviceSalesObserved,
    cashPairClassification: t2.cashPairClassification,
    sourceManifest: params.sourceManifest,
    manifestSizeTruncated: params.manifestSizeTruncated,
    sourceManifestFullDigest: params.sourceManifestFullDigest,
    sourceManifestObservedDocsCount: params.sourceManifestObservedDocsCount,
    sourceManifestStoredDocsCount: params.sourceManifestStoredDocsCount,
    inputsDigest,
  });
  return { verdict, runId, fields };
}

async function runT3(
  firestore: Firestore,
  shiftId: string,
  branchId: string,
  self: string,
  expectedCaseVersion: number,
  targetSourceRevision: number,
  targetCloseHash: string,
  t2: T2Result,
  nowMillis: number,
  isRecheck: boolean,
  selectedRunId: string | null,
  priorProcessingState: ProcessingState,
): Promise<T3TxResult> {
  const caseRef = firestore.collection(CASE_COLLECTION).doc(shiftId);
  const alertRef = firestore.collection(ALERT_COLLECTION).doc(shiftId);

  return firestore.runTransaction(async (tx) => {
    const [caseSnap, alertSnap] = await Promise.all([tx.get(caseRef), tx.get(alertRef)]);
    const caseData = caseSnap.data() as Record<string, unknown>;
    const t3Case: T3CaseSnapshot = {
      leaseOwner: (caseData.leaseOwner as string | null) ?? null,
      caseVersion: caseData.caseVersion as number,
      sourceRevision: caseData.sourceRevision as number,
    };
    const gate = evaluateT3Gates({ case: t3Case, self, expectedCaseVersion, targetSourceRevision });

    if (gate.kind === 'OWNER_MISMATCH') {
      return { kind: 'OWNER_MISMATCH', observedOwner: gate.observedOwner };
    }
    if (gate.kind === 'STALE_REVISION_RELEASED') {
      // BF-3: exact four-field write only — no `updatedAt`.
      tx.update(caseRef, {
        leaseOwner: gate.caseUpdate.leaseOwner,
        leaseExpiry: gate.caseUpdate.leaseExpiryMillis,
        processingState: gate.caseUpdate.processingState,
        caseVersion: gate.caseUpdate.caseVersion,
      });
      // BF-3: the durable deferred outcome carries the case's STORED,
      // UNCHANGED `nextEligibleAt` — never the invocation's `nowMillis`.
      const storedNextEligibleAtMillis = (caseData.nextEligibleAt as Timestamp).toMillis();
      return { kind: 'STALE_REVISION_RELEASED', nextEligibleAtMillis: storedNextEligibleAtMillis };
    }

    // BF-7: a missing alert doc is its own named, zero-write anomaly —
    // never an ordinary exception path.
    if (!alertSnap.exists) {
      console.error('[shiftCloseValidationWorker] worker_anomaly_missing_alert_doc', { shiftId });
      return { kind: 'ANOMALY', reason: 'missing_alert_doc' };
    }

    const alertData = alertSnap.data() as Record<string, unknown>;
    const invariant = validateAlertInvariants(
      { branchId, caseVersion: t3Case.caseVersion, alertState: caseData.alertState as never },
      {
        id: alertSnap.id,
        shiftId: alertData.shiftId as string,
        branchId: alertData.branchId,
        schemaVersion: alertData.schemaVersion,
        caseVersion: alertData.caseVersion,
        alertState: alertData.alertState as never,
        reasonCode: alertData.reasonCode,
        acknowledgedByActor: alertData.acknowledgedByActor,
        resolvedByActor: alertData.resolvedByActor,
        openedAt: alertData.openedAt,
      },
    );
    if (!invariant.ok) {
      // BF-7: zero-write T3 rejection — the ownership-gated Category-D
      // deferral is applied by the CALLER in its own transaction, never here.
      console.error('[shiftCloseValidationWorker] worker_anomaly_alert_invariant', { shiftId, invariant: invariant.violation });
      return { kind: 'ANOMALY', reason: 'alert_invariant' };
    }

    // Manifest source-manifest digest is revision-independent and does not
    // depend on the truncation decision — compute once, reused everywhere.
    const capReachedBySource: SourceManifestCapReachedBySource = t2.capReachedBySource;

    // ── B3/GD9 sweep-recheck comparison (resting-selection admission only) ──
    // BF-6: the selected run was already read in T2 (the frozen read-only
    // snapshot); a missing selected-run doc fails CLOSED (a named,
    // zero-write anomaly) rather than silently falling through to an
    // ordinary fresh selection.
    let effectiveSourceRevision = targetSourceRevision;
    if (isRecheck && selectedRunId !== null) {
      if (!t2.selectedRun || !t2.selectedRun.exists) {
        console.error('[shiftCloseValidationWorker] worker_anomaly_missing_selected_run', { shiftId, selectedRunId });
        return { kind: 'ANOMALY', reason: 'missing_selected_run' };
      }
      // Digest components for the comparison must be computed against the
      // SAME revision-independent inputs the final run would use; the full
      // manifest digest is computed once below and reused for both the
      // comparison and the final build (no re-read either way).
      const comparisonManifestFullDigest = truncateManifestForPayloadGuard(t2.manifestDocs, { sourceManifest: { docs: [] } }).sourceManifestFullDigest;
      const comparisonDigestComponents: InputsDigestSnapshotComponents = {
        tenderFold: t2.tenderFold,
        payInMinor: t2.payInMinor,
        payOutMinor: t2.payOutMinor,
        creditDebtReceiptsObserved: t2.creditDebtReceiptsObserved,
        sourceManifestFullDigest: comparisonManifestFullDigest,
        cashEntriesDigest: t2.cashEntriesDigest,
        cashEntriesFullDigest: t2.cashEntriesFullDigest,
        sourceEntryCount: t2.sourceEntryCount,
      };
      const candidateDigest = computeInputsDigestAtRevision(comparisonDigestComponents, targetSourceRevision);
      const comparison = compareRecheckDigest({
        candidateDigest,
        selectedRunInputsDigest: t2.selectedRun.inputsDigest ?? '',
        currentSourceRevision: targetSourceRevision,
      });
      if (comparison.kind === 'equal') {
        // EQUAL PATH (B3 §11.1): no run, no sourceRevision bump, no audit;
        // selection fully preserved (BF-6: including processingState, which
        // is restored to its PRE-T1 value, never forced to 'validated');
        // release lease; defer 24h (GD9).
        const equalUpdate = buildRecheckEqualCaseUpdate({
          currentCaseVersion: t3Case.caseVersion,
          lateEventHorizonUntilMillis: (caseData.lateEventHorizonUntil as Timestamp).toMillis(),
          nowMillis,
          priorProcessingState,
        });
        tx.update(caseRef, { ...toFirestoreCaseUpdate(equalUpdate), updatedAt: FieldValue.serverTimestamp() });
        console.warn('[shiftCloseValidationWorker] sweep_recheck_noop', { shiftId });
        return { kind: 'RECHECK_EQUAL_DEFERRED', nextEligibleAtMillis: equalUpdate.nextEligibleAtMillis as number };
      }
      // DIFFERENT PATH (B3 §11.1): bump R->R+1; every revision-bearing value
      // below is recomputed in memory at R+1 — no Firestore re-read.
      effectiveSourceRevision = comparison.nextSourceRevision;
      console.warn('[shiftCloseValidationWorker] sweep_recheck_new_revision', { shiftId, newSourceRevision: effectiveSourceRevision });
    }

    // ── Normal selection (Gate 3), driven by effectiveSourceRevision ────────
    const cashPairHasValueMismatch = t2.cashPairClassification.some((c) => c.class === 'paired_value_mismatch');
    const perFieldDeltasAllZero = Object.values(t2.perFieldDeltas).every((v) => v === 0);

    // BF-5: the source-manifest full digest is revision- AND truncation-
    // independent (a pure function of the observed docs only) — compute the
    // REAL 64-character digest once, up front, so no baseline pass below
    // ever measures a placeholder string.
    const realFullDigest = truncateManifestForPayloadGuard(t2.manifestDocs, {}).sourceManifestFullDigest;

    function assembleFinal(manifestSizeTruncatedFlag: boolean, storedDocs: readonly SourceManifestDoc[], observedCount: number, storedCount: number) {
      const sourceManifest = buildSourceManifest({
        storedDocs,
        capReachedBySource,
        manifestSizeTruncated: manifestSizeTruncatedFlag,
        computedAtCommitMicros: t2.computedAtCommitMicros,
      });
      const digestComponents: InputsDigestSnapshotComponents = {
        tenderFold: t2.tenderFold,
        payInMinor: t2.payInMinor,
        payOutMinor: t2.payOutMinor,
        creditDebtReceiptsObserved: t2.creditDebtReceiptsObserved,
        sourceManifestFullDigest: realFullDigest,
        cashEntriesDigest: t2.cashEntriesDigest,
        cashEntriesFullDigest: t2.cashEntriesFullDigest,
        sourceEntryCount: t2.sourceEntryCount,
      };
      return assembleCandidateRun({
        shiftId,
        branchId,
        targetCloseHash,
        sourceRevision: effectiveSourceRevision,
        t2,
        cashPairHasValueMismatch,
        perFieldDeltasAllZero,
        digestComponents,
        sourceManifest,
        manifestSizeTruncated: manifestSizeTruncatedFlag,
        sourceManifestFullDigest: realFullDigest,
        sourceManifestObservedDocsCount: observedCount,
        sourceManifestStoredDocsCount: storedCount,
      });
    }

    // BF-5 (exact final-map trimming, R3; count-cap/byte-size decoupling,
    // R4): find the LONGEST canonical-order doc prefix whose FULLY
    // ASSEMBLED, ACTUALLY-MEASURED final run field map fits within the
    // frozen 786,432-byte guard — never a stale/undercounted baseline.
    // `measureAt(k)` reassembles the complete candidate run (real verdict,
    // real digest, real stored/observed counts) at prefix length `k` and
    // measures its true serialized size every time, so the stored-count
    // byte delta Codex flagged can never be missed.
    //
    // `capReachedBySource` (an observed SOURCE-QUERY COUNT-CAP fact) and
    // `manifestSizeTruncated` (a BYTE-PREFLIGHT fact) are independent
    // dimensions (governing architecture, first remediation addendum
    // §10.1-§10.2): a count-cap-only run whose full observed-doc field map
    // still fits under the guard must be written with ALL observed docs
    // retained and `manifestSizeTruncated:false` — `sourceManifest.
    // truncated` alone (computed in `buildSourceManifest` as
    // `anyCapReached || manifestSizeTruncated`) carries the count-cap fact
    // forward. R4 fix: the full observed-doc candidate is now ALWAYS
    // measured first, regardless of any count-cap flag — never skipped
    // just because a source hit its count cap.
    //
    // Monotonicity care: size is monotonic non-decreasing in `k` ONLY once
    // `manifestSizeTruncated` is fixed (it never flips back to false once
    // true). Between the fully-untruncated shape (k==N, truncated:false)
    // and any truncated shape (k<N, truncated:true), the verdict/
    // errorClassification strings can grow even as the doc array shrinks —
    // a real non-monotonic jump at that one boundary. So: first check the
    // fully-untruncated case on its own; only if that does not fit does the
    // search enter the truncated shape, where it is monotonic throughout
    // and a binary search over prefix length is safe and exact.
    const orderedManifestDocs = orderManifestDocs(t2.manifestDocs);
    const observedDocsCount = orderedManifestDocs.length;

    function measureAt(k: number, truncatedFlag: boolean): { candidate: ReturnType<typeof assembleFinal>; bytes: number } {
      const storedDocs = orderedManifestDocs.slice(0, k);
      const candidate = assembleFinal(truncatedFlag, storedDocs, observedDocsCount, storedDocs.length);
      return { candidate, bytes: Buffer.byteLength(JSON.stringify(candidate.fields), 'utf8') };
    }

    let final: ReturnType<typeof assembleFinal> | null = null;

    const untruncated = measureAt(observedDocsCount, false);
    if (untruncated.bytes <= RUN_PAYLOAD_GUARD_BYTES) {
      final = untruncated.candidate;
    }

    if (final === null) {
      // Truncated shape is fixed from here on (`manifestSizeTruncated:true`
      // for every candidate k below) -> strictly monotonic in k -> binary
      // search for the LARGEST fitting prefix is exact and safe.
      const zeroDocs = measureAt(0, true);
      if (zeroDocs.bytes > RUN_PAYLOAD_GUARD_BYTES) {
        // BF-5: even the empty-doc final map exceeds the guard — FAIL
        // CLOSED. Do not `tx.create` an oversized run; zero-write T3
        // rejection, routed through the same named-anomaly + ownership-
        // gated Category-D deferral path as every other T3 anomaly.
        console.error('[shiftCloseValidationWorker] worker_anomaly_run_payload_guard_unfittable', { shiftId, zeroDocsBytes: zeroDocs.bytes });
        return { kind: 'ANOMALY', reason: 'run_payload_guard_unfittable' };
      }
      let lo = 0;
      let hi = observedDocsCount;
      let bestK = 0;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (measureAt(mid, true).bytes <= RUN_PAYLOAD_GUARD_BYTES) {
          bestK = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      final = measureAt(bestK, true).candidate;
    }

    const priorAlertState = (caseData.alertState as never) ?? 'none';
    const runVerdictInput =
      final.verdict.verdict === 'match'
        ? { verdict: 'match' as const, prior: { alertState: priorAlertState, acknowledgedByActor: (alertData.acknowledgedByActor as never) ?? null } }
        : final.verdict.verdict === 'insufficient_evidence'
          ? { verdict: 'insufficient_evidence' as const, cause: final.verdict.cause }
          : { verdict: final.verdict.verdict };
    const transition = computeRunTransition(runVerdictInput as never);

    const runRef = firestore.collection(RUN_COLLECTION).doc(final.runId);
    tx.create(runRef, { ...final.fields, createdAt: FieldValue.serverTimestamp() });

    const priorSelectedRunId = (caseData.selectedRunId as string | null) ?? null;
    const newCaseVersion = t3Case.caseVersion + 1;

    const runSelectedAuditId = computeP5DAuditEventId({ shiftId, eventKey: final.runId, transitionType: 'run_selected', targetCaseVersion: newCaseVersion });
    tx.create(firestore.collection(AUDIT_COLLECTION).doc(runSelectedAuditId), {
      eventId: runSelectedAuditId,
      shiftId,
      caseVersion: newCaseVersion,
      runId: final.runId,
      transitionType: 'run_selected',
      actor: { kind: 'system' },
      reasonCode: null,
      note: null,
      branchId,
      schemaVersion: 1,
      createdAt: FieldValue.serverTimestamp(),
    });

    if (priorSelectedRunId !== null) {
      const supersededId = computeP5DAuditEventId({ shiftId, eventKey: final.runId, transitionType: 'superseded', targetCaseVersion: newCaseVersion });
      tx.create(firestore.collection(AUDIT_COLLECTION).doc(supersededId), {
        eventId: supersededId,
        shiftId,
        caseVersion: newCaseVersion,
        runId: final.runId,
        transitionType: 'superseded',
        actor: { kind: 'system' },
        reasonCode: null,
        note: null,
        branchId,
        schemaVersion: 1,
        oldRunId: priorSelectedRunId,
        newRunId: final.runId,
        oldCaseVersion: t3Case.caseVersion,
        newCaseVersion,
        oldAlertState: priorAlertState,
        newAlertState: transition.alert.alertState,
        transitionReason: 'newer_source_revision',
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    // BF-7: the audit rule is a pure function of the NEW alert state — every
    // selection landing on 'open' gets `alert_opened` (incl. open->open
    // refresh and resolved->open), every selection landing on 'resolved'
    // gets `alert_resolved`; 'none' gets neither. NOT gated on "did the
    // state change" (that gate silently dropped the open->open refresh
    // audit — the exact BF-7 defect).
    if (transition.alert.alertState === 'open' || transition.alert.alertState === 'resolved') {
      const eventId = computeP5DAuditEventId({
        shiftId,
        eventKey: final.runId,
        transitionType: transition.alert.alertState === 'open' ? 'alert_opened' : 'alert_resolved',
        targetCaseVersion: newCaseVersion,
      });
      tx.create(firestore.collection(AUDIT_COLLECTION).doc(eventId), {
        eventId,
        shiftId,
        caseVersion: newCaseVersion,
        runId: final.runId,
        transitionType: transition.alert.alertState === 'open' ? 'alert_opened' : 'alert_resolved',
        actor: { kind: 'system' },
        reasonCode: transition.alert.reasonCode,
        note: null,
        branchId,
        schemaVersion: 1,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    const caseUpdate = buildSelectionCaseUpdate({
      runId: final.runId,
      closeHash: targetCloseHash,
      sourceRevision: effectiveSourceRevision,
      priorSelectedRunId,
      processingState: transition.processingState,
      settlementState: transition.settlementState,
      alertState: transition.alert.alertState,
      computedAtCommitMicros: t2.computedAtCommitMicros,
      currentLastObservedCommitMicros: (caseData.lastObservedCommitMicros as string) ?? '0',
      commitBoundaryDocKeys: t2.commitBoundaryDocKeys,
      currentCaseVersion: t3Case.caseVersion,
      lateEventHorizonUntilMillis: (caseData.lateEventHorizonUntil as Timestamp).toMillis(),
      nowMillis,
    });
    tx.update(caseRef, { ...toFirestoreCaseUpdate(caseUpdate), updatedAt: FieldValue.serverTimestamp() });

    const openedAtWrite = computeOpenedAtWrite(transition.alert.alertState);
    tx.update(alertRef, {
      alertState: transition.alert.alertState,
      reasonCode: transition.alert.reasonCode,
      acknowledgedByActor: transition.alert.acknowledgedByActor,
      resolvedByActor: transition.alert.resolvedByActor,
      openedAt:
        openedAtWrite.kind === 'fresh' ? FieldValue.serverTimestamp() : openedAtWrite.kind === 'clear' ? null : alertData.openedAt,
      caseVersion: newCaseVersion,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { kind: 'SELECTED' };
  });
}

// ---------------------------------------------------------------------------
// Ownership-gated failure/anomaly deferral — a SEPARATE small transaction
// from T1/T2/T3, reused for: T2/T3 thrown-error handling, AND (BF-7) the
// zero-write T3 anomaly follow-up. Reports the owner-mismatch case
// explicitly rather than silently returning a fabricated deferred outcome
// (BF-1).
// ---------------------------------------------------------------------------

type FailureOutcomeResult =
  | { kind: 'owner_mismatch'; observedOwner: string | null }
  | { kind: 'deferred'; nextEligibleAtMillis: number }
  /** Legitimate zero-write no-op: budget stop (category B), or the case doc no longer exists. Own-head, cacheable-as-consumed (BF-2). */
  | { kind: 'no_write' }
  /** BF-8: the deferral transaction itself failed to COMMIT (thrown/caught below) — NOT a legitimate no-op. Must never be treated as own-head consumption: no durable outcome, no cache, no cursor advance. */
  | { kind: 'commit_failed' };

type ApplyFailureTxResult =
  | { kind: 'owner_mismatch'; observedOwner: string | null }
  | { kind: 'no_write' }
  | { kind: 'A'; nextEligibleAtMillis: number; attempts: number }
  | { kind: 'D'; nextEligibleAtMillis: number };

/**
 * BF-4: the WHOLE transaction is wrapped so a commit failure (e.g. the
 * Category-D deferral write itself failing) is caught and diagnosed as
 * `case_defer_write_failed {shiftId, code}` — never left to escape uncaught
 * (which would crash the invocation) and never logged as though the write
 * had succeeded. Every success diagnostic (`case_attempt_transient`,
 * `case_attempt_error_permanent`) is logged strictly AFTER the transaction
 * resolves, mirroring Q7's post-commit-only logging discipline.
 */
async function applyFailureOutcome(
  firestore: Firestore,
  shiftId: string,
  self: string,
  category: 'A' | 'B' | 'D',
  nowMillis: number,
): Promise<FailureOutcomeResult> {
  if (category === 'B') return { kind: 'no_write' }; // budget stop: zero writes, non-counting.
  const caseRef = firestore.collection(CASE_COLLECTION).doc(shiftId);

  let txResult: ApplyFailureTxResult;
  try {
    txResult = await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(caseRef);
      if (!snap.exists) return { kind: 'no_write' };
      const data = snap.data() as Record<string, unknown>;
      if (data.leaseOwner !== self) {
        // BF-1: report the mismatch to the caller — never silently return
        // a fabricated deferred outcome. Zero writes here (Option A).
        return { kind: 'owner_mismatch', observedOwner: (data.leaseOwner as string | null) ?? null };
      }
      const currentCaseVersion = data.caseVersion as number;
      if (category === 'A') {
        const outcome = buildCategoryAOutcome({ currentCaseVersion, attemptsBefore: (data.revalidationAttempts as number) ?? 0, nowMillis });
        tx.update(caseRef, { ...toFirestoreCaseUpdate(outcome.caseUpdate), updatedAt: FieldValue.serverTimestamp() });
        if (outcome.alertTransition) {
          const alertRef = firestore.collection(ALERT_COLLECTION).doc(shiftId);
          const openedAtWrite = computeOpenedAtWrite(outcome.alertTransition.projection.alertState);
          tx.update(alertRef, {
            alertState: outcome.alertTransition.projection.alertState,
            reasonCode: outcome.alertTransition.projection.reasonCode,
            acknowledgedByActor: outcome.alertTransition.projection.acknowledgedByActor,
            resolvedByActor: outcome.alertTransition.projection.resolvedByActor,
            openedAt: openedAtWrite.kind === 'fresh' ? FieldValue.serverTimestamp() : openedAtWrite.kind === 'clear' ? null : FieldValue.delete(),
            caseVersion: currentCaseVersion + 1,
            updatedAt: FieldValue.serverTimestamp(),
          });
          // BF-7: retry exhaustion must ALSO emit the required alert_opened audit.
          const eventId = computeP5DAuditEventId({
            shiftId,
            eventKey: shiftId,
            transitionType: 'alert_opened',
            targetCaseVersion: currentCaseVersion + 1,
          });
          tx.create(firestore.collection(AUDIT_COLLECTION).doc(eventId), {
            eventId,
            shiftId,
            caseVersion: currentCaseVersion + 1,
            runId: null,
            transitionType: 'alert_opened',
            actor: { kind: 'system' },
            reasonCode: outcome.alertTransition.reasonCode,
            note: null,
            branchId: (data.branchId as string) ?? null,
            schemaVersion: 1,
            createdAt: FieldValue.serverTimestamp(),
          });
        }
        return { kind: 'A', nextEligibleAtMillis: outcome.caseUpdate.nextEligibleAtMillis as number, attempts: outcome.caseUpdate.revalidationAttempts as number };
      }
      const outcome = buildCategoryDOutcome({ currentCaseVersion, nowMillis });
      tx.update(caseRef, { ...toFirestoreCaseUpdate(outcome.caseUpdate), updatedAt: FieldValue.serverTimestamp() });
      return { kind: 'D', nextEligibleAtMillis: outcome.caseUpdate.nextEligibleAtMillis as number };
    });
  } catch (err) {
    // BF-4/BF-8: the deferral write itself failed to commit — truthful,
    // dedicated diagnostic; never mislabeled as an ordinary permanent-attempt
    // success, and (BF-8, R3) never mapped to the legitimate `no_write`
    // own-head no-op either. A failed commit proved NOTHING durable — the
    // caller must treat this as no_progress (stream stop, no cursor
    // advance), not as own-head consumption.
    console.error('[shiftCloseValidationWorker] case_defer_write_failed', { shiftId, code: describeErrorCode(err) });
    return { kind: 'commit_failed' };
  }

  if (txResult.kind === 'owner_mismatch' || txResult.kind === 'no_write') return txResult;
  if (txResult.kind === 'A') {
    console.warn('[shiftCloseValidationWorker] case_attempt_transient', { shiftId, attempts: txResult.attempts });
    return { kind: 'deferred', nextEligibleAtMillis: txResult.nextEligibleAtMillis };
  }
  console.error('[shiftCloseValidationWorker] case_attempt_error_permanent', { shiftId });
  return { kind: 'deferred', nextEligibleAtMillis: txResult.nextEligibleAtMillis };
}

// ---------------------------------------------------------------------------
// Q7 — expired-lease recovery, invocation start. Exact frozen action list
// only (BF-4): no `updatedAt`. Success is logged only AFTER the transaction
// commits (never from inside the retryable callback). Failures are
// classified truthfully via the shared Firestore-error classifier — never a
// blanket "CAS lost" label.
// ---------------------------------------------------------------------------

async function runQ7(firestore: Firestore, nowMillis: number): Promise<void> {
  const query = firestore
    .collection(CASE_COLLECTION)
    .where('processingState', '==', 'validating')
    .where('leaseExpiry', '<=', Timestamp.fromMillis(nowMillis))
    .orderBy('leaseExpiry')
    .limit(25);
  const snap = await query.get();
  for (const doc of snap.docs) {
    const caseRef = doc.ref;
    try {
      const recovered = await firestore.runTransaction(async (tx) => {
        const fresh = await tx.get(caseRef);
        if (!fresh.exists) return null;
        const data = fresh.data() as Record<string, unknown>;
        const leaseExpiry = data.leaseExpiry as Timestamp | null;
        const snapshot: Q7CaseSnapshot = {
          processingState: data.processingState as string,
          leaseOwner: (data.leaseOwner as string | null) ?? null,
          leaseExpiryMillis: leaseExpiry ? leaseExpiry.toMillis() : null,
          caseVersion: data.caseVersion as number,
        };
        const decision = decideQ7Recovery({ case: snapshot, nowMillis });
        if (decision.kind !== 'recover') return null;
        // BF-4: exact frozen action list only — no `updatedAt`.
        tx.update(caseRef, {
          leaseOwner: decision.caseUpdate.leaseOwner,
          leaseExpiry: decision.caseUpdate.leaseExpiryMillis,
          processingState: decision.caseUpdate.processingState,
          caseVersion: decision.caseUpdate.caseVersion,
        });
        return { priorOwner: snapshot.leaseOwner };
      });
      // BF-4: log success only AFTER the transaction has durably committed;
      // include the frozen `recoveredAt`/`class` fields.
      if (recovered) {
        console.warn('[shiftCloseValidationWorker] lease_recovered', {
          shiftId: doc.id,
          priorOwner: recovered.priorOwner,
          recoveredAt: nowMillis,
          class: 'expired_lease',
        });
      }
    } catch (err) {
      // BF-4: classify truthfully — only the specific ABORTED contention
      // signal is CAS loss; deadline-exceeded/resource-exhausted/unavailable
      // are non-CAS transient failures with their own truthful diagnostic,
      // and everything else is permanent/local/unknown.
      if (isCasContentionError(err)) {
        console.warn('[shiftCloseValidationWorker] lease_recovery_cas_lost', { shiftId: doc.id, code: describeErrorCode(err) });
      } else if (isRetryableFirestoreError(err)) {
        console.warn('[shiftCloseValidationWorker] lease_recovery_transient', { shiftId: doc.id, code: describeErrorCode(err) });
      } else {
        console.error('[shiftCloseValidationWorker] lease_recovery_error_permanent', { shiftId: doc.id, code: describeErrorCode(err) });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-case attempt orchestration (T1 -> T2 -> T3), returning a
// CaseAttemptResult or throwing StopStreamUnowned (Gate 1). This is the
// async work resolved BEFORE `stepStream` is ever called — see
// `drainOneStep` below, which never passes an unresolved Promise into
// `stepStream`'s synchronous `process`.
// ---------------------------------------------------------------------------

type CaseAttemptResult =
  | { kind: 'durable'; outcome: DurableOutcome }
  /** own-head consumption, no cache (T1 skip/not-admissible) — BF-2. */
  | { kind: 'own_head_no_cache' }
  /** no progress at all this attempt (T1 pre-commit failure) — the stream must stop so this row is not retried in a tight loop within the same invocation. */
  | { kind: 'no_progress' };

async function attemptCase(firestore: Firestore, shiftId: string, invocationId: string, streamId: string, nowMillis: number): Promise<CaseAttemptResult> {
  const t1 = await runT1(firestore, shiftId, invocationId, nowMillis);
  if (t1.kind === 'own_head_no_cache') return { kind: 'own_head_no_cache' };
  if (t1.kind === 'no_progress') return { kind: 'no_progress' };
  const acquired = t1.result;

  let t2: T2Result;
  try {
    t2 = await runT2({
      firestore,
      shiftId,
      branchId: acquired.branchId,
      staffId: acquired.staffId,
      deviceId: acquired.deviceId,
      caseSchemaVersion: acquired.caseSchemaVersion,
      latestEvidenceId: acquired.latestEvidenceId,
      caseStoredShiftId: acquired.caseStoredShiftId,
      targetCloseHash: acquired.targetCloseHash,
      targetSourceRevision: acquired.targetSourceRevision,
      isRecheck: acquired.isRecheck,
      selectedRunId: acquired.selectedRunId,
    });
  } catch (err) {
    return handleFailure(firestore, shiftId, invocationId, streamId, classifyWorkerFailure(err, false), nowMillis);
  }

  let t3: T3TxResult;
  try {
    t3 = await runT3(
      firestore,
      shiftId,
      acquired.branchId,
      invocationId,
      acquired.expectedCaseVersion,
      acquired.targetSourceRevision,
      acquired.targetCloseHash,
      t2,
      nowMillis,
      acquired.isRecheck,
      acquired.selectedRunId,
      acquired.priorProcessingState,
    );
  } catch (err) {
    return handleFailure(firestore, shiftId, invocationId, streamId, classifyWorkerFailure(err, false), nowMillis);
  }

  if (t3.kind === 'OWNER_MISMATCH') {
    console.warn('[shiftCloseValidationWorker] stale_worker_owner_mismatch', {
      shiftId,
      streamId,
      expectedOwner: invocationId,
      observedOwner: t3.observedOwner,
      targetSourceRevision: acquired.targetSourceRevision,
      class: 'stale_worker_discard',
    });
    throw new StopStreamUnowned(streamId, shiftId, t3.observedOwner);
  }
  if (t3.kind === 'STALE_REVISION_RELEASED') {
    return { kind: 'durable', outcome: { kind: 'deferred', nextEligibleAt: t3.nextEligibleAtMillis } };
  }
  if (t3.kind === 'RECHECK_EQUAL_DEFERRED') {
    // A real durable case write (B3 EQUAL PATH) — selection preserved, GD9
    // 24h defer. Correctly cacheable and cursor-advancing (unlike Gate 1).
    return { kind: 'durable', outcome: { kind: 'deferred', nextEligibleAt: t3.nextEligibleAtMillis } };
  }
  if (t3.kind === 'ANOMALY') {
    // BF-6/BF-7: zero T3 writes occurred; apply the ownership-gated
    // Category-D deferral now, in a separate transaction.
    return handleFailure(firestore, shiftId, invocationId, streamId, 'D', nowMillis);
  }
  return { kind: 'durable', outcome: { kind: 'completed' } };
}

/** Shared failure/anomaly -> CaseAttemptResult mapping, used by every T2/T3 catch site and the T3 ANOMALY branch. */
async function handleFailure(
  firestore: Firestore,
  shiftId: string,
  invocationId: string,
  streamId: string,
  category: 'A' | 'B' | 'D',
  nowMillis: number,
): Promise<CaseAttemptResult> {
  const result = await applyFailureOutcome(firestore, shiftId, invocationId, category, nowMillis);
  if (result.kind === 'owner_mismatch') {
    console.warn('[shiftCloseValidationWorker] stale_worker_owner_mismatch', { shiftId, streamId, expectedOwner: invocationId, observedOwner: result.observedOwner });
    throw new StopStreamUnowned(streamId, shiftId, result.observedOwner);
  }
  if (result.kind === 'no_write') return { kind: 'own_head_no_cache' };
  // BF-8 (R3): a failed deferral COMMIT is not own-head consumption — no
  // durable outcome, no cache entry, no cursor advance for this stream this
  // invocation. The `case_defer_write_failed` diagnostic was already logged
  // truthfully inside `applyFailureOutcome`'s catch block.
  if (result.kind === 'commit_failed') return { kind: 'no_progress' };
  return { kind: 'durable', outcome: { kind: 'deferred', nextEligibleAt: result.nextEligibleAtMillis } };
}

// ---------------------------------------------------------------------------
// Stream drain — synchronous adapter boundary. `process` passed into
// `stepStream` is ALWAYS a resolved closure (`() => outcome`); the async
// T1->T2->T3 work is awaited BEFORE `stepStream` is called. `own_head_no_cache`
// bypasses `stepStream` entirely (it has no representation for "advance
// without caching") and advances the LOCAL cursor variable directly.
// ---------------------------------------------------------------------------

function findNextEligibleIndex(order: StreamOrder, cursor: StreamCursor, isEligible: (id: CaseId) => boolean): number {
  let index = cursor.lastConsumedCaseId === null ? 0 : order.orderedCaseIds.indexOf(cursor.lastConsumedCaseId) + 1;
  if (index < 0) index = 0;
  while (index < order.orderedCaseIds.length && !isEligible(order.orderedCaseIds[index])) index += 1;
  return index;
}

interface DrainStepOutcome {
  cursor: StreamCursor;
  /** Gate-1 stop (own-head unchanged) OR a pre-commit T1 failure (own-head unchanged) — either way, stop draining this stream for the rest of the invocation. */
  stopped: boolean;
}

async function drainOneStep(params: {
  streamId: string;
  order: StreamOrder;
  cursor: StreamCursor;
  isEligible: (id: CaseId) => boolean;
  cache: InvocationResultCache;
  budgetAvailable: boolean;
  invocationId: string;
  nowMillis: number;
  firestore: Firestore;
}): Promise<DrainStepOutcome> {
  const { streamId, order, cursor, isEligible, cache, budgetAvailable, invocationId, nowMillis, firestore } = params;

  if (!budgetAvailable) {
    const result = stepStream({ order, cursor, eligibility: { isEligible }, cache, budgetAvailable: false, process: () => ({ kind: 'completed' }) });
    return { cursor: result.cursor, stopped: false };
  }

  const index = findNextEligibleIndex(order, cursor, isEligible);
  if (index >= order.orderedCaseIds.length || cache.has(order.orderedCaseIds[index])) {
    // Exhaustion or cache-hit — no async work needed; `process` is never invoked on this path.
    const result = stepStream({
      order,
      cursor,
      eligibility: { isEligible },
      cache,
      budgetAvailable: true,
      process: () => {
        throw new Error('unreachable: process invoked on an exhausted/cache-hit step');
      },
    });
    return { cursor: result.cursor, stopped: false };
  }

  const caseId = order.orderedCaseIds[index];
  try {
    const attemptResult = await attemptCase(firestore, caseId, invocationId, streamId, nowMillis);
    if (attemptResult.kind === 'durable') {
      const result = stepStream({ order, cursor, eligibility: { isEligible }, cache, budgetAvailable: true, process: () => attemptResult.outcome });
      return { cursor: result.cursor, stopped: false };
    }
    if (attemptResult.kind === 'own_head_no_cache') {
      // Own-head consumption WITHOUT caching: `stepStream` has no
      // "advance but don't cache" mode, so this path bypasses it entirely
      // and advances the cursor directly (accepted `skipped_leased` rule).
      return { cursor: { lastConsumedCaseId: caseId }, stopped: false };
    }
    // 'no_progress' — nothing durable happened; leave the cursor exactly
    // where it is and stop this stream for the rest of the invocation so a
    // persistently-failing acquisition cannot spin in a tight retry loop.
    return { cursor, stopped: true };
  } catch (err) {
    if (err instanceof StopStreamUnowned) {
      // Gate-1 cursor/durability contract: no DurableOutcome, no cache entry, no
      // cursor advance — the stream simply stops for the rest of this invocation.
      return { cursor, stopped: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cursor persistence — create-once (transactional `tx.create`, fails if
// already exists) and CAS-checked updates (transactional, verifies the
// `casVersion` read at load time is still current before writing; a stale
// write is skipped and logged, never silently overwritten) (BF-8). Carries
// the compound `(lastNextEligibleAt, lastShiftId)` continuation cursor the
// frozen `(nextEligibleAt, __name__)` ordering requires, so the NEXT
// invocation's query genuinely resumes via `startAfter` instead of always
// re-fetching the same head page.
// ---------------------------------------------------------------------------

interface CursorDoc {
  cycleId: string;
  cycleStartedAtMillis: number;
  casVersion: number;
  /** Firestore-level pagination continuation — null at cycle start. */
  lastNextEligibleAtMillis: number | null;
  lastShiftId: string | null;
}

async function loadOrInitCursor(firestore: Firestore, streamKind: 'trigger' | 'sweep', nowMillis: number): Promise<CursorDoc> {
  const ref = firestore.collection(CURSOR_COLLECTION).doc(streamKind);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const d = snap.data() as Record<string, unknown>;
      if (d.cycleComplete === true) {
        // Fresh cycle at THIS invocation's own clock (cursor cycle-rollover,
        // unchanged from the prior remediation) — no query continuation yet.
        return { cycleId: randomUUID(), cycleStartedAtMillis: nowMillis, casVersion: (d.casVersion as number) ?? 0, lastNextEligibleAtMillis: null, lastShiftId: null };
      }
      const lastNextEligibleAt = d.lastNextEligibleAt as Timestamp | null;
      return {
        cycleId: d.cycleId as string,
        cycleStartedAtMillis: (d.cycleStartedAt as Timestamp).toMillis(),
        casVersion: (d.casVersion as number) ?? 0,
        lastNextEligibleAtMillis: lastNextEligibleAt ? lastNextEligibleAt.toMillis() : null,
        lastShiftId: (d.lastShiftId as string | null) ?? null,
      };
    }
    // BF-8: create-once — `tx.create` throws if another invocation created
    // this doc concurrently; Firestore retries the transaction, and the
    // retry's `snap.exists` branch above takes over.
    const cycleId = randomUUID();
    tx.create(ref, {
      schemaVersion: 1,
      streamKind,
      cycleId,
      cycleStartedAt: Timestamp.fromMillis(nowMillis),
      cycleComplete: false,
      invocationsThisCycle: 0,
      lastNextEligibleAt: null,
      lastShiftId: null,
      casVersion: 0,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { cycleId, cycleStartedAtMillis: nowMillis, casVersion: 0, lastNextEligibleAtMillis: null, lastShiftId: null };
  });
}

/**
 * Persists a stream's cursor at the end of an invocation. CAS-checked: if
 * the persisted `casVersion` no longer matches what this invocation loaded,
 * the write is skipped (another invocation already advanced this stream) —
 * never silently overwritten (BF-8). `cycleComplete` must be true ONLY on
 * genuine full-cycle exhaustion (no Gate-1 stop, no budget stop with
 * unprocessed rows, AND the fetched batch was smaller than the page limit —
 * i.e. there is provably nothing left in this cycle, not just this page).
 */
async function persistCursor(
  firestore: Firestore,
  streamKind: 'trigger' | 'sweep',
  doc: CursorDoc,
  update: { lastNextEligibleAtMillis: number | null; lastShiftId: string | null },
  cycleComplete: boolean,
): Promise<void> {
  const ref = firestore.collection(CURSOR_COLLECTION).doc(streamKind);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return; // defensive: loadOrInitCursor always creates first.
    const current = snap.data() as Record<string, unknown>;
    if (((current.casVersion as number) ?? 0) !== doc.casVersion) {
      console.warn('[shiftCloseValidationWorker] cursor_cas_lost', { streamKind });
      return;
    }
    tx.update(ref, {
      cycleId: doc.cycleId,
      cycleStartedAt: Timestamp.fromMillis(doc.cycleStartedAtMillis),
      cycleComplete,
      lastNextEligibleAt: cycleComplete || update.lastNextEligibleAtMillis === null ? null : Timestamp.fromMillis(update.lastNextEligibleAtMillis),
      lastShiftId: cycleComplete ? null : update.lastShiftId,
      casVersion: doc.casVersion + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

// ---------------------------------------------------------------------------
// Top-level scheduled handler.
// ---------------------------------------------------------------------------

export interface RunValidationSweepDeps {
  firestore: Firestore;
  nowMillis: number;
  invocationId: string;
}

interface StreamFetch {
  order: StreamOrder;
  eligible: Set<string>;
  nextEligibleAtById: Map<string, number>;
  /** True iff the fetch returned fewer rows than the page limit — i.e. there is provably nothing more in this cycle beyond this page. */
  isLastPage: boolean;
}

async function fetchStream(
  firestore: Firestore,
  field: 'pendingRevalidation' | 'sweepEligible',
  cycleStartedAtMillis: number,
  lastNextEligibleAtMillis: number | null,
  lastShiftId: string | null,
): Promise<StreamFetch> {
  const PAGE_LIMIT = 25;
  let query = firestore
    .collection(CASE_COLLECTION)
    .where(field, '==', true)
    .where('nextEligibleAt', '<=', Timestamp.fromMillis(cycleStartedAtMillis))
    .orderBy('nextEligibleAt')
    .orderBy(FieldPath.documentId())
    .limit(PAGE_LIMIT);
  if (lastNextEligibleAtMillis !== null) {
    query = query.startAfter(Timestamp.fromMillis(lastNextEligibleAtMillis), lastShiftId);
  }
  const snap = await query.get();
  const nextEligibleAtById = new Map<string, number>();
  for (const doc of snap.docs) {
    const v = doc.get('nextEligibleAt') as Timestamp;
    nextEligibleAtById.set(doc.id, v.toMillis());
  }
  const orderedCaseIds = snap.docs.map((d) => d.id);
  return { order: { orderedCaseIds }, eligible: new Set(orderedCaseIds), nextEligibleAtById, isLastPage: snap.docs.length < PAGE_LIMIT };
}

/** Extracted, exported handler body — unit-testable without an emulator (mirrors `captureOnWrite`'s pattern). */
export async function runValidationSweep(deps: RunValidationSweepDeps): Promise<void> {
  const { firestore, nowMillis, invocationId } = deps;

  await runQ7(firestore, nowMillis);

  const triggerCursorDoc = await loadOrInitCursor(firestore, 'trigger', nowMillis);
  const sweepCursorDoc = await loadOrInitCursor(firestore, 'sweep', nowMillis);

  const triggerFetch = await fetchStream(firestore, 'pendingRevalidation', triggerCursorDoc.cycleStartedAtMillis, triggerCursorDoc.lastNextEligibleAtMillis, triggerCursorDoc.lastShiftId);
  const sweepFetch = await fetchStream(firestore, 'sweepEligible', sweepCursorDoc.cycleStartedAtMillis, sweepCursorDoc.lastNextEligibleAtMillis, sweepCursorDoc.lastShiftId);

  const cache = createInvocationResultCache();
  // Within-invocation stepping always starts at the top of the JUST-FETCHED
  // page (Firestore-level `startAfter` already positioned the fetch at the
  // correct continuation point) — the persisted compound cursor is what
  // carries position ACROSS invocations, not this in-memory `StreamCursor`.
  let triggerCursor = initialStreamCursor();
  let sweepCursor = initialStreamCursor();
  let consumedReads = 0;
  let admittedCases = 0;
  let triggerStopped = false;
  let sweepStopped = false;

  for (;;) {
    const triggerBudget = canAdmitAnotherCase({ consumedReads, admittedCases });
    if (!triggerStopped) {
      const step = await drainOneStep({
        streamId: 'trigger',
        order: triggerFetch.order,
        cursor: triggerCursor,
        isEligible: (id) => triggerFetch.eligible.has(id),
        cache,
        budgetAvailable: triggerBudget,
        invocationId,
        nowMillis,
        firestore,
      });
      triggerCursor = step.cursor;
      if (step.stopped) triggerStopped = true;
    }

    const sweepBudget = canAdmitAnotherCase({ consumedReads, admittedCases });
    if (!sweepStopped) {
      const step = await drainOneStep({
        streamId: 'sweep',
        order: sweepFetch.order,
        cursor: sweepCursor,
        isEligible: (id) => sweepFetch.eligible.has(id),
        cache,
        budgetAvailable: sweepBudget,
        invocationId,
        nowMillis,
        firestore,
      });
      sweepCursor = step.cursor;
      if (step.stopped) sweepStopped = true;
    }

    admittedCases = cache.size;
    consumedReads = admittedCases * WORST_CASE_CASE_READS;

    const triggerAtEnd = findNextEligibleIndex(triggerFetch.order, triggerCursor, (id) => triggerFetch.eligible.has(id)) >= triggerFetch.order.orderedCaseIds.length;
    const sweepAtEnd = findNextEligibleIndex(sweepFetch.order, sweepCursor, (id) => sweepFetch.eligible.has(id)) >= sweepFetch.order.orderedCaseIds.length;
    const triggerDone = triggerStopped || triggerAtEnd;
    const sweepDone = sweepStopped || sweepAtEnd;
    if ((triggerDone && sweepDone) || !canAdmitAnotherCase({ consumedReads, admittedCases })) break;
  }

  // Genuine full-CYCLE exhaustion requires BOTH: the fetched page was fully
  // consumed (own-head/durable, never a Gate-1 stop) AND that page was
  // smaller than the limit (provably nothing left in this cycle). A fully
  // consumed FULL page (exactly the limit) only completes this PAGE — the
  // compound cursor still advances so the next invocation's `startAfter`
  // fetches the following page of the SAME cycle.
  const triggerPageConsumed = !triggerStopped && findNextEligibleIndex(triggerFetch.order, triggerCursor, (id) => triggerFetch.eligible.has(id)) >= triggerFetch.order.orderedCaseIds.length;
  const sweepPageConsumed = !sweepStopped && findNextEligibleIndex(sweepFetch.order, sweepCursor, (id) => sweepFetch.eligible.has(id)) >= sweepFetch.order.orderedCaseIds.length;
  const triggerCycleComplete = triggerPageConsumed && triggerFetch.isLastPage;
  const sweepCycleComplete = sweepPageConsumed && sweepFetch.isLastPage;

  // BF-1: a Gate-1-stopped stream receives NO cursor-document write at all
  // this invocation (no `casVersion` bump, no `updatedAt`, no
  // `cycleComplete` write) — the own-head must remain exactly as durably
  // observed, under the SAME persisted cycle/continuation state, so the
  // next invocation re-queries it unchanged.
  if (!triggerStopped) {
    const lastConsumed = triggerCursor.lastConsumedCaseId;
    const continuation = lastConsumed !== null
      ? { lastNextEligibleAtMillis: triggerFetch.nextEligibleAtById.get(lastConsumed) ?? null, lastShiftId: lastConsumed }
      : { lastNextEligibleAtMillis: triggerCursorDoc.lastNextEligibleAtMillis, lastShiftId: triggerCursorDoc.lastShiftId };
    await persistCursor(firestore, 'trigger', triggerCursorDoc, continuation, triggerCycleComplete);
  }
  if (!sweepStopped) {
    const lastConsumed = sweepCursor.lastConsumedCaseId;
    const continuation = lastConsumed !== null
      ? { lastNextEligibleAtMillis: sweepFetch.nextEligibleAtById.get(lastConsumed) ?? null, lastShiftId: lastConsumed }
      : { lastNextEligibleAtMillis: sweepCursorDoc.lastNextEligibleAtMillis, lastShiftId: sweepCursorDoc.lastShiftId };
    await persistCursor(firestore, 'sweep', sweepCursorDoc, continuation, sweepCycleComplete);
  }

  console.warn('[shiftCloseValidationWorker] sweep_invocation_summary', {
    casesProcessed: cache.size,
    readsUsed: consumedReads,
    budgetStopped: !canAdmitAnotherCase({ consumedReads, admittedCases }),
  });
}

export const shiftCloseValidationSweep = onSchedule(
  {
    schedule: 'every 60 minutes',
    region: FUNCTIONS_REGION,
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async (_event: ScheduledEvent) => {
    await runValidationSweep({ firestore: db, nowMillis: Date.now(), invocationId: randomUUID() });
  },
);
