// deviceSeqAllocator — Packet 3B-2 atomic cross-tab sequence allocator.
//
// The allocator (`allocateLocalSeq`, added to deviceId.ts) is exercised through a
// self-contained, transaction-faithful fake IndexedDB + fake localStorage installed
// on globalThis (vitest env is `node`, where neither exists). No new dependency and
// no config change — the fake lives entirely inside this test file.
//
// Fake IDB fidelity that matters for correctness proofs:
//  - readwrite transactions are SERIALIZED through one shared queue, so overlapping
//    (multi-tab) get→put allocations observe each other's committed writes — this is
//    what makes the "concurrent → distinct" and "two-tab → distinct" proofs valid.
//  - a single shared in-memory `data` map models the same-origin store across the
//    separate connections each allocateLocalSeq() call opens (= separate tabs).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  allocateLocalSeq,
  fastForwardLocalSeqTo,
  nextLocalSeq,
  peekLocalSeq,
  getDeviceId,
  setDeviceIdentity,
} from './deviceId';

// deviceId.ts private storage key (stable storage contract — referenced literally).
const DEVICE_SEQ_KEY = 'twinpet_device_seq';

type FailMode = null | 'open-error' | 'blocked' | 'hang' | 'tx-abort';

// ── Fake localStorage ───────────────────────────────────────────────────────
function createFakeLocalStorage(onSet?: (key: string, value: string) => void) {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string): void => {
      m.set(k, String(v));
      onSet?.(k, String(v));
    },
    removeItem: (k: string): void => {
      m.delete(k);
    },
    clear: (): void => m.clear(),
    key: (i: number): string | null => Array.from(m.keys())[i] ?? null,
    get length(): number {
      return m.size;
    },
  };
}

// ── Fake IndexedDB (transaction-faithful for the allocator's get→put usage) ──
function createFakeIdb(onCommit?: (key: string, value: unknown) => void) {
  const data = new Map<string, unknown>();
  let failMode: FailMode = null;
  let created = false;
  let txChain: Promise<void> = Promise.resolve();

  type Op =
    | { type: 'get'; key: string; req: { onsuccess: (() => void) | null; onerror: (() => void) | null; result: unknown } }
    | { type: 'put'; key: string; value: unknown; req: { onsuccess: (() => void) | null; onerror: (() => void) | null } };

  function makeStore(ops: Op[]) {
    return {
      get(key: string) {
        const req = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null, result: undefined as unknown };
        ops.push({ type: 'get', key, req });
        return req;
      },
      put(value: unknown, key: string) {
        const req = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
        ops.push({ type: 'put', key, value, req });
        return req;
      },
    };
  }

  function makeDb() {
    return {
      transaction(_store: string, _mode: string) {
        const ops: Op[] = [];
        const store = makeStore(ops);
        const tx = {
          oncomplete: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onabort: null as (() => void) | null,
          objectStore: () => store,
        };
        // Enqueue serialized execution — models IDB's cross-connection readwrite
        // serialization: the next tx only starts after this one commits.
        txChain = txChain.then(
          () =>
            new Promise<void>((resolveTx) => {
              if (failMode === 'tx-abort') {
                queueMicrotask(() => {
                  tx.onabort?.();
                  resolveTx();
                });
                return;
              }
              // Phase 1: resolve gets against the CURRENT committed data.
              queueMicrotask(() => {
                for (const op of ops) {
                  if (op.type === 'get') {
                    op.req.result = data.get(op.key);
                    op.req.onsuccess?.();
                  }
                }
                // Phase 2: apply the puts issued inside get.onsuccess, then commit.
                queueMicrotask(() => {
                  for (const op of ops) {
                    if (op.type === 'put') {
                      data.set(op.key, op.value);
                      onCommit?.(op.key, op.value);
                    }
                  }
                  tx.oncomplete?.();
                  resolveTx();
                });
              });
            }),
        );
        return tx;
      },
      close(): void {
        /* noop */
      },
      createObjectStore(): unknown {
        return {};
      },
    };
  }

  const indexedDB = {
    open(_name: string, _version: number) {
      const req = {
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
        onblocked: null as (() => void) | null,
        result: null as unknown,
      };
      if (failMode === 'open-error') {
        queueMicrotask(() => req.onerror?.());
        return req;
      }
      if (failMode === 'blocked') {
        queueMicrotask(() => req.onblocked?.());
        return req; // never fires onsuccess
      }
      if (failMode === 'hang') {
        return req; // fires nothing — only the allocator's timeout can settle it
      }
      queueMicrotask(() => {
        req.result = makeDb();
        if (!created) {
          created = true;
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      });
      return req;
    },
  };

  return {
    indexedDB,
    data,
    setFailMode(m: FailMode): void {
      failMode = m;
    },
    seed(key: string, value: unknown): void {
      data.set(key, value);
    },
  };
}

