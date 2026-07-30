/**
 * getShiftCloseCaseFiguresCore.test.ts — Packet 5 / UI-B2 / Packet S, file #3.
 *
 * Two independent proof layers:
 *  (1) Behavioral tests against the REAL shipped module (request validation,
 *      authorization matrix, curation/decision matrix, response allowlist,
 *      source-value validation, the BI-01 decision biconditional).
 *  (2) A syntax-only AST static guard (rules C1-C15) run against a frozen
 *      string-constant copy of the module (`CORE_BASELINE_V3`) plus a
 *      mutation/positive-fixture matrix proving every rule is decidable and
 *      non-vacuous. No type checker; `ts.createSourceFile(..., true)` only.
 */
import { describe, test, expect } from 'vitest';
import * as ts from 'typescript';
import {
  PROCESSING_STATES,
  SETTLEMENT_STATES,
  ALERT_STATES,
  VALIDATION_VERDICTS,
} from '../shiftCloseValidationTypes';
import { SCHEMA_VERSION } from '../shiftCloseEvidenceCaptureCore';
import { VALIDATION_SCHEMA_VERSION } from '../shiftCloseValidationWorkerCore';
import * as Core from '../getShiftCloseCaseFiguresCore';

// ============================================================================
// PART A — behavioral tests against the real shipped core module
// ============================================================================

describe('SV-01 / SV-02 — schema constant drift detection', () => {
  test('SV-01: SUPPORTED_SCHEMA_VERSION mirrors the real SCHEMA_VERSION', () => {
    expect(Core.SUPPORTED_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
  });
  test('SV-02: SUPPORTED_VALIDATION_SCHEMA_VERSION mirrors the real VALIDATION_SCHEMA_VERSION', () => {
    expect(Core.SUPPORTED_VALIDATION_SCHEMA_VERSION).toBe(VALIDATION_SCHEMA_VERSION);
  });
});

describe('11.1 Request validation', () => {
  const valid = { branchId: 'LDP-001', shiftId: 'SHIFT-1', expectedCaseVersion: 1 };

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['string', 'x'],
    ['array', []],
  ])('non-object %s is rejected', (_label, raw) => {
    expect(Core.curateRequestView(raw)).toBeNull();
  });

  test('missing branchId rejected', () => {
    const { branchId: _drop, ...rest } = valid;
    expect(Core.curateRequestView(rest)).toBeNull();
  });
  test('missing shiftId rejected', () => {
    const { shiftId: _drop, ...rest } = valid;
    expect(Core.curateRequestView(rest)).toBeNull();
  });
  test('missing expectedCaseVersion rejected', () => {
    const { expectedCaseVersion: _drop, ...rest } = valid;
    expect(Core.curateRequestView(rest)).toBeNull();
  });

  test('wrong-typed branchId rejected', () => {
    expect(Core.curateRequestView({ ...valid, branchId: 1 })).toBeNull();
  });
  test('wrong-typed shiftId rejected', () => {
    expect(Core.curateRequestView({ ...valid, shiftId: 1 })).toBeNull();
  });
  test('wrong-typed expectedCaseVersion rejected', () => {
    expect(Core.curateRequestView({ ...valid, expectedCaseVersion: '1' })).toBeNull();
  });

  test('extra key rejected, not stripped', () => {
    expect(Core.curateRequestView({ ...valid, evidenceId: 'x' })).toBeNull();
  });

  test.each(['', '   '])('branchId %j rejected', (branchId) => {
    expect(Core.curateRequestView({ ...valid, branchId })).toBeNull();
  });
  test('branchId ALL rejected', () => {
    expect(Core.curateRequestView({ ...valid, branchId: 'ALL' })).toBeNull();
  });
  test.each(['', '   '])('shiftId %j rejected', (shiftId) => {
    expect(Core.curateRequestView({ ...valid, shiftId })).toBeNull();
  });

  test.each([1.5, -1, NaN, Infinity, -Infinity, '2', null])(
    'expectedCaseVersion %j rejected',
    (expectedCaseVersion) => {
      expect(Core.curateRequestView({ ...valid, expectedCaseVersion })).toBeNull();
    },
  );

  test('a valid minimal request is accepted', () => {
    expect(Core.curateRequestView(valid)).toEqual(valid);
  });

  test('shiftId containing literal % sequences is preserved byte-for-byte', () => {
    const raw = { ...valid, shiftId: 'SHIFT%2F1' };
    expect(Core.curateRequestView(raw)?.shiftId).toBe('SHIFT%2F1');
  });
});

describe('11.2 Authorization (core)', () => {
  const branchId = 'LDP-001';
  const request = Core.curateRequestView({ branchId, shiftId: 'S1', expectedCaseVersion: 0 })!;

  function claims(overrides: Partial<{ role: unknown; branchIds: unknown; staffId: unknown }>) {
    const token: Record<string, unknown> = {
      staffId: 'STAFF-1',
      role: 'manager',
      branchIds: [branchId],
      ...overrides,
    };
    return Core.curateCallableAuth({ token });
  }

  test('auth null -> unauthorized', () => {
    expect(Core.decideAuthorization(Core.curateCallableAuth(null), request)).toEqual({
      status: 'unauthorized',
    });
  });
  test('auth undefined -> unauthorized', () => {
    expect(Core.decideAuthorization(Core.curateCallableAuth(undefined), request)).toEqual({
      status: 'unauthorized',
    });
  });
  test('token without staffId -> unauthorized', () => {
    const c = Core.curateCallableAuth({ token: { role: 'manager', branchIds: [branchId] } });
    expect(Core.decideAuthorization(c, request)).toEqual({ status: 'unauthorized' });
  });
  test('staffId empty string still counts as present (mirrors rules != null semantics)', () => {
    const c = claims({ staffId: '' });
    expect(Core.decideAuthorization(c, request)).toBeNull();
  });
  test('role staff -> unauthorized', () => {
    const c = claims({ role: 'staff' });
    expect(Core.decideAuthorization(c, request)).toEqual({ status: 'unauthorized' });
  });
  test('unknown role -> unauthorized', () => {
    const c = claims({ role: 'owner' });
    expect(Core.decideAuthorization(c, request)).toEqual({ status: 'unauthorized' });
  });
  test('manager same branch -> allowed', () => {
    const c = claims({});
    expect(Core.decideAuthorization(c, request)).toBeNull();
  });
  test('manager other branch -> denied', () => {
    const c = claims({ branchIds: ['OTHER'] });
    expect(Core.decideAuthorization(c, request)).toEqual({ status: 'unauthorized' });
  });
  test('admin same concrete branch -> allowed', () => {
    const c = claims({ role: 'admin', branchIds: [branchId] });
    expect(Core.decideAuthorization(c, request)).toBeNull();
  });
  test('admin DIFFERENT concrete branch -> DENIED (the frozen divergence from resolveShiftCloseAlertCore)', () => {
    const c = claims({ role: 'admin', branchIds: ['OTHER-BRANCH'] });
    expect(Core.decideAuthorization(c, request)).toEqual({ status: 'unauthorized' });
  });
  test('admin with branchIds [ALL] -> allowed for any concrete branch', () => {
    const c = claims({ role: 'admin', branchIds: ['ALL'] });
    expect(Core.decideAuthorization(c, request)).toBeNull();
  });
  test('branchIds missing -> unauthorized', () => {
    const c = Core.curateCallableAuth({ token: { staffId: 'S', role: 'manager' } });
    expect(Core.decideAuthorization(c, request)).toEqual({ status: 'unauthorized' });
  });
  test('branchIds non-array -> unauthorized', () => {
    const c = Core.curateCallableAuth({ token: { staffId: 'S', role: 'manager', branchIds: 'x' } });
    expect(Core.decideAuthorization(c, request)).toEqual({ status: 'unauthorized' });
  });
  test('branchIds array of non-strings -> curated to empty, denied', () => {
    const c = claims({ branchIds: [1, 2, 3] });
    expect(Core.decideAuthorization(c, request)).toEqual({ status: 'unauthorized' });
  });

  test('guard: core does not import from resolveShiftCloseAlertCore', () => {
    const coreSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'getShiftCloseCaseFiguresCore.ts'),
      'utf8',
    ) as string;
    expect(coreSource.includes('resolveShiftCloseAlertCore')).toBe(false);
    expect(coreSource.includes('hasBranchAccess')).toBe(false);
    expect(coreSource.includes('checkAdjudicationAuthority')).toBe(false);
  });
});

describe('11.4 Response allowlist (core)', () => {
  test('ok member has exactly the frozen 7 sorted keys', () => {
    const runView: Core.CuratedRunView = {
      runId: 'R1', shiftId: 'S1', branchId: 'B1', closeHash: 'H1', evidenceId: 'S1_H1',
      schemaVersion: 1, validationSchemaVersion: 1, validationVerdict: 'match',
      serverExpectedCashMinor: 100, serverExpectedCashDeltaMinor: 0,
    };
    const evidenceView: Core.CuratedEvidenceView = {
      evidenceId: 'S1_H1', shiftId: 'S1', branchId: 'B1', closeHash: 'H1', schemaVersion: 1,
      expectedCash: 1, actualCashCount: 1, variance: 0,
    };
    const response = Core.decideShiftCloseCaseFigures(runView, evidenceView);
    expect(Object.keys(response).sort()).toEqual(
      [
        'reportedActualCashCountBaht', 'reportedExpectedCashBaht', 'reportedVarianceBaht',
        'serverExpectedCashDeltaMinor', 'serverExpectedCashMinor', 'status', 'validationVerdict',
      ].sort(),
    );
    expect(Object.keys(response).length).toBe(7);
  });

  test.each([
    ['provisional_no_selected_run', Core.responseProvisionalNoSelectedRun()],
    ['case_not_found', Core.responseCaseNotFound()],
    ['unavailable_data_anomaly', Core.responseUnavailableDataAnomaly()],
  ])('%s member has exactly key set ["status"]', (_label, response) => {
    expect(Object.keys(response)).toEqual(['status']);
  });

  test('every figure key is absent (hasOwnProperty false) from every non-ok member', () => {
    const nonOk = [
      Core.responseProvisionalNoSelectedRun(),
      Core.responseCaseNotFound(),
      Core.responseUnavailableDataAnomaly(),
      { status: 'unsupported_case_state' },
      { status: 'stale_case_version' },
      { status: 'unauthorized' },
    ];
    const figureKeys = [
      'reportedExpectedCashBaht', 'reportedActualCashCountBaht', 'reportedVarianceBaht',
      'serverExpectedCashMinor', 'serverExpectedCashDeltaMinor', 'validationVerdict',
    ];
    const forbidden = [
      'evidenceId', 'runId', 'selectedRunId', 'branchId', 'shiftId', 'caseVersion',
      'processingState', 'settlementState', 'caseAlertState', 'hasSelectedRun',
      'latestEvidenceId', 'closeHash', 'hash', 'digest', 'timestamp',
    ];
    for (const member of nonOk) {
      for (const key of [...figureKeys, ...forbidden]) {
        expect(Object.prototype.hasOwnProperty.call(member, key)).toBe(false);
      }
    }
  });
});

// RC-PS-final / BI-01: per-guard exhaustive forward-direction runtime matrix
// for all three decision families. Every row (a) triggers exactly one named
// guard from the production source (the other 17-21 guards in the same
// function all still pass) and (b) asserts the exact expected response —
// which is strictly stronger than the biconditional alone, since an exact
// wrong-sentinel row would fail even though response!==null <=> view===null
// still holds. Every row also re-asserts the biconditional directly.
// Disclosed scope: this proves the *forward* direction (every listed
// condition produces its exact decision) exhaustively over every guard named
// in the production source, for all three families. It does not attempt a
// formal *reverse* proof that no unlisted condition could also reach the same
// sentinel — that is bounded instead by C12's frozen 26-entry manifest
// (RC-PS-02) plus this file's C1-C15 static guard, which together prove the
// exact, closed set of comparisons the production module contains.
function omit<T extends object>(obj: T, key: keyof T): Partial<T> {
  const clone: Partial<T> = { ...obj };
  delete clone[key];
  return clone;
}

// RC-FINAL-01: exact-view assertion for the single success row in each of the
// three BI-01 families below. Each expected view is an independently written
// object literal (never derived from the actual returned view, the input
// fixture, or the production curator) typed against the real exported view
// interface, so the comparison fails on a wrong value, a missing key, an
// extra key, or an undefined-valued key -- not merely on non-null-ness.
function assertExactSuccessView<T extends Record<string, unknown>>(
  view: T | null,
  expected: T,
  expectedSortedKeys: readonly string[],
): void {
  expect(view).not.toBeNull();
  const actual = view as T;
  const actualKeys = Object.keys(actual).sort();
  const wantedKeys = [...expectedSortedKeys].sort();
  expect(actualKeys).toEqual(wantedKeys);
  expect(actualKeys.length).toBe(wantedKeys.length);
  for (const key of wantedKeys) {
    expect(Object.prototype.hasOwnProperty.call(actual, key)).toBe(true);
    expect(actual[key]).not.toBeUndefined();
    expect(actual[key]).toBe(expected[key]);
  }
  expect(actual).toEqual(expected);
}

describe('BI-01 — the decision biconditional (response===null <=> view!==null)', () => {
  const ANOMALY_R = { status: 'unavailable_data_anomaly' } as const;
  const UNSUPPORTED_R = { status: 'unsupported_case_state' } as const;
  const STALE_R = { status: 'stale_case_version' } as const;
  const DENIED_R = { status: 'unauthorized' } as const;

  describe('BI01_CASE — curateCaseDocument, every named guard', () => {
    const request = Core.curateRequestView({ branchId: 'B1', shiftId: 'S1', expectedCaseVersion: 1 })!;
    const validCase = {
      branchId: 'B1', shiftId: 'S1', caseVersion: 1, schemaVersion: 1,
      processingState: 'validated', settlementState: 'unsettled', alertState: 'none',
      selectedRunId: null, selectedCloseHash: null,
    };

    // Independently constructed -- not the returned view, not spread from
    // validCase, not produced by curateCaseDocument.
    const BI01_CASE_SUCCESS_VIEW: Core.CuratedCaseView = {
      shiftId: 'S1',
      branchId: 'B1',
      caseVersion: 1,
      schemaVersion: 1,
      selectedRunId: null,
      selectedCloseHash: null,
    };
    const BI01_CASE_SUCCESS_VIEW_KEYS = [
      'branchId', 'caseVersion', 'schemaVersion', 'selectedCloseHash', 'selectedRunId', 'shiftId',
    ];

    function check(raw: unknown, expected: unknown, snapshotId = 'S1') {
      const d = Core.curateCaseDocument(request, snapshotId, raw);
      const response = Core.caseDecisionResponse(d);
      const view = Core.caseDecisionView(d);
      expect(response).toEqual(expected);
      expect(response === null).toBe(view !== null);
      if (expected === null) {
        assertExactSuccessView(
          view as unknown as Record<string, unknown> | null,
          BI01_CASE_SUCCESS_VIEW as unknown as Record<string, unknown>,
          BI01_CASE_SUCCESS_VIEW_KEYS,
        );
      } else {
        expect(view).toBeNull();
      }
    }

    test.each([
      ['raw non-object (number)', 42, ANOMALY_R],
      ['raw null', null, ANOMALY_R],
      ['raw array', [], ANOMALY_R],
      ['branchId missing', omit(validCase, 'branchId'), ANOMALY_R],
      ['branchId wrong type', { ...validCase, branchId: 1 }, ANOMALY_R],
      ['branchId mismatched value', { ...validCase, branchId: 'OTHER' }, DENIED_R],
      ['caseVersion missing', omit(validCase, 'caseVersion'), STALE_R],
      ['caseVersion wrong type', { ...validCase, caseVersion: '1' }, STALE_R],
      ['caseVersion mismatched value', { ...validCase, caseVersion: 99 }, STALE_R],
      ['shiftId missing', omit(validCase, 'shiftId'), ANOMALY_R],
      ['shiftId mismatched request.shiftId', { ...validCase, shiftId: 'OTHER-SHIFT' }, ANOMALY_R],
      ['shiftId mismatched caseSnapshotId', validCase, ANOMALY_R, 'MISMATCHED-SNAPSHOT-ID'],
      ['schemaVersion missing', omit(validCase, 'schemaVersion'), ANOMALY_R],
      ['schemaVersion mismatched value', { ...validCase, schemaVersion: 2 }, ANOMALY_R],
      ['processingState missing', omit(validCase, 'processingState'), ANOMALY_R],
      ['settlementState missing', omit(validCase, 'settlementState'), ANOMALY_R],
      ['alertState missing', omit(validCase, 'alertState'), ANOMALY_R],
      ['processingState invalid enum value (present)', { ...validCase, processingState: 'nope' }, UNSUPPORTED_R],
      ['settlementState invalid enum value (present)', { ...validCase, settlementState: 'nope' }, UNSUPPORTED_R],
      ['alertState invalid enum value (present)', { ...validCase, alertState: 'nope' }, UNSUPPORTED_R],
      ['selectedRunId whitespace-only (invalid)', { ...validCase, selectedRunId: '   ', selectedCloseHash: 'H' }, ANOMALY_R],
      ['selectedCloseHash whitespace-only (invalid)', { ...validCase, selectedRunId: 'R', selectedCloseHash: '   ' }, ANOMALY_R],
      ['selectedRunId set but selectedCloseHash null', { ...validCase, selectedRunId: 'R', selectedCloseHash: null }, ANOMALY_R],
      ['valid full document -> success (response null, view populated)', validCase, null],
    ])('%s', (_label, raw, expected, snapshotId) => {
      check(raw, expected, snapshotId ?? 'S1');
    });
  });

  describe('BI01_RUN — curateRunDocument, every named guard', () => {
    const caseView: Core.CuratedCaseView = {
      shiftId: 'S1', branchId: 'B1', caseVersion: 1, schemaVersion: 1,
      selectedRunId: 'RUN1', selectedCloseHash: 'HASH1',
    };
    const validRun = {
      runId: 'RUN1', shiftId: 'S1', branchId: 'B1', closeHash: 'HASH1', evidenceId: 'S1_HASH1',
      schemaVersion: 1, validationSchemaVersion: 1, validationVerdict: 'match',
      serverComputedDrawer: { expectedCashMinor: 100 }, perFieldDeltas: { expectedCashMinor: 0 },
    };

    const BI01_RUN_SUCCESS_VIEW: Core.CuratedRunView = {
      runId: 'RUN1',
      shiftId: 'S1',
      branchId: 'B1',
      closeHash: 'HASH1',
      evidenceId: 'S1_HASH1',
      schemaVersion: 1,
      validationSchemaVersion: 1,
      validationVerdict: 'match',
      serverExpectedCashMinor: 100,
      serverExpectedCashDeltaMinor: 0,
    };
    const BI01_RUN_SUCCESS_VIEW_KEYS = [
      'branchId', 'closeHash', 'evidenceId', 'runId', 'schemaVersion',
      'serverExpectedCashDeltaMinor', 'serverExpectedCashMinor', 'shiftId',
      'validationSchemaVersion', 'validationVerdict',
    ];

    function check(raw: unknown, expected: unknown, snapshotId = 'RUN1') {
      const d = Core.curateRunDocument(caseView, snapshotId, raw);
      const response = Core.runDecisionResponse(d);
      const view = Core.runDecisionView(d);
      expect(response).toEqual(expected);
      expect(response === null).toBe(view !== null);
      if (expected === null) {
        assertExactSuccessView(
          view as unknown as Record<string, unknown> | null,
          BI01_RUN_SUCCESS_VIEW as unknown as Record<string, unknown>,
          BI01_RUN_SUCCESS_VIEW_KEYS,
        );
      } else {
        expect(view).toBeNull();
      }
    }

    test.each([
      ['raw non-object', 42, ANOMALY_R],
      ['runId missing', omit(validRun, 'runId'), ANOMALY_R],
      ['shiftId missing', omit(validRun, 'shiftId'), ANOMALY_R],
      ['branchId missing', omit(validRun, 'branchId'), ANOMALY_R],
      ['closeHash missing', omit(validRun, 'closeHash'), ANOMALY_R],
      ['evidenceId missing', omit(validRun, 'evidenceId'), ANOMALY_R],
      ['schemaVersion missing', omit(validRun, 'schemaVersion'), ANOMALY_R],
      ['validationSchemaVersion missing', omit(validRun, 'validationSchemaVersion'), ANOMALY_R],
      ['validationVerdict missing', omit(validRun, 'validationVerdict'), ANOMALY_R],
      ['serverComputedDrawer missing', omit(validRun, 'serverComputedDrawer'), ANOMALY_R],
      ['perFieldDeltas missing', omit(validRun, 'perFieldDeltas'), ANOMALY_R],
      ['runSnapshotId !== caseView.selectedRunId', validRun, ANOMALY_R, 'WRONG-SNAPSHOT-ID'],
      ['runId.value !== runSnapshotId', { ...validRun, runId: 'OTHER-RUN' }, ANOMALY_R],
      ['shiftId.value !== caseView.shiftId', { ...validRun, shiftId: 'OTHER-SHIFT' }, ANOMALY_R],
      ['branchId.value !== caseView.branchId', { ...validRun, branchId: 'OTHER-BRANCH' }, ANOMALY_R],
      ['closeHash.value !== caseView.selectedCloseHash', { ...validRun, closeHash: 'WRONG-HASH' }, ANOMALY_R],
      ['schemaVersion.value !== SUPPORTED_SCHEMA_VERSION', { ...validRun, schemaVersion: 2 }, ANOMALY_R],
      ['validationSchemaVersion.value !== SUPPORTED_VALIDATION_SCHEMA_VERSION', { ...validRun, validationSchemaVersion: 2 }, ANOMALY_R],
      ['evidenceId.value !== shiftId_closeHash join', { ...validRun, evidenceId: 'WRONG-JOIN' }, ANOMALY_R],
      ['drawerMinor invalid', { ...validRun, serverComputedDrawer: { expectedCashMinor: 1.5 } }, ANOMALY_R],
      ['deltaMinor invalid', { ...validRun, perFieldDeltas: { expectedCashMinor: 1.5 } }, ANOMALY_R],
      ['valid full document -> success (response null, view populated)', validRun, null],
    ])('%s', (_label, raw, expected, snapshotId) => {
      check(raw, expected, snapshotId ?? 'RUN1');
    });
  });

  describe('BI01_EVIDENCE — curateEvidenceDocument, every named guard', () => {
    const caseView: Core.CuratedCaseView = {
      shiftId: 'S1', branchId: 'B1', caseVersion: 1, schemaVersion: 1,
      selectedRunId: 'RUN1', selectedCloseHash: 'HASH1',
    };
    const runView: Core.CuratedRunView = {
      runId: 'RUN1', shiftId: 'S1', branchId: 'B1', closeHash: 'HASH1', evidenceId: 'S1_HASH1',
      schemaVersion: 1, validationSchemaVersion: 1, validationVerdict: 'match',
      serverExpectedCashMinor: 100, serverExpectedCashDeltaMinor: 0,
    };
    const validEvidence = {
      evidenceId: 'S1_HASH1', shiftId: 'S1', branchId: 'B1', closeHash: 'HASH1', schemaVersion: 1,
      expectedCash: 100, actualCashCount: 100, variance: 0,
    };

    const BI01_EVIDENCE_SUCCESS_VIEW: Core.CuratedEvidenceView = {
      evidenceId: 'S1_HASH1',
      shiftId: 'S1',
      branchId: 'B1',
      closeHash: 'HASH1',
      schemaVersion: 1,
      expectedCash: 100,
      actualCashCount: 100,
      variance: 0,
    };
    const BI01_EVIDENCE_SUCCESS_VIEW_KEYS = [
      'actualCashCount', 'branchId', 'closeHash', 'evidenceId', 'expectedCash', 'schemaVersion', 'shiftId', 'variance',
    ];

    function check(raw: unknown, expected: unknown, snapshotId = 'S1_HASH1') {
      const d = Core.curateEvidenceDocument(caseView, runView, snapshotId, raw);
      const response = Core.evidenceDecisionResponse(d);
      const view = Core.evidenceDecisionView(d);
      expect(response).toEqual(expected);
      expect(response === null).toBe(view !== null);
      if (expected === null) {
        assertExactSuccessView(
          view as unknown as Record<string, unknown> | null,
          BI01_EVIDENCE_SUCCESS_VIEW as unknown as Record<string, unknown>,
          BI01_EVIDENCE_SUCCESS_VIEW_KEYS,
        );
      } else {
        expect(view).toBeNull();
      }
    }

    test.each([
      ['raw non-object', 42, ANOMALY_R],
      ['evidenceId missing', omit(validEvidence, 'evidenceId'), ANOMALY_R],
      ['shiftId missing', omit(validEvidence, 'shiftId'), ANOMALY_R],
      ['branchId missing', omit(validEvidence, 'branchId'), ANOMALY_R],
      ['closeHash missing', omit(validEvidence, 'closeHash'), ANOMALY_R],
      ['schemaVersion missing', omit(validEvidence, 'schemaVersion'), ANOMALY_R],
      ['expectedCash missing', omit(validEvidence, 'expectedCash'), ANOMALY_R],
      ['expectedCash invalid (NaN)', { ...validEvidence, expectedCash: NaN }, ANOMALY_R],
      ['actualCashCount missing', omit(validEvidence, 'actualCashCount'), ANOMALY_R],
      ['actualCashCount invalid (NaN)', { ...validEvidence, actualCashCount: NaN }, ANOMALY_R],
      ['variance missing', omit(validEvidence, 'variance'), ANOMALY_R],
      ['variance invalid (NaN)', { ...validEvidence, variance: NaN }, ANOMALY_R],
      ['evidenceSnapshotId !== runView.evidenceId', validEvidence, ANOMALY_R, 'WRONG-SNAPSHOT-ID'],
      ['evidenceId.value !== evidenceSnapshotId', { ...validEvidence, evidenceId: 'OTHER-EVIDENCE' }, ANOMALY_R],
      ['shiftId.value !== caseView.shiftId', { ...validEvidence, shiftId: 'OTHER-SHIFT' }, ANOMALY_R],
      ['branchId.value !== caseView.branchId', { ...validEvidence, branchId: 'OTHER-BRANCH' }, ANOMALY_R],
      ['closeHash.value !== runView.closeHash', { ...validEvidence, closeHash: 'WRONG-HASH' }, ANOMALY_R],
      ['schemaVersion.value !== SUPPORTED_SCHEMA_VERSION', { ...validEvidence, schemaVersion: 2 }, ANOMALY_R],
      ['valid full document -> success (response null, view populated)', validEvidence, null],
    ])('%s', (_label, raw, expected, snapshotId) => {
      check(raw, expected, snapshotId ?? 'S1_HASH1');
    });
  });
});

