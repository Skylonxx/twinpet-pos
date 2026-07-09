import type {
  CloseIntentResult,
  ShiftCloseIntentEntry,
  ShiftCloseIntentSnapshot,
  ShiftCloseIntentStatus,
} from './shiftCloseIntentTypes';
import { SHIFT_CLOSE_INTENT_STALE_AGE_MS } from './shiftCloseIntentTypes';

// ── Low-level KV store (modeled on saleIntentJournalStore.ts) ──────────────

type ShiftCloseIntentStoreName = 'shiftCloseIntents';
const SHIFT_CLOSE_INTENT_STORES: ShiftCloseIntentStoreName[] = ['shiftCloseIntents'];

interface ShiftCloseIntentTxn {
  get<T>(store: ShiftCloseIntentStoreName, key: string): Promise<T | undefined>;
  getAll<T>(store: ShiftCloseIntentStoreName): Promise<T[]>;
  put(store: ShiftCloseIntentStoreName, key: string, value: unknown): Promise<void>;
}

interface ShiftCloseIntentKvStore {
  transact<T>(
    stores: ShiftCloseIntentStoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (txn: ShiftCloseIntentTxn) => Promise<T>,
  ): Promise<T>;
}

export const SHIFT_CLOSE_INTENT_DB_NAME = 'twinpet-shift-close-intent';
export const SHIFT_CLOSE_INTENT_DB_VERSION = 1;

function openShiftCloseIntentDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(SHIFT_CLOSE_INTENT_DB_NAME, SHIFT_CLOSE_INTENT_DB_VERSION);
      req.onupgradeneeded = () => {
        const dbi = req.result;
        for (const s of SHIFT_CLOSE_INTENT_STORES) {
          if (!dbi.objectStoreNames.contains(s)) dbi.createObjectStore(s);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function createIndexedDbShiftCloseIntentStore(): ShiftCloseIntentKvStore {
  return {
    transact<T>(
      stores: ShiftCloseIntentStoreName[],
      mode: 'readonly' | 'readwrite',
      fn: (txn: ShiftCloseIntentTxn) => Promise<T>,
    ): Promise<T> {
      return openShiftCloseIntentDb().then(
        (dbi) =>
          new Promise<T>((resolve, reject) => {
            if (!dbi) {
              reject(new Error('IndexedDB unavailable'));
              return;
            }
            let result: T;
            let settled = false;
            const fail = (err: unknown) => {
              if (settled) return;
              settled = true;
              dbi.close();
              reject(err instanceof Error ? err : new Error(String(err)));
            };

            let tx: IDBTransaction;
            try {
              tx = dbi.transaction(stores, mode);
            } catch (err) {
              fail(err);
              return;
            }

            const txn: ShiftCloseIntentTxn = {
              get: (store, key) => reqP(tx.objectStore(store).get(key)),
              getAll: (store) => reqP(tx.objectStore(store).getAll()),
              put: (store, key, value) =>
                reqP(tx.objectStore(store).put(value, key)).then(() => undefined),
            };

            tx.oncomplete = () => {
              if (settled) return;
              settled = true;
              dbi.close();
              resolve(result);
            };
            tx.onabort = () => fail(tx.error ?? new Error('IndexedDB transaction aborted'));

            Promise.resolve()
              .then(() => fn(txn))
              .then((r) => {
                result = r;
              })
              .catch((err) => {
                try {
                  tx.abort();
                } catch {
                  /* already aborting */
                }
                fail(err);
              });
          }),
      );
    },
  };
}

export function createInMemoryShiftCloseIntentStore(): ShiftCloseIntentKvStore & {
  dump(): Record<ShiftCloseIntentStoreName, Record<string, unknown>>;
} {
  const data: Record<ShiftCloseIntentStoreName, Map<string, unknown>> = {
    shiftCloseIntents: new Map(),
  };

  const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

  return {
    async transact<T>(
      stores: ShiftCloseIntentStoreName[],
      mode: 'readonly' | 'readwrite',
      fn: (txn: ShiftCloseIntentTxn) => Promise<T>,
    ): Promise<T> {
      const working = new Map<ShiftCloseIntentStoreName, Map<string, unknown>>();
      for (const s of stores) {
        const copy = new Map<string, unknown>();
        for (const [k, v] of data[s]) copy.set(k, clone(v));
        working.set(s, copy);
      }
      const ensure = (store: ShiftCloseIntentStoreName): Map<string, unknown> => {
        const m = working.get(store);
        if (!m) throw new Error(`store "${store}" not in transaction scope`);
        return m;
      };

      const txn: ShiftCloseIntentTxn = {
        async get<R>(store: ShiftCloseIntentStoreName, key: string): Promise<R | undefined> {
          return clone(ensure(store).get(key)) as R | undefined;
        },
        async getAll<R>(store: ShiftCloseIntentStoreName): Promise<R[]> {
          return [...ensure(store).values()].map((v) => clone(v)) as R[];
        },
        async put(store, key, value) {
          if (mode !== 'readwrite') throw new Error('put in readonly transaction');
          ensure(store).set(key, clone(value));
        },
      };

      const result = await fn(txn);
      if (mode === 'readwrite') {
        for (const s of stores) data[s] = working.get(s)!;
      }
      return result;
    },

    dump() {
      const out = {} as Record<ShiftCloseIntentStoreName, Record<string, unknown>>;
      for (const s of SHIFT_CLOSE_INTENT_STORES) out[s] = Object.fromEntries(data[s]);
      return out;
    },
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/**
 * Explicit snapshot field list — deliberately NOT `Object.keys(a)`, because
 * callers may pass a `ShiftCloseIntentEntry` (a snapshot plus `status`/
 * timestamp fields) as `a`; comparing by the full object's own keys would
 * spuriously fail on those extra fields.
 */
const SNAPSHOT_FIELDS: (keyof ShiftCloseIntentSnapshot)[] = [
  'shiftId',
  'branchId',
  'staffId',
  'staffName',
  'startingCash',
  'expectedCash',
  'expectedQr',
  'expectedKbank',
  'expectedCard',
  'expectedCredit',
  'payInTotal',
  'payOutTotal',
  'totalBills',
  'actualCashCount',
  'variance',
  'note',
  'closedAtLocal',
  'deviceId',
];

/** Field-wise equality over the frozen snapshot only (never status/timestamps). */
export function snapshotsEqual(
  a: ShiftCloseIntentSnapshot,
  b: ShiftCloseIntentSnapshot,
): boolean {
  return SNAPSHOT_FIELDS.every((k) => a[k] === b[k]);
}

/**
 * Purely computed "needs attention" display state — never stored as a
 * transition. A still-pending close-intent older than the threshold reads as
 * stale on any read, without a background sweep or a written status change.
 */
export function isStaleClosePending(
  entry: Pick<ShiftCloseIntentEntry, 'status' | 'closedAtLocal'>,
  nowMs: number,
): boolean {
  if (entry.status !== 'local_closed_pending') return false;
  return nowMs - entry.closedAtLocal >= SHIFT_CLOSE_INTENT_STALE_AGE_MS;
}

// ── Public journal API ──────────────────────────────────────────────────

export type ShiftCloseIntentJournal = {
  upsertCloseIntent: (
    snapshot: ShiftCloseIntentSnapshot,
  ) => Promise<CloseIntentResult<ShiftCloseIntentEntry>>;
  getCloseIntent: (shiftId: string) => Promise<CloseIntentResult<ShiftCloseIntentEntry | undefined>>;
  listCloseIntents: () => Promise<CloseIntentResult<ShiftCloseIntentEntry[]>>;
  markSynced: (shiftId: string) => Promise<CloseIntentResult<ShiftCloseIntentEntry>>;
  markRejectedManualAttention: (
    shiftId: string,
    reason: string,
  ) => Promise<CloseIntentResult<ShiftCloseIntentEntry>>;
};

export type ShiftCloseIntentJournalDeps = {
  store?: ShiftCloseIntentKvStore;
  now?: () => number;
};

function defaultNow(): number {
  return Date.now();
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'QuotaExceededError';
}

function unavailable<T>(): CloseIntentResult<T> {
  return { ok: false, code: 'unavailable', message: 'IndexedDB unavailable' };
}
function quota<T>(): CloseIntentResult<T> {
  return { ok: false, code: 'quota', message: 'QuotaExceededError' };
}
function txFailed<T>(message: string): CloseIntentResult<T> {
  return { ok: false, code: 'tx_failed', message };
}
function conflict<T>(message: string): CloseIntentResult<T> {
  return { ok: false, code: 'conflict', message };
}
function notFound<T>(): CloseIntentResult<T> {
  return { ok: false, code: 'not_found' };
}

async function runStore<T>(
  store: ShiftCloseIntentKvStore | undefined,
  fn: (store: ShiftCloseIntentKvStore) => Promise<CloseIntentResult<T>>,
): Promise<CloseIntentResult<T>> {
  if (!store) return unavailable<T>();
  try {
    return await fn(store);
  } catch (err) {
    if (isQuotaError(err)) return quota<T>();
    if (err instanceof Error && err.message === 'IndexedDB unavailable') return unavailable<T>();
    return txFailed<T>(err instanceof Error ? err.message : String(err));
  }
}

function buildJournalApi(store: ShiftCloseIntentKvStore, now: () => number): ShiftCloseIntentJournal {
  const markStatus = (
    shiftId: string,
    status: ShiftCloseIntentStatus,
    lastErrorMessage: string | null,
  ): Promise<CloseIntentResult<ShiftCloseIntentEntry>> =>
    runStore(store, async (s) =>
      s.transact(['shiftCloseIntents'], 'readwrite', async (txn) => {
        const existing = await txn.get<ShiftCloseIntentEntry>('shiftCloseIntents', shiftId);
        if (!existing) return notFound<ShiftCloseIntentEntry>();
        const nowMs = now();
        const next: ShiftCloseIntentEntry = {
          ...existing,
          status,
          lastErrorMessage,
          updatedAtLocal: nowMs,
        };
        await txn.put('shiftCloseIntents', shiftId, next);
        return { ok: true, value: next };
      }),
    );

  return {
    upsertCloseIntent: (snapshot) =>
      runStore(store, async (s) =>
        s.transact(['shiftCloseIntents'], 'readwrite', async (txn) => {
          const existing = await txn.get<ShiftCloseIntentEntry>('shiftCloseIntents', snapshot.shiftId);
          if (existing) {
            if (snapshotsEqual(existing, snapshot)) {
              // Idempotent: identical retry (e.g. double-click) is a no-op success.
              return { ok: true, value: existing };
            }
            return conflict<ShiftCloseIntentEntry>(
              `A different close-intent already exists locally for shift "${snapshot.shiftId}" — not overwritten.`,
            );
          }
          const nowMs = now();
          const entry: ShiftCloseIntentEntry = {
            ...snapshot,
            status: 'local_closed_pending',
            createdAtLocal: nowMs,
            updatedAtLocal: nowMs,
            lastErrorMessage: null,
          };
          await txn.put('shiftCloseIntents', snapshot.shiftId, entry);
          return { ok: true, value: entry };
        }),
      ),

    getCloseIntent: (shiftId) =>
      runStore(store, async (s) => {
        const value = await s.transact(['shiftCloseIntents'], 'readonly', async (txn) =>
          txn.get<ShiftCloseIntentEntry>('shiftCloseIntents', shiftId),
        );
        return { ok: true, value };
      }),

    listCloseIntents: () =>
      runStore(store, async (s) => {
        const value = await s.transact(['shiftCloseIntents'], 'readonly', async (txn) =>
          txn.getAll<ShiftCloseIntentEntry>('shiftCloseIntents'),
        );
        return { ok: true, value };
      }),

    markSynced: (shiftId) => markStatus(shiftId, 'synced', null),

    markRejectedManualAttention: (shiftId, reason) =>
      markStatus(shiftId, 'rejected_manual_attention', reason),
  };
}

export function createShiftCloseIntentJournal(
  deps?: ShiftCloseIntentJournalDeps,
): ShiftCloseIntentJournal {
  const store = deps?.store ?? createIndexedDbShiftCloseIntentStore();
  const now = deps?.now ?? defaultNow;
  return buildJournalApi(store, now);
}

export function createInMemoryShiftCloseIntentJournal(
  deps?: ShiftCloseIntentJournalDeps,
): ShiftCloseIntentJournal & { dump: () => Record<string, Record<string, unknown>> } {
  const memory =
    (deps?.store as ReturnType<typeof createInMemoryShiftCloseIntentStore> | undefined) ??
    createInMemoryShiftCloseIntentStore();
  const now = deps?.now ?? defaultNow;
  const api = buildJournalApi(memory, now);
  return {
    ...api,
    dump: () => memory.dump(),
  };
}
