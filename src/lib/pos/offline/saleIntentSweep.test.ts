import { describe, test, expect, vi } from 'vitest';
import type { JournalResult, SaleIntentEntry, SaleIntentJournalStatus } from './saleIntentJournalTypes';
import { runSaleIntentSweep, type SaleIntentSweepJournalDeps } from './saleIntentSweep';
import { SWEEP_STALE_THRESHOLD_MS } from './saleIntentSweepLogic';

const NOW_ISO = '2026-07-07T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

function makeEntry(overrides?: Partial<SaleIntentEntry>): SaleIntentEntry {
  const staleIso = new Date(NOW_MS - (SWEEP_STALE_THRESHOLD_MS + 1000)).toISOString();
  return {
    asyncOrderId: 'DEV1-000001',
    localQueueId: 'DEV1-000001',
    idempotencyKey: 'DEV1-000001',
    billId: 'B-000001',
    branchId: 'LDP-001',
    deviceId: 'DEV1',
    shiftId: 'shift-1',
    staffId: 'staff1',
    createdAtLocal: NOW_MS - (SWEEP_STALE_THRESHOLD_MS + 1000),
    createdAtIso: staleIso,
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
    updatedAtLocal: staleIso,
    ...overrides,
  };
}

/**
 * In-memory fake journal. Only the 3 methods the runner is allowed to depend on
 * exist at all — there is structurally no retry/resend/markRejectedByRules
 * surface for the runner to call even by mistake.
 */
function createFakeJournal(entries: SaleIntentEntry[]): SaleIntentSweepJournalDeps & {
  listSaleIntentsByStatus: ReturnType<typeof vi.fn>;
  markServerAcknowledged: ReturnType<typeof vi.fn>;
  recordSaleIntentEvent: ReturnType<typeof vi.fn>;
} {
  const listSaleIntentsByStatus = vi.fn(
    async (statuses: SaleIntentJournalStatus[]): Promise<JournalResult<SaleIntentEntry[]>> => ({
      ok: true,
      value: entries.filter((e) => statuses.includes(e.status)),
    }),
  );
  const markServerAcknowledged = vi.fn(
    async (asyncOrderId: string): Promise<JournalResult<SaleIntentEntry>> => {
      const entry = entries.find((e) => e.asyncOrderId === asyncOrderId);
      if (!entry) return { ok: false, code: 'not_found' };
      return { ok: true, value: { ...entry, status: 'server_acknowledged' } };
    },
  );
  const recordSaleIntentEvent = vi.fn(async () => ({ ok: true, value: {} }) as JournalResult<any>);

  return { listSaleIntentsByStatus, markServerAcknowledged, recordSaleIntentEvent };
}

describe('saleIntentSweep · candidate discovery scope', () => {
  test('asks the journal for queued / flushed_to_cache / exception_observed only', async () => {
    const journal = createFakeJournal([]);
    await runSaleIntentSweep({
      journal,
      lookupAsyncOrder: async () => ({ exists: false }),
      now: () => NOW_MS,
    });

    expect(journal.listSaleIntentsByStatus).toHaveBeenCalledWith([
      'queued',
      'flushed_to_cache',
      'exception_observed',
    ]);
  });

  test('report-only counts use a separate, non-transitional call — never rejected_by_rules/manual_review for transition', async () => {
    const entries = [
      makeEntry({ asyncOrderId: 'r1', status: 'rejected_by_rules' }),
      makeEntry({ asyncOrderId: 'm1', status: 'manual_review' }),
    ];
    const journal = createFakeJournal(entries);
    const outcome = await runSaleIntentSweep({
      journal,
      lookupAsyncOrder: async () => ({ exists: true }),
      now: () => NOW_MS,
    });

    expect(journal.listSaleIntentsByStatus).toHaveBeenCalledWith(['rejected_by_rules', 'manual_review']);
    expect(journal.markServerAcknowledged).not.toHaveBeenCalled();
    expect(outcome.reportOnly).toEqual({ rejectedByRules: 1, manualReview: 1 });
  });

  test('does not touch server_acknowledged entries', async () => {
    const entries = [makeEntry({ asyncOrderId: 's1', status: 'server_acknowledged' })];
    const journal = createFakeJournal(entries);
    const outcome = await runSaleIntentSweep({
      journal,
      lookupAsyncOrder: async () => ({ exists: true }),
      now: () => NOW_MS,
    });

    expect(journal.markServerAcknowledged).not.toHaveBeenCalled();
    expect(outcome.scanned).toBe(0);
  });
});

describe('saleIntentSweep · transitions on server-exists', () => {
  test('stale flushed_to_cache + lookup exists -> markServerAcknowledged', async () => {
    const entries = [makeEntry({ asyncOrderId: 'f1', status: 'flushed_to_cache' })];
    const journal = createFakeJournal(entries);
    const outcome = await runSaleIntentSweep({
      journal,
      lookupAsyncOrder: async () => ({ exists: true }),
      now: () => NOW_MS,
    });

    expect(journal.markServerAcknowledged).toHaveBeenCalledWith('f1');
    expect(outcome.acknowledged).toBe(1);
  });

  test('stale queued + lookup exists -> markServerAcknowledged', async () => {
    const entries = [makeEntry({ asyncOrderId: 'q1', status: 'queued' })];
    const journal = createFakeJournal(entries);
    const outcome = await runSaleIntentSweep({
      journal,
      lookupAsyncOrder: async () => ({ exists: true }),
      now: () => NOW_MS,
    });

    expect(journal.markServerAcknowledged).toHaveBeenCalledWith('q1');
    expect(outcome.acknowledged).toBe(1);
  });

  test('stale exception_observed + lookup exists -> no illegal status transition, event only', async () => {
    const entries = [makeEntry({ asyncOrderId: 'e1', status: 'exception_observed' })];
    const journal = createFakeJournal(entries);
    const outcome = await runSaleIntentSweep({
      journal,
      lookupAsyncOrder: async () => ({ exists: true }),
      now: () => NOW_MS,
    });

    expect(journal.markServerAcknowledged).not.toHaveBeenCalled();
    expect(journal.recordSaleIntentEvent).toHaveBeenCalledWith(
      'e1',
      'exception_observed',
      expect.objectContaining({ phase: 'sweep' }),
    );
    expect(outcome.exceptionObservedServerExists).toBe(1);
  });
});

