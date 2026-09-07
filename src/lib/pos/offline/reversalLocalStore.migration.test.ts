import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REVERSAL_STORES,
  createIndexedDbReversalStore,
} from './reversalLocalStore';

/**
 * Phase 7B-H7-C + PK-3 + SEC-001 Packet D / D-2 migration coverage.
 *
 * `fake-indexeddb` is not a project dependency (and adding one is out of scope), so this
 * suite injects a COMPACT, deterministic fake `indexedDB` that exercises the REAL
 * `openDb` / `onupgradeneeded` code path inside `createIndexedDbReversalStore()`:
 *
 *   - request callbacks fire on microtasks; transaction `oncomplete` fires on a macrotask
 *     (setTimeout 0) AFTER all microtask request callbacks (and the user `fn` await chain)
 *     have drained — matching IndexedDB's "auto-commit once requests settle" semantics.
 *
 * PK-3 (V2=A): DB_VERSION 3 added `voidIntents`.
 * D-2 (P02 + v3→v4): DB_VERSION 4 adds `privilegedEvidence`, and `openDb()` is now
 * bounded — a `blocked` or never-settling open resolves `null` within
 * OPEN_DB_TIMEOUT_MS instead of hanging forever.
 */

interface FakeDbState {
  version: number;
  stores: Map<string, Map<string, unknown>>;
  created: string[];
}

