import { describe, test, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import {
  MAX_SHIFT_TOTAL_BILLS,
  PAYLOAD_GUARD_THRESHOLD_BYTES,
  SCHEMA_VERSION,
  toSignedTotalMinor,
  toNonNegativeCountInt,
  canonicalizeMoneyField,
  canonicalizeTotalBills,
  canonicalizeNote,
  canonicalizeIdentity,
  canonicalizeClosedAt,
  isCloseTransition,
  planCapture,
  decideCapture,
  buildInitWrites,
  buildConflictWrites,
  isRetryableFirestoreError,
  describeErrorCode,
  type IncomingCapture,
  type ExistingEvidenceView,
  type ExistingCaseView,
} from '../shiftCloseEvidenceCaptureCore';

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

function planClose(afterOverrides: Record<string, unknown> = {}, before: Record<string, unknown> | undefined = { status: 'open' }) {
  return planCapture({ shiftId: SHIFT_ID, before, after: baseAfter(afterOverrides), eventTimeIso: EVENT_TIME });
}

function validCapture(overrides: Record<string, unknown> = {}): IncomingCapture {
  const result = planClose(overrides);
  if (result.kind !== 'capture') throw new Error(`fixture setup failed: ${JSON.stringify(result)}`);
  return result.capture;
}

function matchingEvidenceView(capture: IncomingCapture): ExistingEvidenceView {
  return {
    exists: true,
    id: capture.evidenceId,
    evidenceId: capture.evidenceId,
    shiftId: capture.shiftId,
    closeHash: capture.closeHash,
    sourceCloseDocPath: capture.sourceCloseDocPath,
    branchId: capture.branchId,
    staffId: capture.staffId,
    deviceId: capture.deviceId,
    schemaVersion: SCHEMA_VERSION,
  };
}

function matchingCaseView(capture: IncomingCapture, extra: Partial<ExistingCaseView> = {}): ExistingCaseView {
  return {
    exists: true,
    shiftId: capture.shiftId,
    branchId: capture.branchId,
    staffId: capture.staffId,
    deviceId: capture.deviceId,
    schemaVersion: SCHEMA_VERSION,
    caseVersion: 1,
    sourceRevision: 1,
    ...extra,
  };
}

const ABSENT_EVIDENCE: ExistingEvidenceView = { exists: false };
const ABSENT_CASE: ExistingCaseView = { exists: false };

// ---------------------------------------------------------------------------
// G1 — capture-core-local signed/count primitives.
// ---------------------------------------------------------------------------

describe('toSignedTotalMinor', () => {
  test('valid negative value', () => {
    expect(toSignedTotalMinor(-10.5)).toEqual({ ok: true, minor: -1050 });
  });
  test('valid positive value', () => {
    expect(toSignedTotalMinor(10.5)).toEqual({ ok: true, minor: 1050 });
  });
  test('-0 normalizes to +0', () => {
    expect(toSignedTotalMinor(-0)).toEqual({ ok: true, minor: 0 });
  });
  test('over-precision (10.005) is malformed, never silently rounded', () => {
    const result = toSignedTotalMinor(10.005);
    expect(result.ok).toBe(false);
  });
  test('sign-symmetric bound violation both directions', () => {
    const positive = toSignedTotalMinor(10_000_000_000.01);
    const negative = toSignedTotalMinor(-10_000_000_000.01);
    expect(positive.ok).toBe(false);
    expect(negative.ok).toBe(false);
  });
  test('NaN / Infinity are malformed', () => {
    expect(toSignedTotalMinor(NaN).ok).toBe(false);
    expect(toSignedTotalMinor(Infinity).ok).toBe(false);
    expect(toSignedTotalMinor(-Infinity).ok).toBe(false);
  });
});

describe('toNonNegativeCountInt', () => {
  test.each([0, 1, 250, MAX_SHIFT_TOTAL_BILLS])('valid count %i', (n) => {
    expect(toNonNegativeCountInt(n)).toEqual({ ok: true, count: n });
  });
  test('over bound (100001) refused', () => {
    expect(toNonNegativeCountInt(MAX_SHIFT_TOTAL_BILLS + 1).ok).toBe(false);
  });
  test('Number.MAX_SAFE_INTEGER refused (business bound binds, not the safe-integer ceiling)', () => {
    expect(toNonNegativeCountInt(Number.MAX_SAFE_INTEGER).ok).toBe(false);
  });
  test('unsafe integer refused', () => {
    expect(toNonNegativeCountInt(Number.MAX_SAFE_INTEGER + 1).ok).toBe(false);
  });
  test('negative refused', () => {
    expect(toNonNegativeCountInt(-1).ok).toBe(false);
  });
  test('fractional refused', () => {
    expect(toNonNegativeCountInt(3.5).ok).toBe(false);
  });
  test('NaN / +Infinity / -Infinity refused', () => {
    expect(toNonNegativeCountInt(NaN).ok).toBe(false);
    expect(toNonNegativeCountInt(Infinity).ok).toBe(false);
    expect(toNonNegativeCountInt(-Infinity).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Field-level canonicalization unit tests.
// ---------------------------------------------------------------------------

describe('canonicalizeMoneyField', () => {
  test('missing -> absent', () => {
    expect(canonicalizeMoneyField(undefined, false)).toMatchObject({ kind: 'absent', stored: null });
  });
  test('present null -> null, never refused, never defaulted to 0', () => {
    expect(canonicalizeMoneyField(null, false)).toMatchObject({ kind: 'null', stored: null });
  });
  test('valid number -> stored verbatim, hashed as minor units', () => {
    expect(canonicalizeMoneyField(10.5, false)).toEqual({ kind: 'valid', stored: 10.5, hash: 1050 });
  });
  test('negative on a non-negative field -> invalid_numeric, stored verbatim (never refused, never signed-converted)', () => {
    const result = canonicalizeMoneyField(-5, false);
    expect(result.kind).toBe('invalid_numeric');
    expect(result).toMatchObject({ stored: -5 });
  });
  test('negative on variance (signed) -> valid', () => {
    expect(canonicalizeMoneyField(-10.5, true)).toEqual({ kind: 'valid', stored: -10.5, hash: -1050 });
  });
  test('wrong type (string/map/list/bool) -> wrong_type', () => {
    expect(canonicalizeMoneyField('100', false).kind).toBe('wrong_type');
    expect(canonicalizeMoneyField({}, false).kind).toBe('wrong_type');
    expect(canonicalizeMoneyField([], false).kind).toBe('wrong_type');
    expect(canonicalizeMoneyField(true, false).kind).toBe('wrong_type');
  });
});

describe('canonicalizeTotalBills', () => {
  test.each([0, 1, 250, MAX_SHIFT_TOTAL_BILLS])('valid %i -> stored as int', (n) => {
    expect(canonicalizeTotalBills(n)).toEqual({ kind: 'valid', stored: n, hash: n });
  });
  test('missing -> absent', () => {
    expect(canonicalizeTotalBills(undefined)).toMatchObject({ kind: 'absent', stored: null });
  });
  test('present null -> null (not refused)', () => {
    expect(canonicalizeTotalBills(null)).toMatchObject({ kind: 'null', stored: null });
  });
  test.each([MAX_SHIFT_TOTAL_BILLS + 1, -1, 3.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    'invalid numeric %p -> invalid_numeric (structural refusal, never INV-tagged)',
    (n) => {
      expect(canonicalizeTotalBills(n)).toEqual({ kind: 'invalid_numeric' });
    },
  );
  test('wrong type -> wrong_type', () => {
    expect(canonicalizeTotalBills('12').kind).toBe('wrong_type');
    expect(canonicalizeTotalBills({}).kind).toBe('wrong_type');
    expect(canonicalizeTotalBills([]).kind).toBe('wrong_type');
    expect(canonicalizeTotalBills(true).kind).toBe('wrong_type');
  });
});

describe('canonicalizeIdentity', () => {
  test('all present -> ok', () => {
    expect(canonicalizeIdentity({ shiftId: 's1', branchId: 'b1', staffId: 'st1', deviceId: 'd1' })).toEqual({
      ok: true,
      branchId: 'b1',
      staffId: 'st1',
      deviceId: 'd1',
    });
  });
  test.each(['branchId', 'staffId', 'deviceId'] as const)('missing %s -> refused', (field) => {
    const params = { shiftId: 's1', branchId: 'b1', staffId: 'st1', deviceId: 'd1', [field]: undefined };
    expect(canonicalizeIdentity(params)).toEqual({ ok: false, missingField: field });
  });
  test('empty string deviceId -> refused', () => {
    expect(canonicalizeIdentity({ shiftId: 's1', branchId: 'b1', staffId: 'st1', deviceId: '' })).toEqual({
      ok: false,
      missingField: 'deviceId',
    });
  });
});

describe('canonicalizeClosedAt', () => {
  test('missing -> null observedClosedAt, event.time+7d fallback', () => {
    const result = canonicalizeClosedAt(undefined, EVENT_TIME);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observedClosedAt).toBeNull();
      expect(result.lateEventHorizonUntil.toMillis()).toBe(new Date(EVENT_TIME).getTime() + 7 * 24 * 60 * 60 * 1000);
    }
  });
  test('present null -> same as missing', () => {
    const result = canonicalizeClosedAt(null, EVENT_TIME);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.observedClosedAt).toBeNull();
  });
  test('real Timestamp -> verbatim + closedAt+7d', () => {
    const ts = Timestamp.fromMillis(1_700_000_000_000);
    const result = canonicalizeClosedAt(ts, EVENT_TIME);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observedClosedAt).toBe(ts);
      expect(result.lateEventHorizonUntil.toMillis()).toBe(ts.toMillis() + 7 * 24 * 60 * 60 * 1000);
    }
  });
  test('wrong type (number/string/map/bool) -> refused', () => {
    expect(canonicalizeClosedAt(12345, EVENT_TIME).ok).toBe(false);
    expect(canonicalizeClosedAt('2026-01-01', EVENT_TIME).ok).toBe(false);
    expect(canonicalizeClosedAt({}, EVENT_TIME).ok).toBe(false);
    expect(canonicalizeClosedAt(true, EVENT_TIME).ok).toBe(false);
  });
});

describe('canonicalizeNote', () => {
  test('missing -> absent, null -> null, string -> valid verbatim', () => {
    expect(canonicalizeNote(undefined)).toMatchObject({ kind: 'absent', stored: null });
    expect(canonicalizeNote(null)).toMatchObject({ kind: 'null', stored: null });
    expect(canonicalizeNote('hello')).toEqual({ kind: 'valid', stored: 'hello', hash: 'hello' });
  });
  test('wrong type -> wrong_type', () => {
    expect(canonicalizeNote(123).kind).toBe('wrong_type');
    expect(canonicalizeNote({}).kind).toBe('wrong_type');
  });
});

// ---------------------------------------------------------------------------
// A — Non-close / trigger gating.
// ---------------------------------------------------------------------------

describe('isCloseTransition / planCapture gating', () => {
  test('non-close update -> no capture', () => {
    expect(isCloseTransition({ status: 'open' }, { status: 'open' })).toBe(false);
    expect(planClose({ status: 'open' }, { status: 'open' }).kind).toBe('not_close_transition');
  });
  test('create/open event -> no capture', () => {
    expect(isCloseTransition(undefined, { status: 'open' })).toBe(false);
    expect(planClose({ status: 'open' }, undefined).kind).toBe('not_close_transition');
  });
  test('closed-to-closed irrelevant update -> no capture', () => {
    expect(isCloseTransition({ status: 'closed' }, { status: 'closed' })).toBe(false);
    expect(planClose({}, { status: 'closed' }).kind).toBe('not_close_transition');
  });
  test('close transition (open -> closed) -> enters capture flow', () => {
    expect(isCloseTransition({ status: 'open' }, { status: 'closed' })).toBe(true);
    expect(planClose().kind).toBe('capture');
  });
  test('close transition (no prior doc -> closed) -> enters capture flow', () => {
    expect(planClose({}, undefined).kind).toBe('capture');
  });
  test('deleted doc (after undefined) -> no capture', () => {
    const result = planCapture({ shiftId: SHIFT_ID, before: { status: 'closed' }, after: undefined, eventTimeIso: EVENT_TIME });
    expect(result.kind).toBe('not_close_transition');
  });
});

// ---------------------------------------------------------------------------
// B — totalBills (G8).
// ---------------------------------------------------------------------------

describe('planCapture — totalBills G8', () => {
  test.each([0, 1, 250, MAX_SHIFT_TOTAL_BILLS])('valid %i captured, stored as int', (n) => {
    const result = planClose({ totalBills: n });
    expect(result.kind).toBe('capture');
    if (result.kind === 'capture') expect(result.capture.totalBills).toBe(n);
  });

  test.each([MAX_SHIFT_TOTAL_BILLS + 1, -1, 3.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    'invalid numeric %p -> structural refusal, no writes, no throw',
    (n) => {
      const result = planClose({ totalBills: n });
      expect(result.kind).toBe('refused');
      if (result.kind === 'refused') expect(result.code).toBe('capture_refused_invalid_total_bills');
    },
  );

  test('null -> captured, stored literal null', () => {
    const result = planClose({ totalBills: null });
    expect(result.kind).toBe('capture');
    if (result.kind === 'capture') expect(result.capture.totalBills).toBeNull();
  });

  test('missing -> captured, frozen absent/null behavior', () => {
    const after = baseAfter();
    delete after.totalBills;
    const result = planCapture({ shiftId: SHIFT_ID, before: { status: 'open' }, after, eventTimeIso: EVENT_TIME });
    expect(result.kind).toBe('capture');
    if (result.kind === 'capture') expect(result.capture.totalBills).toBeNull();
  });

  test.each(['12', {}, [], true])('present non-number %p -> malformed-mirror refusal', (v) => {
    const result = planClose({ totalBills: v });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.code).toBe('capture_refused_malformed_mirror_field');
      expect(result.fields).toMatchObject({ fieldName: 'totalBills' });
    }
  });
});

// ---------------------------------------------------------------------------
// C — wrong-type / malformed fields.
// ---------------------------------------------------------------------------

describe('planCapture — wrong-type / malformed field refusals', () => {
  test('wrong-type mirror money field -> structural refusal, no throw', () => {
    const result = planClose({ expectedCash: '100' });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.code).toBe('capture_refused_malformed_mirror_field');
      expect(result.fields).toMatchObject({ fieldName: 'expectedCash' });
    }
  });

  test('wrong-type closedAt -> structural refusal, no throw', () => {
    const result = planClose({ closedAt: 12345 });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.code).toBe('capture_refused_malformed_closed_at');
  });

  test.each(['branchId', 'staffId', 'deviceId'] as const)('missing identity field %s -> refused', (field) => {
    const result = planClose({ [field]: undefined });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.code).toBe('capture_refused_invalid_shift');
      expect(result.fields).toMatchObject({ missingField: field });
    }
  });

  test('empty string branchId -> refused', () => {
    const result = planClose({ branchId: '' });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.fields).toMatchObject({ missingField: 'branchId' });
  });

  test('oversize payload -> log-only structural refusal, no writes, no throw', () => {
    const bigNote = 'x'.repeat(2_000_000);
    const result = planClose({ note: bigNote });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.code).toBe('capture_refused_payload_limit');
      expect(result.fields.estimatedBytes as number).toBeGreaterThan(PAYLOAD_GUARD_THRESHOLD_BYTES);
    }
  });

  test('ordinary close does not trip the payload guard', () => {
    const result = planClose();
    expect(result.kind).toBe('capture');
  });
});

