import { describe, test, expect } from 'vitest';
import {
  validateAdjudicationPayload,
  hasBranchAccess,
  checkAdjudicationAuthority,
  isLeaseLive,
  decideAdjudicationTransition,
  adjudicationPayloadCanonical,
  adjudicationPayloadHash,
  commandLedgerId,
  buildManagerActor,
  MAX_REASON_NOTE_LENGTH,
  type ResolveShiftCloseAlertRequest,
  type ValidatedAdjudicationRequest,
  type AdjudicationCaseView,
  type AdjudicationAlertView,
} from '../resolveShiftCloseAlertCore';

// Pure module — no Admin SDK, no Firestore, no clock reads; no mocking needed.

const baseReq = (over: Partial<ResolveShiftCloseAlertRequest> = {}): ResolveShiftCloseAlertRequest => ({
  commandId: 'cmd-1',
  shiftId: 'S1',
  branchId: 'B1',
  expectedCaseVersion: 3,
  requestedOutcome: 'acknowledge',
  reasonCode: 'drawer_discrepancy',
  reasonNote: 'checked with staff',
  ...over,
});

const validated = (over: Partial<ValidatedAdjudicationRequest> = {}): ValidatedAdjudicationRequest => ({
  commandId: 'cmd-1',
  shiftId: 'S1',
  branchId: 'B1',
  expectedCaseVersion: 3,
  requestedOutcome: 'acknowledge',
  reasonCode: 'drawer_discrepancy',
  reasonNote: 'checked with staff',
  ...over,
});

describe('validateAdjudicationPayload', () => {
  test('accepts a well-formed request', () => {
    const res = validateAdjudicationPayload(baseReq());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toMatchObject({ commandId: 'cmd-1', shiftId: 'S1', branchId: 'B1', expectedCaseVersion: 3, requestedOutcome: 'acknowledge', reasonCode: 'drawer_discrepancy', reasonNote: 'checked with staff' });
    }
  });

  test('reasonNote optional — absent -> null', () => {
    const res = validateAdjudicationPayload(baseReq({ reasonNote: undefined }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.reasonNote).toBeNull();
  });

  test('pin optional and never required for structural validity', () => {
    const withPin = validateAdjudicationPayload(baseReq({ pin: '1234' }));
    const withoutPin = validateAdjudicationPayload(baseReq({ pin: undefined }));
    expect(withPin.ok).toBe(true);
    expect(withoutPin.ok).toBe(true);
  });

  test.each([
    ['missing commandId', { commandId: '' }],
    ['missing shiftId', { shiftId: '' }],
    ['missing branchId', { branchId: '' }],
    ['non-integer expectedCaseVersion', { expectedCaseVersion: 1.5 }],
    ['negative expectedCaseVersion', { expectedCaseVersion: -1 }],
    ['missing expectedCaseVersion', { expectedCaseVersion: undefined }],
    ['bad requestedOutcome', { requestedOutcome: 'delete' }],
    ['bad reasonCode', { reasonCode: 'not_a_real_code' }],
  ])('rejects: %s', (_label, over) => {
    const res = validateAdjudicationPayload(baseReq(over as Partial<ResolveShiftCloseAlertRequest>));
    expect(res.ok).toBe(false);
  });

  test('rejects over-long reasonNote', () => {
    const res = validateAdjudicationPayload(baseReq({ reasonNote: 'x'.repeat(MAX_REASON_NOTE_LENGTH + 1) }));
    expect(res.ok).toBe(false);
  });

  test('accepts reasonNote at exactly the max length', () => {
    const res = validateAdjudicationPayload(baseReq({ reasonNote: 'x'.repeat(MAX_REASON_NOTE_LENGTH) }));
    expect(res.ok).toBe(true);
  });
});

