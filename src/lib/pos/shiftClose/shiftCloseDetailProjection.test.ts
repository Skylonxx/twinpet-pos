import { describe, it, expect } from 'vitest';
import { mapShiftCloseReviewRow } from './shiftCloseReviewRows';
import {
  computeIntegrityCautions,
  mapShiftCloseCaseProjection,
  UNKNOWN_CASE_ENUM,
  UNKNOWN_PROCESSING_STATE_LABEL,
  UNKNOWN_SETTLEMENT_STATE_LABEL,
} from './shiftCloseDetailProjection';

describe('mapShiftCloseCaseProjection — safe field projection', () => {
  it('maps recognized processingState/settlementState to their labels', () => {
    const p = mapShiftCloseCaseProjection('s1', {
      branchId: 'BR-001',
      processingState: 'validated',
      settlementState: 'provisional_match',
      caseVersion: 3,
      selectedRunId: 'run-123',
    });
    expect(p.processingState).toBe('validated');
    expect(p.processingStateUnknown).toBe(false);
    expect(p.settlementState).toBe('provisional_match');
    expect(p.settlementStateUnknown).toBe(false);
    expect(p.caseVersion).toBe(3);
  });

  it('never exposes sensitive keys structurally (actualCashCount, variance, note, evidence, leaseOwner, leaseExpiry, validation run IDs)', () => {
    const p = mapShiftCloseCaseProjection('s1', {
      branchId: 'BR-001',
      processingState: 'validated',
      settlementState: 'unsettled',
      caseVersion: 1,
      selectedRunId: 'run-abc',
      actualCashCount: 99999,
      variance: -500,
      note: 'sensitive manager note',
      leaseOwner: 'worker-1',
      leaseExpiry: 123456,
      evidenceId: 'evidence-xyz',
      validationRunId: 'run-xyz',
    });
    const keys = Object.keys(p);
    expect(keys).not.toContain('actualCashCount');
    expect(keys).not.toContain('variance');
    expect(keys).not.toContain('note');
    expect(keys).not.toContain('leaseOwner');
    expect(keys).not.toContain('leaseExpiry');
    expect(keys).not.toContain('evidenceId');
    expect(keys).not.toContain('validationRunId');
    expect(keys).not.toContain('selectedRunId');
    expect(JSON.stringify(p)).not.toContain('run-abc');
    expect(JSON.stringify(p)).not.toContain('sensitive manager note');
    expect(JSON.stringify(p)).not.toContain('worker-1');
  });

  it('selectedRunId output is boolean-only via hasSelectedRun — present run yields true, no ID leaked', () => {
    const p = mapShiftCloseCaseProjection('s1', {
      processingState: 'validated',
      settlementState: 'unsettled',
      caseVersion: 1,
      selectedRunId: 'run-999',
    });
    expect(p.hasSelectedRun).toBe(true);
  });

  it('selectedRunId absent/null/empty yields hasSelectedRun: false', () => {
    for (const value of [null, undefined, '']) {
      const p = mapShiftCloseCaseProjection('s1', {
        processingState: 'validated',
        settlementState: 'unsettled',
        caseVersion: 1,
        selectedRunId: value,
      });
      expect(p.hasSelectedRun).toBe(false);
    }
  });

  it('caseVersion is internal/provenance-only: a plain finite number, null when missing/malformed', () => {
    const withVersion = mapShiftCloseCaseProjection('s1', { caseVersion: 7 });
    expect(withVersion.caseVersion).toBe(7);

    const missing = mapShiftCloseCaseProjection('s1', {});
    expect(missing.caseVersion).toBeNull();

    const malformed = mapShiftCloseCaseProjection('s1', { caseVersion: 'seven' });
    expect(malformed.caseVersion).toBeNull();

    const nonFinite = mapShiftCloseCaseProjection('s1', { caseVersion: Infinity });
    expect(nonFinite.caseVersion).toBeNull();
  });

  it('unknown/malformed processingState maps to the sentinel + unknown label, never a frozen value', () => {
    const p = mapShiftCloseCaseProjection('s1', { processingState: 'totally-bogus-state' });
    expect(p.processingState).toBe(UNKNOWN_CASE_ENUM);
    expect(p.processingStateUnknown).toBe(true);
    expect(p.processingStateLabel).toBe(UNKNOWN_PROCESSING_STATE_LABEL);
  });

  it('unknown/malformed settlementState maps to the sentinel + unknown label, never a frozen value', () => {
    const p = mapShiftCloseCaseProjection('s1', { settlementState: 'totally-bogus-state' });
    expect(p.settlementState).toBe(UNKNOWN_CASE_ENUM);
    expect(p.settlementStateUnknown).toBe(true);
    expect(p.settlementStateLabel).toBe(UNKNOWN_SETTLEMENT_STATE_LABEL);
  });

  it('storedIdMismatch is true only when a present, non-empty stored shiftId differs from the doc id', () => {
    expect(mapShiftCloseCaseProjection('s1', { shiftId: 's1' }).storedIdMismatch).toBe(false);
    expect(mapShiftCloseCaseProjection('s1', {}).storedIdMismatch).toBe(false);
    expect(mapShiftCloseCaseProjection('s1', { shiftId: '' }).storedIdMismatch).toBe(false);
    expect(mapShiftCloseCaseProjection('s1', { shiftId: 's2' }).storedIdMismatch).toBe(true);
  });

  it('never throws on a completely empty data blob and degrades to safe defaults', () => {
    const p = mapShiftCloseCaseProjection('s1', {});
    expect(p.processingStateUnknown).toBe(true);
    expect(p.settlementStateUnknown).toBe(true);
    expect(p.hasSelectedRun).toBe(false);
    expect(p.updatedAtMs).toBeNull();
  });
});

