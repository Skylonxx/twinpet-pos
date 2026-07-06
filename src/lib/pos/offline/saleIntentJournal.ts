import {
  applyTransitionPatch,
  buildSaleIntentEntry,
  eventTypeForStatus,
  formatSaleIntentEventKey,
  isTransitionAllowed,
  parseSaleIntentEventKey,
  sanitizeSaleIntentErrorMessage,
  sanitizeSaleIntentEventDetails,
  selectPrunePlan,
  stripEntryPayload,
} from './saleIntentJournalLogic';
import {
  createIndexedDbSaleIntentJournalStore,
  createInMemorySaleIntentJournalStore,
  SALE_INTENT_JOURNAL_DB_VERSION,
  type SaleIntentJournalStore,
} from './saleIntentJournalStore';
import type {
  EnqueueSaleIntentInput,
  JournalResult,
  PruneOptions,
  PruneOutcome,
  SaleIntentEntry,
  SaleIntentEvent,
  SaleIntentEventType,
  SaleIntentJournalMeta,
  SaleIntentJournalStatus,
  TransitionMetadata,
} from './saleIntentJournalTypes';
import { SALE_INTENT_META_KEY } from './saleIntentJournalTypes';

export { openSaleIntentJournalDb } from './saleIntentJournalStore';

export type SaleIntentJournal = {
  enqueueSaleIntent: (input: EnqueueSaleIntentInput) => Promise<JournalResult<SaleIntentEntry>>;
  getSaleIntent: (asyncOrderId: string) => Promise<JournalResult<SaleIntentEntry | undefined>>;
  listSaleIntentsByStatus: (
    statuses: SaleIntentJournalStatus[],
  ) => Promise<JournalResult<SaleIntentEntry[]>>;
  listSaleIntentEvents: (asyncOrderId: string) => Promise<JournalResult<SaleIntentEvent[]>>;
  transitionStatus: (
    asyncOrderId: string,
    next: SaleIntentJournalStatus,
    metadata?: TransitionMetadata,
  ) => Promise<JournalResult<SaleIntentEntry>>;
  recordSaleIntentEvent: (
    asyncOrderId: string,
    eventType: SaleIntentEventType,
    details?: Readonly<Record<string, unknown>>,
  ) => Promise<JournalResult<SaleIntentEvent>>;
  markFlushedToCache: (asyncOrderId: string) => Promise<JournalResult<SaleIntentEntry>>;
  markServerAcknowledged: (
    asyncOrderId: string,
    metadata?: TransitionMetadata,
  ) => Promise<JournalResult<SaleIntentEntry>>;
  markRejectedByRules: (
    asyncOrderId: string,
    error: unknown,
    metadata?: TransitionMetadata,
  ) => Promise<JournalResult<SaleIntentEntry>>;
  markManualReview: (
    asyncOrderId: string,
    reason: string,
  ) => Promise<JournalResult<SaleIntentEntry>>;
  pruneSaleIntents: (options?: PruneOptions) => Promise<JournalResult<PruneOutcome>>;
  getJournalMeta: () => Promise<JournalResult<SaleIntentJournalMeta | undefined>>;
  setJournalMeta: (
    patch: Partial<SaleIntentJournalMeta>,
  ) => Promise<JournalResult<SaleIntentJournalMeta>>;
};

export type SaleIntentJournalDeps = {
  store?: SaleIntentJournalStore;
  now?: () => Date;
};

function defaultNow(): Date {
  return new Date();
}

function unavailable<T>(): JournalResult<T> {
  return { ok: false, code: 'unavailable', message: 'IndexedDB unavailable' };
}

function txFailed<T>(message: string): JournalResult<T> {
  return { ok: false, code: 'tx_failed', message };
}

function quota<T>(): JournalResult<T> {
  return { ok: false, code: 'quota', message: 'QuotaExceededError' };
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'QuotaExceededError';
}

async function runStore<T>(
  store: SaleIntentJournalStore | undefined,
  fn: (store: SaleIntentJournalStore) => Promise<JournalResult<T>>,
): Promise<JournalResult<T>> {
  if (!store) return unavailable<T>();
  try {
    return await fn(store);
  } catch (err) {
    if (isQuotaError(err)) return quota<T>();
    if (err instanceof Error && err.message === 'IndexedDB unavailable') return unavailable<T>();
    return txFailed<T>(err instanceof Error ? err.message : String(err));
  }
}

function defaultMeta(): SaleIntentJournalMeta {
  return {
    schemaVersion: SALE_INTENT_JOURNAL_DB_VERSION,
    deviceId: null,
    lastPruneAt: null,
    lastPruneOutcome: null,
  };
}