// ---------------------------------------------------------------------------
// D — Evidence invariant (9 fields).
// ---------------------------------------------------------------------------

describe('decideCapture — evidence invariant', () => {
  const capture = validCapture();
  const validCase = matchingCaseView(capture);

  test.each([
    ['id', 'wrong-id'],
    ['evidenceId', 'wrong-evidenceId'],
    ['shiftId', 'wrong-shift'],
    ['closeHash', 'wrong-hash'],
    ['sourceCloseDocPath', 'shifts/wrong'],
    ['branchId', 'wrong-branch'],
    ['staffId', 'wrong-staff'],
    ['deviceId', 'wrong-device'],
    ['schemaVersion', 999],
  ] as const)('mismatched %s -> capture_anomaly_evidence_identity_mismatch, zero writes, no throw', (field, badValue) => {
    const evidence = { ...matchingEvidenceView(capture), [field]: badValue };
    const decision = decideCapture(capture, evidence, validCase);
    expect(decision).toEqual({
      kind: 'anomaly',
      code: 'capture_anomaly_evidence_identity_mismatch',
      fields: { shiftId: capture.shiftId, evidenceId: capture.evidenceId },
    });
  });

  test('fully matching evidence + case -> true no-op', () => {
    const decision = decideCapture(capture, matchingEvidenceView(capture), validCase);
    expect(decision).toEqual({ kind: 'noop' });
  });
});