describe('computeIntegrityCautions', () => {
  const alertRow = (overrides: Partial<Parameters<typeof mapShiftCloseReviewRow>[1]> = {}) =>
    mapShiftCloseReviewRow('S1', { shiftId: 'S1', branchId: 'BR-001', alertState: 'open', caseVersion: 2, ...overrides });

  const caseProjection = (overrides: Record<string, unknown> = {}) =>
    mapShiftCloseCaseProjection('S1', { shiftId: 'S1', processingState: 'validated', settlementState: 'unsettled', caseVersion: 2, ...overrides });

  it('returns empty for a clean, matching pair', () => {
    const cautions = computeIntegrityCautions({
      alert: alertRow(),
      alertConfirmedEmpty: false,
      kase: caseProjection(),
      caseConfirmedEmpty: false,
    });
    expect(cautions).toEqual([]);
  });

  it('flags alert stored-ID mismatch (doc id S1, stored shiftId differs)', () => {
    const cautions = computeIntegrityCautions({
      alert: alertRow({ shiftId: 'DIFFERENT' }),
      alertConfirmedEmpty: false,
      kase: null,
      caseConfirmedEmpty: false,
    });
    expect(cautions).toContain('alert_stored_id_mismatch');
  });

  it('flags case stored-ID mismatch (doc id S1, stored shiftId differs)', () => {
    const cautions = computeIntegrityCautions({
      alert: null,
      alertConfirmedEmpty: false,
      kase: caseProjection({ shiftId: 'DIFFERENT' }),
      caseConfirmedEmpty: false,
    });
    expect(cautions).toContain('case_stored_id_mismatch');
  });

  it('flags caseVersion drift when alert.caseVersion !== case.caseVersion', () => {
    const cautions = computeIntegrityCautions({
      alert: alertRow({ caseVersion: 5 }),
      alertConfirmedEmpty: false,
      kase: caseProjection({ caseVersion: 2 }),
      caseConfirmedEmpty: false,
    });
    expect(cautions).toContain('case_version_drift');
  });

  it('does not flag caseVersion drift when either side has a null caseVersion', () => {
    const cautions = computeIntegrityCautions({
      alert: alertRow({ caseVersion: null }),
      alertConfirmedEmpty: false,
      kase: caseProjection({ caseVersion: 2 }),
      caseConfirmedEmpty: false,
    });
    expect(cautions).not.toContain('case_version_drift');
  });

  it('flags unknown alertState and unknown reasonCode independently', () => {
    const cautions = computeIntegrityCautions({
      alert: alertRow({ alertState: 'bogus', reasonCode: 'bogus-reason' }),
      alertConfirmedEmpty: false,
      kase: null,
      caseConfirmedEmpty: false,
    });
    expect(cautions).toContain('alert_state_unknown');
    expect(cautions).toContain('alert_reason_unknown');
  });

  it('flags unknown processingState/settlementState independently', () => {
    const cautions = computeIntegrityCautions({
      alert: null,
      alertConfirmedEmpty: false,
      kase: caseProjection({ processingState: 'bogus', settlementState: 'bogus' }),
      caseConfirmedEmpty: false,
    });
    expect(cautions).toContain('processing_state_unknown');
    expect(cautions).toContain('settlement_state_unknown');
  });

  it('flags case_missing_for_alert when alert exists but case source is server-confirmed empty', () => {
    const cautions = computeIntegrityCautions({
      alert: alertRow(),
      alertConfirmedEmpty: false,
      kase: null,
      caseConfirmedEmpty: true,
    });
    expect(cautions).toContain('case_missing_for_alert');
  });

  it('flags alert_missing_for_case when case exists but alert source is server-confirmed empty', () => {
    const cautions = computeIntegrityCautions({
      alert: null,
      alertConfirmedEmpty: true,
      kase: caseProjection(),
      caseConfirmedEmpty: false,
    });
    expect(cautions).toContain('alert_missing_for_case');
  });

  it('does NOT flag a pairing gap when both sources are merely not-yet-confirmed-empty (both null, neither confirmed empty)', () => {
    const cautions = computeIntegrityCautions({
      alert: null,
      alertConfirmedEmpty: false,
      kase: null,
      caseConfirmedEmpty: false,
    });
    expect(cautions).toEqual([]);
  });
});
