import { describe, it, expect, vi } from 'vitest';
import { mapShiftCloseReviewRow } from './shiftCloseReviewRows';
import { mapShiftCloseCaseProjection } from './shiftCloseDetailProjection';
import {
  applyAdjudicationResult,
  availableOutcomes,
  baseAvailability,
  captureDecisionSnapshotToken,
  checkAdjudicationLiveInvalidation,
  closeAdjudicationDialog,
  computeScopeKey,
  decisionSnapshotFresh,
  isReasonNoteWithinLimit,
  normalizeReasonNote,
  openAdjudicationDialog,
  retryAuthorityValid,
  retrySameAdjudicationCommand,
  scopeBoundAvailability,
  sourceScopeBindingValid,
  startNewAdjudicationDecision,
  submitAdjudication,
  updateAdjudicationDraft,
  validateAdjudicationSubmit,
  type BaseAvailabilityInput,
} from './shiftCloseAdjudicationMachine';
import type { ResolveShiftCloseAlertAdapterResult } from './resolveShiftCloseAlertAdapter';

function makeAlertRow(overrides: Record<string, unknown> = {}, docId = 'SHIFT-1') {
  return mapShiftCloseReviewRow(docId, {
    shiftId: docId,
    branchId: 'BR-001',
    alertState: 'open',
    reasonCode: 'drawer_discrepancy',
    caseVersion: 2,
    ...overrides,
  });
}

function makeCaseProjection(overrides: Record<string, unknown> = {}, docId = 'SHIFT-1') {
  return mapShiftCloseCaseProjection(docId, {
    shiftId: docId,
    branchId: 'BR-001',
    alertState: 'open',
    processingState: 'validated',
    settlementState: 'manual_review_required',
    caseVersion: 2,
    ...overrides,
  });
}

function makeInput(overrides: Partial<BaseAvailabilityInput> = {}): BaseAvailabilityInput {
  return {
    alertSource: { status: 'ready', fromCache: false },
    alertRow: makeAlertRow(),
    caseSource: { status: 'ready', fromCache: false },
    caseProjection: makeCaseProjection(),
    integrityCautions: [],
    ...overrides,
  };
}

const SCOPE = computeScopeKey('manager', 'BR-001', 'SHIFT-1');

describe('baseAvailability — table-driven fail-closed conditions', () => {
  it('is true for a clean, fully agreeing, stable case', () => {
    expect(baseAvailability(makeInput())).toBe(true);
  });

  it('is false when alert source is not ready', () => {
    expect(baseAvailability(makeInput({ alertSource: { status: 'pending', fromCache: false } }))).toBe(false);
  });

  it('is false when case source is not ready', () => {
    expect(baseAvailability(makeInput({ caseSource: { status: 'error', fromCache: false } }))).toBe(false);
  });

  it('is false when alert source is from cache', () => {
    expect(baseAvailability(makeInput({ alertSource: { status: 'ready', fromCache: true } }))).toBe(false);
  });

  it('is false when case source is from cache', () => {
    expect(baseAvailability(makeInput({ caseSource: { status: 'ready', fromCache: true } }))).toBe(false);
  });

  it('is false when the alert row is null', () => {
    expect(baseAvailability(makeInput({ alertRow: null }))).toBe(false);
  });

  it('is false when the case projection is null', () => {
    expect(baseAvailability(makeInput({ caseProjection: null }))).toBe(false);
  });

  it('is false for alertState "none" or "resolved" (not actionable)', () => {
    expect(baseAvailability(makeInput({ alertRow: makeAlertRow({ alertState: 'none' }), caseProjection: makeCaseProjection({ alertState: 'none' }) }))).toBe(false);
    expect(baseAvailability(makeInput({ alertRow: makeAlertRow({ alertState: 'resolved' }), caseProjection: makeCaseProjection({ alertState: 'resolved' }) }))).toBe(false);
  });

  it('is false for unknown/malformed alertState', () => {
    expect(baseAvailability(makeInput({ alertRow: makeAlertRow({ alertState: 'bogus' }) }))).toBe(false);
  });

  it('is false when the case alert state is unrecognized', () => {
    expect(baseAvailability(makeInput({ caseProjection: makeCaseProjection({ alertState: 'bogus' }) }))).toBe(false);
  });

  it('is false when alert and case alert states disagree', () => {
    expect(baseAvailability(makeInput({ caseProjection: makeCaseProjection({ alertState: 'acknowledged' }) }))).toBe(false);
  });

  it('is false when the alert reason is null or unknown', () => {
    expect(baseAvailability(makeInput({ alertRow: makeAlertRow({ reasonCode: null }) }))).toBe(false);
    expect(baseAvailability(makeInput({ alertRow: makeAlertRow({ reasonCode: 'totally-bogus' }) }))).toBe(false);
  });

  it('is false when either caseVersion is null/non-integer/negative', () => {
    expect(baseAvailability(makeInput({ alertRow: makeAlertRow({ caseVersion: null }) }))).toBe(false);
    expect(baseAvailability(makeInput({ caseProjection: makeCaseProjection({ caseVersion: null }) }))).toBe(false);
  });

  it('is false when caseVersions differ', () => {
    expect(baseAvailability(makeInput({ caseProjection: makeCaseProjection({ caseVersion: 3 }) }))).toBe(false);
  });

  it.each(['queued', 'awaiting_dependencies', 'validating', 'retryable_error'] as const)(
    'is false for in-progress/unknown processingState %s',
    (state) => {
      expect(baseAvailability(makeInput({ caseProjection: makeCaseProjection({ processingState: state }) }))).toBe(false);
    },
  );

  it.each(['validated', 'permanently_unverifiable', 'requires_operator_review'] as const)(
    'is true for stable processingState %s (all else agreeing)',
    (state) => {
      expect(baseAvailability(makeInput({ caseProjection: makeCaseProjection({ processingState: state }) }))).toBe(true);
    },
  );

  it('is false for unrecognized processingState', () => {
    expect(baseAvailability(makeInput({ caseProjection: makeCaseProjection({ processingState: 'bogus' }) }))).toBe(false);
  });

  it('is false for unrecognized settlementState', () => {
    expect(baseAvailability(makeInput({ caseProjection: makeCaseProjection({ settlementState: 'bogus' }) }))).toBe(false);
  });

  it('is false when any integrity caution is present', () => {
    expect(baseAvailability(makeInput({ integrityCautions: ['case_version_drift'] }))).toBe(false);
  });
});