let fakeIdb: ReturnType<typeof createFakeIdb>;
const origIDB = globalThis.indexedDB;
const origLS = globalThis.localStorage;

function installStores(opts?: {
  onCommit?: (key: string, value: unknown) => void;
  onLsSet?: (key: string, value: string) => void;
}) {
  fakeIdb = createFakeIdb(opts?.onCommit);
  (globalThis as { indexedDB: unknown }).indexedDB = fakeIdb.indexedDB;
  (globalThis as { localStorage: unknown }).localStorage = createFakeLocalStorage(opts?.onLsSet);
}

beforeEach(() => {
  installStores();
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as { indexedDB: unknown }).indexedDB = origIDB;
  (globalThis as { localStorage: unknown }).localStorage = origLS;
});

// ── Monotonicity / concurrency ───────────────────────────────────────────────
describe('allocateLocalSeq · monotonicity & concurrency', () => {
  test('sequential calls return monotonic increasing values (first use starts at 1)', async () => {
    const a = await allocateLocalSeq();
    const b = await allocateLocalSeq();
    const c = await allocateLocalSeq();
    expect([a, b, c]).toEqual([1, 2, 3]);
  });

  test('concurrent calls return distinct, contiguous values', async () => {
    const results = await Promise.all([
      allocateLocalSeq(),
      allocateLocalSeq(),
      allocateLocalSeq(),
      allocateLocalSeq(),
      allocateLocalSeq(),
    ]);
    expect(new Set(results).size).toBe(results.length); // all distinct
    expect([...results].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);
  });

  test('two-tab simulation (separate connections, shared origin store) → distinct values', async () => {
    // Each allocateLocalSeq() opens its own IDB connection (a distinct "tab"); the
    // shared serialized store guarantees the two never collide on the same base.
    const [tabA, tabB] = await Promise.all([allocateLocalSeq(), allocateLocalSeq()]);
    expect(tabA).not.toBe(tabB);
    expect(new Set([tabA, tabB])).toEqual(new Set([1, 2]));
  });
});

// ── max(idb, localStorage) drift absorption + corruption recovery ────────────
describe('allocateLocalSeq · max(idb, localStorage) & sanitization', () => {
  test('localStorage higher than IDB uses max(localStorage, IDB) + 1', async () => {
    localStorage.setItem(DEVICE_SEQ_KEY, '10');
    fakeIdb.seed('deviceSeq', 3);
    expect(await allocateLocalSeq()).toBe(11);
    expect(fakeIdb.data.get('deviceSeq')).toBe(11);
    expect(localStorage.getItem(DEVICE_SEQ_KEY)).toBe('11');
  });

  test('IDB higher than localStorage uses max(localStorage, IDB) + 1', async () => {
    localStorage.setItem(DEVICE_SEQ_KEY, '4');
    fakeIdb.seed('deviceSeq', 20);
    expect(await allocateLocalSeq()).toBe(21);
    expect(fakeIdb.data.get('deviceSeq')).toBe(21);
  });

  test('corrupted localStorage value recovers safely (sanitized to 0 base)', async () => {
    localStorage.setItem(DEVICE_SEQ_KEY, 'not-a-number');
    fakeIdb.seed('deviceSeq', 5);
    expect(await allocateLocalSeq()).toBe(6); // max(5, 0) + 1
  });

  test('corrupted IDB value recovers safely (NaN/negative/non-numeric → 0 base)', async () => {
    localStorage.setItem(DEVICE_SEQ_KEY, '2');
    fakeIdb.seed('deviceSeq', Number.NaN);
    expect(await allocateLocalSeq()).toBe(3); // max(0, 2) + 1

    fakeIdb.seed('deviceSeq', -7);
    expect(await allocateLocalSeq()).toBe(4); // ls now 3 → max(0, 3) + 1

    fakeIdb.seed('deviceSeq', 'garbage');
    expect(await allocateLocalSeq()).toBe(5); // ls now 4 → max(0, 4) + 1
  });

  test('missing values start at the first safe sequence (1), matching nextLocalSeq first use', async () => {
    expect(await allocateLocalSeq()).toBe(1);
  });
});

