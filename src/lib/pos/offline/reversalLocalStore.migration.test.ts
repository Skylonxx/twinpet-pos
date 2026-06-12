import { afterEach, describe, expect, it } from 'vitest';
import {
  REVERSAL_STORES,
  createIndexedDbReversalStore,
} from './reversalLocalStore';

/**
 * Phase 7B-H7-C migration coverage.
 *
 * `fake-indexeddb` is not a project dependency (and adding one is out of scope), so this
 * suite injects a COMPACT, deterministic fake `indexedDB` that exercises the REAL
 * `openDb` / `onupgradeneeded` code path inside `createIndexedDbReversalStore()`:
 *
 *   - request callbacks fire on microtasks; transaction `oncomplete` fires on a macrotask
 *     (setTimeout 0) AFTER all microtask request callbacks (and the user `fn` await chain)
 *     have drained — matching IndexedDB's "auto-commit once requests settle" semantics.
 *
 * The fake persists a pre-seeded v1 database (the four original stores + data, NO
 * `rejections`) so opening at the production `DB_VERSION` (2) triggers a real upgrade.
 */

interface FakeDbState {
  version: number;
  stores: Map<string, Map<string, unknown>>;
  created: string[]; // names passed to createObjectStore during the last upgrade
}

function installFakeIndexedDb(state: FakeDbState): void {
  const makeRequest = <T>(run: (req: { result?: T; onsuccess: (() => void) | null; onerror: (() => void) | null }) => void) => {
    const req: { result?: T; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
      result: undefined,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => run(req));
    return req;
  };

  const makeStore = (name: string) => {
    const map = state.stores.get(name)!;
    return {
      get: (key: string) => makeRequest<unknown>((req) => {
        req.result = map.get(key);
        req.onsuccess?.();
      }),
      getAll: () => makeRequest<unknown[]>((req) => {
        req.result = [...map.values()];
        req.onsuccess?.();
      }),
      put: (value: unknown, key: string) => makeRequest<string>((req) => {
        map.set(key, value);
        req.result = key;
        req.onsuccess?.();
      }),
      delete: (key: string) => makeRequest<undefined>((req) => {
        map.delete(key);
        req.onsuccess?.();
      }),
    };
  };

  const makeTransaction = (_stores: string[], _mode: string) => {
    const tx: { oncomplete: (() => void) | null; onabort: (() => void) | null; error: unknown; objectStore: (n: string) => unknown; abort: () => void } = {
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
    // Auto-commit on a macrotask, after all request microtasks + the fn await chain drain.
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
        req.result = makeDb();
        if (version > state.version) {
          state.created = [];
          req.onupgradeneeded?.(); // production handler creates only missing stores
          state.version = version;
        }
        req.onsuccess?.();
      });
      return req;
    },
  };

  (globalThis as unknown as { indexedDB: unknown }).indexedDB = fakeIndexedDb;
}

function seedV1(): FakeDbState {
  return {
    version: 1,
    stores: new Map<string, Map<string, unknown>>([
      ['intents', new Map<string, unknown>([['i1', { id: 'i1', status: 'queued' }]])],
      ['stock', new Map<string, unknown>([['p1::b1', { count: 5 }]])],
      ['ledger', new Map<string, unknown>([['row-1', { delta: -5 }]])],
      ['markers', new Map<string, unknown>([['mut-1', { applied: true }]])],
    ]),
    created: [],
  };
}

afterEach(() => {
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
});

describe('H7-C: REVERSAL_STORES is additive (no original store removed)', () => {
  it('contains the four original stores plus rejections', () => {
    expect(REVERSAL_STORES).toEqual(['intents', 'stock', 'ledger', 'markers', 'rejections']);
  });
});

describe('H7-C: DB_VERSION 1 → 2 migration (real openDb/onupgradeneeded via injected fake)', () => {
  it('upgrading a v1 DB creates ONLY the rejections store and preserves existing stores + data', async () => {
    const state = seedV1();
    installFakeIndexedDb(state);

    // Any transact triggers openDb at the production DB_VERSION (2) → upgrade fires.
    const store = createIndexedDbReversalStore();
    const got = await store.transact(['rejections'], 'readwrite', async (txn) => {
      await txn.put('rejections', 'rej_1', { recordId: 'rej_1', sourceType: 'transfer' });
      return txn.get('rejections', 'rej_1');
    });

    // Upgrade fired (version bumped) and created ONLY the missing store.
    expect(state.version).toBe(2);
    expect(state.created).toEqual(['rejections']);

    // Existing stores + their data are preserved untouched.
    expect(state.stores.get('intents')!.get('i1')).toEqual({ id: 'i1', status: 'queued' });
    expect(state.stores.get('stock')!.get('p1::b1')).toEqual({ count: 5 });
    expect(state.stores.get('ledger')!.get('row-1')).toEqual({ delta: -5 });
    expect(state.stores.get('markers')!.get('mut-1')).toEqual({ applied: true });

    // The new store exists and accepted the write.
    expect(state.stores.has('rejections')).toBe(true);
    expect(got).toEqual({ recordId: 'rej_1', sourceType: 'transfer' });
  });

  it('does not recreate stores that already exist (no data loss on re-open)', async () => {
    const state = seedV1();
    state.version = 2; // already migrated
    state.stores.set('rejections', new Map<string, unknown>([['rej_existing', { recordId: 'rej_existing' }]]));
    installFakeIndexedDb(state);

    const store = createIndexedDbReversalStore();
    await store.transact(['rejections'], 'readonly', async (txn) => txn.getAll('rejections'));

    // No upgrade → no createObjectStore calls; the pre-existing rejection row survives.
    expect(state.created).toEqual([]);
    expect(state.stores.get('rejections')!.get('rej_existing')).toEqual({ recordId: 'rej_existing' });
  });
});