describe('11.5 Source-value validation (core)', () => {
  const request = Core.curateRequestView({ branchId: 'B1', shiftId: 'S1', expectedCaseVersion: 1 })!;
  const caseView: Core.CuratedCaseView = {
    shiftId: 'S1', branchId: 'B1', caseVersion: 1, schemaVersion: 1,
    selectedRunId: 'RUN1', selectedCloseHash: 'HASH1',
  };
  const validRun = {
    runId: 'RUN1', shiftId: 'S1', branchId: 'B1', closeHash: 'HASH1', evidenceId: 'S1_HASH1',
    schemaVersion: 1, validationSchemaVersion: 1, validationVerdict: 'match',
    serverComputedDrawer: { expectedCashMinor: 100 }, perFieldDeltas: { expectedCashMinor: 0 },
  };
  const runView: Core.CuratedRunView = {
    runId: 'RUN1', shiftId: 'S1', branchId: 'B1', closeHash: 'HASH1', evidenceId: 'S1_HASH1',
    schemaVersion: 1, validationSchemaVersion: 1, validationVerdict: 'match',
    serverExpectedCashMinor: 100, serverExpectedCashDeltaMinor: 0,
  };
  const validEvidence = {
    evidenceId: 'S1_HASH1', shiftId: 'S1', branchId: 'B1', closeHash: 'HASH1', schemaVersion: 1,
    expectedCash: 100, actualCashCount: 100, variance: 0,
  };

  test.each([
    [100, 100],
    [null, null],
  ])('expectedCash %j -> %j (passthrough / null)', (input, expected) => {
    const d = Core.curateEvidenceDocument(caseView, runView, 'S1_HASH1', { ...validEvidence, expectedCash: input });
    expect(Core.evidenceDecisionView(d)?.expectedCash).toBe(expected);
  });

  test.each([NaN, Infinity, -Infinity, 'x', true, {}])('expectedCash %j -> anomaly', (input) => {
    const d = Core.curateEvidenceDocument(caseView, runView, 'S1_HASH1', { ...validEvidence, expectedCash: input });
    expect(Core.evidenceDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });

  test('expectedCash key absent -> anomaly', () => {
    const { expectedCash: _drop, ...rest } = validEvidence;
    const d = Core.curateEvidenceDocument(caseView, runView, 'S1_HASH1', rest);
    expect(Core.evidenceDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });

  test('finite out-of-bound reported Baht passes through unchanged (deliberate, §8.4)', () => {
    const d = Core.curateEvidenceDocument(caseView, runView, 'S1_HASH1', { ...validEvidence, expectedCash: 1e12 });
    expect(Core.evidenceDecisionView(d)?.expectedCash).toBe(1e12);
  });
  test.each([0, -1e12, -0.5])('reported Baht %j passes through unchanged (zero / negative / fractional)', (v) => {
    const d = Core.curateEvidenceDocument(caseView, runView, 'S1_HASH1', { ...validEvidence, expectedCash: v });
    expect(Core.evidenceDecisionView(d)?.expectedCash).toBe(v);
  });
  test.each(['actualCashCount', 'variance'] as const)('reported Baht field %s: zero/negative/fractional pass through unchanged', (field) => {
    for (const v of [0, -1e12, -0.5]) {
      const d = Core.curateEvidenceDocument(caseView, runView, 'S1_HASH1', { ...validEvidence, [field]: v });
      expect((Core.evidenceDecisionView(d) as unknown as Record<string, unknown> | null)?.[field]).toBe(v);
    }
  });

  test('serverComputedDrawer {} -> curated null (J10: nested-missing maps to null, not anomaly)', () => {
    const d = Core.curateRunDocument(caseView, 'RUN1', { ...validRun, serverComputedDrawer: {} });
    expect(Core.runDecisionView(d)?.serverExpectedCashMinor).toBeNull();
  });
  test('serverComputedDrawer key present null -> null', () => {
    const d = Core.curateRunDocument(caseView, 'RUN1', {
      ...validRun,
      serverComputedDrawer: { expectedCashMinor: null },
    });
    expect(Core.runDecisionView(d)?.serverExpectedCashMinor).toBeNull();
  });
  test('serverComputedDrawer safe integer -> passthrough', () => {
    const d = Core.curateRunDocument(caseView, 'RUN1', validRun);
    expect(Core.runDecisionView(d)?.serverExpectedCashMinor).toBe(100);
  });
  test.each([0, -100, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])('serverComputedDrawer minor %j (zero / negative / bound) -> passthrough', (v) => {
    const d = Core.curateRunDocument(caseView, 'RUN1', { ...validRun, serverComputedDrawer: { expectedCashMinor: v } });
    expect(Core.runDecisionView(d)?.serverExpectedCashMinor).toBe(v);
  });
  test.each([NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '100', true])('serverComputedDrawer minor %j -> anomaly', (v) => {
    const d = Core.curateRunDocument(caseView, 'RUN1', {
      ...validRun,
      serverComputedDrawer: { expectedCashMinor: v },
    });
    expect(Core.runDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });
  test('serverComputedDrawer non-object -> anomaly', () => {
    const d = Core.curateRunDocument(caseView, 'RUN1', { ...validRun, serverComputedDrawer: 'x' });
    expect(Core.runDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });

  test.each(VALIDATION_VERDICTS)('validationVerdict %s accepted', (verdict) => {
    const d = Core.curateRunDocument(caseView, 'RUN1', { ...validRun, validationVerdict: verdict });
    expect(Core.runDecisionView(d)?.validationVerdict).toBe(verdict);
  });
  test.each(['unknown', '', null, undefined, 42])('validationVerdict %j -> anomaly', (v) => {
    const d = Core.curateRunDocument(caseView, 'RUN1', { ...validRun, validationVerdict: v });
    expect(Core.runDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });

  test.each([0, 2, '1', undefined])('case schemaVersion %j -> anomaly', (schemaVersion) => {
    const raw: Record<string, unknown> = {
      branchId: 'B1', shiftId: 'S1', caseVersion: 1,
      processingState: 'validated', settlementState: 'unsettled', alertState: 'none',
      selectedRunId: null, selectedCloseHash: null,
    };
    if (schemaVersion !== undefined) raw.schemaVersion = schemaVersion;
    const d = Core.curateCaseDocument(request, 'S1', raw);
    expect(Core.caseDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });
  test.each([0, 2, '1', undefined])('run schemaVersion %j -> anomaly', (schemaVersion) => {
    const raw: Record<string, unknown> = { ...validRun };
    if (schemaVersion === undefined) delete raw.schemaVersion;
    else raw.schemaVersion = schemaVersion;
    const d = Core.curateRunDocument(caseView, 'RUN1', raw);
    expect(Core.runDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });
  test.each([0, 2, '1', undefined])('evidence schemaVersion %j -> anomaly', (schemaVersion) => {
    const raw: Record<string, unknown> = { ...validEvidence };
    if (schemaVersion === undefined) delete raw.schemaVersion;
    else raw.schemaVersion = schemaVersion;
    const d = Core.curateEvidenceDocument(caseView, runView, 'S1_HASH1', raw);
    expect(Core.evidenceDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });
});

// RC-PS-BI01-numeric: the exhaustive safe-integer / reported-Baht / J10
// matrices. Governed-field inventories are derived directly from production
// source (not assumed):
//  - safe-integer ("server minor") fields: exactly the two nested keys read
//    by `minorFrom` (the sole `asNullableSafeInteger`-typed FieldRead
//    helper) inside `curateRunDocument`: `serverComputedDrawer.expectedCashMinor`
//    and `perFieldDeltas.expectedCashMinor`.
//  - reported-Baht fields: exactly the three `asNullableFinite`-typed reads
//    inside `curateEvidenceDocument`: `expectedCash`, `actualCashCount`,
//    `variance`.
//  - J10 nested-map contract governs exactly the same two parent maps as the
//    safe-integer matrix (`serverComputedDrawer`, `perFieldDeltas`); the
//    parent-map-shape categories below are additive to (not a duplicate of)
//    the nested-key-level categories already exercised per field in the
//    safe-integer matrix — the full 26-row-per-field J10 contract is the
//    union of both sections, machine-cross-referenced in the completion
//    report.
const OMIT = Symbol('omit-key');

const SAFE_INTEGER_CATEGORIES: [string, unknown, number | null | 'anomaly'][] = [
  ['positive safe integer', 100, 100],
  ['zero', 0, 0],
  ['negative safe integer', -100, -100],
  ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ['Number.MIN_SAFE_INTEGER', Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
  ['unsafe positive integer', Number.MAX_SAFE_INTEGER + 1, 'anomaly'],
  ['unsafe negative integer', Number.MIN_SAFE_INTEGER - 1, 'anomaly'],
  ['fractional number', 1.5, 'anomaly'],
  ['numeric string', '100', 'anomaly'],
  ['empty string', '', 'anomaly'],
  ['null', null, null],
  ['missing key', OMIT, null],
  ['NaN', NaN, 'anomaly'],
  ['Infinity', Infinity, 'anomaly'],
  ['-Infinity', -Infinity, 'anomaly'],
  ['plain object', {}, 'anomaly'],
  ['array', [], 'anomaly'],
  ['boolean', true, 'anomaly'],
];

describe('Exhaustive safe-integer matrix (RC-PS-BI01-numeric): every governed server-minor field x every category', () => {
  const caseView: Core.CuratedCaseView = {
    shiftId: 'S1', branchId: 'B1', caseVersion: 1, schemaVersion: 1,
    selectedRunId: 'RUN1', selectedCloseHash: 'HASH1',
  };
  const validRun = {
    runId: 'RUN1', shiftId: 'S1', branchId: 'B1', closeHash: 'HASH1', evidenceId: 'S1_HASH1',
    schemaVersion: 1, validationSchemaVersion: 1, validationVerdict: 'match',
    serverComputedDrawer: { expectedCashMinor: 100 }, perFieldDeltas: { expectedCashMinor: 0 },
  };
  function buildNested(value: unknown): Record<string, unknown> {
    return value === OMIT ? {} : { expectedCashMinor: value };
  }

  test.each(SAFE_INTEGER_CATEGORIES)('serverComputedDrawer.expectedCashMinor: %s', (_cat, value, expected) => {
    const d = Core.curateRunDocument(caseView, 'RUN1', { ...validRun, serverComputedDrawer: buildNested(value) });
    if (expected === 'anomaly') {
      expect(Core.runDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
    } else {
      expect(Core.runDecisionResponse(d)).toBeNull();
      expect(Core.runDecisionView(d)?.serverExpectedCashMinor).toBe(expected);
      expect(Object.prototype.hasOwnProperty.call(Core.runDecisionView(d), 'serverExpectedCashMinor')).toBe(true);
    }
  });

  test.each(SAFE_INTEGER_CATEGORIES)('perFieldDeltas.expectedCashMinor: %s', (_cat, value, expected) => {
    const d = Core.curateRunDocument(caseView, 'RUN1', { ...validRun, perFieldDeltas: buildNested(value) });
    if (expected === 'anomaly') {
      expect(Core.runDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
    } else {
      expect(Core.runDecisionResponse(d)).toBeNull();
      expect(Core.runDecisionView(d)?.serverExpectedCashDeltaMinor).toBe(expected);
      expect(Object.prototype.hasOwnProperty.call(Core.runDecisionView(d), 'serverExpectedCashDeltaMinor')).toBe(true);
    }
  });

  test('exactly 2 governed server-minor fields x 18 categories are executed', () => {
    expect(SAFE_INTEGER_CATEGORIES.length).toBe(18);
  });
});

const REPORTED_BAHT_CATEGORIES: [string, unknown, number | null | 'anomaly'][] = [
  ['ordinary positive finite number', 123.45, 123.45],
  ['zero', 0, 0],
  ['negative finite number', -50, -50],
  ['fractional finite number', 1.25, 1.25],
  ['1e12 frozen passthrough', 1e12, 1e12],
  ['NaN', NaN, 'anomaly'],
  ['Infinity', Infinity, 'anomaly'],
  ['-Infinity', -Infinity, 'anomaly'],
  ['numeric string', '100', 'anomaly'],
  ['empty string', '', 'anomaly'],
  ['null', null, null],
  ['missing key', OMIT, 'anomaly'],
  ['plain object', {}, 'anomaly'],
  ['array', [], 'anomaly'],
  ['boolean', true, 'anomaly'],
];

describe('Exhaustive reported-Baht matrix (RC-PS-BI01-numeric): every governed evidence field x every category', () => {
  const caseView: Core.CuratedCaseView = {
    shiftId: 'S1', branchId: 'B1', caseVersion: 1, schemaVersion: 1,
    selectedRunId: 'RUN1', selectedCloseHash: 'HASH1',
  };
  const runView: Core.CuratedRunView = {
    runId: 'RUN1', shiftId: 'S1', branchId: 'B1', closeHash: 'HASH1', evidenceId: 'S1_HASH1',
    schemaVersion: 1, validationSchemaVersion: 1, validationVerdict: 'match',
    serverExpectedCashMinor: 100, serverExpectedCashDeltaMinor: 0,
  };
  const validEvidence: Record<string, unknown> = {
    evidenceId: 'S1_HASH1', shiftId: 'S1', branchId: 'B1', closeHash: 'HASH1', schemaVersion: 1,
    expectedCash: 100, actualCashCount: 100, variance: 0,
  };
  function buildEvidence(field: 'expectedCash' | 'actualCashCount' | 'variance', value: unknown): Record<string, unknown> {
    const raw: Record<string, unknown> = { ...validEvidence };
    if (value === OMIT) delete raw[field];
    else raw[field] = value;
    return raw;
  }

  for (const field of ['expectedCash', 'actualCashCount', 'variance'] as const) {
    test.each(REPORTED_BAHT_CATEGORIES)(`${field}: %s`, (_cat, value, expected) => {
      const d = Core.curateEvidenceDocument(caseView, runView, 'S1_HASH1', buildEvidence(field, value));
      if (expected === 'anomaly') {
        expect(Core.evidenceDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
      } else {
        expect(Core.evidenceDecisionResponse(d)).toBeNull();
        const view = Core.evidenceDecisionView(d) as unknown as Record<string, unknown> | null;
        expect(view?.[field]).toBe(expected);
        expect(Object.prototype.hasOwnProperty.call(view, field)).toBe(true);
      }
    });
  }

  test('exactly 3 governed reported-Baht fields x 15 categories are executed', () => {
    expect(REPORTED_BAHT_CATEGORIES.length).toBe(15);
  });
});

const J10_PARENT_MAP_CATEGORIES: [string, unknown, number | null | 'anomaly'][] = [
  ['parent map missing', OMIT, 'anomaly'],
  ['parent map null', null, 'anomaly'],
  ['parent map array', [], 'anomaly'],
  ['parent map string', 'x', 'anomaly'],
  ['parent map number', 42, 'anomaly'],
  ['parent map boolean', true, 'anomaly'],
  ['parent map empty object (nested key missing) -> curated null', {}, null],
  ['parent map with an allowed-shaped sibling key alongside expectedCashMinor', { expectedCashMinor: 100, note: 'x' }, 100],
  ['parent map with an unknown/unexpected sibling key alongside expectedCashMinor', { expectedCashMinor: 100, someRandomKey: 'zzz' }, 100],
];

describe('Exhaustive J10 matrix (RC-PS-BI01-numeric): parent-map shape contract for both governed nested maps', () => {
  const caseView: Core.CuratedCaseView = {
    shiftId: 'S1', branchId: 'B1', caseVersion: 1, schemaVersion: 1,
    selectedRunId: 'RUN1', selectedCloseHash: 'HASH1',
  };
  const validRun: Record<string, unknown> = {
    runId: 'RUN1', shiftId: 'S1', branchId: 'B1', closeHash: 'HASH1', evidenceId: 'S1_HASH1',
    schemaVersion: 1, validationSchemaVersion: 1, validationVerdict: 'match',
    serverComputedDrawer: { expectedCashMinor: 100 }, perFieldDeltas: { expectedCashMinor: 0 },
  };
  function buildRun(field: 'serverComputedDrawer' | 'perFieldDeltas', value: unknown): Record<string, unknown> {
    const raw: Record<string, unknown> = { ...validRun };
    if (value === OMIT) delete raw[field];
    else raw[field] = value;
    return raw;
  }

  test.each(J10_PARENT_MAP_CATEGORIES)('serverComputedDrawer parent map: %s', (_cat, value, expected) => {
    const d = Core.curateRunDocument(caseView, 'RUN1', buildRun('serverComputedDrawer', value));
    if (expected === 'anomaly') {
      expect(Core.runDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
    } else {
      expect(Core.runDecisionResponse(d)).toBeNull();
      expect(Core.runDecisionView(d)?.serverExpectedCashMinor).toBe(expected);
    }
  });

  test.each(J10_PARENT_MAP_CATEGORIES)('perFieldDeltas parent map: %s', (_cat, value, expected) => {
    const d = Core.curateRunDocument(caseView, 'RUN1', buildRun('perFieldDeltas', value));
    if (expected === 'anomaly') {
      expect(Core.runDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
    } else {
      expect(Core.runDecisionResponse(d)).toBeNull();
      expect(Core.runDecisionView(d)?.serverExpectedCashDeltaMinor).toBe(expected);
    }
  });

  test('exactly 2 governed parent maps x 9 shape categories are executed here (cross-referenced with the 2x18 nested-key rows above for the full contract)', () => {
    expect(J10_PARENT_MAP_CATEGORIES.length).toBe(9);
  });

  test('input fixtures are never mutated by curation (no accidental fallback / no input aliasing)', () => {
    const drawer = { expectedCashMinor: 100 };
    const frozenCopy = JSON.parse(JSON.stringify(drawer));
    Core.curateRunDocument(caseView, 'RUN1', { ...validRun, serverComputedDrawer: drawer });
    expect(drawer).toEqual(frozenCopy);
  });
});

describe('J11 — nullable selection-pointer classification (14 rows: 12 disposition + 2 byte-preservation)', () => {
  const request = Core.curateRequestView({ branchId: 'B1', shiftId: 'S1', expectedCaseVersion: 1 })!;
  const base = {
    branchId: 'B1', shiftId: 'S1', caseVersion: 1, schemaVersion: 1,
    processingState: 'validated', settlementState: 'unsettled', alertState: 'none',
  };
  const OVER_LENGTH = 'X'.repeat(201);

  // ---- selectedRunId: 6 disposition rows (selectedCloseHash held at a
  // consistent, non-interfering value for each) ----
  test('J11-R1: selectedRunId missing -> no selection (selectedCloseHash also null)', () => {
    const d = Core.curateCaseDocument(request, 'S1', { ...base, selectedCloseHash: null });
    expect(Core.caseDecisionResponse(d)).toBeNull();
    expect(Core.caseDecisionView(d)?.selectedRunId).toBeNull();
  });
  test('J11-R2: selectedRunId null -> no selection (selectedCloseHash also null)', () => {
    const d = Core.curateCaseDocument(request, 'S1', { ...base, selectedRunId: null, selectedCloseHash: null });
    expect(Core.caseDecisionResponse(d)).toBeNull();
    expect(Core.caseDecisionView(d)?.selectedRunId).toBeNull();
  });
  test('J11-R3: selectedRunId empty string -> unavailable_data_anomaly', () => {
    const d = Core.curateCaseDocument(request, 'S1', { ...base, selectedRunId: '', selectedCloseHash: 'HASH1' });
    expect(Core.caseDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });
  test('J11-R4: selectedRunId whitespace-only -> unavailable_data_anomaly (the RC-PS-01 fix)', () => {
    const d = Core.curateCaseDocument(request, 'S1', { ...base, selectedRunId: '   ', selectedCloseHash: 'HASH1' });
    expect(Core.caseDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });
  test('J11-R5: selectedRunId non-string -> unavailable_data_anomaly', () => {
    const d = Core.curateCaseDocument(request, 'S1', { ...base, selectedRunId: 123, selectedCloseHash: 'HASH1' });
    expect(Core.caseDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });
  test('J11-R6: selectedRunId over-length -> unavailable_data_anomaly', () => {
    const d = Core.curateCaseDocument(request, 'S1', { ...base, selectedRunId: OVER_LENGTH, selectedCloseHash: 'HASH1' });
    expect(Core.caseDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });

  // ---- selectedCloseHash: 6 disposition rows (selectedRunId held valid,
  // except the two "no selection" rows where both are null) ----
  test('J11-H1: selectedCloseHash missing, selectedRunId null -> no selection', () => {
    const { selectedCloseHash: _drop, ...rest } = { ...base, selectedRunId: null, selectedCloseHash: null };
    const d = Core.curateCaseDocument(request, 'S1', rest);
    expect(Core.caseDecisionResponse(d)).toBeNull();
    expect(Core.caseDecisionView(d)?.selectedCloseHash).toBeNull();
  });
  test('J11-H2: selectedCloseHash null, selectedRunId null -> no selection', () => {
    const d = Core.curateCaseDocument(request, 'S1', { ...base, selectedRunId: null, selectedCloseHash: null });
    expect(Core.caseDecisionResponse(d)).toBeNull();
    expect(Core.caseDecisionView(d)?.selectedCloseHash).toBeNull();
  });
  test('J11-H3: selectedCloseHash empty string, selectedRunId valid -> unavailable_data_anomaly', () => {
    const d = Core.curateCaseDocument(request, 'S1', { ...base, selectedRunId: 'RUN1', selectedCloseHash: '' });
    expect(Core.caseDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });
  test('J11-H4: selectedCloseHash whitespace-only, selectedRunId valid -> unavailable_data_anomaly (the RC-PS-01 fix)', () => {
    const d = Core.curateCaseDocument(request, 'S1', { ...base, selectedRunId: 'RUN1', selectedCloseHash: '   ' });
    expect(Core.caseDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });
  test('J11-H5: selectedCloseHash non-string, selectedRunId valid -> unavailable_data_anomaly', () => {
    const d = Core.curateCaseDocument(request, 'S1', { ...base, selectedRunId: 'RUN1', selectedCloseHash: 123 });
    expect(Core.caseDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });
  test('J11-H6: selectedCloseHash over-length, selectedRunId valid -> unavailable_data_anomaly', () => {
    const d = Core.curateCaseDocument(request, 'S1', { ...base, selectedRunId: 'RUN1', selectedCloseHash: OVER_LENGTH });
    expect(Core.caseDecisionResponse(d)).toEqual({ status: 'unavailable_data_anomaly' });
  });

  // ---- 2 byte-preservation rows: a valid pointer with surrounding whitespace
  // must survive untrimmed, byte-for-byte ----
  test('J11-BP1: selectedRunId with surrounding whitespace is preserved byte-for-byte, not trimmed', () => {
    const d = Core.curateCaseDocument(request, 'S1', { ...base, selectedRunId: '  RUN1  ', selectedCloseHash: 'HASH1' });
    expect(Core.caseDecisionResponse(d)).toBeNull();
    expect(Core.caseDecisionView(d)?.selectedRunId).toBe('  RUN1  ');
  });
  test('J11-BP2: selectedCloseHash with surrounding whitespace is preserved byte-for-byte, not trimmed', () => {
    const d = Core.curateCaseDocument(request, 'S1', { ...base, selectedRunId: 'RUN1', selectedCloseHash: '  HASH1  ' });
    expect(Core.caseDecisionResponse(d)).toBeNull();
    expect(Core.caseDecisionView(d)?.selectedCloseHash).toBe('  HASH1  ');
  });
});

describe('C12 manifest arithmetic (RC-PS-02): exactly 26 entries / 31 bound comparison nodes', () => {
  test('manifest length is exactly 26', () => {
    expect(C12_MANIFEST.length).toBe(26);
  });
  test('bound comparison-node total is exactly 31', () => {
    expect(C12_BOUND_COMPARISON_NODE_COUNT).toBe(31);
  });
  test('CASE 9/14, RUN 11/11, EVIDENCE 6/6 sub-totals reconcile to 26/31', () => {
    const byFn = (fn: string) => C12_MANIFEST.filter((e) => e.fn === fn);
    const nodes = (entries: readonly C12ManifestEntry[]) => entries.reduce((s, e) => s + c12BoundNodeCount(e), 0);
    const caseEntries = byFn('curateCaseDocument');
    const runEntries = byFn('curateRunDocument');
    const evidenceEntries = byFn('curateEvidenceDocument');
    expect(caseEntries.length).toBe(9);
    expect(nodes(caseEntries)).toBe(14);
    expect(runEntries.length).toBe(11);
    expect(nodes(runEntries)).toBe(11);
    expect(evidenceEntries.length).toBe(6);
    expect(nodes(evidenceEntries)).toBe(6);
  });
});

// RC-PS-BI01-numeric / Gemini Option A ("layered proof"): the static-reverse
// layer. Every one of the 26 C12_MANIFEST entries is mapped to at least one
// existing mutation row that, when applied, defeats exactly that entry (and
// no other) — proving the manifest's reverse/anti-decoy properties directly,
// rather than merely asserting the manifest's shape. C5/R3/R7/E3 are already
// proven by pre-existing frozen rows (MC-58/75/76, MC-60/77, MC-59, MC-61
// respectively); the remaining 22 entries get a new, additive, dedicated
// REPLACE mutation here. These 22 rows are explicitly ADDITIVE EVIDENCE and
// are NOT part of the frozen 139-row / 167-row static matrix (RC-PS-02) —
// they reuse the same unmodified `expectMutation` harness and the same
// unmodified `analyzeCore`, so they carry the identical exact-set +
// changed-range guarantees, but they are counted and reported separately.
const C12_REVERSE_COVERAGE: Record<string, string[]> = {
  C2: ['C12R-C2'], C3: ['C12R-C3'], C4: ['C12R-C4'], C5: ['MC-58', 'MC-75', 'MC-76'],
  C6: ['C12R-C6'], C7: ['C12R-C7'], C8: ['C12R-C8'], C9: ['C12R-C9'], C10: ['C12R-C10'],
  R2: ['C12R-R2'], R3: ['MC-60', 'MC-77'], R4: ['C12R-R4'], R5: ['C12R-R5'], R6: ['C12R-R6'],
  R7: ['MC-59'], R8: ['C12R-R8'], R9: ['C12R-R9'], R10: ['C12R-R10'], R11: ['C12R-R11'], R12: ['C12R-R12'],
  E2: ['C12R-E2'], E3: ['MC-61'], E4: ['C12R-E4'], E5: ['C12R-E5'], E6: ['C12R-E6'], E7: ['C12R-E7'],
};

describe('C12 static-reverse per-entry coverage (RC-PS-BI01-numeric, additive — not part of the frozen 139/167 static matrix)', () => {
  test('every C12_MANIFEST entry ID has a mapped coverage row (machine-checked against the live manifest)', () => {
    const manifestIds = [...C12_MANIFEST.map((e) => e.id)].sort();
    const mappedIds = Object.keys(C12_REVERSE_COVERAGE).sort();
    expect(mappedIds).toEqual(manifestIds);
    expect(manifestIds.length).toBe(26);
    for (const id of manifestIds) {
      expect(C12_REVERSE_COVERAGE[id].length).toBeGreaterThanOrEqual(1);
    }
  });

  // ---- CASE (8 new; C5 already covered by MC-58/75/76) ----
  test('C12R-C2 (shiftId vs request.shiftId, absence-style)', () =>
    expectMutation('REPLACE',
      "  if (shiftIdRead.value !== request.shiftId) return { response: ANOMALY, view: null };",
      '  if (false) return { response: ANOMALY, view: null };',
      ['C12-INVARIANT-MISSING']));
  test('C12R-C3 (branch authority, self-comparison anti-decoy)', () =>
    expectMutation('REPLACE',
      "  if (branchIdRead.value !== request.branchId) return { response: DENIED, view: null };",
      '  if (branchIdRead.value !== branchIdRead.value) return { response: DENIED, view: null };',
      ['C12-INVARIANT-MISSING']));
  test('C12R-C4 (case version, swapped-operand anti-decoy)', () =>
    expectMutation('REPLACE',
      "  if (versionRead.value !== request.expectedCaseVersion) return { response: STALE, view: null };",
      '  if (request.expectedCaseVersion !== versionRead.value) return { response: STALE, view: null };',
      ['C12-INVARIANT-MISSING']));
  test('C12R-C6 (processingState, absence-style)', () =>
    expectMutation('REPLACE',
      "  if (processingRead.kind !== 'value') return { response: UNSUPPORTED, view: null };",
      "  if (false) return { response: UNSUPPORTED, view: null };",
      ['C12-INVARIANT-MISSING']));
  test('C12R-C7 (settlementState, absence-style)', () =>
    expectMutation('REPLACE',
      "  if (settlementRead.kind !== 'value') return { response: UNSUPPORTED, view: null };",
      "  if (false) return { response: UNSUPPORTED, view: null };",
      ['C12-INVARIANT-MISSING']));
  test('C12R-C8 (alertState, absence-style)', () =>
    expectMutation('REPLACE',
      "  if (alertRead.kind !== 'value') return { response: UNSUPPORTED, view: null };",
      "  if (false) return { response: UNSUPPORTED, view: null };",
      ['C12-INVARIANT-MISSING']));
  test('C12R-C9 (selectedRunId invalid, wrong-literal anti-decoy: a valid FieldRead tag, but the wrong one)', () =>
    expectMutation('REPLACE',
      "  if (runIdRead.kind === 'invalid') return { response: ANOMALY, view: null };",
      "  if (runIdRead.kind === 'missing') return { response: ANOMALY, view: null };",
      ['C12-INVARIANT-MISSING']));
  test('C12R-C10 (compound selection guard, absence-style)', () =>
    expectMutation('REPLACE',
      '  if (selectedRunId !== null && selectedCloseHash === null) {\n    return { response: ANOMALY, view: null };\n  }',
      '  if (false) {\n    return { response: ANOMALY, view: null };\n  }',
      ['C12-INVARIANT-MISSING']));

  // ---- RUN (9 new; R3/R7 already covered by MC-60/77/MC-59) ----
  test('C12R-R2 (runSnapshotId vs caseView.selectedRunId, absence-style)', () =>
    expectMutation('REPLACE',
      "  if (runSnapshotId !== caseView.selectedRunId) return { response: ANOMALY, view: null };",
      '  if (false) return { response: ANOMALY, view: null };',
      ['C12-INVARIANT-MISSING']));
  test('C12R-R4 (run shiftId vs caseView.shiftId, absence-style, unique-context anchor)', () =>
    expectMutation('REPLACE',
      "  if (runIdRead.value !== runSnapshotId) return { response: ANOMALY, view: null };\n  if (shiftIdRead.value !== caseView.shiftId) return { response: ANOMALY, view: null };",
      "  if (runIdRead.value !== runSnapshotId) return { response: ANOMALY, view: null };\n  if (false) return { response: ANOMALY, view: null };",
      ['C12-INVARIANT-MISSING']));
  test('C12R-R5 (run branchId vs caseView.branchId, absence-style, unique-context anchor)', () =>
    expectMutation('REPLACE',
      "  if (runIdRead.value !== runSnapshotId) return { response: ANOMALY, view: null };\n  if (shiftIdRead.value !== caseView.shiftId) return { response: ANOMALY, view: null };\n  if (branchIdRead.value !== caseView.branchId) return { response: ANOMALY, view: null };",
      "  if (runIdRead.value !== runSnapshotId) return { response: ANOMALY, view: null };\n  if (shiftIdRead.value !== caseView.shiftId) return { response: ANOMALY, view: null };\n  if (false) return { response: ANOMALY, view: null };",
      ['C12-INVARIANT-MISSING']));
  test('C12R-R6 (run closeHash vs caseView.selectedCloseHash, absence-style)', () =>
    expectMutation('REPLACE',
      "  if (hashRead.value !== caseView.selectedCloseHash) return { response: ANOMALY, view: null };",
      '  if (false) return { response: ANOMALY, view: null };',
      ['C12-INVARIANT-MISSING']));
  test('C12R-R8 (run schemaVersion, absence-style, unique-context anchor)', () =>
    expectMutation('REPLACE',
      "  if (hashRead.value !== caseView.selectedCloseHash) return { response: ANOMALY, view: null };\n  if (schemaRead.value !== SUPPORTED_SCHEMA_VERSION) return { response: ANOMALY, view: null };",
      "  if (hashRead.value !== caseView.selectedCloseHash) return { response: ANOMALY, view: null };\n  if (false) return { response: ANOMALY, view: null };",
      ['C12-INVARIANT-MISSING']));
  test('C12R-R9 (evidenceId join, absence-style)', () =>
    expectMutation('REPLACE',
      '  if (evidenceRead.value !== shiftIdRead.value + ID_JOIN + hashRead.value) {\n    return { response: ANOMALY, view: null };\n  }',
      '  if (false) {\n    return { response: ANOMALY, view: null };\n  }',
      ['C12-INVARIANT-MISSING']));
  test('C12R-R10 (validationVerdict, absence-style)', () =>
    expectMutation('REPLACE',
      "  if (verdictRead.kind !== 'value') return { response: ANOMALY, view: null };",
      "  if (false) return { response: ANOMALY, view: null };",
      ['C12-INVARIANT-MISSING']));
  test('C12R-R11 (serverComputedDrawer record, absence-style)', () =>
    expectMutation('REPLACE',
      "  if (drawerRead.kind !== 'value') return { response: ANOMALY, view: null };",
      "  if (false) return { response: ANOMALY, view: null };",
      ['C12-INVARIANT-MISSING']));
  test('C12R-R12 (perFieldDeltas record, absence-style)', () =>
    expectMutation('REPLACE',
      "  if (deltasRead.kind !== 'value') return { response: ANOMALY, view: null };",
      "  if (false) return { response: ANOMALY, view: null };",
      ['C12-INVARIANT-MISSING']));

  // ---- EVIDENCE (5 new; E3 already covered by MC-61) ----
  test('C12R-E2 (evidenceSnapshotId vs runView.evidenceId, absence-style)', () =>
    expectMutation('REPLACE',
      "  if (evidenceSnapshotId !== runView.evidenceId) return { response: ANOMALY, view: null };",
      '  if (false) return { response: ANOMALY, view: null };',
      ['C12-INVARIANT-MISSING']));
  test('C12R-E4 (evidence shiftId vs caseView.shiftId, absence-style, unique-context anchor)', () =>
    expectMutation('REPLACE',
      "  if (evidenceRead.value !== evidenceSnapshotId) return { response: ANOMALY, view: null };\n  if (shiftIdRead.value !== caseView.shiftId) return { response: ANOMALY, view: null };",
      "  if (evidenceRead.value !== evidenceSnapshotId) return { response: ANOMALY, view: null };\n  if (false) return { response: ANOMALY, view: null };",
      ['C12-INVARIANT-MISSING']));
  test('C12R-E5 (evidence branchId vs caseView.branchId, absence-style, unique-context anchor)', () =>
    expectMutation('REPLACE',
      "  if (evidenceRead.value !== evidenceSnapshotId) return { response: ANOMALY, view: null };\n  if (shiftIdRead.value !== caseView.shiftId) return { response: ANOMALY, view: null };\n  if (branchIdRead.value !== caseView.branchId) return { response: ANOMALY, view: null };",
      "  if (evidenceRead.value !== evidenceSnapshotId) return { response: ANOMALY, view: null };\n  if (shiftIdRead.value !== caseView.shiftId) return { response: ANOMALY, view: null };\n  if (false) return { response: ANOMALY, view: null };",
      ['C12-INVARIANT-MISSING']));
  test('C12R-E6 (evidence closeHash vs runView.closeHash, absence-style)', () =>
    expectMutation('REPLACE',
      "  if (hashRead.value !== runView.closeHash) return { response: ANOMALY, view: null };",
      '  if (false) return { response: ANOMALY, view: null };',
      ['C12-INVARIANT-MISSING']));
  test('C12R-E7 (evidence schemaVersion, absence-style, unique-context anchor)', () =>
    expectMutation('REPLACE',
      "  if (hashRead.value !== runView.closeHash) return { response: ANOMALY, view: null };\n  if (schemaRead.value !== SUPPORTED_SCHEMA_VERSION) return { response: ANOMALY, view: null };",
      "  if (hashRead.value !== runView.closeHash) return { response: ANOMALY, view: null };\n  if (false) return { response: ANOMALY, view: null };",
      ['C12-INVARIANT-MISSING']));
});

// ============================================================================
// PART B — the AST static guard: rules C1-C15 over CORE_BASELINE_V3
// ============================================================================

const CORE_LITERAL_KEYS_25 = [
  'branchId', 'shiftId', 'expectedCaseVersion', 'token', 'staffId', 'role', 'branchIds',
  'caseVersion', 'processingState', 'settlementState', 'alertState', 'selectedRunId',
  'selectedCloseHash', 'runId', 'closeHash', 'evidenceId', 'validationVerdict',
  'serverComputedDrawer', 'perFieldDeltas', 'expectedCashMinor', 'expectedCash',
  'actualCashCount', 'variance', 'schemaVersion', 'validationSchemaVersion',
] as const;

const EXCLUDED_FIELD_NAMES_39 = [
  'note', 'notes', 'reasonNote', 'message', 'description',
  'actor', 'acknowledgedByActor', 'resolvedByActor', 'staffName', 'actorUid', 'managerUid', 'uid',
  'cashEntries', 'cashEntriesSnapshot', 'cashEntriesMeta', 'sourceManifest', 'snapshot', 'rawSnapshot',
  'createdAt', 'updatedAt', 'createdAtServer', 'confirmedAtServer', 'capturedAt', 'openedAt',
  'resolvedAt', 'acknowledgedAt', 'leaseOwner', 'leaseExpiry',
  'sourceEvent', 'sourceEventBranch', 'sourceEventId',
  'commandId', 'payloadHash', 'payloadCanonical', 'auditEventId', 'eventId', 'pinVerifiedAtServer',
  'latestEvidenceId', 'latestCloseHash',
] as const;

expect(new Set(CORE_LITERAL_KEYS_25).size).toBe(25);
expect(new Set(EXCLUDED_FIELD_NAMES_39).size).toBe(39);
for (const k of CORE_LITERAL_KEYS_25) {
  if ((EXCLUDED_FIELD_NAMES_39 as readonly string[]).includes(k)) {
    throw new Error(`CoreLiteralKey/EXCLUDED_FIELD_NAMES collision: ${k}`);
  }
}

const GOVERNED_ENUM_BINDINGS = [
  'PROCESSING_STATES', 'SETTLEMENT_STATES', 'ALERT_STATES', 'VALIDATION_VERDICTS',
] as const;

const FIELD_READ_HELPERS_11 = [
  'ownRead', 'minorFrom', 'asRequiredId', 'asNullableId', 'asInteger', 'asNullableFinite',
  'asNullableSafeInteger', 'asEnum', 'asRecord', 'asArray', 'asPresent',
] as const;

const ALLOWED_READ_FUNCTIONS = [
  'readOwnLiteral', 'readCuratedRequestShiftId', 'readCuratedCaseSelectedRunId', 'readCuratedRunEvidenceId',
] as const;

// 'require' and the seven reflective/global names below are deliberately absent:
// 'require' is already the more specific rule C1-REQUIRE's exact concern, and
// 'Reflect' | 'Proxy' | 'eval' | 'Function' | 'globalThis' | 'WeakRef' |
// 'FinalizationRegistry' are already rule C7-GLOBAL's exact concern. Listing them
// here too would double-report the same identifier under two codes for the same
// mutation (MC-04, MC-12 … MC-17) with no added detection, since C1/C7 already
// catch every occurrence C2 would have.
const BANNED_IDENTIFIERS_C2 = [
  'Firestore', 'DocumentData', 'DocumentSnapshot', 'QueryDocumentSnapshot', 'DocumentReference',
  'CollectionReference', 'CollectionGroup', 'Query', 'QuerySnapshot', 'Transaction', 'WriteBatch',
  'BulkWriter', 'FieldValue', 'FieldPath', 'Timestamp', 'GeoPoint', 'Settings',
  'getFirestore', 'initializeApp', 'getApps', 'getApp', 'admin', 'firestore', 'db', 'database',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Request', 'Response', 'Headers',
  'FormData', 'navigator', 'process', 'Buffer', 'Bun', 'Deno',
  'readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'createReadStream', 'createWriteStream',
  'Date', 'performance', 'console', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
] as const;

const FORBIDDEN_MEMBER_NAMES_CORE = [
  'set', 'create', 'update', 'delete', 'add', 'batch', 'bulkWriter', 'runTransaction',
  'where', 'orderBy', 'limit', 'limitToLast', 'startAt', 'startAfter', 'endAt', 'endBefore',
  'offset', 'select', 'collectionGroup', 'collection', 'doc', 'listDocuments',
  'listCollections', 'onSnapshot', 'stream', 'getAll', 'bundle', 'recursiveDelete',
  'terminate', 'withConverter', 'settings',
] as const;

const BROAD_TYPE_NAMES = ['Record', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise'] as const;
const CURATED_INTERFACE_NAMES = [
  'CuratedRequestView', 'CuratedAuthClaims', 'CuratedCaseView', 'CuratedRunView', 'CuratedEvidenceView',
  'CaseDecision', 'RunDecision', 'EvidenceDecision', 'GetShiftCloseCaseFiguresResponse',
  'ValidationVerdict', 'FieldRead',
] as const;

// ============================================================================
// C12 — the frozen 26-entry / 31-bound-comparison-node
// CONTROL_FLOW_BOUND_COMPARISON_MANIFEST (plan R7 §8.4). Ten binding properties
// per entry: (1) containing function, (2) left operand text, (3) operator,
// (4) right operand text, (5) polarity, (6) enclosing IfStatement condition
// (not a free expression/argument/initializer), (7) failure-branch return of
// the exact frozen sentinel, (8) no `else` (success falls through), (9) a
// dominance point — approximated here as a statement-ordinal check (the
// containing function has no loop/switch/nesting, so this is sound per plan
// R7 §20 item 9's disclosed CFG-dominance approximation), and (10)
// uniqueness/no-decoy, which the "first satisfying match wins" search below
// guarantees (a syntactically matching decoy elsewhere neither satisfies nor
// disturbs the entry, because the search only needs one true positive).
// Plus two global clauses — no-self-comparison and no-swapped-side — both
// enforced by the exact left/right text equality check (a self- or
// swapped comparison never has the frozen text).
// CASE 9 entries / 14 bound nodes, RUN 11/11, EVIDENCE 6/6 = 26 / 31.
// (C10's compound && condition is counted as 3 bound nodes: its two operand
// comparisons plus the combining `&&` node itself, reconciling the frozen
// per-block counts in plan R7 §8.4 with the frozen grand total of 31.)
// ============================================================================
const C12_EQ = ts.SyntaxKind.EqualsEqualsEqualsToken;
const C12_NEQ = ts.SyntaxKind.ExclamationEqualsEqualsToken;

interface C12Binding {
  op: ts.SyntaxKind;
  left: string;
  right: string;
}
interface C12ManifestEntry {
  id: string;
  fn: string;
  sentinel: string;
  compound: boolean;
  parts: C12Binding[];
  /**
   * Packet S / C12 presence-order-contract exactification (D2): explicit,
   * hand-authored top-level-statement precedence within this entry's owning
   * function, independent of this array's own declaration order (which does
   * NOT match real production source order for curateRunDocument -- see
   * C12_MANIFEST_EXPECTED_ORDER below) and independent of any AST re-parse of
   * CORE_BASELINE_V3. Cross-checked once against the live baseline AST by the
   * dedicated order-contract test; analyzeCore's own order check compares
   * against this metadata, never against a baseline-AST-derived sequence.
   */
  sourceOrder: number;
  /**
   * C15 already independently re-derives, for exactly these guards, that the
   * failure branch returns the one correct sentinel (STALE for the version
   * pair, UNSUPPORTED for the three workflow-state reads) — see rule C15
   * below, which scans the same `curateCaseDocument` `IfStatement`s and
   * fires its own `C15-VERSION-STATUS` code whenever the sentinel is wrong.
   * For these entries only, C12 therefore checks existence/operands/operator/
   * no-else/dominance (properties 1-6, 8-10) but defers sentinel-identity
   * (property 7) to C15, so a wrong-sentinel mutation on one of these five
   * guards is reported once, under the narrower code, rather than twice.
   * Detection is not weakened: C15's set of acceptable outcomes is a strict
   * singleton, so nothing a relaxed C12 would have caught here escapes both
   * rules. This mirrors the plan's own accepted C1/R1/E1/E8 C12 exclusions
   * (each governed by a different, more specific rule instead).
   */
  sentinelGovernedByC15?: boolean;
}

const C12_MANIFEST: readonly C12ManifestEntry[] = [
  { id: 'C3', fn: 'curateCaseDocument', sentinel: 'DENIED', compound: false, sourceOrder: 0, parts: [
    { op: C12_NEQ, left: 'branchIdRead.value', right: 'request.branchId' },
  ] },
  { id: 'C4', fn: 'curateCaseDocument', sentinel: 'STALE', compound: false, sourceOrder: 1, sentinelGovernedByC15: true, parts: [
    { op: C12_NEQ, left: 'versionRead.kind', right: "'value'" },
    { op: C12_NEQ, left: 'versionRead.value', right: 'request.expectedCaseVersion' },
  ] },
  { id: 'C2', fn: 'curateCaseDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 2, parts: [
    { op: C12_NEQ, left: 'shiftIdRead.value', right: 'request.shiftId' },
    { op: C12_NEQ, left: 'shiftIdRead.value', right: 'caseSnapshotId' },
  ] },
  { id: 'C5', fn: 'curateCaseDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 3, parts: [
    { op: C12_NEQ, left: 'schemaRead.value', right: 'SUPPORTED_SCHEMA_VERSION' },
  ] },
  { id: 'C6', fn: 'curateCaseDocument', sentinel: 'UNSUPPORTED', compound: false, sourceOrder: 4, sentinelGovernedByC15: true, parts: [
    { op: C12_NEQ, left: 'processingRead.kind', right: "'value'" },
  ] },
  { id: 'C7', fn: 'curateCaseDocument', sentinel: 'UNSUPPORTED', compound: false, sourceOrder: 5, sentinelGovernedByC15: true, parts: [
    { op: C12_NEQ, left: 'settlementRead.kind', right: "'value'" },
  ] },
  { id: 'C8', fn: 'curateCaseDocument', sentinel: 'UNSUPPORTED', compound: false, sourceOrder: 6, sentinelGovernedByC15: true, parts: [
    { op: C12_NEQ, left: 'alertRead.kind', right: "'value'" },
  ] },
  { id: 'C9', fn: 'curateCaseDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 7, parts: [
    { op: C12_EQ, left: 'runIdRead.kind', right: "'invalid'" },
    { op: C12_EQ, left: 'hashRead.kind', right: "'invalid'" },
  ] },
  { id: 'C10', fn: 'curateCaseDocument', sentinel: 'ANOMALY', compound: true, sourceOrder: 8, parts: [
    { op: C12_NEQ, left: 'selectedRunId', right: 'null' },
    { op: C12_EQ, left: 'selectedCloseHash', right: 'null' },
  ] },
  // curateRunDocument: real production source (getShiftCloseCaseFiguresCore.ts
  // lines 486-508) places all ten `.kind !== 'value'` presence-shape checks as
  // one block BEFORE the R2-R9 value-level comparisons -- so the three
  // C12-governed kind checks (R10/R11/R12) sourceOrder *before* R2-R9, even
  // though they are declared last in this array. R8 (schemaRead) precedes R7
  // (validationSchemaRead) in source, ahead of their declaration order too.
  { id: 'R2', fn: 'curateRunDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 3, parts: [
    { op: C12_NEQ, left: 'runSnapshotId', right: 'caseView.selectedRunId' },
  ] },
  { id: 'R3', fn: 'curateRunDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 4, parts: [
    { op: C12_NEQ, left: 'runIdRead.value', right: 'runSnapshotId' },
  ] },
  { id: 'R4', fn: 'curateRunDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 5, parts: [
    { op: C12_NEQ, left: 'shiftIdRead.value', right: 'caseView.shiftId' },
  ] },
  { id: 'R5', fn: 'curateRunDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 6, parts: [
    { op: C12_NEQ, left: 'branchIdRead.value', right: 'caseView.branchId' },
  ] },
  { id: 'R6', fn: 'curateRunDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 7, parts: [
    { op: C12_NEQ, left: 'hashRead.value', right: 'caseView.selectedCloseHash' },
  ] },
  { id: 'R8', fn: 'curateRunDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 8, parts: [
    { op: C12_NEQ, left: 'schemaRead.value', right: 'SUPPORTED_SCHEMA_VERSION' },
  ] },
  { id: 'R7', fn: 'curateRunDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 9, parts: [
    { op: C12_NEQ, left: 'validationSchemaRead.value', right: 'SUPPORTED_VALIDATION_SCHEMA_VERSION' },
  ] },
  { id: 'R9', fn: 'curateRunDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 10, parts: [
    { op: C12_NEQ, left: 'evidenceRead.value', right: 'shiftIdRead.value + ID_JOIN + hashRead.value' },
  ] },
  { id: 'R10', fn: 'curateRunDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 0, parts: [
    { op: C12_NEQ, left: 'verdictRead.kind', right: "'value'" },
  ] },
  { id: 'R11', fn: 'curateRunDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 1, parts: [
    { op: C12_NEQ, left: 'drawerRead.kind', right: "'value'" },
  ] },
  { id: 'R12', fn: 'curateRunDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 2, parts: [
    { op: C12_NEQ, left: 'deltasRead.kind', right: "'value'" },
  ] },
  { id: 'E2', fn: 'curateEvidenceDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 0, parts: [
    { op: C12_NEQ, left: 'evidenceSnapshotId', right: 'runView.evidenceId' },
  ] },
  { id: 'E3', fn: 'curateEvidenceDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 1, parts: [
    { op: C12_NEQ, left: 'evidenceRead.value', right: 'evidenceSnapshotId' },
  ] },
  { id: 'E4', fn: 'curateEvidenceDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 2, parts: [
    { op: C12_NEQ, left: 'shiftIdRead.value', right: 'caseView.shiftId' },
  ] },
  { id: 'E5', fn: 'curateEvidenceDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 3, parts: [
    { op: C12_NEQ, left: 'branchIdRead.value', right: 'caseView.branchId' },
  ] },
  { id: 'E6', fn: 'curateEvidenceDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 4, parts: [
    { op: C12_NEQ, left: 'hashRead.value', right: 'runView.closeHash' },
  ] },
  { id: 'E7', fn: 'curateEvidenceDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 5, parts: [
    { op: C12_NEQ, left: 'schemaRead.value', right: 'SUPPORTED_SCHEMA_VERSION' },
  ] },
];

/**
 * Packet S / C12 presence-order-contract exactification (D2/D3): the frozen
 * expected ordered slot sequence per governed function, derived exclusively
 * from C12_MANIFEST's own `sourceOrder` + `parts`/`compound` shape metadata --
 * no AST, no CORE_BASELINE_V3 reference of any kind. This is what
 * analyzeCore's order check (RC-C12-02) now compares the actual, live-parsed
 * source's resolved slot order against, replacing the former baseline-AST-
 * re-derivation (`getC12FrozenSlotOrder`, retained below only as the
 * independent actual-order oracle for the dedicated cross-check test).
 */
function c12ExpectedOrderFromManifest(manifest: readonly C12ManifestEntry[]): Map<string, string[]> {
  const byFn = new Map<string, string[]>();
  for (const fn of [...new Set(manifest.map((e) => e.fn))]) {
    const entries = manifest
      .filter((e) => e.fn === fn)
      .slice()
      .sort((a, b) => a.sourceOrder - b.sourceOrder);
    const seq: string[] = [];
    for (const entry of entries) {
      const nodeCount = c12BoundNodeCount(entry);
      for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) {
        seq.push(`${entry.id}#${ordinal}`);
      }
    }
    byFn.set(fn, seq);
  }
  return byFn;
}
const C12_MANIFEST_EXPECTED_ORDER: ReadonlyMap<string, string[]> = c12ExpectedOrderFromManifest(C12_MANIFEST);

function c12BoundNodeCount(entry: C12ManifestEntry): number {
  return entry.compound ? entry.parts.length + 1 : entry.parts.length;
}

const C12_BOUND_COMPARISON_NODE_COUNT = C12_MANIFEST.reduce((sum, e) => sum + c12BoundNodeCount(e), 0);

// ============================================================================
// RC-FINAL-02 / C12 CLOSED WORLD (PS-C17 supersession): the frozen 31-entry
// PERMITTED FINGERPRINT inventory, machine-derived from C12_MANIFEST itself
// (never hand-copied), plus a whole-module governed-candidate scanner and a
// multiset-equality check wired into analyzeCore below. Where the existing
// per-entry checkSingleBinding/checkCompoundBinding loop only asks "does the
// exact frozen text exist somewhere inside its own owning function" (so it
// cannot see a decoy occurring in the *wrong* function, self-compared, or
// swapped), this closed-world layer instead asks "does the *entire module*
// contain exactly the permitted 31 governed comparisons and nothing else,
// counted with multiplicity" -- which is what lets a decoy like the old
// PS-C17 (`caseView.schemaVersion !== SUPPORTED_SCHEMA_VERSION`, sharing the
// real SUPPORTED_SCHEMA_VERSION binding but in an unrelated function) surface
// as an extra governed candidate instead of passing silently.
// ============================================================================
function c12OperatorText(op: ts.SyntaxKind): string {
  if (op === C12_EQ) return '===';
  if (op === C12_NEQ) return '!==';
  if (op === ts.SyntaxKind.EqualsEqualsToken) return '==';
  if (op === ts.SyntaxKind.ExclamationEqualsToken) return '!=';
  if (op === ts.SyntaxKind.AmpersandAmpersandToken) return '&&';
  return String(op);
}

interface C12StructFingerprint {
  /** Metadata only (not part of the matching key): which manifest entry/ordinal this
   *  slot represents. '' / -1 for an actual candidate, since independent discovery
   *  cannot know which manifest slot (if any) a candidate was "trying" to be. */
  manifestId: string;
  boundNodeOrdinal: number;
  fn: string;
  op: string;
  left: string;
  right: string;
  /** ts.SyntaxKind name of the comparison's parent node (IfStatement, VariableDeclaration,
   *  ConditionalExpression, BinaryExpression for &&, ...). */
  stmtKind: string;
  /** Property 6: is this node the direct, un-nested condition of an IfStatement? */
  directIfCondition: boolean;
  /** Property 8: does the enclosing if have no `else`? (false when not directIfCondition) */
  hasElse: boolean;
  /** Property 7, loosened to "any of the 4 frozen sentinels": sentinel *identity* is
   *  C15's job for the 5 sentinelGovernedByC15 entries and is never re-litigated here
   *  (mirrors the existing per-entry `acceptable` list). Does the enclosing if return
   *  `{ response: <ANOMALY|DENIED|STALE|UNSUPPORTED>, view: null }`? */
  acceptableSentinelShape: boolean;
  /** Property 9 (dominance). */
  dominanceOk: boolean;
}

/**
 * The structural multiset key: every dimension a permitted slot and an actual
 * candidate must agree on to be the same governed comparison. Manifest ID and
 * bound-node ordinal are deliberately excluded from the key (an independently
 * discovered candidate cannot know which manifest slot it was "trying" to be --
 * that identity is carried as metadata on the fingerprint object instead).
 *
 * `dominanceOk` is deliberately excluded from the key too, though it remains a
 * carried fingerprint field (a real, structural dimension a mutation can defeat
 * -- see the existing dominatesFinalReturn-driven per-entry checks, which
 * already enforce it with correctly mutation-range-bound violations). Property
 * 9's approximation is a *global*, statement-ordinal property of the containing
 * function, not a local property of one comparison: a single early decoy return
 * (MC-65) can flip `dominanceOk` for every *later, still entirely real and
 * unmutated* guard in the same function. Folding that into the multiset key
 * would turn each of those untouched real nodes into a spurious "extra"
 * candidate anchored at its own (far away, out-of-mutation-range) location,
 * duplicating and mis-locating a finding the per-entry loop already reports
 * correctly, structurally, and in-range. `acceptableSentinelShape` and
 * `hasElse` have no such cross-node cascade (each is evaluated from one
 * IfStatement alone), so they safely stay part of the key.
 */
function c12StructKey(fp: C12StructFingerprint): string {
  return [
    fp.fn, fp.op, fp.left, fp.right, fp.stmtKind,
    fp.directIfCondition, fp.hasElse, fp.acceptableSentinelShape,
  ].join(' :: ');
}

/**
 * The frozen 31-node permitted inventory (RC-FINAL-02A): built from C12_MANIFEST's
 * own declared shape, not a stale hand copy. Every C12_MANIFEST entry's binding
 * properties 6-9 (direct if-condition, sentinel-shape return, no-else, dominance)
 * are uniform by construction (documented at C12_MANIFEST's declaration above), so
 * every permitted slot's structural dimensions are derived from that uniform
 * template rather than re-parsed per call.
 */
function buildC12PermittedStructFingerprints(manifest: readonly C12ManifestEntry[]): C12StructFingerprint[] {
  const out: C12StructFingerprint[] = [];
  for (const entry of manifest) {
    // A compound entry's individual parts are sub-expressions of the `&&` node
    // (their AST parent is the BinaryExpression, not the IfStatement itself) --
    // only the combined `&&` node below is the direct if-condition. Properties
    // 6-9 therefore only apply, and are only asserted, at the compound level.
    entry.parts.forEach((part, ordinal) => {
      out.push({
        manifestId: entry.id,
        boundNodeOrdinal: ordinal,
        fn: entry.fn,
        op: c12OperatorText(part.op),
        left: part.left,
        right: part.right,
        stmtKind: entry.compound ? 'BinaryExpression' : 'IfStatement',
        directIfCondition: !entry.compound,
        hasElse: false,
        acceptableSentinelShape: !entry.compound,
        dominanceOk: !entry.compound,
      });
    });
    if (entry.compound) {
      const [a, b] = entry.parts;
      out.push({
        manifestId: entry.id,
        boundNodeOrdinal: entry.parts.length,
        fn: entry.fn,
        op: '&&',
        left: `${a.left} ${c12OperatorText(a.op)} ${a.right}`,
        right: `${b.left} ${c12OperatorText(b.op)} ${b.right}`,
        stmtKind: 'IfStatement',
        directIfCondition: true,
        hasElse: false,
        acceptableSentinelShape: true,
        dominanceOk: true,
      });
    }
  }
  return out;
}

/** The frozen 31-node permitted inventory (RC-FINAL-02): C12_PERMITTED_FINGERPRINT_COUNT. */
const C12_PERMITTED_FINGERPRINTS: readonly C12StructFingerprint[] = buildC12PermittedStructFingerprints(C12_MANIFEST);

/**
 * Packet S / C12 presence-order-contract exactification (D1): the exact,
 * frozen three-slot benign field-*presence* inventory, replacing the removed
 * blanket `xRead.kind === 'missing'` admission exclusion. These three real,
 * permanent production checks (getShiftCloseCaseFiguresCore.ts, curateCaseDocument,
 * immediately after the processingRead/settlementRead/alertRead FieldRead
 * declarations) ask whether a field was omitted from the record entirely --
 * a distinct semantic category from the shape/value invariant C12's 31 slots
 * govern -- so they get their own frozen permitted inventory, built with the
 * exact same shape-template builder (buildC12PermittedStructFingerprints) and
 * reconciled the same way, rather than hidden from discovery. Reusing
 * C12ManifestEntry/C12Binding directly (not a parallel ad hoc shape) is
 * deliberate: every one of BP1-BP3's structural dimensions (direct
 * if-condition, no else, ANOMALY sentinel, dominance) is therefore derived
 * from the identical template C12's own 31 slots use, not hand-duplicated.
 */
const C12_BENIGN_PRESENCE_MANIFEST: readonly C12ManifestEntry[] = [
  { id: 'BP1', fn: 'curateCaseDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 0, parts: [
    { op: C12_EQ, left: 'processingRead.kind', right: "'missing'" },
  ] },
  { id: 'BP2', fn: 'curateCaseDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 1, parts: [
    { op: C12_EQ, left: 'settlementRead.kind', right: "'missing'" },
  ] },
  { id: 'BP3', fn: 'curateCaseDocument', sentinel: 'ANOMALY', compound: false, sourceOrder: 2, parts: [
    { op: C12_EQ, left: 'alertRead.kind', right: "'missing'" },
  ] },
];
/** The frozen 3-node benign-presence permitted inventory: BENIGN_PRESENCE_SLOT_COUNT. */
const C12_BENIGN_PRESENCE_FINGERPRINTS: readonly C12StructFingerprint[] =
  buildC12PermittedStructFingerprints(C12_BENIGN_PRESENCE_MANIFEST);