describe('saleIntentSweep · ambiguity handling', () => {
  test('missing doc -> no server_acknowledged transition (structurally no rejected_by_rules call exists)', async () => {
    const entries = [makeEntry({ asyncOrderId: 'q1', status: 'queued' })];
    const journal = createFakeJournal(entries);
    const outcome = await runSaleIntentSweep({
      journal,
      lookupAsyncOrder: async () => ({ exists: false }),
      now: () => NOW_MS,
    });

    expect(journal.markServerAcknowledged).not.toHaveBeenCalled();
    expect(outcome.ambiguousMissing).toBe(1);
  });

  test('permission-denied lookup error -> no transition, ambiguous', async () => {
    const entries = [makeEntry({ asyncOrderId: 'q1', status: 'queued' })];
    const journal = createFakeJournal(entries);
    const outcome = await runSaleIntentSweep({
      journal,
      lookupAsyncOrder: async () => {
        throw Object.assign(new Error('denied'), { code: 'permission-denied' });
      },
      now: () => NOW_MS,
    });

    expect(journal.markServerAcknowledged).not.toHaveBeenCalled();
    expect(outcome.ambiguousLookupError).toBe(1);
  });

  test('unavailable lookup error -> safe skip, no throw', async () => {
    const entries = [makeEntry({ asyncOrderId: 'q1', status: 'queued' })];
    const journal = createFakeJournal(entries);
    await expect(
      runSaleIntentSweep({
        journal,
        lookupAsyncOrder: async () => {
          throw Object.assign(new Error('offline'), { code: 'unavailable' });
        },
        now: () => NOW_MS,
      }),
    ).resolves.not.toThrow();
  });
});

describe('saleIntentSweep · fail-open behavior', () => {
  test('journal list failure -> fail open, no throw', async () => {
    const journal: SaleIntentSweepJournalDeps = {
      listSaleIntentsByStatus: vi.fn(async () => ({ ok: false, code: 'unavailable' }) as JournalResult<SaleIntentEntry[]>),
      markServerAcknowledged: vi.fn(),
      recordSaleIntentEvent: vi.fn(),
    };

    const outcome = await runSaleIntentSweep({
      journal,
      lookupAsyncOrder: async () => ({ exists: true }),
      now: () => NOW_MS,
    });

    expect(outcome.failedOpen).toBe(true);
    expect(journal.markServerAcknowledged).not.toHaveBeenCalled();
  });

  test('lookup failure (unknown error) -> fail open, no throw, ambiguous', async () => {
    const entries = [makeEntry({ asyncOrderId: 'q1', status: 'queued' })];
    const journal = createFakeJournal(entries);
    const outcome = await runSaleIntentSweep({
      journal,
      lookupAsyncOrder: async () => {
        throw new Error('boom');
      },
      now: () => NOW_MS,
    });

    expect(outcome.ambiguousLookupError).toBe(1);
    expect(outcome.failedOpen).toBe(false);
  });

  test('transition failure (markServerAcknowledged throws) -> fail open, no throw', async () => {
    const entries = [makeEntry({ asyncOrderId: 'q1', status: 'queued' })];
    const journal = createFakeJournal(entries);
    journal.markServerAcknowledged.mockImplementation(async () => {
      throw new Error('write failed');
    });

    const outcome = await runSaleIntentSweep({
      journal,
      lookupAsyncOrder: async () => ({ exists: true }),
      now: () => NOW_MS,
    });

    expect(outcome.acknowledged).toBe(0);
    expect(outcome.failedOpen).toBe(false);
  });
});

describe('saleIntentSweep · bounds and non-invocation', () => {
  test('max batch limit is respected', async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ asyncOrderId: `q${i + 1}`, status: 'queued', createdAtLocal: NOW_MS - (5 - i) * 1000 }),
    );
    const journal = createFakeJournal(entries);
    const lookupAsyncOrder = vi.fn(async () => ({ exists: true }));

    const outcome = await runSaleIntentSweep({
      journal,
      lookupAsyncOrder,
      now: () => NOW_MS,
      batchLimit: 2,
    });

    expect(lookupAsyncOrder).toHaveBeenCalledTimes(2);
    expect(outcome.candidatesConsidered).toBe(2);
  });

  test('no retry/resend function exists on the journal dependency surface', async () => {
    const journal = createFakeJournal([]);
    expect((journal as Record<string, unknown>).markRejectedByRules).toBeUndefined();
    expect((journal as Record<string, unknown>).resendAsyncOrder).toBeUndefined();
    expect((journal as Record<string, unknown>).retryAsyncOrder).toBeUndefined();
  });

  test('the sweep is not invoked merely by importing the module', async () => {
    const journal = createFakeJournal([makeEntry({ asyncOrderId: 'q1', status: 'queued' })]);
    // Constructing deps and never calling runSaleIntentSweep must leave the journal untouched.
    expect(journal.listSaleIntentsByStatus).not.toHaveBeenCalled();
    expect(journal.markServerAcknowledged).not.toHaveBeenCalled();
    expect(journal.recordSaleIntentEvent).not.toHaveBeenCalled();
  });
});