// ---------------------------------------------------------------------------
// E — Case invariant (5 fields).
// ---------------------------------------------------------------------------

describe('decideCapture — case invariant', () => {
  const capture = validCapture();

  test.each([
    ['shiftId', 'wrong-shift'],
    ['branchId', 'wrong-branch'],
    ['staffId', 'wrong-staff'],
    ['deviceId', 'wrong-device'],
    ['schemaVersion', 999],
  ] as const)('mismatched %s -> capture_anomaly_case_identity_mismatch, zero writes, no throw', (field, badValue) => {
    const caseView = { ...matchingCaseView(capture), [field]: badValue };
    const decision = decideCapture(capture, ABSENT_EVIDENCE, caseView);
    expect(decision).toEqual({ kind: 'anomaly', code: 'capture_anomaly_case_identity_mismatch', fields: { shiftId: capture.shiftId } });
  });
});

// ---------------------------------------------------------------------------
// F — Disjoint precedence matrix.
// ---------------------------------------------------------------------------

describe('decideCapture — disjoint ordered precedence', () => {
  const capture = validCapture();
  const mismatchedEvidence: ExistingEvidenceView = { ...matchingEvidenceView(capture), branchId: 'wrong-branch' };
  const mismatchedCase: ExistingCaseView = { ...matchingCaseView(capture), branchId: 'wrong-branch' };
  const validEvidence = matchingEvidenceView(capture);
  const validCaseView = matchingCaseView(capture);

  test('case absent + mismatched evidence -> evidence_identity_mismatch (NOT evidence_without_case)', () => {
    expect(decideCapture(capture, mismatchedEvidence, ABSENT_CASE).code).toBe('capture_anomaly_evidence_identity_mismatch');
  });

  test('case absent + valid evidence -> evidence_without_case', () => {
    const decision = decideCapture(capture, validEvidence, ABSENT_CASE);
    expect(decision).toEqual({
      kind: 'anomaly',
      code: 'capture_anomaly_evidence_without_case',
      fields: { shiftId: capture.shiftId, evidenceId: capture.evidenceId },
    });
  });

  test('case present mismatched + evidence absent -> case_identity_mismatch (NOT conflict)', () => {
    expect(decideCapture(capture, ABSENT_EVIDENCE, mismatchedCase).code).toBe('capture_anomaly_case_identity_mismatch');
  });

  test('case present mismatched + evidence present valid -> case_identity_mismatch', () => {
    expect(decideCapture(capture, validEvidence, mismatchedCase).code).toBe('capture_anomaly_case_identity_mismatch');
  });

  test('case present mismatched + evidence present mismatched -> evidence mismatch wins (tie-break)', () => {
    expect(decideCapture(capture, mismatchedEvidence, mismatchedCase).code).toBe('capture_anomaly_evidence_identity_mismatch');
  });

  test('case present valid + evidence present valid -> true replay no-op', () => {
    expect(decideCapture(capture, validEvidence, validCaseView)).toEqual({ kind: 'noop' });
  });

  test('case present valid + evidence absent -> conflict-close', () => {
    const decision = decideCapture(capture, ABSENT_EVIDENCE, validCaseView);
    expect(decision).toEqual({ kind: 'conflict', nextCaseVersion: 2, nextSourceRevision: 2 });
  });

  test('case absent + evidence absent -> init', () => {
    expect(decideCapture(capture, ABSENT_EVIDENCE, ABSENT_CASE)).toEqual({ kind: 'init' });
  });
});

