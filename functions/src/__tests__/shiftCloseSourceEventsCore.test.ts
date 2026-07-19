import { describe, test, expect, vi } from 'vitest';

// A lightweight fake Timestamp (not the real Admin SDK class, which triggers
// Google Auth project-id detection on import in a test/node environment with
// no ambient credentials) — mirrors shiftCloseEvidenceCapture.test.ts's mock.
// [RC-2] Constructed from (seconds, nanoseconds) — mirrors the real Admin SDK
// `Timestamp`'s public constructor/getters exactly, so a millisecond-collapsing
// `toMillis()`-only fake could never mask the precision bug under test.
vi.mock('firebase-admin/firestore', () => {
  class FakeTimestamp {
    readonly seconds: number;
    readonly nanoseconds: number;
    constructor(seconds: number, nanoseconds: number) {
      this.seconds = seconds;
      this.nanoseconds = nanoseconds;
    }
    static fromMillis(ms: number): FakeTimestamp {
      const seconds = Math.floor(ms / 1000);
      const nanoseconds = (ms - seconds * 1000) * 1e6;
      return new FakeTimestamp(seconds, nanoseconds);
    }
    toMillis(): number {
      return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
    }
  }
  return { Timestamp: FakeTimestamp };
});

import {
  planSourceEventRouting,
  relevantFieldsChanged,
  deriveMembership,
  decideWatermark,
  decideTargetOutcome,
  buildEnqueueWriteSet,
  buildLedgerEntryKey,
  MAX_LEDGER_SIZE,
  microsFromSecondsNanos,
  microsFromIsoString,
  isRetryableFirestoreError,
  describeErrorCode,
  type RawImage,
  type SourceKind,
  type RouteTarget,
  type CaseSnapshotView,
} from '../shiftCloseSourceEventsCore';
import { buildSelectionCaseUpdate, buildRecheckEqualCaseUpdate } from '../shiftCloseValidationWorkerCore';
import { Timestamp } from 'firebase-admin/firestore';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function asyncOrder(overrides: RawImage = {}): RawImage {
  return {
    shiftId: 'shift-1',
    branchId: 'branch-1',
    deviceId: 'device-1',
    status: 'flushed',
    voidRequested: false,
    voidedAt: null,
    reconcileStatus: 'pending',
    changeAmt: 0,
    payments: [],
    unrelatedField: 'noise',
    ...overrides,
  };
}

function order(overrides: RawImage = {}): RawImage {
  return {
    shiftId: 'shift-1',
    branchId: 'branch-1',
    deviceId: 'device-1',
    status: 'completed',
    voidRequested: false,
    voidedAt: null,
    reconcileStatus: 'pending',
    unrelatedField: 'noise',
    ...overrides,
  };
}

function cashTx(overrides: RawImage = {}): RawImage {
  return {
    id: 'tx-1',
    shiftId: 'shift-1',
    branchId: 'branch-1',
    type: 'pay_in',
    amount: 100,
    unrelatedField: 'noise',
    ...overrides,
  };
}

function creditPayment(overrides: RawImage = {}): RawImage {
  return {
    id: 'pay-1',
    shiftId: 'shift-1',
    paymentMethod: 'cash',
    amount: 500,
    unrelatedField: 'noise',
    ...overrides,
  };
}

const UPDATE_TIME_MICROS = '1700000000000000';
const EVENT_TIME_ISO = '2026-07-15T00:00:00.000Z';
const EVENT_ID = 'event-1';

function createInput(sourceKind: SourceKind, after: RawImage, eventId: string = EVENT_ID) {
  return {
    sourceKind,
    sourceId: 'doc-1',
    before: undefined,
    after,
    updateTimeMicros: UPDATE_TIME_MICROS,
    eventTimeMicros: microsFromIsoString(EVENT_TIME_ISO),
    eventId,
  };
}

function updateInput(sourceKind: SourceKind, before: RawImage, after: RawImage, eventId: string = EVENT_ID) {
  return {
    sourceKind,
    sourceId: 'doc-1',
    before,
    after,
    updateTimeMicros: UPDATE_TIME_MICROS,
    eventTimeMicros: microsFromIsoString(EVENT_TIME_ISO),
    eventId,
  };
}

function deleteInput(sourceKind: SourceKind, before: RawImage, eventId: string = EVENT_ID) {
  return {
    sourceKind,
    sourceId: 'doc-1',
    before,
    after: undefined,
    updateTimeMicros: null,
    eventTimeMicros: microsFromIsoString(EVENT_TIME_ISO),
    eventId,
  };
}