/**
 * Packet S / C12 benign-presence exactness final remediation (RC-PRESENCE-01):
 * the frozen expected BP1/BP2/BP3 order, derived the identical way
 * C12_MANIFEST_EXPECTED_ORDER is (c12ExpectedOrderFromManifest, manifest
 * metadata only -- no AST). Compared against the live-resolved benign slot
 * order inside analyzeCore below, mirroring the 31-slot order check exactly.
 */
const C12_BENIGN_PRESENCE_EXPECTED_ORDER: ReadonlyMap<string, string[]> =
  c12ExpectedOrderFromManifest(C12_BENIGN_PRESENCE_MANIFEST);

/**
 * Packet S / C12 benign-presence exactness final remediation (RC-PRESENCE-01):
 * BP1-BP3 share c12StructKey/boundReturnsSentinelNoElse with the 31 real C12
 * slots, but that shared machinery only binds a *loosened* sentinel-shape
 * boolean (true for any of the four frozen sentinels, ANOMALY/DENIED/STALE/
 * UNSUPPORTED) and never inspects the `view` property at all. That looseness
 * is safe for the 31 real slots -- each is independently re-checked against
 * its own single correct sentinel by the checkSingleBinding/checkCompoundBinding
 * entry.sentinel-scoped loop in analyzeCore -- but BP1-BP3 are not
 * C12_MANIFEST members and have no equivalent per-entry loop, so a wrong
 * sentinel among the other three, a non-null view, a missing view key, or an
 * extra return key all currently pass through undetected. This model and its
 * builder close that gap for the three benign slots only; c12StructKey,
 * C12_PERMITTED_FINGERPRINTS, and the 31-slot per-entry loop are untouched.
 */
interface BenignPresenceReturnSignature {
  returnObjectExact: boolean;
  returnPropertyCount: number;
  returnPropertyKeys: readonly string[];
  responseIdentifier: string | null;
  viewLiteralKind: 'null' | 'other' | 'missing';
  hasSpread: boolean;
  hasComputed: boolean;
  hasDuplicateKey: boolean;
  hasExtraKey: boolean;
  hasMissingKey: boolean;
}

const BENIGN_EXPECTED_RETURN_KEYS: readonly string[] = ['response', 'view'];

/**
 * Exact benign branch-return signature: `if (<cond>) { return { response:
 * ANOMALY, view: null }; }` (or the bare-statement equivalent), no `else`,
 * exactly two properties, no spread/computed/shorthand/method/accessor
 * property, no duplicate/extra/missing key, `response` bound to the bare
 * identifier `ANOMALY`, `view` bound to the literal `null` keyword.
 */