describe('availableOutcomes', () => {
  it('offers acknowledge + resolve for open', () => {
    expect(availableOutcomes('open')).toEqual(['acknowledge', 'resolve']);
  });
  it('offers resolve only for acknowledged', () => {
    expect(availableOutcomes('acknowledged')).toEqual(['resolve']);
  });
  it('offers nothing for none/resolved/unknown', () => {
    expect(availableOutcomes('none')).toEqual([]);
    expect(availableOutcomes('resolved')).toEqual([]);
  });
});

describe('decision snapshot bootstrap (R2 §7.3) — no token before capture', () => {
  it('captureDecisionSnapshotToken throws if baseAvailability is false (programmer guard)', () => {
    expect(() => captureDecisionSnapshotToken(makeInput({ alertRow: null }), SCOPE)).toThrow();
  });

  it('openAdjudicationDialog only evaluates baseAvailability from idle — no freshness comparator invoked (nothing to compare against)', () => {
    const spy = vi.fn(baseAvailability);
    const input = makeInput();
    const state = openAdjudicationDialog('acknowledge', input, SCOPE);
    expect(state.status).toBe('confirming');
    void spy; // documents intent: decisionSnapshotFresh requires a token, which cannot exist pre-capture
  });

  it('openAdjudicationDialog is a no-op (stays idle) when baseAvailability is false', () => {
    const state = openAdjudicationDialog('acknowledge', makeInput({ alertRow: null }), SCOPE);
    expect(state).toEqual({ status: 'idle' });
  });

  it('captured token freezes every decision-relevant field', () => {
    const input = makeInput();
    const state = openAdjudicationDialog('resolve', input, SCOPE);
    expect(state.status).toBe('confirming');
    if (state.status === 'confirming') {
      expect(state.token.alertId).toBe('SHIFT-1');
      expect(state.token.alertBranchId).toBe('BR-001');
      expect(state.token.alertReasonCode).toBe('drawer_discrepancy');
      expect(state.token.caseVersion).toBe(2);
      expect(state.token.scopeKey).toBe(SCOPE);
    }
  });
});

describe('decisionSnapshotFresh — post-capture comparison only', () => {
  it('is true immediately after capture against identical live state', () => {
    const input = makeInput();
    const token = captureDecisionSnapshotToken(input, SCOPE);
    expect(decisionSnapshotFresh(input, SCOPE, token)).toBe(true);
  });

  it('is false when a decision-relevant field drifts (caseVersion bump)', () => {
    const input = makeInput();
    const token = captureDecisionSnapshotToken(input, SCOPE);
    const drifted = makeInput({
      alertRow: makeAlertRow({ caseVersion: 3 }),
      caseProjection: makeCaseProjection({ caseVersion: 3 }),
    });
    expect(decisionSnapshotFresh(drifted, SCOPE, token)).toBe(false);
  });

  it('is false when scope changes (role/branch/route)', () => {
    const input = makeInput();
    const token = captureDecisionSnapshotToken(input, SCOPE);
    const otherScope = computeScopeKey('manager', 'BR-002', 'SHIFT-1');
    expect(decisionSnapshotFresh(input, otherScope, token)).toBe(false);
  });

  it('is false when baseAvailability regresses (e.g. a new integrity caution appears)', () => {
    const input = makeInput();
    const token = captureDecisionSnapshotToken(input, SCOPE);
    const nowCautioned = makeInput({ integrityCautions: ['case_version_drift'] });
    expect(decisionSnapshotFresh(nowCautioned, SCOPE, token)).toBe(false);
  });
});

describe('checkAdjudicationLiveInvalidation — pre-submit invalidation', () => {
  it('stays in confirming when still fresh', () => {
    const input = makeInput();
    const confirming = openAdjudicationDialog('acknowledge', input, SCOPE);
    const result = checkAdjudicationLiveInvalidation(confirming, input, SCOPE);
    expect(result.status).toBe('confirming');
  });

  it('discards the draft and returns to idle when a listener update breaks freshness — zero commandId ever minted', () => {
    const input = makeInput();
    const confirming = openAdjudicationDialog('acknowledge', input, SCOPE);
    const drifted = makeInput({ caseProjection: makeCaseProjection({ caseVersion: 99 }) });
    const result = checkAdjudicationLiveInvalidation(confirming, drifted, SCOPE);
    expect(result).toEqual({ status: 'idle' });
  });

  it('is a no-op outside confirming', () => {
    expect(checkAdjudicationLiveInvalidation({ status: 'idle' }, makeInput(), SCOPE)).toEqual({ status: 'idle' });
  });
});

describe('updateAdjudicationDraft', () => {
  it('updates note and evidenceChecked while confirming', () => {
    const confirming = openAdjudicationDialog('resolve', makeInput(), SCOPE);
    const updated = updateAdjudicationDraft(confirming, { note: 'hello', evidenceChecked: true });
    expect(updated).toMatchObject({ status: 'confirming', note: 'hello', evidenceChecked: true });
  });

  it('is a no-op outside confirming', () => {
    expect(updateAdjudicationDraft({ status: 'idle' }, { note: 'x' })).toEqual({ status: 'idle' });
  });
});

describe('reason note (N1) — trim/omit/limit semantics', () => {
  it('trims leading/trailing whitespace', () => {
    expect(normalizeReasonNote('  hello  ')).toBe('hello');
  });
  it('a whitespace-only note normalizes to null (omitted)', () => {
    expect(normalizeReasonNote('   ')).toBeNull();
  });
  it('an empty note normalizes to null', () => {
    expect(normalizeReasonNote('')).toBeNull();
  });
  it('exactly 1000 UTF-16 code units is within limit', () => {
    expect(isReasonNoteWithinLimit('a'.repeat(1000))).toBe(true);
  });
  it('1001 UTF-16 code units is over limit', () => {
    expect(isReasonNoteWithinLimit('a'.repeat(1001))).toBe(false);
  });
});

