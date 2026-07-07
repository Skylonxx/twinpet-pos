import { describe, test, expect } from 'vitest';
import type { SaleIntentEntry, SaleIntentJournalStatus } from './saleIntentJournalTypes';
import {
  SWEEP_CANDIDATE_STATUSES,
  SWEEP_DEFAULT_BATCH_LIMIT,
  SWEEP_REPORT_ONLY_STATUSES,
  SWEEP_STALE_THRESHOLD_MS,
  classifyEntryForSweep,
  countReportOnlyEntries,
  decideSweepAction,
  isEntryStale,
  isSweepCandidateStatus,
  isSweepReportOnlyStatus,
  normalizeLookupError,
  selectSweepCandidates,
} from './saleIntentSweepLogic';

const NOW_ISO = '2026-07-07T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

function makeEntry(overrides?: Partial<SaleIntentEntry>): SaleIntentEntry {
  return {
    asyncOrderId: 'DEV1-000001',
    localQueueId: 'DEV1-000001',
    idempotencyKey: 'DEV1-000001',
    billId: 'B-000001',
    branchId: 'LDP-001',
    deviceId: 'DEV1',
    shiftId: 'shift-1',
    staffId: 'staff1',
    createdAtLocal: NOW_MS - SWEEP_STALE_THRESHOLD_MS * 2,
    createdAtIso: new Date(NOW_MS - SWEEP_STALE_THRESHOLD_MS * 2).toISOString(),
    status: 'queued',
    payloadVersion: 1,
    salePayload: null,
    payloadStrippedAt: null,
    totalAmount: 100,
    retryCount: 0,
    lastAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    rejectedAt: null,
    serverAcknowledgedAt: null,
    settledObservedAt: null,
    manualReviewReason: null,
    conflictState: null,
    supersededBy: null,
    nextEventSeq: 1,
    updatedAtLocal: new Date(NOW_MS - SWEEP_STALE_THRESHOLD_MS * 2).toISOString(),
    ...overrides,
  };
}

function withUpdatedAgeMs(entry: SaleIntentEntry, ageMs: number): SaleIntentEntry {
  return { ...entry, updatedAtLocal: new Date(NOW_MS - ageMs).toISOString() };
}

describe('saleIntentSweepLogic · status classification', () => {
  test('queued / flushed_to_cache / exception_observed are candidate statuses', () => {
    expect(isSweepCandidateStatus('queued')).toBe(true);
    expect(isSweepCandidateStatus('flushed_to_cache')).toBe(true);
    expect(isSweepCandidateStatus('exception_observed')).toBe(true);
  });

  test('rejected_by_rules / manual_review are report-only, never candidates', () => {
    expect(isSweepCandidateStatus('rejected_by_rules')).toBe(false);
    expect(isSweepCandidateStatus('manual_review')).toBe(false);
    expect(isSweepReportOnlyStatus('rejected_by_rules')).toBe(true);
    expect(isSweepReportOnlyStatus('manual_review')).toBe(true);
  });

  test('server_acknowledged is not a candidate status', () => {
    expect(isSweepCandidateStatus('server_acknowledged')).toBe(false);
    expect(isSweepReportOnlyStatus('server_acknowledged')).toBe(false);
  });

  test('settled_observed and superseded are not swept', () => {
    expect(isSweepCandidateStatus('settled_observed')).toBe(false);
    expect(isSweepCandidateStatus('superseded')).toBe(false);
    expect(isSweepReportOnlyStatus('settled_observed')).toBe(false);
    expect(isSweepReportOnlyStatus('superseded')).toBe(false);
  });

  test('orphaned is neither a candidate nor a report-only status by default', () => {
    expect(isSweepCandidateStatus('orphaned')).toBe(false);
    expect(isSweepReportOnlyStatus('orphaned')).toBe(false);
  });
});