// ---------------------------------------------------------------------------
// G — Init write shape.
// ---------------------------------------------------------------------------

// Exact frozen key sets (Codex B2-C) — independent hardcoded literal arrays,
// deliberately NOT derived from the implementation, so a key added/renamed/
// removed by accident in `buildEvidenceFields`/`buildInitWrites`/
// `buildConflictWrites` fails a test here even if the production code and a
// same-author test both "agree" on the wrong shape.
const EXACT_EVIDENCE_KEYS = [
  'evidenceId', 'shiftId', 'closeHash', 'branchId', 'staffId', 'deviceId',
  'startingCash', 'actualCashCount', 'variance', 'expectedCash', 'expectedQr',
  'expectedKbank', 'expectedCard', 'expectedCredit', 'payInTotal', 'payOutTotal',
  'totalBills', 'note', 'cashEntriesSnapshot', 'cashEntriesSnapshotMeta',
  'cashEntriesDigest', 'cashEntriesFullDigest', 'sourceEntryCount',
  'sourceCloseDocPath', 'observedShiftStatus', 'observedClosedAt', 'schemaVersion',
].sort();

const EXACT_CASE_INIT_KEYS = [
  'shiftId', 'branchId', 'staffId', 'deviceId', 'selectedRunId', 'selectedCloseHash',
  'priorSelectedRunId', 'latestEvidenceId', 'latestCloseHash', 'processingState',
  'settlementState', 'alertState', 'caseVersion', 'sourceRevision', 'pendingRevalidation',
  'lastObservedCommitMicros', 'commitBoundaryDocKeys', 'lastEnqueuedSourceEventId',
  'revalidationAttempts', 'leaseOwner', 'leaseExpiry', 'lateEventHorizonUntil',
  'sweepEligible', 'schemaVersion',
].sort();