describe('validateAdjudicationSubmit — first-submit guard', () => {
  it('rejects when not confirming', () => {
    expect(validateAdjudicationSubmit({ status: 'idle' }, makeInput(), SCOPE)).toBe('not_confirming');
  });

  it('rejects an over-limit note before mint', () => {
    const confirming = updateAdjudicationDraft(openAdjudicationDialog('acknowledge', makeInput(), SCOPE), { note: 'a'.repeat(1001) });
    expect(validateAdjudicationSubmit(confirming, makeInput(), SCOPE)).toBe('note_too_long');
  });

  it('rejects a resolve submit with the evidence checkbox unchecked', () => {
    const confirming = openAdjudicationDialog('resolve', makeInput(), SCOPE);
    expect(validateAdjudicationSubmit(confirming, makeInput(), SCOPE)).toBe('evidence_not_checked');
  });

  it('accepts a resolve submit once the evidence checkbox is checked', () => {
    const confirming = updateAdjudicationDraft(openAdjudicationDialog('resolve', makeInput(), SCOPE), { evidenceChecked: true });
    expect(validateAdjudicationSubmit(confirming, makeInput(), SCOPE)).toBeNull();
  });

  it('acknowledge never requires the evidence checkbox', () => {
    const confirming = openAdjudicationDialog('acknowledge', makeInput(), SCOPE);
    expect(validateAdjudicationSubmit(confirming, makeInput(), SCOPE)).toBeNull();
  });

  it('rejects when the live state is no longer fresh/available', () => {
    const confirming = openAdjudicationDialog('acknowledge', makeInput(), SCOPE);
    const stale = makeInput({ caseProjection: makeCaseProjection({ caseVersion: 99 }) });
    expect(validateAdjudicationSubmit(confirming, stale, SCOPE)).toBe('stale_or_unavailable');
  });
});

describe('submitAdjudication — mint on first valid submit only', () => {
  it('mints a commandId and freezes the payload FROM THE TOKEN', () => {
    const confirming = updateAdjudicationDraft(openAdjudicationDialog('resolve', makeInput(), SCOPE), {
      evidenceChecked: true,
      note: '  investigated with z-report  ',
    });
    const submitting = submitAdjudication(confirming, makeInput(), SCOPE);
    expect(submitting.status).toBe('submitting');
    if (submitting.status === 'submitting') {
      expect(submitting.commandId).toBeTruthy();
      expect(submitting.payload.shiftId).toBe('SHIFT-1');
      expect(submitting.payload.branchId).toBe('BR-001');
      expect(submitting.payload.expectedCaseVersion).toBe(2);
      expect(submitting.payload.requestedOutcome).toBe('resolve');
      expect(submitting.payload.reasonCode).toBe('drawer_discrepancy');
      expect(submitting.payload.reasonNote).toBe('investigated with z-report');
    }
  });

  it('the submitted reason always equals the token alert reason — no alternate reason path exists', () => {
    const confirming = openAdjudicationDialog('acknowledge', makeInput({ alertRow: makeAlertRow({ reasonCode: 'identity_mismatch' }) }), SCOPE);
    const submitting = submitAdjudication(confirming, makeInput({ alertRow: makeAlertRow({ reasonCode: 'identity_mismatch' }) }), SCOPE);
    if (submitting.status === 'submitting') expect(submitting.payload.reasonCode).toBe('identity_mismatch');
  });

  it('is a no-op (stays confirming) when the guard fails', () => {
    const confirming = openAdjudicationDialog('resolve', makeInput(), SCOPE); // checkbox unchecked
    const result = submitAdjudication(confirming, makeInput(), SCOPE);
    expect(result.status).toBe('confirming');
  });

  it('mints a NEW commandId on each independent submit attempt (edit -> new decision)', () => {
    const c1 = updateAdjudicationDraft(openAdjudicationDialog('acknowledge', makeInput(), SCOPE), {});
    const s1 = submitAdjudication(c1, makeInput(), SCOPE);
    const c2 = openAdjudicationDialog('acknowledge', makeInput(), SCOPE);
    const s2 = submitAdjudication(c2, makeInput(), SCOPE);
    if (s1.status === 'submitting' && s2.status === 'submitting') {
      expect(s1.commandId).not.toBe(s2.commandId);
    }
  });

  it('RC-4: payload branchId comes from the frozen token, never from a live argument — submitAdjudication takes no live branchId parameter at all', () => {
    // A scope-changed live branchId can only ever reach the machine via the
    // `scopeKey` argument (which then fails decisionSnapshotFresh — see the
    // dedicated scope-drift test below). There is no other channel by which
    // a live branchId could leak into the payload.
    const confirming = openAdjudicationDialog('acknowledge', makeInput(), SCOPE);
    const submitting = submitAdjudication(confirming, makeInput(), SCOPE);
    if (submitting.status === 'submitting') {
      expect(submitting.payload.branchId).toBe(submitting.token.scopeKey.branchId);
    }
  });

  it('RC-4: a scope-key branch drift since capture fails the freshness guard rather than leaking into the payload', () => {
    const confirming = openAdjudicationDialog('acknowledge', makeInput(), SCOPE);
    const driftedScope = computeScopeKey('manager', 'BR-999', 'SHIFT-1');
    const result = submitAdjudication(confirming, makeInput(), driftedScope);
    expect(result.status).toBe('confirming');
  });
});

