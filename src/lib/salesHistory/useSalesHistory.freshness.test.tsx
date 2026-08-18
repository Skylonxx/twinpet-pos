// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

type Snap = {
  docs: Array<{
    id: string;
    data: () => Record<string, unknown>;
    metadata: { fromCache: boolean; hasPendingWrites: boolean };
  }>;
  metadata: { fromCache: boolean; hasPendingWrites: boolean };
  docChanges: () => Array<{ type: string; doc: { id: string } }>;
};

type OnNext = (snap: Snap) => void;
type OnErr = (err: Error) => void;

type DocsSnap = {
  docs?: Array<{ id: string; data: () => Record<string, unknown> }>;
  forEach: () => void;
  metadata: { fromCache: boolean; hasPendingWrites: boolean };
};

const getDocs = vi.fn(async (q?: unknown): Promise<DocsSnap> => {
  if ((q as { name?: string } | undefined)?.name === 'orders') {
    return {
      docs: [{ id: 'i1', data: () => ({ productId: 'p1', lineTotal: 100 }) }],
      forEach: () => {},
      metadata: { fromCache: false, hasPendingWrites: false },
    };
  }
  return {
    forEach: () => {},
    metadata: { fromCache: true, hasPendingWrites: false },
  };
});
const getDocsFromServer = vi.fn(async (): Promise<DocsSnap> => ({
  forEach: () => {},
  metadata: { fromCache: false, hasPendingWrites: false },
}));

const listeners: Array<{ col: unknown; options: unknown; onNext: OnNext; onErr?: OnErr }> = [];
const onSnapshot = vi.fn((q: unknown, options: unknown, onNext?: OnNext, onErr?: OnErr) => {
  const next = (typeof options === 'function' ? options : onNext) as OnNext;
  const err = typeof options === 'function' ? (onNext as unknown as OnErr) : onErr;
  const opts = typeof options === 'function' ? undefined : options;
  listeners.push({ col: q, options: opts, onNext: next, onErr: err });
  return () => {};
});

vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, name: string, ...rest: string[]) => ({ name, rest }),
  query: (...args: unknown[]) => ({ args }),
  where: (...args: unknown[]) => ({ args }),
  orderBy: (...args: unknown[]) => ({ args }),
  onSnapshot: (a: unknown, b?: unknown, c?: OnNext, d?: OnErr) => onSnapshot(a, b, c, d),
  getDocs: (q?: unknown) => getDocs(q as { name?: string; args?: unknown }),
  getDocsFromServer: () => getDocsFromServer(),
}));

vi.mock('../firebase', () => ({
  db: {},
  isFirebaseConfigured: true,
  collections: { orders: 'orders', orderItems: 'orderItems', payments: 'payments' },
}));

vi.mock('../pos/deviceId', () => ({ getDeviceId: () => 'dev1' }));

import { useSalesHistory } from './useSalesHistory';
import { decideAction, settledVoidEligible } from './historyFreshness';

function orderSnap(
  fromCache: boolean,
  ids = ['o1'],
  extra: Record<string, unknown> = {},
  changes: Array<{ type: string; doc: { id: string } }> = [],
): Snap {
  return {
    docs: ids.map((id) => ({
      id,
      data: () => ({
        branchId: 'br1',
        status: 'completed',
        total: 100,
        historyRev: 1,
        createdAt: { seconds: 1, nanoseconds: 0 },
        updatedAt: { seconds: 1, nanoseconds: 0 },
        deviceId: 'dev1',
        asyncOrderId: `dev1-${id.replace(/\D/g, '') || '1'}`,
        billId: id,
        staffName: 'Dao',
        paidAmt: 100,
        changeAmt: 0,
        creditAmt: 0,
        customerSnap: null,
        ...extra,
      }),
      metadata: { fromCache, hasPendingWrites: false },
    })),
    metadata: { fromCache, hasPendingWrites: false },
    docChanges: () => changes,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  listeners.length = 0;
  getDocs.mockReset();
  getDocsFromServer.mockReset();
  onSnapshot.mockClear();
  getDocs.mockImplementation(async (q?: unknown) => {
    if ((q as { name?: string } | undefined)?.name === 'orders') {
      return {
        docs: [{ id: 'i1', data: () => ({ productId: 'p1', lineTotal: 100 }) }],
        forEach: () => {},
        metadata: { fromCache: false, hasPendingWrites: false },
      };
    }
    return {
      forEach: () => {},
      metadata: { fromCache: true, hasPendingWrites: false },
    };
  });
  getDocsFromServer.mockImplementation(async () => ({
    forEach: () => {},
    metadata: { fromCache: false, hasPendingWrites: false },
  }));
});