const EXACT_AUDIT_KEYS = ['eventId', 'shiftId', 'caseVersion', 'runId', 'transitionType', 'actor', 'reasonCode', 'note', 'branchId', 'schemaVersion'].sort();

const EXACT_ALERT_KEYS = ['alertState', 'reasonCode', 'openedAt', 'acknowledgedByActor', 'resolvedByActor', 'caseVersion', 'branchId', 'schemaVersion'].sort();

const EXACT_CONFLICT_CASE_UPDATE_KEYS = ['caseVersion', 'sourceRevision', 'latestEvidenceId', 'latestCloseHash', 'pendingRevalidation'].sort();

describe('buildInitWrites', () => {
  const capture = validCapture();
  const writes = buildInitWrites(capture);

  test('evidence init document — exact whole-document field set and values', () => {
    expect(Object.keys(writes.evidenceFields).sort()).toEqual(EXACT_EVIDENCE_KEYS);
    expect(writes.evidenceFields).toEqual({
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
    });
  });

  test('case init document — exact whole-document field set and values', () => {
    expect(Object.keys(writes.caseFields).sort()).toEqual(EXACT_CASE_INIT_KEYS);
    expect(writes.caseFields).toEqual({
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
    });
  });

  test('audit init document — exact whole-document field set and values, no targetCaseVersion', () => {
    expect(Object.keys(writes.auditFields).sort()).toEqual(EXACT_AUDIT_KEYS);
    expect(writes.auditFields).toEqual({
      eventId: writes.auditEventId,
      shiftId: capture.shiftId,
      caseVersion: 1,
      runId: null,
      transitionType: 'evidence_captured',
      actor: { kind: 'system' },
      reasonCode: null,
      note: null,
      branchId: capture.branchId,
      schemaVersion: SCHEMA_VERSION,
    });
    expect(writes.auditFields).not.toHaveProperty('targetCaseVersion');
  });

  test('alert init document — exact whole-document field set and values, no obsolete acknowledgedBy/resolvedBy', () => {
    expect(Object.keys(writes.alertFields).sort()).toEqual(EXACT_ALERT_KEYS);
    expect(writes.alertFields).toEqual({
      alertState: 'none',
      reasonCode: null,
      openedAt: null,
      acknowledgedByActor: null,
      resolvedByActor: null,
      caseVersion: 1,
      branchId: capture.branchId,
      schemaVersion: SCHEMA_VERSION,
    });
    expect(writes.alertFields).not.toHaveProperty('acknowledgedBy');
    expect(writes.alertFields).not.toHaveProperty('resolvedBy');
  });

  test('no shifts write, no validationRuns write, no sourceManifest field anywhere in the write set', () => {
    const serialized = JSON.stringify(writes);
    expect(serialized).not.toContain('sourceManifest');
    expect(serialized).not.toContain('shiftCloseValidationRuns');
  });
});