function appendEvent(
  entry: SaleIntentEntry,
  eventType: SaleIntentEventType,
  now: () => Date,
  details?: Readonly<Record<string, unknown>>,
): { entry: SaleIntentEntry; event: SaleIntentEvent; eventKey: string } {
  const eventSeq = entry.nextEventSeq;
  const timestamp = now().toISOString();
  const sanitizedDetails = sanitizeSaleIntentEventDetails(details);
  const event: SaleIntentEvent = {
    asyncOrderId: entry.asyncOrderId,
    eventSeq,
    timestamp,
    eventType,
    ...(sanitizedDetails ? { details: sanitizedDetails } : {}),
  };
  const nextEntry: SaleIntentEntry = {
    ...entry,
    nextEventSeq: eventSeq + 1,
    updatedAtLocal: timestamp,
  };
  return {
    entry: nextEntry,
    event,
    eventKey: formatSaleIntentEventKey(entry.asyncOrderId, eventSeq),
  };
}

export function createSaleIntentJournal(deps?: SaleIntentJournalDeps): SaleIntentJournal {
  const store = deps?.store ?? createIndexedDbSaleIntentJournalStore();
  const now = deps?.now ?? defaultNow;
  return buildJournalApi(store, now);
}

export function createInMemorySaleIntentJournal(deps?: SaleIntentJournalDeps): SaleIntentJournal & {
  dump: () => Record<string, Record<string, unknown>>;
} {
  const memory =
    (deps?.store as ReturnType<typeof createInMemorySaleIntentJournalStore> | undefined) ??
    createInMemorySaleIntentJournalStore();
  const now = deps?.now ?? defaultNow;
  const api = buildJournalApi(memory, now);
  return {
    ...api,
    dump: () => memory.dump(),
  };
}

