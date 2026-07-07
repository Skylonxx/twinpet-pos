import type { SaleIntentJournal } from './saleIntentJournal';
import {
  countReportOnlyEntries,
  decideSweepAction,
  normalizeLookupError,
  selectSweepCandidates,
  SWEEP_CANDIDATE_STATUSES,
  SWEEP_REPORT_ONLY_STATUSES,
  type SweepDecision,
  type SweepLookupOutcome,
  type SweepReportOnlyCounts,
} from './saleIntentSweepLogic';
import type { SaleIntentEntry } from './saleIntentJournalTypes';

/** Minimal journal surface the sweep runner depends on (Packet 1 public API only). */
export type SaleIntentSweepJournalDeps = Pick<
  SaleIntentJournal,
  'listSaleIntentsByStatus' | 'markServerAcknowledged' | 'recordSaleIntentEvent'
>;

export type SaleIntentSweepLookupResult = { exists: boolean };

export type SaleIntentSweepDeps = {
  journal: SaleIntentSweepJournalDeps;
  /** Read-only existence check against the server; never a write. */
  lookupAsyncOrder: (asyncOrderId: string) => Promise<SaleIntentSweepLookupResult>;
  now?: () => number;
  thresholdMs?: number;
  batchLimit?: number;
};

export type SaleIntentSweepOutcome = {
  scanned: number;
  candidatesConsidered: number;
  acknowledged: number;
  ambiguousMissing: number;
  ambiguousLookupError: number;
  exceptionObservedServerExists: number;
  reportOnly: SweepReportOnlyCounts;
  failedOpen: boolean;
};

function emptyOutcome(): SaleIntentSweepOutcome {
  return {
    scanned: 0,
    candidatesConsidered: 0,
    acknowledged: 0,
    ambiguousMissing: 0,
    ambiguousLookupError: 0,
    exceptionObservedServerExists: 0,
    reportOnly: { rejectedByRules: 0, manualReview: 0 },
    failedOpen: false,
  };
}

async function safeLookup(
  lookupAsyncOrder: SaleIntentSweepDeps['lookupAsyncOrder'],
  asyncOrderId: string,
): Promise<SweepLookupOutcome> {
  try {
    const result = await lookupAsyncOrder(asyncOrderId);
    return result.exists ? { kind: 'exists' } : { kind: 'missing' };
  } catch (err) {
    return normalizeLookupError(err);
  }
}

async function applySweepDecision(
  journal: SaleIntentSweepJournalDeps,
  entry: SaleIntentEntry,
  decision: SweepDecision,
  outcome: SaleIntentSweepOutcome,
): Promise<void> {
  try {
    switch (decision) {
      case 'acknowledge_server_exists': {
        const result = await journal.markServerAcknowledged(entry.asyncOrderId);
        if (result.ok) outcome.acknowledged += 1;
        break;
      }
      case 'no_transition_exception_observed_server_exists': {
        await journal.recordSaleIntentEvent(entry.asyncOrderId, 'exception_observed', {
          phase: 'sweep',
          outcome: 'server_exists_no_transition',
        });
        outcome.exceptionObservedServerExists += 1;
        break;
      }
      case 'no_transition_missing_ambiguous':
        outcome.ambiguousMissing += 1;
        break;
      case 'no_transition_lookup_error':
        outcome.ambiguousLookupError += 1;
        break;
    }
  } catch {
    // fail open — a single entry's transition failure must not abort the sweep.
  }
}

async function readReportOnlyCounts(
  journal: SaleIntentSweepJournalDeps,
): Promise<SweepReportOnlyCounts> {
  try {
    const result = await journal.listSaleIntentsByStatus([...SWEEP_REPORT_ONLY_STATUSES]);
    return result.ok ? countReportOnlyEntries(result.value) : { rejectedByRules: 0, manualReview: 0 };
  } catch {
    return { rejectedByRules: 0, manualReview: 0 };
  }
}

/**
 * Sidecar lifecycle sweep: classifies stale queued/flushed_to_cache/exception_observed
 * Sale Intents against a read-only server lookup and applies only matrix-legal,
 * bounded, fail-open transitions. Not invoked anywhere yet — unwired by design.
 */
export async function runSaleIntentSweep(deps: SaleIntentSweepDeps): Promise<SaleIntentSweepOutcome> {
  const outcome = emptyOutcome();

  try {
    const nowMs = (deps.now ?? Date.now)();

    const listResult = await deps.journal.listSaleIntentsByStatus([...SWEEP_CANDIDATE_STATUSES]);
    if (!listResult.ok) {
      outcome.failedOpen = true;
      return outcome;
    }

    const entries = listResult.value;
    outcome.scanned = entries.length;

    outcome.reportOnly = await readReportOnlyCounts(deps.journal);

    const candidates = selectSweepCandidates(entries, {
      nowMs,
      thresholdMs: deps.thresholdMs,
      batchLimit: deps.batchLimit,
    });
    outcome.candidatesConsidered = candidates.length;

    for (const entry of candidates) {
      const lookupOutcome = await safeLookup(deps.lookupAsyncOrder, entry.asyncOrderId);
      const decision = decideSweepAction(entry, lookupOutcome);
      await applySweepDecision(deps.journal, entry, decision, outcome);
    }
  } catch {
    outcome.failedOpen = true;
  }

  return outcome;
}