// ── localStorage write-through only after IDB commit ─────────────────────────
describe('allocateLocalSeq · localStorage mirror ordering', () => {
  test('localStorage mirror is written strictly AFTER the IDB commit', async () => {
    const events: string[] = [];
    installStores({
      onCommit: (key) => {
        if (key === 'deviceSeq') events.push('idb-commit');
      },
      onLsSet: (key) => {
        if (key === DEVICE_SEQ_KEY) events.push('ls-mirror');
      },
    });

    const seq = await allocateLocalSeq();
    expect(seq).toBe(1);
    expect(events).toEqual(['idb-commit', 'ls-mirror']);
    expect(events.indexOf('idb-commit')).toBeLessThan(events.indexOf('ls-mirror'));
  });
});

// ── Bounded fail-open to legacy nextLocalSeq() ───────────────────────────────
describe('allocateLocalSeq · bounded fail-open', () => {
  test('IDB open error → falls back to legacy nextLocalSeq()', async () => {
    localStorage.setItem(DEVICE_SEQ_KEY, '4');
    fakeIdb.setFailMode('open-error');
    await expect(allocateLocalSeq()).resolves.toBe(5); // legacy path: 4 → 5
    expect(localStorage.getItem(DEVICE_SEQ_KEY)).toBe('5');
  });

  test('IDB transaction abort → falls back to legacy nextLocalSeq()', async () => {
    localStorage.setItem(DEVICE_SEQ_KEY, '4');
    fakeIdb.setFailMode('tx-abort');
    await expect(allocateLocalSeq()).resolves.toBe(5);
  });

  test('IDB open blocked (onblocked) → bounded fallback without waiting on the timeout', async () => {
    localStorage.setItem(DEVICE_SEQ_KEY, '4');
    fakeIdb.setFailMode('blocked');
    await expect(allocateLocalSeq()).resolves.toBe(5);
  });

  test('never-settling IDB open is bounded by a timeout and falls back', async () => {
    vi.useFakeTimers();
    localStorage.setItem(DEVICE_SEQ_KEY, '4');
    fakeIdb.setFailMode('hang');

    const pending = allocateLocalSeq();
    // Nothing has settled the open; advance past the allocator's bound.
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBe(5);
  });

  test('fallback never throws', async () => {
    fakeIdb.setFailMode('open-error');
    await expect(allocateLocalSeq()).resolves.toBeTypeOf('number');
  });
});

// ── Legacy / compatibility pins ──────────────────────────────────────────────
describe('deviceId legacy & compatibility (unchanged by 3B-2)', () => {
  test('nextLocalSeq() remains available and behavior-compatible (localStorage +1)', () => {
    expect(nextLocalSeq()).toBe(1); // missing → 1
    expect(nextLocalSeq()).toBe(2);
    localStorage.setItem(DEVICE_SEQ_KEY, '7');
    expect(nextLocalSeq()).toBe(8);
    expect(peekLocalSeq()).toBe(8); // peek does not consume
    expect(peekLocalSeq()).toBe(8);
  });

  test('getDeviceId() is stable and idempotent', () => {
    const id1 = getDeviceId();
    const id2 = getDeviceId();
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9A-Z]+$/); // Crockford base32, uppercase
  });

  test('setDeviceIdentity() overwrites id + seq (Claim-Device recovery) compatibly', () => {
    setDeviceIdentity('CLAIMED1', 42);
    expect(getDeviceId()).toBe('CLAIMED1');
    expect(peekLocalSeq()).toBe(42);
    expect(nextLocalSeq()).toBe(43);
  });

  test('allocateLocalSeq() continues cleanly from a setDeviceIdentity() seq baseline', async () => {
    setDeviceIdentity('CLAIMED2', 100);
    // localStorage seq is 100; IDB mirror unseeded → max(0, 100) + 1.
    expect(await allocateLocalSeq()).toBe(101);
  });
});