function computeBenignPresenceReturnSignature(ifStmt: ts.IfStatement): BenignPresenceReturnSignature {
  const notExact = (partial: Partial<BenignPresenceReturnSignature>): BenignPresenceReturnSignature => ({
    returnObjectExact: false,
    returnPropertyCount: 0,
    returnPropertyKeys: [],
    responseIdentifier: null,
    viewLiteralKind: 'missing',
    hasSpread: false,
    hasComputed: false,
    hasDuplicateKey: false,
    hasExtraKey: true,
    hasMissingKey: true,
    ...partial,
  });
  if (ifStmt.elseStatement) return notExact({});
  const thenStmts = ts.isBlock(ifStmt.thenStatement) ? ifStmt.thenStatement.statements : [ifStmt.thenStatement];
  if (thenStmts.length !== 1) return notExact({});
  const stmt = thenStmts[0];
  if (!ts.isReturnStatement(stmt) || !stmt.expression || !ts.isObjectLiteralExpression(stmt.expression)) {
    return notExact({});
  }
  const obj = stmt.expression;

  let hasSpread = false;
  let hasComputed = false;
  let hasNonStandardShape = false;
  const keyTexts: string[] = [];
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      hasSpread = true;
      continue;
    }
    if (
      ts.isMethodDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isShorthandPropertyAssignment(p) ||
      !ts.isPropertyAssignment(p)
    ) {
      hasNonStandardShape = true;
      continue;
    }
    if (ts.isComputedPropertyName(p.name)) {
      hasComputed = true;
      continue;
    }
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
    if (key === null) {
      hasNonStandardShape = true;
      continue;
    }
    keyTexts.push(key);
  }

  const hasDuplicateKey = new Set(keyTexts).size !== keyTexts.length;
  const keySet = new Set(keyTexts);
  const hasExtraKey =
    hasNonStandardShape || hasSpread || hasComputed || keyTexts.some((k) => !BENIGN_EXPECTED_RETURN_KEYS.includes(k));
  const hasMissingKey = BENIGN_EXPECTED_RETURN_KEYS.some((k) => !keySet.has(k));

  const responseProp = obj.properties.find(
    (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'response',
  );
  const responseIdentifier =
    responseProp && ts.isIdentifier(responseProp.initializer) ? responseProp.initializer.text : null;

  const viewProp = obj.properties.find(
    (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'view',
  );
  const viewLiteralKind: BenignPresenceReturnSignature['viewLiteralKind'] = !viewProp
    ? 'missing'
    : viewProp.initializer.kind === ts.SyntaxKind.NullKeyword
      ? 'null'
      : 'other';

  const returnObjectExact =
    !hasSpread &&
    !hasComputed &&
    !hasNonStandardShape &&
    !hasDuplicateKey &&
    !hasExtraKey &&
    !hasMissingKey &&
    obj.properties.length === 2 &&
    responseIdentifier === 'ANOMALY' &&
    viewLiteralKind === 'null';

  return {
    returnObjectExact,
    returnPropertyCount: obj.properties.length,
    returnPropertyKeys: [...keyTexts].sort(),
    responseIdentifier,
    viewLiteralKind,
    hasSpread,
    hasComputed,
    hasDuplicateKey,
    hasExtraKey,
    hasMissingKey,
  };
}

/**
 * The combined permitted inventory (31 C12 + 3 benign-presence = 34) used
 * only by the closed-world missing/extra reconciliation (both in analyzeCore
 * and in the dedicated baseline inventory test): a candidate matching either
 * a C12 slot or a benign-presence slot is accounted for; the keys are
 * disjoint by construction (no C12_MANIFEST part's right operand is the
 * literal `'missing'`), so combining them is a plain multiset union, not a
 * behavior change to either reconciliation. The 31-slot *order* check
 * (RC-C12-02 / C12_MANIFEST_EXPECTED_ORDER) deliberately still uses
 * C12_PERMITTED_FINGERPRINTS alone -- benign-presence slots are not part of
 * the 31-slot ordered contract and get their own, separate order assertion
 * (see the dedicated benign-presence inventory test below).
 */
const C12_ALL_PERMITTED_FOR_CLOSED_WORLD: readonly C12StructFingerprint[] = [
  ...C12_PERMITTED_FINGERPRINTS,
  ...C12_BENIGN_PRESENCE_FINGERPRINTS,
];

function c12IsKindDiscriminantPath(text: string): boolean {
  return /\.kind$/.test(text);
}
function c12IsStringLiteralText(text: string): boolean {
  return /^['"]/.test(text);
}
/**
 * The `xRead.value` idiom recurs (with different local names, but the same
 * `...Read.value` shape) in several non-governed functions too -- e.g.
 * curateRequestView also declares its own `branchIdRead`/`versionRead`
 * locals for unrelated fields. So unlike a dedicated pointer identifier or a
 * module constant, this shape is not solo-trustworthy; it is covered instead
 * by C12_NONKIND_PAIR_VOCAB below, which requires the exact frozen partner
 * operand too (verified collision-free in RC-FINAL-02's completion report).
 */
function c12IsReadValueAccessor(text: string): boolean {
  return /Read\.value$/.test(text);
}

function c12PartIsKindBased(p: C12Binding): boolean {
  return c12IsKindDiscriminantPath(p.left) || c12IsKindDiscriminantPath(p.right);
}
const C12_NONKIND_PARTS: readonly C12Binding[] = C12_MANIFEST.flatMap((e) => e.parts).filter(
  (p) => !c12PartIsKindBased(p),
);
const C12_KIND_PARTS: readonly C12Binding[] = C12_MANIFEST.flatMap((e) => e.parts).filter(c12PartIsKindBased);

/**
 * Operands that are, by themselves, sufficient to mark a comparison a governed
 * candidate regardless of the other side: the two frozen module-level version
 * constants, plus the plain pointer/parameter-derived accessors that are each
 * unique to a single owning function's parameter list (request.*, caseView.*,
 * runView.*, and the bare snapshot-id parameter names). `.kind` discriminant
 * reads and `xRead.value` local accessors are excluded (see
 * c12IsReadValueAccessor above and the kind-pair note below) -- every
 * remaining solo entry occurs, across the whole frozen production module, in
 * exactly the manifest-bound comparison(s) that reference it (verified in
 * RC-FINAL-02's completion report), so solo membership cannot over-fire on
 * the clean baseline.
 */
const C12_SOLO_VOCAB: ReadonlySet<string> = new Set(
  C12_NONKIND_PARTS.flatMap((p) => [p.left, p.right]).filter(
    (t) => !c12IsStringLiteralText(t) && t !== 'null' && !c12IsReadValueAccessor(t),
  ),
);

/** Exact non-kind (left,right) pairs (either order) -- a safety-net for the
 *  one non-kind part (R9's evidenceId join) whose *both* operands are
 *  excluded from solo status. */
const C12_NONKIND_PAIR_VOCAB: ReadonlySet<string> = new Set(
  C12_NONKIND_PARTS.map((p) => `${p.left} :: ${p.right}`),
);
/**
 * RC-FINAL-02A closure: per-owning-function governed vocabulary for the two
 * shapes candidate discovery previously missed independently of decision shape
 * (Codex P1-P4) -- bare `.kind` discriminant reads and bare `Read.value`
 * cross-accessor pairs. Built directly from C12_MANIFEST (never hand-copied):
 * each kind-bearing operand, and each Read.value operand, is mapped to the
 * *set* of owning functions in which the manifest actually binds it (several
 * are shared -- e.g. branchIdRead.value/shiftIdRead.value are each governed in
 * all three curate* functions). Admission requires *both* the operand-text
 * match *and* that the comparison's nearest enclosing C12-governed curate*
 * function ancestor (searched past any nested function boundary, so a
 * wrong-function decoy nested inside the right outer curate* function is
 * still admitted) is in that owner set -- independent of branch/statement
 * shape, which is a fingerprint-validation dimension (C12StructFingerprint)
 * rather than an admission gate. This is what lets curateRequestView's own,
 * unrelated, same-named `versionRead.kind !== 'value'` guard (a real,
 * permanent, non-C12 check) stay excluded (its only enclosing function is
 * curateRequestView, never one of the three governed functions) while a decoy
 * sharing the identical text but nested or placed inside a governed function
 * is admitted and then fails fingerprint validation instead.
 *
 * RC-C12-02 closure: the owner-function set itself is derived from the live
 * manifest (`new Set(C12_MANIFEST.map(e => e.fn))`), not a second hand-typed
 * name array -- a future manifest owner is picked up automatically, and any
 * drift between the two would have shown up as a live-analyzer discrepancy
 * rather than silently diverging.
 */
const GOVERNED_CURATE_FUNCTIONS: readonly string[] = [...new Set(C12_MANIFEST.map((e) => e.fn))];

function enclosingGovernedCurateFunction(node: ts.Node): string | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name && GOVERNED_CURATE_FUNCTIONS.includes(cur.name.text)) {
      return cur.name.text;
    }
    cur = cur.parent;
  }
  return null;
}

const C12_KIND_LHS_OWNERS = new Map<string, Set<string>>();
const C12_VALUE_ACCESSOR_OWNERS = new Map<string, Set<string>>();
for (const entry of C12_MANIFEST) {
  for (const part of entry.parts) {
    if (c12PartIsKindBased(part)) {
      const kindText = c12IsKindDiscriminantPath(part.left) ? part.left : part.right;
      const owners = C12_KIND_LHS_OWNERS.get(kindText) ?? new Set<string>();
      owners.add(entry.fn);
      C12_KIND_LHS_OWNERS.set(kindText, owners);
    } else {
      for (const side of [part.left, part.right]) {
        if (c12IsReadValueAccessor(side)) {
          const owners = C12_VALUE_ACCESSOR_OWNERS.get(side) ?? new Set<string>();
          owners.add(entry.fn);
          C12_VALUE_ACCESSOR_OWNERS.set(side, owners);
        }
      }
    }
  }
}

/** Excludes a comparison sitting directly in a ternary's condition slot: the
 *  `xRead.kind === 'value' ? xRead.value : null` idiom is a real, legitimate,
 *  permanent data-*extraction* pattern reused for runIdRead/hashRead in
 *  curateCaseDocument (unwrapping a FieldRead, not a rejecting guard), and it
 *  is not itself part of any P1-P4/P5 probe shape, so it must stay outside
 *  scoped-kind admission rather than surface as a false extra candidate. */
function c12IsTernaryCondition(node: ts.Node): boolean {
  return ts.isConditionalExpression(node.parent) && node.parent.condition === node;
}

/**
 * Packet S / C12 presence-order-contract exactification (D1): the former
 * blanket `xRead.kind === 'missing'` admission-time exclusion (RC-C12-01) is
 * removed. Candidate admission is now truly literal-agnostic for every
 * governed `.kind` operand -- including against the `'missing'` literal --
 * subject only to the ternary-unwrap idiom exclusion above. The three real,
 * legitimate field-*presence* checks this used to blanket-exclude
 * (processingRead.kind / settlementRead.kind / alertRead.kind === 'missing'
 * in curateCaseDocument) are instead admitted as ordinary governed
 * candidates and reconciled against an exact three-slot benign-presence
 * inventory (BP1-BP3, see C12_BENIGN_PRESENCE_MANIFEST below), the same way
 * the 31 real C12 slots are reconciled against C12_PERMITTED_FINGERPRINTS.
 * Anything merely *shaped* like one of those three (wrong field, wrong
 * statement, wrong owning function) now surfaces as an extra governed
 * candidate -- C12-INVARIANT-MISSING -- instead of vanishing into a blanket
 * literal/operator exclusion (see the P8 probes below).
 */
function c12ScopedKindMatch(kindText: string, otherText: string, node: ts.BinaryExpression): boolean {
  if (c12IsTernaryCondition(node)) return false;
  const owners = C12_KIND_LHS_OWNERS.get(kindText);
  if (!owners) return false;
  const scope = enclosingGovernedCurateFunction(node);
  return scope !== null && owners.has(scope);
}

function c12ScopedValueAccessorMatch(text: string, node: ts.Node): boolean {
  const owners = C12_VALUE_ACCESSOR_OWNERS.get(text);
  if (!owners) return false;
  const scope = enclosingGovernedCurateFunction(node);
  return scope !== null && owners.has(scope);
}

function c12PairInVocab(vocab: ReadonlySet<string>, left: string, right: string): boolean {
  return vocab.has(`${left} :: ${right}`) || vocab.has(`${right} :: ${left}`);
}

/** The full operand vocabulary (kind included), for self-comparison detection only. */
const C12_ALL_OPERAND_TEXTS: ReadonlySet<string> = new Set(
  C12_MANIFEST.flatMap((e) => e.parts.flatMap((p) => [p.left, p.right])),
);

const C12_ALL_SENTINELS = ['ANOMALY', 'DENIED', 'STALE', 'UNSUPPORTED'];

/** Property 8 (no else) + property 7 (loosened, see C12StructFingerprint.acceptableSentinelShape
 *  doc comment): does this IfStatement's then-branch return exactly one `return { response:
 *  <one of `acceptable`>, view: null };`, with no `else`? Module-level (not analyzeCore-nested)
 *  so both the per-entry checkSingleBinding/checkCompoundBinding loop below and the closed-world
 *  candidate fingerprinter share one definition. */
function boundReturnsSentinelNoElse(ifStmt: ts.IfStatement, acceptable: readonly string[]): boolean {
  if (ifStmt.elseStatement) return false;
  const stmt = ts.isBlock(ifStmt.thenStatement) ? ifStmt.thenStatement.statements[0] : ifStmt.thenStatement;
  if (!stmt || !ts.isReturnStatement(stmt) || !stmt.expression) return false;
  if (!ts.isObjectLiteralExpression(stmt.expression)) return false;
  const responseProp = stmt.expression.properties.find(
    (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'response',
  ) as ts.PropertyAssignment | undefined;
  if (!responseProp) return false;
  return ts.isIdentifier(responseProp.initializer) && acceptable.includes(responseProp.initializer.text);
}

/** Property 9 (dominance, statement-ordinal approximation): the guard must precede
 *  the containing function's final `return { response: null, view: ... }`. */
function dominatesFinalReturn(ifStmt: ts.IfStatement): boolean {
  let body: ts.Block | undefined;
  let cur: ts.Node | undefined = ifStmt.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.body) {
      body = cur.body;
      break;
    }
    cur = cur.parent;
  }
  if (!body) return false;
  const stmts = body.statements;
  const ifIndex = stmts.indexOf(ifStmt as unknown as ts.Statement);
  if (ifIndex === -1) return false;
  const finalReturnIndex = stmts.findIndex(
    (s) =>
      ts.isReturnStatement(s) &&
      !!s.expression &&
      ts.isObjectLiteralExpression(s.expression) &&
      s.expression.properties.some(
        (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'response',
      ) &&
      s.expression.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === 'response' &&
          p.initializer.kind === ts.SyntaxKind.NullKeyword,
      ),
  );
  if (finalReturnIndex === -1) return true; // no terminal-null return in this function shape; do not block on it
  return ifIndex < finalReturnIndex;
}

/**
 * RC-FINAL-02A/RC-C12-01 closure: candidate admission is independent of both
 * the decoy's branch/statement shape (Codex P1-P4) and, for the two *scoped*
 * checks, the correctness of the non-kind operand's literal (Codex P5a/b/c):
 * a bare `.kind` operand against *any* other operand (subject only to the
 * ternary-unwrap and field-presence idiom exclusions, not a literal
 * allowlist), and a bare `Read.value`-to-`Read.value` pair, each admitted
 * only inside its governed owning function(s) -- both statement/branch shape
 * and operand-literal correctness are validated afterward, as structural-
 * fingerprint/slot-matching dimensions, never gated here.
 */
function c12IsGovernedCandidate(node: ts.BinaryExpression, left: string, right: string): boolean {
  if (left === right && C12_ALL_OPERAND_TEXTS.has(left)) return true; // self-comparison decoy (A3)
  if (C12_SOLO_VOCAB.has(left) || C12_SOLO_VOCAB.has(right)) return true; // distinctive solo operand
  if (c12PairInVocab(C12_NONKIND_PAIR_VOCAB, left, right)) return true; // exact non-kind pair
  if (c12IsKindDiscriminantPath(left) && c12ScopedKindMatch(left, right, node)) return true; // P1/P2/P3
  if (c12IsKindDiscriminantPath(right) && c12ScopedKindMatch(right, left, node)) return true; // symmetry
  if (c12IsReadValueAccessor(left) && c12IsReadValueAccessor(right)) {
    if (c12ScopedValueAccessorMatch(left, node) || c12ScopedValueAccessorMatch(right, node)) return true; // P4
  }
  return false;
}

/** Candidate discovery also accepts loose `==`/`!=` (A11: ungoverned duplicate via operator drift). */
function c12IsCandidateOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === C12_EQ ||
    kind === C12_NEQ ||
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken
  );
}

interface C12CandidateEntry {
  fp: C12StructFingerprint;
  node: ts.Node;
}

function c12CandidateStructFingerprint(n: ts.BinaryExpression, left: string, right: string): C12StructFingerprint {
  const parent = n.parent;
  const directIfCondition = ts.isIfStatement(parent) && parent.expression === n;
  const ifStmt = directIfCondition ? (parent as ts.IfStatement) : null;
  return {
    manifestId: '',
    boundNodeOrdinal: -1,
    fn: enclosingFunctionName(n) ?? '<module>',
    op: c12OperatorText(n.operatorToken.kind),
    left,
    right,
    stmtKind: ts.SyntaxKind[parent.kind],
    directIfCondition,
    hasElse: ifStmt ? !!ifStmt.elseStatement : false,
    acceptableSentinelShape: ifStmt ? boundReturnsSentinelNoElse(ifStmt, C12_ALL_SENTINELS) : false,
    dominanceOk: ifStmt ? dominatesFinalReturn(ifStmt) : false,
  };
}

function c12CompoundStructFingerprint(n: ts.BinaryExpression, left: string, right: string): C12StructFingerprint {
  const parent = n.parent;
  const directIfCondition = ts.isIfStatement(parent) && parent.expression === n;
  const ifStmt = directIfCondition ? (parent as ts.IfStatement) : null;
  return {
    manifestId: '',
    boundNodeOrdinal: -1,
    fn: enclosingFunctionName(n) ?? '<module>',
    op: '&&',
    left,
    right,
    stmtKind: ts.SyntaxKind[parent.kind],
    directIfCondition,
    hasElse: ifStmt ? !!ifStmt.elseStatement : false,
    acceptableSentinelShape: ifStmt ? boundReturnsSentinelNoElse(ifStmt, C12_ALL_SENTINELS) : false,
    dominanceOk: ifStmt ? dominatesFinalReturn(ifStmt) : false,
  };
}

/**
 * Whole-module scan (RC-FINAL-02A): unlike checkSingleBinding/checkCompoundBinding
 * (which search only *inside* each manifest entry's own owning function for its
 * *exact* frozen text and shape), this walks every BinaryExpression in the entire
 * module -- any function, any statement shape, even module-level/detached code --
 * and flags a governed candidate whenever c12IsGovernedCandidate holds, which is
 * now independent of enclosing statement/branch shape. Each candidate's full
 * structural fingerprint (including shape) is computed here and compared against
 * the permitted inventory below, so a shape mismatch still surfaces as an extra
 * candidate rather than silently vanishing. The compound `&&` node itself is
 * additionally reported when both its sides were already-flagged simple
 * candidates (mirroring C10's frozen 3rd bound node).
 */
function discoverC12GovernedCandidates(sf: ts.SourceFile): C12CandidateEntry[] {
  const out: C12CandidateEntry[] = [];
  const flaggedSimple = new Set<ts.BinaryExpression>();
  forEachDescendant(sf, (n) => {
    if (!ts.isBinaryExpression(n)) return;
    if (!c12IsCandidateOperator(n.operatorToken.kind)) return;
    const left = n.left.getText();
    const right = n.right.getText();
    if (!c12IsGovernedCandidate(n, left, right)) return;
    flaggedSimple.add(n);
    out.push({ fp: c12CandidateStructFingerprint(n, left, right), node: n });
  });
  forEachDescendant(sf, (n) => {
    if (!ts.isBinaryExpression(n)) return;
    if (n.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return;
    const { left, right } = n;
    if (!ts.isBinaryExpression(left) || !ts.isBinaryExpression(right)) return;
    if (!flaggedSimple.has(left) || !flaggedSimple.has(right)) return;
    out.push({ fp: c12CompoundStructFingerprint(n, left.getText(), right.getText()), node: n });
  });
  return out;
}

// ============================================================================
// RC-C12-02: exact resolved manifest-slot identity + frozen ordered slot
// sequence + effective dominance/precedence. Where the structural multiset
// key (c12StructKey) above only proves the *set* of governed comparisons in
// the module has the right multiplicities (order-blind by construction), this
// layer binds every actual candidate to the *specific* permitted slot
// (manifestId + boundNodeOrdinal) it occupies, and then checks that each
// governed function's slots occur in the same *relative* order as the frozen
// clean baseline -- so a mutation that reorders two entirely-real, unmutated
// guards (leaving the multiset exactly 31/31/0/0/0) is still caught.
// ============================================================================
interface C12ResolvedSlot {
  manifestId: string;
  boundNodeOrdinal: number;
  fn: string;
  node: ts.Node;
}

interface C12SlotResolution {
  /** Every permitted slot bound 1:1 to the single actual candidate occupying it. */
  resolved: C12ResolvedSlot[];
  /** A permitted slot with zero actual occupants. */
  missingSlotCount: number;
  /** An actual candidate sharing an already-filled slot's exact key (beyond the first occupant). */
  duplicateSlotOccupancyCount: number;
  /** Any actual candidate not uniquely bound to a permitted slot (extra-key candidates plus duplicate occupants). */
  unresolvedCandidateCount: number;
}

/**
 * Binds every permitted slot (C12_PERMITTED_FINGERPRINTS, each carrying its
 * own manifestId/boundNodeOrdinal identity) to the single actual candidate
 * sharing its exact structural key, if any. Because every permitted key is
 * already unique (C12_UNIQUE_PERMITTED_FINGERPRINT_COUNT === 31) this is a
 * straightforward one-pass bucket-and-consume: a slot with no occupant is
 * "missing"; a slot with more than one occupant sharing its key has resolved
 * its first occupant and counts the rest as duplicate occupancy; any actual
 * candidate never consumed this way (an entirely new key, or a duplicate
 * occupant) is "unresolved".
 */
function resolveC12Slots(
  permitted: readonly C12StructFingerprint[],
  actual: readonly C12CandidateEntry[],
): C12SlotResolution {
  const actualByKey = new Map<string, C12CandidateEntry[]>();
  for (const entry of actual) {
    const k = c12StructKey(entry.fp);
    const bucket = actualByKey.get(k);
    if (bucket) bucket.push(entry);
    else actualByKey.set(k, [entry]);
  }
  const consumed = new Set<C12CandidateEntry>();
  const resolved: C12ResolvedSlot[] = [];
  let missingSlotCount = 0;
  let duplicateSlotOccupancyCount = 0;
  for (const slot of permitted) {
    const bucket = actualByKey.get(c12StructKey(slot)) ?? [];
    if (bucket.length === 0) {
      missingSlotCount += 1;
      continue;
    }
    const [first, ...rest] = bucket;
    consumed.add(first);
    resolved.push({ manifestId: slot.manifestId, boundNodeOrdinal: slot.boundNodeOrdinal, fn: slot.fn, node: first.node });
    duplicateSlotOccupancyCount += rest.length;
  }
  const unresolvedCandidateCount = actual.filter((c) => !consumed.has(c)).length;
  return { resolved, missingSlotCount, duplicateSlotOccupancyCount, unresolvedCandidateCount };
}

function c12EnclosingFunctionBody(node: ts.Node): ts.Block | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.body) return cur.body;
    cur = cur.parent;
  }
  return null;
}

/**
 * Effective dominance/precedence, generalized: the index of node's nearest
 * top-level statement within its owning function's body. A compound entry's
 * two parts and their `&&` combiner all share exactly one top-level
 * IfStatement, so they collapse to the same ordinal here (never
 * double-counted as separate order positions) and are only tie-broken by
 * boundNodeOrdinal (their manifest-declared sub-order within that one
 * statement) in c12ResolvedSlotOrder below.
 */
function c12TopLevelStatementOrdinal(node: ts.Node): number | null {
  const body = c12EnclosingFunctionBody(node);
  if (!body) return null;
  let cur: ts.Node = node;
  while (cur.parent && cur.parent !== body) {
    cur = cur.parent;
  }
  const idx = body.statements.indexOf(cur as ts.Statement);
  return idx === -1 ? null : idx;
}

/**
 * The ordered slot sequence per governed function, keyed as `${manifestId}#${
 * boundNodeOrdinal}`, sorted by each resolved slot's actual top-level
 * statement position (ties -- only possible within one compound entry's own
 * parts/combiner -- broken by boundNodeOrdinal). Computed identically
 * whether `resolved` came from the frozen clean baseline or from a mutated
 * source under test, so the two are directly comparable.
 */
function c12ResolvedSlotOrder(resolved: readonly C12ResolvedSlot[]): Map<string, string[]> {
  const byFn = new Map<string, string[]>();
  for (const fn of GOVERNED_CURATE_FUNCTIONS) {
    const slotsForFn = resolved
      .filter((r) => r.fn === fn)
      .slice()
      .sort((a, b) => {
        const oa = c12TopLevelStatementOrdinal(a.node) ?? -1;
        const ob = c12TopLevelStatementOrdinal(b.node) ?? -1;
        if (oa !== ob) return oa - ob;
        return a.boundNodeOrdinal - b.boundNodeOrdinal;
      });
    byFn.set(fn, slotsForFn.map((r) => `${r.manifestId}#${r.boundNodeOrdinal}`));
  }
  return byFn;
}

function c12OrderMapsEqual(a: ReadonlyMap<string, string[]>, b: ReadonlyMap<string, string[]>): boolean {
  return GOVERNED_CURATE_FUNCTIONS.every((fn) => JSON.stringify(a.get(fn) ?? []) === JSON.stringify(b.get(fn) ?? []));
}

/**
 * Packet S / C12 presence-order-contract exactification (D2): the ACTUAL
 * ordered slot sequence, independently re-derived by parsing CORE_BASELINE_V3
 * itself. This is no longer analyzeCore's comparison target (that is now
 * C12_MANIFEST_EXPECTED_ORDER, built purely from manifest metadata) -- it
 * survives solely as the independent oracle the dedicated manifest-order
 * baseline cross-check test (D3) compares C12_MANIFEST_EXPECTED_ORDER
 * against, proving the hand-authored `sourceOrder` metadata still matches the
 * untouched production baseline. Lazily computed and memoized on first use so
 * it can be referenced from code declared earlier in this file than the
 * CORE_BASELINE_V3 constant itself.
 */
let c12FrozenSlotOrderCache: Map<string, string[]> | null = null;
function getC12FrozenSlotOrder(): Map<string, string[]> {
  if (!c12FrozenSlotOrderCache) {
    const sf = parseModule(CORE_BASELINE_V3);
    const { resolved } = resolveC12Slots(C12_PERMITTED_FINGERPRINTS, discoverC12GovernedCandidates(sf));
    c12FrozenSlotOrderCache = c12ResolvedSlotOrder(resolved);
  }
  return c12FrozenSlotOrderCache;
}

interface Violation {
  code: string;
  line: number;
  column: number;
  start: number;
  end: number;
}

interface CharRange {
  start: number;
  end: number;
}

function parseModule(source: string): ts.SourceFile {
  return ts.createSourceFile('CORE_BASELINE_V3.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function loc(sf: ts.SourceFile, start: number): { line: number; column: number } {
  const p = sf.getLineAndCharacterOfPosition(start);
  return { line: p.line + 1, column: p.character + 1 };
}

function forEachDescendant(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node);
  ts.forEachChild(node, (child) => forEachDescendant(child, cb));
}

function enclosingFunctionName(node: ts.Node): string | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    cur = cur.parent;
  }
  return null;
}

function typeIsAllowed(node: ts.TypeNode | undefined): boolean {
  if (!node) return true;
  if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) return false;
  if (node.kind === ts.SyntaxKind.ObjectKeyword) return false;
  if (node.kind === ts.SyntaxKind.AnyKeyword) return false;
  if (ts.isIntersectionTypeNode(node) || ts.isConditionalTypeNode(node)) return false;
  if (ts.isUnionTypeNode(node)) return node.types.every((t) => typeIsAllowed(t));
  if (ts.isArrayTypeNode(node)) return typeIsAllowed(node.elementType);
  if (ts.isParenthesizedTypeNode(node)) return typeIsAllowed(node.type);
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    if ((BROAD_TYPE_NAMES as readonly string[]).includes(name)) return false;
    if (name === 'Function') return false;
    return true;
  }
  return true;
}

/**
 * Syntax-only static guard implementing rules C1-C15 over CORE_BASELINE_V3-shaped source.
 * `changedRange`, when supplied, is the exact [start,end) character span of the single
 * mutation under test. Violations that have no specific offending AST node (a structural
 * "the required construct is absent" finding) are anchored to that span rather than to
 * the whole SourceFile, so every reported location is provably inside the mutation.
 */