describe('hasBranchAccess / checkAdjudicationAuthority', () => {
  test('admin bypasses branch check', () => {
    expect(hasBranchAccess({ token: { role: 'admin', branchIds: [] } }, 'B1')).toBe(true);
  });

  test('manager with matching branchIds passes', () => {
    expect(hasBranchAccess({ token: { role: 'manager', branchIds: ['B1', 'B2'] } }, 'B1')).toBe(true);
  });

  test('manager with ALL branchIds passes any branch', () => {
    expect(hasBranchAccess({ token: { role: 'manager', branchIds: ['ALL'] } }, 'B9')).toBe(true);
  });

  test('cross-branch manager fails', () => {
    expect(hasBranchAccess({ token: { role: 'manager', branchIds: ['B2'] } }, 'B1')).toBe(false);
  });

  test('checkAdjudicationAuthority: manager with branch access -> managerUid recorded from staffId', () => {
    const res = checkAdjudicationAuthority({ uid: 'u1', token: { role: 'manager', staffId: 'm1', branchIds: ['B1'] } }, 'B1');
    expect(res.rejectCode).toBeUndefined();
    expect(res.managerUid).toBe('m1');
  });

  test('checkAdjudicationAuthority: admin without staffId falls back to uid', () => {
    const res = checkAdjudicationAuthority({ uid: 'u2', token: { role: 'admin', branchIds: ['ALL'] } }, 'B1');
    expect(res.managerUid).toBe('u2');
  });

  test('checkAdjudicationAuthority: staff role always unauthorized (no PIN path)', () => {
    const res = checkAdjudicationAuthority({ uid: 'u3', token: { role: 'staff', staffId: 's1', branchIds: ['B1'] } }, 'B1');
    expect(res.rejectCode).toBe('unauthorized');
  });

  test('checkAdjudicationAuthority: manager without branch access -> unauthorized', () => {
    const res = checkAdjudicationAuthority({ uid: 'u4', token: { role: 'manager', staffId: 'm2', branchIds: ['B2'] } }, 'B1');
    expect(res.rejectCode).toBe('unauthorized');
  });

  test('checkAdjudicationAuthority: unknown role -> unauthorized', () => {
    const res = checkAdjudicationAuthority({ uid: 'u5', token: { role: 'cashier', branchIds: ['ALL'] } }, 'B1');
    expect(res.rejectCode).toBe('unauthorized');
  });
});

describe('isLeaseLive', () => {
  test('no owner -> not live', () => {
    expect(isLeaseLive({ leaseOwner: null, leaseExpiryMillis: null }, 1000)).toBe(false);
  });

  test('owner present, expiry in the future -> live', () => {
    expect(isLeaseLive({ leaseOwner: 'worker-1', leaseExpiryMillis: 2000 }, 1000)).toBe(true);
  });

  test('owner present, expiry in the past -> not live', () => {
    expect(isLeaseLive({ leaseOwner: 'worker-1', leaseExpiryMillis: 500 }, 1000)).toBe(false);
  });

  test('owner present, expiry exactly now -> not live (strict >)', () => {
    expect(isLeaseLive({ leaseOwner: 'worker-1', leaseExpiryMillis: 1000 }, 1000)).toBe(false);
  });
});

