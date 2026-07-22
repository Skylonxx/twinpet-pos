import { describe, it, expect } from 'vitest';
import {
  ALERT_REASON_CODES,
  ALERT_REASON_LABELS,
  ALERT_STATES,
  ALERT_STATE_LABELS,
  ACTIONABLE_ALERT_STATES,
  UNKNOWN_ALERT_STATE,
  UNKNOWN_REASON_LABEL,
  UNKNOWN_STATE_LABEL,
  filterActionableRows,
  filterMalformedRows,
  mapShiftCloseReviewRow,
  sortShiftCloseReviewRows,
  type ShiftCloseReviewRow,
} from './shiftCloseReviewRows';

const fakeTimestamp = (ms: number) => ({ toMillis: () => ms });

describe('mapShiftCloseReviewRow', () => {
  it('maps only alert-projection fields from a well-formed doc', () => {
    const row = mapShiftCloseReviewRow('shift-1', {
      shiftId: 'shift-1',
      branchId: 'BR-001',
      alertState: 'open',
      reasonCode: 'drawer_discrepancy',
      openedAt: fakeTimestamp(1000),
      updatedAt: fakeTimestamp(2000),
      caseVersion: 3,
      acknowledgedByActor: null,
      resolvedByActor: null,
    });
    expect(row).toEqual({
      id: 'shift-1',
      shiftId: 'shift-1',
      branchId: 'BR-001',
      alertState: 'open',
      alertStateLabel: ALERT_STATE_LABELS.open,
      reasonCode: 'drawer_discrepancy',
      reasonLabel: ALERT_REASON_LABELS.drawer_discrepancy,
      reasonUnknown: false,
      openedAtMs: 1000,
      updatedAtMs: 2000,
      caseVersion: 3,
      acknowledgedByActor: null,
      resolvedByActor: null,
    });
  });

  it('degrades safely for malformed/missing values (never throws)', () => {
    expect(() => mapShiftCloseReviewRow('shift-2', {})).not.toThrow();
    const row = mapShiftCloseReviewRow('shift-2', {
      shiftId: 123, // wrong type
      branchId: null,
      alertState: 'not-a-real-state',
      reasonCode: 'not-a-real-reason',
      openedAt: 'garbage',
      updatedAt: undefined,
      caseVersion: 'NaN-ish',
      acknowledgedByActor: 'garbage',
      resolvedByActor: 42,
    });
    expect(row.id).toBe('shift-2');
    expect(row.shiftId).toBe('shift-2'); // falls back to doc id
    expect(row.branchId).toBe('—');
    // RC-2: unrecognized alertState must surface as UNKNOWN, never collapse to 'none'.
    expect(row.alertState).toBe(UNKNOWN_ALERT_STATE);
    expect(row.alertStateLabel).toBe(UNKNOWN_STATE_LABEL);
    expect(row.reasonCode).toBeNull();
    expect(row.reasonLabel).toBe(UNKNOWN_REASON_LABEL);
    expect(row.reasonUnknown).toBe(true);
    expect(row.openedAtMs).toBeNull();
    expect(row.updatedAtMs).toBeNull();
    expect(row.caseVersion).toBeNull();
    expect(row.acknowledgedByActor).toBeNull();
    expect(row.resolvedByActor).toBeNull();
  });

  it('converts Firestore Timestamp-like values via toMillis()', () => {
    const row = mapShiftCloseReviewRow('s', { openedAt: fakeTimestamp(555), updatedAt: fakeTimestamp(999) });
    expect(row.openedAtMs).toBe(555);
    expect(row.updatedAtMs).toBe(999);
  });

  it('labels all 4 alert states', () => {
    expect(ALERT_STATES).toHaveLength(4);
    for (const state of ALERT_STATES) {
      const row = mapShiftCloseReviewRow('s', { alertState: state });
      expect(row.alertStateLabel).toBe(ALERT_STATE_LABELS[state]);
      expect(row.alertStateLabel).toBeTruthy();
    }
  });

  it('labels all 10 reason codes', () => {
    expect(ALERT_REASON_CODES).toHaveLength(10);
    for (const code of ALERT_REASON_CODES) {
      const row = mapShiftCloseReviewRow('s', { reasonCode: code });
      expect(row.reasonLabel).toBe(ALERT_REASON_LABELS[code]);
      expect(row.reasonLabel).toBeTruthy();
    }
  });

  // RC-2: an unrecognized alertState must reach UNKNOWN_STATE_LABEL and must
  // NEVER be presented as the valid, safe-looking 'none' state — a manager
  // reading "ไม่มีการแจ้งเตือน" for corrupt/drifted data would be misled into
  // believing the branch is clean.
  it('unknown alertState stays visibly unknown (never collapses to "none")', () => {
    const row = mapShiftCloseReviewRow('s', { alertState: 'bogus-state', reasonCode: 'bogus-reason' });
    expect(row.alertState).toBe(UNKNOWN_ALERT_STATE);
    expect(row.alertState).not.toBe('none');
    expect(row.alertStateLabel).toBe(UNKNOWN_STATE_LABEL);
    expect(row.alertStateLabel).not.toBe(ALERT_STATE_LABELS.none);
  });

  // RC-2: an unrecognized reasonCode must reach UNKNOWN_REASON_LABEL, distinct
  // from the "genuinely no reason" dash label used for a null/undefined reasonCode.
  it('unknown reasonCode reaches UNKNOWN_REASON_LABEL, distinct from "no reason"', () => {
    const unknownReasonRow = mapShiftCloseReviewRow('s', { alertState: 'open', reasonCode: 'bogus-reason' });
    expect(unknownReasonRow.reasonCode).toBeNull();
    expect(unknownReasonRow.reasonLabel).toBe(UNKNOWN_REASON_LABEL);
    expect(unknownReasonRow.reasonUnknown).toBe(true);

    const noReasonRow = mapShiftCloseReviewRow('s', { alertState: 'none', reasonCode: null });
    expect(noReasonRow.reasonCode).toBeNull();
    expect(noReasonRow.reasonLabel).toBe('—');
    expect(noReasonRow.reasonLabel).not.toBe(UNKNOWN_REASON_LABEL);
    expect(noReasonRow.reasonUnknown).toBe(false);
  });

  // RC-2 (R2 remediation): filterMalformedRows must catch BOTH an unknown
  // alertState AND a valid-but-non-actionable state (e.g. `resolved`) that
  // carries a present-but-unrecognized reasonCode — the exact gap that let a
  // false clean-success state slip through in R1's alertState-only check.
  describe('filterMalformedRows', () => {
    it('returns a row with an unknown alertState', () => {
      const known = mapShiftCloseReviewRow('k1', { alertState: 'open' });
      const unknownState = mapShiftCloseReviewRow('u1', { alertState: 'totally-bogus' });
      const rows = [known, unknownState];
      expect(filterActionableRows(rows).map((r) => r.id)).toEqual(['k1']);
      expect(filterMalformedRows(rows).map((r) => r.id)).toEqual(['u1']);
      // Never silently dropped from the unfiltered total.
      expect(rows).toHaveLength(2);
    });

    it('returns a valid non-actionable row (resolved) that has an unknown reasonCode', () => {
      const resolvedWithUnknownReason = mapShiftCloseReviewRow('r1', {
        alertState: 'resolved',
        reasonCode: 'bogus-reason',
      });
      expect(resolvedWithUnknownReason.alertState).toBe('resolved'); // valid state, NOT flagged by alertState alone
      expect(filterActionableRows([resolvedWithUnknownReason])).toHaveLength(0); // resolved is never actionable
      expect(filterMalformedRows([resolvedWithUnknownReason]).map((r) => r.id)).toEqual(['r1']);
    });

    it('does NOT flag a known resolved/none row with a known or absent reason', () => {
      const resolvedKnownReason = mapShiftCloseReviewRow('ok1', { alertState: 'resolved', reasonCode: 'retry_exhausted' });
      const noneNoReason = mapShiftCloseReviewRow('ok2', { alertState: 'none', reasonCode: null });
      expect(filterMalformedRows([resolvedKnownReason, noneNoReason])).toHaveLength(0);
    });
  });

  // RC-2: a toMillis() that returns a non-finite number (without throwing)
  // must still degrade to null — never leak NaN/Infinity into sort/UI.
  it('degrades a non-finite toMillis() result to null (never NaN/Infinity)', () => {
    const rowNaN = mapShiftCloseReviewRow('s', { updatedAt: { toMillis: () => NaN } });
    const rowInf = mapShiftCloseReviewRow('s', { openedAt: { toMillis: () => Infinity } });
    expect(rowNaN.updatedAtMs).toBeNull();
    expect(rowInf.openedAtMs).toBeNull();
    expect(Number.isNaN(rowNaN.updatedAtMs)).toBe(false);
  });

  it('negative contract: never surfaces settlementState/processingState labels or fields', () => {
    const row = mapShiftCloseReviewRow('s', {
      alertState: 'open',
      settlementState: 'settled',
      processingState: 'leased',
      selectedRun: 'run-1',
      leaseOwner: 'worker-1',
    }) as ShiftCloseReviewRow & Record<string, unknown>;
    expect(row).not.toHaveProperty('settlementState');
    expect(row).not.toHaveProperty('processingState');
    expect(row).not.toHaveProperty('selectedRun');
    expect(row).not.toHaveProperty('leaseOwner');
    expect(JSON.stringify(row)).not.toMatch(/settlementState|processingState/);
  });
});