// ---------------------------------------------------------------------------
// H — Conflict write shape.
// ---------------------------------------------------------------------------

describe('buildConflictWrites', () => {
  const capture = validCapture({ actualCashCount: 2000 });
  const writes = buildConflictWrites(capture, 2, 2);

  test('conflict evidence document — exact whole-document field set and values', () => {
    expect(Object.keys(writes.evidenceFields).sort()).toEqual(EXACT_EVIDENCE_KEYS);
    expect(writes.evidenceFields).toEqual({
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
    });
  });

  test('conflict audit document — exact whole-document field set and values, with the bumped caseVersion', () => {
    expect(Object.keys(writes.auditFields).sort()).toEqual(EXACT_AUDIT_KEYS);
    expect(writes.auditFields).toEqual({
      eventId: writes.auditEventId,
      shiftId: capture.shiftId,
      caseVersion: 2,
      runId: null,
      transitionType: 'evidence_captured',
      actor: { kind: 'system' },
      reasonCode: null,
      note: null,
      branchId: capture.branchId,
      schemaVersion: SCHEMA_VERSION,
    });
    expect(writes.auditFields).not.toHaveProperty('targetCaseVersion');
  });

  test('case update field set — exact, bumps version/sourceRevision/latest*, never touches selected*', () => {
    expect(Object.keys(writes.caseUpdateFields).sort()).toEqual(EXACT_CONFLICT_CASE_UPDATE_KEYS);
    expect(writes.caseUpdateFields).toEqual({
      caseVersion: 2,
      sourceRevision: 2,
      latestEvidenceId: capture.evidenceId,
      latestCloseHash: capture.closeHash,
      pendingRevalidation: true,
    });
    expect(writes.caseUpdateFields).not.toHaveProperty('selectedRunId');
    expect(writes.caseUpdateFields).not.toHaveProperty('selectedCloseHash');
    expect(writes.caseUpdateFields).not.toHaveProperty('branchId');
  });

  test('latest pointer is set to THIS conflict close (proves latest* tracks the most recent write, not the first)', () => {
    expect(writes.caseUpdateFields.latestCloseHash).toBe(capture.closeHash);
    expect(writes.caseUpdateFields.latestEvidenceId).toBe(capture.evidenceId);
  });
});

// ---------------------------------------------------------------------------
// I — Replay / idempotency (decision-level).
// ---------------------------------------------------------------------------

