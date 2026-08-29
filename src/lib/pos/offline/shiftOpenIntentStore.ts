/**
 * PK-1 — IndexedDB-backed shift-open intent journal.
 * Modeled on `shiftCloseIntentStore.ts` but intentionally narrower (no OBS-B2 pointer repair).
 */
import type {
  ClaimRemoteCreateAttemptResult,
  OpenIntentErrorCode,
  OpenIntentResult,
  ShiftOpenIntentBusinessSnapshot,
  ShiftOpenIntentEntry,
  ShiftOpenIntentStatus,
  ShiftOpenRemoteCreateState,
} from './shiftOpenIntentTypes';
import { SHIFT_OPEN_INTENT_STALE_AGE_MS } from './shiftOpenIntentTypes';
import {
  getCommittedDurableStore,
  nativeTxnGet,
  nativeTxnGetAll,
  nativeTxnGetAllKeys,
  nativeTxnPut,
  registerDomainDumper,
} from '../../platform/durableStore/bootDurableStore';

export { SHIFT_OPEN_INTENT_STALE_AGE_MS };

type ShiftOpenIntentStoreName = 'shiftOpenIntents';
const SHIFT_OPEN_INTENT_STORES: ShiftOpenIntentStoreName[] = ['shiftOpenIntents'];

interface ShiftOpenIntentTxn {
  get<T>(store: ShiftOpenIntentStoreName, key: string): Promise<T | undefined>;
  getAll<T>(store: ShiftOpenIntentStoreName): Promise<T[]>;
  getAllKeys(store: ShiftOpenIntentStoreName): Promise<string[]>;
  put(store: ShiftOpenIntentStoreName, key: string, value: unknown): Promise<void>;
}

interface ShiftOpenIntentKvStore {
  transact<T>(
    stores: ShiftOpenIntentStoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (txn: ShiftOpenIntentTxn) => Promise<T>,
  ): Promise<T>;
}

export const SHIFT_OPEN_INTENT_DB_NAME = 'twinpet-shift-open-intent';
export const SHIFT_OPEN_INTENT_DB_VERSION = 1;

function openShiftOpenIntentDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(SHIFT_OPEN_INTENT_DB_NAME, SHIFT_OPEN_INTENT_DB_VERSION);
      req.onupgradeneeded = () => {
        const dbi = req.result;
        for (const s of SHIFT_OPEN_INTENT_STORES) {
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

export function createIndexedDbShiftOpenIntentStore(): ShiftOpenIntentKvStore {
  const native = getCommittedDurableStore('twinpet-shift-open-intent');
  if (native) {
    return {
      transact(stores, mode, fn) {
        return native.transact(stores, mode, (txn) =>
          fn({
            get: (store, key) => nativeTxnGet(txn, store, key),
            getAll: (store) => nativeTxnGetAll(txn, store),
            getAllKeys: (store) =>
              nativeTxnGetAllKeys(txn, store).then((keys) =>
                keys.map((key) => {
                  if (typeof key !== 'string') throw new Error('shift-open native key must be a string');
                  return key;
                }),
              ),
            put: (store, key, value) => nativeTxnPut(txn, store, key, value),
          }),
        );
      },
    };
  }
  return {
    transact<T>(
      stores: ShiftOpenIntentStoreName[],
      mode: 'readonly' | 'readwrite',
      fn: (txn: ShiftOpenIntentTxn) => Promise<T>,
    ): Promise<T> {
      return openShiftOpenIntentDb().then(
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

            const txn: ShiftOpenIntentTxn = {
              get: (store, key) => reqP(tx.objectStore(store).get(key)),
              getAll: (store) => reqP(tx.objectStore(store).getAll()),
              getAllKeys: (store) =>
                reqP(tx.objectStore(store).getAllKeys()).then((keys) =>
                  keys.map((key) => {
                    if (typeof key !== 'string') {
                      throw new Error(`shift-open store "${store}" returned a non-string key`);
                    }
                    return key;
                  }),
                ),
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

export function createInMemoryShiftOpenIntentStore(): ShiftOpenIntentKvStore & {
  dump(): Record<ShiftOpenIntentStoreName, Record<string, unknown>>;
} {
  const data: Record<ShiftOpenIntentStoreName, Map<string, unknown>> = {
    shiftOpenIntents: new Map(),
  };

  const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

  return {
    async transact<T>(
      stores: ShiftOpenIntentStoreName[],
      mode: 'readonly' | 'readwrite',
      fn: (txn: ShiftOpenIntentTxn) => Promise<T>,
    ): Promise<T> {
      const working = new Map<ShiftOpenIntentStoreName, Map<string, unknown>>();
      for (const s of stores) {
        const copy = new Map<string, unknown>();
        for (const [k, v] of data[s]) copy.set(k, clone(v));
        working.set(s, copy);
      }
      const ensure = (store: ShiftOpenIntentStoreName): Map<string, unknown> => {
        const m = working.get(store);
        if (!m) throw new Error(`store "${store}" not in transaction scope`);
        return m;
      };

      const txn: ShiftOpenIntentTxn = {
        async get<R>(store: ShiftOpenIntentStoreName, key: string): Promise<R | undefined> {
          return clone(ensure(store).get(key)) as R | undefined;
        },
        async getAll<R>(store: ShiftOpenIntentStoreName): Promise<R[]> {
          return [...ensure(store).values()].map((v) => clone(v)) as R[];
        },
        async getAllKeys(store: ShiftOpenIntentStoreName): Promise<string[]> {
          return [...ensure(store).keys()];
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
      const out = {} as Record<ShiftOpenIntentStoreName, Record<string, unknown>>;
      for (const s of SHIFT_OPEN_INTENT_STORES) {
        out[s] = {};
        for (const [k, v] of data[s]) out[s][k] = v;
      }
      return out;
    },
  };
}

const BUSINESS_SNAPSHOT_FIELDS: (keyof ShiftOpenIntentBusinessSnapshot)[] = [
  'shiftId',
  'branchId',
  'staffId',
  'staffName',
  'startingCash',
  'deviceId',
];

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isValidLocalTimestamp(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0;
}

function businessEquals(
  a: ShiftOpenIntentBusinessSnapshot,
  b: ShiftOpenIntentBusinessSnapshot,
): boolean {
  return BUSINESS_SNAPSHOT_FIELDS.every((f) => a[f] === b[f]);
}

/**
 * Normalize durable create-attempt state. Legacy records without the field are
 * treated as `outstanding` (fail closed — do not reissue a W0 create).
 */
export function normalizeRemoteCreateState(raw: unknown): ShiftOpenRemoteCreateState {
  return raw === 'none' ? 'none' : 'outstanding';
}

function isOpenIntentEntry(v: unknown): v is ShiftOpenIntentEntry {
  if (!isPlainRecord(v)) return false;
  if (typeof v.shiftId !== 'string' || v.shiftId.length === 0) return false;
  if (typeof v.branchId !== 'string') return false;
  if (typeof v.staffId !== 'string') return false;
  if (typeof v.staffName !== 'string') return false;
  if (!isFiniteNumber(v.startingCash) || v.startingCash < 0) return false;
  if (!(typeof v.deviceId === 'string' || v.deviceId === null)) return false;
  if (!isValidLocalTimestamp(v.openedAtLocal)) return false;
  if (
    v.status !== 'local_open_pending' &&
    v.status !== 'synced' &&
    v.status !== 'rejected_manual_attention'
  ) {
    return false;
  }
  // Absent remoteCreateState is allowed (legacy) and normalized on read.
  if (
    v.remoteCreateState !== undefined &&
    v.remoteCreateState !== 'none' &&
    v.remoteCreateState !== 'outstanding'
  ) {
    return false;
  }
  if (!isValidLocalTimestamp(v.createdAtLocal)) return false;
  if (!isValidLocalTimestamp(v.updatedAtLocal)) return false;
  if (!(typeof v.lastErrorMessage === 'string' || v.lastErrorMessage === null)) return false;
  return true;
}

function coerceOpenIntentEntry(raw: ShiftOpenIntentEntry): ShiftOpenIntentEntry {
  return {
    ...raw,
    remoteCreateState: normalizeRemoteCreateState(raw.remoteCreateState),
  };
}

export type ListOpenIntentsResult =
  | { ok: true; value: ShiftOpenIntentEntry[] }
  | { ok: false; code: OpenIntentErrorCode; message?: string };

export type ShiftOpenIntentJournal = {
  upsertOpenIntent: (
    snapshot: ShiftOpenIntentBusinessSnapshot,
  ) => Promise<OpenIntentResult<ShiftOpenIntentEntry>>;
  getOpenIntent: (shiftId: string) => Promise<OpenIntentResult<ShiftOpenIntentEntry | undefined>>;
  listOpenIntents: () => Promise<ListOpenIntentsResult>;
  findPendingOpenForStaff: (
    branchId: string,
    staffId: string,
    deviceId: string | null,
  ) => Promise<OpenIntentResult<ShiftOpenIntentEntry | undefined>>;
  findRejectedOpenForDevice: (
    deviceId: string | null,
  ) => Promise<OpenIntentResult<ShiftOpenIntentEntry | undefined>>;
  /**
   * CAS: `none` → `outstanding`. Only the winner may enqueue a W0 create.
   * Idempotent observe of `outstanding` returns `already_outstanding`.
   */
  claimRemoteCreateAttempt: (
    shiftId: string,
  ) => Promise<OpenIntentResult<ClaimRemoteCreateAttemptResult>>;
  markSynced: (shiftId: string) => Promise<OpenIntentResult<ShiftOpenIntentEntry>>;
  markRejectedManualAttention: (
    shiftId: string,
    reason: string,
  ) => Promise<OpenIntentResult<ShiftOpenIntentEntry>>;
};

export type ShiftOpenIntentJournalDeps = {
  store?: ShiftOpenIntentKvStore;
  now?: () => number;
};

function defaultNow(): number {
  return Date.now();
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'QuotaExceededError';
}

function unavailable<T>(): OpenIntentResult<T> {
  return { ok: false, code: 'unavailable', message: 'IndexedDB unavailable' };
}
function quota<T>(): OpenIntentResult<T> {
  return { ok: false, code: 'quota', message: 'QuotaExceededError' };
}
function txFailed<T>(message: string): OpenIntentResult<T> {
  return { ok: false, code: 'tx_failed', message };
}
function conflict<T>(message: string): OpenIntentResult<T> {
  return { ok: false, code: 'conflict', message };
}
function notFound<T>(): OpenIntentResult<T> {
  return { ok: false, code: 'not_found' };
}

async function runStore<T>(
  store: ShiftOpenIntentKvStore | undefined,
  fn: (store: ShiftOpenIntentKvStore) => Promise<OpenIntentResult<T>>,
): Promise<OpenIntentResult<T>> {
  if (!store) return unavailable<T>();
  try {
    return await fn(store);
  } catch (err) {
    if (isQuotaError(err)) return quota<T>();
    if (err instanceof Error && err.message === 'IndexedDB unavailable') return unavailable<T>();
    return txFailed<T>(err instanceof Error ? err.message : String(err));
  }
}

async function runListStore(
  store: ShiftOpenIntentKvStore | undefined,
  fn: (store: ShiftOpenIntentKvStore) => Promise<ListOpenIntentsResult>,
): Promise<ListOpenIntentsResult> {
  if (!store) return unavailable<ShiftOpenIntentEntry[]>();
  try {
    return await fn(store);
  } catch (err) {
    if (isQuotaError(err)) return quota<ShiftOpenIntentEntry[]>();
    if (err instanceof Error && err.message === 'IndexedDB unavailable') {
      return unavailable<ShiftOpenIntentEntry[]>();
    }
    return txFailed<ShiftOpenIntentEntry[]>(err instanceof Error ? err.message : String(err));
  }
}

function buildJournalApi(store: ShiftOpenIntentKvStore, now: () => number): ShiftOpenIntentJournal {
  const markStatus = (
    shiftId: string,
    status: ShiftOpenIntentStatus,
    lastErrorMessage: string | null,
  ): Promise<OpenIntentResult<ShiftOpenIntentEntry>> =>
    runStore(store, async (s) => {
      const result = await s.transact(['shiftOpenIntents'], 'readwrite', async (txn) => {
        const existingRaw = await txn.get<Record<string, unknown>>('shiftOpenIntents', shiftId);
        if (!existingRaw) return notFound<ShiftOpenIntentEntry>();
        if (!isOpenIntentEntry(existingRaw)) {
          return conflict<ShiftOpenIntentEntry>(
            `Stored open-intent for shift "${shiftId}" is unreadable — status not updated.`,
          );
        }
        const existing = coerceOpenIntentEntry(existingRaw);
        if (existing.status === status) {
          return { ok: true as const, value: existing };
        }
        if (existing.status !== 'local_open_pending' && status !== existing.status) {
          return conflict<ShiftOpenIntentEntry>(
            `Cannot transition open-intent "${shiftId}" from ${existing.status} to ${status}.`,
          );
        }
        const next: ShiftOpenIntentEntry = {
          ...existing,
          status,
          lastErrorMessage,
          updatedAtLocal: now(),
        };
        await txn.put('shiftOpenIntents', shiftId, next);
        return { ok: true as const, value: next };
      });
      return result;
    });

  return {
    upsertOpenIntent: (snapshot) =>
      runStore(store, async (s) => {
        const result = await s.transact(['shiftOpenIntents'], 'readwrite', async (txn) => {
          const existingRaw = await txn.get<unknown>('shiftOpenIntents', snapshot.shiftId);
          const nowMs = now();

          if (existingRaw !== undefined) {
            if (!isOpenIntentEntry(existingRaw)) {
              return conflict<ShiftOpenIntentEntry>(
                `Stored open-intent for shift "${snapshot.shiftId}" is unreadable.`,
              );
            }
            const existing = coerceOpenIntentEntry(existingRaw);
            if (existing.status === 'rejected_manual_attention') {
              return conflict<ShiftOpenIntentEntry>(
                'Open intent for this shift requires manual attention and cannot be retried silently.',
              );
            }
            if (!businessEquals(existing, snapshot)) {
              return conflict<ShiftOpenIntentEntry>(
                'A different open intent already exists for this shift id.',
              );
            }
            // Idempotent resume — preserve openedAtLocal / createdAtLocal / remoteCreateState.
            if (existing.status === 'local_open_pending' || existing.status === 'synced') {
              return { ok: true as const, value: existing };
            }
          }

          const entry: ShiftOpenIntentEntry = {
            ...snapshot,
            openedAtLocal: nowMs,
            status: 'local_open_pending',
            remoteCreateState: 'none',
            createdAtLocal: nowMs,
            updatedAtLocal: nowMs,
            lastErrorMessage: null,
          };
          await txn.put('shiftOpenIntents', snapshot.shiftId, entry);
          return { ok: true as const, value: entry };
        });
        return result;
      }),

    getOpenIntent: (shiftId) =>
      runStore(store, async (s) => {
        const raw = await s.transact(['shiftOpenIntents'], 'readonly', (txn) =>
          txn.get<unknown>('shiftOpenIntents', shiftId),
        );
        if (raw === undefined) return { ok: true, value: undefined };
        if (!isOpenIntentEntry(raw)) {
          return conflict<ShiftOpenIntentEntry | undefined>(
            `Stored open-intent for shift "${shiftId}" is unreadable.`,
          );
        }
        return { ok: true, value: coerceOpenIntentEntry(raw) };
      }),

    listOpenIntents: () =>
      runListStore(store, async (s) => {
        const records = await s.transact(['shiftOpenIntents'], 'readonly', (txn) =>
          txn.getAll<unknown>('shiftOpenIntents'),
        );
        const entries: ShiftOpenIntentEntry[] = [];
        for (const raw of records) {
          if (!isOpenIntentEntry(raw)) {
            return {
              ok: false,
              code: 'tx_failed',
              message: 'Unreadable open-intent record in store',
            };
          }
          entries.push(coerceOpenIntentEntry(raw));
        }
        return { ok: true, value: entries };
      }),

    findPendingOpenForStaff: (branchId, staffId, deviceId) =>
      runStore(store, async (s) => {
        const listed = await s.transact(['shiftOpenIntents'], 'readonly', (txn) =>
          txn.getAll<unknown>('shiftOpenIntents'),
        );
        for (const raw of listed) {
          if (!isOpenIntentEntry(raw)) continue;
          const entry = coerceOpenIntentEntry(raw);
          if (
            entry.status === 'local_open_pending' &&
            entry.branchId === branchId &&
            entry.staffId === staffId &&
            entry.deviceId === deviceId
          ) {
            return { ok: true, value: entry };
          }
        }
        return { ok: true, value: undefined };
      }),

    findRejectedOpenForDevice: (deviceId) =>
      runStore(store, async (s) => {
        const listed = await s.transact(['shiftOpenIntents'], 'readonly', (txn) =>
          txn.getAll<unknown>('shiftOpenIntents'),
        );
        for (const raw of listed) {
          if (!isOpenIntentEntry(raw)) continue;
          const entry = coerceOpenIntentEntry(raw);
          if (entry.status === 'rejected_manual_attention' && entry.deviceId === deviceId) {
            return { ok: true, value: entry };
          }
        }
        return { ok: true, value: undefined };
      }),

    claimRemoteCreateAttempt: (shiftId) =>
      runStore(store, async (s) => {
        const result = await s.transact(['shiftOpenIntents'], 'readwrite', async (txn) => {
          const existingRaw = await txn.get<unknown>('shiftOpenIntents', shiftId);
          if (!existingRaw) return notFound<ClaimRemoteCreateAttemptResult>();
          if (!isOpenIntentEntry(existingRaw)) {
            return conflict<ClaimRemoteCreateAttemptResult>(
              `Stored open-intent for shift "${shiftId}" is unreadable — create claim denied.`,
            );
          }
          const existing = coerceOpenIntentEntry(existingRaw);
          if (existing.status !== 'local_open_pending') {
            return conflict<ClaimRemoteCreateAttemptResult>(
              `Cannot claim create attempt for open-intent "${shiftId}" in status ${existing.status}.`,
            );
          }
          if (existing.remoteCreateState === 'outstanding') {
            return { ok: true as const, value: 'already_outstanding' as const };
          }
          const next: ShiftOpenIntentEntry = {
            ...existing,
            remoteCreateState: 'outstanding',
            updatedAtLocal: now(),
          };
          await txn.put('shiftOpenIntents', shiftId, next);
          return { ok: true as const, value: 'claimed' as const };
        });
        return result;
      }),

    markSynced: (shiftId) => markStatus(shiftId, 'synced', null),

    markRejectedManualAttention: (shiftId, reason) =>
      markStatus(shiftId, 'rejected_manual_attention', reason),
  };
}

export function createShiftOpenIntentJournal(
  deps?: ShiftOpenIntentJournalDeps,
): ShiftOpenIntentJournal {
  const store = deps?.store ?? createIndexedDbShiftOpenIntentStore();
  return buildJournalApi(store, deps?.now ?? defaultNow);
}

export function createInMemoryShiftOpenIntentJournal(
  deps?: Omit<ShiftOpenIntentJournalDeps, 'store'> & {
    store?: ReturnType<typeof createInMemoryShiftOpenIntentStore>;
  },
): ShiftOpenIntentJournal & { store: ReturnType<typeof createInMemoryShiftOpenIntentStore> } {
  const mem = deps?.store ?? createInMemoryShiftOpenIntentStore();
  const journal = buildJournalApi(mem, deps?.now ?? defaultNow);
  return Object.assign(journal, { store: mem });
}

export function isStaleOpenPending(entry: ShiftOpenIntentEntry, nowMs: number = Date.now()): boolean {
  return (
    entry.status === 'local_open_pending' &&
    nowMs - entry.openedAtLocal >= SHIFT_OPEN_INTENT_STALE_AGE_MS
  );
}

registerDomainDumper('shiftOpen', async () => {
  const store = createIndexedDbShiftOpenIntentStore();
  return store.transact(['shiftOpenIntents'], 'readonly', async (txn) => {
    const rows: Array<{ store: string; key: string; value: unknown }> = [];
    for (const key of await txn.getAllKeys('shiftOpenIntents')) {
      rows.push({ store: 'shiftOpenIntents', key, value: await txn.get('shiftOpenIntents', key) });
    }
    return rows;
  });
});