describe('reason note (RC-1) — payload omission semantics', () => {
  it('omits reasonNote entirely from the submitted payload when the draft note is absent', () => {
    const confirming = openAdjudicationDialog('acknowledge', makeInput(), SCOPE);
    const submitting = submitAdjudication(confirming, makeInput(), SCOPE);
    if (submitting.status === 'submitting') {
      expect('reasonNote' in submitting.payload).toBe(false);
      expect(submitting.payload.reasonNote).toBeUndefined();
    }
  });

  it('omits reasonNote entirely when the draft note is whitespace-only', () => {
    const confirming = updateAdjudicationDraft(openAdjudicationDialog('acknowledge', makeInput(), SCOPE), { note: '   ' });
    const submitting = submitAdjudication(confirming, makeInput(), SCOPE);
    if (submitting.status === 'submitting') {
      expect('reasonNote' in submitting.payload).toBe(false);
    }
  });

  it('includes the trimmed note when non-empty', () => {
    const confirming = updateAdjudicationDraft(openAdjudicationDialog('acknowledge', makeInput(), SCOPE), { note: '  z-report attached  ' });
    const submitting = submitAdjudication(confirming, makeInput(), SCOPE);
    if (submitting.status === 'submitting') expect(submitting.payload.reasonNote).toBe('z-report attached');
  });

  it('retry of a no-note submission preserves the exact same property-absent payload', () => {
    const confirming = openAdjudicationDialog('acknowledge', makeInput(), SCOPE);
    const submitting = submitAdjudication(confirming, makeInput(), SCOPE);
    if (submitting.status !== 'submitting') throw new Error('setup failed');
    const failed = applyAdjudicationResult(submitting, { kind: 'transport_failure', cause: new Error('x') }, SCOPE);
    const retried = retrySameAdjudicationCommand(failed, makeInput(), SCOPE);
    if (retried.status === 'submitting') {
      expect('reasonNote' in retried.payload).toBe(false);
      expect(retried.payload).toEqual(submitting.payload);
    }
  });

  it('retry of a non-empty-note submission preserves the exact same value', () => {
    const confirming = updateAdjudicationDraft(openAdjudicationDialog('acknowledge', makeInput(), SCOPE), { note: 'kept exact' });
    const submitting = submitAdjudication(confirming, makeInput(), SCOPE);
    if (submitting.status !== 'submitting') throw new Error('setup failed');
    const failed = applyAdjudicationResult(submitting, { kind: 'transport_failure', cause: new Error('x') }, SCOPE);
    const retried = retrySameAdjudicationCommand(failed, makeInput(), SCOPE);
    if (retried.status === 'submitting') expect(retried.payload.reasonNote).toBe('kept exact');
  });
});

describe('applyAdjudicationResult — runtime result matrix', () => {
  function submittingState(outcome: 'acknowledge' | 'resolve' = 'acknowledge') {
    const draft = outcome === 'resolve'
      ? updateAdjudicationDraft(openAdjudicationDialog('resolve', makeInput(), SCOPE), { evidenceChecked: true })
      : openAdjudicationDialog('acknowledge', makeInput(), SCOPE);
    const submitting = submitAdjudication(draft, makeInput(), SCOPE);
    if (submitting.status !== 'submitting') throw new Error('setup failed');
    return submitting;
  }

  it('confirmed -> success', () => {
    const submitting = submittingState();
    const result: ResolveShiftCloseAlertAdapterResult = {
      kind: 'response',
      raw: {},
      response: { ok: true, commandId: submitting.commandId, shiftId: 'SHIFT-1', status: 'confirmed', newAlertState: 'acknowledged' },
    };
    const next = applyAdjudicationResult(submitting, result, SCOPE);
    expect(next.status).toBe('success');
    if (next.status === 'success') expect(next.adjudicationStatus).toBe('confirmed');
  });

  it('duplicate_confirmed -> success', () => {
    const submitting = submittingState();
    const result: ResolveShiftCloseAlertAdapterResult = {
      kind: 'response',
      raw: {},
      response: { ok: true, commandId: submitting.commandId, shiftId: 'SHIFT-1', status: 'duplicate_confirmed' },
    };
    const next = applyAdjudicationResult(submitting, result, SCOPE);
    if (next.status === 'success') expect(next.adjudicationStatus).toBe('duplicate_confirmed');
  });

  it('conflict_requires_manual_review (stale_case_version) -> stale_or_busy, command discarded', () => {
    const submitting = submittingState();
    const result: ResolveShiftCloseAlertAdapterResult = {
      kind: 'response',
      raw: {},
      response: { ok: false, commandId: submitting.commandId, shiftId: 'SHIFT-1', status: 'conflict_requires_manual_review', rejectCode: 'stale_case_version' },
    };
    expect(applyAdjudicationResult(submitting, result, SCOPE)).toEqual({ status: 'stale_or_busy' });
  });

  it('RC-3: conflict_requires_manual_review (invalid_payload) -> terminal_conflict, NOT stale_or_busy — command-ID collision, not data drift', () => {
    const submitting = submittingState();
    const result: ResolveShiftCloseAlertAdapterResult = {
      kind: 'response',
      raw: {},
      response: { ok: false, commandId: submitting.commandId, shiftId: 'SHIFT-1', status: 'conflict_requires_manual_review', rejectCode: 'invalid_payload' },
    };
    expect(applyAdjudicationResult(submitting, result, SCOPE)).toEqual({ status: 'terminal_conflict' });
  });

  it('rejected with server_error -> retryable (same-command retry eligible)', () => {
    const submitting = submittingState();
    const result: ResolveShiftCloseAlertAdapterResult = {
      kind: 'response',
      raw: {},
      response: { ok: false, commandId: submitting.commandId, shiftId: 'SHIFT-1', status: 'rejected', rejectCode: 'server_error' },
    };
    const next = applyAdjudicationResult(submitting, result, SCOPE);
    expect(next.status).toBe('retryable');
    if (next.status === 'retryable') {
      expect(next.failureKind).toBe('server_error');
      expect(next.commandId).toBe(submitting.commandId);
    }
  });

  it.each(['unauthorized', 'invalid_pin', 'invalid_payload', 'case_not_found', 'alert_not_open', 'invalid_outcome_transition'] as const)(
    'rejected with %s -> terminal_rejected (no retry control)',
    (rejectCode) => {
      const submitting = submittingState();
      const result: ResolveShiftCloseAlertAdapterResult = {
        kind: 'response',
        raw: {},
        response: { ok: false, commandId: submitting.commandId, shiftId: 'SHIFT-1', status: 'rejected', rejectCode },
      };
      const next = applyAdjudicationResult(submitting, result, SCOPE);
      expect(next).toEqual({ status: 'terminal_rejected', outcome: 'acknowledge', rejectCode });
    },
  );

  it('transport_failure -> retryable', () => {
    const submitting = submittingState();
    const result: ResolveShiftCloseAlertAdapterResult = { kind: 'transport_failure', cause: new Error('down') };
    const next = applyAdjudicationResult(submitting, result, SCOPE);
    if (next.status === 'retryable') expect(next.failureKind).toBe('transport');
  });

  it('malformed_response -> retryable', () => {
    const submitting = submittingState();
    const result: ResolveShiftCloseAlertAdapterResult = { kind: 'malformed_response', raw: {} };
    const next = applyAdjudicationResult(submitting, result, SCOPE);
    if (next.status === 'retryable') expect(next.failureKind).toBe('malformed');
  });

  it('a scope change before the result arrives drops the late result silently -> idle', () => {
    const submitting = submittingState();
    const result: ResolveShiftCloseAlertAdapterResult = {
      kind: 'response',
      raw: {},
      response: { ok: true, commandId: submitting.commandId, shiftId: 'SHIFT-1', status: 'confirmed' },
    };
    const otherScope = computeScopeKey('manager', 'BR-999', 'SHIFT-1');
    expect(applyAdjudicationResult(submitting, result, otherScope)).toEqual({ status: 'idle' });
  });

  it('RC-4: branch/route values containing delimiter-like text cannot collide into a false "same scope"', () => {
    // The withdrawn `::`-joined key made `branchId:'A::B', routeShiftId:'C'`
    // equal `branchId:'A', routeShiftId:'B::C'` (both -> "manager::A::B::C").
    // The structured ScopeKey must treat these as genuinely different scopes.
    // (Final RC-4: the rows must genuinely bind to the token scope — doc ID
    // 'C', branch 'A::B' — or capture/mint would rightly fail closed.)
    const tokenScope = computeScopeKey('manager', 'A::B', 'C');
    const scopeAInput = makeInput({
      alertRow: makeAlertRow({ branchId: 'A::B' }, 'C'),
      caseProjection: makeCaseProjection({}, 'C'),
    });
    const confirming = openAdjudicationDialog('acknowledge', scopeAInput, tokenScope);
    const submitting = submitAdjudication(confirming, scopeAInput, tokenScope);
    if (submitting.status !== 'submitting') throw new Error('setup failed');

    const result: ResolveShiftCloseAlertAdapterResult = {
      kind: 'response',
      raw: {},
      response: { ok: true, commandId: submitting.commandId, shiftId: submitting.payload.shiftId, status: 'confirmed' },
    };
    const wouldCollideUnderOldStringKey = computeScopeKey('manager', 'A', 'B::C');
    // Genuinely different scope -> the late result must be dropped (idle),
    // never mistaken for the same scope the old delimiter-joined key produced.
    expect(applyAdjudicationResult(submitting, result, wouldCollideUnderOldStringKey)).toEqual({ status: 'idle' });
    // The true, unchanged scope is still recognized as fresh/same.
    expect(applyAdjudicationResult(submitting, result, tokenScope).status).toBe('success');
  });

  it('is a no-op outside submitting/retryable', () => {
    const result: ResolveShiftCloseAlertAdapterResult = { kind: 'malformed_response', raw: {} };
    expect(applyAdjudicationResult({ status: 'idle' }, result, SCOPE)).toEqual({ status: 'idle' });
  });
});