describe('decideAdjudicationTransition', () => {
  const openAlert: AdjudicationAlertView = { alertState: 'open', reasonCode: 'drawer_discrepancy', acknowledgedByActor: null };
  const openCase: AdjudicationCaseView = { alertState: 'open', settlementState: 'manual_review_required' };

  test('acknowledge on open -> acknowledged, reasonCode preserved, settlement unchanged', () => {
    const res = decideAdjudicationTransition({ caseView: openCase, alertView: openAlert, requestedOutcome: 'acknowledge', managerUid: 'm1' });
    expect(res.kind).toBe('transition');
    if (res.kind === 'transition') {
      expect(res.alertProjection).toEqual({
        alertState: 'acknowledged',
        reasonCode: 'drawer_discrepancy',
        acknowledgedByActor: { kind: 'manager', managerUid: 'm1' },
        resolvedByActor: null,
      });
      expect(res.newSettlementState).toBe('manual_review_required');
    }
  });

  test('resolve on open -> resolved, manual_review_required -> manually_resolved, reasonCode preserved, no prior ack', () => {
    const res = decideAdjudicationTransition({ caseView: openCase, alertView: openAlert, requestedOutcome: 'resolve', managerUid: 'm1' });
    expect(res.kind).toBe('transition');
    if (res.kind === 'transition') {
      expect(res.alertProjection).toEqual({
        alertState: 'resolved',
        reasonCode: 'drawer_discrepancy',
        acknowledgedByActor: null,
        resolvedByActor: { kind: 'manager', managerUid: 'm1' },
      });
      expect(res.newSettlementState).toBe('manually_resolved');
    }
  });

  test('resolve on acknowledged -> resolved, PRESERVES prior manager acknowledgedByActor', () => {
    const ackAlert: AdjudicationAlertView = {
      alertState: 'acknowledged',
      reasonCode: 'identity_mismatch',
      acknowledgedByActor: { kind: 'manager', managerUid: 'm-first' },
    };
    const ackCase: AdjudicationCaseView = { alertState: 'acknowledged', settlementState: 'manual_review_required' };
    const res = decideAdjudicationTransition({ caseView: ackCase, alertView: ackAlert, requestedOutcome: 'resolve', managerUid: 'm-second' });
    expect(res.kind).toBe('transition');
    if (res.kind === 'transition') {
      expect(res.alertProjection.acknowledgedByActor).toEqual({ kind: 'manager', managerUid: 'm-first' });
      expect(res.alertProjection.resolvedByActor).toEqual({ kind: 'manager', managerUid: 'm-second' });
      expect(res.alertProjection.reasonCode).toBe('identity_mismatch');
    }
  });

  test('resolve when settlementState is NOT manual_review_required leaves settlement unchanged', () => {
    const provisionalCase: AdjudicationCaseView = { alertState: 'open', settlementState: 'unsettled' };
    const res = decideAdjudicationTransition({ caseView: provisionalCase, alertView: openAlert, requestedOutcome: 'resolve', managerUid: 'm1' });
    expect(res.kind).toBe('transition');
    if (res.kind === 'transition') expect(res.newSettlementState).toBe('unsettled');
  });

  test('resolve when no open alert exists (alertState none) -> alert_not_open', () => {
    const noneAlert: AdjudicationAlertView = { alertState: 'none', reasonCode: null, acknowledgedByActor: null };
    const noneCase: AdjudicationCaseView = { alertState: 'none', settlementState: 'unsettled' };
    const res = decideAdjudicationTransition({ caseView: noneCase, alertView: noneAlert, requestedOutcome: 'resolve', managerUid: 'm1' });
    expect(res).toEqual({ kind: 'rejected', rejectCode: 'alert_not_open' });
  });

  test('acknowledge when no open alert exists (alertState none) -> alert_not_open', () => {
    const noneAlert: AdjudicationAlertView = { alertState: 'none', reasonCode: null, acknowledgedByActor: null };
    const noneCase: AdjudicationCaseView = { alertState: 'none', settlementState: 'unsettled' };
    const res = decideAdjudicationTransition({ caseView: noneCase, alertView: noneAlert, requestedOutcome: 'acknowledge', managerUid: 'm1' });
    expect(res).toEqual({ kind: 'rejected', rejectCode: 'alert_not_open' });
  });

  test('acknowledge already-acknowledged -> invalid_outcome_transition', () => {
    const ackAlert: AdjudicationAlertView = { alertState: 'acknowledged', reasonCode: 'drawer_discrepancy', acknowledgedByActor: { kind: 'manager', managerUid: 'm1' } };
    const ackCase: AdjudicationCaseView = { alertState: 'acknowledged', settlementState: 'manual_review_required' };
    const res = decideAdjudicationTransition({ caseView: ackCase, alertView: ackAlert, requestedOutcome: 'acknowledge', managerUid: 'm2' });
    expect(res).toEqual({ kind: 'rejected', rejectCode: 'invalid_outcome_transition' });
  });

  test('acknowledge already-resolved -> invalid_outcome_transition', () => {
    const resolvedAlert: AdjudicationAlertView = { alertState: 'resolved', reasonCode: 'drawer_discrepancy', acknowledgedByActor: null };
    const resolvedCase: AdjudicationCaseView = { alertState: 'resolved', settlementState: 'manually_resolved' };
    const res = decideAdjudicationTransition({ caseView: resolvedCase, alertView: resolvedAlert, requestedOutcome: 'acknowledge', managerUid: 'm2' });
    expect(res).toEqual({ kind: 'rejected', rejectCode: 'invalid_outcome_transition' });
  });

  test('resolve already-resolved -> invalid_outcome_transition', () => {
    const resolvedAlert: AdjudicationAlertView = { alertState: 'resolved', reasonCode: 'drawer_discrepancy', acknowledgedByActor: null };
    const resolvedCase: AdjudicationCaseView = { alertState: 'resolved', settlementState: 'manually_resolved' };
    const res = decideAdjudicationTransition({ caseView: resolvedCase, alertView: resolvedAlert, requestedOutcome: 'resolve', managerUid: 'm2' });
    expect(res).toEqual({ kind: 'rejected', rejectCode: 'invalid_outcome_transition' });
  });

  test('case/alert alertState disagreement -> invalid_outcome_transition (fails closed)', () => {
    const mismatchedCase: AdjudicationCaseView = { alertState: 'open', settlementState: 'manual_review_required' };
    const mismatchedAlert: AdjudicationAlertView = { alertState: 'acknowledged', reasonCode: 'drawer_discrepancy', acknowledgedByActor: { kind: 'manager', managerUid: 'x' } };
    const res = decideAdjudicationTransition({ caseView: mismatchedCase, alertView: mismatchedAlert, requestedOutcome: 'resolve', managerUid: 'm1' });
    expect(res).toEqual({ kind: 'rejected', rejectCode: 'invalid_outcome_transition' });
  });

  test('every returned transition projection satisfies the frozen P5-B invariant shape', () => {
    const ack = decideAdjudicationTransition({ caseView: openCase, alertView: openAlert, requestedOutcome: 'acknowledge', managerUid: 'm1' });
    const res = decideAdjudicationTransition({ caseView: openCase, alertView: openAlert, requestedOutcome: 'resolve', managerUid: 'm1' });
    expect(ack.kind).toBe('transition');
    expect(res.kind).toBe('transition');
  });
});

