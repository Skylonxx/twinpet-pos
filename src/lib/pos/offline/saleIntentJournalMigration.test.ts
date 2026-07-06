import { afterEach, describe, expect, it } from 'vitest';
import {
  SALE_INTENT_JOURNAL_DB_NAME,
  SALE_INTENT_JOURNAL_DB_VERSION,
  SALE_INTENT_JOURNAL_STORES,
  createIndexedDbSaleIntentJournalStore,
  openSaleIntentJournalDb,
} from './saleIntentJournalStore';

interface FakeDbState {
  version: number;
  stores: Map<string, Map<string, unknown>>;
  created: string[];
  openShouldFail?: boolean;
}

function installFakeIndexedDb(state: FakeDbState): void {
  const makeRequest = <T>(
    run: (req: { result?: T; onsuccess: (() => void) | null; onerror: (() => void) | null }) => void,
  ) => {
    const req: { result?: T; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
      result: undefined,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => run(req));
    return req;
  };

  const makeStore = (name: string) => {
    if (!state.stores.has(name)) state.stores.set(name, new Map());
    const map = state.stores.get(name)!;
    return {
      get: (key: string) =>
        makeRequest<unknown>((req) => {
          req.result = map.get(key);
          req.onsuccess?.();
        }),
      getAll: () =>
        makeRequest<unknown[]>((req) => {
          req.result = [...map.values()];
          req.onsuccess?.();
        }),
      put: (value: unknown, key: string) =>
        makeRequest<string>((req) => {
          map.set(key, value);
          req.result = key;
          req.onsuccess?.();
        }),
      delete: (key: string) =>
        makeRequest<undefined>((req) => {
          map.delete(key);
          req.onsuccess?.();
        }),
    };
  };

  const makeTransaction = (_stores: string[], _mode: string) => {
    const tx: {
      oncomplete: (() => void) | null;
      onabort: (() => void) | null;
      error: unknown;
      objectStore: (n: string) => unknown;
      abort: () => void;
    } = {
      oncomplete: null,
      onabort: null,
      error: null,
      objectStore: (n: string) => makeStore(n),
      abort: () => {
        aborted = true;
        tx.onabort?.();
      },
    };
    let aborted = false;
    setTimeout(() => {
      if (!aborted) tx.oncomplete?.();
    }, 0);
    return tx;
  };

  const makeDb = () => ({
    objectStoreNames: { contains: (n: string) => state.stores.has(n) },
    createObjectStore: (n: string) => {
      state.stores.set(n, new Map());
      state.created.push(n);
    },
    transaction: (stores: string[], mode: string) => makeTransaction(stores, mode),
    close: () => {},
  });

  const fakeIndexedDb = {
    open: (_name: string, version: number) => {
      const req: {
        result?: ReturnType<typeof makeDb>;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onupgradeneeded: (() => void) | null;
      } = { result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        if (state.openShouldFail) {
          req.onerror?.();
          return;
        }
        req.result = makeDb();
        if (version > state.version) {
          state.created = [];
          req.onupgradeneeded?.();
          state.version = version;
        }
        req.onsuccess?.();
      });
      return req;
    },
  };

  (globalThis as unknown as { indexedDB: unknown }).indexedDB = fakeIndexedDb;
}

afterEach(() => {
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
});

describe('sale intent journal DB v1 migration (injected fake IDB)', () => {
  it('defines the three v1 object stores', () => {
    expect(SALE_INTENT_JOURNAL_STORES).toEqual(['saleIntents', 'saleIntentEvents', 'saleIntentMeta']);
    expect(SALE_INTENT_JOURNAL_DB_NAME).toBe('twinpet-sale-intent-journal');
    expect(SALE_INTENT_JOURNAL_DB_VERSION).toBe(1);
  });

  it('creates all stores on first open and accepts writes', async () => {
    const state: FakeDbState = { version: 0, stores: new Map(), created: [] };
    installFakeIndexedDb(state);

    const db = await openSaleIntentJournalDb();
    expect(db).not.toBeNull();
    db?.close();

    expect(state.version).toBe(1);
    expect(state.created.sort()).toEqual([...SALE_INTENT_JOURNAL_STORES].sort());

    const store = createIndexedDbSaleIntentJournalStore();
    const row = { asyncOrderId: 'dev-1-1', status: 'queued' };
    const got = await store.transact(['saleIntents'], 'readwrite', async (txn) => {
      await txn.put('saleIntents', 'dev-1-1', row);
      return txn.get('saleIntents', 'dev-1-1');
    });
    expect(got).toEqual(row);
  });

  it('reopen at same version does not recreate stores (additive pattern)', async () => {
    const state: FakeDbState = {
      version: 1,
      stores: new Map([
        ['saleIntents', new Map([['keep', { asyncOrderId: 'keep' }]])],
        ['saleIntentEvents', new Map()],
        ['saleIntentMeta', new Map()],
      ]),
      created: [],
    };
    installFakeIndexedDb(state);

    const store = createIndexedDbSaleIntentJournalStore();
    await store.transact(['saleIntents'], 'readonly', async (txn) => txn.getAll('saleIntents'));

    expect(state.created).toEqual([]);
    expect(state.stores.get('saleIntents')!.get('keep')).toEqual({ asyncOrderId: 'keep' });
  });

  it('open failure yields null from openSaleIntentJournalDb', async () => {
    const state: FakeDbState = { version: 0, stores: new Map(), created: [], openShouldFail: true };
    installFakeIndexedDb(state);
    const db = await openSaleIntentJournalDb();
    expect(db).toBeNull();
  });

  it('indexedDB unavailable is handled without throw from open helper', async () => {
    delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
    const db = await openSaleIntentJournalDb();
    expect(db).toBeNull();
  });
});