describe('useSalesHistory freshness FSM', () => {
  test('E01 both onSnapshot calls use includeMetadataChanges', () => {
    renderHook(() => useSalesHistory('br1'));
    expect(listeners.length).toBeGreaterThanOrEqual(2);
    expect(
      listeners.every(
        (l) => l.options && (l.options as { includeMetadataChanges?: boolean }).includeMetadataChanges === true,
      ),
    ).toBe(true);
  });

  test('E02 metadata-only + unchanged generation + already qualified → zero extra reads', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: false, hasPendingWrites: false },
    }));
    const { result } = renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    await flush();
    const docs = getDocs.mock.calls.length;
    const server = getDocsFromServer.mock.calls.length;
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    await flush();
    expect(getDocs.mock.calls.length).toBe(docs);
    expect(getDocsFromServer.mock.calls.length).toBe(server);
    expect(result.current.paymentObservation).toBe('SERVER_OBSERVED');
  });

  test('E03 metadata-only while payment fan-out in flight keeps the in-flight result', async () => {
    let resolvePrimary: ((v: unknown) => void) | undefined;
    getDocs.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePrimary = resolve as (v: unknown) => void;
        }),
    );
    renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    expect(getDocs).toHaveBeenCalledTimes(1);
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    expect(getDocs).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvePrimary?.({ forEach: () => {}, metadata: { fromCache: false, hasPendingWrites: false } });
      await Promise.resolve();
    });
  });

  test('E04 changed data generation discards stale result and dispatches replacement fan-out', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: false, hasPendingWrites: false },
    }));
    renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false, ['o1'], { total: 100 }));
    });
    await flush();
    const first = getDocs.mock.calls.length;
    await act(async () => {
      listeners[0].onNext(orderSnap(false, ['o1'], { total: 180, updatedAt: { seconds: 2, nanoseconds: 0 } }));
    });
    await flush();
    expect(getDocs.mock.calls.length).toBeGreaterThan(first);
  });

  test('E05 cache→server edge with unqualified generation triggers exactly one qualification', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: true, hasPendingWrites: false },
    }));
    renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(true));
    });
    await flush();
    getDocsFromServer.mockClear();
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    await flush();
    expect(getDocsFromServer).toHaveBeenCalledTimes(1);
  });

  test('E06 failed qualification is not retried for the same generation', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: true, hasPendingWrites: false },
    }));
    getDocsFromServer.mockRejectedValue(new Error('unavailable'));
    renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    await flush();
    const n = getDocsFromServer.mock.calls.length;
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    await flush();
    expect(getDocsFromServer.mock.calls.length).toBe(n);
  });

  test('E07 auxiliaryObservation four-way map is exported from historyFreshness', async () => {
    const { auxiliaryObservation } = await import('./historyFreshness');
    expect(auxiliaryObservation(null, false)).toBe('ABSENT');
    expect(auxiliaryObservation({ fromCache: true, hasPendingWrites: false }, false)).toBe('CACHE_OBSERVED');
    expect(auxiliaryObservation({ fromCache: false, hasPendingWrites: false }, false)).toBe('SERVER_OBSERVED');
    expect(auxiliaryObservation({ fromCache: false, hasPendingWrites: false }, true)).toBe('ERROR');
  });

  test('E08 cached/failed payments never yield CURRENT; auxiliary is not a rowVerdict input', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: true, hasPendingWrites: false },
    }));
    getDocsFromServer.mockRejectedValue(new Error('stale-payments'));
    const { result } = renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    await flush();
    expect(result.current.paymentObservation).not.toBe('SERVER_OBSERVED');
    expect(result.current.records.every((r) => r.verdict !== 'CURRENT')).toBe(true);
    const src = (await import('./historyFreshness.ts?raw')).default as string;
    expect(src.includes('paymentObservation')).toBe(false);
  });

  test('E09 item reads are memoized per (orderId, generation) and re-read on generation change', async () => {
    getDocs.mockImplementation(async (q?: unknown) => {
      if ((q as { name?: string } | undefined)?.name === 'orders') {
        return {
          docs: [{ id: 'i1', data: () => ({ productId: 'p1' }) }],
          forEach: () => {},
          metadata: { fromCache: false, hasPendingWrites: false },
        };
      }
      return { forEach: () => {}, metadata: { fromCache: false, hasPendingWrites: false } };
    });
    const { result } = renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    await flush();
    await act(async () => {
      await result.current.loadItems('o1');
      await result.current.loadItems('o1');
    });
    const itemReads = getDocs.mock.calls.filter((c) => (c[0] as { name?: string })?.name === 'orders').length;
    expect(itemReads).toBe(1);
    await act(async () => {
      listeners[0].onNext(orderSnap(false, ['o1'], { total: 200, updatedAt: { seconds: 9, nanoseconds: 0 } }));
    });
    await flush();
    await act(async () => {
      await result.current.loadItems('o1');
    });
    const after = getDocs.mock.calls.filter((c) => (c[0] as { name?: string })?.name === 'orders').length;
    expect(after).toBeGreaterThan(itemReads);
  });

  test('E10 per-source listener error does not clear the other source', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: false, hasPendingWrites: false },
    }));
    const { result } = renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
      listeners[1].onNext({
        docs: [],
        metadata: { fromCache: false, hasPendingWrites: false },
        docChanges: () => [],
      });
    });
    await flush();
    expect(result.current.records.length).toBeGreaterThan(0);
    await act(async () => {
      listeners[1].onErr?.(new Error('async overlay failed'));
    });
    expect(result.current.records.some((r) => r.order.id === 'o1')).toBe(true);
  });

  test('E11 no unbounded read loop over a scripted callback sequence', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: true, hasPendingWrites: false },
    }));
    renderHook(() => useSalesHistory('br1'));
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        listeners[0].onNext(orderSnap(false));
      });
    }
    await flush();
    expect(getDocsFromServer.mock.calls.length).toBeLessThanOrEqual(2);
    expect(getDocs.mock.calls.length).toBeLessThanOrEqual(10);
  });

  test('E12 qualification calls getDocsFromServer', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: true, hasPendingWrites: false },
    }));
    renderHook(() => useSalesHistory('br1'));
    getDocsFromServer.mockClear();
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    await flush();
    expect(getDocsFromServer).toHaveBeenCalled();
  });

  test('E13 exactly one getDocsFromServer per chunk of 10 with where orderId in chunk', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: true, hasPendingWrites: false },
    }));
    const ids = Array.from({ length: 11 }, (_, i) => `o${i + 1}`);
    renderHook(() => useSalesHistory('br1'));
    getDocsFromServer.mockClear();
    await act(async () => {
      listeners[0].onNext(orderSnap(false, ids));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(getDocsFromServer.mock.calls.length).toBe(2);
    const src = (await import('./useSalesHistory.ts?raw')).default as string;
    expect(src).toMatch(/where\('orderId',\s*'in',\s*chunk\)/);
    expect(src).toMatch(/chunkIds\(ids,\s*10\)|chunkIds\(ids\)|size = 10/);
  });

  test('E14 one chunk reject publishes no SERVER_OBSERVED and discards partials', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: true, hasPendingWrites: false },
    }));
    let n = 0;
    getDocsFromServer.mockImplementation(async () => {
      n += 1;
      if (n === 2) throw new Error('chunk-2');
      return { forEach: () => {}, metadata: { fromCache: false, hasPendingWrites: false } };
    });
    const { result } = renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false, Array.from({ length: 11 }, (_, i) => `o${i + 1}`)));
    });
    await flush();
    expect(result.current.paymentObservation).not.toBe('SERVER_OBSERVED');
  });

  test('E15 already server-backed primary does not require qualification', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: false, hasPendingWrites: false },
    }));
    renderHook(() => useSalesHistory('br1'));
    getDocsFromServer.mockClear();
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    await flush();
    expect(getDocsFromServer).not.toHaveBeenCalled();
  });

  test('E16 Q-TRY T1 cache-resolved primary under server-backed canonical dispatches one qualification with no false→true edge', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: true, hasPendingWrites: false },
    }));
    renderHook(() => useSalesHistory('br1'));
    getDocsFromServer.mockClear();
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    await flush();
    expect(getDocsFromServer).toHaveBeenCalledTimes(1);
  });

  test('E17 new generation while canonical provenance stays server-backed gets its own qualification', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: true, hasPendingWrites: false },
    }));
    renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false, ['o1'], { total: 100 }));
    });
    await flush();
    getDocsFromServer.mockClear();
    await act(async () => {
      listeners[0].onNext(orderSnap(false, ['o1'], { total: 150, updatedAt: { seconds: 4, nanoseconds: 0 } }));
    });
    await flush();
    expect(getDocsFromServer).toHaveBeenCalledTimes(1);
  });

  test('E18 metadata-only while primary in flight → zero qualification, no invalidate', async () => {
    let resolvePrimary: ((v: unknown) => void) | undefined;
    getDocs.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePrimary = resolve as (v: unknown) => void;
        }),
    );
    renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    getDocsFromServer.mockClear();
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    expect(getDocsFromServer).not.toHaveBeenCalled();
    await act(async () => {
      resolvePrimary?.({ forEach: () => {}, metadata: { fromCache: true, hasPendingWrites: false } });
      await Promise.resolve();
    });
  });

  test('E19 generation change during in-flight qualification discards stale result', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: true, hasPendingWrites: false },
    }));
    let release: ((v: unknown) => void) | undefined;
    getDocsFromServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as (v: unknown) => void;
        }),
    );
    const { result } = renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false, ['o1'], { total: 100 }));
    });
    await act(async () => {
      listeners[0].onNext(orderSnap(false, ['o1'], { total: 222, updatedAt: { seconds: 8, nanoseconds: 0 } }));
    });
    await act(async () => {
      release?.({ forEach: () => {}, metadata: { fromCache: false, hasPendingWrites: false } });
      await Promise.resolve();
    });
    await flush();
    expect(result.current.records[0]?.order.total).toBe(222);
  });

  test('E20 failed qualification published stays CACHE_OBSERVED, never ERROR, never silent SERVER_OBSERVED', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: true, hasPendingWrites: false },
    }));
    getDocsFromServer.mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    await flush();
    expect(result.current.paymentObservation).toBe('CACHE_OBSERVED');
    expect(result.current.paymentObservation).not.toBe('ERROR');
    expect(result.current.paymentObservation).not.toBe('SERVER_OBSERVED');
  });

  test('E21 same-id recreate with identical updatedAt does not carry AUX items', async () => {
    getDocs.mockImplementation(async (q?: unknown) => {
      if ((q as { name?: string } | undefined)?.name === 'orders') {
        return {
          docs: [{ id: 'old', data: () => ({ productId: 'old' }) }],
          forEach: () => {},
          metadata: { fromCache: false, hasPendingWrites: false },
        };
      }
      return { forEach: () => {}, metadata: { fromCache: false, hasPendingWrites: false } };
    });
    const { result } = renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    await flush();
    await act(async () => {
      await result.current.loadItems('o1');
    });
    await act(async () => {
      listeners[0].onNext(orderSnap(false, ['o1'], {}, [{ type: 'removed', doc: { id: 'o1' } }]));
    });
    await flush();
    getDocs.mockClear();
    await act(async () => {
      await result.current.loadItems('o1');
    });
    expect(getDocs.mock.calls.some((c) => (c[0] as { name?: string })?.name === 'orders')).toBe(true);
  });

  test('E22 no AUX observation survives a generation change', async () => {
    getDocs.mockImplementation(async (q?: unknown) => {
      if ((q as { name?: string } | undefined)?.name === 'orders') {
        return {
          docs: [{ id: 'i1', data: () => ({ productId: 'p1' }) }],
          forEach: () => {},
          metadata: { fromCache: false, hasPendingWrites: false },
        };
      }
      return { forEach: () => {}, metadata: { fromCache: false, hasPendingWrites: false } };
    });
    const { result } = renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    await flush();
    await act(async () => {
      await result.current.loadItems('o1');
    });
    await act(async () => {
      listeners[0].onNext(orderSnap(false, ['o1'], { total: 333, updatedAt: { seconds: 12, nanoseconds: 0 } }));
    });
    await flush();
    getDocs.mockClear();
    await act(async () => {
      await result.current.loadItems('o1');
    });
    expect(getDocs.mock.calls.some((c) => (c[0] as { name?: string })?.name === 'orders')).toBe(true);
  });

  test('E23 docChanges removed for an open drawer discards AUX', async () => {
    getDocs.mockImplementation(async (q?: unknown) => {
      if ((q as { name?: string } | undefined)?.name === 'orders') {
        return {
          docs: [{ id: 'i1', data: () => ({ productId: 'p1' }) }],
          forEach: () => {},
          metadata: { fromCache: false, hasPendingWrites: false },
        };
      }
      return { forEach: () => {}, metadata: { fromCache: false, hasPendingWrites: false } };
    });
    const { result } = renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    await flush();
    await act(async () => {
      await result.current.loadItems('o1');
    });
    await act(async () => {
      listeners[0].onNext({
        ...orderSnap(false, []),
        docChanges: () => [{ type: 'removed', doc: { id: 'o1' } }],
      });
    });
    await flush();
    getDocs.mockClear();
    await act(async () => {
      await result.current.loadItems('o1');
    });
    expect(getDocs.mock.calls.some((c) => (c[0] as { name?: string })?.name === 'orders')).toBe(true);
    expect(result.current.records.find((r) => r.order.id === 'o1')).toBeUndefined();
    expect(decideAction('SETTLEMENT_CURRENTNESS_CLAIM', 'UNPROVEN', 'QUERY_CACHE_RESOLVED')).toBe('REFUSE');
  });

  test('E24 getDocsFromServer re-entrancy dispatches once', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: true, hasPendingWrites: false },
    }));
    let inner = 0;
    getDocsFromServer.mockImplementation(async () => {
      inner += 1;
      if (inner === 1 && listeners[0]) listeners[0].onNext(orderSnap(false));
      return { forEach: () => {}, metadata: { fromCache: false, hasPendingWrites: false } };
    });
    renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false));
    });
    await flush();
    expect(getDocsFromServer.mock.calls.length).toBeLessThanOrEqual(1);
  });

  test('E25 captured generation is fixed before dispatch', async () => {
    const src = (await import('./useSalesHistory.ts?raw')).default as string;
    const fn = src.slice(src.indexOf('function tryQualifyPayments'), src.indexOf('// [Q-TRY] END'));
    expect(fn).toMatch(/const capturedG = fsm\.dataGeneration/);
    const latch = fn.indexOf("qual = 'IN_FLIGHT'");
    const dispatch = fn.indexOf('dispatchQualRef.current(capturedG)');
    expect(fn.indexOf('const capturedG')).toBeGreaterThan(-1);
    expect(latch).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(latch);
    const between = fn.slice(latch, dispatch);
    expect(between.includes('await')).toBe(false);
  });

  test('E26 voidRevisionFault surfaces at zero extra reads and gates VOID_SETTLED_SALE; control row unaffected', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: false, hasPendingWrites: false },
    }));
    const { result } = renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext(orderSnap(false, ['o1', 'o2']));
      listeners[1].onNext({
        docs: [
          {
            id: 'o1',
            data: () => ({
              id: 'o1',
              branchId: 'br1',
              deviceId: 'dev1',
              reconcileStatus: 'settled',
              voidRevisionFault: 'revision_malformed',
              status: 'completed',
              total: 100,
              lines: [],
              payments: [],
            }),
            metadata: { fromCache: false, hasPendingWrites: false },
          },
        ],
        metadata: { fromCache: false, hasPendingWrites: false },
        docChanges: () => [],
      });
    });
    await flush();
    const faulted = result.current.records.find((r) => r.order.id === 'o1');
    const control = result.current.records.find((r) => r.order.id === 'o2');
    expect(faulted?.voidRevisionFault).toBe('revision_malformed');
    expect(control?.voidRevisionFault).toBeFalsy();
    expect(faulted?.verdict).toBe('ERROR');
    expect(decideAction('VOID_SETTLED_SALE', faulted?.verdict ?? 'CURRENT', faulted?.verdictReason ?? null)).toBe('REFUSE');
    expect(settledVoidEligible(faulted?.verdict, faulted?.verdictReason)).toBe(false);
    expect(control?.verdict).not.toBe('ERROR');
    expect(settledVoidEligible(control?.verdict ?? 'UNPROVEN', control?.verdictReason ?? null)).toBe(true);
  });

  test('production chronology uses createdAt and deterministic total order', async () => {
    getDocs.mockImplementation(async () => ({
      forEach: () => {},
      metadata: { fromCache: false, hasPendingWrites: false },
    }));
    const { result } = renderHook(() => useSalesHistory('br1'));
    await act(async () => {
      listeners[0].onNext({
        docs: [
          {
            id: 'late',
            data: () => ({
              branchId: 'br1',
              status: 'completed',
              total: 100,
              historyRev: 1,
              createdAt: { seconds: 20, nanoseconds: 0 },
              deviceId: 'dev1',
              asyncOrderId: 'dev1-2',
              billId: 'late',
              staffName: 'Dao',
              paidAmt: 100,
              changeAmt: 0,
              creditAmt: 0,
              customerSnap: null,
            }),
            metadata: { fromCache: false, hasPendingWrites: false },
          },
          {
            id: 'early',
            data: () => ({
              branchId: 'br1',
              status: 'completed',
              total: 100,
              historyRev: 1,
              createdAt: { seconds: 10, nanoseconds: 0 },
              deviceId: 'dev1',
              asyncOrderId: 'dev1-1',
              billId: 'early',
              staffName: 'Dao',
              paidAmt: 100,
              changeAmt: 0,
              creditAmt: 0,
              customerSnap: null,
            }),
            metadata: { fromCache: false, hasPendingWrites: false },
          },
          {
            id: 'tie-b',
            data: () => ({
              branchId: 'br1',
              status: 'completed',
              total: 100,
              historyRev: 1,
              createdAt: { seconds: 10, nanoseconds: 0 },
              deviceId: 'dev2',
              asyncOrderId: 'dev2-1',
              billId: 'tie-b',
              staffName: 'Dao',
              paidAmt: 100,
              changeAmt: 0,
              creditAmt: 0,
              customerSnap: null,
            }),
            metadata: { fromCache: false, hasPendingWrites: false },
          },
          {
            id: 'invalid',
            data: () => ({
              branchId: 'br1',
              status: 'completed',
              total: 100,
              historyRev: 1,
              createdAt: { seconds: 50, nanoseconds: 0 },
              deviceId: '',
              billId: 'invalid',
              staffName: 'Dao',
              paidAmt: 100,
              changeAmt: 0,
              creditAmt: 0,
              customerSnap: null,
            }),
            metadata: { fromCache: false, hasPendingWrites: false },
          },
        ],
        metadata: { fromCache: false, hasPendingWrites: false },
        docChanges: () => [],
      });
    });
    await flush();
    const ids = result.current.records.map((r) => r.order.id);
    expect(ids).toEqual(['late', 'early', 'tie-b', 'invalid']);
    expect(result.current.records.find((r) => r.order.id === 'early')?.verdictReason).not.toBe('CHRONOLOGY_INVALID');
    expect(result.current.records.find((r) => r.order.id === 'invalid')?.verdictReason).toBe('CHRONOLOGY_INVALID');
  });
});