describe('decideCapture — replay / idempotency sequences', () => {
  test('A-init -> redeliver A -> no-op', () => {
    const captureA = validCapture();
    expect(decideCapture(captureA, ABSENT_EVIDENCE, ABSENT_CASE)).toEqual({ kind: 'init' });
    // After init commits, evidence A + case (v1) both exist and match.
    const decision = decideCapture(captureA, matchingEvidenceView(captureA), matchingCaseView(captureA));
    expect(decision).toEqual({ kind: 'noop' });
  });

  test('A-init -> B-conflict -> redeliver A -> no-op', () => {
    const captureA = validCapture();
    const captureB = validCapture({ actualCashCount: 9999 });
    expect(captureA.closeHash).not.toBe(captureB.closeHash);

    // A initializes the case.
    const caseAfterInit = matchingCaseView(captureA);
    // B conflicts against the existing case (its own evidence is absent).
    const conflictDecision = decideCapture(captureB, ABSENT_EVIDENCE, caseAfterInit);
    expect(conflictDecision).toEqual({ kind: 'conflict', nextCaseVersion: 2, nextSourceRevision: 2 });

    // Case identity fields are unchanged by the conflict (only version/latest* bump).
    const caseAfterConflict = matchingCaseView(captureA, { caseVersion: 2, sourceRevision: 2 });
    // Redelivering A: its own evidence still exists and matches; case identity still matches.
    const redeliverA = decideCapture(captureA, matchingEvidenceView(captureA), caseAfterConflict);
    expect(redeliverA).toEqual({ kind: 'noop' });
  });

  test('no anomaly is ever a benign no-op, and no anomaly throws (structural — both asserted by return shape)', () => {
    const capture = validCapture();
    const decision = decideCapture(capture, { ...matchingEvidenceView(capture), deviceId: 'wrong' }, ABSENT_CASE);
    expect(decision.kind).toBe('anomaly');
  });

  // -------------------------------------------------------------------------
  // Full frozen A/B/C historical-replay matrix (Codex B2-A). Three distinct
  // closes on the same shift: A inits the case, B conflicts (v1->v2), C
  // conflicts again (v2->v3). Every earlier event, redelivered after the
  // case has moved on, must be a true no-op — including B, which is no
  // longer the latest evidence once C has landed.
  // -------------------------------------------------------------------------

  test('A-init -> B-conflict -> C-conflict -> redeliver B -> no-op (old-but-valid evidence, not latest)', () => {
    const captureA = validCapture();
    const captureB = validCapture({ actualCashCount: 9999 });
    const captureC = validCapture({ actualCashCount: 12345 });
    expect(new Set([captureA.closeHash, captureB.closeHash, captureC.closeHash]).size).toBe(3);

    expect(decideCapture(captureA, ABSENT_EVIDENCE, ABSENT_CASE)).toEqual({ kind: 'init' });
    const caseAfterA = matchingCaseView(captureA, { caseVersion: 1, sourceRevision: 1 });

    expect(decideCapture(captureB, ABSENT_EVIDENCE, caseAfterA)).toEqual({ kind: 'conflict', nextCaseVersion: 2, nextSourceRevision: 2 });
    const caseAfterB = matchingCaseView(captureA, { caseVersion: 2, sourceRevision: 2 });

    expect(decideCapture(captureC, ABSENT_EVIDENCE, caseAfterB)).toEqual({ kind: 'conflict', nextCaseVersion: 3, nextSourceRevision: 3 });
    const caseAfterC = matchingCaseView(captureA, { caseVersion: 3, sourceRevision: 3 });

    // B's own evidence exists (created during its conflict-close) and matches; case identity is
    // untouched by any conflict — so redelivering B, even though it is no longer latest, is a no-op.
    const redeliverB = decideCapture(captureB, matchingEvidenceView(captureB), caseAfterC);
    expect(redeliverB).toEqual({ kind: 'noop' });
  });

  test('A-init -> B-conflict -> C-conflict -> redeliver A -> no-op (old-but-valid evidence, not latest)', () => {
    const captureA = validCapture();
    const captureB = validCapture({ actualCashCount: 9999 });
    const captureC = validCapture({ actualCashCount: 12345 });

    expect(decideCapture(captureA, ABSENT_EVIDENCE, ABSENT_CASE)).toEqual({ kind: 'init' });
    const caseAfterA = matchingCaseView(captureA, { caseVersion: 1, sourceRevision: 1 });
    expect(decideCapture(captureB, ABSENT_EVIDENCE, caseAfterA)).toEqual({ kind: 'conflict', nextCaseVersion: 2, nextSourceRevision: 2 });
    const caseAfterB = matchingCaseView(captureA, { caseVersion: 2, sourceRevision: 2 });
    expect(decideCapture(captureC, ABSENT_EVIDENCE, caseAfterB)).toEqual({ kind: 'conflict', nextCaseVersion: 3, nextSourceRevision: 3 });
    const caseAfterC = matchingCaseView(captureA, { caseVersion: 3, sourceRevision: 3 });

    const redeliverA = decideCapture(captureA, matchingEvidenceView(captureA), caseAfterC);
    expect(redeliverA).toEqual({ kind: 'noop' });
  });

  test('latest case pointer remains latest (== C) after historical A/B redelivery, since redelivery writes nothing', () => {
    const captureA = validCapture();
    const captureB = validCapture({ actualCashCount: 9999 });
    const captureC = validCapture({ actualCashCount: 12345 });

    // The conflict write-set for C sets latest* to C — proven directly on the builder output.
    const conflictWritesC = buildConflictWrites(captureC, 3, 3);
    expect(conflictWritesC.caseUpdateFields.latestEvidenceId).toBe(captureC.evidenceId);
    expect(conflictWritesC.caseUpdateFields.latestCloseHash).toBe(captureC.closeHash);

    // Redelivering A or B after C is a pure no-op (decideCapture returns 'noop', which the
    // adapter dispatches to zero writes) — so nothing downstream of C's write can revert latest*.
    const caseAfterC = matchingCaseView(captureA, { caseVersion: 3, sourceRevision: 3 });
    expect(decideCapture(captureA, matchingEvidenceView(captureA), caseAfterC)).toEqual({ kind: 'noop' });
    expect(decideCapture(captureB, matchingEvidenceView(captureB), caseAfterC)).toEqual({ kind: 'noop' });
  });

  // -------------------------------------------------------------------------
  // Duplicate / concurrency simulation at the decision level (Codex B2-B).
  // No emulator is run; this proves the DECISION FUNCTION's own idempotency
  // contract, not real Firestore transaction contention/rollback (disclosed
  // as a residual limitation in the remediation report).
  // -------------------------------------------------------------------------

  test('duplicate A delivery when A evidence already exists -> no-op (not a second init)', () => {
    const captureA = validCapture();
    const decision = decideCapture(captureA, matchingEvidenceView(captureA), matchingCaseView(captureA));
    expect(decision).toEqual({ kind: 'noop' });
  });

  test('duplicate B delivery when B evidence already exists -> no-op (not a second conflict)', () => {
    const captureA = validCapture();
    const captureB = validCapture({ actualCashCount: 9999 });
    // B's evidence already landed; the case is at v2 (post-B-conflict).
    const caseAfterB = matchingCaseView(captureA, { caseVersion: 2, sourceRevision: 2 });
    const decision = decideCapture(captureB, matchingEvidenceView(captureB), caseAfterB);
    expect(decision).toEqual({ kind: 'noop' });
  });

  test('a create decision (init or conflict) is only ever reachable when existingEvidence.exists is false', () => {
    const capture = validCapture();
    const validEvidence = matchingEvidenceView(capture);
    const mismatchedEvidence = { ...validEvidence, deviceId: 'wrong-device' };
    const caseVariants: ExistingCaseView[] = [ABSENT_CASE, matchingCaseView(capture), { ...matchingCaseView(capture), branchId: 'wrong-branch' }];

    for (const caseView of caseVariants) {
      for (const evidenceView of [validEvidence, mismatchedEvidence]) {
        const decision = decideCapture(capture, evidenceView, caseView);
        expect(decision.kind).not.toBe('init');
        expect(decision.kind).not.toBe('conflict');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// B1 — Retry/throw taxonomy classifier (Codex blocker B1).
// ---------------------------------------------------------------------------

describe('isRetryableFirestoreError', () => {
  test.each(['deadline-exceeded', 'unavailable', 'aborted', 'resource-exhausted'])(
    'stable string code %s -> retryable (throw)',
    (code) => {
      expect(isRetryableFirestoreError({ code })).toBe(true);
    },
  );

  test.each([4, 8, 10, 14])('stable numeric gRPC code %i (DEADLINE_EXCEEDED/RESOURCE_EXHAUSTED/ABORTED/UNAVAILABLE) -> retryable', (code) => {
    expect(isRetryableFirestoreError({ code })).toBe(true);
  });

  test('nested cause.code transient -> retryable', () => {
    expect(isRetryableFirestoreError({ message: 'wrapped', cause: { code: 'unavailable' } })).toBe(true);
    expect(isRetryableFirestoreError({ message: 'wrapped', cause: { code: 14 } })).toBe(true);
  });

  test('a plain un-coded Error, even with a transient-sounding MESSAGE, is NOT retryable (never infer from text)', () => {
    expect(isRetryableFirestoreError(new Error('DEADLINE_EXCEEDED'))).toBe(false);
    expect(isRetryableFirestoreError(new Error('please retry, unavailable right now'))).toBe(false);
  });

  test('a local invariant/schema/programmer error (plain Error, no code) is NOT retryable', () => {
    expect(isRetryableFirestoreError(new Error('invariant violation: init alert projection failed isValidAlertProjection'))).toBe(false);
  });

  test.each(['invalid-argument', 'failed-precondition', 'permission-denied', 'not-found', 'already-exists'])(
    'stable permanent string code %s -> NOT retryable (ACK)',
    (code) => {
      expect(isRetryableFirestoreError({ code })).toBe(false);
    },
  );

  test.each([3, 9, 7, 5, 6])('stable permanent numeric gRPC code %i -> NOT retryable', (code) => {
    expect(isRetryableFirestoreError({ code })).toBe(false);
  });

  test('unknown/non-coded object, null, undefined, primitive -> NOT retryable', () => {
    expect(isRetryableFirestoreError({ foo: 'bar' })).toBe(false);
    expect(isRetryableFirestoreError(null)).toBe(false);
    expect(isRetryableFirestoreError(undefined)).toBe(false);
    expect(isRetryableFirestoreError('a string error')).toBe(false);
    expect(isRetryableFirestoreError(42)).toBe(false);
  });

  test('code case-insensitivity for string codes (defensive; SDK convention is lower-case)', () => {
    expect(isRetryableFirestoreError({ code: 'UNAVAILABLE' })).toBe(true);
  });
});

describe('describeErrorCode', () => {
  test('returns the direct code when present', () => {
    expect(describeErrorCode({ code: 'unavailable' })).toBe('unavailable');
    expect(describeErrorCode({ code: 14 })).toBe(14);
  });
  test('falls back to cause.code when the error itself is uncoded', () => {
    expect(describeErrorCode({ cause: { code: 'aborted' } })).toBe('aborted');
  });
  test('returns "unknown" for a plain Error or non-coded value', () => {
    expect(describeErrorCode(new Error('DEADLINE_EXCEEDED'))).toBe('unknown');
    expect(describeErrorCode({ foo: 'bar' })).toBe('unknown');
    expect(describeErrorCode(null)).toBe('unknown');
  });
});