function analyzeCore(source: string, changedRange?: CharRange): Violation[] {
  const sf = parseModule(source);
  const violations: Violation[] = [];
  const fallbackRange: CharRange = changedRange ?? { start: 0, end: source.length };
  const push = (code: string, node: ts.Node | CharRange) => {
    const start = typeof (node as ts.Node).getStart === 'function' ? (node as ts.Node).getStart(sf) : (node as CharRange).start;
    const end = typeof (node as ts.Node).getEnd === 'function' ? (node as ts.Node).getEnd() : (node as CharRange).end;
    violations.push({ code, ...loc(sf, start), start, end });
  };
  const pushStructural = (code: string) => push(code, fallbackRange);

  // ---- C1: import allowlist ----
  const imports: ts.ImportDeclaration[] = [];
  forEachDescendant(sf, (n) => {
    if (ts.isImportDeclaration(n)) imports.push(n);
  });
  if (imports.length === 0) {
    pushStructural('C1-MISSING-IMPORT');
  }
  for (const imp of imports) {
    const spec = ts.isStringLiteral(imp.moduleSpecifier) ? imp.moduleSpecifier.text : '';
    if (imp.importClause?.namedBindings && ts.isNamespaceImport(imp.importClause.namedBindings)) {
      push('C1-NAMESPACE', imp);
    } else if (spec !== './shiftCloseValidationTypes') {
      if (spec.startsWith('node:') || /^(http|https|http2|net|tls|dns|dgram|fs|fs\/promises|path|os|child_process|worker_threads|cluster|vm|inspector|perf_hooks)$/.test(spec)) {
        push('C1-NODE-SPECIFIER', imp);
      } else {
        push('C1-SPECIFIER', imp);
      }
    }
  }
  forEachDescendant(sf, (n) => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      push('C1-DYNAMIC', n);
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require') {
      push('C1-REQUIRE', n);
    }
  });

  // ---- C2: banned identifiers/type refs ----
  function isDeclarationNamePosition(n: ts.Identifier, p: ts.Node): boolean {
    return (
      (ts.isFunctionDeclaration(p) && p.name === n) ||
      (ts.isParameter(p) && p.name === n) ||
      (ts.isVariableDeclaration(p) && p.name === n) ||
      (ts.isImportSpecifier(p) && p.name === n) ||
      (ts.isPropertyAccessExpression(p) && p.name === n)
    );
  }
  forEachDescendant(sf, (n) => {
    if (ts.isIdentifier(n) && (BANNED_IDENTIFIERS_C2 as readonly string[]).includes(n.text)) {
      if (!isDeclarationNamePosition(n, n.parent)) push('C2-IDENTIFIER', n);
    }
    if (ts.isTypeReferenceNode(n) && (BANNED_IDENTIFIERS_C2 as readonly string[]).includes(n.typeName.getText())) {
      push('C2-IDENTIFIER', n);
    }
  });

  // ---- C3: forbidden member names ----
  // `Object.xxx` receivers are excluded here: every banned or bounded `Object.*`
  // API is already rule C7-OBJECT-API's exact, exhaustive concern (its
  // alwaysBanned/boundedOk lists below), so e.g. `Object.create` would
  // otherwise double-report under C3 too, purely because `create` also
  // happens to be a banned Firestore-style member name.
  forEachDescendant(sf, (n) => {
    if (
      ts.isPropertyAccessExpression(n) &&
      (FORBIDDEN_MEMBER_NAMES_CORE as readonly string[]).includes(n.name.text) &&
      !(ts.isIdentifier(n.expression) && n.expression.text === 'Object')
    ) {
      push('C3-MEMBER', n);
    }
  });

  // ---- C4: bounded .call ----
  forEachDescendant(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const name = n.expression.name.text;
      if (name === 'call') {
        if (n.expression.getText() !== 'Object.prototype.hasOwnProperty.call') push('C4-CALL', n);
      } else if (name === 'apply') {
        push('C4-APPLY', n);
      } else if (name === 'bind') {
        push('C4-BIND', n);
      }
    }
  });

  // ---- C5 / C6: exported signature capability boundary ----
  const unknownEntrypoints: string[] = [];
  forEachDescendant(sf, (n) => {
    if (!ts.isFunctionDeclaration(n)) return;
    const isExported = !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) return;
    if (n.typeParameters && n.typeParameters.length > 0) push('C5-TYPE-PARAM', n);
    for (const param of n.parameters) {
      if (param.type && (ts.isFunctionTypeNode(param.type) || ts.isConstructorTypeNode(param.type))) {
        push('C5-FUNCTION-PARAM', param);
      } else if (!typeIsAllowed(param.type)) {
        push('C5-BROAD-TYPE', param);
      }
      // Top-level `unknown` only (property 2/4 exact-shape discipline): a
      // parameter typed `Record<string, unknown>` merely *contains* the
      // `unknown` keyword as a generic argument and is separately, correctly
      // flagged C5-BROAD-TYPE above; it must not also count as one of the
      // five frozen `(raw: unknown)`-shaped entrypoints.
      if (param.type && param.type.kind === ts.SyntaxKind.UnknownKeyword) {
        if (n.name) unknownEntrypoints.push(n.name.text);
      }
    }
    if (!typeIsAllowed(n.type)) push('C5-BROAD-TYPE', n);
  });
  const expectedUnknownEntrypoints = [
    'curateRequestView', 'curateCallableAuth', 'curateCaseDocument', 'curateRunDocument', 'curateEvidenceDocument',
  ];
  const sortedActual = [...unknownEntrypoints].sort();
  const sortedExpected = [...expectedUnknownEntrypoints].sort();
  if (sortedActual.length !== 5 || sortedActual.some((v, i) => v !== sortedExpected[i])) {
    pushStructural('C6-UNKNOWN-COUNT');
  }

  // ---- C7: reflective/global dispatch + bounded Object.* exception ----
  const c7Globals = ['Reflect', 'Proxy', 'eval', 'Function', 'globalThis', 'WeakRef', 'FinalizationRegistry', 'structuredClone'];
  forEachDescendant(sf, (n) => {
    if (ts.isIdentifier(n) && c7Globals.includes(n.text)) {
      if (!isDeclarationNamePosition(n, n.parent)) push('C7-GLOBAL', n);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const chain = n.expression.getText();
      const boundedOk = ['Object.getPrototypeOf', 'Object.getOwnPropertyDescriptors', 'Object.getOwnPropertySymbols'];
      const alwaysBanned = [
        'Object.setPrototypeOf', 'Object.defineProperty', 'Object.defineProperties',
        'Object.create', 'Object.assign', 'Object.getOwnPropertyDescriptor',
      ];
      if (alwaysBanned.includes(chain)) push('C7-OBJECT-API', n);
      else if (boundedOk.includes(chain) && enclosingFunctionName(n) !== 'isSafeSerializedShape') push('C7-OBJECT-API', n);
    }
  });

  // ---- C8a: exactly one ElementAccessExpression, inside readOwnLiteral ----
  const elementAccesses: ts.ElementAccessExpression[] = [];
  forEachDescendant(sf, (n) => {
    if (ts.isElementAccessExpression(n)) elementAccesses.push(n);
  });
  const outsideReadOwnLiteral = elementAccesses.filter((n) => enclosingFunctionName(n) !== 'readOwnLiteral');
  if (elementAccesses.length !== 1 || outsideReadOwnLiteral.length > 0) {
    for (const n of outsideReadOwnLiteral.length > 0 ? outsideReadOwnLiteral : elementAccesses) {
      push('C8-ELEMENT-ACCESS-COUNT', n);
    }
    if (elementAccesses.length === 0) pushStructural('C8-ELEMENT-ACCESS-COUNT');
  }

  // ---- C8b: no ComputedPropertyName ----
  forEachDescendant(sf, (n) => {
    if (ts.isComputedPropertyName(n)) push('C8-COMPUTED-NAME', n);
  });

  // ---- C8c/C8d/C8e/C9c: hasOwnLiteral / readOwnLiteral / ownRead discipline ----
  forEachDescendant(sf, (n) => {
    if (!ts.isIdentifier(n)) return;
    if (n.text === 'hasOwnLiteral' || n.text === 'readOwnLiteral') {
      const p = n.parent;
      const isOwnDeclName = ts.isFunctionDeclaration(p) && p.name === n;
      const isCalleePos = ts.isCallExpression(p) && p.expression === n;
      if (!isOwnDeclName && !isCalleePos) {
        push('C8-HELPER-ALIAS', n);
      }
      if (isCalleePos && ts.isCallExpression(p)) {
        if (p.arguments.length !== 2) {
          push('C8-NONLITERAL-KEY', p);
        } else {
          const arg2 = p.arguments[1];
          if (!ts.isStringLiteral(arg2)) {
            push('C8-NONLITERAL-KEY', p);
          } else if (!(CORE_LITERAL_KEYS_25 as readonly string[]).includes(arg2.text)) {
            push('C8-UNLISTED-KEY', p);
          }
        }
      }
    }
  });
  forEachDescendant(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'ownRead') {
      const parent = n.parent;
      const validatorParent =
        ts.isCallExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        /^as[A-Z]/.test(parent.expression.text) &&
        parent.arguments[0] === n;
      if (!validatorParent) push('C9-UNVALIDATED-READ', n);

      // Only the hasOwnLiteral/readOwnLiteral paired-callsite shape is governed;
      // an ownRead call over arbitrary literal/test values (e.g. `ownRead(true, 5)`)
      // is out of C8e's scope entirely (proven non-vacuous by PS-C14).
      if (n.arguments.length === 2) {
        const [presentArg, valueArg] = n.arguments;
        const presentIsHasOwn = ts.isCallExpression(presentArg) && ts.isIdentifier(presentArg.expression) && presentArg.expression.text === 'hasOwnLiteral';
        const valueIsReadOwn = ts.isCallExpression(valueArg) && ts.isIdentifier(valueArg.expression) && valueArg.expression.text === 'readOwnLiteral';
        if (presentIsHasOwn || valueIsReadOwn) {
          let paired = presentIsHasOwn && valueIsReadOwn;
          if (paired) {
            const pArgs = (presentArg as ts.CallExpression).arguments;
            const vArgs = (valueArg as ts.CallExpression).arguments;
            const receiverMatch = pArgs[0]?.getText() === vArgs[0]?.getText();
            const keyMatch =
              ts.isStringLiteral(pArgs[1]) && ts.isStringLiteral(vArgs[1]) && pArgs[1].text === vArgs[1].text;
            paired = receiverMatch && keyMatch;
          }
          if (!paired) push('C8-UNPAIRED-READ', n);
        }
      }
    }
  });

  // ---- C9a/b: FieldRead-producing helper set + banned reader names ----
  const fieldReadHelperNames: string[] = [];
  const readerNames: string[] = [];
  forEachDescendant(sf, (n) => {
    if (!ts.isFunctionDeclaration(n) || !n.name) return;
    const name = n.name.text;
    const returnsFieldRead = n.type ? n.type.getText().startsWith('FieldRead<') : false;
    if (/^as[A-Z]/.test(name) || name === 'ownRead' || name === 'minorFrom') {
      if (returnsFieldRead) fieldReadHelperNames.push(name);
      else push('C9-FIELD-READ-COLLAPSE', n);
    }
    if (/^read[A-Z]/.test(name)) readerNames.push(name);
  });
  const sortedFR = [...fieldReadHelperNames].sort();
  const sortedExpectedFR = [...FIELD_READ_HELPERS_11].sort();
  if (sortedFR.length !== 11 || sortedFR.some((v, i) => v !== sortedExpectedFR[i])) {
    pushStructural('C9-FIELD-READ-COLLAPSE');
  }
  for (const name of readerNames) {
    if (!(ALLOWED_READ_FUNCTIONS as readonly string[]).includes(name)) pushStructural('C9-BANNED-READER');
  }

  // ---- C9e: FieldRead discriminant exhaustiveness ----
  forEachDescendant(sf, (n) => {
    if (!ts.isBinaryExpression(n)) return;
    if (n.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken && n.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return;
    const left = n.left;
    const right = n.right;
    const leftIsKind = ts.isPropertyAccessExpression(left) && left.name.text === 'kind';
    const rightIsKind = ts.isPropertyAccessExpression(right) && right.name.text === 'kind';
    const literal = leftIsKind ? right : rightIsKind ? left : null;
    if (literal && ts.isStringLiteral(literal)) {
      if (!['missing', 'invalid', 'null', 'value'].includes(literal.text)) {
        push('C9-TAG-EXHAUSTIVENESS', n);
      }
    }
  });

  // ---- Reconstruction: curateRequestView must return a fresh key-by-key literal ----
  forEachDescendant(sf, (n) => {
    if (!(ts.isFunctionDeclaration(n) && n.name?.text === 'curateRequestView')) return;
    forEachDescendant(n, (m) => {
      if (!ts.isReturnStatement(m) || !m.expression) return;
      const expr = m.expression;
      if (ts.isObjectLiteralExpression(expr)) {
        if (expr.properties.some((p) => ts.isSpreadAssignment(p))) push('C-RECONSTRUCT-SPREAD', m);
      } else if (ts.isAsExpression(expr) || ts.isIdentifier(expr)) {
        push('C-RECONSTRUCT-RAW', m);
      }
    });
  });

  // ---- C10: curated receiver binding rule ----
  const receiverSet = ['request', 'claims', 'caseView', 'runView', 'evidenceView'];
  forEachDescendant(sf, (n) => {
    if (ts.isPropertyAccessExpression(n)) {
      const key = n.name.text;
      if ((CORE_LITERAL_KEYS_25 as readonly string[]).includes(key) || (EXCLUDED_FIELD_NAMES_39 as readonly string[]).includes(key)) {
        if (!(ts.isIdentifier(n.expression) && receiverSet.includes(n.expression.text))) {
          push('C10-RECEIVER-BINDING', n);
        }
      }
    }
  });
  forEachDescendant(sf, (n) => {
    let bindingName: ts.Identifier | null = null;
    if (ts.isParameter(n) && ts.isIdentifier(n.name) && receiverSet.includes(n.name.text)) bindingName = n.name;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && receiverSet.includes(n.name.text)) bindingName = n.name;
    if (!bindingName) return;
    if (ts.isParameter(n)) {
      const typeName = n.type && ts.isTypeReferenceNode(n.type) ? n.type.typeName.getText() : n.type && ts.isUnionTypeNode(n.type) ? n.type.types.map((t) => (ts.isTypeReferenceNode(t) ? t.typeName.getText() : t.getText())).join('|') : '';
      const ok = n.type && (CURATED_INTERFACE_NAMES as readonly string[]).some((c) => typeName.includes(c));
      if (!ok) push('C10-RECEIVER-BINDING', n);
    } else if (ts.isVariableDeclaration(n)) {
      const parent = n.parent;
      const isConst = ts.isVariableDeclarationList(parent) && (parent.flags & ts.NodeFlags.Const) !== 0;
      const init = n.initializer;
      const isCurateCall = init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && /^curate[A-Z]/.test(init.expression.text);
      if (!isConst || !isCurateCall) push('C10-RECEIVER-BINDING', n);
    }
  });
  forEachDescendant(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'curateCallableAuth') {
      forEachDescendant(n, (m) => {
        if (ts.isReturnStatement(m) && m.expression && ts.isObjectLiteralExpression(m.expression)) {
          const names = m.expression.properties.map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : '')).sort();
          const expected = ['branchIds', 'role', 'staffIdPresent'];
          if (names.length !== 3 || names.some((v, i) => v !== expected[i])) {
            // Locate the specific offending (extra/renamed) property rather than
            // the whole return statement, so the violation resolves inside a
            // narrow single-property mutation's changed range.
            const extra = m.expression.properties.filter((p) => {
              const name = p.name && ts.isIdentifier(p.name) ? p.name.text : '';
              return !expected.includes(name);
            });
            if (extra.length > 0) {
              for (const p of extra) push('C10-CLAIMS-SHAPE', p);
            } else {
              push('C10-CLAIMS-SHAPE', m);
            }
          }
        }
      });
    }
  });

  // ---- C11: sortedKeys exactly once, inside curateRequestView ----
  let sortedKeysCalls = 0;
  forEachDescendant(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'sortedKeys') {
      sortedKeysCalls += 1;
      if (enclosingFunctionName(n) !== 'curateRequestView') push('C11-AUTH-EXACT-KEYSET', n);
    }
  });
  if (sortedKeysCalls !== 1) pushStructural('C11-AUTH-EXACT-KEYSET');

  // ---- C12: the frozen 26-entry / 31-node control-flow-bound invariant manifest ----
  // (C12_MANIFEST, C12Binding, boundReturnsSentinelNoElse, dominatesFinalReturn, and their
  // supporting doc-comments are module-level, above -- shared with the closed-world layer.)
  const C12_FROZEN_SENTINELS = C12_ALL_SENTINELS;

  function checkSingleBinding(fn: string, binding: C12Binding, acceptable: readonly string[]): boolean {
    let ok = false;
    forEachDescendant(sf, (n) => {
      if (ok) return;
      if (!ts.isBinaryExpression(n)) return;
      if (n.operatorToken.kind !== binding.op) return;
      if (enclosingFunctionName(n) !== fn) return;
      if (n.left.getText() !== binding.left || n.right.getText() !== binding.right) return;
      const parent = n.parent;
      if (!ts.isIfStatement(parent) || parent.expression !== n) return; // property 6: direct if-condition only
      if (!boundReturnsSentinelNoElse(parent, acceptable)) return;
      if (!dominatesFinalReturn(parent)) return;
      ok = true;
    });
    return ok;
  }

  function checkCompoundBinding(fn: string, parts: readonly C12Binding[], acceptable: readonly string[]): boolean {
    let ok = false;
    forEachDescendant(sf, (n) => {
      if (ok) return;
      if (!ts.isIfStatement(n)) return;
      if (enclosingFunctionName(n) !== fn) return;
      const cond = n.expression;
      if (!ts.isBinaryExpression(cond) || cond.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return;
      const [a, b] = parts;
      const left = cond.left;
      const right = cond.right;
      if (!ts.isBinaryExpression(left) || !ts.isBinaryExpression(right)) return;
      if (left.operatorToken.kind !== a.op || left.left.getText() !== a.left || left.right.getText() !== a.right) return;
      if (right.operatorToken.kind !== b.op || right.left.getText() !== b.left || right.right.getText() !== b.right) return;
      if (!boundReturnsSentinelNoElse(n, acceptable)) return;
      if (!dominatesFinalReturn(n)) return;
      ok = true;
    });
    return ok;
  }

  for (const entry of C12_MANIFEST) {
    const acceptable = entry.sentinelGovernedByC15 ? C12_FROZEN_SENTINELS : [entry.sentinel];
    if (entry.compound) {
      if (!checkCompoundBinding(entry.fn, entry.parts, acceptable)) {
        pushStructural('C12-INVARIANT-MISSING');
      }
    } else {
      for (const part of entry.parts) {
        if (!checkSingleBinding(entry.fn, part, acceptable)) {
          pushStructural('C12-INVARIANT-MISSING');
        }
      }
    }
  }

  // ---- C12 CLOSED WORLD (RC-FINAL-02, Packet S D1): multiset equality between
  // the frozen 31-entry C12 permitted inventory PLUS the frozen 3-entry
  // benign-presence inventory (C12_ALL_PERMITTED_FOR_CLOSED_WORLD -- see
  // C12_BENIGN_PRESENCE_MANIFEST above for why the latter exists) and every
  // governed candidate discovered anywhere in the module. Missing entries (an
  // existing permitted key whose actual count fell below its permitted
  // multiplicity) have no single offending node, so they are structural;
  // every extra occurrence (a wrong-function/self/swapped/detached/
  // duplicate/operator-drift decoy, a benign-presence-shaped candidate with
  // the wrong field/statement/owning-function, or simply an actual count
  // exceeding the permitted multiplicity for its own key) is anchored to its
  // own node.
  {
    const permittedCounts = new Map<string, number>();
    for (const fp of C12_ALL_PERMITTED_FOR_CLOSED_WORLD) {
      const k = c12StructKey(fp);
      permittedCounts.set(k, (permittedCounts.get(k) ?? 0) + 1);
    }
    const actualByKey = new Map<string, C12CandidateEntry[]>();
    for (const entry of discoverC12GovernedCandidates(sf)) {
      const k = c12StructKey(entry.fp);
      const bucket = actualByKey.get(k);
      if (bucket) bucket.push(entry);
      else actualByKey.set(k, [entry]);
    }
    let missingTotal = 0;
    for (const [k, permittedCount] of permittedCounts) {
      const actualCount = actualByKey.get(k)?.length ?? 0;
      if (actualCount < permittedCount) missingTotal += permittedCount - actualCount;
    }
    if (missingTotal > 0) pushStructural('C12-INVARIANT-MISSING');
    for (const [k, entries] of actualByKey) {
      const permittedCount = permittedCounts.get(k) ?? 0;
      for (const overflow of entries.slice(permittedCount)) {
        push('C12-INVARIANT-MISSING', overflow.node);
      }
    }
  }

  // ---- C12 EFFECTIVE DOMINANCE / ORDER (RC-C12-02, Packet S D2): the multiset
  // check above is order-blind by construction (it only proves the right
  // *set* of governed comparisons exists, with the right multiplicities).
  // This layer additionally binds every resolved candidate to its exact
  // permitted slot identity and checks that each governed function's slots
  // occur in the same relative order as C12_MANIFEST_EXPECTED_ORDER -- explicit,
  // hand-authored manifest metadata (each entry's `sourceOrder`), independent
  // of any AST re-parse of CORE_BASELINE_V3 -- catching a reorder that leaves
  // every comparison present and unmutated (e.g. moving branch authorization
  // after expected-version handling) -- which the multiset alone cannot see.
  // No single node is "the" offending one for a whole-function reorder, so
  // this is anchored to the mutation's own range like every other structural
  // finding, never to an unrelated baseline node.
  {
    const { resolved } = resolveC12Slots(C12_PERMITTED_FINGERPRINTS, discoverC12GovernedCandidates(sf));
    const actualOrder = c12ResolvedSlotOrder(resolved);
    if (!c12OrderMapsEqual(C12_MANIFEST_EXPECTED_ORDER, actualOrder)) {
      pushStructural('C12-INVARIANT-MISSING');
    }
  }

  // ---- BENIGN PRESENCE EXACTNESS (RC-PRESENCE-01, Packet S / C12
  // benign-presence exactness final remediation): three dimensions the
  // shared c12StructKey/boundReturnsSentinelNoElse machinery deliberately
  // does not bind exactly for BP1-BP3 (see BenignPresenceReturnSignature's
  // doc comment above) -- exact branch-return signature (response
  // identifier, view===null, exact 2-key shape), exact relative BP1/BP2/BP3
  // order, and exact effective dominance. Every check here is anchored with
  // pushStructural (the mutation's own changed range), mirroring exactly how
  // the 31-slot per-entry loop and order check above already report -- never
  // anchored to BP1-3's own (possibly out-of-mutation-range) node location,
  // since an unrelated earlier-in-function decoy (e.g. MC-65's early
  // terminal-shaped return) can defeat BP1-3's dominance/order the same way
  // it already defeats later real C12 guards, without BP1-3 themselves being
  // the mutated text. Reuses resolveC12Slots/c12ResolvedSlotOrder/
  // c12OrderMapsEqual/dominatesFinalReturn unchanged, applied to
  // C12_BENIGN_PRESENCE_MANIFEST/FINGERPRINTS -- no change to the 31-slot
  // C12_MANIFEST path above.
  {
    const { resolved: benignResolved } = resolveC12Slots(
      C12_BENIGN_PRESENCE_FINGERPRINTS,
      discoverC12GovernedCandidates(sf),
    );
    for (const slot of benignResolved) {
      const ifStmt = slot.node.parent as ts.IfStatement;
      if (!computeBenignPresenceReturnSignature(ifStmt).returnObjectExact) {
        pushStructural('C12-INVARIANT-MISSING');
      }
      if (!dominatesFinalReturn(ifStmt)) {
        pushStructural('C12-INVARIANT-MISSING');
      }
    }
    const benignActualOrder = c12ResolvedSlotOrder(benignResolved);
    if (!c12OrderMapsEqual(C12_BENIGN_PRESENCE_EXPECTED_ORDER, benignActualOrder)) {
      pushStructural('C12-INVARIANT-MISSING');
    }
  }

  // ---- C13: minor validator discipline ----
  forEachDescendant(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'minorFrom') {
      let asCallNode: ts.CallExpression | null = null;
      forEachDescendant(n, (m) => {
        if (ts.isCallExpression(m) && ts.isIdentifier(m.expression) && /^as[A-Z]/.test(m.expression.text)) {
          asCallNode = m;
        }
      });
      const asCall: string | null = asCallNode ? (asCallNode as ts.CallExpression).expression.getText() : null;
      // Locate the actual offending validator call, not the whole function,
      // so the violation resolves inside a narrow single-call-swap mutation's
      // changed range.
      if (asCall !== 'asNullableSafeInteger') push('C13-MINOR-VALIDATOR', asCallNode ?? n);
    }
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'curateEvidenceDocument') {
      for (const key of ['expectedCash', 'actualCashCount', 'variance']) {
        let matched = false;
        forEachDescendant(n, (m) => {
          if (matched) return;
          if (ts.isCallExpression(m) && ts.isIdentifier(m.expression) && m.expression.text === 'readOwnLiteral') {
            const arg2 = m.arguments[1];
            if (ts.isStringLiteral(arg2) && arg2.text === key) {
              // walk up to find the wrapping as* validator call
              let cur: ts.Node = m;
              for (let i = 0; i < 4 && cur.parent; i += 1) {
                cur = cur.parent;
                if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && /^as[A-Z]/.test(cur.expression.text)) {
                  matched = cur.expression.text === 'asNullableFinite';
                  break;
                }
              }
            }
          }
        });
        if (!matched) push('C13-MINOR-VALIDATOR', n);
      }
    }
  });

  // ---- C14: governed enum arrays, exactly two positions each ----
  const bindingOccurrences = new Map<string, number>();
  for (const b of GOVERNED_ENUM_BINDINGS) bindingOccurrences.set(b, 0);
  forEachDescendant(sf, (n) => {
    if (!ts.isIdentifier(n)) return;
    if (!(GOVERNED_ENUM_BINDINGS as readonly string[]).includes(n.text)) return;
    bindingOccurrences.set(n.text, (bindingOccurrences.get(n.text) ?? 0) + 1);
    const p = n.parent;
    const isImportSpecifier = ts.isImportSpecifier(p) && p.name === n;
    const isAsEnumArg =
      ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'asEnum' && p.arguments[1] === n;
    if (!isImportSpecifier && !isAsEnumArg) {
      push('C14-ENUM-ARRAY-USE', n);
    }
  });
  for (const b of GOVERNED_ENUM_BINDINGS) {
    if (bindingOccurrences.get(b) !== 2) pushStructural('C14-ENUM-ARRAY-USE');
  }
  const stateStringValues = new Set<string>([...PROCESSING_STATES, ...SETTLEMENT_STATES, ...ALERT_STATES]);
  forEachDescendant(sf, (n) => {
    if (ts.isStringLiteral(n) && stateStringValues.has(n.text)) {
      push('C14-STATE-NARROWING', n);
    }
  });

  // ---- C15: version/state sentinel consistency ----
  forEachDescendant(sf, (n) => {
    if (!ts.isFunctionDeclaration(n) || n.name?.text !== 'curateCaseDocument') return;
    forEachDescendant(n, (m) => {
      if (!ts.isIfStatement(m)) return;
      const text = m.expression.getText();
      if (text.includes('versionRead')) {
        if (!boundReturnsSentinelNoElse(m, ['STALE'])) push('C15-VERSION-STATUS', m);
      } else if (
        (text.includes('processingRead.kind') || text.includes('settlementRead.kind') || text.includes('alertRead.kind')) &&
        !text.includes("'missing'")
      ) {
        if (!boundReturnsSentinelNoElse(m, ['UNSUPPORTED'])) push('C15-VERSION-STATUS', m);
      }
    });
  });

  // ---- EXCLUDED-FIELD: 39-name targeted guard ----
  forEachDescendant(sf, (n) => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    if (ts.isPropertyAccessExpression(n)) text = n.name.text;
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isIdentifier(n.name)) text = n.name.text;
    if (text !== null && (EXCLUDED_FIELD_NAMES_39 as readonly string[]).includes(text)) {
      push('EXCLUDED-FIELD', n);
    }
  });

  return violations;
}

interface Mutated {
  source: string;
  range: CharRange;
}

function applyInsert(source: string, marker: string, construct: string): Mutated {
  const markerComment = `/* MARKER:${marker} */`;
  const occurrences = source.split(markerComment).length - 1;
  if (occurrences !== 1) throw new Error(`marker ${marker} occurs ${occurrences} times, expected 1`);
  const idx = source.indexOf(markerComment);
  const insertAt = idx + markerComment.length + 1; // +1 skips the injected '\n'
  return {
    source: source.replace(markerComment, `${markerComment}\n${construct}`),
    range: { start: insertAt, end: insertAt + construct.length },
  };
}

function applyReplacement(source: string, target: string, replacement: string): Mutated {
  const occurrences = source.split(target).length - 1;
  if (occurrences !== 1) throw new Error(`replacement target occurs ${occurrences} times, expected 1:\n${target}`);
  const idx = source.indexOf(target);
  return {
    source: source.replace(target, replacement),
    range: { start: idx, end: idx + replacement.length },
  };
}

/**
 * MC-65 (RC-PS-02 / Gemini adjudication MC65-AND-RCPS03-ADJUDICATION-GEMINI-001,
 * Option A): a test-only exact-unique-anchor insertion. Unlike `applyInsert`,
 * this does not depend on a `MARKER:` comment (no production marker may be
 * added); it inserts `construct` immediately after an arbitrary but *unique*,
 * *frozen*, *semantic* substring of the baseline (`anchor`), which must occur
 * in `source` exactly once or this throws. The returned range is the exact
 * [start,end) of the inserted text only — nothing before or after it changes.
 */
function applyAnchoredInsert(source: string, anchor: string, construct: string): Mutated {
  const occurrences = source.split(anchor).length - 1;
  if (occurrences !== 1) throw new Error(`anchor occurs ${occurrences} times, expected exactly 1:\n${anchor}`);
  const idx = source.indexOf(anchor);
  const insertAt = idx + anchor.length + 1; // +1 skips the injected '\n'
  return {
    source: source.replace(anchor, `${anchor}\n${construct}`),
    range: { start: insertAt, end: insertAt + construct.length },
  };
}

const STRUCTURAL_CODES = [
  'C1-MISSING-IMPORT', 'C8-ELEMENT-ACCESS-COUNT', 'C9-FIELD-READ-COLLAPSE', 'C12-INVARIANT-MISSING',
];

/**
 * Asserts (RC-PS-02): the baseline is clean; the mutation produces at least one
 * violation; the actual distinct violation-code set equals `expectedCodes`
 * exactly (order-insensitive, no subset/superset); and every reported
 * violation's [start,end) location falls inside the mutation's own exact
 * changed range (never a source-file-wide or otherwise out-of-range location).
 */
function expectMutation(
  form: 'INSERT' | 'REPLACE',
  markerOrTarget: string,
  constructOrReplacement: string,
  expectedCodes: string[],
) {
  expect(analyzeCore(CORE_BASELINE_V3)).toEqual([]);
  const { source: mutated, range } =
    form === 'INSERT'
      ? applyInsert(CORE_BASELINE_V3, markerOrTarget, constructOrReplacement)
      : applyReplacement(CORE_BASELINE_V3, markerOrTarget, constructOrReplacement);
  const violations = analyzeCore(mutated, range);
  expect(violations.length).toBeGreaterThanOrEqual(1);
  const actualCodes = [...new Set(violations.map((v) => v.code))].sort();
  const expectedSet = [...new Set(expectedCodes)].sort();
  expect(actualCodes).toEqual(expectedSet);
  for (const v of violations) {
    expect(v.start).toBeGreaterThanOrEqual(range.start);
    expect(v.end).toBeLessThanOrEqual(range.end);
  }
}

function expectPositive(marker: string, construct: string) {
  expect(analyzeCore(CORE_BASELINE_V3)).toEqual([]);
  const { source: mutated } = applyInsert(CORE_BASELINE_V3, marker, construct);
  expect(analyzeCore(mutated)).toEqual([]);
}

describe('Static guard — CORE_BASELINE_V3 zero-violation baseline', () => {
  test('the unmutated baseline yields zero violations', () => {
    expect(analyzeCore(CORE_BASELINE_V3)).toEqual([]);
  });
});

describe('Production/fixture byte binding (RC-PS-final): CORE_BASELINE_V3 == shipped getShiftCloseCaseFiguresCore.ts', () => {
  test('CORE_BASELINE_V3 is byte-for-byte identical to the live production file', () => {
    const productionBytes: Buffer = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'getShiftCloseCaseFiguresCore.ts'),
    );
    const fixtureBytes = Buffer.from(CORE_BASELINE_V3, 'utf8');
    expect(fixtureBytes.length).toBe(productionBytes.length);
    expect(Buffer.compare(fixtureBytes, productionBytes)).toBe(0);
  });
});

