/**
 * INCIDENT 2026-10-17 — P5 A3 `worker_anomaly_alert_invariant / doc_id_mismatch`.
 *
 * Writer/reader contract test: the REAL alert document shape produced by
 * shiftCloseEvidenceCapture (`buildInitWrites().alertFields`, as persisted by
 * `tx.create(shiftCloseAlerts/{shiftId}, { ...alertFields, updatedAt })`) must
 * pass the worker's `validateAlertInvariants`. The capture writer deliberately
 * persists NO `shiftId` on the alert doc (its key set is pinned in
 * shiftCloseEvidenceCaptureCore.test.ts); the Firestore document id is the
 * canonical shift identity (D-P5-A3-1).
 *
 * Before the fix the worker compared `doc id` to a stored `shiftId` that is
 * always absent, so this test failed with `doc_id_mismatch`.
 */
import { describe, test, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { planCapture, buildInitWrites } from '../shiftCloseEvidenceCaptureCore';
import { validateAlertInvariants, type AlertInvariantAlertView } from '../shiftCloseValidationWorkerCore';

const SHIFT_ID = 'shift-contract-1';

function capturedInit() {
  const planned = planCapture({
    shiftId: SHIFT_ID,
    before: { status: 'open' },
    after: {
      status: 'closed',
      branchId: 'branch-1',
      staffId: 'staff-1',
      deviceId: 'device-1',
      closedAt: Timestamp.fromMillis(1_700_000_000_000),
      startingCash: 5000,
      actualCashCount: 4800,
      variance: -200,
      expectedCash: 0,
      expectedQr: 0,
      expectedKbank: 0,
      expectedCard: 0,
      expectedCredit: 0,
      payInTotal: 0,
      payOutTotal: 0,
      totalBills: 0,
      note: '',
      cashEntries: [],
    },
    eventTimeIso: '2026-10-17T00:44:36.915Z',
  });
  if (planned.kind !== 'capture') throw new Error(`fixture setup failed: ${JSON.stringify(planned)}`);
  return buildInitWrites(planned.capture);
}

/** Same field mapping the worker's T3 applies to a stored alert doc (runT3). */
function workerViewOfStoredAlert(docId: string, stored: Record<string, unknown>): AlertInvariantAlertView {
  return {
    id: docId,
    shiftId: stored.shiftId,
    branchId: stored.branchId,
    schemaVersion: stored.schemaVersion,
    caseVersion: stored.caseVersion,
    alertState: stored.alertState as AlertInvariantAlertView['alertState'],
    reasonCode: stored.reasonCode,
    acknowledgedByActor: stored.acknowledgedByActor,
    resolvedByActor: stored.resolvedByActor,
    openedAt: stored.openedAt,
  };
}

describe('P5 capture -> worker alert identity contract (INCIDENT-A3 regression)', () => {
  test('capture still writes NO shiftId on the alert doc (persisted schema unchanged)', () => {
    const { alertFields } = capturedInit();
    expect(Object.keys(alertFields).sort()).toEqual(
      ['acknowledgedByActor', 'alertState', 'branchId', 'caseVersion', 'openedAt', 'reasonCode', 'resolvedByActor', 'schemaVersion'].sort(),
    );
    expect(alertFields).not.toHaveProperty('shiftId');
  });

  test('the real capture-produced alert doc passes the worker alert invariants', () => {
    const { alertFields, caseFields } = capturedInit();
    const stored = { ...alertFields, updatedAt: Timestamp.fromMillis(1_700_000_001_000) }; // as persisted
    const result = validateAlertInvariants(
      { branchId: caseFields.branchId as string, caseVersion: caseFields.caseVersion as number, alertState: caseFields.alertState as never },
      workerViewOfStoredAlert(SHIFT_ID, stored),
    );
    expect(result).toEqual({ ok: true }); // pre-fix: { ok: false, violation: 'doc_id_mismatch' }
  });

  test('an explicitly stored, mismatching shiftId on the same captured shape is still rejected', () => {
    const { alertFields, caseFields } = capturedInit();
    const stored = { ...alertFields, shiftId: 'a-different-shift' };
    const result = validateAlertInvariants(
      { branchId: caseFields.branchId as string, caseVersion: caseFields.caseVersion as number, alertState: caseFields.alertState as never },
      workerViewOfStoredAlert(SHIFT_ID, stored),
    );
    expect(result).toEqual({ ok: false, violation: 'doc_id_mismatch' });
  });

  test('an explicitly stored, matching shiftId on the captured shape is accepted', () => {
    const { alertFields, caseFields } = capturedInit();
    const stored = { ...alertFields, shiftId: SHIFT_ID };
    const result = validateAlertInvariants(
      { branchId: caseFields.branchId as string, caseVersion: caseFields.caseVersion as number, alertState: caseFields.alertState as never },
      workerViewOfStoredAlert(SHIFT_ID, stored),
    );
    expect(result).toEqual({ ok: true });
  });
});
