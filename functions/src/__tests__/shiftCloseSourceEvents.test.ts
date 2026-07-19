import { describe, test, expect, vi, beforeEach } from 'vitest';

// Prove the TRIGGER WRAPPER / transaction WIRING (not the pure core in
// isolation): does a source-document write reach the right case CAS with
// the right reads/writes? Mirrors shiftCloseEvidenceCapture.test.ts's
// mocking pattern.

vi.mock('../deployConfig', () => ({ FIRESTORE_DATABASE_ID: 'pos-db', FUNCTIONS_REGION: 'asia-southeast1' }));

vi.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (opts: unknown, handler: unknown) => ({ __trigger: true, opts, handler }),
}));

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
  return {
    FieldValue: { serverTimestamp: () => ({ __fv: 'serverTimestamp' }) },
    Timestamp: FakeTimestamp,
  };
});

const { fakeState, dbMock } = vi.hoisted(() => {
  const fakeState = {
    caseSnap: { exists: false, get: (_f: string) => undefined } as { exists: boolean; get: (field: string) => unknown },
    updateCalls: [] as Array<{ path: string; data: Record<string, unknown> }>,
    getCalls: [] as string[],
    collectionCalls: [] as string[],
    runTransactionCalls: 0,
    transactionError: null as unknown,
  };

  function docRef(collection: string, id?: string) {
    return { __ref: true, collection, id, path: id ? `${collection}/${id}` : collection };
  }

  const dbMock = {
    collection: (name: string) => {
      fakeState.collectionCalls.push(name);
      return { doc: (id?: string) => docRef(name, id) };
    },
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
      fakeState.runTransactionCalls += 1;
      if (fakeState.transactionError) throw fakeState.transactionError;
      const tx = {
        get: async (ref: { path: string }) => {
          fakeState.getCalls.push(ref.path);
          return fakeState.caseSnap;
        },
        update: (ref: { path: string }, data: Record<string, unknown>) => {
          fakeState.updateCalls.push({ path: ref.path, data });
        },
      };
      await fn(tx);
    },
  };

  return { fakeState, dbMock };
});

vi.mock('../db', () => ({ db: dbMock }));

import {
  sourceEventOnWrite,
  processRouteTarget,
  shiftCloseSourceEventAsyncOrders,
  shiftCloseSourceEventOrders,
  shiftCloseSourceEventCashTransactions,
  shiftCloseSourceEventCreditPayments,
  type WrittenEvent,
} from '../shiftCloseSourceEvents';
import type { RouteTarget } from '../shiftCloseSourceEventsCore';

const SHIFT_ID = 'shift-1';
const EVENT_TIME = '2026-07-15T00:00:00.000Z';

function caseSnap(exists: boolean, extra: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    branchId: 'branch-1',
    caseVersion: 1,
    sourceRevision: 1,
    pendingRevalidation: false,
    lastObservedCommitMicros: '0',
    commitBoundaryDocKeys: [],
    ...extra,
  };
  return { exists, get: (field: string) => data[field] };
}

function baseTarget(overrides: Partial<RouteTarget> = {}): RouteTarget {
  return {
    shiftId: SHIFT_ID,
    branchId: 'branch-1',
    deviceId: 'device-1',
    sourceKind: 'orders',
    sourceId: 'order-1',
    sourceEventId: 'orders:order-1:1500000000000000',
    watermarkKey: 'orders:order-1',
    revisionToken: '1500000000000000',
    eventId: 'event-1',
    ...overrides,
  };
}

function writtenEvent(params: {
  paramName: string;
  paramValue: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  afterUpdateTime?: { seconds: number; nanoseconds: number };
  id?: string;
}): WrittenEvent {
  return {
    params: { [params.paramName]: params.paramValue },
    time: EVENT_TIME,
    id: params.id ?? 'event-1',
    data: {
      before: params.before !== undefined ? { exists: true, data: () => params.before } : { exists: false, data: () => undefined },
      after:
        params.after !== undefined
          ? { exists: true, data: () => params.after, updateTime: params.afterUpdateTime ?? { seconds: 1_600_000_000, nanoseconds: 0 } }
          : { exists: false, data: () => undefined },
    },
  };
}