function installFakeIndexedDb(
  state: FakeDbState,
  options: { blocked?: boolean; neverSettle?: boolean } = {},
): void {
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
        onblocked: (() => void) | null;
      } = { result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      if (options.neverSettle) {
        // Neither onsuccess, onerror, nor onupgradeneeded ever fires — P02 must
        // still bound this via its own timer, not via any handler.
        return req;
      }
      if (options.blocked) {
        queueMicrotask(() => req.onblocked?.());
        return req;
      }
      queueMicrotask(() => {
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

function seedV2(): FakeDbState {
  const state = seedV1();
  state.version = 2;
  state.stores.set('rejections', new Map<string, unknown>([['rej_existing', { recordId: 'rej_existing' }]]));
  return state;
}

function seedV3(): FakeDbState {
  const state = seedV2();
  state.version = 3;
  state.stores.set('voidIntents', new Map<string, unknown>([['ord_existing', { orderId: 'ord_existing' }]]));
  return state;
}

afterEach(() => {
  delete (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
});

describe('H7-C / PK-3 / D-2: REVERSAL_STORES is additive (no original store removed)', () => {
  it('contains the four original stores plus rejections, voidIntents, and privilegedEvidence, in order', () => {
    expect(REVERSAL_STORES).toEqual([
      'intents',
      'stock',
      'ledger',
      'markers',
      'rejections',
      'voidIntents',
      'privilegedEvidence',
    ]);
  });
});

describe('H7-C: DB_VERSION 1 → 4 hop retained inside current open', () => {
  it('upgrading a v1 DB creates every missing store (rejections, voidIntents, privilegedEvidence) and preserves data', async () => {
    const state = seedV1();
    installFakeIndexedDb(state);

    const store = createIndexedDbReversalStore();
    const got = await store.transact(['rejections'], 'readwrite', async (txn) => {
      await txn.put('rejections', 'rej_1', { recordId: 'rej_1', sourceType: 'transfer' });
      return txn.get('rejections', 'rej_1');
    });

    expect(state.version).toBe(4);
    expect(state.created).toEqual(['rejections', 'voidIntents', 'privilegedEvidence']);
    expect(state.stores.get('intents')!.get('i1')).toEqual({ id: 'i1', status: 'queued' });
    expect(state.stores.get('stock')!.get('p1::b1')).toEqual({ count: 5 });
    expect(state.stores.get('ledger')!.get('row-1')).toEqual({ delta: -5 });
    expect(state.stores.get('markers')!.get('mut-1')).toEqual({ applied: true });
    expect(state.stores.has('rejections')).toBe(true);
    expect(state.stores.has('voidIntents')).toBe(true);
    expect(state.stores.has('privilegedEvidence')).toBe(true);
    expect(got).toEqual({ recordId: 'rej_1', sourceType: 'transfer' });
  });
});

describe('PK-3: DB_VERSION 2 → 3 hop', () => {
  it('upgrading a v2 DB creates voidIntents and privilegedEvidence, preserving existing stores + data', async () => {
    const state = seedV2();
    installFakeIndexedDb(state);

    const store = createIndexedDbReversalStore();
    const got = await store.transact(['voidIntents'], 'readwrite', async (txn) => {
      await txn.put('voidIntents', 'ord-1', { orderId: 'ord-1', status: 'pending' });
      return txn.get('voidIntents', 'ord-1');
    });

    expect(state.version).toBe(4);
    expect(state.created).toEqual(['voidIntents', 'privilegedEvidence']);
    expect(state.stores.get('intents')!.get('i1')).toEqual({ id: 'i1', status: 'queued' });
    expect(state.stores.get('rejections')!.get('rej_existing')).toEqual({ recordId: 'rej_existing' });
    expect(got).toEqual({ orderId: 'ord-1', status: 'pending' });
  });
});

describe('D-2: DB_VERSION 3 → 4 migration', () => {
  it('upgrading a v3 DB creates ONLY privilegedEvidence and preserves every existing store + row', async () => {
    const state = seedV3();
    installFakeIndexedDb(state);

    const store = createIndexedDbReversalStore();
    const got = await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', 'adj-1', { adjudicationId: 'adj-1' });
      return txn.get('privilegedEvidence', 'adj-1');
    });

    expect(state.version).toBe(4);
    expect(state.created).toEqual(['privilegedEvidence']);
    expect(state.stores.get('intents')!.get('i1')).toEqual({ id: 'i1', status: 'queued' });
    expect(state.stores.get('rejections')!.get('rej_existing')).toEqual({ recordId: 'rej_existing' });
    expect(state.stores.get('voidIntents')!.get('ord_existing')).toEqual({ orderId: 'ord_existing' });
    expect(got).toEqual({ adjudicationId: 'adj-1' });
  });

  it('does not recreate stores that already exist on an already-v4 database', async () => {
    const state = seedV3();
    state.version = 4;
    state.stores.set('privilegedEvidence', new Map<string, unknown>([['adj_existing', { adjudicationId: 'adj_existing' }]]));
    installFakeIndexedDb(state);

    const store = createIndexedDbReversalStore();
    await store.transact(['privilegedEvidence'], 'readonly', async (txn) => txn.getAll('privilegedEvidence'));

    expect(state.created).toEqual([]);
    expect(state.stores.get('privilegedEvidence')!.get('adj_existing')).toEqual({ adjudicationId: 'adj_existing' });
    expect(state.stores.get('voidIntents')!.get('ord_existing')).toEqual({ orderId: 'ord_existing' });
    expect(state.stores.get('rejections')!.get('rej_existing')).toEqual({ recordId: 'rej_existing' });
  });
});

describe('P02: bounded openDb() — blocked / never-settling open cannot hang a durable operation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a blocked open (onblocked fires, no other handler ever fires) resolves to IndexedDB unavailable within the bound, not a hang', async () => {
    const state = seedV3();
    installFakeIndexedDb(state, { blocked: true });

    const store = createIndexedDbReversalStore();
    const p = store.transact(['intents'], 'readonly', async (txn) => txn.getAll('intents'));
    const assertion = expect(p).rejects.toThrow('IndexedDB unavailable');
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
  });

  it('a hung open (no handler ever fires) resolves to IndexedDB unavailable within the bound, not a hang', async () => {
    const state = seedV3();
    installFakeIndexedDb(state, { neverSettle: true });

    const store = createIndexedDbReversalStore();
    const p = store.transact(['intents'], 'readonly', async (txn) => txn.getAll('intents'));
    const assertion = expect(p).rejects.toThrow('IndexedDB unavailable');
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
  });

  it('a normal (non-blocked) open still settles well within the bound and is unaffected by the timer', async () => {
    const state = seedV3();
    installFakeIndexedDb(state);
    const store = createIndexedDbReversalStore();
    const p = store.transact(['intents'], 'readonly', async (txn) => txn.getAll('intents'));
    await vi.advanceTimersByTimeAsync(0);
    const result = await p;
    expect(Array.isArray(result)).toBe(true);
  });
});
