/**
 * Offline Reversal Queue — durable local store  [Phase 7B-3D-3]
 *
 * A dedicated IndexedDB database (`twinpet-offline-reversal`) holding four object
 * stores that together make the reversal queue durable and the create/rollback
 * paths atomic:
 *
 *   - `intents`  — the durable reversal queue        (key: intent id)
 *   - `stock`    — local stock counters (product×loc) (key: `${productId}::${loc}`)
 *   - `ledger`   — append-only correction ledger rows (key: deterministic row id)
 *   - `markers`  — local mutation markers / idempotency guard (key: localMutationId)
 *
 * Why a custom store and not Firestore offline persistence: the SKILL-OFFLINE-FIRST
 * note is explicit that "Firestore offline persistence must NOT be the sole
 * durability guarantee" for the native POS, and — critically — the SDK's offline
 * write queue cannot give us an IMMEDIATE local stock-counter correction, a single
 * atomic transaction across queue+stock+ledger+marker, or the manual-review /
 * rollback bookkeeping this phase requires.
 *
 * The raw-IndexedDB pattern (open with a version, create stores in onupgradeneeded,
 * wrap requests in promises) mirrors the existing kv mirror in pos/deviceId.ts — no
 * new dependency is introduced.
 *
 * ATOMICITY: every multi-store operation runs inside ONE `transaction([...], 'readwrite')`.
 * The async transaction callback only ever awaits IndexedDB request promises, which
 * keeps the transaction alive (an IDB transaction stays active across the microtask
 * that resolves a request's onsuccess). Any thrown error aborts the transaction, so
 * a partial create/rollback can never be observed.
 */

/**
 * The object stores. `rejections` (Phase 7B-H7-C) is a forensic, append-style log of
 * pre-queue fail-closed reversal-evidence rejections — independent of the four
 * stock-correction stores and never part of an `intents`/`stock`/`ledger`/`markers`
 * transaction, so it cannot affect reversal-queue atomicity.
 */
export type ReversalStoreName = 'intents' | 'stock' | 'ledger' | 'markers' | 'rejections';

export const REVERSAL_STORES: ReversalStoreName[] = ['intents', 'stock', 'ledger', 'markers', 'rejections'];

/** Per-transaction handle exposed to orchestration code. All ops are out-of-line keyed. */
export interface ReversalTxn {
  get<T>(store: ReversalStoreName, key: string): Promise<T | undefined>;
  getAll<T>(store: ReversalStoreName): Promise<T[]>;
  put(store: ReversalStoreName, key: string, value: unknown): Promise<void>;
  delete(store: ReversalStoreName, key: string): Promise<void>;
}

/** The atomic transactional store contract the orchestration layer depends on. */
export interface ReversalLocalStore {
  transact<T>(
    stores: ReversalStoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (txn: ReversalTxn) => Promise<T>,
  ): Promise<T>;
}

const DB_NAME = 'twinpet-offline-reversal';
// v2 (Phase 7B-H7-C): adds the `rejections` store. The upgrade is additive — the
// `onupgradeneeded` loop only creates stores not already present, so existing
// `intents`/`stock`/`ledger`/`markers` data is preserved across the bump.
const DB_VERSION = 2;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const dbi = req.result;
        for (const s of REVERSAL_STORES) {
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

/** Wrap a single IDBRequest in a promise — resolving in the request's onsuccess
 *  keeps the parent transaction active across the await. */
function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Real IndexedDB-backed store. Returns `null` when IndexedDB is unavailable (SSR /
 * unit-test `node` env) so callers can fall back or skip — exactly how deviceId.ts
 * degrades. Construct once and reuse.
 */
export function createIndexedDbReversalStore(): ReversalLocalStore {
  return {
    transact<T>(
      stores: ReversalStoreName[],
      mode: 'readonly' | 'readwrite',
      fn: (txn: ReversalTxn) => Promise<T>,
    ): Promise<T> {
      return openDb().then(
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

            const txn: ReversalTxn = {
              get: (store, key) => reqP(tx.objectStore(store).get(key)),
              getAll: (store) => reqP(tx.objectStore(store).getAll()),
              put: (store, key, value) => reqP(tx.objectStore(store).put(value, key)).then(() => undefined),
              delete: (store, key) => reqP(tx.objectStore(store).delete(key)).then(() => undefined),
            };

            tx.oncomplete = () => {
              if (settled) return;
              settled = true;
              dbi.close();
              resolve(result);
            };
            tx.onabort = () => fail(tx.error ?? new Error('IndexedDB transaction aborted'));

            // Only awaits IDB request promises inside fn → transaction stays alive.
            // On throw we abort so the partial mutation set is discarded.
            Promise.resolve()
              .then(() => fn(txn))
              .then((r) => {
                result = r;
                // Let the transaction auto-commit once its requests drain.
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

/**
 * In-memory store with the SAME atomic semantics, for unit tests (the `node` test
 * env has no IndexedDB). Mutations are buffered in a working copy and only merged
 * into the backing maps if the transaction callback resolves; a throw discards
 * them — modelling IndexedDB's abort-on-error so atomicity/rollback are testable.
 */
export function createInMemoryReversalStore(): ReversalLocalStore & {
  dump(): Record<ReversalStoreName, Record<string, unknown>>;
} {
  const data: Record<ReversalStoreName, Map<string, unknown>> = {
    intents: new Map(),
    stock: new Map(),
    ledger: new Map(),
    markers: new Map(),
    rejections: new Map(),
  };

  const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

  return {
    async transact<T>(
      stores: ReversalStoreName[],
      mode: 'readonly' | 'readwrite',
      fn: (txn: ReversalTxn) => Promise<T>,
    ): Promise<T> {
      // Working copy of just the touched stores (structured-clone semantics).
      const working = new Map<ReversalStoreName, Map<string, unknown>>();
      for (const s of stores) {
        const copy = new Map<string, unknown>();
        for (const [k, v] of data[s]) copy.set(k, clone(v));
        working.set(s, copy);
      }
      const ensure = (store: ReversalStoreName): Map<string, unknown> => {
        const m = working.get(store);
        if (!m) throw new Error(`store "${store}" not in transaction scope`);
        return m;
      };

      const txn: ReversalTxn = {
        async get<R>(store: ReversalStoreName, key: string): Promise<R | undefined> {
          return clone(ensure(store).get(key)) as R | undefined;
        },
        async getAll<R>(store: ReversalStoreName): Promise<R[]> {
          return [...ensure(store).values()].map((v) => clone(v)) as R[];
        },
        async put(store, key, value) {
          if (mode !== 'readwrite') throw new Error('put in readonly transaction');
          ensure(store).set(key, clone(value));
        },
        async delete(store, key) {
          if (mode !== 'readwrite') throw new Error('delete in readonly transaction');
          ensure(store).delete(key);
        },
      };

      // Throw inside fn → working copy discarded, backing data untouched (abort).
      const result = await fn(txn);
      if (mode === 'readwrite') {
        for (const s of stores) data[s] = working.get(s)!;
      }
      return result;
    },

    dump() {
      const out = {} as Record<ReversalStoreName, Record<string, unknown>>;
      for (const s of REVERSAL_STORES) out[s] = Object.fromEntries(data[s]);
      return out;
    },
  };
}
