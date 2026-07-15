import { describe, test, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Prove the TRIGGER WRAPPER / transaction WIRING (not the pure core in
// isolation): does a close event reach the right decision path with the
// right reads/writes? Mirrors reconcileTrigger.test.ts's mocking pattern.

vi.mock('../deployConfig', () => ({ FIRESTORE_DATABASE_ID: 'pos-db', FUNCTIONS_REGION: 'asia-southeast1' }));

vi.mock('firebase-functions/v2/firestore', () => ({
  // Capture the options object so the export-shape test can assert retry:true.
  onDocumentWritten: (opts: unknown, handler: unknown) => ({ __trigger: true, opts, handler }),
}));

// A lightweight fake Timestamp (not the real Admin SDK class, which triggers
// Google Auth project-id detection on import in a test/node environment with
// no ambient credentials). Supports the exact surface the core module and
// this test file use: fromMillis/toMillis/instanceof.
vi.mock('firebase-admin/firestore', () => {
  class FakeTimestamp {
    private readonly millis: number;
    constructor(millis: number) {
      this.millis = millis;
    }
    static fromMillis(ms: number): FakeTimestamp {
      return new FakeTimestamp(ms);
    }
    static now(): FakeTimestamp {
      return new FakeTimestamp(Date.now());
    }
    toMillis(): number {
      return this.millis;
    }
    toDate(): Date {
      return new Date(this.millis);
    }
  }
  return {
    FieldValue: { serverTimestamp: () => ({ __fv: 'serverTimestamp' }) },
    Timestamp: FakeTimestamp,
  };
});

const { fakeState, dbMock } = vi.hoisted(() => {
  const fakeState = {
    evidenceSnap: { exists: false, id: '', get: (_f: string) => undefined } as {
      exists: boolean;
      id: string;
      get: (field: string) => unknown;
    },
    caseSnap: { exists: false, id: '', get: (_f: string) => undefined } as {
      exists: boolean;
      id: string;
      get: (field: string) => unknown;
    },
    createCalls: [] as Array<{ path: string; data: Record<string, unknown> }>,
    updateCalls: [] as Array<{ path: string; data: Record<string, unknown> }>,
    runTransactionCalls: 0,
    // `unknown`, not `Error` — B1 tests inject coded plain objects
    // (`{ code: 'unavailable' }`) as well as real `Error` instances, since
    // the classifier under test must key off a stable `.code`, never
    // `instanceof Error` or message text.
    transactionError: null as unknown,
  };

  function docRef(collection: string, id?: string) {
    return { __ref: true, collection, id, path: id ? `${collection}/${id}` : collection };
  }

  const dbMock = {
    collection: (name: string) => ({ doc: (id?: string) => docRef(name, id) }),
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
      fakeState.runTransactionCalls += 1;
      if (fakeState.transactionError) throw fakeState.transactionError;
      const tx = {
        getAll: async (...refs: Array<{ collection: string }>) =>
          refs.map((ref) => (ref.collection === 'shiftCloseCases' ? fakeState.caseSnap : fakeState.evidenceSnap)),
        create: (ref: { path: string }, data: Record<string, unknown>) => {
          fakeState.createCalls.push({ path: ref.path, data });
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

import { captureOnWrite, shiftCloseEvidenceCapture } from '../shiftCloseEvidenceCapture';
import { planCapture, SCHEMA_VERSION, type IncomingCapture } from '../shiftCloseEvidenceCaptureCore';
import { Timestamp } from 'firebase-admin/firestore';

const EVENT_TIME = '2026-07-15T00:00:00.000Z';
const SHIFT_ID = 'shift-1';

function baseAfter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'closed',
    branchId: 'branch-1',
    staffId: 'staff-1',
    deviceId: 'device-1',
    closedAt: Timestamp.fromMillis(1_700_000_000_000),
    startingCash: 1000,
    actualCashCount: 1050,
    variance: 50,
    expectedCash: 1000,
    expectedQr: 200,
    expectedKbank: 300,
    expectedCard: 400,
    expectedCredit: 0,
    payInTotal: 100,
    payOutTotal: 50,
    totalBills: 12,
    note: 'ok',
    cashEntries: [],
    ...overrides,
  };
}

function computeFixture(afterOverrides: Record<string, unknown> = {}): { after: Record<string, unknown>; capture: IncomingCapture } {
  const after = baseAfter(afterOverrides);
  const result = planCapture({ shiftId: SHIFT_ID, before: { status: 'open' }, after, eventTimeIso: EVENT_TIME });
  if (result.kind !== 'capture') throw new Error(`fixture setup failed: ${JSON.stringify(result)}`);
  return { after, capture: result.capture };
}

function matchingEvidenceSnap(capture: IncomingCapture) {
  const data: Record<string, unknown> = {
    evidenceId: capture.evidenceId,
    shiftId: capture.shiftId,
    closeHash: capture.closeHash,
    sourceCloseDocPath: capture.sourceCloseDocPath,
    branchId: capture.branchId,
    staffId: capture.staffId,
    deviceId: capture.deviceId,
    schemaVersion: SCHEMA_VERSION,
  };
  return { exists: true, id: capture.evidenceId, get: (field: string) => data[field] };
}

function matchingCaseSnap(capture: IncomingCapture, extra: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    shiftId: capture.shiftId,
    branchId: capture.branchId,
    staffId: capture.staffId,
    deviceId: capture.deviceId,
    schemaVersion: SCHEMA_VERSION,
    caseVersion: 1,
    sourceRevision: 1,
    ...extra,
  };
  return { exists: true, id: capture.shiftId, get: (field: string) => data[field] };
}

const SERVER_TS = { __fv: 'serverTimestamp' };

/** Exact expected evidence document (core fields + adapter-added timestamp sentinels). */
function expectedEvidenceDoc(capture: IncomingCapture): Record<string, unknown> {
  return {
    evidenceId: capture.evidenceId,
    shiftId: capture.shiftId,
    closeHash: capture.closeHash,
    branchId: capture.branchId,
    staffId: capture.staffId,
    deviceId: capture.deviceId,
    startingCash: capture.startingCash,
    actualCashCount: capture.actualCashCount,
    variance: capture.variance,
    expectedCash: capture.expectedCash,
    expectedQr: capture.expectedQr,
    expectedKbank: capture.expectedKbank,
    expectedCard: capture.expectedCard,
    expectedCredit: capture.expectedCredit,
    payInTotal: capture.payInTotal,
    payOutTotal: capture.payOutTotal,
    totalBills: capture.totalBills,
    note: capture.note,
    cashEntriesSnapshot: capture.cashEntriesSnapshot,
    cashEntriesSnapshotMeta: capture.cashEntriesSnapshotMeta,
    cashEntriesDigest: capture.cashEntriesDigest,
    cashEntriesFullDigest: capture.cashEntriesFullDigest,
    sourceEntryCount: capture.sourceEntryCount,
    sourceCloseDocPath: capture.sourceCloseDocPath,
    observedShiftStatus: 'closed',
    observedClosedAt: capture.observedClosedAt,
    schemaVersion: SCHEMA_VERSION,
    capturedAt: SERVER_TS,
    createdAt: SERVER_TS,
  };
}

/** Exact expected case-init document. */
function expectedCaseInitDoc(capture: IncomingCapture): Record<string, unknown> {
  return {
    shiftId: capture.shiftId,
    branchId: capture.branchId,
    staffId: capture.staffId,
    deviceId: capture.deviceId,
    selectedRunId: null,
    selectedCloseHash: null,
    priorSelectedRunId: null,
    latestEvidenceId: capture.evidenceId,
    latestCloseHash: capture.closeHash,
    processingState: 'queued',
    settlementState: 'unsettled',
    alertState: 'none',
    caseVersion: 1,
    sourceRevision: 1,
    pendingRevalidation: true,
    lastObservedCommitMicros: '0',
    commitBoundaryDocKeys: [],
    lastEnqueuedSourceEventId: null,
    revalidationAttempts: 0,
    leaseOwner: null,
    leaseExpiry: null,
    lateEventHorizonUntil: capture.lateEventHorizonUntil,
    sweepEligible: true,
    schemaVersion: SCHEMA_VERSION,
    nextEligibleAt: SERVER_TS,
    createdAt: SERVER_TS,
    updatedAt: SERVER_TS,
  };
}

/** Exact expected audit document (init: caseVersion 1; conflict: caller-supplied bumped version). */
function expectedAuditDoc(capture: IncomingCapture, caseVersion: number, eventId: string): Record<string, unknown> {
  return {
    eventId,
    shiftId: capture.shiftId,
    caseVersion,
    runId: null,
    transitionType: 'evidence_captured',
    actor: { kind: 'system' },
    reasonCode: null,
    note: null,
    branchId: capture.branchId,
    schemaVersion: SCHEMA_VERSION,
    createdAt: SERVER_TS,
  };
}

/** Exact expected alert-init document. */
function expectedAlertInitDoc(capture: IncomingCapture): Record<string, unknown> {
  return {
    alertState: 'none',
    reasonCode: null,
    openedAt: null,
    acknowledgedByActor: null,
    resolvedByActor: null,
    caseVersion: 1,
    branchId: capture.branchId,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: SERVER_TS,
  };
}

/** Exact expected case-update document on a conflict close. */
function expectedCaseUpdateDoc(capture: IncomingCapture, caseVersion: number, sourceRevision: number): Record<string, unknown> {
  return {
    caseVersion,
    sourceRevision,
    latestEvidenceId: capture.evidenceId,
    latestCloseHash: capture.closeHash,
    pendingRevalidation: true,
    updatedAt: SERVER_TS,
  };
}

function event(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined, time = EVENT_TIME) {
  return {
    params: { shiftId: SHIFT_ID },
    time,
    data: {
      before: before ? { exists: true, data: () => before } : { exists: false, data: () => undefined },
      after: after ? { exists: true, data: () => after } : { exists: false, data: () => undefined },
    },
  };
}

beforeEach(() => {
  fakeState.evidenceSnap = { exists: false, id: '', get: () => undefined };
  fakeState.caseSnap = { exists: false, id: '', get: () => undefined };
  fakeState.createCalls = [];
  fakeState.updateCalls = [];
  fakeState.runTransactionCalls = 0;
  fakeState.transactionError = null;
});

describe('shiftCloseEvidenceCapture export shape', () => {
  test('trigger options assert retry === true, correct document/database/region', () => {
    expect((shiftCloseEvidenceCapture as unknown as { opts: unknown }).opts).toEqual({
      document: 'shifts/{shiftId}',
      database: 'pos-db',
      region: 'asia-southeast1',
      retry: true,
    });
  });

  test('index.ts exports shiftCloseEvidenceCapture', () => {
    const indexPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');
    const source = readFileSync(indexPath, 'utf8');
    expect(source).toContain("export { shiftCloseEvidenceCapture } from './shiftCloseEvidenceCapture'");
  });

  test('functions/package.json deploy allowlist includes functions:shiftCloseEvidenceCapture', () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts: { deploy: string } };
    expect(pkg.scripts.deploy).toContain('functions:shiftCloseEvidenceCapture');
  });

  test('no exported callable named anything like recaptureShiftCloseEvidence exists in index.ts', () => {
    const indexPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');
    const source = readFileSync(indexPath, 'utf8');
    expect(source.toLowerCase()).not.toContain('recapture');
  });
});

describe('captureOnWrite — trigger routing', () => {
  test('a non-close update is NOT routed into a transaction', async () => {
    await captureOnWrite(event({ status: 'open' }, { status: 'open' }));
    expect(fakeState.runTransactionCalls).toBe(0);
  });

  test('a closed-to-closed irrelevant update is NOT routed into a transaction', async () => {
    await captureOnWrite(event({ status: 'closed' }, { status: 'closed' }));
    expect(fakeState.runTransactionCalls).toBe(0);
  });

  test('a deleted doc is ignored', async () => {
    await captureOnWrite(event({ status: 'closed' }, undefined));
    expect(fakeState.runTransactionCalls).toBe(0);
  });

  test('a structural refusal (wrong-type field) does NOT throw and touches no transaction', async () => {
    const after = baseAfter({ expectedCash: 'not-a-number' });
    await expect(captureOnWrite(event({ status: 'open' }, after))).resolves.toBeUndefined();
    expect(fakeState.runTransactionCalls).toBe(0);
    expect(fakeState.createCalls).toHaveLength(0);
  });

  test('a close transition reads BOTH case and evidence refs via one transaction', async () => {
    const { after } = computeFixture();
    await captureOnWrite(event({ status: 'open' }, after));
    expect(fakeState.runTransactionCalls).toBe(1);
  });
});

describe('captureOnWrite — init write shape', () => {
  test('creates exactly evidence + case + audit + alert, no shifts write', async () => {
    const { after } = computeFixture();
    await captureOnWrite(event({ status: 'open' }, after));

    expect(fakeState.createCalls).toHaveLength(4);
    expect(fakeState.updateCalls).toHaveLength(0);

    const collections = fakeState.createCalls.map((c) => c.path.split('/')[0]).sort();
    expect(collections).toEqual(['shiftCloseAlerts', 'shiftCloseAuditEvents', 'shiftCloseCases', 'shiftCloseEvidence']);

    for (const call of fakeState.createCalls) {
      expect(call.path.startsWith('shifts/')).toBe(false);
    }
  });

  test('evidence init document — exact whole-document write, including serverTimestamp sentinels', async () => {
    const { after, capture } = computeFixture();
    await captureOnWrite(event({ status: 'open' }, after));

    const evidenceCall = fakeState.createCalls.find((c) => c.path.startsWith('shiftCloseEvidence/'));
    expect(evidenceCall?.path).toBe(`shiftCloseEvidence/${capture.evidenceId}`);
    expect(evidenceCall?.data).toEqual(expectedEvidenceDoc(capture));
  });

  test('case init document — exact whole-document write, including serverTimestamp sentinels', async () => {
    const { after, capture } = computeFixture();
    await captureOnWrite(event({ status: 'open' }, after));

    const caseCall = fakeState.createCalls.find((c) => c.path.startsWith('shiftCloseCases/'));
    expect(caseCall?.path).toBe(`shiftCloseCases/${capture.shiftId}`);
    expect(caseCall?.data).toEqual(expectedCaseInitDoc(capture));
  });

  test('audit init document — exact whole-document write, including serverTimestamp sentinel', async () => {
    const { after, capture } = computeFixture();
    await captureOnWrite(event({ status: 'open' }, after));

    const auditCall = fakeState.createCalls.find((c) => c.path.startsWith('shiftCloseAuditEvents/'));
    expect(auditCall).toBeDefined();
    const eventId = auditCall!.path.split('/')[1];
    expect(auditCall?.data).toEqual(expectedAuditDoc(capture, 1, eventId));
  });

  test('alert init document — exact whole-document write, including serverTimestamp sentinel', async () => {
    const { after, capture } = computeFixture();
    await captureOnWrite(event({ status: 'open' }, after));

    const alertCall = fakeState.createCalls.find((c) => c.path.startsWith('shiftCloseAlerts/'));
    expect(alertCall?.path).toBe(`shiftCloseAlerts/${capture.shiftId}`);
    expect(alertCall?.data).toEqual(expectedAlertInitDoc(capture));
  });
});

describe('captureOnWrite — conflict write shape', () => {
  test('conflict evidence + audit documents — exact whole-document writes', async () => {
    const { after, capture } = computeFixture({ actualCashCount: 5000 });
    fakeState.caseSnap = matchingCaseSnap(capture, { caseVersion: 1, sourceRevision: 1 });
    fakeState.evidenceSnap = { exists: false, id: '', get: () => undefined };

    await captureOnWrite(event({ status: 'open' }, after));

    const evidenceCall = fakeState.createCalls.find((c) => c.path.startsWith('shiftCloseEvidence/'));
    expect(evidenceCall?.data).toEqual(expectedEvidenceDoc(capture));

    const auditCall = fakeState.createCalls.find((c) => c.path.startsWith('shiftCloseAuditEvents/'));
    const eventId = auditCall!.path.split('/')[1];
    expect(auditCall?.data).toEqual(expectedAuditDoc(capture, 2, eventId));
  });

  test('conflict case update — exact field set, never touches selected*/alert', async () => {
    const { after, capture } = computeFixture({ actualCashCount: 5000 });
    fakeState.caseSnap = matchingCaseSnap(capture, { caseVersion: 1, sourceRevision: 1 });
    fakeState.evidenceSnap = { exists: false, id: '', get: () => undefined };

    await captureOnWrite(event({ status: 'open' }, after));

    expect(fakeState.updateCalls).toHaveLength(1);
    expect(fakeState.updateCalls[0]?.path).toBe(`shiftCloseCases/${capture.shiftId}`);
    expect(fakeState.updateCalls[0]?.data).toEqual(expectedCaseUpdateDoc(capture, 2, 2));
    // No alert write at all on conflict (alert init-only, unchanged afterward).
    expect(fakeState.createCalls.some((c) => c.path.startsWith('shiftCloseAlerts/'))).toBe(false);
  });
});

describe('captureOnWrite — noop / anomaly routing (all four disjoint outcomes, adapter-level)', () => {
  test('matching existing evidence + case -> true no-op, zero writes', async () => {
    const { after, capture } = computeFixture();
    fakeState.evidenceSnap = matchingEvidenceSnap(capture);
    fakeState.caseSnap = matchingCaseSnap(capture);

    await captureOnWrite(event({ status: 'open' }, after));

    expect(fakeState.createCalls).toHaveLength(0);
    expect(fakeState.updateCalls).toHaveLength(0);
  });

  test('evidence identity mismatch (case present, valid) -> capture_anomaly_evidence_identity_mismatch, zero writes, no throw', async () => {
    const { after, capture } = computeFixture();
    fakeState.caseSnap = matchingCaseSnap(capture);
    fakeState.evidenceSnap = {
      ...matchingEvidenceSnap(capture),
      get: (field: string) => (field === 'deviceId' ? 'wrong-device' : matchingEvidenceSnap(capture).get(field)),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(captureOnWrite(event({ status: 'open' }, after))).resolves.toBeUndefined();
    expect(fakeState.createCalls).toHaveLength(0);
    expect(fakeState.updateCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith('[shiftCloseEvidenceCapture] capture_anomaly_evidence_identity_mismatch', expect.anything());
    warnSpy.mockRestore();
  });

  test('case identity mismatch (evidence absent) -> capture_anomaly_case_identity_mismatch, zero writes, no throw (NOT a conflict)', async () => {
    const { after, capture } = computeFixture();
    fakeState.evidenceSnap = { exists: false, id: '', get: () => undefined };
    fakeState.caseSnap = { ...matchingCaseSnap(capture), get: (field: string) => (field === 'branchId' ? 'wrong-branch' : matchingCaseSnap(capture).get(field)) };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(captureOnWrite(event({ status: 'open' }, after))).resolves.toBeUndefined();
    expect(fakeState.createCalls).toHaveLength(0);
    expect(fakeState.updateCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith('[shiftCloseEvidenceCapture] capture_anomaly_case_identity_mismatch', expect.anything());
    warnSpy.mockRestore();
  });

  test('evidence present valid, case absent -> capture_anomaly_evidence_without_case, zero writes, no throw', async () => {
    const { after, capture } = computeFixture();
    fakeState.evidenceSnap = matchingEvidenceSnap(capture);
    fakeState.caseSnap = { exists: false, id: '', get: () => undefined };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(captureOnWrite(event({ status: 'open' }, after))).resolves.toBeUndefined();
    expect(fakeState.createCalls).toHaveLength(0);
    expect(fakeState.updateCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith('[shiftCloseEvidenceCapture] capture_anomaly_evidence_without_case', expect.anything());
    warnSpy.mockRestore();
  });

  test('case exists (evidence absent) -> conflict-close: create evidence+audit, update case', async () => {
    const { after, capture } = computeFixture({ actualCashCount: 5000 });
    fakeState.caseSnap = matchingCaseSnap(capture, { caseVersion: 1, sourceRevision: 1 });
    fakeState.evidenceSnap = { exists: false, id: '', get: () => undefined };

    await captureOnWrite(event({ status: 'open' }, after));

    expect(fakeState.createCalls).toHaveLength(2);
    expect(fakeState.updateCalls).toHaveLength(1);
    expect(fakeState.updateCalls[0]?.data).toMatchObject({ caseVersion: 2, sourceRevision: 2, latestEvidenceId: capture.evidenceId });
  });
});

// ---------------------------------------------------------------------------
// B1 — Retry/throw taxonomy (Codex blocker B1). All errors here are injected
// as `fakeState.transactionError`, which the fake `db.runTransaction` throws
// BEFORE invoking the transaction callback — i.e. the whole
// `db.runTransaction(...)` call rejects, exactly like a real Admin SDK
// transaction failure or a synchronous throw from inside the callback would
// propagate out of `runTransaction`. Retryability must come ONLY from
// `error.code` / `error.cause.code`, never from `error.message` text.
// ---------------------------------------------------------------------------

describe('captureOnWrite — retry/throw taxonomy', () => {
  test.each(['deadline-exceeded', 'unavailable', 'aborted'])(
    'coded transient string error %s THROWS (so retry:true can redeliver)',
    async (code) => {
      const { after } = computeFixture();
      fakeState.transactionError = { code, message: 'transient' };
      await expect(captureOnWrite(event({ status: 'open' }, after))).rejects.toBe(fakeState.transactionError);
    },
  );

  test('coded transient numeric gRPC error (14 = UNAVAILABLE) THROWS', async () => {
    const { after } = computeFixture();
    fakeState.transactionError = { code: 14, message: 'transient' };
    await expect(captureOnWrite(event({ status: 'open' }, after))).rejects.toBe(fakeState.transactionError);
  });

  test('nested cause.code transient error THROWS', async () => {
    const { after } = computeFixture();
    fakeState.transactionError = { message: 'wrapped', cause: { code: 'aborted' } };
    await expect(captureOnWrite(event({ status: 'open' }, after))).rejects.toBe(fakeState.transactionError);
  });

  test('a plain un-coded Error("DEADLINE_EXCEEDED") does NOT throw — message text is never used to infer retryability', async () => {
    const { after } = computeFixture();
    fakeState.transactionError = new Error('DEADLINE_EXCEEDED');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(captureOnWrite(event({ status: 'open' }, after))).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      '[shiftCloseEvidenceCapture] capture_transaction_error_permanent',
      expect.objectContaining({ code: 'unknown' }),
    );
    errorSpy.mockRestore();
  });

  test('a local invariant/schema/programmer error (plain Error, no code) does NOT throw — ACK, structured-logged', async () => {
    const { after } = computeFixture();
    fakeState.transactionError = new Error('invariant violation: init alert projection failed isValidAlertProjection');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(captureOnWrite(event({ status: 'open' }, after))).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test.each(['invalid-argument', 'failed-precondition', 'permission-denied', 'not-found', 'already-exists'])(
    'coded permanent error %s does NOT throw — ACK, structured-logged with the code',
    async (code) => {
      const { after } = computeFixture();
      fakeState.transactionError = { code, message: 'permanent' };
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(captureOnWrite(event({ status: 'open' }, after))).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith('[shiftCloseEvidenceCapture] capture_transaction_error_permanent', expect.objectContaining({ code }));
      errorSpy.mockRestore();
    },
  );

  test('unknown/non-coded object error does NOT throw — ACK', async () => {
    const { after } = computeFixture();
    fakeState.transactionError = { foo: 'bar' };
    await expect(captureOnWrite(event({ status: 'open' }, after))).resolves.toBeUndefined();
  });

  test('structural refusal (before any transaction) still does not throw — unaffected by the classifier', async () => {
    const after = baseAfter({ expectedCash: 'not-a-number' });
    await expect(captureOnWrite(event({ status: 'open' }, after))).resolves.toBeUndefined();
    expect(fakeState.runTransactionCalls).toBe(0);
  });

  test('cross-invocation redelivery: coded aborted failure then a clean redelivery succeeds (NOT real Firestore contention — models Eventarc redelivery between two separate invocations, since this repo has no functions-emulator transaction harness)', async () => {
    const { after, capture } = computeFixture();

    fakeState.transactionError = { code: 'aborted', message: 'transient' };
    await expect(captureOnWrite(event({ status: 'open' }, after))).rejects.toBe(fakeState.transactionError);
    expect(fakeState.createCalls).toHaveLength(0);

    // Simulate the platform's redelivery: a fresh invocation of the SAME event, transient
    // condition cleared.
    fakeState.transactionError = null;
    await captureOnWrite(event({ status: 'open' }, after));
    expect(fakeState.createCalls).toHaveLength(4);
    expect(fakeState.createCalls.find((c) => c.path.startsWith('shiftCloseEvidence/'))?.path).toBe(`shiftCloseEvidence/${capture.evidenceId}`);
  });
});