function caseView(overrides: Partial<CaseSnapshotView> = {}): CaseSnapshotView {
  return {
    caseVersion: 1,
    sourceRevision: 1,
    pendingRevalidation: false,
    lastObservedCommitMicros: '0',
    commitBoundaryDocKeys: [],
    branchId: 'branch-1',
    lastEnqueuedSourceEventId: null,
    recentEnqueuedSourceEventIds: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Route decisions for all S1-S4
// ---------------------------------------------------------------------------

describe('route decisions for S1-S4', () => {
  test('asyncOrders create routes one target', () => {
    const result = planSourceEventRouting(createInput('asyncOrders', asyncOrder()));
    expect(result.kind).toBe('targets');
    if (result.kind !== 'targets') return;
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({ shiftId: 'shift-1', branchId: 'branch-1', deviceId: 'device-1', sourceKind: 'asyncOrders' });
  });

  test('orders create routes one target', () => {
    const result = planSourceEventRouting(createInput('orders', order()));
    expect(result.kind).toBe('targets');
    if (result.kind !== 'targets') return;
    expect(result.targets[0]).toMatchObject({ shiftId: 'shift-1', branchId: 'branch-1', deviceId: 'device-1', sourceKind: 'orders' });
  });

  test('cashTransactions create routes one target (no deviceId)', () => {
    const result = planSourceEventRouting(createInput('cashTransactions', cashTx()));
    expect(result.kind).toBe('targets');
    if (result.kind !== 'targets') return;
    expect(result.targets[0]).toMatchObject({ shiftId: 'shift-1', branchId: 'branch-1', deviceId: null, sourceKind: 'cashTransactions' });
  });

  test('creditPayments create routes one target (no branchId/deviceId)', () => {
    const result = planSourceEventRouting(createInput('creditPayments', creditPayment()));
    expect(result.kind).toBe('targets');
    if (result.kind !== 'targets') return;
    expect(result.targets[0]).toMatchObject({ shiftId: 'shift-1', branchId: null, deviceId: null, sourceKind: 'creditPayments' });
  });
});

// ---------------------------------------------------------------------------
// 2. Relevant-field diff gate
// ---------------------------------------------------------------------------

describe('relevant-field diff gate', () => {
  test('relevant field change enqueues', () => {
    const before = asyncOrder({ status: 'pending' });
    const after = asyncOrder({ status: 'flushed' });
    expect(relevantFieldsChanged('asyncOrders', before, after)).toBe(true);
    const result = planSourceEventRouting(updateInput('asyncOrders', before, after));
    expect(result.kind).toBe('targets');
  });

  test('non-relevant churn exits before any target/read', () => {
    const before = asyncOrder({ unrelatedField: 'a' });
    const after = asyncOrder({ unrelatedField: 'b' });
    expect(relevantFieldsChanged('asyncOrders', before, after)).toBe(false);
    const result = planSourceEventRouting(updateInput('asyncOrders', before, after));
    expect(result).toEqual({ kind: 'no_targets' });
  });

  test('voidedAt Timestamp change is relevant', () => {
    const before = asyncOrder({ voidedAt: null });
    const after = asyncOrder({ voidedAt: Timestamp.fromMillis(1000) });
    expect(relevantFieldsChanged('asyncOrders', before, after)).toBe(true);
  });

  test('voidedAt identical Timestamp values are not relevant', () => {
    const before = asyncOrder({ voidedAt: Timestamp.fromMillis(1000) });
    const after = asyncOrder({ voidedAt: Timestamp.fromMillis(1000) });
    expect(relevantFieldsChanged('asyncOrders', before, after)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Same-shift branch-only move (both image orders)
// ---------------------------------------------------------------------------

describe('same-shift branch-only move', () => {
  test('branch A -> B: two targets, matching branch enqueues, mismatch anomaly', () => {
    const before = asyncOrder({ branchId: 'branch-A', status: 'pending' });
    const after = asyncOrder({ branchId: 'branch-B', status: 'flushed' });
    const result = planSourceEventRouting(updateInput('asyncOrders', before, after));
    expect(result.kind).toBe('targets');
    if (result.kind !== 'targets') return;
    expect(result.targets).toHaveLength(2);
    const branchIds = result.targets.map((t) => t.branchId).sort();
    expect(branchIds).toEqual(['branch-A', 'branch-B']);

    const view = caseView({ branchId: 'branch-A' });
    const outcomes = result.targets.map((t) => decideTargetOutcome({ target: t, caseView: view, nowMillis: 0 }));
    const kinds = outcomes.map((o) => o.kind).sort();
    expect(kinds).toEqual(['branch_mismatch', 'enqueue']);
  });

  test('branch B -> A (swapped image order): same symmetric result', () => {
    const before = asyncOrder({ branchId: 'branch-B', status: 'pending' });
    const after = asyncOrder({ branchId: 'branch-A', status: 'flushed' });
    const result = planSourceEventRouting(updateInput('asyncOrders', before, after));
    expect(result.kind).toBe('targets');
    if (result.kind !== 'targets') return;
    expect(result.targets).toHaveLength(2);

    const view = caseView({ branchId: 'branch-A' });
    const outcomes = result.targets.map((t) => decideTargetOutcome({ target: t, caseView: view, nowMillis: 0 }));
    expect(outcomes.filter((o) => o.kind === 'enqueue')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'branch_mismatch')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Same-shift device-only move
// ---------------------------------------------------------------------------

describe('same-shift device-only move', () => {
  test('two targets, exactly one CAS effect expected', () => {
    const before = asyncOrder({ deviceId: 'device-A', status: 'pending' });
    const after = asyncOrder({ deviceId: 'device-B', status: 'flushed' });
    const result = planSourceEventRouting(updateInput('asyncOrders', before, after));
    expect(result.kind).toBe('targets');
    if (result.kind !== 'targets') return;
    expect(result.targets).toHaveLength(2);

    let view = caseView({ branchId: 'branch-1' });
    let enqueueCount = 0;
    for (const target of result.targets) {
      const outcome = decideTargetOutcome({ target, caseView: view, nowMillis: 0 });
      if (outcome.kind === 'enqueue') {
        enqueueCount += 1;
        view = {
          ...view,
          caseVersion: outcome.write.caseVersion,
          sourceRevision: outcome.write.sourceRevision,
          pendingRevalidation: outcome.write.pendingRevalidation,
          lastObservedCommitMicros: outcome.write.lastObservedCommitMicros,
          commitBoundaryDocKeys: outcome.write.commitBoundaryDocKeys,
          // [RC-RR1-E-1] Must propagate the ledger too, matching real
          // per-target sequential transactions (each `processRouteTarget`
          // writes it for real) — the two targets share the identical
          // sourceEventId/eventId (one underlying write), so the ledger
          // dedup check (step 3), not the watermark's `duplicate` branch,
          // is what correctly catches the second target now.
          recentEnqueuedSourceEventIds: outcome.write.recentEnqueuedSourceEventIds,
        };
      }
    }
    expect(enqueueCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. shiftId move -> two independent cases
// ---------------------------------------------------------------------------

describe('shiftId move', () => {
  test('two targets with different shiftIds', () => {
    const before = asyncOrder({ shiftId: 'shift-1', status: 'pending' });
    const after = asyncOrder({ shiftId: 'shift-2', status: 'pending' });
    const result = planSourceEventRouting(updateInput('asyncOrders', before, after));
    expect(result.kind).toBe('targets');
    if (result.kind !== 'targets') return;
    expect(result.targets).toHaveLength(2);
    expect(result.targets.map((t) => t.shiftId).sort()).toEqual(['shift-1', 'shift-2']);
  });
});

// ---------------------------------------------------------------------------
// 6. branch+device move
// ---------------------------------------------------------------------------

describe('branch+device move', () => {
  test('two targets, same shiftId, differing branch and device', () => {
    const before = asyncOrder({ branchId: 'branch-A', deviceId: 'device-A' });
    const after = asyncOrder({ branchId: 'branch-B', deviceId: 'device-B' });
    const result = planSourceEventRouting(updateInput('asyncOrders', before, after));
    expect(result.kind).toBe('targets');
    if (result.kind !== 'targets') return;
    expect(result.targets).toHaveLength(2);
    expect(result.targets.every((t) => t.shiftId === 'shift-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7-8. before-only delete / after-only create
// ---------------------------------------------------------------------------

describe('create/delete edge shapes', () => {
  test('before-only delete uses :del discriminator', () => {
    const result = planSourceEventRouting(deleteInput('cashTransactions', cashTx()));
    expect(result.kind).toBe('targets');
    if (result.kind !== 'targets') return;
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].sourceEventId).toContain(':del:');
    expect(result.targets[0].watermarkKey).toBe('cashTransactions:doc-1:del');
  });

  test('after-only create has no :del discriminator', () => {
    const result = planSourceEventRouting(createInput('cashTransactions', cashTx()));
    expect(result.kind).toBe('targets');
    if (result.kind !== 'targets') return;
    expect(result.targets[0].sourceEventId).not.toContain(':del');
    expect(result.targets[0].watermarkKey).toBe('cashTransactions:doc-1');
  });
});

// ---------------------------------------------------------------------------
// 9-10. Dedupe / multi-target representability
// ---------------------------------------------------------------------------

describe('dedupe and multi-target representability', () => {
  test('identical membership across before/after dedupes to one target', () => {
    const before = asyncOrder({ status: 'pending' });
    const after = asyncOrder({ status: 'flushed' });
    const result = planSourceEventRouting(updateInput('asyncOrders', before, after));
    expect(result.kind).toBe('targets');
    if (result.kind !== 'targets') return;
    expect(result.targets).toHaveLength(1);
  });

  test('same shiftId twice with different membership is representable', () => {
    const before = asyncOrder({ branchId: 'branch-A' });
    const after = asyncOrder({ branchId: 'branch-B' });
    const result = planSourceEventRouting(updateInput('asyncOrders', before, after));
    expect(result.kind).toBe('targets');
    if (result.kind !== 'targets') return;
    const shiftIds = new Set(result.targets.map((t) => t.shiftId));
    expect(shiftIds.size).toBe(1);
    expect(result.targets).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 11. Watermark
// ---------------------------------------------------------------------------

describe('watermark decision', () => {
  test('older revisionToken -> stale', () => {
    const decision = decideWatermark({
      currentLastObservedCommitMicros: '100',
      currentCommitBoundaryDocKeys: [],
      revisionToken: '50',
      watermarkKey: 'orders:x',
    });
    expect(decision).toEqual({ kind: 'stale' });
  });

  test('equal + existing key -> duplicate', () => {
    const decision = decideWatermark({
      currentLastObservedCommitMicros: '100',
      currentCommitBoundaryDocKeys: ['orders:x'],
      revisionToken: '100',
      watermarkKey: 'orders:x',
    });
    expect(decision).toEqual({ kind: 'duplicate' });
  });

  test('equal + new key -> append', () => {
    const decision = decideWatermark({
      currentLastObservedCommitMicros: '100',
      currentCommitBoundaryDocKeys: ['orders:x'],
      revisionToken: '100',
      watermarkKey: 'orders:y',
    });
    expect(decision).toEqual({ kind: 'append', nextCommitBoundaryDocKeys: ['orders:x', 'orders:y'] });
  });

  test('newer -> advance and reset boundary', () => {
    const decision = decideWatermark({
      currentLastObservedCommitMicros: '100',
      currentCommitBoundaryDocKeys: ['orders:x', 'orders:y'],
      revisionToken: '200',
      watermarkKey: 'orders:z',
    });
    expect(decision).toEqual({ kind: 'advance', nextLastObservedCommitMicros: '200', nextCommitBoundaryDocKeys: ['orders:z'] });
  });

  test('BigInt beyond Number.MAX_SAFE_INTEGER compares correctly', () => {
    const huge = '9007199254740993'; // MAX_SAFE_INTEGER + 2
    const hugerPlus1 = '9007199254740994';
    const decision = decideWatermark({
      currentLastObservedCommitMicros: huge,
      currentCommitBoundaryDocKeys: [],
      revisionToken: hugerPlus1,
      watermarkKey: 'orders:z',
    });
    expect(decision).toEqual({ kind: 'advance', nextLastObservedCommitMicros: hugerPlus1, nextCommitBoundaryDocKeys: ['orders:z'] });

    const same = decideWatermark({
      currentLastObservedCommitMicros: huge,
      currentCommitBoundaryDocKeys: [],
      revisionToken: huge,
      watermarkKey: 'orders:z',
    });
    expect(same.kind).toBe('append');
  });
});

// ---------------------------------------------------------------------------
// 12. Double-delivery of same sourceEventId -> no-op
// ---------------------------------------------------------------------------

describe('double delivery idempotency', () => {
  test('redelivered same sourceEventId produces exactly-once effect', () => {
    const target: RouteTarget = {
      shiftId: 'shift-1',
      branchId: 'branch-1',
      deviceId: 'device-1',
      sourceKind: 'asyncOrders',
      sourceId: 'doc-1',
      sourceEventId: 'asyncOrders:doc-1:100',
      watermarkKey: 'asyncOrders:doc-1',
      revisionToken: '100',
      eventId: 'event-1',
    };
    const initialView = caseView({ branchId: 'branch-1' });
    const first = decideTargetOutcome({ target, caseView: initialView, nowMillis: 0 });
    expect(first.kind).toBe('enqueue');
    if (first.kind !== 'enqueue') return;

    const advancedView: CaseSnapshotView = {
      ...initialView,
      caseVersion: first.write.caseVersion,
      sourceRevision: first.write.sourceRevision,
      pendingRevalidation: first.write.pendingRevalidation,
      lastObservedCommitMicros: first.write.lastObservedCommitMicros,
      commitBoundaryDocKeys: first.write.commitBoundaryDocKeys,
      lastEnqueuedSourceEventId: first.write.lastEnqueuedSourceEventId,
      recentEnqueuedSourceEventIds: first.write.recentEnqueuedSourceEventIds,
    };

    // Caught by the RC-RR1 durable ledger dedup check, which runs before the
    // watermark check.
    const redelivered = decideTargetOutcome({ target, caseView: advancedView, nowMillis: 5000 });
    expect(redelivered).toEqual({ kind: 'noop_duplicate_source_event' });
  });

  test('a genuinely older (stale) revision still no-ops regardless of ledger state', () => {
    // A strictly OLDER revision is unambiguously not a new event no matter
    // what the ledger holds (or misses) — the `stale` watermark branch is
    // checked before the RC-RR1-E-1 duplicate-override path and always wins.
    const target: RouteTarget = {
      shiftId: 'shift-1',
      branchId: 'branch-1',
      deviceId: 'device-1',
      sourceKind: 'asyncOrders',
      sourceId: 'doc-1',
      sourceEventId: 'asyncOrders:doc-1:50',
      watermarkKey: 'asyncOrders:doc-1',
      revisionToken: '50',
      eventId: 'event-1',
    };
    const view = caseView({
      branchId: 'branch-1',
      lastObservedCommitMicros: '100',
      commitBoundaryDocKeys: ['asyncOrders:doc-1'],
      lastEnqueuedSourceEventId: 'some-other-event',
      recentEnqueuedSourceEventIds: ['some-other-event#some-other-eventId'],
    });
    expect(decideTargetOutcome({ target, caseView: view, nowMillis: 0 })).toEqual({ kind: 'noop_watermark' });
  });
});

// ---------------------------------------------------------------------------
// RC-1: delete redelivery exactly-once ACROSS an intervening P5-D-1 sweep.
//
// Codex-diagnosed shape: the worker's selection write (buildSelectionCaseUpdate
// in shiftCloseValidationWorkerCore.ts, NOT edited here) computes
// lastObservedCommitMicros = max(current, its own T2 scan) but wholesale
// REPLACES commitBoundaryDocKeys from that same live scan — which can never
// include a document that has since been deleted. A redelivered delete
// sourceEventId would then see "equal revision, missing key" and wrongly
// `append`. `lastEnqueuedSourceEventId` is not in the worker's write-set, so
// it survives the sweep untouched and gives routing an independent,
// durable exactly-once signal.
// ---------------------------------------------------------------------------

describe('RC-1: delete redelivery exactly-once across an intervening P5-D-1 sweep', () => {
  const deleteTarget: RouteTarget = {
    shiftId: 'shift-1',
    branchId: 'branch-1',
    deviceId: null,
    sourceKind: 'orders',
    sourceId: 'deleted-order',
    sourceEventId: 'orders:deleted-order:del:200',
    watermarkKey: 'orders:deleted-order:del',
    revisionToken: '200',
    eventId: 'event-A',
  };

  test('sweep replaces commitBoundaryDocKeys but the ledger survives -> redelivered delete is a clean no-op', () => {
    // 1. Router enqueues the delete for the first time.
    const initialView = caseView({ branchId: 'branch-1', lastObservedCommitMicros: '150', commitBoundaryDocKeys: ['orders:remaining'] });
    const enqueued = decideTargetOutcome({ target: deleteTarget, caseView: initialView, nowMillis: 0 });
    expect(enqueued.kind).toBe('enqueue');
    if (enqueued.kind !== 'enqueue') return;
    expect(enqueued.write.lastObservedCommitMicros).toBe('200');
    expect(enqueued.write.commitBoundaryDocKeys).toEqual(['orders:deleted-order:del']);
    expect(enqueued.write.lastEnqueuedSourceEventId).toBe('orders:deleted-order:del:200');
    expect(enqueued.write.recentEnqueuedSourceEventIds).toEqual([buildLedgerEntryKey('orders:deleted-order:del:200', 'event-A')]);

    // 2. A P5-D-1 sweep/selection transaction runs afterward (simulated, not
    //    imported — the worker module is out of the P5-D-2 allowlist). It
    //    keeps lastObservedCommitMicros at 200 (nothing newer exists) but
    //    REPLACES commitBoundaryDocKeys wholesale from its own live source
    //    scan, which cannot see the deleted document. It never touches
    //    lastEnqueuedSourceEventId/recentEnqueuedSourceEventIds (not in its
    //    allowed write-set).
    const postSweepView: CaseSnapshotView = {
      ...initialView,
      caseVersion: enqueued.write.caseVersion,
      sourceRevision: enqueued.write.sourceRevision,
      pendingRevalidation: false,
      lastObservedCommitMicros: '200',
      commitBoundaryDocKeys: ['orders:remaining'],
      lastEnqueuedSourceEventId: enqueued.write.lastEnqueuedSourceEventId,
      recentEnqueuedSourceEventIds: enqueued.write.recentEnqueuedSourceEventIds,
    };

    // Sanity: WITHOUT the ledger, this exact case state reproduces Codex's
    // diagnosed `append` bug via the watermark path alone.
    const watermarkOnly = decideWatermark({
      currentLastObservedCommitMicros: postSweepView.lastObservedCommitMicros,
      currentCommitBoundaryDocKeys: postSweepView.commitBoundaryDocKeys,
      revisionToken: deleteTarget.revisionToken,
      watermarkKey: deleteTarget.watermarkKey,
    });
    expect(watermarkOnly.kind).toBe('append');

    // 3. The same delete sourceEventId (and the same CloudEvent id) is redelivered by Eventarc.
    const redelivered = decideTargetOutcome({ target: deleteTarget, caseView: postSweepView, nowMillis: 10_000 });
    expect(redelivered).toEqual({ kind: 'noop_duplicate_source_event' });
  });

  test('a genuinely new event on the same doc after a sweep still enqueues (dedup does not over-suppress)', () => {
    const view: CaseSnapshotView = caseView({
      branchId: 'branch-1',
      lastObservedCommitMicros: '200',
      commitBoundaryDocKeys: ['orders:remaining'],
      lastEnqueuedSourceEventId: 'orders:deleted-order:del:200',
      recentEnqueuedSourceEventIds: [buildLedgerEntryKey('orders:deleted-order:del:200', 'event-A')],
    });
    const newTarget: RouteTarget = {
      ...deleteTarget,
      sourceEventId: 'orders:deleted-order:del:300',
      revisionToken: '300',
    };
    const outcome = decideTargetOutcome({ target: newTarget, caseView: view, nowMillis: 0 });
    expect(outcome.kind).toBe('enqueue');
  });

  test('branch mismatch is still flagged even when the mismatched target shares the surviving ledger entry', () => {
    // Ordering guarantee: branch check runs BEFORE the ledger dedup check, so
    // a real anomaly is never silently swallowed by the durable dedup signal.
    const view: CaseSnapshotView = caseView({
      branchId: 'branch-OTHER',
      lastObservedCommitMicros: '200',
      commitBoundaryDocKeys: ['orders:remaining'],
      lastEnqueuedSourceEventId: deleteTarget.sourceEventId,
      recentEnqueuedSourceEventIds: [buildLedgerEntryKey(deleteTarget.sourceEventId, deleteTarget.eventId)],
    });
    const outcome = decideTargetOutcome({ target: deleteTarget, caseView: view, nowMillis: 0 });
    expect(outcome).toEqual({ kind: 'branch_mismatch', caseBranchId: 'branch-OTHER', targetBranchId: 'branch-1' });
  });
});

// ---------------------------------------------------------------------------
// RC-RR1: Candidate E — durable tied-event ledger, microsecond-accurate
// CloudEvent-time parsing, and CloudEvent `id` identity strengthening.
//
// Codex re-review counterexample (RC-RR1): a one-slot `lastEnqueuedSourceEventId`
// cannot remember MORE THAN ONE tied sibling at the same revision. Two
// distinct delete events (A, B) tied at the same revision R both enqueue; B's
// write overwrites the single scalar slot; a P5-D-1 sweep then wholesale-
// replaces commitBoundaryDocKeys from its live scan (dropping both deleted
// docs' keys) while leaving the scalar untouched at B; a delayed redelivery
// of A then sees "scalar=B, revision=R, boundary missing A" and wrongly
// re-enqueues. The bounded FIFO ledger (`recentEnqueuedSourceEventIds`)
// closes this by remembering every distinct tied sibling, not just the last.
// ---------------------------------------------------------------------------

describe('RC-RR1: durable tied-event ledger (Candidate E)', () => {
  const targetA: RouteTarget = {
    shiftId: 'shift-1',
    branchId: 'branch-1',
    deviceId: null,
    sourceKind: 'orders',
    sourceId: 'deleted-A',
    sourceEventId: 'orders:deleted-A:del:200',
    watermarkKey: 'orders:deleted-A:del',
    revisionToken: '200',
    eventId: 'event-A',
  };
  const targetB: RouteTarget = {
    shiftId: 'shift-1',
    branchId: 'branch-1',
    deviceId: null,
    sourceKind: 'orders',
    sourceId: 'deleted-B',
    sourceEventId: 'orders:deleted-B:del:200',
    watermarkKey: 'orders:deleted-B:del',
    revisionToken: '200',
    eventId: 'event-B',
  };

  test('two distinct tied delete events both land in the ledger', () => {
    const initialView = caseView({ branchId: 'branch-1', lastObservedCommitMicros: '150', commitBoundaryDocKeys: ['orders:remaining'] });
    const enqueuedA = decideTargetOutcome({ target: targetA, caseView: initialView, nowMillis: 0 });
    expect(enqueuedA.kind).toBe('enqueue');
    if (enqueuedA.kind !== 'enqueue') return;

    const viewAfterA: CaseSnapshotView = {
      ...initialView,
      caseVersion: enqueuedA.write.caseVersion,
      sourceRevision: enqueuedA.write.sourceRevision,
      pendingRevalidation: enqueuedA.write.pendingRevalidation,
      lastObservedCommitMicros: enqueuedA.write.lastObservedCommitMicros,
      commitBoundaryDocKeys: enqueuedA.write.commitBoundaryDocKeys,
      lastEnqueuedSourceEventId: enqueuedA.write.lastEnqueuedSourceEventId,
      recentEnqueuedSourceEventIds: enqueuedA.write.recentEnqueuedSourceEventIds,
    };

    const enqueuedB = decideTargetOutcome({ target: targetB, caseView: viewAfterA, nowMillis: 0 });
    expect(enqueuedB.kind).toBe('enqueue');
    if (enqueuedB.kind !== 'enqueue') return;

    // Both A and B are present in the ledger — no eviction at length 2.
    expect(enqueuedB.write.recentEnqueuedSourceEventIds).toEqual([
      buildLedgerEntryKey(targetA.sourceEventId, targetA.eventId),
      buildLedgerEntryKey(targetB.sourceEventId, targetB.eventId),
    ]);
    // The scalar mirror only ever reflects the LATEST enqueue (B) — this is
    // the exact one-slot limitation the ledger exists to fix.
    expect(enqueuedB.write.lastEnqueuedSourceEventId).toBe(targetB.sourceEventId);
  });

  test('RC-RR1 counterexample closed: delayed redelivery of the earlier/non-latest tied event is a clean no-op after a sweep', () => {
    // 1. A enqueues, then B enqueues at the same tied revision.
    const initialView = caseView({ branchId: 'branch-1', lastObservedCommitMicros: '150', commitBoundaryDocKeys: ['orders:remaining'] });
    const enqueuedA = decideTargetOutcome({ target: targetA, caseView: initialView, nowMillis: 0 });
    if (enqueuedA.kind !== 'enqueue') throw new Error('expected enqueue');
    const viewAfterA: CaseSnapshotView = { ...initialView, ...enqueuedA.write };
    const enqueuedB = decideTargetOutcome({ target: targetB, caseView: viewAfterA, nowMillis: 0 });
    if (enqueuedB.kind !== 'enqueue') throw new Error('expected enqueue');

    // 2. A P5-D-1 sweep runs: lastObservedCommitMicros stays at 200 (nothing
    //    newer), commitBoundaryDocKeys is wholesale-replaced from a live scan
    //    that can see neither deleted document, and the ledger is untouched
    //    (not in the worker's write-set).
    const postSweepView: CaseSnapshotView = {
      ...initialView,
      caseVersion: enqueuedB.write.caseVersion,
      sourceRevision: enqueuedB.write.sourceRevision,
      pendingRevalidation: false,
      lastObservedCommitMicros: '200',
      commitBoundaryDocKeys: ['orders:remaining'],
      lastEnqueuedSourceEventId: enqueuedB.write.lastEnqueuedSourceEventId,
      recentEnqueuedSourceEventIds: enqueuedB.write.recentEnqueuedSourceEventIds,
    };

    // Sanity: the scalar-only RC-1 mechanism would wrongly re-enqueue A here
    // (scalar = B's sourceEventId, not A's) — reproducing the exact RC-RR1
    // diagnosis before the ledger fix is applied.
    expect(postSweepView.lastEnqueuedSourceEventId).not.toBe(targetA.sourceEventId);

    // 3. Delayed redelivery of the EARLIER/non-latest tied event (A).
    const redeliveredA = decideTargetOutcome({ target: targetA, caseView: postSweepView, nowMillis: 10_000 });
    expect(redeliveredA).toEqual({ kind: 'noop_duplicate_source_event' });
  });

  test('delayed redelivery of the LATEST tied event is also a clean no-op after a sweep', () => {
    const initialView = caseView({ branchId: 'branch-1', lastObservedCommitMicros: '150', commitBoundaryDocKeys: ['orders:remaining'] });
    const enqueuedA = decideTargetOutcome({ target: targetA, caseView: initialView, nowMillis: 0 });
    if (enqueuedA.kind !== 'enqueue') throw new Error('expected enqueue');
    const viewAfterA: CaseSnapshotView = { ...initialView, ...enqueuedA.write };
    const enqueuedB = decideTargetOutcome({ target: targetB, caseView: viewAfterA, nowMillis: 0 });
    if (enqueuedB.kind !== 'enqueue') throw new Error('expected enqueue');

    const postSweepView: CaseSnapshotView = {
      ...initialView,
      caseVersion: enqueuedB.write.caseVersion,
      sourceRevision: enqueuedB.write.sourceRevision,
      pendingRevalidation: false,
      lastObservedCommitMicros: '200',
      commitBoundaryDocKeys: ['orders:remaining'],
      lastEnqueuedSourceEventId: enqueuedB.write.lastEnqueuedSourceEventId,
      recentEnqueuedSourceEventIds: enqueuedB.write.recentEnqueuedSourceEventIds,
    };

    const redeliveredB = decideTargetOutcome({ target: targetB, caseView: postSweepView, nowMillis: 10_000 });
    expect(redeliveredB).toEqual({ kind: 'noop_duplicate_source_event' });
  });

  test('a genuinely new, later, distinct event on the same case still enqueues and appends to the ledger', () => {
    const view = caseView({
      branchId: 'branch-1',
      lastObservedCommitMicros: '200',
      commitBoundaryDocKeys: ['orders:remaining'],
      recentEnqueuedSourceEventIds: [buildLedgerEntryKey(targetA.sourceEventId, targetA.eventId), buildLedgerEntryKey(targetB.sourceEventId, targetB.eventId)],
    });
    const targetC: RouteTarget = { ...targetA, sourceId: 'deleted-C', sourceEventId: 'orders:deleted-C:del:300', revisionToken: '300', eventId: 'event-C' };
    const outcome = decideTargetOutcome({ target: targetC, caseView: view, nowMillis: 0 });
    expect(outcome.kind).toBe('enqueue');
    if (outcome.kind !== 'enqueue') return;
    expect(outcome.write.recentEnqueuedSourceEventIds).toContain(buildLedgerEntryKey(targetC.sourceEventId, targetC.eventId));
  });

  test('same-source delete -> recreate -> delete at sub-millisecond-adjacent instants produces distinct source-event identity', () => {
    const isoEarlier = '2026-07-18T00:00:00.000100Z';
    const isoLater = '2026-07-18T00:00:00.000900Z';
    const microsEarlier = microsFromIsoString(isoEarlier);
    const microsLater = microsFromIsoString(isoLater);
    expect(microsEarlier).not.toBe(microsLater);

    const firstDelete = deleteInput('orders', order(), 'event-first');
    const secondDelete = { ...firstDelete, eventTimeMicros: microsLater, eventId: 'event-second' };
    const planFirst = planSourceEventRouting({ ...firstDelete, eventTimeMicros: microsEarlier });
    const planSecond = planSourceEventRouting(secondDelete);
    expect(planFirst.kind).toBe('targets');
    expect(planSecond.kind).toBe('targets');
    if (planFirst.kind !== 'targets' || planSecond.kind !== 'targets') return;
    expect(planFirst.targets[0].sourceEventId).not.toBe(planSecond.targets[0].sourceEventId);
  });

  test('fractional CloudEvent time parsing: .000100Z vs .000900Z produce different revisionTokens', () => {
    const a = microsFromIsoString('2026-07-18T00:00:00.000100Z');
    const b = microsFromIsoString('2026-07-18T00:00:00.000900Z');
    expect(a).not.toBe(b);
    expect(a).toBe('1784332800000100');
    expect(b).toBe('1784332800000900');
  });

  test('9-digit nanosecond-shaped fractional input truncates safely to microseconds (no NaN/throw)', () => {
    const micros = microsFromIsoString('2026-07-18T00:00:00.123456789Z');
    expect(micros).toBe('1784332800123456');
    expect(() => BigInt(micros)).not.toThrow();
  });

  test('no fractional component parses as zero sub-second micros', () => {
    expect(microsFromIsoString('2026-07-18T00:00:00Z')).toBe('1784332800000000');
  });

  test('short fractional component right-pads (ISO decimal-fraction semantics, not digit-count microseconds)', () => {
    // ".5" means 500ms = 500000 micros, not 5 micros.
    expect(microsFromIsoString('2026-07-18T00:00:00.5Z')).toBe('1784332800500000');
  });

  test('event-ID identity: identical CloudEvent id redelivery dedups; same derived revision/source with a different id is distinct', () => {
    const view = caseView({
      branchId: 'branch-1',
      lastObservedCommitMicros: '200',
      commitBoundaryDocKeys: ['orders:remaining'],
      recentEnqueuedSourceEventIds: [buildLedgerEntryKey('orders:collided:del:200', 'event-original')],
    });
    // Identical sourceEventId AND identical eventId -> genuine redelivery -> no-op.
    const sameEventRedelivery: RouteTarget = {
      shiftId: 'shift-1',
      branchId: 'branch-1',
      deviceId: null,
      sourceKind: 'orders',
      sourceId: 'collided',
      sourceEventId: 'orders:collided:del:200',
      watermarkKey: 'orders:collided:del',
      revisionToken: '200',
      eventId: 'event-original',
    };
    expect(decideTargetOutcome({ target: sameEventRedelivery, caseView: view, nowMillis: 0 })).toEqual({ kind: 'noop_duplicate_source_event' });

    // Identical derived sourceEventId (a contrived collision) but a DIFFERENT
    // CloudEvent id -> a genuinely distinct event -> must NOT be deduped.
    const collidedDistinctEvent: RouteTarget = { ...sameEventRedelivery, eventId: 'event-distinct' };
    const distinctOutcome = decideTargetOutcome({ target: collidedDistinctEvent, caseView: view, nowMillis: 0 });
    expect(distinctOutcome.kind).toBe('enqueue');
  });

  test('ledger cap/pruning: enqueuing MAX_LEDGER_SIZE + 1 distinct TIED events caps at MAX_LEDGER_SIZE with FIFO eviction', () => {
    // All events tied at the SAME revision, so a post-sweep boundary
    // replacement (which drops every deleted doc's key) leaves the
    // watermark rule alone unable to catch a redelivery — isolating the
    // ledger's own eviction behavior as the only variable under test.
    let view = caseView({ branchId: 'branch-1', lastObservedCommitMicros: '200', commitBoundaryDocKeys: [] });
    const keys: string[] = [];
    for (let i = 0; i < MAX_LEDGER_SIZE + 1; i += 1) {
      const target: RouteTarget = {
        shiftId: 'shift-1',
        branchId: 'branch-1',
        deviceId: null,
        sourceKind: 'orders',
        sourceId: `doc-${i}`,
        sourceEventId: `orders:doc-${i}:del:200`,
        watermarkKey: `orders:doc-${i}:del`,
        revisionToken: '200',
        eventId: `event-${i}`,
      };
      const outcome = decideTargetOutcome({ target, caseView: view, nowMillis: 0 });
      expect(outcome.kind).toBe('enqueue');
      if (outcome.kind !== 'enqueue') return;
      keys.push(buildLedgerEntryKey(target.sourceEventId, target.eventId));
      view = { ...view, ...outcome.write };
    }

    expect(view.recentEnqueuedSourceEventIds).toHaveLength(MAX_LEDGER_SIZE);
    // FIFO: the oldest (index 0) entry was evicted; the most recent MAX_LEDGER_SIZE remain.
    expect(view.recentEnqueuedSourceEventIds).toEqual(keys.slice(keys.length - MAX_LEDGER_SIZE));
    expect(view.recentEnqueuedSourceEventIds).not.toContain(keys[0]);

    // Simulate a P5-D-1 sweep: commitBoundaryDocKeys wholesale-replaced
    // (every deleted doc vanishes from the live scan); lastObservedCommitMicros
    // stays at 200 (nothing newer). Redelivery of the EVICTED (oldest) event
    // DOES enqueue again — accepted bounded degradation (§Candidate B
    // "ability to cover"), not a regression: the ledger's bound was
    // exceeded by more distinct tied siblings than realistic same-commit
    // fan-out, and the watermark rule alone (post-sweep) cannot help either.
    const postSweepView: CaseSnapshotView = { ...view, commitBoundaryDocKeys: [] };
    const evictedTarget: RouteTarget = {
      shiftId: 'shift-1',
      branchId: 'branch-1',
      deviceId: null,
      sourceKind: 'orders',
      sourceId: 'doc-0',
      sourceEventId: 'orders:doc-0:del:200',
      watermarkKey: 'orders:doc-0:del',
      revisionToken: '200',
      eventId: 'event-0',
    };
    const evictedRedelivery = decideTargetOutcome({ target: evictedTarget, caseView: postSweepView, nowMillis: 0 });
    expect(evictedRedelivery.kind).toBe('enqueue');
  });

  test('worker/router interop: buildSelectionCaseUpdate and buildRecheckEqualCaseUpdate never write recentEnqueuedSourceEventIds or lastEnqueuedSourceEventId', () => {
    const selectionUpdate = buildSelectionCaseUpdate({
      runId: 'run-1',
      closeHash: 'hash-1',
      sourceRevision: 5,
      priorSelectedRunId: null,
      processingState: 'validated',
      settlementState: 'unsettled',
      alertState: 'none',
      computedAtCommitMicros: '200',
      currentLastObservedCommitMicros: '150',
      commitBoundaryDocKeys: ['orders:remaining'],
      currentCaseVersion: 3,
      lateEventHorizonUntilMillis: 1000,
      nowMillis: 0,
    });
    expect('recentEnqueuedSourceEventIds' in selectionUpdate).toBe(false);
    expect('lastEnqueuedSourceEventId' in selectionUpdate).toBe(false);

    const recheckUpdate = buildRecheckEqualCaseUpdate({
      currentCaseVersion: 3,
      lateEventHorizonUntilMillis: 1000,
      nowMillis: 0,
      priorProcessingState: 'validated',
    });
    expect('recentEnqueuedSourceEventIds' in recheckUpdate).toBe(false);
    expect('lastEnqueuedSourceEventId' in recheckUpdate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RC-RR1-E-1: Codex re-review finding — a different CloudEvent `id` sharing
// the same derived `sourceEventId`/revision was still wrongly collapsed by
// the ordinary equal-revision watermark `duplicate` classification whenever
// the source boundary key remained present (i.e. the NORMAL post-first-
// enqueue state, not just the post-sweep boundary-replaced state RC-RR1's
// original regression covered). Codex's exact reproduction:
//
//   case ledger: [orders:collided:del:200#event-original]
//   case watermark: revision 200, boundary [orders:collided:del]
//   incoming: same sourceEventId/revision, eventId=event-distinct
//   pre-fix result: {"kind":"noop_watermark"}   <- WRONG, silently dropped
//
// Fix: a ledger MISS reaching the watermark `duplicate` branch is now
// treated as a genuinely distinct event (the ledger already proved this
// exact CloudEvent was never recorded) — it enqueues and appends its own
// ledger entry, WITHOUT altering `lastObservedCommitMicros`/
// `commitBoundaryDocKeys` (nothing new to record there) and WITHOUT
// changing the frozen `watermarkKey`/`commitBoundaryDocKeys` string
// convention itself.
// ---------------------------------------------------------------------------

describe('RC-RR1-E-1: CloudEvent ID distinct-event override under the NORMAL (non-swept) boundary state', () => {
  const normalBoundaryView = () =>
    caseView({
      branchId: 'branch-1',
      lastObservedCommitMicros: '200',
      commitBoundaryDocKeys: ['orders:collided:del'],
      lastEnqueuedSourceEventId: 'orders:collided:del:200',
      recentEnqueuedSourceEventIds: [buildLedgerEntryKey('orders:collided:del:200', 'event-original')],
    });

  const targetWithEventId = (eventId: string): RouteTarget => ({
    shiftId: 'shift-1',
    branchId: 'branch-1',
    deviceId: null,
    sourceKind: 'orders',
    sourceId: 'collided',
    sourceEventId: 'orders:collided:del:200',
    watermarkKey: 'orders:collided:del',
    revisionToken: '200',
    eventId,
  });

  test('normal-boundary distinct CloudEvent ID enqueues and appends its own ledger entry (Codex reproduction, corrected)', () => {
    const outcome = decideTargetOutcome({ target: targetWithEventId('event-distinct'), caseView: normalBoundaryView(), nowMillis: 0 });
    expect(outcome.kind).toBe('enqueue');
    if (outcome.kind !== 'enqueue') return;
    expect(outcome.write.recentEnqueuedSourceEventIds).toEqual([
      buildLedgerEntryKey('orders:collided:del:200', 'event-original'),
      buildLedgerEntryKey('orders:collided:del:200', 'event-distinct'),
    ]);
    // The boundary/watermark state itself is unchanged — the key was
    // already correctly present; the shared string convention is untouched.
    expect(outcome.write.lastObservedCommitMicros).toBe('200');
    expect(outcome.write.commitBoundaryDocKeys).toEqual(['orders:collided:del']);
  });

  test('same CloudEvent ID under the same normal-boundary state still no-ops', () => {
    const outcome = decideTargetOutcome({ target: targetWithEventId('event-original'), caseView: normalBoundaryView(), nowMillis: 0 });
    expect(outcome).toEqual({ kind: 'noop_duplicate_source_event' });
  });

  test('branch mismatch still wins first, even with a ledger miss and the normal boundary present', () => {
    const view = { ...normalBoundaryView(), branchId: 'branch-OTHER' };
    const outcome = decideTargetOutcome({ target: targetWithEventId('event-distinct'), caseView: view, nowMillis: 0 });
    expect(outcome).toEqual({ kind: 'branch_mismatch', caseBranchId: 'branch-OTHER', targetBranchId: 'branch-1' });
  });

  test('an older (stale) revision still no-ops despite a ledger miss', () => {
    const staleTarget: RouteTarget = { ...targetWithEventId('event-distinct'), sourceEventId: 'orders:collided:del:100', revisionToken: '100' };
    const outcome = decideTargetOutcome({ target: staleTarget, caseView: normalBoundaryView(), nowMillis: 0 });
    expect(outcome).toEqual({ kind: 'noop_watermark' });
  });
});

// ---------------------------------------------------------------------------
// RC-2: relevant-field timestamp equality must compare exact
// (seconds, nanoseconds) — never `.toMillis()`, which collapses distinct
// sub-millisecond Timestamps to the same value.
// ---------------------------------------------------------------------------

describe('RC-2: sub-millisecond timestamp precision', () => {
  test('two Timestamps in the same millisecond but different nanoseconds ARE relevant', () => {
    const before = asyncOrder({ voidedAt: new Timestamp(1_700_000_000, 1000) });
    const after = asyncOrder({ voidedAt: new Timestamp(1_700_000_000, 2000) });
    // Sanity: both collapse to the identical millisecond under toMillis().
    expect((before.voidedAt as Timestamp).toMillis()).toBe((after.voidedAt as Timestamp).toMillis());
    expect(relevantFieldsChanged('asyncOrders', before, after)).toBe(true);
  });

  test('identical (seconds, nanoseconds) Timestamp remains equal (no false-positive churn)', () => {
    const before = asyncOrder({ voidedAt: new Timestamp(1_700_000_000, 123_456_789) });
    const after = asyncOrder({ voidedAt: new Timestamp(1_700_000_000, 123_456_789) });
    expect(relevantFieldsChanged('asyncOrders', before, after)).toBe(false);
  });

  test('plain SDK-serialized {_seconds,_nanoseconds} shape compares at sub-millisecond precision', () => {
    const before = asyncOrder({ voidedAt: { _seconds: 100, _nanoseconds: 1000 } });
    const after = asyncOrder({ voidedAt: { _seconds: 100, _nanoseconds: 2000 } });
    expect(relevantFieldsChanged('asyncOrders', before, after)).toBe(true);
  });

  test('a real Timestamp instance and an equivalent plain {seconds,nanoseconds} shape compare equal', () => {
    const before = asyncOrder({ voidedAt: new Timestamp(100, 5000) });
    const after = asyncOrder({ voidedAt: { seconds: 100, nanoseconds: 5000 } });
    expect(relevantFieldsChanged('asyncOrders', before, after)).toBe(false);
  });

  test('non-timestamp relevant-field equality is unaffected', () => {
    expect(relevantFieldsChanged('asyncOrders', asyncOrder({ status: 'a' }), asyncOrder({ status: 'a' }))).toBe(false);
    expect(relevantFieldsChanged('asyncOrders', asyncOrder({ status: 'a' }), asyncOrder({ status: 'b' }))).toBe(true);
    expect(relevantFieldsChanged('cashTransactions', cashTx({ amount: 100 }), cashTx({ amount: 100 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13-14. Missing/malformed shiftId
// ---------------------------------------------------------------------------

describe('missing/malformed shiftId', () => {
  test('missing shiftId on create -> no-op', () => {
    const after = asyncOrder({ shiftId: undefined });
    const result = planSourceEventRouting(createInput('asyncOrders', after));
    expect(result).toEqual({ kind: 'no_targets' });
  });

  test('empty-string shiftId -> no-op', () => {
    const after = order({ shiftId: '' });
    const result = planSourceEventRouting(createInput('orders', after));
    expect(result).toEqual({ kind: 'no_targets' });
  });

  test('creditPayments null shiftId -> no-op', () => {
    const after = creditPayment({ shiftId: null });
    const result = planSourceEventRouting(createInput('creditPayments', after));
    expect(result).toEqual({ kind: 'no_targets' });
  });

  test('deriveMembership rejects non-string shiftId', () => {
    expect(deriveMembership('cashTransactions', cashTx({ shiftId: 12345 }))).toEqual({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// 15. Retry classifier
// ---------------------------------------------------------------------------

describe('retry classifier', () => {
  test.each([4, 8, 10, 14])('numeric transient code %i is retryable', (code) => {
    expect(isRetryableFirestoreError({ code })).toBe(true);
  });

  test.each(['deadline-exceeded', 'resource-exhausted', 'aborted', 'unavailable'])('string transient code %s is retryable', (code) => {
    expect(isRetryableFirestoreError({ code })).toBe(true);
  });

  test('string code is case-insensitive', () => {
    expect(isRetryableFirestoreError({ code: 'UNAVAILABLE' })).toBe(true);
  });

  test('one-level cause code is honored', () => {
    expect(isRetryableFirestoreError({ cause: { code: 14 } })).toBe(true);
    expect(describeErrorCode({ cause: { code: 14 } })).toBe(14);
  });

  test('uncoded plain Error is permanent (non-retryable)', () => {
    expect(isRetryableFirestoreError(new Error('boom'))).toBe(false);
    expect(describeErrorCode(new Error('boom'))).toBe('unknown');
  });

  test('non-transient numeric code is permanent', () => {
    expect(isRetryableFirestoreError({ code: 5 })).toBe(false);
  });

  test('two-level nested cause is NOT honored (only one level)', () => {
    expect(isRetryableFirestoreError({ cause: { cause: { code: 14 } } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 16. Enqueue write-set
// ---------------------------------------------------------------------------

describe('enqueue write-set', () => {
  const advanceWatermark = { kind: 'advance', nextLastObservedCommitMicros: '500', nextCommitBoundaryDocKeys: ['orders:x'] } as const;

  test('exact field set on false->true pendingRevalidation transition', () => {
    const view = caseView({ pendingRevalidation: false, caseVersion: 3, sourceRevision: 7 });
    const write = buildEnqueueWriteSet({ caseView: view, watermark: advanceWatermark, sourceEventId: 'orders:x:500', eventId: 'event-x', nowMillis: 1_000_000 });
    expect(write).toEqual({
      caseVersion: 4,
      sourceRevision: 8,
      pendingRevalidation: true,
      processingState: 'queued',
      lastObservedCommitMicros: '500',
      commitBoundaryDocKeys: ['orders:x'],
      lastEnqueuedSourceEventId: 'orders:x:500',
      recentEnqueuedSourceEventIds: [buildLedgerEntryKey('orders:x:500', 'event-x')],
      nextEligibleAtMillis: 1_060_000,
    });
  });

  test('already-pending does not push the debounce window', () => {
    const view = caseView({ pendingRevalidation: true, caseVersion: 3, sourceRevision: 7 });
    const write = buildEnqueueWriteSet({ caseView: view, watermark: advanceWatermark, sourceEventId: 'orders:x:500', eventId: 'event-x', nowMillis: 1_000_000 });
    expect('nextEligibleAtMillis' in write).toBe(false);
    expect(Object.keys(write).sort()).toEqual(
      ['caseVersion', 'sourceRevision', 'pendingRevalidation', 'processingState', 'lastObservedCommitMicros', 'commitBoundaryDocKeys', 'lastEnqueuedSourceEventId', 'recentEnqueuedSourceEventIds'].sort(),
    );
  });

  test('unknown / red-zone fields are never present', () => {
    const view = caseView();
    const write = buildEnqueueWriteSet({ caseView: view, watermark: advanceWatermark, sourceEventId: 'orders:x:500', eventId: 'event-x', nowMillis: 0 });
    const forbidden = [
      'selectedRunId', 'selectedCloseHash', 'priorSelectedRunId', 'latestEvidenceId', 'latestCloseHash',
      'settlementState', 'alertState', 'leaseOwner', 'leaseExpiry', 'revalidationAttempts', 'updatedAt',
    ];
    for (const field of forbidden) {
      expect(field in write).toBe(false);
    }
  });

  test('append watermark keeps lastObservedCommitMicros unchanged', () => {
    const view = caseView({ lastObservedCommitMicros: '500', commitBoundaryDocKeys: ['orders:x'] });
    const appendWatermark = { kind: 'append', nextCommitBoundaryDocKeys: ['orders:x', 'orders:y'] } as const;
    const write = buildEnqueueWriteSet({ caseView: view, watermark: appendWatermark, sourceEventId: 'orders:y:500', eventId: 'event-y', nowMillis: 0 });
    expect(write.lastObservedCommitMicros).toBe('500');
    expect(write.commitBoundaryDocKeys).toEqual(['orders:x', 'orders:y']);
  });

  test('ledger FIFO-prunes to MAX_LEDGER_SIZE on append, keeping the most recent entries', () => {
    const fullLedger = Array.from({ length: MAX_LEDGER_SIZE }, (_, i) => `orders:doc-${i}:100#event-${i}`);
    const view = caseView({ recentEnqueuedSourceEventIds: fullLedger });
    const write = buildEnqueueWriteSet({ caseView: view, watermark: advanceWatermark, sourceEventId: 'orders:x:500', eventId: 'event-x', nowMillis: 0 });
    expect(write.recentEnqueuedSourceEventIds).toHaveLength(MAX_LEDGER_SIZE);
    expect(write.recentEnqueuedSourceEventIds[MAX_LEDGER_SIZE - 1]).toBe(buildLedgerEntryKey('orders:x:500', 'event-x'));
    expect(write.recentEnqueuedSourceEventIds).not.toContain(fullLedger[0]);
  });
});

// ---------------------------------------------------------------------------
// Target outcome dispatch (case_absent / branch_mismatch / watermark no-op)
// ---------------------------------------------------------------------------

describe('decideTargetOutcome dispatch', () => {
  const target: RouteTarget = {
    shiftId: 'shift-1',
    branchId: 'branch-1',
    deviceId: 'device-1',
    sourceKind: 'orders',
    sourceId: 'order-1',
    sourceEventId: 'orders:order-1:100',
    watermarkKey: 'orders:order-1',
    revisionToken: '100',
    eventId: 'event-1',
  };

  test('case absent -> case_absent, zero writes implied', () => {
    expect(decideTargetOutcome({ target, caseView: null, nowMillis: 0 })).toEqual({ kind: 'case_absent' });
  });

  test('branch known and mismatched -> branch_mismatch', () => {
    const view = caseView({ branchId: 'branch-OTHER' });
    expect(decideTargetOutcome({ target, caseView: view, nowMillis: 0 })).toEqual({
      kind: 'branch_mismatch',
      caseBranchId: 'branch-OTHER',
      targetBranchId: 'branch-1',
    });
  });

  test('branch unknown on case (null) skips the branch check', () => {
    const view = caseView({ branchId: null, lastObservedCommitMicros: '0', commitBoundaryDocKeys: [] });
    const outcome = decideTargetOutcome({ target, caseView: view, nowMillis: 0 });
    expect(outcome.kind).toBe('enqueue');
  });

  test('branch unknown on target (creditPayments) skips the branch check', () => {
    const cpTarget: RouteTarget = { ...target, sourceKind: 'creditPayments', branchId: null };
    const view = caseView({ branchId: 'branch-1' });
    const outcome = decideTargetOutcome({ target: cpTarget, caseView: view, nowMillis: 0 });
    expect(outcome.kind).toBe('enqueue');
  });
});

// ---------------------------------------------------------------------------
// micros helpers
// ---------------------------------------------------------------------------

describe('micros helpers', () => {
  test('microsFromSecondsNanos matches manual BigInt computation', () => {
    expect(microsFromSecondsNanos(1, 500_000_000)).toBe('1500000');
  });

  test('microsFromIsoString round-trips a known instant', () => {
    expect(microsFromIsoString('1970-01-01T00:00:01.000Z')).toBe('1000000');
  });
});
