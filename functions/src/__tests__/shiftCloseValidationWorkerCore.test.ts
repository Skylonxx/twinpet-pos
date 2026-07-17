import { describe, test, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import {
  StopStreamUnowned,
  hasPendingWork,
  isRecheckEligible,
  decideT1Lease,
  evaluateT3Gates,
  decideQ7Recovery,
  classifyWorkerFailure,
  computeBackoffMillis,
  buildCategoryAOutcome,
  buildCategoryDOutcome,
  compareRecheckDigest,
  buildRecheckEqualCaseUpdate,
  computeFoldSummaryDigest,
  computeCreditDebtReceiptsObservedDigest,
  computeInputsDigestAtRevision,
  truncateManifestForPayloadGuard,
  buildSourceManifest,
  decideValidationVerdict,
  validateAlertInvariants,
  validateStoredOpenedAt,
  computeOpenedAtWrite,
  buildRunId,
  buildRunFields,
  buildSelectionCaseUpdate,
  computeP5DAuditEventId,
  canAdmitAnotherCase,
  RUN_PAYLOAD_GUARD_BYTES,
  MAX_REVALIDATION_ATTEMPTS,
  RECHECK_INTERVAL_MS,
  type T1CaseSnapshot,
  type T3CaseSnapshot,
  type Q7CaseSnapshot,
  type AlertInvariantCaseView,
  type AlertInvariantAlertView,
  type CreditDebtReceiptsObserved,
} from '../shiftCloseValidationWorkerCore';
import { foldDeviceScopedDrawer } from '../shiftCloseValidationDrawerFold';
import type { SourceManifestDoc, SourceManifestCapReachedBySource } from '../shiftCloseValidationTypes';

const NO_CAP: SourceManifestCapReachedBySource = {
  asyncOrders: false,
  cashTransactions: false,
  creditPayments: false,
  orders: false,
};

// ---------------------------------------------------------------------------
// T1 pre-ownership
// ---------------------------------------------------------------------------

describe('hasPendingWork', () => {
  test('pendingRevalidation true -> pending', () => {
    expect(hasPendingWork({ pendingRevalidation: true, selectedCloseHash: 'h', latestCloseHash: 'h' })).toBe(true);
  });
  test('selectedCloseHash !== latestCloseHash -> pending (incl. initial null)', () => {
    expect(hasPendingWork({ pendingRevalidation: false, selectedCloseHash: null, latestCloseHash: 'h' })).toBe(true);
  });
  test('both false/equal -> not pending', () => {
    expect(hasPendingWork({ pendingRevalidation: false, selectedCloseHash: 'h', latestCloseHash: 'h' })).toBe(false);
  });
});

function t1Case(overrides: Partial<T1CaseSnapshot> = {}): T1CaseSnapshot {
  return {
    pendingRevalidation: true,
    selectedCloseHash: null,
    latestCloseHash: 'hash-1',
    leaseOwner: null,
    leaseExpiryMillis: null,
    nextEligibleAtMillis: 0,
    caseVersion: 1,
    sourceRevision: 1,
    sweepEligible: false,
    selectedRunId: null,
    ...overrides,
  };
}

describe('decideT1Lease', () => {
  test('no pending work -> not_admissible, zero write', () => {
    const result = decideT1Lease({
      case: t1Case({ pendingRevalidation: false, selectedCloseHash: 'hash-1' }),
      nowMillis: 1000,
      invocationId: 'inv-1',
    });
    expect(result).toEqual({ kind: 'not_admissible' });
  });

  test('nextEligibleAt in the future -> not_admissible', () => {
    const result = decideT1Lease({ case: t1Case({ nextEligibleAtMillis: 5000 }), nowMillis: 1000, invocationId: 'inv-1' });
    expect(result).toEqual({ kind: 'not_admissible' });
  });

  test('live unexpired lease -> skip_live_owner, zero write', () => {
    const result = decideT1Lease({
      case: t1Case({ leaseOwner: 'other', leaseExpiryMillis: 5000 }),
      nowMillis: 1000,
      invocationId: 'inv-1',
    });
    expect(result).toEqual({ kind: 'skip_live_owner' });
  });

  test('expired lease is free -> acquire', () => {
    const result = decideT1Lease({
      case: t1Case({ leaseOwner: 'other', leaseExpiryMillis: 500, caseVersion: 3 }),
      nowMillis: 1000,
      invocationId: 'inv-1',
    });
    expect(result.kind).toBe('acquire');
    if (result.kind === 'acquire') {
      expect(result.caseUpdate.leaseOwner).toBe('inv-1');
      expect(result.caseUpdate.processingState).toBe('validating');
      expect(result.caseUpdate.caseVersion).toBe(4);
      expect(result.expectedCaseVersion).toBe(4);
    }
  });

  test('null lease -> acquire; exactly one durable lease acquisition, no attempt increment field present', () => {
    const result = decideT1Lease({ case: t1Case({ caseVersion: 1 }), nowMillis: 1000, invocationId: 'inv-1' });
    expect(result.kind).toBe('acquire');
    if (result.kind === 'acquire') {
      expect(Object.keys(result.caseUpdate)).not.toContain('revalidationAttempts');
      expect(result.isRecheck).toBe(false);
    }
  });

  // ── B3/GD9 sweep-recheck admission (resting selection, no pending work) ──
  describe('recheck-only admission (isRecheckEligible)', () => {
    function restingCase(overrides: Partial<T1CaseSnapshot> = {}): T1CaseSnapshot {
      return t1Case({
        pendingRevalidation: false,
        selectedCloseHash: 'hash-1',
        latestCloseHash: 'hash-1',
        sweepEligible: true,
        selectedRunId: 'run-1',
        ...overrides,
      });
    }

    test('resting selection, sweepEligible, due -> acquire with isRecheck:true', () => {
      const result = decideT1Lease({ case: restingCase(), nowMillis: 1000, invocationId: 'inv-1' });
      expect(result.kind).toBe('acquire');
      if (result.kind === 'acquire') {
        expect(result.isRecheck).toBe(true);
        expect(result.selectedRunId).toBe('run-1');
      }
    });

    test('resting selection, not yet due (nextEligibleAt in the future) -> not_admissible, zero write', () => {
      const result = decideT1Lease({ case: restingCase({ nextEligibleAtMillis: 5000 }), nowMillis: 1000, invocationId: 'inv-1' });
      expect(result).toEqual({ kind: 'not_admissible' });
    });

    test('resting selection but sweepEligible:false (past horizon) -> not_admissible', () => {
      const result = decideT1Lease({ case: restingCase({ sweepEligible: false }), nowMillis: 1000, invocationId: 'inv-1' });
      expect(result).toEqual({ kind: 'not_admissible' });
    });

    test('sweepEligible but no selectedRunId yet -> not_admissible (nothing to recheck)', () => {
      const result = decideT1Lease({ case: restingCase({ selectedRunId: null }), nowMillis: 1000, invocationId: 'inv-1' });
      expect(result).toEqual({ kind: 'not_admissible' });
    });

    test('pending work always wins over recheck-eligibility: isRecheck stays false', () => {
      const result = decideT1Lease({
        case: restingCase({ pendingRevalidation: true }),
        nowMillis: 1000,
        invocationId: 'inv-1',
      });
      expect(result.kind).toBe('acquire');
      if (result.kind === 'acquire') expect(result.isRecheck).toBe(false);
    });

    test('recheck-eligible case still respects live-lease skip', () => {
      const result = decideT1Lease({
        case: restingCase({ leaseOwner: 'other', leaseExpiryMillis: 5000 }),
        nowMillis: 1000,
        invocationId: 'inv-1',
      });
      expect(result).toEqual({ kind: 'skip_live_owner' });
    });
  });
});

describe('isRecheckEligible', () => {
  test('true only when no pending work, sweepEligible, and a selection exists', () => {
    expect(
      isRecheckEligible({ pendingRevalidation: false, selectedCloseHash: 'h', latestCloseHash: 'h', sweepEligible: true, selectedRunId: 'r' }),
    ).toBe(true);
  });
  test('false when pending work exists', () => {
    expect(
      isRecheckEligible({ pendingRevalidation: true, selectedCloseHash: 'h', latestCloseHash: 'h', sweepEligible: true, selectedRunId: 'r' }),
    ).toBe(false);
  });
  test('false when not sweepEligible', () => {
    expect(
      isRecheckEligible({ pendingRevalidation: false, selectedCloseHash: 'h', latestCloseHash: 'h', sweepEligible: false, selectedRunId: 'r' }),
    ).toBe(false);
  });
  test('false when no selection exists yet', () => {
    expect(
      isRecheckEligible({ pendingRevalidation: false, selectedCloseHash: 'h', latestCloseHash: 'h', sweepEligible: true, selectedRunId: null }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T3 Gate 1 (Option A / STOP_STREAM_UNOWNED) / Gate 2 (same-T3 release) / Gate 3
// ---------------------------------------------------------------------------

function t3Case(overrides: Partial<T3CaseSnapshot> = {}): T3CaseSnapshot {
  return { leaseOwner: 'self', caseVersion: 5, sourceRevision: 2, ...overrides };
}

describe('evaluateT3Gates', () => {
  test('different non-null owner -> OWNER_MISMATCH', () => {
    const result = evaluateT3Gates({ case: t3Case({ leaseOwner: 'other' }), self: 'self', expectedCaseVersion: 5, targetSourceRevision: 2 });
    expect(result).toEqual({ kind: 'OWNER_MISMATCH', observedOwner: 'other' });
  });

  test('observedOwner null (post Q7) -> OWNER_MISMATCH', () => {
    const result = evaluateT3Gates({ case: t3Case({ leaseOwner: null }), self: 'self', expectedCaseVersion: 5, targetSourceRevision: 2 });
    expect(result).toEqual({ kind: 'OWNER_MISMATCH', observedOwner: null });
  });

  test('owner self + stale caseVersion -> STALE_REVISION_RELEASED, exact four fields, freshly-read caseVersion', () => {
    const result = evaluateT3Gates({ case: t3Case({ caseVersion: 9 }), self: 'self', expectedCaseVersion: 5, targetSourceRevision: 2 });
    expect(result).toEqual({
      kind: 'STALE_REVISION_RELEASED',
      caseUpdate: { leaseOwner: null, leaseExpiryMillis: null, processingState: 'queued', caseVersion: 10 },
    });
  });

  test('owner self + stale sourceRevision -> STALE_REVISION_RELEASED', () => {
    const result = evaluateT3Gates({ case: t3Case({ sourceRevision: 3 }), self: 'self', expectedCaseVersion: 5, targetSourceRevision: 2 });
    expect(result.kind).toBe('STALE_REVISION_RELEASED');
  });

  test('owner self + revision current -> PROCEED', () => {
    const result = evaluateT3Gates({ case: t3Case(), self: 'self', expectedCaseVersion: 5, targetSourceRevision: 2 });
    expect(result).toEqual({ kind: 'PROCEED' });
  });

  test('ownership gate wins over stale revision when both conditions hold', () => {
    const result = evaluateT3Gates({
      case: t3Case({ leaseOwner: 'other', caseVersion: 99 }),
      self: 'self',
      expectedCaseVersion: 5,
      targetSourceRevision: 2,
    });
    expect(result.kind).toBe('OWNER_MISMATCH');
  });
});

describe('StopStreamUnowned sentinel', () => {
  test('carries streamId/caseId/observedOwner and is not a generic Error subtype confusion', () => {
    const sentinel = new StopStreamUnowned('trigger', 'shift-1', 'other-owner');
    expect(sentinel).toBeInstanceOf(Error);
    expect(sentinel.name).toBe('StopStreamUnowned');
    expect(sentinel.streamId).toBe('trigger');
    expect(sentinel.caseId).toBe('shift-1');
    expect(sentinel.observedOwner).toBe('other-owner');
  });
});

// ---------------------------------------------------------------------------
// Q7 — cause-agnostic, non-counting recovery
// ---------------------------------------------------------------------------

function q7Case(overrides: Partial<Q7CaseSnapshot> = {}): Q7CaseSnapshot {
  return { processingState: 'validating', leaseOwner: 'owner-1', leaseExpiryMillis: 500, caseVersion: 2, ...overrides };
}

describe('decideQ7Recovery', () => {
  test('validating + expired lease -> recover; caseVersion bumped; no attempts field written', () => {
    const result = decideQ7Recovery({ case: q7Case(), nowMillis: 1000 });
    expect(result).toEqual({
      kind: 'recover',
      caseUpdate: { leaseOwner: null, leaseExpiryMillis: null, processingState: 'queued', caseVersion: 3 },
    });
    if (result.kind === 'recover') {
      expect(Object.keys(result.caseUpdate)).not.toContain('revalidationAttempts');
    }
  });

  test('validating + not yet expired -> not_eligible', () => {
    const result = decideQ7Recovery({ case: q7Case({ leaseExpiryMillis: 5000 }), nowMillis: 1000 });
    expect(result).toEqual({ kind: 'not_eligible' });
  });

  test('not validating -> not_eligible', () => {
    const result = decideQ7Recovery({ case: q7Case({ processingState: 'queued' }), nowMillis: 1000 });
    expect(result).toEqual({ kind: 'not_eligible' });
  });

  test('validating with null leaseOwner -> not_eligible (nothing to recover)', () => {
    const result = decideQ7Recovery({ case: q7Case({ leaseOwner: null }), nowMillis: 1000 });
    expect(result).toEqual({ kind: 'not_eligible' });
  });
});

// ---------------------------------------------------------------------------
// Retry / Category taxonomy (B1 final)
// ---------------------------------------------------------------------------

describe('classifyWorkerFailure', () => {
  test('budget stop always Category B regardless of error shape', () => {
    expect(classifyWorkerFailure(new Error('anything'), true)).toBe('B');
  });
  test('coded transient (numeric) -> Category A', () => {
    expect(classifyWorkerFailure({ code: 10 }, false)).toBe('A');
  });
  test('coded transient (string) -> Category A', () => {
    expect(classifyWorkerFailure({ code: 'unavailable' }, false)).toBe('A');
  });
  test('uncoded plain Error -> Category D', () => {
    expect(classifyWorkerFailure(new Error('boom'), false)).toBe('D');
  });
  test('coded permanent (e.g. NOT_FOUND=5) -> Category D', () => {
    expect(classifyWorkerFailure({ code: 5 }, false)).toBe('D');
  });
});

describe('computeBackoffMillis', () => {
  test('exponential growth capped at 1h', () => {
    expect(computeBackoffMillis(1)).toBe(120_000);
    expect(computeBackoffMillis(2)).toBe(240_000);
    expect(computeBackoffMillis(10)).toBe(3_600_000);
  });
});

describe('buildCategoryAOutcome', () => {
  test('attempts < 10 -> retryable_error, backoff, no alert', () => {
    const outcome = buildCategoryAOutcome({ currentCaseVersion: 1, attemptsBefore: 2, nowMillis: 1000 });
    expect(outcome.exhausted).toBe(false);
    expect(outcome.caseUpdate.processingState).toBe('retryable_error');
    expect(outcome.caseUpdate.revalidationAttempts).toBe(3);
    expect(outcome.alertTransition).toBeUndefined();
  });

  test('attempts reach 10 -> retry_exhausted alert, requires_operator_review, settlement caller-preserved', () => {
    const outcome = buildCategoryAOutcome({ currentCaseVersion: 1, attemptsBefore: MAX_REVALIDATION_ATTEMPTS - 1, nowMillis: 1000 });
    expect(outcome.exhausted).toBe(true);
    expect(outcome.caseUpdate.processingState).toBe('requires_operator_review');
    expect(outcome.caseUpdate.revalidationAttempts).toBe(MAX_REVALIDATION_ATTEMPTS);
    expect(outcome.alertTransition?.reasonCode).toBe('retry_exhausted');
    expect(outcome.alertTransition?.projection.alertState).toBe('open');
  });
});

describe('buildCategoryDOutcome', () => {
  test('non-counting: no revalidationAttempts/pendingRevalidation field in the update', () => {
    const outcome = buildCategoryDOutcome({ currentCaseVersion: 4, nowMillis: 1000 });
    expect(outcome.caseUpdate.processingState).toBe('queued');
    expect(outcome.caseUpdate.caseVersion).toBe(5);
    expect(Object.keys(outcome.caseUpdate)).not.toContain('revalidationAttempts');
    expect(Object.keys(outcome.caseUpdate)).not.toContain('pendingRevalidation');
  });
});

// ---------------------------------------------------------------------------
// B3 — revision-consistent recheck
// ---------------------------------------------------------------------------

describe('compareRecheckDigest', () => {
  test('equal digests -> equal, no revision bump', () => {
    expect(compareRecheckDigest({ candidateDigest: 'x', selectedRunInputsDigest: 'x', currentSourceRevision: 4 })).toEqual({ kind: 'equal' });
  });
  test('changed digest -> changed, revision bumps by exactly 1', () => {
    expect(compareRecheckDigest({ candidateDigest: 'y', selectedRunInputsDigest: 'x', currentSourceRevision: 4 })).toEqual({
      kind: 'changed',
      nextSourceRevision: 5,
    });
  });
});

describe('buildRecheckEqualCaseUpdate', () => {
  test('releases lease, defers 24h, selection fields untouched (caller preserves them by omission)', () => {
    const update = buildRecheckEqualCaseUpdate({
      currentCaseVersion: 3,
      lateEventHorizonUntilMillis: 10_000,
      nowMillis: 1_000,
      priorProcessingState: 'validated',
    });
    expect(update.leaseOwner).toBeNull();
    expect(update.nextEligibleAtMillis).toBe(1_000 + RECHECK_INTERVAL_MS);
    expect(update.sweepEligible).toBe(true);
    expect(update.caseVersion).toBe(4);
    expect(update).not.toHaveProperty('selectedRunId');
  });

  test('sweepEligible flips false when past the horizon', () => {
    const update = buildRecheckEqualCaseUpdate({
      currentCaseVersion: 3,
      lateEventHorizonUntilMillis: 500,
      nowMillis: 1_000,
      priorProcessingState: 'validated',
    });
    expect(update.sweepEligible).toBe(false);
  });

  test('BF-6: preserves the PRE-T1 processingState exactly — never forces validated', () => {
    const forInsufficientEvidence = buildRecheckEqualCaseUpdate({
      currentCaseVersion: 3,
      lateEventHorizonUntilMillis: 10_000,
      nowMillis: 1_000,
      priorProcessingState: 'requires_operator_review',
    });
    expect(forInsufficientEvidence.processingState).toBe('requires_operator_review');

    const forInvalidPayload = buildRecheckEqualCaseUpdate({
      currentCaseVersion: 3,
      lateEventHorizonUntilMillis: 10_000,
      nowMillis: 1_000,
      priorProcessingState: 'permanently_unverifiable',
    });
    expect(forInvalidPayload.processingState).toBe('permanently_unverifiable');
  });
});

// ---------------------------------------------------------------------------
// GD7 digests
// ---------------------------------------------------------------------------

describe('computeFoldSummaryDigest', () => {
  test('deterministic and stable for identical inputs', () => {
    const fold = foldDeviceScopedDrawer([], 'device-1');
    const a = computeFoldSummaryDigest(fold, 0, 0);
    const b = computeFoldSummaryDigest(fold, 0, 0);
    expect(a).toBe(b);
  });

  test('blocked fold still produces a stable digest (block reason encoded)', () => {
    const fold = foldDeviceScopedDrawer(
      [{ id: 'a', shiftId: 's', branchId: 'b', deviceId: 'device-1', status: 'completed', voidRequested: false, reconcileStatus: 'pending_reconcile', changeAmt: 0, payments: [{ method: 'bitcoin', amount: 1 }] }],
      'device-1',
    );
    expect(() => computeFoldSummaryDigest(fold, 0, 0)).not.toThrow();
  });

  test('differs when pay-in/pay-out changes', () => {
    const fold = foldDeviceScopedDrawer([], 'device-1');
    expect(computeFoldSummaryDigest(fold, 100, 0)).not.toBe(computeFoldSummaryDigest(fold, 0, 0));
  });
});

describe('computeCreditDebtReceiptsObservedDigest', () => {
  test('deterministic', () => {
    const o: CreditDebtReceiptsObserved = {
      cashTotalMinor: 100,
      transferTotalMinor: 200,
      count: 3,
      linkedShiftIdCount: 3,
      observedAsOfSourceRevision: 1,
      classification: 'financially_relevant_not_in_frozen_expected',
    };
    expect(computeCreditDebtReceiptsObservedDigest(o)).toBe(computeCreditDebtReceiptsObservedDigest({ ...o }));
  });
  test('differs when observedAsOfSourceRevision differs (R vs R+1 revision-consistency)', () => {
    const base: CreditDebtReceiptsObserved = {
      cashTotalMinor: 0,
      transferTotalMinor: 0,
      count: 0,
      linkedShiftIdCount: 0,
      observedAsOfSourceRevision: 1,
      classification: 'financially_relevant_not_in_frozen_expected',
    };
    expect(computeCreditDebtReceiptsObservedDigest(base)).not.toBe(
      computeCreditDebtReceiptsObservedDigest({ ...base, observedAsOfSourceRevision: 2 }),
    );
  });
});

// ---------------------------------------------------------------------------
// B2 — truthful manifest size truncation
// ---------------------------------------------------------------------------

function manifestDoc(docId: string, collection: SourceManifestDoc['collection'] = 'asyncOrders'): SourceManifestDoc {
  return { collection, docId, updateTimeMicros: '1000000', relevantFieldsDigest: 'a'.repeat(64) };
}

describe('truncateManifestForPayloadGuard', () => {
  test('small manifest -> not truncated; full digest reproducible from the stored docs', () => {
    const docs = [manifestDoc('a'), manifestDoc('b')];
    const result = truncateManifestForPayloadGuard(docs, { docs: [] });
    expect(result.manifestSizeTruncated).toBe(false);
    expect(result.sourceManifestStoredDocsCount).toBe(2);
    expect(result.sourceManifestObservedDocsCount).toBe(2);
  });

  test('degenerate: baseline alone exceeds the guard -> docs:[], hard invariant case', () => {
    const hugeBaseline = { docs: [], padding: 'x'.repeat(RUN_PAYLOAD_GUARD_BYTES + 1) };
    const result = truncateManifestForPayloadGuard([manifestDoc('a')], hugeBaseline);
    expect(result.storedDocs).toHaveLength(0);
    expect(result.manifestSizeTruncated).toBe(true);
  });

  test('byte overflow with many docs -> deterministic canonical prefix, truncated true', () => {
    const docs = Array.from({ length: 5000 }, (_, i) => manifestDoc(String(i).padStart(6, '0')));
    const result = truncateManifestForPayloadGuard(docs, { docs: [] });
    expect(result.manifestSizeTruncated).toBe(true);
    expect(result.sourceManifestStoredDocsCount).toBeLessThan(docs.length);
    expect(result.sourceManifestStoredDocsCount).toBeGreaterThan(0);
  });

  test('deterministic prefix under shuffled input order', () => {
    const docs = Array.from({ length: 5000 }, (_, i) => manifestDoc(String(i).padStart(6, '0')));
    const shuffled = [...docs].reverse();
    const a = truncateManifestForPayloadGuard(docs, { docs: [] });
    const b = truncateManifestForPayloadGuard(shuffled, { docs: [] });
    expect(a.sourceManifestStoredDocsCount).toBe(b.sourceManifestStoredDocsCount);
    expect(a.sourceManifestFullDigest).toBe(b.sourceManifestFullDigest);
  });
});

describe('buildSourceManifest', () => {
  test('truncated = capReachedBySource OR manifestSizeTruncated', () => {
    const notTruncated = buildSourceManifest({ storedDocs: [], capReachedBySource: NO_CAP, manifestSizeTruncated: false, computedAtCommitMicros: '1' });
    expect(notTruncated.truncated).toBe(false);

    const capTruncated = buildSourceManifest({
      storedDocs: [],
      capReachedBySource: { ...NO_CAP, asyncOrders: true },
      manifestSizeTruncated: false,
      computedAtCommitMicros: '1',
    });
    expect(capTruncated.truncated).toBe(true);

    const sizeTruncated = buildSourceManifest({ storedDocs: [], capReachedBySource: NO_CAP, manifestSizeTruncated: true, computedAtCommitMicros: '1' });
    expect(sizeTruncated.truncated).toBe(true);
  });

  test('no fabricated cap flags: false cap flags stay false even when size-truncated', () => {
    const result = buildSourceManifest({ storedDocs: [], capReachedBySource: NO_CAP, manifestSizeTruncated: true, computedAtCommitMicros: '1' });
    expect(result.capReachedBySource).toEqual(NO_CAP);
  });

  test('snapshotConsistency always txn', () => {
    const result = buildSourceManifest({ storedDocs: [], capReachedBySource: NO_CAP, manifestSizeTruncated: false, computedAtCommitMicros: '1' });
    expect(result.snapshotConsistency).toBe('txn');
  });
});

// ---------------------------------------------------------------------------
// V1-V8 verdict decision
// ---------------------------------------------------------------------------

function fullyComputable(overrides: Partial<Parameters<typeof decideValidationVerdict>[0]> = {}) {
  return {
    evidenceExists: true,
    evidenceIdentityMatches: true,
    legacyMissingRequiredField: false,
    capReachedAnySource: false,
    cashEntriesOverflowed: false,
    manifestSizeTruncated: false,
    cashEntriesFoldBlockingCount: 0,
    tenderFoldBlocked: false,
    cashPairHasValueMismatch: false,
    drawerCashVerdict: 'match' as const,
    perFieldDeltasAllZero: true,
    ...overrides,
  };
}

describe('decideValidationVerdict — V1-V8 precedence', () => {
  test('V1 evidence missing wins over everything else', () => {
    const result = decideValidationVerdict(fullyComputable({ evidenceExists: false, tenderFoldBlocked: true }));
    expect(result).toEqual({ verdict: 'insufficient_evidence', cause: 'dependency_unavailable' });
  });

  test('V2 identity mismatch', () => {
    const result = decideValidationVerdict(fullyComputable({ evidenceIdentityMatches: false }));
    expect(result).toEqual({ verdict: 'identity_mismatch' });
  });

  test('V3 legacy missing required field', () => {
    const result = decideValidationVerdict(fullyComputable({ legacyMissingRequiredField: true }));
    expect(result).toEqual({ verdict: 'insufficient_evidence', cause: 'legacy_missing_required_field' });
  });

  test('V4 cap overflow -> source_limit_exceeded', () => {
    expect(decideValidationVerdict(fullyComputable({ capReachedAnySource: true }))).toEqual({
      verdict: 'insufficient_evidence',
      cause: 'source_limit_exceeded',
    });
  });
  test('V4 cashEntriesOverflowed -> source_limit_exceeded', () => {
    expect(decideValidationVerdict(fullyComputable({ cashEntriesOverflowed: true }))).toEqual({
      verdict: 'insufficient_evidence',
      cause: 'source_limit_exceeded',
    });
  });
  test('V4 manifestSizeTruncated -> source_limit_exceeded', () => {
    expect(decideValidationVerdict(fullyComputable({ manifestSizeTruncated: true }))).toEqual({
      verdict: 'insufficient_evidence',
      cause: 'source_limit_exceeded',
    });
  });

  test('V5 cash entry fold-blocking', () => {
    expect(decideValidationVerdict(fullyComputable({ cashEntriesFoldBlockingCount: 1 }))).toEqual({
      verdict: 'insufficient_evidence',
      cause: 'cash_entry_malformed',
    });
  });

  test('V6 malformed source tender -> invalid_payload (errorClassification stays null at the caller)', () => {
    expect(decideValidationVerdict(fullyComputable({ tenderFoldBlocked: true }))).toEqual({ verdict: 'invalid_payload' });
  });

  test('V7 cash pair value mismatch', () => {
    expect(decideValidationVerdict(fullyComputable({ cashPairHasValueMismatch: true }))).toEqual({
      verdict: 'insufficient_evidence',
      cause: 'cash_pair_value_mismatch',
    });
  });

  test('V8 all computable, all zero deltas, drawer match -> match', () => {
    expect(decideValidationVerdict(fullyComputable())).toEqual({ verdict: 'match' });
  });

  test('V8 any nonzero delta -> discrepancy', () => {
    expect(decideValidationVerdict(fullyComputable({ perFieldDeltasAllZero: false }))).toEqual({ verdict: 'discrepancy' });
  });

  test('V8 drawer discrepancy verdict -> discrepancy even if deltas report zero', () => {
    expect(decideValidationVerdict(fullyComputable({ drawerCashVerdict: 'discrepancy' }))).toEqual({ verdict: 'discrepancy' });
  });

  test('V5 wins over V6 (precedence order)', () => {
    const result = decideValidationVerdict(fullyComputable({ cashEntriesFoldBlockingCount: 1, tenderFoldBlocked: true }));
    expect(result).toEqual({ verdict: 'insufficient_evidence', cause: 'cash_entry_malformed' });
  });
});

// ---------------------------------------------------------------------------
// B4 final — alert invariants + independent openedAt validation
// ---------------------------------------------------------------------------

function caseView(overrides: Partial<AlertInvariantCaseView> = {}): AlertInvariantCaseView {
  return { branchId: 'branch-1', caseVersion: 5, alertState: 'open', ...overrides };
}

function alertView(overrides: Partial<AlertInvariantAlertView> = {}): AlertInvariantAlertView {
  return {
    id: 'shift-1',
    shiftId: 'shift-1',
    branchId: 'branch-1',
    schemaVersion: 1,
    caseVersion: 5,
    alertState: 'open',
    reasonCode: 'drawer_discrepancy',
    acknowledgedByActor: null,
    resolvedByActor: null,
    openedAt: new Timestamp(1000, 0),
    ...overrides,
  };
}

describe('validateStoredOpenedAt', () => {
  test('none requires exactly null', () => {
    expect(validateStoredOpenedAt('none', null)).toBe(true);
    expect(validateStoredOpenedAt('none', new Timestamp(1, 0))).toBe(false);
  });
  test('open requires a valid Timestamp instance', () => {
    expect(validateStoredOpenedAt('open', new Timestamp(1, 0))).toBe(true);
    expect(validateStoredOpenedAt('open', null)).toBe(false);
    expect(validateStoredOpenedAt('open', { seconds: 1, nanoseconds: 0 })).toBe(false); // plain object shape rejected
  });
  test('resolved requires a valid Timestamp', () => {
    expect(validateStoredOpenedAt('resolved', new Timestamp(1, 0))).toBe(true);
    expect(validateStoredOpenedAt('resolved', null)).toBe(false);
  });
});

describe('validateAlertInvariants', () => {
  test('valid alert doc -> ok', () => {
    expect(validateAlertInvariants(caseView(), alertView())).toEqual({ ok: true });
  });
  test('doc id != shiftId -> violation', () => {
    expect(validateAlertInvariants(caseView(), alertView({ id: 'other' }))).toEqual({ ok: false, violation: 'doc_id_mismatch' });
  });
  test('branch mismatch -> violation', () => {
    expect(validateAlertInvariants(caseView(), alertView({ branchId: 'branch-2' }))).toEqual({ ok: false, violation: 'branch_mismatch' });
  });
  test('schema version mismatch -> violation', () => {
    expect(validateAlertInvariants(caseView(), alertView({ schemaVersion: 2 }))).toEqual({ ok: false, violation: 'schema_version_mismatch' });
  });
  test('alert.caseVersion ahead of case.caseVersion -> violation', () => {
    expect(validateAlertInvariants(caseView({ caseVersion: 3 }), alertView({ caseVersion: 5 }))).toEqual({
      ok: false,
      violation: 'case_version_ahead',
    });
  });
  test('invalid projection shape (open with non-null actor) -> violation', () => {
    expect(
      validateAlertInvariants(caseView(), alertView({ acknowledgedByActor: { kind: 'manager', managerUid: 'u1' } })),
    ).toEqual({ ok: false, violation: 'invalid_projection_shape' });
  });
  test('case.alertState disagrees with alert.alertState -> violation', () => {
    expect(validateAlertInvariants(caseView({ alertState: 'none' }), alertView())).toEqual({ ok: false, violation: 'state_disagreement' });
  });
  test('openedAt invalid for open state -> violation', () => {
    expect(validateAlertInvariants(caseView(), alertView({ openedAt: null }))).toEqual({ ok: false, violation: 'openedAt_invalid' });
  });
  test('none state with null openedAt -> ok', () => {
    expect(
      validateAlertInvariants(
        caseView({ alertState: 'none' }),
        alertView({ alertState: 'none', reasonCode: null, openedAt: null }),
      ),
    ).toEqual({ ok: true });
  });
});

describe('computeOpenedAtWrite', () => {
  test('-> open is always fresh', () => {
    expect(computeOpenedAtWrite('open')).toEqual({ kind: 'fresh' });
  });
  test('-> none clears', () => {
    expect(computeOpenedAtWrite('none')).toEqual({ kind: 'clear' });
  });
  test('-> resolved preserves', () => {
    expect(computeOpenedAtWrite('resolved')).toEqual({ kind: 'preserve' });
  });
});

// ---------------------------------------------------------------------------
// Run / audit id builders
// ---------------------------------------------------------------------------

describe('buildRunId', () => {
  test('deterministic composition', () => {
    expect(buildRunId({ shiftId: 's1', closeHash: 'ch', sourceRevision: 3 })).toBe('s1_ch_1_3');
  });
});

describe('computeP5DAuditEventId', () => {
  test('deterministic for identical inputs', () => {
    const a = computeP5DAuditEventId({ shiftId: 's1', eventKey: 'run-1', transitionType: 'run_selected', targetCaseVersion: 2 });
    const b = computeP5DAuditEventId({ shiftId: 's1', eventKey: 'run-1', transitionType: 'run_selected', targetCaseVersion: 2 });
    expect(a).toBe(b);
  });
  test('differs when targetCaseVersion differs (retries at a strictly-increasing version cannot duplicate)', () => {
    const a = computeP5DAuditEventId({ shiftId: 's1', eventKey: 'run-1', transitionType: 'run_selected', targetCaseVersion: 2 });
    const b = computeP5DAuditEventId({ shiftId: 's1', eventKey: 'run-1', transitionType: 'run_selected', targetCaseVersion: 3 });
    expect(a).not.toBe(b);
  });
});

describe('buildRunFields', () => {
  test('exact forbidden-field absence: no complete_proven, no updatedAt, no selected*/latest*', () => {
    const { runId, evidenceId, fields } = buildRunFields({
      shiftId: 's1',
      branchId: 'b1',
      closeHash: 'ch',
      sourceRevision: 1,
      validationVerdict: 'match',
      errorClassification: null,
      drawerCashVerdict: 'match',
      serverComputedDrawer: { expectedCashMinor: 0 },
      perFieldDeltas: { expectedCashMinor: 0 },
      creditDebtReceiptsObserved: {
        cashTotalMinor: 0,
        transferTotalMinor: 0,
        count: 0,
        linkedShiftIdCount: 0,
        observedAsOfSourceRevision: 1,
        classification: 'financially_relevant_not_in_frozen_expected',
      },
      crossDeviceSalesObserved: { observed: false, count: 0 },
      cashPairClassification: [],
      sourceManifest: buildSourceManifest({ storedDocs: [], capReachedBySource: NO_CAP, manifestSizeTruncated: false, computedAtCommitMicros: '1' }),
      manifestSizeTruncated: false,
      sourceManifestFullDigest: 'digest',
      sourceManifestObservedDocsCount: 0,
      sourceManifestStoredDocsCount: 0,
      inputsDigest: 'digest2',
    });
    expect(runId).toBe('s1_ch_1_1');
    expect(evidenceId).toBe('s1_ch');
    expect(fields.completenessPosture).toBe('provisional');
    expect(fields).not.toHaveProperty('updatedAt');
    expect(fields).not.toHaveProperty('selectedRunId');
    expect(fields).not.toHaveProperty('complete_proven');
    expect(fields.mode).toBe('live');
  });
});

describe('buildSelectionCaseUpdate', () => {
  test('pendingRevalidation false, attempts reset to 0, lease released', () => {
    const update = buildSelectionCaseUpdate({
      runId: 'run-1',
      closeHash: 'ch',
      sourceRevision: 1,
      priorSelectedRunId: null,
      processingState: 'validated',
      settlementState: 'provisional_match',
      alertState: 'none',
      computedAtCommitMicros: '100',
      currentLastObservedCommitMicros: '50',
      commitBoundaryDocKeys: ['k1'],
      currentCaseVersion: 4,
      lateEventHorizonUntilMillis: 10_000,
      nowMillis: 1_000,
    });
    expect(update.pendingRevalidation).toBe(false);
    expect(update.revalidationAttempts).toBe(0);
    expect(update.leaseOwner).toBeNull();
    expect(update.lastObservedCommitMicros).toBe('100');
    expect(update.caseVersion).toBe(5);
  });

  test('lastObservedCommitMicros is BigInt-max, never regresses', () => {
    const update = buildSelectionCaseUpdate({
      runId: 'run-1',
      closeHash: 'ch',
      sourceRevision: 1,
      priorSelectedRunId: null,
      processingState: 'validated',
      settlementState: 'provisional_match',
      alertState: 'none',
      computedAtCommitMicros: '50',
      currentLastObservedCommitMicros: '999999999999',
      commitBoundaryDocKeys: [],
      currentCaseVersion: 1,
      lateEventHorizonUntilMillis: 10_000,
      nowMillis: 1_000,
    });
    expect(update.lastObservedCommitMicros).toBe('999999999999');
  });

  test('sourceRevision is written on the case update (B3 revision-consistency)', () => {
    const update = buildSelectionCaseUpdate({
      runId: 'shift-1_ch_1_3',
      closeHash: 'ch',
      sourceRevision: 3,
      priorSelectedRunId: 'shift-1_ch_1_2',
      processingState: 'validated',
      settlementState: 'provisional_match',
      alertState: 'none',
      computedAtCommitMicros: '1',
      currentLastObservedCommitMicros: '0',
      commitBoundaryDocKeys: [],
      currentCaseVersion: 1,
      lateEventHorizonUntilMillis: 10_000,
      nowMillis: 1_000,
    });
    expect(update.sourceRevision).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// B3 — computeInputsDigestAtRevision (revision-aware digest composition)
// ---------------------------------------------------------------------------

describe('computeInputsDigestAtRevision', () => {
  function components() {
    return {
      tenderFold: foldDeviceScopedDrawer([], 'device-1'),
      payInMinor: 0,
      payOutMinor: 0,
      creditDebtReceiptsObserved: {
        cashTotalMinor: 0,
        transferTotalMinor: 0,
        count: 0,
        linkedShiftIdCount: 0,
        observedAsOfSourceRevision: 1,
        classification: 'financially_relevant_not_in_frozen_expected' as const,
      },
      sourceManifestFullDigest: 'manifest-digest',
      cashEntriesDigest: 'cash-digest',
      cashEntriesFullDigest: 'cash-full-digest',
      sourceEntryCount: 0,
    };
  }

  test('deterministic for identical inputs', () => {
    const c = components();
    expect(computeInputsDigestAtRevision(c, 1)).toBe(computeInputsDigestAtRevision(c, 1));
  });

  test('differs at a different revision — proves the R vs R+1 comparison is meaningful', () => {
    const c = components();
    expect(computeInputsDigestAtRevision(c, 1)).not.toBe(computeInputsDigestAtRevision(c, 2));
  });

  test('the observedAsOfSourceRevision component always tracks the requested revision, not the input snapshot value', () => {
    const c = components(); // snapshot says observedAsOfSourceRevision: 1
    const atR2 = computeInputsDigestAtRevision(c, 2);
    const manuallyBuiltAtR2 = computeInputsDigestAtRevision({ ...c, creditDebtReceiptsObserved: { ...c.creditDebtReceiptsObserved, observedAsOfSourceRevision: 2 } }, 2);
    expect(atR2).toBe(manuallyBuiltAtR2);
  });

  test('non-revision components (fold/manifest/cash-entries) participate in the digest', () => {
    const c = components();
    const changed = { ...c, sourceManifestFullDigest: 'different-manifest-digest' };
    expect(computeInputsDigestAtRevision(c, 1)).not.toBe(computeInputsDigestAtRevision(changed, 1));
  });
});

// ---------------------------------------------------------------------------
// Budget accounting
// ---------------------------------------------------------------------------

describe('canAdmitAnotherCase', () => {
  test('effective worst-case admissions = 12 (12 * 1412 = 16944 <= 17000; 13 would exceed)', () => {
    expect(canAdmitAnotherCase({ consumedReads: 11 * 1412, admittedCases: 11 })).toBe(true);
    expect(canAdmitAnotherCase({ consumedReads: 12 * 1412, admittedCases: 12 })).toBe(false);
  });
  test('cardinality ceiling: 25 cases max regardless of read budget', () => {
    expect(canAdmitAnotherCase({ consumedReads: 0, admittedCases: 25 })).toBe(false);
  });
});