describe('idempotency payload hash + ledger id', () => {
  test('same logical request -> same canonical string and hash', () => {
    const a = adjudicationPayloadCanonical(validated());
    const b = adjudicationPayloadCanonical(validated({ commandId: 'different-command-id' }));
    expect(a).toBe(b); // commandId is intentionally excluded from the "same request" definition
    expect(adjudicationPayloadHash(validated())).toBe(adjudicationPayloadHash(validated({ commandId: 'other' })));
  });

  test('a different requestedOutcome/reasonCode/reasonNote changes the hash', () => {
    const base = adjudicationPayloadHash(validated());
    expect(adjudicationPayloadHash(validated({ requestedOutcome: 'resolve' }))).not.toBe(base);
    expect(adjudicationPayloadHash(validated({ reasonCode: 'identity_mismatch' }))).not.toBe(base);
    expect(adjudicationPayloadHash(validated({ reasonNote: 'different note' }))).not.toBe(base);
  });

  test('commandLedgerId is deterministic and stable for the same commandId', () => {
    expect(commandLedgerId('cmd-1')).toBe(commandLedgerId('cmd-1'));
    expect(commandLedgerId('cmd-1')).not.toBe(commandLedgerId('cmd-2'));
    expect(commandLedgerId('cmd-1')).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('buildManagerActor', () => {
  test('builds a manager-kind actor from a uid', () => {
    expect(buildManagerActor('m1')).toEqual({ kind: 'manager', managerUid: 'm1' });
  });
});