describe('Static guard — core mutation matrix (MC-01 .. MC-77)', () => {
  test('MC-01', () => expectMutation('INSERT', 'IMPORTS', "import { db } from './db';", ['C1-SPECIFIER']));
  test('MC-02', () => expectMutation('INSERT', 'IMPORTS', "import * as types from './shiftCloseValidationTypes';", ['C1-NAMESPACE']));
  test('MC-03', () => expectMutation('INSERT', 'HELPERS', "const t = (async () => { await import('firebase-admin/firestore'); })();", ['C1-DYNAMIC']));
  test('MC-04', () => expectMutation('INSERT', 'HELPERS', "const m = require('./db');", ['C1-REQUIRE']));
  test('MC-05', () => expectMutation('INSERT', 'IMPORTS', "import { readFileSync } from 'node:fs';", ['C1-NODE-SPECIFIER']));
  test('MC-06', () => expectMutation('INSERT', 'HELPERS', 'function t(x: Firestore): void { return; }', ['C2-IDENTIFIER']));
  test('MC-07', () => expectMutation('INSERT', 'HELPERS', 'const now = Date.now();', ['C2-IDENTIFIER']));
  test('MC-08', () => expectMutation('INSERT', 'HELPERS', "console.error('x');", ['C2-IDENTIFIER']));
  test('MC-09', () => expectMutation('INSERT', 'HELPERS', "const r0 = fetch('https://example.test');", ['C2-IDENTIFIER']));
  test('MC-10', () => expectMutation('INSERT', 'HELPERS', 'const p = process.env;', ['C2-IDENTIFIER']));
  test('MC-11', () => expectMutation('INSERT', 'HELPERS', "const b = Buffer.from('x');", ['C2-IDENTIFIER']));
  test('MC-12', () => expectMutation('INSERT', 'HELPERS', 'const s0 = globalThis;', ['C7-GLOBAL']));
  test('MC-13', () => expectMutation('INSERT', 'HELPERS', "const v = Reflect.get({}, 'x');", ['C7-GLOBAL']));
  test('MC-14', () => expectMutation('INSERT', 'HELPERS', 'const p2 = new Proxy({}, {});', ['C7-GLOBAL']));
  test('MC-15', () => expectMutation('INSERT', 'HELPERS', "const f0 = eval('1');", ['C7-GLOBAL']));
  test('MC-16', () => expectMutation('INSERT', 'HELPERS', "const f1 = new Function('return 1');", ['C7-GLOBAL']));
  test('MC-17', () => expectMutation('INSERT', 'HELPERS', 'const w0 = new WeakRef({});', ['C7-GLOBAL']));
  test('MC-18', () => expectMutation('INSERT', 'HELPERS', "const d0 = Object.getOwnPropertyDescriptor({}, 'x');", ['C7-OBJECT-API']));
  test('MC-19', () => expectMutation('INSERT', 'HELPERS', 'const o0 = Object.assign({}, {});', ['C7-OBJECT-API']));
  test('MC-20', () => expectMutation('INSERT', 'HELPERS', 'const o1 = Object.create(null);', ['C7-OBJECT-API']));
  test('MC-21', () => expectMutation('INSERT', 'HELPERS', 'const c0 = structuredClone({});', ['C7-GLOBAL']));
  test('MC-22', () => expectMutation('INSERT', 'HELPERS', "const x0 = ({} as { set: () => void }).set;", ['C3-MEMBER']));
  test('MC-23', () => expectMutation('INSERT', 'HELPERS', "const x1 = ({} as { where: () => void }).where;", ['C3-MEMBER']));
  test('MC-24', () => expectMutation('INSERT', 'HELPERS', "const x2 = ({} as { collection: () => void }).collection;", ['C3-MEMBER']));
  test('MC-25', () => expectMutation('INSERT', 'HELPERS', 'const x3 = Object.keys({}).slice.call([], 0);', ['C4-CALL']));
  test('MC-26', () => expectMutation('INSERT', 'HELPERS', 'const f2 = isPlainScalar.bind(null);', ['C4-BIND']));
  test('MC-27', () => expectMutation('INSERT', 'HELPERS', 'const f3 = isPlainScalar.apply(null, [1]);', ['C4-APPLY']));
  test('MC-28', () => expectMutation('INSERT', 'RESPONSES', 'export function withCallback(fn: (v: number) => number): number { return fn(1); }', ['C5-FUNCTION-PARAM']));
  test('MC-29', () => expectMutation('INSERT', 'RESPONSES', 'export function generic<T>(v: T): T { return v; }', ['C5-TYPE-PARAM']));
  test('MC-30', () => expectMutation('INSERT', 'RESPONSES', 'export function widen(v: Record<string, unknown>): number { return 0; }', ['C5-BROAD-TYPE']));
  test('MC-31', () => expectMutation('INSERT', 'RESPONSES', 'export function widen2(v: object): number { return 0; }', ['C5-BROAD-TYPE']));
  test('MC-32', () => expectMutation('INSERT', 'RESPONSES', 'export function widen3(v: Promise<number>): number { return 0; }', ['C5-BROAD-TYPE']));
  test('MC-33', () => expectMutation('INSERT', 'RESPONSES', 'export function extra(v: unknown): number { return 0; }', ['C6-UNKNOWN-COUNT']));

  test('MC-34', () =>
    expectMutation(
      'REPLACE',
      '  return {\n    branchId: branchIdRead.value,\n    shiftId: shiftIdRead.value,\n    expectedCaseVersion: versionRead.value,\n  };',
      '  return { ...(raw as CuratedRequestView) };',
      ['C-RECONSTRUCT-SPREAD'],
    ));
  test('MC-35', () =>
    expectMutation(
      'REPLACE',
      '  return {\n    branchId: branchIdRead.value,\n    shiftId: shiftIdRead.value,\n    expectedCaseVersion: versionRead.value,\n  };',
      '  return raw as CuratedRequestView;',
      ['C-RECONSTRUCT-RAW'],
    ));
  test('MC-36', () =>
    expectMutation(
      'REPLACE',
      "      variance: varianceRead.kind === 'value' ? varianceRead.value : null,",
      "      variance: varianceRead.kind === 'value' ? varianceRead.value : null,\n      note: readOwnLiteral(record, 'note'),",
      ['EXCLUDED-FIELD', 'C8-UNLISTED-KEY'],
    ));
  test('MC-37', () =>
    expectMutation(
      'REPLACE',
      "      variance: varianceRead.kind === 'value' ? varianceRead.value : null,",
      "      variance: varianceRead.kind === 'value' ? varianceRead.value : null,\n      cashEntriesSnapshot: null,",
      ['EXCLUDED-FIELD'],
    ));
  test('MC-38', () => expectMutation('INSERT', 'HELPERS', "const a0 = readOwnLiteral({}, 'acknowledgedByActor');", ['EXCLUDED-FIELD', 'C8-UNLISTED-KEY']));
  test('MC-39', () => expectMutation('INSERT', 'HELPERS', "const l0 = readOwnLiteral({}, 'latestEvidenceId');", ['EXCLUDED-FIELD', 'C8-UNLISTED-KEY']));
  test('MC-40', () => expectMutation('INSERT', 'HELPERS', 'const t0 = setTimeout(() => 1, 0);', ['C2-IDENTIFIER']));
  test('MC-41', () => expectMutation('INSERT', 'HELPERS', "const v0 = (({} as { [k: string]: unknown }))['zzz'];", ['C8-ELEMENT-ACCESS-COUNT']));
  test('MC-42', () => expectMutation('INSERT', 'HELPERS', "const k0 = 'no' + 'te'; const v1 = readOwnLiteral({}, k0);", ['C8-NONLITERAL-KEY']));
  test('MC-43', () => expectMutation('INSERT', 'HELPERS', "const alias0 = readOwnLiteral; const v2 = alias0({}, 'shiftId');", ['C8-HELPER-ALIAS']));
  test('MC-44', () => expectMutation('INSERT', 'HELPERS', "const t1 = readOwnLiteral({}, 'rawToken');", ['C8-UNLISTED-KEY']));
  test('MC-45', () => expectMutation('INSERT', 'HELPERS', 'const p3 = Object.getPrototypeOf({});', ['C7-OBJECT-API']));
  test('MC-46', () => expectMutation('INSERT', 'HELPERS', 'const s1 = Object.getOwnPropertySymbols({});', ['C7-OBJECT-API']));
  test('MC-47', () => expectMutation('INSERT', 'HELPERS', 'const d1 = Object.getOwnPropertyDescriptors({});', ['C7-OBJECT-API']));
  test('MC-48', () =>
    expectMutation(
      'REPLACE',
      '  const token = tokenRead.value;',
      "  const token = tokenRead.value;\n  if (sortedKeys(token) !== 'branchIds,role,staffId') return null;",
      ['C11-AUTH-EXACT-KEYSET'],
    ));
  test('MC-49', () =>
    expectMutation(
      'REPLACE',
      "    role: roleRead.value as 'manager' | 'admin',",
      "    role: roleRead.value as 'manager' | 'admin',\n    staffId: readOwnLiteral(token, 'staffId'),",
      ['C10-CLAIMS-SHAPE'],
    ));
  test('MC-50', () => expectMutation('INSERT', 'HELPERS', "function readNullableId(record: object, key: string): string | null { return null; }", ['C9-BANNED-READER']));
  test('MC-51', () => expectMutation('INSERT', 'HELPERS', 'function asBroken(read: FieldRead<unknown>): string | null { return null; }', ['C9-FIELD-READ-COLLAPSE']));
  test('MC-52', () =>
    expectMutation(
      'REPLACE',
      '  if (branchIdRead.value !== request.branchId) return { response: DENIED, view: null };',
      '  if (branchIdRead.value !== request.branchId) return { response: DENIED, view: null };\n  const caseView = record;',
      ['C10-RECEIVER-BINDING'],
    ));
  test('MC-53', () => expectMutation('INSERT', 'HELPERS', 'const t2 = ({} as { token: unknown }).token;', ['C10-RECEIVER-BINDING']));
  test('MC-54', () => expectMutation('INSERT', 'HELPERS', 'const r1 = ownRead(true, 1);', ['C9-UNVALIDATED-READ']));
  test('MC-55', () => expectMutation('INSERT', 'HELPERS', "const b0 = hasOwnLiteral({}, 'zzz');", ['C8-UNLISTED-KEY']));
  test('MC-56 — retargeted off any C12-governed comparison so C9 fires alone (see MC-56 binding policy)', () =>
    expectMutation(
      'REPLACE',
      "function asRequiredId(read: FieldRead<unknown>): FieldRead<string> {\n  if (read.kind !== 'value') return read;",
      "function asRequiredId(read: FieldRead<unknown>): FieldRead<string> {\n  if (read.kind !== 'nope') return read;",
      ['C9-TAG-EXHAUSTIVENESS'],
    ));
  test('MC-57', () => expectMutation('INSERT', 'CURATION', "const v3 = readOwnLiteral({}, 'latestCloseHash');", ['C8-UNLISTED-KEY', 'EXCLUDED-FIELD']));
  test('MC-58', () =>
    expectMutation(
      'REPLACE',
      '  const schemaRead = asInteger(\n    ownRead(hasOwnLiteral(record, \'schemaVersion\'), readOwnLiteral(record, \'schemaVersion\')),\n  );\n  if (schemaRead.kind !== \'value\') return { response: ANOMALY, view: null };\n  if (schemaRead.value !== SUPPORTED_SCHEMA_VERSION) return { response: ANOMALY, view: null };\n\n  const processingRead = asEnum(',
      '  const schemaRead = asInteger(\n    ownRead(hasOwnLiteral(record, \'schemaVersion\'), readOwnLiteral(record, \'schemaVersion\')),\n  );\n  if (schemaRead.kind !== \'value\') return { response: ANOMALY, view: null };\n  void schemaRead;\n\n  const processingRead = asEnum(',
      ['C12-INVARIANT-MISSING'],
    ));
  test('MC-59', () =>
    expectMutation(
      'REPLACE',
      "  if (validationSchemaRead.value !== SUPPORTED_VALIDATION_SCHEMA_VERSION) {\n    return { response: ANOMALY, view: null };\n  }",
      '  if (false) {\n    return { response: ANOMALY, view: null };\n  }',
      ['C12-INVARIANT-MISSING'],
    ));
  test('MC-60', () =>
    expectMutation(
      'REPLACE',
      '  if (runIdRead.value !== runSnapshotId) return { response: ANOMALY, view: null };',
      '  if (runIdRead.value !== runIdRead.value) return { response: ANOMALY, view: null };',
      ['C12-INVARIANT-MISSING'],
    ));
  test('MC-61', () =>
    expectMutation(
      'REPLACE',
      '  if (evidenceRead.value !== evidenceSnapshotId) return { response: ANOMALY, view: null };',
      '  if (false) return { response: ANOMALY, view: null };',
      ['C12-INVARIANT-MISSING'],
    ));
  test('MC-62', () =>
    expectMutation(
      'REPLACE',
      "  const read = asNullableSafeInteger(\n    ownRead(hasOwnLiteral(map, 'expectedCashMinor'), readOwnLiteral(map, 'expectedCashMinor')),\n  );",
      "  const read = asNullableFinite(\n    ownRead(hasOwnLiteral(map, 'expectedCashMinor'), readOwnLiteral(map, 'expectedCashMinor')),\n  );",
      ['C13-MINOR-VALIDATOR'],
    ));
  test('MC-63', () =>
    expectMutation(
      'REPLACE',
      "  if (alertRead.kind !== 'value') return { response: UNSUPPORTED, view: null };",
      "  if (alertRead.kind !== 'value') return { response: UNSUPPORTED, view: null };\n  if (processingRead.value !== 'validated') return { response: UNSUPPORTED, view: null };",
      ['C14-STATE-NARROWING'],
    ));
  test('MC-64 — C4 defers sentinel-identity to C15 (see MC-64 binding policy), so only C15 fires', () =>
    expectMutation(
      'REPLACE',
      "  if (versionRead.kind !== 'value') return { response: STALE, view: null };",
      "  if (versionRead.kind !== 'value') return { response: ANOMALY, view: null };",
      ['C15-VERSION-STATUS'],
    ));
  test('MC-66', () =>
    expectMutation(
      'REPLACE',
      "  if (varianceRead.kind === 'invalid') return { response: ANOMALY, view: null };",
      "  if (varianceRead.kind === 'invalid') return { response: ANOMALY, view: null };\n  const r2 = readOwnLiteral(record, 'note');",
      ['EXCLUDED-FIELD', 'C8-UNLISTED-KEY'],
    ));
  test('MC-67', () => expectMutation('INSERT', 'HELPERS', 'const [firstState] = PROCESSING_STATES;', ['C14-ENUM-ARRAY-USE']));
  test('MC-68', () => expectMutation('INSERT', 'HELPERS', 'const stateAlias = SETTLEMENT_STATES; const [firstSettlement] = stateAlias;', ['C14-ENUM-ARRAY-USE']));
  test('MC-69', () => expectMutation('INSERT', 'HELPERS', 'const stateClone = [...ALERT_STATES];', ['C14-ENUM-ARRAY-USE']));
  test('MC-70', () => expectMutation('INSERT', 'HELPERS', 'const firstVerdict = VALIDATION_VERDICTS[0];', ['C14-ENUM-ARRAY-USE', 'C8-ELEMENT-ACCESS-COUNT']));
  test('MC-71', () => expectMutation('INSERT', 'HELPERS', 'for (const s of PROCESSING_STATES) { void s; }', ['C14-ENUM-ARRAY-USE']));
  test('MC-72', () => expectMutation('INSERT', 'HELPERS', 'const atState = SETTLEMENT_STATES.at(0);', ['C14-ENUM-ARRAY-USE']));
  test('MC-73', () => expectMutation('INSERT', 'HELPERS', "const hasState = ALERT_STATES.includes('x');", ['C14-ENUM-ARRAY-USE']));
  test('MC-74', () => expectMutation('INSERT', 'HELPERS', 'const passed = asArray(ownRead(true, PROCESSING_STATES));', ['C14-ENUM-ARRAY-USE']));
  test('MC-75', () =>
    expectMutation(
      'REPLACE',
      "  if (schemaRead.value !== SUPPORTED_SCHEMA_VERSION) return { response: ANOMALY, view: null };\n\n  const processingRead = asEnum(",
      "  void (schemaRead.value !== SUPPORTED_SCHEMA_VERSION);\n\n  const processingRead = asEnum(",
      ['C12-INVARIANT-MISSING'],
    ));
  test('MC-76', () =>
    expectMutation(
      'REPLACE',
      "  if (schemaRead.value !== SUPPORTED_SCHEMA_VERSION) return { response: ANOMALY, view: null };\n\n  const processingRead = asEnum(",
      "  if (schemaRead.kind === 'value' && schemaRead.value !== SUPPORTED_SCHEMA_VERSION) { void 0; }\n\n  const processingRead = asEnum(",
      ['C12-INVARIANT-MISSING'],
    ));
  test('MC-77', () =>
    expectMutation(
      'REPLACE',
      '  if (runIdRead.value !== runSnapshotId) return { response: ANOMALY, view: null };',
      '  if (runSnapshotId !== caseView.selectedRunId) return { response: ANOMALY, view: null };',
      ['C12-INVARIANT-MISSING'],
    ));

  test('MC-65 (unique-anchor insert inside curateCaseDocument: RC-PS-02 / Gemini MC65-AND-RCPS03-ADJUDICATION-GEMINI-001, Option A)', () => {
    expect(analyzeCore(CORE_BASELINE_V3)).toEqual([]);

    // The anchor is the exact, frozen, semantic source line for the branch-
    // authority guard inside curateCaseDocument (the only place in the whole
    // module `request.branchId` is compared against a `DENIED` sentinel).
    // Uniqueness is proven directly, not merely relied upon: applyAnchoredInsert
    // itself throws on anything other than exactly one match.
    const anchor = "  if (branchIdRead.value !== request.branchId) return { response: DENIED, view: null };";
    const anchorOccurrences = CORE_BASELINE_V3.split(anchor).length - 1;
    expect(anchorOccurrences).toBe(1); // MC65_ANCHOR_MATCH_COUNT

    // A pure INSERT: an unconditional top-level `return { response: null, ... }`
    // dropped immediately after the anchor. It removes nothing and shadows no
    // guard's own AST node. It is detected purely because C12's dominance
    // check (`dominatesFinalReturn`, a disclosed statement-ordinal
    // approximation) treats the *first* top-level `return { response: null, ...}`
    // found in the function body as the terminal success return: this decoy
    // return is now that first match, so every later real guard's own
    // `ifIndex < finalReturnIndex` test now fails, and every one of those
    // manifest entries reports C12-INVARIANT-MISSING. This is a genuine,
    // non-vacuous finding, not a weakening of C12's no-decoy/exact-text
    // properties — the decoy is never mistaken for satisfying any manifest
    // entry itself; it only defeats the *approximation* the plan already
    // discloses as such.
    const construct = '  return { response: null, view: null };';
    const { source: mutated, range } = applyAnchoredInsert(CORE_BASELINE_V3, anchor, construct);

    // Pure-insertion proof: the mutated source is byte-identical to the
    // baseline outside the inserted text (the anchor line plus one injected
    // newline, exactly matching applyAnchoredInsert's own construction).
    const anchorEnd = CORE_BASELINE_V3.indexOf(anchor) + anchor.length;
    expect(mutated).toBe(
      CORE_BASELINE_V3.slice(0, anchorEnd) + '\n' + construct + CORE_BASELINE_V3.slice(anchorEnd),
    );
    expect(mutated.length).toBe(CORE_BASELINE_V3.length + 1 + construct.length);
    expect(mutated).not.toBe(CORE_BASELINE_V3);

    const violations = analyzeCore(mutated, range);
    expect(violations.length).toBeGreaterThanOrEqual(1); // MC65_ZERO_VIOLATION_COUNT == 0
    const actualCodes = [...new Set(violations.map((v) => v.code))].sort();
    expect(actualCodes).toEqual(['C12-INVARIANT-MISSING']); // MC65_EXPECTED_CODE_COUNT == 1, MC65_UNEXPECTED_CODE_COUNT == 0
    for (const v of violations) {
      expect(v.start).toBeGreaterThanOrEqual(range.start); // MC65_OUT_OF_RANGE_LOCATION_COUNT == 0
      expect(v.end).toBeLessThanOrEqual(range.end);
    }
  });
});

describe('Static guard — core positive fixtures (PS-C1 .. PS-C17)', () => {
  test('PS-C1', () => expectPositive('HELPERS', "const psc1 = Object.prototype.hasOwnProperty.call({}, 'expectedCashMinor');"));
  test('PS-C2', () => expectPositive('HELPERS', 'const psc2 = Number.isFinite(1) && Number.isInteger(1) && Number.isSafeInteger(1);'));
  test('PS-C3', () => expectPositive('HELPERS', "const psc3 = Object.keys({}).sort().join(',');"));
  test('PS-C4', () =>
    expectPositive(
      'HELPERS',
      "const psc4 = typeof '' === 'string' && typeof 1 === 'number' && typeof {} === 'object' && typeof true === 'boolean';",
    ));
  test('PS-C5', () => expectPositive('HELPERS', "const psc5 = '' === '';"));
  test('PS-C6', () =>
    expectPositive(
      'RESPONSES',
      "export function responseStale(): GetShiftCloseCaseFiguresResponse { return { status: 'stale_case_version' }; }",
    ));
  test('PS-C7', () =>
    expectPositive(
      'RESPONSES',
      "export function responseUnauthorized(): GetShiftCloseCaseFiguresResponse { return { status: 'unauthorized' }; }",
    ));
  test('PS-C8', () =>
    expectPositive(
      'RESPONSES',
      "export function responseUnsupported(): GetShiftCloseCaseFiguresResponse { return { status: 'unsupported_case_state' }; }",
    ));
  test('PS-C9 — located: the four governed bindings at exactly their two permitted positions', () => {
    const violations = analyzeCore(CORE_BASELINE_V3);
    expect(violations.filter((v) => v.code === 'C14-ENUM-ARRAY-USE')).toEqual([]);
  });
  test('PS-C10', () =>
    expectPositive(
      'HELPERS',
      "const psc10 = asRequiredId(ownRead(hasOwnLiteral({}, 'branchId'), readOwnLiteral({}, 'branchId')));",
    ));
  test('PS-C11', () =>
    expectPositive('HELPERS', "const psc11 = isSafeSerializedShape({}, 'record') && isSafeSerializedShape([], 'array');"));
  test('PS-C12 — located: the single ElementAccessExpression inside readOwnLiteral is accepted', () => {
    const sf = parseModule(CORE_BASELINE_V3);
    const accesses: ts.ElementAccessExpression[] = [];
    forEachDescendant(sf, (n) => {
      if (ts.isElementAccessExpression(n)) accesses.push(n);
    });
    expect(accesses.length).toBe(1);
    expect(enclosingFunctionName(accesses[0])).toBe('readOwnLiteral');
  });
  test('PS-C13 — located: the four reflective Object.* calls inside isSafeSerializedShape are accepted', () => {
    const violations = analyzeCore(CORE_BASELINE_V3);
    expect(violations.filter((v) => v.code === 'C7-OBJECT-API')).toEqual([]);
  });
  test('PS-C14', () => expectPositive('HELPERS', 'const psc14 = asNullableSafeInteger(ownRead(true, 5));'));
  test('PS-C15 — located: the two SUPPORTED_* constants are accepted (not banned identifiers)', () => {
    expect(CORE_BASELINE_V3.includes('export const SUPPORTED_SCHEMA_VERSION = 1;')).toBe(true);
    expect(CORE_BASELINE_V3.includes('export const SUPPORTED_VALIDATION_SCHEMA_VERSION = 1;')).toBe(true);
    expect(analyzeCore(CORE_BASELINE_V3)).toEqual([]);
  });
  test('PS-C16 — located: all C12 manifest comparisons are satisfied in the baseline', () => {
    expect(analyzeCore(CORE_BASELINE_V3).filter((v) => v.code === 'C12-INVARIANT-MISSING')).toEqual([]);
  });
  // RC-FINAL-02 / PS-C17 closed-world supersession (Gemini
  // TWINPET-P1-OFFLINE-SYNC-PACKET-5-UI-B2-PACKET-S-FINAL-BI01-CLOSED-WORLD-
  // REMEDIATION-AUTHORIZATION-GEMINI-001): the old PS-C17 construct below
  // (`caseView.schemaVersion !== SUPPORTED_SCHEMA_VERSION`, inserted as an
  // unrelated `decoyCheck` function) is no longer an acceptable zero-
  // violation positive fixture now that the C12 CLOSED WORLD layer exists --
  // it shares the real SUPPORTED_SCHEMA_VERSION governed operand, so the
  // whole-module scan correctly reports it as an extra governed candidate
  // (see the "Static guard — C12 closed world" describe block below, where
  // this exact construct is reused, unmodified, as anti-decoy row A6). PS-C17
  // is replaced with a genuinely benign comparison that shares zero governed
  // vocabulary: no governed operand path, sentinel, enum member, literal,
  // comparison shape, or decision-function name.
  test('PS-C17 — inserted benign, non-governed comparison does not disturb C12 (closed-world-safe replacement)', () =>
    expectPositive(
      'DECISIONS',
      "export function isBlankLabel(label: string): boolean { return label.trim() === ''; }",
    ));
});

// ============================================================================
// RC-FINAL-02: C12 CLOSED WORLD -- the 11-category additive anti-decoy matrix.
// Each row is a fresh, additive, non-vacuous mutation (never a substitute for
// a required guard) that inserts or replaces text so the module now contains
// a governed-vocabulary-touching comparison that is NOT one of the 31
// permitted fingerprints. Every row must, and does, produce the exact
// singleton code set ['C12-INVARIANT-MISSING'], with every violation located
// inside the mutation's own exact changed range. These are additive evidence,
// like the C12R rows above, and are not part of the frozen 139-row/167-row
// static matrix.
// ============================================================================
interface AntiDecoyRow {
  id: string;
  category: string;
  description: string;
  form: 'INSERT' | 'REPLACE';
  markerOrTarget: string;
  constructOrReplacement: string;
  expectedCodes: string[];
}

/**
 * RC-FINAL-02B closure: one canonical executable registry for the A1-A11
 * anti-decoy rows. This array is what actually *drives* every anti-decoy test
 * below (via the `for` loop) -- it is not a parallel hand list next to
 * separately written `test(...)` calls, so deleting, renaming, or failing to
 * execute a row changes both the executed test count and the derived
 * category set, making the registry-shape assertions below fail.
 */
const AC3_LINE = '  if (branchIdRead.value !== request.branchId) return { response: DENIED, view: null };';
const AE6_LINE = '  if (hashRead.value !== runView.closeHash) return { response: ANOMALY, view: null };';