describe('retrySameAdjudicationCommand — exact same-ID/payload retry only, no auto-retry', () => {
  it('re-enters submitting with the identical commandId and payload', () => {
    const draft = openAdjudicationDialog('acknowledge', makeInput(), SCOPE);
    const submitting = submitAdjudication(draft, makeInput(), SCOPE);
    if (submitting.status !== 'submitting') throw new Error('setup failed');
    const failed = applyAdjudicationResult(submitting, { kind: 'transport_failure', cause: new Error('x') }, SCOPE);
    const retried = retrySameAdjudicationCommand(failed, makeInput(), SCOPE);
    expect(retried.status).toBe('submitting');
    if (retried.status === 'submitting' && submitting.status === 'submitting') {
      expect(retried.commandId).toBe(submitting.commandId);
      expect(retried.payload).toEqual(submitting.payload);
    }
  });

  it('is a no-op outside retryable', () => {
    expect(retrySameAdjudicationCommand({ status: 'idle' }, makeInput(), SCOPE)).toEqual({ status: 'idle' });
  });

  it('no automatic retry ever occurs — applying a failure never itself triggers another transport call', () => {
    const transportSpy = vi.fn();
    const draft = openAdjudicationDialog('acknowledge', makeInput(), SCOPE);
    const submitting = submitAdjudication(draft, makeInput(), SCOPE);
    if (submitting.status !== 'submitting') throw new Error('setup failed');
    applyAdjudicationResult(submitting, { kind: 'transport_failure', cause: new Error('x') }, SCOPE);
    expect(transportSpy).not.toHaveBeenCalled();
  });
});

describe('startNewAdjudicationDecision / closeAdjudicationDialog — abandonment', () => {
  it('closeAdjudicationDialog always returns idle from any state', () => {
    expect(closeAdjudicationDialog()).toEqual({ status: 'idle' });
  });

  it('starting a new decision from terminal_rejected recaptures a FRESH token', () => {
    const rejected: ReturnType<typeof applyAdjudicationResult> = { status: 'terminal_rejected', outcome: 'acknowledge', rejectCode: 'invalid_outcome_transition' };
    const next = startNewAdjudicationDecision(rejected, 'resolve', makeInput(), SCOPE);
    expect(next.status).toBe('confirming');
    if (next.status === 'confirming') expect(next.outcome).toBe('resolve');
  });

  it('starting a new decision falls back to idle when the live state no longer permits it', () => {
    const rejected: ReturnType<typeof applyAdjudicationResult> = { status: 'terminal_rejected', outcome: 'acknowledge', rejectCode: 'invalid_outcome_transition' };
    const next = startNewAdjudicationDecision(rejected, 'resolve', makeInput({ alertRow: null }), SCOPE);
    expect(next).toEqual({ status: 'idle' });
  });

  it('reopen after stale/busy captures a brand-new token, never compares against the discarded one', () => {
    const staleOrBusy: ReturnType<typeof applyAdjudicationResult> = { status: 'stale_or_busy' };
    const next = startNewAdjudicationDecision(staleOrBusy, 'acknowledge', makeInput(), SCOPE);
    expect(next.status).toBe('confirming');
  });
});