describe('sortShiftCloseReviewRows (deterministic)', () => {
  const row = (id: string, updatedAtMs: number | null): ShiftCloseReviewRow => ({
    id,
    shiftId: id,
    branchId: 'BR-001',
    alertState: 'open',
    alertStateLabel: ALERT_STATE_LABELS.open,
    reasonCode: null,
    reasonLabel: '—',
    reasonUnknown: false,
    openedAtMs: null,
    updatedAtMs,
    caseVersion: null,
    acknowledgedByActor: null,
    resolvedByActor: null,
  });

  it('sorts by updatedAtMs descending', () => {
    const sorted = sortShiftCloseReviewRows([row('a', 100), row('b', 300), row('c', 200)]);
    expect(sorted.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties (including both null) deterministically by id ascending', () => {
    const sorted1 = sortShiftCloseReviewRows([row('z', null), row('a', null), row('m', null)]);
    const sorted2 = sortShiftCloseReviewRows([row('m', null), row('z', null), row('a', null)]);
    expect(sorted1.map((r) => r.id)).toEqual(['a', 'm', 'z']);
    expect(sorted2.map((r) => r.id)).toEqual(['a', 'm', 'z']);
  });
});

describe('filterActionableRows (default filter)', () => {
  const row = (id: string, alertState: ShiftCloseReviewRow['alertState']): ShiftCloseReviewRow => ({
    id,
    shiftId: id,
    branchId: 'BR-001',
    alertState,
    alertStateLabel: alertState === UNKNOWN_ALERT_STATE ? UNKNOWN_STATE_LABEL : ALERT_STATE_LABELS[alertState],
    reasonCode: null,
    reasonLabel: '—',
    reasonUnknown: false,
    openedAtMs: null,
    updatedAtMs: null,
    caseVersion: null,
    acknowledgedByActor: null,
    resolvedByActor: null,
  });

  it('default filter is exactly { open, acknowledged }', () => {
    expect([...ACTIONABLE_ALERT_STATES].sort()).toEqual(['acknowledged', 'open']);
  });

  it('actionable count is a strict subset of the total unfiltered count', () => {
    const rows = [row('1', 'none'), row('2', 'open'), row('3', 'acknowledged'), row('4', 'resolved')];
    const actionable = filterActionableRows(rows);
    expect(rows.length).toBe(4); // total unfiltered count
    expect(actionable.length).toBe(2); // actionable count
    expect(actionable.map((r) => r.id).sort()).toEqual(['2', '3']);
  });
});