// ── fastForwardLocalSeqTo (Packet 3B-4 boot-time watermark reconciliation) ────
describe('fastForwardLocalSeqTo · upward-only fast-forward', () => {
  test('server watermark higher than local seq raises the base', async () => {
    localStorage.setItem(DEVICE_SEQ_KEY, '5');
    await fastForwardLocalSeqTo(50);
    expect(peekLocalSeq()).toBe(50);
    expect(fakeIdb.data.get('deviceSeq')).toBe(50);
  });

  test('equal watermark is a no-op', async () => {
    localStorage.setItem(DEVICE_SEQ_KEY, '50');
    fakeIdb.seed('deviceSeq', 50);
    await fastForwardLocalSeqTo(50);
    expect(peekLocalSeq()).toBe(50);
    expect(fakeIdb.data.get('deviceSeq')).toBe(50);
  });

  test('lower watermark than local seq is a no-op', async () => {
    localStorage.setItem(DEVICE_SEQ_KEY, '50');
    fakeIdb.seed('deviceSeq', 50);
    await fastForwardLocalSeqTo(10);
    expect(peekLocalSeq()).toBe(50);
    expect(fakeIdb.data.get('deviceSeq')).toBe(50);
  });

  test('never lowers localStorage even when IDB mirror is already higher than the watermark', async () => {
    localStorage.setItem(DEVICE_SEQ_KEY, '5');
    fakeIdb.seed('deviceSeq', 80); // out-of-sync mirror higher than the incoming watermark
    await fastForwardLocalSeqTo(20);
    // 20 <= max(5, 80) → no-op; must not lower IDB down to 20, and must not
    // raise localStorage to a value below the true (IDB) high-water mark either.
    expect(fakeIdb.data.get('deviceSeq')).toBe(80);
    expect(localStorage.getItem(DEVICE_SEQ_KEY)).toBe('5');
  });

  test('never lowers the IndexedDB mirror even when localStorage is already higher', async () => {
    localStorage.setItem(DEVICE_SEQ_KEY, '80');
    fakeIdb.seed('deviceSeq', 5);
    await fastForwardLocalSeqTo(20);
    // 20 <= max(80, 5) → no-op.
    expect(fakeIdb.data.get('deviceSeq')).toBe(5);
    expect(localStorage.getItem(DEVICE_SEQ_KEY)).toBe('80');
  });

  test.each([
    ['NaN', Number.NaN],
    ['negative', -5],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['non-number string', '50' as unknown as number],
    ['null', null as unknown as number],
    ['undefined', undefined as unknown as number],
  ])('invalid input (%s) is a safe no-op', async (_label, value) => {
    localStorage.setItem(DEVICE_SEQ_KEY, '5');
    await fastForwardLocalSeqTo(value);
    expect(peekLocalSeq()).toBe(5);
    expect(fakeIdb.data.has('deviceSeq')).toBe(false);
  });

  test('fractional watermark is floored to a safe integer', async () => {
    localStorage.setItem(DEVICE_SEQ_KEY, '5');
    await fastForwardLocalSeqTo(10.9);
    expect(peekLocalSeq()).toBe(10);
    expect(fakeIdb.data.get('deviceSeq')).toBe(10);
  });

  test('updates the same LS/IDB mirror that allocateLocalSeq() reads', async () => {
    await fastForwardLocalSeqTo(200);
    expect(await allocateLocalSeq()).toBe(201); // serverLastSeq + 1
  });

  test('allocateLocalSeq() after fast-forward returns serverLastSeq + 1 even with prior lower local state', async () => {
    localStorage.setItem(DEVICE_SEQ_KEY, '3');
    fakeIdb.seed('deviceSeq', 3);
    await fastForwardLocalSeqTo(999);
    expect(await allocateLocalSeq()).toBe(1000);
  });

  test('never throws on IDB failure (bounded fail path still applies to idbGet/idbSet)', async () => {
    fakeIdb.setFailMode('open-error');
    await expect(fastForwardLocalSeqTo(50)).resolves.toBeUndefined();
  });
});