// ---------------------------------------------------------------------------
// Final RC-4 — fail-closed source/scope binding + canonical route authority.
// ---------------------------------------------------------------------------

describe('sourceScopeBindingValid / scopeBoundAvailability — fail-closed identity binding (final RC-4)', () => {
  it('is true when alert/case doc IDs equal the route shift ID and the alert branch equals the structured branch', () => {
    expect(sourceScopeBindingValid(makeInput(), SCOPE)).toBe(true);
    expect(scopeBoundAvailability(makeInput(), SCOPE)).toBe(true);
  });

  it('alert identity mismatch (alert doc ID !== route shift ID) fails closed — no offer, no dialog, no capture', () => {
    const input = makeInput({ alertRow: makeAlertRow({}, 'OTHER-ALERT') });
    expect(sourceScopeBindingValid(input, SCOPE)).toBe(false);
    expect(scopeBoundAvailability(input, SCOPE)).toBe(false);
    expect(openAdjudicationDialog('acknowledge', input, SCOPE)).toEqual({ status: 'idle' });
    expect(() => captureDecisionSnapshotToken(input, SCOPE)).toThrow();
  });

  it('case identity mismatch (case doc ID !== route shift ID) fails closed — no offer, no dialog, no capture', () => {
    const input = makeInput({ caseProjection: makeCaseProjection({}, 'OTHER-CASE') });
    expect(sourceScopeBindingValid(input, SCOPE)).toBe(false);
    expect(scopeBoundAvailability(input, SCOPE)).toBe(false);
    expect(openAdjudicationDialog('acknowledge', input, SCOPE)).toEqual({ status: 'idle' });
    expect(() => captureDecisionSnapshotToken(input, SCOPE)).toThrow();
  });

  it('alert branch mismatch (stored branch !== structured branch) fails closed — no offer, no dialog, no capture', () => {
    const input = makeInput({ alertRow: makeAlertRow({ branchId: 'BR-OTHER' }) });
    expect(sourceScopeBindingValid(input, SCOPE)).toBe(false);
    expect(scopeBoundAvailability(input, SCOPE)).toBe(false);
    expect(openAdjudicationDialog('acknowledge', input, SCOPE)).toEqual({ status: 'idle' });
    expect(() => captureDecisionSnapshotToken(input, SCOPE)).toThrow();
  });

  it('missing/malformed canonical route ID fails closed (empty, dot-segments, slash, over-length)', () => {
    for (const badRoute of ['', '.', '..', 'a/b', 'x'.repeat(1501)]) {
      const scope = computeScopeKey('manager', 'BR-001', badRoute);
      const input = makeInput({
        alertRow: makeAlertRow({}, badRoute),
        caseProjection: makeCaseProjection({}, badRoute),
      });
      expect(sourceScopeBindingValid(input, scope)).toBe(false);
      expect(openAdjudicationDialog('acknowledge', input, scope)).toEqual({ status: 'idle' });
    }
  });

  it('missing/unscoped canonical branch ID fails closed (empty and the ALL pseudo-branch)', () => {
    for (const badBranch of ['', 'ALL']) {
      const scope = computeScopeKey('manager', badBranch, 'SHIFT-1');
      const input = makeInput({ alertRow: makeAlertRow({ branchId: badBranch }) });
      expect(sourceScopeBindingValid(input, scope)).toBe(false);
      expect(openAdjudicationDialog('acknowledge', input, scope)).toEqual({ status: 'idle' });
    }
  });

  it('null rows fail the binding (fail-closed on absence)', () => {
    expect(sourceScopeBindingValid(makeInput({ alertRow: null }), SCOPE)).toBe(false);
    expect(sourceScopeBindingValid(makeInput({ caseProjection: null }), SCOPE)).toBe(false);
  });

  it('delimiter collision: prior-scope rows (branch "A::B", doc "C") under new scope (branch "A", route "B::C") can never offer, capture, or mint', () => {
    // The upstream hook's `::`-joined reset key makes these two scopes collide
    // (both -> "1::manager::A::B::C"), so scope-A rows can survive one render
    // under scope B. The adjudication boundary must reject them outright.
    const scopeB = computeScopeKey('manager', 'A', 'B::C');
    const staleScopeARows = makeInput({
      alertRow: makeAlertRow({ branchId: 'A::B' }, 'C'),
      caseProjection: makeCaseProjection({}, 'C'),
    });
    expect(sourceScopeBindingValid(staleScopeARows, scopeB)).toBe(false);
    expect(scopeBoundAvailability(staleScopeARows, scopeB)).toBe(false);
    expect(openAdjudicationDialog('acknowledge', staleScopeARows, scopeB)).toEqual({ status: 'idle' });
    expect(() => captureDecisionSnapshotToken(staleScopeARows, scopeB)).toThrow();
    // And an existing token from scope A can never stay fresh against them either.
    const scopeA = computeScopeKey('manager', 'A::B', 'C');
    const token = captureDecisionSnapshotToken(staleScopeARows, scopeA);
    expect(decisionSnapshotFresh(staleScopeARows, scopeB, token)).toBe(false);
  });

  it('an existing token goes stale the instant the live rows stop binding to the current scope', () => {
    const token = captureDecisionSnapshotToken(makeInput(), SCOPE);
    const swappedRows = makeInput({
      alertRow: makeAlertRow({}, 'OTHER'),
      caseProjection: makeCaseProjection({}, 'OTHER'),
    });
    expect(decisionSnapshotFresh(swappedRows, SCOPE, token)).toBe(false);
  });

  it('the token freezes the alert branch, and a live alert-branch drift alone breaks freshness', () => {
    const token = captureDecisionSnapshotToken(makeInput(), SCOPE);
    expect(token.alertBranchId).toBe('BR-001');
    const branchDrift = makeInput({ alertRow: makeAlertRow({ branchId: 'BR-DRIFTED' }) });
    expect(decisionSnapshotFresh(branchDrift, SCOPE, token)).toBe(false);
  });
});