const ANTIDECOY_ROWS: readonly AntiDecoyRow[] = [
  {
    id: 'A1',
    category: 'uniqueness',
    description: 'A1 uniqueness (in-place duplicate of the C3 branchId comparison)',
    form: 'REPLACE',
    markerOrTarget: AC3_LINE,
    constructOrReplacement: `${AC3_LINE}\n${AC3_LINE}`,
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'A2',
    category: 'duplicate exact comparison',
    description: 'A2 duplicate exact comparison (in-place duplicate of the E6 closeHash comparison)',
    form: 'REPLACE',
    markerOrTarget: AE6_LINE,
    constructOrReplacement: `${AE6_LINE}\n${AE6_LINE}`,
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'A3',
    category: 'additive self-comparison',
    description: 'A3 additive self-comparison (branchIdRead.value compared to itself)',
    form: 'INSERT',
    markerOrTarget: 'DECISIONS',
    constructOrReplacement: 'export function decoyA3SelfComparison(): boolean { return branchIdRead.value !== branchIdRead.value; }',
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'A4',
    category: 'additive swapped comparison',
    description: 'A4 additive swapped comparison (C3 operands reversed)',
    form: 'INSERT',
    markerOrTarget: 'DECISIONS',
    constructOrReplacement: 'export function decoyA4SwappedComparison(): boolean { return request.branchId !== branchIdRead.value; }',
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'A5',
    category: 'additive detached equivalent',
    description: 'A5 additive detached equivalent (C3 pair reproduced at module level, no owning function)',
    form: 'INSERT',
    markerOrTarget: 'DECISIONS',
    constructOrReplacement: 'if (branchIdRead.value !== request.branchId) { /* A5 detached, module-level */ }',
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'A6',
    category: 'wrong-function decoy',
    description: 'A6 wrong-function decoy (the historical PS-C17 decoyCheck construct)',
    form: 'INSERT',
    markerOrTarget: 'DECISIONS',
    constructOrReplacement:
      'export function decoyCheck(caseView: CuratedCaseView): boolean { if (caseView.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return false; return true; }',
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'A7',
    category: 'wrong-field decoy',
    description: 'A7 wrong-field decoy (branchIdRead.value cross-wired to request.expectedCaseVersion)',
    form: 'INSERT',
    markerOrTarget: 'DECISIONS',
    constructOrReplacement: 'export function decoyA7WrongField(): boolean { return branchIdRead.value !== request.expectedCaseVersion; }',
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'A8',
    category: 'wrong-branch decoy',
    description: 'A8 wrong-branch decoy (C3 pair, non-decision-shape branch)',
    form: 'INSERT',
    markerOrTarget: 'DECISIONS',
    constructOrReplacement:
      'export function decoyA8WrongBranch(): boolean { if (branchIdRead.value !== request.branchId) { return false; } return true; }',
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'A9',
    category: 'wrong-statement decoy',
    description: 'A9 wrong-statement decoy (C3 pair inside a ternary, not an IfStatement)',
    form: 'INSERT',
    markerOrTarget: 'DECISIONS',
    constructOrReplacement: "export const decoyA9WrongStatement = branchIdRead.value !== request.branchId ? 'stale' : 'ok';",
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'A10',
    category: 'wrong-order decoy',
    description: 'A10 wrong-order decoy (C3 pair inserted out of dominance order, near the tail of the module)',
    form: 'INSERT',
    markerOrTarget: 'RESPONSES',
    constructOrReplacement: 'export function decoyA10WrongOrder(): boolean { return branchIdRead.value !== request.branchId; }',
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'A11',
    category: 'ungoverned duplicate (operator drift)',
    description: 'A11 ungoverned duplicate via operator drift (C3 operands, loose != instead of strict !==)',
    form: 'INSERT',
    markerOrTarget: 'DECISIONS',
    constructOrReplacement: 'export function decoyA11UngovernedDuplicate(): boolean { return branchIdRead.value != request.branchId; }',
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
];

const REQUIRED_ANTIDECOY_CATEGORIES = [
  'uniqueness', 'duplicate exact comparison', 'additive self-comparison', 'additive swapped comparison',
  'additive detached equivalent', 'wrong-function decoy', 'wrong-field decoy', 'wrong-branch decoy',
  'wrong-statement decoy', 'wrong-order decoy', 'ungoverned duplicate (operator drift)',
];

describe('Static guard — C12 closed world: 11-category additive anti-decoy matrix (A1 .. A11)', () => {
  test('anti-decoy row registry: exactly 11 rows, unique IDs, unique categories', () => {
    expect(ANTIDECOY_ROWS.length).toBe(11);
    expect(new Set(ANTIDECOY_ROWS.map((r) => r.id)).size).toBe(11);
    expect(new Set(ANTIDECOY_ROWS.map((r) => r.category)).size).toBe(11);
  });

  for (const row of ANTIDECOY_ROWS) {
    test(row.description, () =>
      expectMutation(row.form, row.markerOrTarget, row.constructOrReplacement, row.expectedCodes));
  }

  test('implemented category inventory is derived from the executable row registry (not a parallel hand list)', () => {
    const implemented = ANTIDECOY_ROWS.map((r) => r.category); // derived from the rows the loop above actually executes
    expect(implemented.length).toBe(11);
    expect(REQUIRED_ANTIDECOY_CATEGORIES.length).toBe(11);
    expect([...implemented].sort()).toEqual([...REQUIRED_ANTIDECOY_CATEGORIES].sort());
  });
});

// ============================================================================
// RC-C12-03: an exact required ID-to-category contract for the anti-decoy
// registry, defined independently of ANTIDECOY_ROWS (a second, hand-typed
// source, deliberately not derived from the registry it validates -- the
// point is to catch the registry drifting away from this contract, so the
// contract cannot itself be derived from the thing being checked). The
// pre-existing count/uniqueness/category-set checks above pass unchanged
// even if a row's *ID* is silently renamed to another unique value (length,
// ID uniqueness, category uniqueness, and the required category *set* all
// stay intact); only an exact ID-to-category map catches that.
// ============================================================================
const REQUIRED_ANTIDECOY_ID_CATEGORY: ReadonlyMap<string, string> = new Map([
  ['A1', 'uniqueness'],
  ['A2', 'duplicate exact comparison'],
  ['A3', 'additive self-comparison'],
  ['A4', 'additive swapped comparison'],
  ['A5', 'additive detached equivalent'],
  ['A6', 'wrong-function decoy'],
  ['A7', 'wrong-field decoy'],
  ['A8', 'wrong-branch decoy'],
  ['A9', 'wrong-statement decoy'],
  ['A10', 'wrong-order decoy'],
  ['A11', 'ungoverned duplicate (operator drift)'],
]);

interface AntiDecoyRegistryValidation {
  valid: boolean;
  missingIds: string[];
  unexpectedIds: string[];
  duplicateIds: string[];
  categoryMismatches: { id: string; expectedCategory: string; actualCategory: string }[];
  duplicateCategories: string[];
  missingCategories: string[];
}

/**
 * Validates an anti-decoy row array against REQUIRED_ANTIDECOY_ID_CATEGORY --
 * exact ID set, exact ID-to-category map, no duplicate IDs, no duplicate
 * categories, no missing categories. Unlike the pre-existing registry-shape
 * test (count/uniqueness/category-set only), this rejects an ID rename even
 * though every one of those pre-existing dimensions stays satisfied.
 */
function validateAntiDecoyRegistry(rows: readonly Pick<AntiDecoyRow, 'id' | 'category'>[]): AntiDecoyRegistryValidation {
  const requiredIds = new Set(REQUIRED_ANTIDECOY_ID_CATEGORY.keys());
  const actualIdCounts = new Map<string, number>();
  for (const row of rows) actualIdCounts.set(row.id, (actualIdCounts.get(row.id) ?? 0) + 1);
  const duplicateIds = [...actualIdCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();

  const actualIdSet = new Set(actualIdCounts.keys());
  const missingIds = [...requiredIds].filter((id) => !actualIdSet.has(id)).sort();
  const unexpectedIds = [...actualIdSet].filter((id) => !requiredIds.has(id)).sort();

  const categoryMismatches: AntiDecoyRegistryValidation['categoryMismatches'] = [];
  for (const row of rows) {
    const expectedCategory = REQUIRED_ANTIDECOY_ID_CATEGORY.get(row.id);
    if (expectedCategory !== undefined && expectedCategory !== row.category) {
      categoryMismatches.push({ id: row.id, expectedCategory, actualCategory: row.category });
    }
  }

  const actualCategoryCounts = new Map<string, number>();
  for (const row of rows) actualCategoryCounts.set(row.category, (actualCategoryCounts.get(row.category) ?? 0) + 1);
  const duplicateCategories = [...actualCategoryCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([category]) => category)
    .sort();

  const requiredCategories = new Set(REQUIRED_ANTIDECOY_ID_CATEGORY.values());
  const actualCategories = new Set(rows.map((r) => r.category));
  const missingCategories = [...requiredCategories].filter((c) => !actualCategories.has(c)).sort();

  const valid =
    missingIds.length === 0 &&
    unexpectedIds.length === 0 &&
    duplicateIds.length === 0 &&
    categoryMismatches.length === 0 &&
    duplicateCategories.length === 0 &&
    missingCategories.length === 0;

  return { valid, missingIds, unexpectedIds, duplicateIds, categoryMismatches, duplicateCategories, missingCategories };
}

describe('Static guard — C12 closed world: anti-decoy registry exact ID/category contract (RC-C12-03)', () => {
  test('required contract: exactly 11 IDs, matching REQUIRED_ANTIDECOY_CATEGORIES', () => {
    expect(REQUIRED_ANTIDECOY_ID_CATEGORY.size).toBe(11);
    expect([...REQUIRED_ANTIDECOY_ID_CATEGORY.values()].sort()).toEqual([...REQUIRED_ANTIDECOY_CATEGORIES].sort());
  });

  test('clean registry validation: ANTIDECOY_ROWS matches the required contract exactly', () => {
    const result = validateAntiDecoyRegistry(ANTIDECOY_ROWS);
    expect(result.valid).toBe(true);
    expect(result.missingIds).toEqual([]);
    expect(result.unexpectedIds).toEqual([]);
    expect(result.duplicateIds).toEqual([]);
    expect(result.categoryMismatches).toEqual([]);
    expect(result.duplicateCategories).toEqual([]);
    expect(result.missingCategories).toEqual([]);
  });

  test('P7 rename validator: renaming A6 to A6_RENAMED is rejected even though length/uniqueness/category-set stay intact', () => {
    const renamed = ANTIDECOY_ROWS.map((r) => (r.id === 'A6' ? { ...r, id: 'A6_RENAMED' } : r));
    // Every pre-existing registry-shape dimension still passes on the renamed copy:
    expect(renamed.length).toBe(11);
    expect(new Set(renamed.map((r) => r.id)).size).toBe(11);
    expect(new Set(renamed.map((r) => r.category)).size).toBe(11);
    expect([...renamed.map((r) => r.category)].sort()).toEqual([...REQUIRED_ANTIDECOY_CATEGORIES].sort());

    // Only the exact ID/category contract validator catches the rename:
    const result = validateAntiDecoyRegistry(renamed);
    expect(result.valid).toBe(false);
    expect(result.missingIds).toEqual(['A6']);
    expect(result.unexpectedIds).toEqual(['A6_RENAMED']);
    expect(result.duplicateIds).toEqual([]);
    expect(result.duplicateCategories).toEqual([]);
    expect(result.missingCategories).toEqual([]);
  });
});

/**
 * RC-FINAL-02A closure: permanent additive negative tests for the four
 * governed-vocabulary blind spots Codex proved independently (P1-P4). Each
 * preserves every valid production guard, changes the source exactly once,
 * and is non-vacuous. Placed inside curateCaseDocument (via REPLACE-append
 * immediately after a real, unique anchor line already inside that function)
 * rather than at the module-level DECISIONS marker used by A1-A11: P1's
 * "wrong function" is a nested decoy function (so its ancestor chain still
 * includes curateCaseDocument, the correct C12-governed scope, while its own
 * immediate owning function is wrong); P2/P3/P4 are direct sibling statements
 * inside curateCaseDocument (same owning function, wrong statement kind or
 * wrong operand). A module-level placement (like A1-A11's) cannot express
 * these four shapes without collapsing into the already-covered A6 pattern.
 * P1 specifically anchors inside curateRunDocument (R10's verdictRead.kind),
 * not curateCaseDocument's versionRead.kind: C15 (a separate rule) walks
 * every IfStatement nested anywhere inside curateCaseDocument -- including
 * inside a nested decoy function -- looking for `versionRead`-text guards, so
 * a versionRead-based nested-if decoy there would also (correctly, but not
 * usefully for isolating this probe) trip C15-VERSION-STATUS. R10 is not a
 * sentinelGovernedByC15 entry and curateRunDocument is outside C15's scan
 * entirely, so P1 stays an exact C12-only singleton.
 */
const P1_ANCHOR = "  if (verdictRead.kind !== 'value') return { response: ANOMALY, view: null };";
const P1_P4_ANCHOR = "  if (versionRead.kind !== 'value') return { response: STALE, view: null };";
const P4_ANCHOR = '  if (shiftIdRead.value !== caseSnapshotId) return { response: ANOMALY, view: null };';

const CODEX_BLIND_SPOT_PROBE_ROWS: readonly AntiDecoyRow[] = [
  {
    id: 'P1',
    category: 'wrong-function/wrong-branch .kind',
    description: 'P1 wrong-function/wrong-branch .kind comparison (verdictRead.kind, nested decoy function, non-sentinel branch)',
    form: 'REPLACE',
    markerOrTarget: P1_ANCHOR,
    constructOrReplacement:
      `${P1_ANCHOR}\n  function p1DecoyWrongFunction(): boolean {\n    if (verdictRead.kind !== 'value') { return false; }\n    return true;\n  }`,
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'P2',
    category: 'wrong-statement .kind',
    description: 'P2 wrong-statement .kind comparison (versionRead.kind, bare boolean initializer, not an IfStatement)',
    form: 'REPLACE',
    markerOrTarget: P1_P4_ANCHOR,
    constructOrReplacement: `${P1_P4_ANCHOR}\n  const p2DecoyWrongStatement = versionRead.kind !== 'value';`,
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'P3',
    category: 'wrong-field .kind',
    description: "P3 wrong-field .kind comparison (versionRead.kind compared to the wrong literal 'invalid')",
    form: 'REPLACE',
    markerOrTarget: P1_P4_ANCHOR,
    constructOrReplacement: `${P1_P4_ANCHOR}\n  const p3DecoyWrongField = versionRead.kind !== 'invalid';`,
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'P4',
    category: 'wrong-field *Read.value',
    description: 'P4 wrong-field *Read.value pair (branchIdRead.value cross-compared to shiftIdRead.value)',
    form: 'REPLACE',
    markerOrTarget: P4_ANCHOR,
    constructOrReplacement: `${P4_ANCHOR}\n  const p4DecoyReadValueWrongField = branchIdRead.value !== shiftIdRead.value;`,
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
];

describe('Static guard — C12 closed world: permanent Codex blind-spot probes (P1 .. P4)', () => {
  test('probe row registry: exactly 4 rows, unique IDs, unique categories', () => {
    expect(CODEX_BLIND_SPOT_PROBE_ROWS.length).toBe(4);
    expect(new Set(CODEX_BLIND_SPOT_PROBE_ROWS.map((r) => r.id)).size).toBe(4);
    expect(new Set(CODEX_BLIND_SPOT_PROBE_ROWS.map((r) => r.category)).size).toBe(4);
  });

  for (const row of CODEX_BLIND_SPOT_PROBE_ROWS) {
    test(row.description, () =>
      expectMutation(row.form, row.markerOrTarget, row.constructOrReplacement, row.expectedCodes));
  }
});

/**
 * RC-C12-01 closure: permanent additive negative tests proving governed
 * `.kind` candidate admission no longer depends on the non-kind operand's
 * literal being correct. Each preserves the real C4 `versionRead.kind`
 * guard untouched and appends a structurally-distinct wrong-literal sibling
 * inside the same governed function; each must still surface as an exact
 * singleton `C12-INVARIANT-MISSING` (an admitted candidate with no matching
 * permitted fingerprint), not zero violations.
 *
 * P5a (mandatory) mirrors the Codex-proven escape exactly: `versionRead.kind
 * !== 'missing'` as a real if/return, returning the correct governed sentinel
 * shape (`{ response: STALE, view: null }`) with no else -- previously
 * invisible to discovery because the non-kind operand's literal ('missing')
 * was outside the old two-item kind-tag-literal admission family. P5b/P5c use
 * a bare-initializer shape (like P2) with a wrong string literal ('null') and
 * the `null` keyword itself (not a string literal), respectively, to prove
 * admission is independent of the operand's *kind* of value, not just its
 * text. None of the three collides with the benign-presence inventory
 * (BP1-BP3, see C12_BENIGN_PRESENCE_MANIFEST): all three use the inequality
 * operator (`!==`) against `versionRead.kind`, never the benign slots'
 * equality-against-`'missing'` shape on processingRead/settlementRead/
 * alertRead, so all three remain admitted and rejected as ordinary extra
 * governed candidates.
 */
const P5_WRONG_LITERAL_ROWS: readonly AntiDecoyRow[] = [
  {
    id: 'P5a',
    category: 'wrong-literal .kind (missing, if/return)',
    description:
      "P5a wrong-literal .kind comparison (versionRead.kind !== 'missing', real if/return, correct sentinel shape)",
    form: 'REPLACE',
    markerOrTarget: P1_P4_ANCHOR,
    constructOrReplacement:
      `${P1_P4_ANCHOR}\n  if (versionRead.kind !== 'missing') {\n    return { response: STALE, view: null };\n  }`,
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'P5b',
    category: "wrong-literal .kind ('null' string, bare initializer)",
    description: "P5b wrong-literal .kind comparison (versionRead.kind !== 'null', bare boolean initializer)",
    form: 'REPLACE',
    markerOrTarget: P1_P4_ANCHOR,
    constructOrReplacement: `${P1_P4_ANCHOR}\n  const p5b = versionRead.kind !== 'null';`,
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'P5c',
    category: 'wrong-literal .kind (null keyword, bare initializer)',
    description: 'P5c wrong-literal .kind comparison (versionRead.kind !== null, bare boolean initializer)',
    form: 'REPLACE',
    markerOrTarget: P1_P4_ANCHOR,
    constructOrReplacement: `${P1_P4_ANCHOR}\n  const p5c = versionRead.kind !== null;`,
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
];

describe('Static guard — C12 closed world: permanent wrong-literal .kind probes (P5a .. P5c)', () => {
  test('probe row registry: exactly 3 rows, unique IDs, unique categories', () => {
    expect(P5_WRONG_LITERAL_ROWS.length).toBe(3);
    expect(new Set(P5_WRONG_LITERAL_ROWS.map((r) => r.id)).size).toBe(3);
    expect(new Set(P5_WRONG_LITERAL_ROWS.map((r) => r.category)).size).toBe(3);
  });

  for (const row of P5_WRONG_LITERAL_ROWS) {
    test(row.description, () =>
      expectMutation(row.form, row.markerOrTarget, row.constructOrReplacement, row.expectedCodes));
  }
});

/**
 * Packet S / C12 presence-order-contract exactification (D1): permanent
 * presence-family adversarial probes (P8), proving the removal of the
 * blanket kind-missing admission exclusion actually closes a detection gap
 * rather than merely relocating it. Each construct is legitimate-looking --
 * it reuses the exact `.kind === 'missing'` shape the three real benign
 * checks use -- but is admitted and rejected as an extra governed candidate
 * because it fails to structurally match any of the three exact benign
 * slots (BP1-BP3), not because of any P8-specific analyzer special case.
 *
 * P8a (mandatory): wrong field -- versionRead.kind (a real C12-governed kind
 * operand, C4) compared against 'missing' in a real if/return with a
 * plausible sentinel shape. Before D1, this was invisible (blanket-excluded);
 * now it is admitted (versionRead.kind is governed in curateCaseDocument) and
 * rejected (no benign slot has left === 'versionRead.kind').
 *
 * P8b (mandatory): wrong statement -- the exact real BP1 field/literal pair
 * (processingRead.kind === 'missing'), but as a bare boolean initializer, not
 * an IfStatement -- so it fails the benign slot's directIfCondition/stmtKind
 * dimensions even though its (left, op, right) triple is BP1's own.
 *
 * P8c (preferred, implemented): nested function -- the same BP1 pair, inside
 * a function declared within curateCaseDocument. Admission still succeeds
 * (enclosingGovernedCurateFunction searches past nested function boundaries),
 * but the comparison's parent is a ReturnStatement, not an IfStatement, so it
 * fails structural-slot matching the same way P8b does.
 */
const P8_PRESENCE_PROBE_ROWS: readonly AntiDecoyRow[] = [
  {
    id: 'P8a',
    category: 'wrong-field presence (.kind === \'missing\')',
    description:
      "P8a wrong-field presence probe (versionRead.kind === 'missing', real if/return, plausible sentinel shape)",
    form: 'REPLACE',
    markerOrTarget: P1_P4_ANCHOR,
    constructOrReplacement:
      `${P1_P4_ANCHOR}\n  if (versionRead.kind === 'missing') {\n    return { response: STALE, view: null };\n  }`,
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'P8b',
    category: 'wrong-statement presence (.kind === \'missing\')',
    description:
      "P8b wrong-statement presence probe (processingRead.kind === 'missing', bare boolean initializer, not an IfStatement)",
    form: 'REPLACE',
    markerOrTarget: P1_P4_ANCHOR,
    constructOrReplacement: `${P1_P4_ANCHOR}\n  const p8b = processingRead.kind === 'missing';`,
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'P8c',
    category: 'nested-function presence (.kind === \'missing\')',
    description:
      "P8c nested-function presence probe (processingRead.kind === 'missing', inside a function declared within curateCaseDocument)",
    form: 'REPLACE',
    markerOrTarget: P1_P4_ANCHOR,
    constructOrReplacement:
      `${P1_P4_ANCHOR}\n  function p8c(): boolean {\n    return processingRead.kind === 'missing';\n  }`,
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
];

describe('Static guard — C12 closed world: permanent presence-family adversarial probes (P8a .. P8c)', () => {
  test('probe row registry: exactly 3 rows, unique IDs, unique categories', () => {
    expect(P8_PRESENCE_PROBE_ROWS.length).toBe(3);
    expect(new Set(P8_PRESENCE_PROBE_ROWS.map((r) => r.id)).size).toBe(3);
    expect(new Set(P8_PRESENCE_PROBE_ROWS.map((r) => r.category)).size).toBe(3);
  });

  for (const row of P8_PRESENCE_PROBE_ROWS) {
    test(row.description, () =>
      expectMutation(row.form, row.markerOrTarget, row.constructOrReplacement, row.expectedCodes));
  }
});

/**
 * RC-PRESENCE-01 closure: permanent benign-presence near-match probes (P9a ..
 * P9f), proving the exact branch-signature/order/dominance layer added above
 * actually closes the five near-match escapes Codex proved against the prior
 * benign-presence reconciler (BP1 response DENIED / view null; BP1 response
 * ANOMALY / view non-null; BP1 response ANOMALY / view property omitted;
 * BP1/BP2 order swapped; BP1 moved after the function's terminal success
 * return), plus one additional near-match (an extra return key). Each row
 * preserves the exact real BP1 (left,op,right) triple and owning function --
 * so it still structurally matches BP1's permitted fingerprint and is never
 * rejected as a missing/extra governed candidate -- and fails only the new
 * exact-signature/order/dominance dimension under test.
 */
const BP1_LINE = "  if (processingRead.kind === 'missing') return { response: ANOMALY, view: null };";
const BP2_LINE = "  if (settlementRead.kind === 'missing') return { response: ANOMALY, view: null };";

const P9F_DOMINANCE_TARGET = `  if (processingRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (settlementRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (alertRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (processingRead.kind !== 'value') return { response: UNSUPPORTED, view: null };
  if (settlementRead.kind !== 'value') return { response: UNSUPPORTED, view: null };
  if (alertRead.kind !== 'value') return { response: UNSUPPORTED, view: null };

  const runIdRead = asNullableId(
    ownRead(hasOwnLiteral(record, 'selectedRunId'), readOwnLiteral(record, 'selectedRunId')),
  );
  const hashRead = asNullableId(
    ownRead(
      hasOwnLiteral(record, 'selectedCloseHash'),
      readOwnLiteral(record, 'selectedCloseHash'),
    ),
  );
  if (runIdRead.kind === 'invalid') return { response: ANOMALY, view: null };
  if (hashRead.kind === 'invalid') return { response: ANOMALY, view: null };
  const selectedRunId = runIdRead.kind === 'value' ? runIdRead.value : null;
  const selectedCloseHash = hashRead.kind === 'value' ? hashRead.value : null;
  if (selectedRunId !== null && selectedCloseHash === null) {
    return { response: ANOMALY, view: null };
  }

  return {
    response: null,
    view: {
      shiftId: shiftIdRead.value,
      branchId: branchIdRead.value,
      caseVersion: versionRead.value,
      schemaVersion: schemaRead.value,
      selectedRunId,
      selectedCloseHash,
    },
  };
}`;

const P9F_DOMINANCE_REPLACEMENT = `  if (settlementRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (alertRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (processingRead.kind !== 'value') return { response: UNSUPPORTED, view: null };
  if (settlementRead.kind !== 'value') return { response: UNSUPPORTED, view: null };
  if (alertRead.kind !== 'value') return { response: UNSUPPORTED, view: null };

  const runIdRead = asNullableId(
    ownRead(hasOwnLiteral(record, 'selectedRunId'), readOwnLiteral(record, 'selectedRunId')),
  );
  const hashRead = asNullableId(
    ownRead(
      hasOwnLiteral(record, 'selectedCloseHash'),
      readOwnLiteral(record, 'selectedCloseHash'),
    ),
  );
  if (runIdRead.kind === 'invalid') return { response: ANOMALY, view: null };
  if (hashRead.kind === 'invalid') return { response: ANOMALY, view: null };
  const selectedRunId = runIdRead.kind === 'value' ? runIdRead.value : null;
  const selectedCloseHash = hashRead.kind === 'value' ? hashRead.value : null;
  if (selectedRunId !== null && selectedCloseHash === null) {
    return { response: ANOMALY, view: null };
  }

  return {
    response: null,
    view: {
      shiftId: shiftIdRead.value,
      branchId: branchIdRead.value,
      caseVersion: versionRead.value,
      schemaVersion: schemaRead.value,
      selectedRunId,
      selectedCloseHash,
    },
  };
  if (processingRead.kind === 'missing') return { response: ANOMALY, view: null };
}`;

const P9_NEAR_MATCH_ROWS: readonly AntiDecoyRow[] = [
  {
    id: 'P9a',
    category: 'benign wrong response sentinel',
    description: 'P9a benign wrong response sentinel (BP1 returns DENIED instead of ANOMALY)',
    form: 'REPLACE',
    markerOrTarget: BP1_LINE,
    constructOrReplacement: "  if (processingRead.kind === 'missing') return { response: DENIED, view: null };",
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'P9b',
    category: 'benign non-null view',
    description: 'P9b benign non-null view (BP1 returns view: {} instead of null)',
    form: 'REPLACE',
    markerOrTarget: BP1_LINE,
    constructOrReplacement: "  if (processingRead.kind === 'missing') return { response: ANOMALY, view: {} };",
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'P9c',
    category: 'benign missing view property',
    description: 'P9c benign missing view property (BP1 omits the view key entirely)',
    form: 'REPLACE',
    markerOrTarget: BP1_LINE,
    constructOrReplacement: "  if (processingRead.kind === 'missing') return { response: ANOMALY };",
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'P9d',
    category: 'benign extra return key',
    description: 'P9d benign extra return key (BP1 adds an extra key beyond response/view)',
    form: 'REPLACE',
    markerOrTarget: BP1_LINE,
    constructOrReplacement:
      "  if (processingRead.kind === 'missing') return { response: ANOMALY, view: null, extra: true };",
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'P9e',
    category: 'benign order swap',
    description: 'P9e benign order swap (BP1 and BP2 statements swapped, both byte-for-byte unmutated)',
    form: 'REPLACE',
    markerOrTarget: `${BP1_LINE}\n${BP2_LINE}`,
    constructOrReplacement: `${BP2_LINE}\n${BP1_LINE}`,
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
  {
    id: 'P9f',
    category: 'benign post-terminal dominance',
    description: "P9f benign post-terminal dominance (BP1 moved after curateCaseDocument's terminal success return)",
    form: 'REPLACE',
    markerOrTarget: P9F_DOMINANCE_TARGET,
    constructOrReplacement: P9F_DOMINANCE_REPLACEMENT,
    expectedCodes: ['C12-INVARIANT-MISSING'],
  },
];

describe('Static guard — C12 closed world: permanent benign-presence near-match probes (P9a .. P9f)', () => {
  test('probe row registry: exactly 6 rows, unique IDs, unique categories', () => {
    expect(P9_NEAR_MATCH_ROWS.length).toBe(6);
    expect(new Set(P9_NEAR_MATCH_ROWS.map((r) => r.id)).size).toBe(6);
    expect(new Set(P9_NEAR_MATCH_ROWS.map((r) => r.category)).size).toBe(6);
  });

  for (const row of P9_NEAR_MATCH_ROWS) {
    test(row.description, () =>
      expectMutation(row.form, row.markerOrTarget, row.constructOrReplacement, row.expectedCodes));
  }
});

/**
 * RC-C12-02 closure: a permanent branch-authorization/expected-version reorder
 * probe (the Codex semantic exactly): C3's real, unmutated branch-authorization
 * guard and C4's real, unmutated expected-version guards are both preserved
 * byte-for-byte -- only their relative order changes, moving C3 from before
 * C4 to after it. The structural multiset (fn/op/left/right/shape) is
 * unaffected by a pure reorder, so this exercises only the new effective-
 * dominance/order layer, not the pre-existing per-key reconciliation.
 */
const P6_REORDER_TARGET = `  if (branchIdRead.value !== request.branchId) return { response: DENIED, view: null };

  const versionRead = asInteger(
    ownRead(hasOwnLiteral(record, 'caseVersion'), readOwnLiteral(record, 'caseVersion')),
  );
  if (versionRead.kind !== 'value') return { response: STALE, view: null };
  if (versionRead.value !== request.expectedCaseVersion) return { response: STALE, view: null };`;

const P6_REORDER_REPLACEMENT = `  const versionRead = asInteger(
    ownRead(hasOwnLiteral(record, 'caseVersion'), readOwnLiteral(record, 'caseVersion')),
  );
  if (versionRead.kind !== 'value') return { response: STALE, view: null };
  if (versionRead.value !== request.expectedCaseVersion) return { response: STALE, view: null };
  if (branchIdRead.value !== request.branchId) return { response: DENIED, view: null };`;

describe('Static guard — C12 closed world: permanent branch/version reorder probe (P6)', () => {
  test('P6 branch-authorization/expected-version reorder (C3 moved after C4, both guards unmutated)', () =>
    expectMutation('REPLACE', P6_REORDER_TARGET, P6_REORDER_REPLACEMENT, ['C12-INVARIANT-MISSING']));
});

/**
 * RC-FINAL-02B closure (Packet S D1/D2 exactified): a dedicated executable
 * assertion of the full closed-world baseline inventory, running the *live*
 * discoverC12GovernedCandidates scanner and C12_PERMITTED_FINGERPRINTS /
 * C12_BENIGN_PRESENCE_FINGERPRINTS builders against CORE_BASELINE_V3 -- not a
 * comparison of frozen constants back to themselves. Since discovery is now
 * fully literal-agnostic (the blanket kind-missing exclusion is gone), the
 * live scanner admits 34 total candidates on the clean baseline: the 31 real
 * C12 slots plus the 3 benign field-presence checks (BP1-BP3) -- reconciled
 * here as TOTAL_ADMITTED_GOVERNED_KIND_CANDIDATE_COUNT /
 * C12_ACTUAL_GOVERNED_CANDIDATE_COUNT / BENIGN_PRESENCE_CANDIDATE_COUNT,
 * proven to sum exactly with nothing left uncounted.
 */
describe('C12 closed-world dedicated baseline inventory (RC-FINAL-02B): live analyzer execution', () => {
  test('permitted/actual/missing/extra/duplicate inventory reconciles exactly on CORE_BASELINE_V3', () => {
    expect(C12_MANIFEST.length).toBe(26);
    expect(C12_BOUND_COMPARISON_NODE_COUNT).toBe(31);
    expect(C12_PERMITTED_FINGERPRINTS.length).toBe(31);
    expect(C12_BENIGN_PRESENCE_MANIFEST.length).toBe(3);
    expect(C12_BENIGN_PRESENCE_FINGERPRINTS.length).toBe(3);
    // RC-C12-01: governed owner functions are derived from the live manifest,
    // not a second hand-typed array -- a manifest-owner drift would change
    // this count automatically rather than silently diverging.
    expect(GOVERNED_CURATE_FUNCTIONS.length).toBe(3);
    expect([...GOVERNED_CURATE_FUNCTIONS].sort()).toEqual(
      [...new Set(C12_MANIFEST.map((e) => e.fn))].sort(),
    );

    const combinedPermitted = C12_ALL_PERMITTED_FOR_CLOSED_WORLD;
    expect(combinedPermitted.length).toBe(34);
    const permittedCounts = new Map<string, number>();
    for (const fp of combinedPermitted) {
      const k = c12StructKey(fp);
      permittedCounts.set(k, (permittedCounts.get(k) ?? 0) + 1);
    }
    expect(permittedCounts.size).toBe(34);

    const sf = parseModule(CORE_BASELINE_V3);
    const actualCandidates = discoverC12GovernedCandidates(sf);
    // TOTAL_ADMITTED_GOVERNED_KIND_CANDIDATE_COUNT: whole-module discovery is
    // literal-agnostic, so it admits both families uniformly.
    expect(actualCandidates.length).toBe(34);

    const actualByKey = new Map<string, number>();
    for (const c of actualCandidates) {
      const k = c12StructKey(c.fp);
      actualByKey.set(k, (actualByKey.get(k) ?? 0) + 1);
    }
    expect(actualByKey.size).toBe(34);

    let missing = 0;
    for (const [k, permittedCount] of permittedCounts) {
      const actualCount = actualByKey.get(k) ?? 0;
      if (actualCount < permittedCount) missing += permittedCount - actualCount;
    }
    let extra = 0;
    let duplicate = 0;
    for (const [k, actualCount] of actualByKey) {
      const permittedCount = permittedCounts.get(k) ?? 0;
      if (actualCount > permittedCount) {
        extra += actualCount - permittedCount;
        if (permittedCount >= 1) duplicate += actualCount - permittedCount;
      }
    }

    expect(missing).toBe(0);
    expect(extra).toBe(0);
    expect(duplicate).toBe(0);

    // C12_ACTUAL_GOVERNED_CANDIDATE_COUNT / RC-C12-02: exact resolved
    // manifest-slot identity (manifestId + boundNodeOrdinal) for the 31 real
    // C12 slots specifically -- resolved against C12_PERMITTED_FINGERPRINTS
    // alone, so the 3 benign-presence candidates are correctly *unresolved*
    // here (they belong to the separate benign-presence slot space, reconciled
    // in the dedicated benign-presence inventory test below).
    const c12Resolution = resolveC12Slots(C12_PERMITTED_FINGERPRINTS, actualCandidates);
    expect(c12Resolution.resolved.length).toBe(31);
    expect(c12Resolution.missingSlotCount).toBe(0);
    expect(c12Resolution.duplicateSlotOccupancyCount).toBe(0);
    expect(c12Resolution.unresolvedCandidateCount).toBe(3); // exactly the 3 benign-presence candidates
    expect(new Set(c12Resolution.resolved.map((r) => `${r.manifestId}#${r.boundNodeOrdinal}`)).size).toBe(31);

    // BENIGN_PRESENCE_CANDIDATE_COUNT: the complementary resolution against
    // the benign-presence inventory alone -- proving the 3 unresolved-above
    // candidates are exactly, and only, BP1-BP3, with nothing left over on
    // either side (31 + 3 == 34, TOTAL_ADMITTED_GOVERNED_KIND_CANDIDATE_COUNT).
    const benignResolution = resolveC12Slots(C12_BENIGN_PRESENCE_FINGERPRINTS, actualCandidates);
    expect(benignResolution.resolved.length).toBe(3);
    expect(benignResolution.missingSlotCount).toBe(0);
    expect(benignResolution.duplicateSlotOccupancyCount).toBe(0);
    expect(benignResolution.unresolvedCandidateCount).toBe(31); // exactly the 31 real C12 candidates
    expect(c12Resolution.resolved.length + benignResolution.resolved.length).toBe(actualCandidates.length);

    // RC-C12-02 / Packet S D2/D3: the actual resolved C12 slot order,
    // machine-cross-checked against C12_MANIFEST_EXPECTED_ORDER -- manifest
    // metadata, not a re-derivation from CORE_BASELINE_V3.
    const actualOrder = c12ResolvedSlotOrder(c12Resolution.resolved);
    expect(c12OrderMapsEqual(C12_MANIFEST_EXPECTED_ORDER, actualOrder)).toBe(true);
  });
});

/**
 * Packet S / C12 presence-order-contract exactification: the dedicated
 * benign-presence inventory test (BENIGN_PRESENCE_INVENTORY_TEST_COUNT == 1).
 * Proves, independently of the baseline-inventory test above: (1) whole-
 * module discovery admits all three benign field-presence candidates as
 * ordinary governed candidates (not via any special-cased benign-only scan);
 * (2) they resolve 1:1 against the exact three benign-presence slots, with
 * zero missing/extra/duplicate; (3) their relative source order matches the
 * real production order (processingRead, then settlementRead, then
 * alertRead); (4) each resolved slot's node genuinely satisfies the
 * no-else/ANOMALY-sentinel/dominance properties the permitted template
 * encodes, not merely a structural-key coincidence.
 */
describe('C12 benign presence slots (Packet S D1): exact three-slot structural inventory', () => {
  test('processingRead/settlementRead/alertRead .kind === \'missing\' resolve to exactly BP1/BP2/BP3, in source order', () => {
    expect(C12_BENIGN_PRESENCE_MANIFEST.map((e) => e.id)).toEqual(['BP1', 'BP2', 'BP3']);
    expect(new Set(C12_BENIGN_PRESENCE_FINGERPRINTS.map(c12StructKey)).size).toBe(3);

    const sf = parseModule(CORE_BASELINE_V3);
    // Admission proof: the same whole-module scanner that finds the 31 real
    // C12 candidates finds these three too -- no benign-specific admission
    // path exists (c12ScopedKindMatch has no knowledge of BP1-BP3).
    const allCandidates = discoverC12GovernedCandidates(sf);
    const admittedLefts = new Set(allCandidates.map((c) => c.fp.left));
    expect(admittedLefts.has('processingRead.kind')).toBe(true);
    expect(admittedLefts.has('settlementRead.kind')).toBe(true);
    expect(admittedLefts.has('alertRead.kind')).toBe(true);

    // Reconciliation proof: resolving the full candidate set against the
    // 3-slot benign-presence inventory alone yields exactly 3 resolved, 0
    // missing/extra/duplicate (the 31 real C12 candidates are the expected,
    // accounted-for "unresolved" remainder -- see the baseline inventory test
    // above for the complementary check).
    const resolution = resolveC12Slots(C12_BENIGN_PRESENCE_FINGERPRINTS, allCandidates);
    expect(resolution.resolved.length).toBe(3); // BENIGN_PRESENCE_RESOLVED_SLOT_COUNT
    expect(resolution.missingSlotCount).toBe(0); // BENIGN_PRESENCE_MISSING_SLOT_COUNT
    expect(resolution.duplicateSlotOccupancyCount).toBe(0); // BENIGN_PRESENCE_DUPLICATE_SLOT_COUNT
    expect(new Set(resolution.resolved.map((r) => r.manifestId))).toEqual(new Set(['BP1', 'BP2', 'BP3']));

    // Structural-shape proof (direct if-condition / no else / ANOMALY
    // sentinel / dominance), independent of the key-match above.
    for (const r of resolution.resolved) {
      expect(ts.isIfStatement(r.node.parent)).toBe(true);
      const ifStmt = r.node.parent as ts.IfStatement;
      expect(boundReturnsSentinelNoElse(ifStmt, ['ANOMALY'])).toBe(true);
      expect(dominatesFinalReturn(ifStmt)).toBe(true);
    }

    // Exact order proof: BP1 (processingRead) precedes BP2 (settlementRead)
    // precedes BP3 (alertRead) in the real production source.
    const orderedIds = resolution.resolved
      .slice()
      .sort((a, b) => (c12TopLevelStatementOrdinal(a.node) ?? -1) - (c12TopLevelStatementOrdinal(b.node) ?? -1))
      .map((r) => r.manifestId);
    expect(orderedIds).toEqual(['BP1', 'BP2', 'BP3']);
  });
});

/**
 * RC-PRESENCE-01 closure: dedicated benign-presence exactness contract tests,
 * each independently executing the live parser/analyzer machinery against
 * CORE_BASELINE_V3 (never comparing a constant to itself) --
 * BENIGN_BRANCH_SIGNATURE_TEST_COUNT / BENIGN_ORDER_CONTRACT_TEST_COUNT /
 * BENIGN_DOMINANCE_CONTRACT_TEST_COUNT, one each, separate from the P9
 * negative near-match probes above.
 */
describe('C12 benign presence exactness (RC-PRESENCE-01): exact branch signature / order / dominance contract', () => {
  test('BENIGN_BRANCH_SIGNATURE_TEST_COUNT: each of BP1/BP2/BP3 has the exact frozen 2-key ANOMALY/view:null return shape', () => {
    const sf = parseModule(CORE_BASELINE_V3);
    const { resolved } = resolveC12Slots(C12_BENIGN_PRESENCE_FINGERPRINTS, discoverC12GovernedCandidates(sf));
    expect(resolved.length).toBe(3);
    for (const slot of resolved) {
      const ifStmt = slot.node.parent as ts.IfStatement;
      const sig = computeBenignPresenceReturnSignature(ifStmt);
      expect(sig.returnObjectExact).toBe(true);
      expect(sig.returnPropertyCount).toBe(2);
      expect(sig.returnPropertyKeys).toEqual(['response', 'view']);
      expect(sig.responseIdentifier).toBe('ANOMALY');
      expect(sig.viewLiteralKind).toBe('null');
      expect(sig.hasSpread).toBe(false);
      expect(sig.hasComputed).toBe(false);
      expect(sig.hasDuplicateKey).toBe(false);
      expect(sig.hasExtraKey).toBe(false);
      expect(sig.hasMissingKey).toBe(false);
    }
  });

  test('BENIGN_ORDER_CONTRACT_TEST_COUNT: live-resolved BP1/BP2/BP3 order matches manifest-derived expected order exactly', () => {
    const sf = parseModule(CORE_BASELINE_V3);
    const { resolved } = resolveC12Slots(C12_BENIGN_PRESENCE_FINGERPRINTS, discoverC12GovernedCandidates(sf));
    const actualOrder = c12ResolvedSlotOrder(resolved);
    expect(c12OrderMapsEqual(C12_BENIGN_PRESENCE_EXPECTED_ORDER, actualOrder)).toBe(true);
    expect(actualOrder.get('curateCaseDocument')).toEqual(['BP1#0', 'BP2#0', 'BP3#0']);
  });

  test("BENIGN_DOMINANCE_CONTRACT_TEST_COUNT: each of BP1/BP2/BP3 dominates curateCaseDocument's terminal success return", () => {
    const sf = parseModule(CORE_BASELINE_V3);
    const { resolved } = resolveC12Slots(C12_BENIGN_PRESENCE_FINGERPRINTS, discoverC12GovernedCandidates(sf));
    expect(resolved.length).toBe(3);
    for (const slot of resolved) {
      const ifStmt = slot.node.parent as ts.IfStatement;
      expect(dominatesFinalReturn(ifStmt)).toBe(true);
    }
  });
});

/**
 * Packet S / C12 presence-order-contract exactification (D3): the dedicated
 * order-contract test (C12_ORDERED_SLOT_SEQUENCE_TEST_COUNT == 1), separate
 * from the RC-FINAL-02B baseline inventory test above. Proves the expected
 * sequence (C12_MANIFEST_EXPECTED_ORDER) is generated purely from
 * C12_MANIFEST's own `sourceOrder`/`parts`/`compound` metadata -- computed
 * here again from scratch, without ever touching `sf`/CORE_BASELINE_V3 -- and
 * only THEN cross-checked against the actual baseline order independently
 * re-derived by parsing CORE_BASELINE_V3 (getC12FrozenSlotOrder).
 */
describe('C12 manifest order contract (Packet S D2/D3): manifest-metadata-derived expected order', () => {
  test('expected order is derived from manifest metadata alone, and cross-checks exactly against CORE_BASELINE_V3', () => {
    // Recomputed independently of the module-level constant, and manifestly
    // without any `sf`/CORE_BASELINE_V3 reference anywhere in its call graph
    // (c12ExpectedOrderFromManifest only ever reads its `manifest` argument).
    const expectedFromManifest = c12ExpectedOrderFromManifest(C12_MANIFEST);
    expect(expectedFromManifest).toEqual(C12_MANIFEST_EXPECTED_ORDER);

    expect([...expectedFromManifest.keys()].sort()).toEqual([...GOVERNED_CURATE_FUNCTIONS].sort());
    const totalSlots = [...expectedFromManifest.values()].reduce((sum, seq) => sum + seq.length, 0);
    expect(totalSlots).toBe(31); // every manifest-declared bound node accounted for, once each

    // curateRunDocument: the one function where manifest declaration order
    // diverges from real production order (R10/R11/R12's presence checks
    // precede R2-R9's value checks in source, though declared last).
    expect(expectedFromManifest.get('curateRunDocument')).toEqual([
      'R10#0', 'R11#0', 'R12#0',
      'R2#0', 'R3#0', 'R4#0', 'R5#0', 'R6#0', 'R8#0', 'R7#0', 'R9#0',
    ]);
    expect(expectedFromManifest.get('curateCaseDocument')).toEqual([
      'C3#0', 'C4#0', 'C4#1', 'C2#0', 'C2#1', 'C5#0', 'C6#0', 'C7#0', 'C8#0', 'C9#0', 'C9#1', 'C10#0', 'C10#1', 'C10#2',
    ]);
    expect(expectedFromManifest.get('curateEvidenceDocument')).toEqual(['E2#0', 'E3#0', 'E4#0', 'E5#0', 'E6#0', 'E7#0']);

    // C12_MANIFEST_ORDER_BASELINE_CROSSCHECK_PASS: the independent actual-order
    // oracle (AST-parsed from CORE_BASELINE_V3, never touching the manifest's
    // sourceOrder field) agrees exactly with the manifest-derived expectation.
    expect(c12OrderMapsEqual(expectedFromManifest, getC12FrozenSlotOrder())).toBe(true); // C12_RELATIVE_ORDER_MISMATCH_COUNT == 0

    // Effective dominance: every resolved baseline slot's own IfStatement
    // dominates its function's terminal null-return. A compound (C10) part's
    // resolved node is the comparison itself, one level below the combining
    // `&&`, which is one level below the IfStatement -- walk up to find it,
    // rather than assuming `.parent` is always the IfStatement directly.
    const sf = parseModule(CORE_BASELINE_V3);
    const { resolved } = resolveC12Slots(C12_PERMITTED_FINGERPRINTS, discoverC12GovernedCandidates(sf));
    expect(resolved.length).toBe(31);
    for (const r of resolved) {
      let cur: ts.Node | undefined = r.node;
      while (cur && !ts.isIfStatement(cur)) cur = cur.parent;
      expect(cur && ts.isIfStatement(cur)).toBe(true);
      expect(dominatesFinalReturn(cur as ts.IfStatement)).toBe(true); // C12_EFFECTIVE_DOMINANCE_EXACT
    }
  });
});

describe('Rule-code anti-vacuity: C1-MISSING-IMPORT / C8-ELEMENT-ACCESS-COUNT / C9-FIELD-READ-COLLAPSE never appear in the baseline', () => {
  test('baseline never carries a structural code', () => {
    const codes = new Set(analyzeCore(CORE_BASELINE_V3).map((v) => v.code));
    for (const structural of STRUCTURAL_CODES) {
      expect(codes.has(structural)).toBe(false);
    }
  });
});

// ============================================================================
// The frozen CORE_BASELINE_V3 source text (byte-identical to the shipped
// functions/src/getShiftCloseCaseFiguresCore.ts) — the fixture under guard.
// ============================================================================
const CORE_BASELINE_V3 = `/**
 * getShiftCloseCaseFiguresCore — pure decision core. [Packet 5 / UI-B2 / Packet S]
 * No Firestore handle, no clock, no logging, no network, no process, no reflection.
 * Every exported signature takes curated types, primitives, or `+"`unknown`"+`.
 */
import {
  ALERT_STATES,
  PROCESSING_STATES,
  SETTLEMENT_STATES,
  VALIDATION_VERDICTS,
  type ValidationVerdict,
} from './shiftCloseValidationTypes';

/* MARKER:IMPORTS */

/** Source of truth: shiftCloseEvidenceCaptureCore.ts:40 (SCHEMA_VERSION = 1). */
export const SUPPORTED_SCHEMA_VERSION = 1;

/** Source of truth: shiftCloseValidationWorkerCore.ts:76 (VALIDATION_SCHEMA_VERSION = 1). */
export const SUPPORTED_VALIDATION_SCHEMA_VERSION = 1;

export interface CuratedRequestView {
  branchId: string;
  shiftId: string;
  expectedCaseVersion: number;
}

export interface CuratedAuthClaims {
  staffIdPresent: true;
  role: 'manager' | 'admin';
  branchIds: readonly string[];
}

export interface CuratedCaseView {
  shiftId: string;
  branchId: string;
  caseVersion: number;
  schemaVersion: number;
  selectedRunId: string | null;
  selectedCloseHash: string | null;
}

export interface CuratedRunView {
  runId: string;
  shiftId: string;
  branchId: string;
  closeHash: string;
  evidenceId: string;
  schemaVersion: number;
  validationSchemaVersion: number;
  validationVerdict: ValidationVerdict;
  serverExpectedCashMinor: number | null;
  serverExpectedCashDeltaMinor: number | null;
}

export interface CuratedEvidenceView {
  evidenceId: string;
  shiftId: string;
  branchId: string;
  closeHash: string;
  schemaVersion: number;
  expectedCash: number | null;
  actualCashCount: number | null;
  variance: number | null;
}

export type GetShiftCloseCaseFiguresResponse =
  | {
      status: 'ok';
      reportedExpectedCashBaht: number | null;
      reportedActualCashCountBaht: number | null;
      reportedVarianceBaht: number | null;
      serverExpectedCashMinor: number | null;
      serverExpectedCashDeltaMinor: number | null;
      validationVerdict: ValidationVerdict;
    }
  | { status: 'provisional_no_selected_run' }
  | { status: 'case_not_found' }
  | { status: 'unsupported_case_state' }
  | { status: 'stale_case_version' }
  | { status: 'unavailable_data_anomaly' }
  | { status: 'unauthorized' };

export interface CaseDecision {
  response: GetShiftCloseCaseFiguresResponse | null;
  view: CuratedCaseView | null;
}

export interface RunDecision {
  response: GetShiftCloseCaseFiguresResponse | null;
  view: CuratedRunView | null;
}

export interface EvidenceDecision {
  response: GetShiftCloseCaseFiguresResponse | null;
  view: CuratedEvidenceView | null;
}

export type FieldRead<T> =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'null' }
  | { kind: 'value'; value: T };

type CoreLiteralKey =
  | 'branchId'
  | 'shiftId'
  | 'expectedCaseVersion'
  | 'token'
  | 'staffId'
  | 'role'
  | 'branchIds'
  | 'caseVersion'
  | 'processingState'
  | 'settlementState'
  | 'alertState'
  | 'selectedRunId'
  | 'selectedCloseHash'
  | 'runId'
  | 'closeHash'
  | 'evidenceId'
  | 'validationVerdict'
  | 'serverComputedDrawer'
  | 'perFieldDeltas'
  | 'expectedCashMinor'
  | 'expectedCash'
  | 'actualCashCount'
  | 'variance'
  | 'schemaVersion'
  | 'validationSchemaVersion';

type SafeShapeKind = 'record' | 'array';

const MISSING = { kind: 'missing' } as const;
const INVALID = { kind: 'invalid' } as const;
const NULL_READ = { kind: 'null' } as const;

const MAX_ID_LENGTH = 200;
const REQUEST_KEY_SET = 'branchId,expectedCaseVersion,shiftId';
const BRANCH_WILDCARD = 'ALL';
const ROLE_VALUES: readonly string[] = ['admin', 'manager'];
const ID_JOIN = '_';

const ANOMALY: GetShiftCloseCaseFiguresResponse = { status: 'unavailable_data_anomaly' };
const UNSUPPORTED: GetShiftCloseCaseFiguresResponse = { status: 'unsupported_case_state' };
const STALE: GetShiftCloseCaseFiguresResponse = { status: 'stale_case_version' };
const DENIED: GetShiftCloseCaseFiguresResponse = { status: 'unauthorized' };

/**
 * The ONLY place permitted to use Object.getPrototypeOf,
 * Object.getOwnPropertyDescriptors, or Object.getOwnPropertySymbols (C7).
 */
function isSafeSerializedShape(value: unknown, kind: SafeShapeKind): boolean {
  if (value === null) return false;
  if (typeof value !== 'object') return false;
  const isArrayValue = Array.isArray(value);
  if (kind === 'record') {
    if (isArrayValue) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
  } else {
    if (!isArrayValue) return false;
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  for (const descriptor of descriptors) {
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
  }
  return true;
}

function isPlainScalar(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === 'string') return true;
  if (typeof value === 'number') return true;
  if (typeof value === 'boolean') return true;
  return false;
}

function sortedKeys(raw: object): string {
  return Object.keys(raw).sort().join(',');
}

function hasOwnLiteral(record: object, key: CoreLiteralKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readOwnLiteral(record: object, key: CoreLiteralKey): unknown {
  return (record as { [k in CoreLiteralKey]?: unknown })[key];
}

function ownRead(present: boolean, value: unknown): FieldRead<unknown> {
  if (!present) return MISSING;
  return { kind: 'value', value };
}

function asRequiredId(read: FieldRead<unknown>): FieldRead<string> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (!isPlainScalar(value)) return INVALID;
  if (typeof value !== 'string') return INVALID;
  if (value.length === 0) return INVALID;
  if (value.length > MAX_ID_LENGTH) return INVALID;
  return { kind: 'value', value };
}

function asNullableId(read: FieldRead<unknown>): FieldRead<string | null> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (value === null) return NULL_READ;
  if (!isPlainScalar(value)) return INVALID;
  if (typeof value !== 'string') return INVALID;
  if (value.length === 0) return INVALID;
  if (value.trim().length === 0) return INVALID;
  if (value.length > MAX_ID_LENGTH) return INVALID;
  return { kind: 'value', value };
}

function asInteger(read: FieldRead<unknown>): FieldRead<number> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (!isPlainScalar(value)) return INVALID;
  if (typeof value !== 'number') return INVALID;
  if (!Number.isSafeInteger(value)) return INVALID;
  return { kind: 'value', value };
}

function asNullableFinite(read: FieldRead<unknown>): FieldRead<number | null> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (value === null) return NULL_READ;
  if (!isPlainScalar(value)) return INVALID;
  if (typeof value !== 'number') return INVALID;
  if (!Number.isFinite(value)) return INVALID;
  return { kind: 'value', value };
}

function asNullableSafeInteger(read: FieldRead<unknown>): FieldRead<number | null> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (value === null) return NULL_READ;
  if (!isPlainScalar(value)) return INVALID;
  if (typeof value !== 'number') return INVALID;
  if (!Number.isSafeInteger(value)) return INVALID;
  return { kind: 'value', value };
}

function asEnum(read: FieldRead<unknown>, allowed: readonly string[]): FieldRead<string> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (!isPlainScalar(value)) return INVALID;
  if (typeof value !== 'string') return INVALID;
  if (!allowed.includes(value)) return INVALID;
  return { kind: 'value', value };
}

function asRecord(read: FieldRead<unknown>): FieldRead<object> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (value === null) return NULL_READ;
  if (!isSafeSerializedShape(value, 'record')) return INVALID;
  return { kind: 'value', value: value as object };
}

function asArray(read: FieldRead<unknown>): FieldRead<readonly unknown[]> {
  if (read.kind !== 'value') return read;
  const value = read.value;
  if (value === null) return NULL_READ;
  if (!isSafeSerializedShape(value, 'array')) return INVALID;
  return { kind: 'value', value: value as readonly unknown[] };
}

function asPresent(read: FieldRead<unknown>): FieldRead<true> {
  if (read.kind !== 'value') return read;
  if (read.value === null) return NULL_READ;
  if (read.value === undefined) return INVALID;
  return { kind: 'value', value: true };
}

/** J10: nested missing -> null; explicit null -> null; invalid -> reject. */
function minorFrom(map: object): FieldRead<number | null> {
  const read = asNullableSafeInteger(
    ownRead(hasOwnLiteral(map, 'expectedCashMinor'), readOwnLiteral(map, 'expectedCashMinor')),
  );
  if (read.kind === 'missing') return NULL_READ;
  return read;
}

/* MARKER:HELPERS */

export function curateRequestView(raw: unknown): CuratedRequestView | null {
  if (!isSafeSerializedShape(raw, 'record')) return null;
  const record = raw as object;
  if (sortedKeys(record) !== REQUEST_KEY_SET) return null;
  const branchIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'branchId'), readOwnLiteral(record, 'branchId')),
  );
  const shiftIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'shiftId'), readOwnLiteral(record, 'shiftId')),
  );
  const versionRead = asInteger(
    ownRead(
      hasOwnLiteral(record, 'expectedCaseVersion'),
      readOwnLiteral(record, 'expectedCaseVersion'),
    ),
  );
  if (branchIdRead.kind !== 'value') return null;
  if (shiftIdRead.kind !== 'value') return null;
  if (versionRead.kind !== 'value') return null;
  if (branchIdRead.value.trim().length === 0) return null;
  if (branchIdRead.value === BRANCH_WILDCARD) return null;
  if (shiftIdRead.value.trim().length === 0) return null;
  if (versionRead.value < 0) return null;
  return {
    branchId: branchIdRead.value,
    shiftId: shiftIdRead.value,
    expectedCaseVersion: versionRead.value,
  };
}

export function curateCallableAuth(rawAuth: unknown): CuratedAuthClaims | null {
  if (!isSafeSerializedShape(rawAuth, 'record')) return null;
  const container = rawAuth as object;
  const tokenRead = asRecord(
    ownRead(hasOwnLiteral(container, 'token'), readOwnLiteral(container, 'token')),
  );
  if (tokenRead.kind !== 'value') return null;
  const token = tokenRead.value;
  const staffRead = asPresent(
    ownRead(hasOwnLiteral(token, 'staffId'), readOwnLiteral(token, 'staffId')),
  );
  if (staffRead.kind !== 'value') return null;
  const roleRead = asEnum(
    ownRead(hasOwnLiteral(token, 'role'), readOwnLiteral(token, 'role')),
    ROLE_VALUES,
  );
  if (roleRead.kind !== 'value') return null;
  const branchRead = asArray(
    ownRead(hasOwnLiteral(token, 'branchIds'), readOwnLiteral(token, 'branchIds')),
  );
  if (branchRead.kind !== 'value') return null;
  const branchIds: string[] = [];
  for (const entry of branchRead.value) {
    if (typeof entry === 'string') branchIds.push(entry);
  }
  return {
    staffIdPresent: true,
    role: roleRead.value as 'manager' | 'admin',
    branchIds,
  };
}

/* MARKER:CURATION */

export function curateCaseDocument(
  request: CuratedRequestView,
  caseSnapshotId: string,
  raw: unknown,
): CaseDecision {
  if (!isSafeSerializedShape(raw, 'record')) return { response: ANOMALY, view: null };
  const record = raw as object;

  const branchIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'branchId'), readOwnLiteral(record, 'branchId')),
  );
  if (branchIdRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (branchIdRead.value !== request.branchId) return { response: DENIED, view: null };

  const versionRead = asInteger(
    ownRead(hasOwnLiteral(record, 'caseVersion'), readOwnLiteral(record, 'caseVersion')),
  );
  if (versionRead.kind !== 'value') return { response: STALE, view: null };
  if (versionRead.value !== request.expectedCaseVersion) return { response: STALE, view: null };

  const shiftIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'shiftId'), readOwnLiteral(record, 'shiftId')),
  );
  if (shiftIdRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (shiftIdRead.value !== request.shiftId) return { response: ANOMALY, view: null };
  if (shiftIdRead.value !== caseSnapshotId) return { response: ANOMALY, view: null };

  const schemaRead = asInteger(
    ownRead(hasOwnLiteral(record, 'schemaVersion'), readOwnLiteral(record, 'schemaVersion')),
  );
  if (schemaRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (schemaRead.value !== SUPPORTED_SCHEMA_VERSION) return { response: ANOMALY, view: null };

  const processingRead = asEnum(
    ownRead(hasOwnLiteral(record, 'processingState'), readOwnLiteral(record, 'processingState')),
    PROCESSING_STATES,
  );
  const settlementRead = asEnum(
    ownRead(hasOwnLiteral(record, 'settlementState'), readOwnLiteral(record, 'settlementState')),
    SETTLEMENT_STATES,
  );
  const alertRead = asEnum(
    ownRead(hasOwnLiteral(record, 'alertState'), readOwnLiteral(record, 'alertState')),
    ALERT_STATES,
  );
  if (processingRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (settlementRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (alertRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (processingRead.kind !== 'value') return { response: UNSUPPORTED, view: null };
  if (settlementRead.kind !== 'value') return { response: UNSUPPORTED, view: null };
  if (alertRead.kind !== 'value') return { response: UNSUPPORTED, view: null };

  const runIdRead = asNullableId(
    ownRead(hasOwnLiteral(record, 'selectedRunId'), readOwnLiteral(record, 'selectedRunId')),
  );
  const hashRead = asNullableId(
    ownRead(
      hasOwnLiteral(record, 'selectedCloseHash'),
      readOwnLiteral(record, 'selectedCloseHash'),
    ),
  );
  if (runIdRead.kind === 'invalid') return { response: ANOMALY, view: null };
  if (hashRead.kind === 'invalid') return { response: ANOMALY, view: null };
  const selectedRunId = runIdRead.kind === 'value' ? runIdRead.value : null;
  const selectedCloseHash = hashRead.kind === 'value' ? hashRead.value : null;
  if (selectedRunId !== null && selectedCloseHash === null) {
    return { response: ANOMALY, view: null };
  }

  return {
    response: null,
    view: {
      shiftId: shiftIdRead.value,
      branchId: branchIdRead.value,
      caseVersion: versionRead.value,
      schemaVersion: schemaRead.value,
      selectedRunId,
      selectedCloseHash,
    },
  };
}

export function curateRunDocument(
  caseView: CuratedCaseView,
  runSnapshotId: string,
  raw: unknown,
): RunDecision {
  if (!isSafeSerializedShape(raw, 'record')) return { response: ANOMALY, view: null };
  const record = raw as object;

  const runIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'runId'), readOwnLiteral(record, 'runId')),
  );
  const shiftIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'shiftId'), readOwnLiteral(record, 'shiftId')),
  );
  const branchIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'branchId'), readOwnLiteral(record, 'branchId')),
  );
  const hashRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'closeHash'), readOwnLiteral(record, 'closeHash')),
  );
  const evidenceRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'evidenceId'), readOwnLiteral(record, 'evidenceId')),
  );
  const schemaRead = asInteger(
    ownRead(hasOwnLiteral(record, 'schemaVersion'), readOwnLiteral(record, 'schemaVersion')),
  );
  const validationSchemaRead = asInteger(
    ownRead(
      hasOwnLiteral(record, 'validationSchemaVersion'),
      readOwnLiteral(record, 'validationSchemaVersion'),
    ),
  );
  const verdictRead = asEnum(
    ownRead(
      hasOwnLiteral(record, 'validationVerdict'),
      readOwnLiteral(record, 'validationVerdict'),
    ),
    VALIDATION_VERDICTS,
  );
  const drawerRead = asRecord(
    ownRead(
      hasOwnLiteral(record, 'serverComputedDrawer'),
      readOwnLiteral(record, 'serverComputedDrawer'),
    ),
  );
  const deltasRead = asRecord(
    ownRead(hasOwnLiteral(record, 'perFieldDeltas'), readOwnLiteral(record, 'perFieldDeltas')),
  );
  if (runIdRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (shiftIdRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (branchIdRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (hashRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (evidenceRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (schemaRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (validationSchemaRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (verdictRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (drawerRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (deltasRead.kind !== 'value') return { response: ANOMALY, view: null };

  if (runSnapshotId !== caseView.selectedRunId) return { response: ANOMALY, view: null };
  if (runIdRead.value !== runSnapshotId) return { response: ANOMALY, view: null };
  if (shiftIdRead.value !== caseView.shiftId) return { response: ANOMALY, view: null };
  if (branchIdRead.value !== caseView.branchId) return { response: ANOMALY, view: null };
  if (hashRead.value !== caseView.selectedCloseHash) return { response: ANOMALY, view: null };
  if (schemaRead.value !== SUPPORTED_SCHEMA_VERSION) return { response: ANOMALY, view: null };
  if (validationSchemaRead.value !== SUPPORTED_VALIDATION_SCHEMA_VERSION) {
    return { response: ANOMALY, view: null };
  }
  if (evidenceRead.value !== shiftIdRead.value + ID_JOIN + hashRead.value) {
    return { response: ANOMALY, view: null };
  }

  const drawerMinor = minorFrom(drawerRead.value);
  const deltaMinor = minorFrom(deltasRead.value);
  if (drawerMinor.kind === 'invalid') return { response: ANOMALY, view: null };
  if (deltaMinor.kind === 'invalid') return { response: ANOMALY, view: null };

  return {
    response: null,
    view: {
      runId: runIdRead.value,
      shiftId: shiftIdRead.value,
      branchId: branchIdRead.value,
      closeHash: hashRead.value,
      evidenceId: evidenceRead.value,
      schemaVersion: schemaRead.value,
      validationSchemaVersion: validationSchemaRead.value,
      validationVerdict: verdictRead.value as ValidationVerdict,
      serverExpectedCashMinor: drawerMinor.kind === 'value' ? drawerMinor.value : null,
      serverExpectedCashDeltaMinor: deltaMinor.kind === 'value' ? deltaMinor.value : null,
    },
  };
}

export function curateEvidenceDocument(
  caseView: CuratedCaseView,
  runView: CuratedRunView,
  evidenceSnapshotId: string,
  raw: unknown,
): EvidenceDecision {
  if (!isSafeSerializedShape(raw, 'record')) return { response: ANOMALY, view: null };
  const record = raw as object;

  const evidenceRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'evidenceId'), readOwnLiteral(record, 'evidenceId')),
  );
  const shiftIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'shiftId'), readOwnLiteral(record, 'shiftId')),
  );
  const branchIdRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'branchId'), readOwnLiteral(record, 'branchId')),
  );
  const hashRead = asRequiredId(
    ownRead(hasOwnLiteral(record, 'closeHash'), readOwnLiteral(record, 'closeHash')),
  );
  const schemaRead = asInteger(
    ownRead(hasOwnLiteral(record, 'schemaVersion'), readOwnLiteral(record, 'schemaVersion')),
  );
  const expectedRead = asNullableFinite(
    ownRead(hasOwnLiteral(record, 'expectedCash'), readOwnLiteral(record, 'expectedCash')),
  );
  const actualRead = asNullableFinite(
    ownRead(hasOwnLiteral(record, 'actualCashCount'), readOwnLiteral(record, 'actualCashCount')),
  );
  const varianceRead = asNullableFinite(
    ownRead(hasOwnLiteral(record, 'variance'), readOwnLiteral(record, 'variance')),
  );
  if (evidenceRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (shiftIdRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (branchIdRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (hashRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (schemaRead.kind !== 'value') return { response: ANOMALY, view: null };
  if (expectedRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (expectedRead.kind === 'invalid') return { response: ANOMALY, view: null };
  if (actualRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (actualRead.kind === 'invalid') return { response: ANOMALY, view: null };
  if (varianceRead.kind === 'missing') return { response: ANOMALY, view: null };
  if (varianceRead.kind === 'invalid') return { response: ANOMALY, view: null };

  if (evidenceSnapshotId !== runView.evidenceId) return { response: ANOMALY, view: null };
  if (evidenceRead.value !== evidenceSnapshotId) return { response: ANOMALY, view: null };
  if (shiftIdRead.value !== caseView.shiftId) return { response: ANOMALY, view: null };
  if (branchIdRead.value !== caseView.branchId) return { response: ANOMALY, view: null };
  if (hashRead.value !== runView.closeHash) return { response: ANOMALY, view: null };
  if (schemaRead.value !== SUPPORTED_SCHEMA_VERSION) return { response: ANOMALY, view: null };

  return {
    response: null,
    view: {
      evidenceId: evidenceRead.value,
      shiftId: shiftIdRead.value,
      branchId: branchIdRead.value,
      closeHash: hashRead.value,
      schemaVersion: schemaRead.value,
      expectedCash: expectedRead.kind === 'value' ? expectedRead.value : null,
      actualCashCount: actualRead.kind === 'value' ? actualRead.value : null,
      variance: varianceRead.kind === 'value' ? varianceRead.value : null,
    },
  };
}

/* MARKER:DECISIONS */

export function readCuratedRequestShiftId(request: CuratedRequestView): string {
  return request.shiftId;
}

export function readCuratedCaseSelectedRunId(caseView: CuratedCaseView): string | null {
  return caseView.selectedRunId;
}

export function readCuratedRunEvidenceId(runView: CuratedRunView): string {
  return runView.evidenceId;
}

export function caseDecisionResponse(
  decision: CaseDecision,
): GetShiftCloseCaseFiguresResponse | null {
  return decision.response;
}

export function caseDecisionView(decision: CaseDecision): CuratedCaseView | null {
  return decision.view;
}

export function runDecisionResponse(
  decision: RunDecision,
): GetShiftCloseCaseFiguresResponse | null {
  return decision.response;
}

export function runDecisionView(decision: RunDecision): CuratedRunView | null {
  return decision.view;
}

export function evidenceDecisionResponse(
  decision: EvidenceDecision,
): GetShiftCloseCaseFiguresResponse | null {
  return decision.response;
}

export function evidenceDecisionView(decision: EvidenceDecision): CuratedEvidenceView | null {
  return decision.view;
}

export function hasBranchAuthority(claims: CuratedAuthClaims, branchId: string): boolean {
  if (claims.role !== 'manager' && claims.role !== 'admin') return false;
  if (claims.branchIds.includes(BRANCH_WILDCARD)) return true;
  return claims.branchIds.includes(branchId);
}

export function decideAuthorization(
  claims: CuratedAuthClaims | null,
  request: CuratedRequestView,
): GetShiftCloseCaseFiguresResponse | null {
  if (claims === null) return DENIED;
  if (!hasBranchAuthority(claims, request.branchId)) return DENIED;
  return null;
}

export function decideShiftCloseCaseFigures(
  runView: CuratedRunView,
  evidenceView: CuratedEvidenceView,
): GetShiftCloseCaseFiguresResponse {
  return {
    status: 'ok',
    reportedExpectedCashBaht: evidenceView.expectedCash,
    reportedActualCashCountBaht: evidenceView.actualCashCount,
    reportedVarianceBaht: evidenceView.variance,
    serverExpectedCashMinor: runView.serverExpectedCashMinor,
    serverExpectedCashDeltaMinor: runView.serverExpectedCashDeltaMinor,
    validationVerdict: runView.validationVerdict,
  };
}

export function responseCaseNotFound(): GetShiftCloseCaseFiguresResponse {
  return { status: 'case_not_found' };
}

export function responseProvisionalNoSelectedRun(): GetShiftCloseCaseFiguresResponse {
  return { status: 'provisional_no_selected_run' };
}

export function responseUnavailableDataAnomaly(): GetShiftCloseCaseFiguresResponse {
  return { status: 'unavailable_data_anomaly' };
}

/* MARKER:RESPONSES */
`;

