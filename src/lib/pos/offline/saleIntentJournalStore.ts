export type SaleIntentJournalStoreName = 'saleIntents' | 'saleIntentEvents' | 'saleIntentMeta';

export const SALE_INTENT_JOURNAL_STORES: SaleIntentJournalStoreName[] = [
  'saleIntents',
  'saleIntentEvents',
  'saleIntentMeta',
];

export interface SaleIntentJournalTxn {
  get<T>(store: SaleIntentJournalStoreName, key: string): Promise<T | undefined>;
  getAll<T>(store: SaleIntentJournalStoreName): Promise<T[]>;
  put(store: SaleIntentJournalStoreName, key: string, value: unknown): Promise<void>;
  delete(store: SaleIntentJournalStoreName, key: string): Promise<void>;
}

export interface SaleIntentJournalStore {
  transact<T>(
    stores: SaleIntentJournalStoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (txn: SaleIntentJournalTxn) => Promise<T>,
  ): Promise<T>;
}

export const SALE_INTENT_JOURNAL_DB_NAME = 'twinpet-sale-intent-journal';
export const SALE_INTENT_JOURNAL_DB_VERSION = 1;

export function openSaleIntentJournalDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(SALE_INTENT_JOURNAL_DB_NAME, SALE_INTENT_JOURNAL_DB_VERSION);
      req.onupgradeneeded = () => {
        const dbi = req.result;
        for (const s of SALE_INTENT_JOURNAL_STORES) {
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

export function createIndexedDbSaleIntentJournalStore(): SaleIntentJournalStore {
  return {
    transact<T>(
      stores: SaleIntentJournalStoreName[],
      mode: 'readonly' | 'readwrite',
      fn: (txn: SaleIntentJournalTxn) => Promise<T>,
    ): Promise<T> {
      return openSaleIntentJournalDb().then(
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

            const txn: SaleIntentJournalTxn = {
              get: (store, key) => reqP(tx.objectStore(store).get(key)),
              getAll: (store) => reqP(tx.objectStore(store).getAll()),
              put: (store, key, value) =>
                reqP(tx.objectStore(store).put(value, key)).then(() => undefined),
              delete: (store, key) =>
                reqP(tx.objectStore(store).delete(key)).then(() => undefined),
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

export function createInMemorySaleIntentJournalStore(): SaleIntentJournalStore & {
  dump(): Record<SaleIntentJournalStoreName, Record<string, unknown>>;
} {
  const data: Record<SaleIntentJournalStoreName, Map<string, unknown>> = {
    saleIntents: new Map(),
    saleIntentEvents: new Map(),
    saleIntentMeta: new Map(),
  };

  const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

  return {
    async transact<T>(
      stores: SaleIntentJournalStoreName[],
      mode: 'readonly' | 'readwrite',
      fn: (txn: SaleIntentJournalTxn) => Promise<T>,
    ): Promise<T> {
      const working = new Map<SaleIntentJournalStoreName, Map<string, unknown>>();
      for (const s of stores) {
        const copy = new Map<string, unknown>();
        for (const [k, v] of data[s]) copy.set(k, clone(v));
        working.set(s, copy);
      }
      const ensure = (store: SaleIntentJournalStoreName): Map<string, unknown> => {
        const m = working.get(store);
        if (!m) throw new Error(`store "${store}" not in transaction scope`);
        return m;
      };

      const txn: SaleIntentJournalTxn = {
        async get<R>(store: SaleIntentJournalStoreName, key: string): Promise<R | undefined> {
          return clone(ensure(store).get(key)) as R | undefined;
        },
        async getAll<R>(store: SaleIntentJournalStoreName): Promise<R[]> {
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

      const result = await fn(txn);
      if (mode === 'readwrite') {
        for (const s of stores) data[s] = working.get(s)!;
      }
      return result;
    },

    dump() {
      const out = {} as Record<SaleIntentJournalStoreName, Record<string, unknown>>;
      for (const s of SALE_INTENT_JOURNAL_STORES) out[s] = Object.fromEntries(data[s]);
      return out;
    },
  };
}