beforeEach(() => {
  fakeState.caseSnap = caseSnap(false);
  fakeState.updateCalls = [];
  fakeState.getCalls = [];
  fakeState.collectionCalls = [];
  fakeState.runTransactionCalls = 0;
  fakeState.transactionError = null;
});

// ---------------------------------------------------------------------------
// 1. Successful enqueue CAS exact write-set
// ---------------------------------------------------------------------------

describe('successful enqueue', () => {
  test('exact write-set on a false->true pendingRevalidation transition', async () => {
    fakeState.caseSnap = caseSnap(true, { pendingRevalidation: false, caseVersion: 2, sourceRevision: 5 });
    const target = baseTarget();
    await processRouteTarget(target, 1_000_000);

    expect(fakeState.updateCalls).toHaveLength(1);
    expect(fakeState.updateCalls[0].path).toBe('shiftCloseCases/shift-1');
    expect(fakeState.updateCalls[0].data).toEqual({
      caseVersion: 3,
      sourceRevision: 6,
      pendingRevalidation: true,
      processingState: 'queued',
      lastObservedCommitMicros: target.revisionToken,
      commitBoundaryDocKeys: [target.watermarkKey],
      lastEnqueuedSourceEventId: target.sourceEventId,
      recentEnqueuedSourceEventIds: [`${target.sourceEventId}#${target.eventId}`],
      updatedAt: { __fv: 'serverTimestamp' },
      nextEligibleAt: expect.objectContaining({}),
    });
  });

  test('already-pending: no nextEligibleAt in the write', async () => {
    fakeState.caseSnap = caseSnap(true, { pendingRevalidation: true, caseVersion: 2, sourceRevision: 5 });
    const target = baseTarget();
    await processRouteTarget(target, 1_000_000);

    expect(fakeState.updateCalls).toHaveLength(1);
    expect('nextEligibleAt' in fakeState.updateCalls[0].data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2-3. Contention -> clean discard / zero writes
// ---------------------------------------------------------------------------

describe('contention discards cleanly', () => {
  test('case already advanced past this revision (stale) -> zero writes', async () => {
    fakeState.caseSnap = caseSnap(true, { lastObservedCommitMicros: '9999999999999999', commitBoundaryDocKeys: [] });
    const target = baseTarget({ revisionToken: '100' });
    await processRouteTarget(target, 0);
    expect(fakeState.updateCalls).toHaveLength(0);
  });

  test('case already recorded this exact watermark key at this revision -> zero writes', async () => {
    const target = baseTarget();
    fakeState.caseSnap = caseSnap(true, {
      caseVersion: 9,
      lastObservedCommitMicros: '1500000000000000',
      commitBoundaryDocKeys: ['orders:order-1'],
      // [RC-RR1-E-1] A prior writer that recorded this exact watermark key
      // for this exact revision was processing the SAME CloudEvent, so its
      // ledger entry is present too — the ledger dedup (step 3), not the
      // watermark's `duplicate` branch alone, is what a real redelivery of
      // the identical event now hits.
      recentEnqueuedSourceEventIds: [`${target.sourceEventId}#${target.eventId}`],
    });
    await processRouteTarget(target, 0);
    expect(fakeState.updateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Absent case -> no-op / zero writes
// ---------------------------------------------------------------------------

describe('absent case', () => {
  test('no-op, zero writes', async () => {
    fakeState.caseSnap = caseSnap(false);
    await processRouteTarget(baseTarget(), 0);
    expect(fakeState.updateCalls).toHaveLength(0);
    expect(fakeState.getCalls).toEqual(['shiftCloseCases/shift-1']);
  });
});

// ---------------------------------------------------------------------------
// 5. Branch mismatch -> hard-anomaly log + ACK / zero writes
// ---------------------------------------------------------------------------

describe('branch mismatch', () => {
  test('logs a structured anomaly and performs zero writes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeState.caseSnap = caseSnap(true, { branchId: 'branch-OTHER' });
    await processRouteTarget(baseTarget({ branchId: 'branch-1' }), 0);
    expect(fakeState.updateCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      '[shiftCloseSourceEvents] source_event_branch_mismatch',
      expect.objectContaining({ shiftId: SHIFT_ID, caseBranchId: 'branch-OTHER', targetBranchId: 'branch-1' }),
    );
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 6-7. Retry / permanent error classification
// ---------------------------------------------------------------------------

describe('error classification', () => {
  test('transient coded error throws (redelivery)', async () => {
    fakeState.transactionError = { code: 14 }; // UNAVAILABLE
    await expect(processRouteTarget(baseTarget(), 0)).rejects.toEqual({ code: 14 });
  });

  test('permanent/uncoded error logs and ACKs (no throw)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fakeState.transactionError = new Error('boom');
    await expect(processRouteTarget(baseTarget(), 0)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      '[shiftCloseSourceEvents] source_event_transaction_error_permanent',
      expect.objectContaining({ shiftId: SHIFT_ID, code: 'unknown' }),
    );
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 8. Double Eventarc delivery -> watermark no-op
// ---------------------------------------------------------------------------

describe('double delivery', () => {
  test('redelivering the same document write is a watermark no-op the second time', async () => {
    fakeState.caseSnap = caseSnap(true, { pendingRevalidation: false, caseVersion: 1, sourceRevision: 1 });
    const event = writtenEvent({
      paramName: 'orderId',
      paramValue: 'order-1',
      before: { shiftId: SHIFT_ID, branchId: 'branch-1', deviceId: 'device-1', status: 'pending' },
      after: { shiftId: SHIFT_ID, branchId: 'branch-1', deviceId: 'device-1', status: 'completed' },
      afterUpdateTime: { seconds: 1_600_000_000, nanoseconds: 0 },
    });

    await sourceEventOnWrite('orders', 'order-1', event);
    expect(fakeState.updateCalls).toHaveLength(1);

    // Simulate the case now reflecting the first delivery's effect, then redeliver the SAME event.
    fakeState.caseSnap = caseSnap(true, {
      caseVersion: fakeState.updateCalls[0].data.caseVersion,
      sourceRevision: fakeState.updateCalls[0].data.sourceRevision,
      pendingRevalidation: true,
      lastObservedCommitMicros: fakeState.updateCalls[0].data.lastObservedCommitMicros,
      commitBoundaryDocKeys: fakeState.updateCalls[0].data.commitBoundaryDocKeys,
      // [RC-RR1-E-1] The redelivery below reuses the identical `event` object
      // (same CloudEvent `id`), so the ledger the first delivery wrote must
      // be propagated too — a genuine redelivery is now caught by the ledger
      // dedup (step 3), not by the watermark's `duplicate` branch alone.
      recentEnqueuedSourceEventIds: fakeState.updateCalls[0].data.recentEnqueuedSourceEventIds,
    });
    fakeState.updateCalls = [];

    await sourceEventOnWrite('orders', 'order-1', event);
    expect(fakeState.updateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RC-1: end-to-end — a redelivered delete after a simulated P5-D-1 sweep
// boundary replacement produces zero writes through the real trigger wiring.
// ---------------------------------------------------------------------------

describe('RC-1: delete redelivery across a sweep (end-to-end through processRouteTarget)', () => {
  test('zero writes on redelivery once the case reflects a post-sweep boundary replacement', async () => {
    const target = baseTarget({
      sourceKind: 'orders',
      sourceId: 'deleted-order',
      sourceEventId: 'orders:deleted-order:del:200',
      watermarkKey: 'orders:deleted-order:del',
      revisionToken: '200',
      eventId: 'event-A',
    });

    // Case state AFTER a P5-D-1 sweep: lastObservedCommitMicros stayed at 200,
    // commitBoundaryDocKeys was replaced by the worker's own live scan (no
    // longer contains the deleted doc's key), but the durable ledger
    // (untouched by the worker) still records the router's own last delivery.
    fakeState.caseSnap = caseSnap(true, {
      lastObservedCommitMicros: '200',
      commitBoundaryDocKeys: ['orders:remaining'],
      lastEnqueuedSourceEventId: 'orders:deleted-order:del:200',
      recentEnqueuedSourceEventIds: ['orders:deleted-order:del:200#event-A'],
    });

    await processRouteTarget(target, 10_000);
    expect(fakeState.updateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RC-RR1: end-to-end — the durable FIFO ledger (Candidate E) closes the
// multi-tied-delete-event counterexample through the real trigger wiring.
// ---------------------------------------------------------------------------

describe('RC-RR1: durable tied-event ledger (end-to-end through processRouteTarget)', () => {
  test('zero writes on redelivery of the earlier/non-latest tied event after a post-sweep boundary replacement', async () => {
    const targetA = baseTarget({
      sourceKind: 'orders',
      sourceId: 'deleted-A',
      sourceEventId: 'orders:deleted-A:del:200',
      watermarkKey: 'orders:deleted-A:del',
      revisionToken: '200',
      eventId: 'event-A',
    });
    // Post-sweep: boundary replaced (both deleted docs dropped), but the
    // ledger (untouched by the worker) still holds both tied siblings.
    fakeState.caseSnap = caseSnap(true, {
      lastObservedCommitMicros: '200',
      commitBoundaryDocKeys: ['orders:remaining'],
      lastEnqueuedSourceEventId: 'orders:deleted-B:del:200',
      recentEnqueuedSourceEventIds: ['orders:deleted-A:del:200#event-A', 'orders:deleted-B:del:200#event-B'],
    });

    await processRouteTarget(targetA, 0);
    expect(fakeState.updateCalls).toHaveLength(0);
  });

  test('zero writes on redelivery of the latest tied event after a post-sweep boundary replacement', async () => {
    const targetB = baseTarget({
      sourceKind: 'orders',
      sourceId: 'deleted-B',
      sourceEventId: 'orders:deleted-B:del:200',
      watermarkKey: 'orders:deleted-B:del',
      revisionToken: '200',
      eventId: 'event-B',
    });
    fakeState.caseSnap = caseSnap(true, {
      lastObservedCommitMicros: '200',
      commitBoundaryDocKeys: ['orders:remaining'],
      lastEnqueuedSourceEventId: 'orders:deleted-B:del:200',
      recentEnqueuedSourceEventIds: ['orders:deleted-A:del:200#event-A', 'orders:deleted-B:del:200#event-B'],
    });

    await processRouteTarget(targetB, 0);
    expect(fakeState.updateCalls).toHaveLength(0);
  });

  test('WrittenEvent fixtures carry id and thread it into the ledger key material', async () => {
    fakeState.caseSnap = caseSnap(true, { pendingRevalidation: false, caseVersion: 2, sourceRevision: 5 });
    const event = writtenEvent({
      paramName: 'orderId',
      paramValue: 'order-1',
      before: { shiftId: SHIFT_ID, branchId: 'branch-1', deviceId: 'device-1', status: 'pending' },
      after: { shiftId: SHIFT_ID, branchId: 'branch-1', deviceId: 'device-1', status: 'completed' },
      afterUpdateTime: { seconds: 1_600_000_000, nanoseconds: 0 },
      id: 'event-distinctive',
    });

    await sourceEventOnWrite('orders', 'order-1', event);
    expect(fakeState.updateCalls).toHaveLength(1);
    const write = fakeState.updateCalls[0].data;
    expect(write.recentEnqueuedSourceEventIds).toEqual([`${write.lastEnqueuedSourceEventId}#event-distinctive`]);
  });

  test('case snapshot without recentEnqueuedSourceEventIds defaults to an empty ledger and still enqueues normally', async () => {
    // Simulates a case created before this remediation: no ledger field at all
    // (caseSnap's default `extra` omits it, so snap.get('recentEnqueuedSourceEventIds') is undefined).
    fakeState.caseSnap = caseSnap(true, { pendingRevalidation: false, caseVersion: 2, sourceRevision: 5 });
    const target = baseTarget();

    await processRouteTarget(target, 0);
    expect(fakeState.updateCalls).toHaveLength(1);
    expect(fakeState.updateCalls[0].data.recentEnqueuedSourceEventIds).toEqual([`${target.sourceEventId}#${target.eventId}`]);
  });

  test('transaction update writes the ledger field with FIFO cap enforced', async () => {
    const fullLedger = Array.from({ length: 24 }, (_, i) => `orders:doc-${i}:100#event-${i}`);
    fakeState.caseSnap = caseSnap(true, { recentEnqueuedSourceEventIds: fullLedger });
    await processRouteTarget(baseTarget({ revisionToken: '9999999999999999' }), 0);
    expect(fakeState.updateCalls).toHaveLength(1);
    const ledger = fakeState.updateCalls[0].data.recentEnqueuedSourceEventIds as string[];
    expect(ledger).toHaveLength(24);
    expect(ledger).not.toContain(fullLedger[0]);
  });
});

// ---------------------------------------------------------------------------
// RC-RR1-E-1: end-to-end — a different CloudEvent ID sharing the same
// derived sourceEventId/revision must enqueue (not be swallowed by the
// watermark's `duplicate` classification) under the NORMAL (non-swept)
// boundary state, where the source boundary key is still present.
// ---------------------------------------------------------------------------

describe('RC-RR1-E-1: CloudEvent ID distinct-event override (end-to-end through processRouteTarget)', () => {
  test('a different CloudEvent ID enqueues and records its own ledger entry under the normal boundary state', async () => {
    const target = baseTarget({
      sourceKind: 'orders',
      sourceId: 'collided',
      sourceEventId: 'orders:collided:del:200',
      watermarkKey: 'orders:collided:del',
      revisionToken: '200',
      eventId: 'event-distinct',
    });
    // Normal post-first-enqueue state: boundary key present, ledger holds
    // only the ORIGINAL CloudEvent id for this exact sourceEventId/revision.
    fakeState.caseSnap = caseSnap(true, {
      lastObservedCommitMicros: '200',
      commitBoundaryDocKeys: ['orders:collided:del'],
      lastEnqueuedSourceEventId: 'orders:collided:del:200',
      recentEnqueuedSourceEventIds: ['orders:collided:del:200#event-original'],
    });

    await processRouteTarget(target, 0);
    expect(fakeState.updateCalls).toHaveLength(1);
    const write = fakeState.updateCalls[0].data;
    expect(write.recentEnqueuedSourceEventIds).toEqual(['orders:collided:del:200#event-original', 'orders:collided:del:200#event-distinct']);
    expect(write.lastObservedCommitMicros).toBe('200');
    expect(write.commitBoundaryDocKeys).toEqual(['orders:collided:del']);
  });

  test('the same CloudEvent ID under the same normal boundary state still no-ops', async () => {
    const target = baseTarget({
      sourceKind: 'orders',
      sourceId: 'collided',
      sourceEventId: 'orders:collided:del:200',
      watermarkKey: 'orders:collided:del',
      revisionToken: '200',
      eventId: 'event-original',
    });
    fakeState.caseSnap = caseSnap(true, {
      lastObservedCommitMicros: '200',
      commitBoundaryDocKeys: ['orders:collided:del'],
      lastEnqueuedSourceEventId: 'orders:collided:del:200',
      recentEnqueuedSourceEventIds: ['orders:collided:del:200#event-original'],
    });

    await processRouteTarget(target, 0);
    expect(fakeState.updateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9-10. No writes outside shiftCloseCases; no evidence/run/audit/alert/cursor
// ---------------------------------------------------------------------------

describe('write surface containment', () => {
  test('every write targets shiftCloseCases only, and no other collection is ever opened', async () => {
    fakeState.caseSnap = caseSnap(true, { pendingRevalidation: false });
    await processRouteTarget(baseTarget(), 0);
    expect(fakeState.updateCalls.every((c) => c.path.startsWith('shiftCloseCases/'))).toBe(true);
    const forbidden = ['shiftCloseValidationRuns', 'shiftCloseEvidence', 'shiftCloseAuditEvents', 'shiftCloseAlerts', 'shiftCloseSweepCursor', 'shifts'];
    for (const name of forbidden) {
      expect(fakeState.collectionCalls).not.toContain(name);
    }
    expect(new Set(fakeState.collectionCalls)).toEqual(new Set(['shiftCloseCases']));
  });
});

// ---------------------------------------------------------------------------
// 11-12. Trigger paths exactly; no shifts trigger
// ---------------------------------------------------------------------------

describe('trigger export shape', () => {
  test('four triggers bind the exact expected document paths, database, region, retry', () => {
    const triggers = [
      { fn: shiftCloseSourceEventAsyncOrders, document: 'asyncOrders/{orderId}' },
      { fn: shiftCloseSourceEventOrders, document: 'orders/{orderId}' },
      { fn: shiftCloseSourceEventCashTransactions, document: 'cashTransactions/{txId}' },
      { fn: shiftCloseSourceEventCreditPayments, document: 'creditPayments/{paymentId}' },
    ] as const;

    for (const { fn, document } of triggers) {
      const t = fn as unknown as { __trigger: true; opts: Record<string, unknown> };
      expect(t.__trigger).toBe(true);
      expect(t.opts).toMatchObject({ document, database: 'pos-db', region: 'asia-southeast1', retry: true });
    }
  });

  test('no trigger binds a shifts/{shiftId} document', () => {
    const triggers = [shiftCloseSourceEventAsyncOrders, shiftCloseSourceEventOrders, shiftCloseSourceEventCashTransactions, shiftCloseSourceEventCreditPayments];
    for (const fn of triggers) {
      const t = fn as unknown as { opts: { document: string } };
      expect(t.opts.document.startsWith('shifts/')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// sourceEventOnWrite: no-op routing exits before any Firestore read
// ---------------------------------------------------------------------------

describe('sourceEventOnWrite zero-read no-op', () => {
  test('non-relevant churn performs zero case reads', async () => {
    const event = writtenEvent({
      paramName: 'txId',
      paramValue: 'tx-1',
      before: { id: 'tx-1', shiftId: SHIFT_ID, branchId: 'branch-1', type: 'pay_in', amount: 100, note: 'a' },
      after: { id: 'tx-1', shiftId: SHIFT_ID, branchId: 'branch-1', type: 'pay_in', amount: 100, note: 'b' },
    });
    await sourceEventOnWrite('cashTransactions', 'tx-1', event);
    expect(fakeState.getCalls).toHaveLength(0);
    expect(fakeState.updateCalls).toHaveLength(0);
  });

  test('missing shiftId performs zero case reads', async () => {
    const event = writtenEvent({
      paramName: 'paymentId',
      paramValue: 'pay-1',
      after: { id: 'pay-1', paymentMethod: 'cash', amount: 500 },
    });
    await sourceEventOnWrite('creditPayments', 'pay-1', event);
    expect(fakeState.getCalls).toHaveLength(0);
    expect(fakeState.updateCalls).toHaveLength(0);
  });
});