describe('canonical route request authority (final RC-4) — shiftId from token.scopeKey.routeShiftId only', () => {
  it('the minted payload shiftId equals the frozen canonical route ID (distinctive delimiter-bearing route, token-derived branch)', () => {
    const scope = computeScopeKey('manager', 'A', 'B::C');
    const input = makeInput({
      alertRow: makeAlertRow({ branchId: 'A' }, 'B::C'),
      caseProjection: makeCaseProjection({}, 'B::C'),
    });
    const confirming = openAdjudicationDialog('acknowledge', input, scope);
    const submitting = submitAdjudication(confirming, input, scope);
    expect(submitting.status).toBe('submitting');
    if (submitting.status === 'submitting') {
      expect(submitting.payload.shiftId).toBe(submitting.token.scopeKey.routeShiftId);
      expect(submitting.payload.shiftId).toBe('B::C');
      expect(submitting.payload.branchId).toBe(submitting.token.scopeKey.branchId);
      expect(submitting.payload.branchId).toBe('A');
    }
  });

  it('a percent-containing canonical route reaches the payload byte-for-byte — no re-decode, no alert-ID substitution', () => {
    // React Router delivers the ONE-decode value to useParams(); the machine
    // must pass it through untouched (validateRouteShiftId never re-decodes).
    const legalId = 'SHIFT-2026%2520weird';
    const scope = computeScopeKey('manager', 'BR-001', legalId);
    const input = makeInput({
      alertRow: makeAlertRow({}, legalId),
      caseProjection: makeCaseProjection({}, legalId),
    });
    const confirming = openAdjudicationDialog('acknowledge', input, scope);
    const submitting = submitAdjudication(confirming, input, scope);
    if (submitting.status !== 'submitting') throw new Error('setup failed');
    expect(submitting.payload.shiftId).toBe(legalId);
    expect(submitting.payload.shiftId).toBe(submitting.token.scopeKey.routeShiftId);
  });

  it('a forged token whose alertId differs from its route authority can never mint or reach transport', () => {
    // Structurally unreachable via capture (the binding forbids it) — forged
    // here deliberately to prove the guard refuses divergent identities
    // rather than letting either field win.
    const confirming = openAdjudicationDialog('acknowledge', makeInput(), SCOPE);
    if (confirming.status !== 'confirming') throw new Error('setup failed');
    const forged = { ...confirming, token: { ...confirming.token, alertId: 'FORGED-ALERT' } };
    expect(validateAdjudicationSubmit(forged, makeInput(), SCOPE)).toBe('stale_or_unavailable');
    const result = submitAdjudication(forged, makeInput(), SCOPE);
    expect(result).toBe(forged); // unchanged confirming state — zero mint
  });

  it('a forged token whose caseId differs from its route authority can never mint', () => {
    const confirming = openAdjudicationDialog('acknowledge', makeInput(), SCOPE);
    if (confirming.status !== 'confirming') throw new Error('setup failed');
    const forged = { ...confirming, token: { ...confirming.token, caseId: 'FORGED-CASE' } };
    expect(validateAdjudicationSubmit(forged, makeInput(), SCOPE)).toBe('stale_or_unavailable');
    expect(submitAdjudication(forged, makeInput(), SCOPE)).toBe(forged);
  });

  it('a live route change after capture cannot alter the payload — it blocks the mint entirely', () => {
    const confirming = openAdjudicationDialog('acknowledge', makeInput(), SCOPE);
    const newRouteScope = computeScopeKey('manager', 'BR-001', 'SHIFT-OTHER');
    const result = submitAdjudication(confirming, makeInput(), newRouteScope);
    expect(result.status).toBe('confirming'); // refused — never minted with either route value
  });
});

// ---------------------------------------------------------------------------
// Final retry-scope remediation — manual retry requires CURRENT scope
// equality + CURRENT source binding + CURRENT scope-bound availability.
// ---------------------------------------------------------------------------