function buildJournalApi(store: SaleIntentJournalStore, now: () => Date): SaleIntentJournal {
  const transitionStatus = async (
    asyncOrderId: string,
    next: SaleIntentJournalStatus,
    metadata?: TransitionMetadata,
  ): Promise<JournalResult<SaleIntentEntry>> =>
    runStore(store, async (s) => {
      try {
        const value = await s.transact(['saleIntents', 'saleIntentEvents'], 'readwrite', async (txn) => {
          const existing = await txn.get<SaleIntentEntry>('saleIntents', asyncOrderId);
          if (!existing) throw new Error('not_found');
          if (!isTransitionAllowed(existing.status, next)) {
            throw new Error(`illegal_transition:${existing.status}:${next}`);
          }
          const patched = applyTransitionPatch(existing, next, metadata, now);
          const appended = appendEvent(patched, eventTypeForStatus(next), now);
          await txn.put('saleIntents', asyncOrderId, appended.entry);
          await txn.put('saleIntentEvents', appended.eventKey, appended.event);
          return appended.entry;
        });
        return { ok: true, value };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'not_found') return { ok: false, code: 'not_found' };
        if (message.startsWith('illegal_transition:')) {
          const [, from, to] = message.split(':');
          return {
            ok: false,
            code: 'illegal_transition',
            from: from as SaleIntentJournalStatus,
            to: to as SaleIntentJournalStatus,
          };
        }
        throw err;
      }
    });

  return {
    enqueueSaleIntent: (input) =>
      runStore(store, async (s) => {
        const entry = buildSaleIntentEntry(input, now);
        try {
          const value = await s.transact(['saleIntents', 'saleIntentEvents'], 'readwrite', async (txn) => {
            const existing = await txn.get<SaleIntentEntry>('saleIntents', entry.asyncOrderId);
            if (existing) throw new Error('duplicate');
            const appended = appendEvent(entry, 'enqueued', now);
            await txn.put('saleIntents', entry.asyncOrderId, appended.entry);
            await txn.put('saleIntentEvents', appended.eventKey, appended.event);
            return appended.entry;
          });
          return { ok: true, value };
        } catch (err) {
          if (err instanceof Error && err.message === 'duplicate') {
            return { ok: false, code: 'duplicate' };
          }
          throw err;
        }
      }),

    getSaleIntent: (asyncOrderId) =>
      runStore(store, async (s) => {
        const value = await s.transact(['saleIntents'], 'readonly', async (txn) =>
          txn.get<SaleIntentEntry>('saleIntents', asyncOrderId),
        );
        return { ok: true, value };
      }),

    listSaleIntentsByStatus: (statuses) =>
      runStore(store, async (s) => {
        const value = await s.transact(['saleIntents'], 'readonly', async (txn) => {
          const all = await txn.getAll<SaleIntentEntry>('saleIntents');
          return all
            .filter((entry) => statuses.includes(entry.status))
            .sort(
              (a, b) =>
                a.createdAtLocal - b.createdAtLocal || a.asyncOrderId.localeCompare(b.asyncOrderId),
            );
        });
        return { ok: true, value };
      }),

    listSaleIntentEvents: (asyncOrderId) =>
      runStore(store, async (s) => {
        const value = await s.transact(['saleIntentEvents'], 'readonly', async (txn) => {
          const all = await txn.getAll<SaleIntentEvent>('saleIntentEvents');
          return all
            .filter((event) => event.asyncOrderId === asyncOrderId)
            .sort((a, b) => a.eventSeq - b.eventSeq);
        });
        return { ok: true, value };
      }),

    transitionStatus,

    recordSaleIntentEvent: (asyncOrderId, eventType, details) =>
      runStore(store, async (s) => {
        try {
          const value = await s.transact(['saleIntents', 'saleIntentEvents'], 'readwrite', async (txn) => {
            const existing = await txn.get<SaleIntentEntry>('saleIntents', asyncOrderId);
            if (!existing) throw new Error('not_found');
            const appended = appendEvent(existing, eventType, now, details);
            await txn.put('saleIntents', asyncOrderId, appended.entry);
            await txn.put('saleIntentEvents', appended.eventKey, appended.event);
            return appended.event;
          });
          return { ok: true, value };
        } catch (err) {
          if (err instanceof Error && err.message === 'not_found') {
            return { ok: false, code: 'not_found' };
          }
          throw err;
        }
      }),

    markFlushedToCache: (asyncOrderId) => transitionStatus(asyncOrderId, 'flushed_to_cache'),

    markServerAcknowledged: (asyncOrderId, metadata) =>
      transitionStatus(asyncOrderId, 'server_acknowledged', metadata),

    markRejectedByRules: (asyncOrderId, error, metadata) =>
      transitionStatus(asyncOrderId, 'rejected_by_rules', {
        ...metadata,
        lastErrorMessage: sanitizeSaleIntentErrorMessage(error),
        lastErrorCode: metadata?.lastErrorCode ?? (typeof error === 'object' && error && 'code' in error ? String((error as { code?: string }).code ?? '') : null),
      }),

    markManualReview: (asyncOrderId, reason) =>
      transitionStatus(asyncOrderId, 'manual_review', { manualReviewReason: reason }),

    pruneSaleIntents: (options) =>
      runStore(store, async (s) => {
        const outcome: PruneOutcome = { scanned: 0, strippedPayloads: 0, deletedEntries: 0 };
        const entries = await s.transact(['saleIntents'], 'readonly', async (txn) =>
          txn.getAll<SaleIntentEntry>('saleIntents'),
        );
        outcome.scanned = entries.length;
        const plan = selectPrunePlan(entries, { ...options, now });

        for (const asyncOrderId of plan.stripIds) {
          await s.transact(['saleIntents', 'saleIntentEvents'], 'readwrite', async (txn) => {
            const existing = await txn.get<SaleIntentEntry>('saleIntents', asyncOrderId);
            if (!existing || existing.salePayload == null) return;
            const stripped = stripEntryPayload(existing, now);
            const appended = appendEvent(stripped, 'payload_stripped', now);
            await txn.put('saleIntents', asyncOrderId, appended.entry);
            await txn.put('saleIntentEvents', appended.eventKey, appended.event);
          });
          outcome.strippedPayloads += 1;
        }

        for (const asyncOrderId of plan.deleteIds) {
          await s.transact(['saleIntents', 'saleIntentEvents'], 'readwrite', async (txn) => {
            const events = await txn.getAll<SaleIntentEvent>('saleIntentEvents');
            for (const event of events) {
              if (event.asyncOrderId !== asyncOrderId) continue;
              const key = formatSaleIntentEventKey(event.asyncOrderId, event.eventSeq);
              await txn.delete('saleIntentEvents', key);
            }
            await txn.delete('saleIntents', asyncOrderId);
          });
          outcome.deletedEntries += 1;
        }

        await s.transact(['saleIntentMeta'], 'readwrite', async (txn) => {
          const existing = (await txn.get<SaleIntentJournalMeta>('saleIntentMeta', SALE_INTENT_META_KEY)) ??
            defaultMeta();
          const next: SaleIntentJournalMeta = {
            ...existing,
            lastPruneAt: now().toISOString(),
            lastPruneOutcome: outcome,
          };
          await txn.put('saleIntentMeta', SALE_INTENT_META_KEY, next);
        });

        return { ok: true, value: outcome };
      }),

    getJournalMeta: () =>
      runStore(store, async (s) => {
        const value = await s.transact(['saleIntentMeta'], 'readonly', async (txn) =>
          txn.get<SaleIntentJournalMeta>('saleIntentMeta', SALE_INTENT_META_KEY),
        );
        return { ok: true, value };
      }),

    setJournalMeta: (patch) =>
      runStore(store, async (s) => {
        const value = await s.transact(['saleIntentMeta'], 'readwrite', async (txn) => {
          const existing = (await txn.get<SaleIntentJournalMeta>('saleIntentMeta', SALE_INTENT_META_KEY)) ??
            defaultMeta();
          const next = { ...existing, ...patch };
          await txn.put('saleIntentMeta', SALE_INTENT_META_KEY, next);
          return next;
        });
        return { ok: true, value };
      }),
  };
}

export { parseSaleIntentEventKey };
