import { describe, test, expect } from 'vitest';
import {
  computeRunTransition,
  computeRetryExhaustionTransition,
  computeManagerResolution,
  isValidAlertProjection,
  createInvocationResultCache,
  initialStreamCursor,
  stepStream,
  type AlertProjectionDelta,
  type CaseId,
  type DurableOutcome,
  type EligibilityCheck,
  type StreamCursor,
  type StreamOrder,
} from '../shiftCloseValidationState';
import { ALERT_REASON_CODES, isValidAlertReasonCode, isValidErrorClassification, ERROR_CLASSIFICATIONS } from '../shiftCloseValidationTypes';

describe('AlertReasonCode / errorClassification schema', () => {
  test('all ten AlertReasonCode values are accepted', () => {
    expect(ALERT_REASON_CODES).toHaveLength(10);
    for (const value of ALERT_REASON_CODES) {
      expect(isValidAlertReasonCode(value)).toBe(true);
    }
  });

  test('an unknown reason code is rejected', () => {
    expect(isValidAlertReasonCode('not_a_real_reason')).toBe(false);
    expect(isValidAlertReasonCode('')).toBe(false);
  });

  test('all five errorClassification values are accepted', () => {
    expect(ERROR_CLASSIFICATIONS).toHaveLength(5);
    for (const value of ERROR_CLASSIFICATIONS) {
      expect(isValidErrorClassification(value)).toBe(true);
    }
  });

  test('invalid_payload is a valid AlertReasonCode but NOT a valid errorClassification', () => {
    expect(isValidAlertReasonCode('invalid_payload')).toBe(true);
    expect(isValidErrorClassification('invalid_payload')).toBe(false);
  });

  test('every non-null errorClassification value is also a valid AlertReasonCode (mirror holds)', () => {
    for (const value of ERROR_CLASSIFICATIONS) {
      expect(isValidAlertReasonCode(value)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Alert projection validity — the frozen per-state actor/null rules (R4 §8.3).
// ---------------------------------------------------------------------------

describe('isValidAlertProjection — frozen per-state actor/null rules', () => {
  test('none: reason and both actors null', () => {
    expect(isValidAlertProjection({ alertState: 'none', reasonCode: null, acknowledgedByActor: null, resolvedByActor: null })).toBe(true);
    expect(isValidAlertProjection({ alertState: 'none', reasonCode: 'drawer_discrepancy', acknowledgedByActor: null, resolvedByActor: null })).toBe(false);
  });

  test('open: reason non-null, both actors null', () => {
    expect(isValidAlertProjection({ alertState: 'open', reasonCode: 'drawer_discrepancy', acknowledgedByActor: null, resolvedByActor: null })).toBe(true);
    expect(isValidAlertProjection({ alertState: 'open', reasonCode: null, acknowledgedByActor: null, resolvedByActor: null })).toBe(false);
    // an open alert may not carry actors
    expect(isValidAlertProjection({ alertState: 'open', reasonCode: 'drawer_discrepancy', acknowledgedByActor: { kind: 'manager', managerUid: 'm1' }, resolvedByActor: null })).toBe(false);
  });

  test('acknowledged: manager acknowledgement actor, no resolved actor', () => {
    expect(isValidAlertProjection({ alertState: 'acknowledged', reasonCode: 'drawer_discrepancy', acknowledgedByActor: { kind: 'manager', managerUid: 'm1' }, resolvedByActor: null })).toBe(true);
    // system may never acknowledge
    expect(isValidAlertProjection({ alertState: 'acknowledged', reasonCode: 'drawer_discrepancy', acknowledgedByActor: { kind: 'system' }, resolvedByActor: null })).toBe(false);
    // must have an acknowledgement actor
    expect(isValidAlertProjection({ alertState: 'acknowledged', reasonCode: 'drawer_discrepancy', acknowledgedByActor: null, resolvedByActor: null })).toBe(false);
  });

  test('resolved by system: resolvedByActor {kind:system}, ack actor nullable', () => {
    expect(isValidAlertProjection({ alertState: 'resolved', reasonCode: 'superseding_match', acknowledgedByActor: null, resolvedByActor: { kind: 'system' } })).toBe(true);
    expect(isValidAlertProjection({ alertState: 'resolved', reasonCode: 'superseding_match', acknowledgedByActor: { kind: 'manager', managerUid: 'm1' }, resolvedByActor: { kind: 'system' } })).toBe(true);
    // a system value in the acknowledgement slot is impossible
    expect(isValidAlertProjection({ alertState: 'resolved', reasonCode: 'superseding_match', acknowledgedByActor: { kind: 'system' }, resolvedByActor: { kind: 'system' } })).toBe(false);
    // resolved must have a resolver
    expect(isValidAlertProjection({ alertState: 'resolved', reasonCode: 'superseding_match', acknowledgedByActor: null, resolvedByActor: null })).toBe(false);
  });

  test('resolved by manager: resolvedByActor {kind:manager, managerUid}', () => {
    expect(isValidAlertProjection({ alertState: 'resolved', reasonCode: 'drawer_discrepancy', acknowledgedByActor: null, resolvedByActor: { kind: 'manager', managerUid: 'm1' } })).toBe(true);
  });
});

describe('run transition table', () => {
  function expectValidAlert(alert: AlertProjectionDelta) {
    expect(isValidAlertProjection(alert)).toBe(true);
  }

  test('invalid_payload run: errorClassification null, alert open (invalid_payload), permanently_unverifiable', () => {
    const result = computeRunTransition({ verdict: 'invalid_payload' });
    expect(result.errorClassification).toBeNull();
    expect(result.processingState).toBe('permanently_unverifiable');
    expect(result.settlementState).toBe('manual_review_required');
    expect(result.alert.alertState).toBe('open');
    expect(result.alert.reasonCode).toBe('invalid_payload');
    expectValidAlert(result.alert);
  });

  test('match without a prior alert: alertState none, provisional_match, errorClassification null', () => {
    const result = computeRunTransition({ verdict: 'match', prior: { alertState: 'none', acknowledgedByActor: null } });
    expect(result.errorClassification).toBeNull();
    expect(result.settlementState).toBe('provisional_match');
    expect(result.alert.alertState).toBe('none');
    expect(result.alert.reasonCode).toBeNull();
    expectValidAlert(result.alert);
  });

  test('match superseding a prior OPEN alert: resolved by system, reason superseding_match, no fabricated manager UID', () => {
    const result = computeRunTransition({ verdict: 'match', prior: { alertState: 'open', acknowledgedByActor: null } });
    expect(result.alert.alertState).toBe('resolved');
    expect(result.alert.reasonCode).toBe('superseding_match');
    expect(result.alert.resolvedByActor).toEqual({ kind: 'system' });
    expect(result.alert.acknowledgedByActor).toBeNull();
    expectValidAlert(result.alert);
  });

  test('match superseding a prior ACKNOWLEDGED alert: resolved by system, preserves the manager acknowledgement actor', () => {
    const managerActor = { kind: 'manager', managerUid: 'mgr-1' } as const;
    const result = computeRunTransition({ verdict: 'match', prior: { alertState: 'acknowledged', acknowledgedByActor: managerActor } });
    expect(result.alert.alertState).toBe('resolved');
    expect(result.alert.resolvedByActor).toEqual({ kind: 'system' });
    expect(result.alert.acknowledgedByActor).toEqual(managerActor);
    expectValidAlert(result.alert);
  });

  test('discrepancy / identity_mismatch: alert open with the matching reason, errorClassification null', () => {
    const discrepancy = computeRunTransition({ verdict: 'discrepancy' });
    expect(discrepancy.errorClassification).toBeNull();
    expect(discrepancy.alert.alertState).toBe('open');
    expect(discrepancy.alert.reasonCode).toBe('drawer_discrepancy');
    expectValidAlert(discrepancy.alert);

    const identity = computeRunTransition({ verdict: 'identity_mismatch' });
    expect(identity.errorClassification).toBeNull();
    expect(identity.alert.reasonCode).toBe('identity_mismatch');
    expectValidAlert(identity.alert);
  });

  test('source_limit_exceeded -> requires_operator_review / manual_review_required / alert open', () => {
    const result = computeRunTransition({ verdict: 'insufficient_evidence', cause: 'source_limit_exceeded' });
    expect(result.processingState).toBe('requires_operator_review');
    expect(result.settlementState).toBe('manual_review_required');
    expect(result.alert.alertState).toBe('open');
    expect(result.alert.reasonCode).toBe('source_limit_exceeded');
    expect(result.errorClassification).toBe('source_limit_exceeded');
    expectValidAlert(result.alert);
  });

  test('dependency_unavailable -> requires_operator_review / alert open', () => {
    const result = computeRunTransition({ verdict: 'insufficient_evidence', cause: 'dependency_unavailable' });
    expect(result.processingState).toBe('requires_operator_review');
    expect(result.alert.alertState).toBe('open');
    expect(result.alert.reasonCode).toBe('dependency_unavailable');
    expectValidAlert(result.alert);
  });

  test('cash_pair_value_mismatch -> requires_operator_review / alert open', () => {
    const result = computeRunTransition({ verdict: 'insufficient_evidence', cause: 'cash_pair_value_mismatch' });
    expect(result.processingState).toBe('requires_operator_review');
    expect(result.alert.reasonCode).toBe('cash_pair_value_mismatch');
    expectValidAlert(result.alert);
  });

  test('cash_entry_malformed -> permanently_unverifiable / alert open', () => {
    const result = computeRunTransition({ verdict: 'insufficient_evidence', cause: 'cash_entry_malformed' });
    expect(result.processingState).toBe('permanently_unverifiable');
    expect(result.alert.alertState).toBe('open');
    expect(result.alert.reasonCode).toBe('cash_entry_malformed');
    expectValidAlert(result.alert);
  });

  test('legacy_missing_required_field -> permanently_unverifiable / alert open', () => {
    const result = computeRunTransition({ verdict: 'insufficient_evidence', cause: 'legacy_missing_required_field' });
    expect(result.processingState).toBe('permanently_unverifiable');
    expect(result.alert.reasonCode).toBe('legacy_missing_required_field');
    expectValidAlert(result.alert);
  });

  test('no transition result represents final settlement or complete_proven', () => {
    const allResults = [
      computeRunTransition({ verdict: 'match', prior: { alertState: 'none', acknowledgedByActor: null } }),
      computeRunTransition({ verdict: 'discrepancy' }),
      computeRunTransition({ verdict: 'identity_mismatch' }),
      computeRunTransition({ verdict: 'invalid_payload' }),
      computeRunTransition({ verdict: 'insufficient_evidence', cause: 'source_limit_exceeded' }),
    ];
    for (const result of allResults) {
      expect(result.settlementState).not.toBe('complete_proven' as never);
      expect(result.processingState).not.toBe('complete_proven' as never);
    }
  });

  test('retry exhaustion: requires_operator_review, alert open (retry_exhausted), settlement explicitly unchanged', () => {
    const result = computeRetryExhaustionTransition();
    expect(result.processingState).toBe('requires_operator_review');
    expect(result.settlementUnchanged).toBe(true);
    expect(result.alert.alertState).toBe('open');
    expect(result.alert.reasonCode).toBe('retry_exhausted');
    expect(isValidAlertProjection(result.alert)).toBe(true);
  });

  test('manager resolution: resolved by manager actor, preserves prior acknowledgement, valid projection', () => {
    const priorAck = { kind: 'manager', managerUid: 'mgr-ack' } as const;
    const resolution = computeManagerResolution('mgr-resolve', 'drawer_discrepancy', priorAck);
    expect(resolution.alertState).toBe('resolved');
    expect(resolution.resolvedByActor).toEqual({ kind: 'manager', managerUid: 'mgr-resolve' });
    expect(resolution.acknowledgedByActor).toEqual(priorAck);
    expect(resolution.reasonCode).toBe('drawer_discrepancy');
    expect(isValidAlertProjection(resolution)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ordered cross-stream dedup / cursor advancement (P5-A R5 Defect 2 / §8.3).
// Cursor is keyed by the last CONSUMED case id; a removed/absent row never
// synthetically advances it.
// ---------------------------------------------------------------------------

function alwaysEligible(): EligibilityCheck {
  return { isEligible: () => true };
}

function eligibleExcept(excluded: ReadonlySet<CaseId>): EligibilityCheck {
  return { isEligible: (caseId) => !excluded.has(caseId) };
}

function completedProcessor(calls: CaseId[]): (caseId: CaseId) => DurableOutcome {
  return (caseId) => {
    calls.push(caseId);
    return { kind: 'completed' };
  };
}

describe('ordered cross-stream dedup / cursor advancement', () => {
  test('sweep A,B,C with trigger head C (dual-eligible): trigger processes C; sweep cursor stays before A; A and B are not skipped', () => {
    const triggerOrder: StreamOrder = { orderedCaseIds: ['C'] };
    const sweepOrder: StreamOrder = { orderedCaseIds: ['A', 'B', 'C'] };
    const cache = createInvocationResultCache();
    const triggerCalls: CaseId[] = [];
    const sweepCalls: CaseId[] = [];

    let triggerCursor: StreamCursor = initialStreamCursor();
    let sweepCursor: StreamCursor = initialStreamCursor();

    const triggerStep = stepStream({ order: triggerOrder, cursor: triggerCursor, eligibility: alwaysEligible(), cache, budgetAvailable: true, process: completedProcessor(triggerCalls) });
    triggerCursor = triggerStep.cursor;
    expect(triggerStep.processedCaseId).toBe('C');
    expect(triggerCursor.lastConsumedCaseId).toBe('C');

    // Sweep cursor is untouched by the trigger's processing of C — still at cycle start (before A).
    expect(sweepCursor.lastConsumedCaseId).toBeNull();

    const stepA = stepStream({ order: sweepOrder, cursor: sweepCursor, eligibility: alwaysEligible(), cache, budgetAvailable: true, process: completedProcessor(sweepCalls) });
    sweepCursor = stepA.cursor;
    expect(stepA.processedCaseId).toBe('A');
    expect(stepA.fromCache).toBe(false);

    const stepB = stepStream({ order: sweepOrder, cursor: sweepCursor, eligibility: alwaysEligible(), cache, budgetAvailable: true, process: completedProcessor(sweepCalls) });
    sweepCursor = stepB.cursor;
    expect(stepB.processedCaseId).toBe('B');

    const stepC = stepStream({ order: sweepOrder, cursor: sweepCursor, eligibility: alwaysEligible(), cache, budgetAvailable: true, process: completedProcessor(sweepCalls) });
    sweepCursor = stepC.cursor;
    expect(stepC.processedCaseId).toBe('C');
    expect(stepC.fromCache).toBe(true); // reused, not reprocessed — no duplicate worker run
    expect(sweepCalls).toEqual(['A', 'B']); // C never reprocessed by sweep
    expect(triggerCalls).toEqual(['C']);
  });

  test('both streams head the same case C: processed once, both cursors advance (each consumed its own head)', () => {
    const cache = createInvocationResultCache();
    const calls: CaseId[] = [];

    const triggerStep = stepStream({ order: { orderedCaseIds: ['C'] }, cursor: initialStreamCursor(), eligibility: alwaysEligible(), cache, budgetAvailable: true, process: completedProcessor(calls) });
    const sweepStep = stepStream({ order: { orderedCaseIds: ['C'] }, cursor: initialStreamCursor(), eligibility: alwaysEligible(), cache, budgetAvailable: true, process: completedProcessor(calls) });

    expect(triggerStep.cursor.lastConsumedCaseId).toBe('C');
    expect(sweepStep.cursor.lastConsumedCaseId).toBe('C');
    expect(calls).toEqual(['C']); // processed exactly once across both streams
    expect(sweepStep.fromCache).toBe(true);
  });

  test('cache hit reuse in the same invocation avoids duplicate processing', () => {
    const cache = createInvocationResultCache();
    const calls: CaseId[] = [];
    stepStream({ order: { orderedCaseIds: ['C'] }, cursor: initialStreamCursor(), eligibility: alwaysEligible(), cache, budgetAvailable: true, process: completedProcessor(calls) });
    const reuse = stepStream({ order: { orderedCaseIds: ['C'] }, cursor: initialStreamCursor(), eligibility: alwaysEligible(), cache, budgetAvailable: true, process: completedProcessor(calls) });
    expect(reuse.fromCache).toBe(true);
    expect(calls).toEqual(['C']);
  });

  test('removed before arrival: after consuming B, absent C does NOT become a cursor step — cursor stays at B (no synthetic advance)', () => {
    const triggerOrder: StreamOrder = { orderedCaseIds: ['C'] };
    const sweepOrder: StreamOrder = { orderedCaseIds: ['A', 'B', 'C'] };
    const cache = createInvocationResultCache();
    const triggerCalls: CaseId[] = [];
    const sweepCalls: CaseId[] = [];

    stepStream({ order: triggerOrder, cursor: initialStreamCursor(), eligibility: alwaysEligible(), cache, budgetAvailable: true, process: completedProcessor(triggerCalls) });

    // C's durable completion cleared its sweep eligibility before sweep arrives.
    const eligibility = eligibleExcept(new Set(['C']));

    let sweepCursor: StreamCursor = initialStreamCursor();
    const stepA = stepStream({ order: sweepOrder, cursor: sweepCursor, eligibility, cache, budgetAvailable: true, process: completedProcessor(sweepCalls) });
    sweepCursor = stepA.cursor;
    const stepB = stepStream({ order: sweepOrder, cursor: sweepCursor, eligibility, cache, budgetAvailable: true, process: completedProcessor(sweepCalls) });
    sweepCursor = stepB.cursor;
    const stepAfterC = stepStream({ order: sweepOrder, cursor: sweepCursor, eligibility, cache, budgetAvailable: true, process: completedProcessor(sweepCalls) });

    expect(sweepCalls).toEqual(['A', 'B']); // both processed; nothing skipped
    expect(stepAfterC.processedCaseId).toBeNull(); // C absent, nothing consumed
    expect(stepAfterC.exhausted).toBe(true);
    // The persisted cursor remains at the last RETURNED row (B), NOT advanced past absent C.
    expect(stepAfterC.cursor.lastConsumedCaseId).toBe('B');
    expect(stepAfterC.cursor).toEqual(sweepCursor);
  });

  test('a later returned D IS consumed and the cursor advances to D (never "through" the removed C)', () => {
    const order: StreamOrder = { orderedCaseIds: ['A', 'B', 'C', 'D'] };
    const cache = createInvocationResultCache();
    const calls: CaseId[] = [];
    const eligibility = eligibleExcept(new Set(['C'])); // C removed

    let cursor: StreamCursor = initialStreamCursor();
    cursor = stepStream({ order, cursor, eligibility, cache, budgetAvailable: true, process: completedProcessor(calls) }).cursor; // A
    cursor = stepStream({ order, cursor, eligibility, cache, budgetAvailable: true, process: completedProcessor(calls) }).cursor; // B
    const stepD = stepStream({ order, cursor, eligibility, cache, budgetAvailable: true, process: completedProcessor(calls) }); // skips absent C, consumes D
    expect(stepD.processedCaseId).toBe('D');
    expect(stepD.cursor.lastConsumedCaseId).toBe('D');
    expect(calls).toEqual(['A', 'B', 'D']); // C never processed, D consumed
  });

  test('budget stop: no cursor advances, no cache entry written', () => {
    const order: StreamOrder = { orderedCaseIds: ['A', 'B'] };
    const cache = createInvocationResultCache();
    const calls: CaseId[] = [];
    const cursor: StreamCursor = initialStreamCursor();

    const result = stepStream({ order, cursor, eligibility: alwaysEligible(), cache, budgetAvailable: false, process: completedProcessor(calls) });

    expect(result.cursor).toEqual(cursor);
    expect(result.processedCaseId).toBeNull();
    expect(result.exhausted).toBe(false); // stopped by budget, not exhaustion
    expect(calls).toEqual([]);
    expect(cache.size).toBe(0);
  });
});