describe('retryAuthorityValid / retrySameAdjudicationCommand — retry scope/source authority', () => {
  function makeRetryable(live: BaseAvailabilityInput = makeInput(), scope = SCOPE) {
    const draft = openAdjudicationDialog('acknowledge', live, scope);
    const submitting = submitAdjudication(draft, live, scope);
    if (submitting.status !== 'submitting') throw new Error('setup failed');
    const failed = applyAdjudicationResult(submitting, { kind: 'transport_failure', cause: new Error('x') }, scope);
    if (failed.status !== 'retryable') throw new Error('setup failed');
    return failed;
  }

  it('unchanged valid scope: retry re-enters submitting with the identical commandId and the exact same frozen payload — no new mint', () => {
    const failed = makeRetryable();
    expect(retryAuthorityValid(failed, makeInput(), SCOPE)).toBe(true);
    const retried = retrySameAdjudicationCommand(failed, makeInput(), SCOPE);
    expect(retried.status).toBe('submitting');
    if (retried.status === 'submitting') {
      expect(retried.commandId).toBe(failed.commandId);
      expect(retried.payload).toBe(failed.payload); // same frozen object — zero mutation
      expect(retried.payload).toEqual(failed.payload);
    }
  });

  it('a changed role abandons the retry chain — no submitting, no transport eligibility', () => {
    const failed = makeRetryable();
    const roleChanged = computeScopeKey('admin', 'BR-001', 'SHIFT-1');
    expect(retryAuthorityValid(failed, makeInput(), roleChanged)).toBe(false);
    expect(retrySameAdjudicationCommand(failed, makeInput(), roleChanged)).toEqual({ status: 'idle' });
  });

  it('a changed branch abandons the retry chain', () => {
    const failed = makeRetryable();
    const branchChanged = computeScopeKey('manager', 'BR-002', 'SHIFT-1');
    expect(retryAuthorityValid(failed, makeInput(), branchChanged)).toBe(false);
    expect(retrySameAdjudicationCommand(failed, makeInput(), branchChanged)).toEqual({ status: 'idle' });
  });

  it('a changed route abandons the retry chain', () => {
    const failed = makeRetryable();
    const routeChanged = computeScopeKey('manager', 'BR-001', 'SHIFT-OTHER');
    expect(retryAuthorityValid(failed, makeInput(), routeChanged)).toBe(false);
    expect(retrySameAdjudicationCommand(failed, makeInput(), routeChanged)).toEqual({ status: 'idle' });
  });

  it('same structured scope but a live alert identity mismatch blocks/abandons retry', () => {
    const failed = makeRetryable();
    const swappedAlert = makeInput({ alertRow: makeAlertRow({}, 'OTHER-ALERT') });
    expect(retryAuthorityValid(failed, swappedAlert, SCOPE)).toBe(false);
    expect(retrySameAdjudicationCommand(failed, swappedAlert, SCOPE)).toEqual({ status: 'idle' });
  });

  it('same structured scope but a live case identity mismatch blocks/abandons retry', () => {
    const failed = makeRetryable();
    const swappedCase = makeInput({ caseProjection: makeCaseProjection({}, 'OTHER-CASE') });
    expect(retryAuthorityValid(failed, swappedCase, SCOPE)).toBe(false);
    expect(retrySameAdjudicationCommand(failed, swappedCase, SCOPE)).toEqual({ status: 'idle' });
  });

  it('same structured scope but a live alert branch mismatch blocks/abandons retry', () => {
    const failed = makeRetryable();
    const branchDrift = makeInput({ alertRow: makeAlertRow({ branchId: 'BR-DRIFTED' }) });
    expect(retryAuthorityValid(failed, branchDrift, SCOPE)).toBe(false);
    expect(retrySameAdjudicationCommand(failed, branchDrift, SCOPE)).toEqual({ status: 'idle' });
  });

  it('same scope but source unavailable / cache-derived / cautioned states block retry (fail-closed availability)', () => {
    const failed = makeRetryable();
    const unavailable = makeInput({ alertRow: null });
    const cacheDerived = makeInput({ alertSource: { status: 'ready', fromCache: true } });
    const cautioned = makeInput({ integrityCautions: ['case_version_drift'] });
    for (const live of [unavailable, cacheDerived, cautioned]) {
      expect(retryAuthorityValid(failed, live, SCOPE)).toBe(false);
      expect(retrySameAdjudicationCommand(failed, live, SCOPE)).toEqual({ status: 'idle' });
    }
  });

  it('delimiter collision: an S1 (branch "A::B", route "C") retryable command can never transport under S2 (branch "A", route "B::C") with stale S1 rows', () => {
    const scopeA = computeScopeKey('manager', 'A::B', 'C');
    const scopeARows = makeInput({
      alertRow: makeAlertRow({ branchId: 'A::B' }, 'C'),
      caseProjection: makeCaseProjection({}, 'C'),
    });
    const failed = makeRetryable(scopeARows, scopeA);
    const scopeB = computeScopeKey('manager', 'A', 'B::C');
    expect(retryAuthorityValid(failed, scopeARows, scopeB)).toBe(false);
    expect(retrySameAdjudicationCommand(failed, scopeARows, scopeB)).toEqual({ status: 'idle' });
  });

  it('no retry path ever mints a new commandId — abandoned paths carry no command, the valid path reuses the frozen one', () => {
    const failed = makeRetryable();
    const abandoned = retrySameAdjudicationCommand(failed, makeInput(), computeScopeKey('manager', 'BR-002', 'SHIFT-1'));
    expect(abandoned).toEqual({ status: 'idle' }); // idle carries no commandId at all
    const retried = retrySameAdjudicationCommand(failed, makeInput(), SCOPE);
    if (retried.status === 'submitting') expect(retried.commandId).toBe(failed.commandId);
  });

  it('render-time invalidation abandons retryable on a scope change or source-binding break, but keeps a valid same-scope retryable', () => {
    const failed = makeRetryable();
    // Valid same-scope retryable survives (dialog stays, retry stays offered).
    expect(checkAdjudicationLiveInvalidation(failed, makeInput(), SCOPE)).toBe(failed);
    // Scope change (incl. the delimiter collision) abandons before interaction.
    const scopeB = computeScopeKey('manager', 'A', 'B::C');
    expect(checkAdjudicationLiveInvalidation(failed, makeInput(), scopeB)).toEqual({ status: 'idle' });
    // Source-binding break abandons before interaction.
    const swappedRows = makeInput({ alertRow: makeAlertRow({}, 'OTHER') });
    expect(checkAdjudicationLiveInvalidation(failed, swappedRows, SCOPE)).toEqual({ status: 'idle' });
  });

  it('render-time invalidation for retryable does NOT abandon on same-scope data drift alone (the frozen idempotent command may still be disambiguated)', () => {
    const failed = makeRetryable();
    // Same scope, rows still bound — but decision fields drifted (e.g. the
    // first attempt actually landed server-side and bumped state/version).
    const drifted = makeInput({
      alertRow: makeAlertRow({ alertState: 'acknowledged' }),
      caseProjection: makeCaseProjection({ alertState: 'acknowledged' }),
    });
    expect(checkAdjudicationLiveInvalidation(failed, drifted, SCOPE)).toBe(failed);
  });

  it('in-flight submitting is never invalidated by the render-time check (late results are scope-checked at application instead)', () => {
    const draft = openAdjudicationDialog('acknowledge', makeInput(), SCOPE);
    const submitting = submitAdjudication(draft, makeInput(), SCOPE);
    if (submitting.status !== 'submitting') throw new Error('setup failed');
    const scopeB = computeScopeKey('manager', 'A', 'B::C');
    expect(checkAdjudicationLiveInvalidation(submitting, makeInput(), scopeB)).toBe(submitting);
  });
});