describe('saleIntentSweepLogic · staleness', () => {
  test('fresh entries under 10 minutes are skipped', () => {
    const entry = withUpdatedAgeMs(makeEntry(), SWEEP_STALE_THRESHOLD_MS - 1);
    expect(isEntryStale(entry, NOW_MS)).toBe(false);
  });

  test('stale entries at/over 10 minutes are eligible', () => {
    const atThreshold = withUpdatedAgeMs(makeEntry(), SWEEP_STALE_THRESHOLD_MS);
    const overThreshold = withUpdatedAgeMs(makeEntry(), SWEEP_STALE_THRESHOLD_MS + 1);
    expect(isEntryStale(atThreshold, NOW_MS)).toBe(true);
    expect(isEntryStale(overThreshold, NOW_MS)).toBe(true);
  });

  test('unparsable updatedAtLocal is treated as not-stale (safe default)', () => {
    const entry = { ...makeEntry(), updatedAtLocal: 'not-a-date' };
    expect(isEntryStale(entry, NOW_MS)).toBe(false);
  });
});

describe('saleIntentSweepLogic · classifyEntryForSweep', () => {
  test('non-candidate status -> skip_status regardless of age', () => {
    const entry = withUpdatedAgeMs(makeEntry({ status: 'rejected_by_rules' }), SWEEP_STALE_THRESHOLD_MS + 1);
    expect(classifyEntryForSweep(entry, NOW_MS)).toBe('skip_status');
  });

  test('candidate status but fresh -> skip_fresh', () => {
    const entry = withUpdatedAgeMs(makeEntry({ status: 'flushed_to_cache' }), 1000);
    expect(classifyEntryForSweep(entry, NOW_MS)).toBe('skip_fresh');
  });

  test('candidate status and stale -> lookup_required', () => {
    const entry = withUpdatedAgeMs(makeEntry({ status: 'queued' }), SWEEP_STALE_THRESHOLD_MS + 1);
    expect(classifyEntryForSweep(entry, NOW_MS)).toBe('lookup_required');
  });
});

describe('saleIntentSweepLogic · selectSweepCandidates', () => {
  test('threshold and batch defaults are deterministic', () => {
    expect(SWEEP_STALE_THRESHOLD_MS).toBe(10 * 60 * 1000);
    expect(SWEEP_DEFAULT_BATCH_LIMIT).toBeGreaterThan(0);
    expect(SWEEP_CANDIDATE_STATUSES).toEqual(['queued', 'flushed_to_cache', 'exception_observed']);
    expect(SWEEP_REPORT_ONLY_STATUSES).toEqual(['rejected_by_rules', 'manual_review']);
  });

  test('excludes fresh entries and non-candidate statuses, includes stale candidates', () => {
    const stale = withUpdatedAgeMs(
      makeEntry({ asyncOrderId: 'DEV1-000001', status: 'queued' }),
      SWEEP_STALE_THRESHOLD_MS + 1,
    );
    const fresh = withUpdatedAgeMs(
      makeEntry({ asyncOrderId: 'DEV1-000002', status: 'flushed_to_cache' }),
      1000,
    );
    const notCandidate = withUpdatedAgeMs(
      makeEntry({ asyncOrderId: 'DEV1-000003', status: 'rejected_by_rules' }),
      SWEEP_STALE_THRESHOLD_MS + 1,
    );

    const selected = selectSweepCandidates([stale, fresh, notCandidate], { nowMs: NOW_MS });
    expect(selected.map((e) => e.asyncOrderId)).toEqual(['DEV1-000001']);
  });

  test('respects a bounded batch limit deterministically ordered by createdAtLocal then id', () => {
    const entries: SaleIntentEntry[] = Array.from({ length: 5 }, (_, i) =>
      withUpdatedAgeMs(
        makeEntry({
          asyncOrderId: `DEV1-00000${i + 1}`,
          status: 'queued',
          createdAtLocal: NOW_MS - (5 - i) * 1000,
        }),
        SWEEP_STALE_THRESHOLD_MS + 1,
      ),
    );

    const selected = selectSweepCandidates(entries, { nowMs: NOW_MS, batchLimit: 2 });
    expect(selected).toHaveLength(2);
    expect(selected.map((e) => e.asyncOrderId)).toEqual(['DEV1-000001', 'DEV1-000002']);
  });
});

describe('saleIntentSweepLogic · decideSweepAction', () => {
  test('server exists for flushed_to_cache recommends server_acknowledged', () => {
    const entry = makeEntry({ status: 'flushed_to_cache' });
    expect(decideSweepAction(entry, { kind: 'exists' })).toBe('acknowledge_server_exists');
  });

  test('server exists for queued recommends server_acknowledged', () => {
    const entry = makeEntry({ status: 'queued' });
    expect(decideSweepAction(entry, { kind: 'exists' })).toBe('acknowledge_server_exists');
  });

  test('server exists for exception_observed does not recommend an illegal transition', () => {
    const entry = makeEntry({ status: 'exception_observed' });
    const decision = decideSweepAction(entry, { kind: 'exists' });
    expect(decision).toBe('no_transition_exception_observed_server_exists');
    expect(decision).not.toBe('acknowledge_server_exists');
  });

  test('missing server doc remains ambiguous and not rejected_by_rules', () => {
    const entry = makeEntry({ status: 'queued' });
    const decision = decideSweepAction(entry, { kind: 'missing' });
    expect(decision).toBe('no_transition_missing_ambiguous');
  });

  test.each(['permission-denied', 'unauthenticated', 'unavailable', 'some-unknown-code'] as const)(
    '%s lookup error remains ambiguous/no-transition, never rejected_by_rules',
    (reason) => {
      const entry = makeEntry({ status: 'flushed_to_cache' });
      const decision = decideSweepAction(entry, { kind: 'error', reason });
      expect(decision).toBe('no_transition_lookup_error');
    },
  );

  test('no decision path maps a lookup error to rejected_by_rules', () => {
    const outcomes: Array<{ kind: 'error'; reason: string }> = [
      { kind: 'error', reason: 'permission-denied' },
      { kind: 'error', reason: 'unauthenticated' },
      { kind: 'error', reason: 'unavailable' },
      { kind: 'error', reason: 'unknown' },
    ];
    for (const status of SWEEP_CANDIDATE_STATUSES as SaleIntentJournalStatus[]) {
      for (const outcome of outcomes) {
        const decision = decideSweepAction(makeEntry({ status }), outcome);
        expect(decision).not.toBe('rejected_by_rules' as unknown as typeof decision);
        expect(decision).toBe('no_transition_lookup_error');
      }
    }
  });

  test('no decision path maps a missing doc directly to server_acknowledged', () => {
    for (const status of SWEEP_CANDIDATE_STATUSES as SaleIntentJournalStatus[]) {
      const decision = decideSweepAction(makeEntry({ status }), { kind: 'missing' });
      expect(decision).not.toBe('acknowledge_server_exists');
    }
  });
});

describe('saleIntentSweepLogic · normalizeLookupError', () => {
  test('permission-denied normalizes to a known ambiguous reason', () => {
    const err = Object.assign(new Error('nope'), { code: 'permission-denied' });
    expect(normalizeLookupError(err)).toEqual({ kind: 'error', reason: 'permission-denied' });
  });

  test('unauthenticated normalizes to a known ambiguous reason', () => {
    const err = Object.assign(new Error('nope'), { code: 'unauthenticated' });
    expect(normalizeLookupError(err)).toEqual({ kind: 'error', reason: 'unauthenticated' });
  });

  test('unavailable normalizes to a known ambiguous reason', () => {
    const err = Object.assign(new Error('offline'), { code: 'unavailable' });
    expect(normalizeLookupError(err)).toEqual({ kind: 'error', reason: 'unavailable' });
  });

  test('unrecognized/missing error codes normalize to unknown', () => {
    expect(normalizeLookupError(new Error('boom'))).toEqual({ kind: 'error', reason: 'unknown' });
    expect(normalizeLookupError('plain string')).toEqual({ kind: 'error', reason: 'unknown' });
    expect(normalizeLookupError(undefined)).toEqual({ kind: 'error', reason: 'unknown' });
  });
});

describe('saleIntentSweepLogic · countReportOnlyEntries', () => {
  test('counts rejected_by_rules and manual_review without affecting candidates', () => {
    const entries = [
      makeEntry({ asyncOrderId: 'a', status: 'rejected_by_rules' }),
      makeEntry({ asyncOrderId: 'b', status: 'rejected_by_rules' }),
      makeEntry({ asyncOrderId: 'c', status: 'manual_review' }),
      makeEntry({ asyncOrderId: 'd', status: 'queued' }),
    ];
    expect(countReportOnlyEntries(entries)).toEqual({ rejectedByRules: 2, manualReview: 1 });
  });
});
