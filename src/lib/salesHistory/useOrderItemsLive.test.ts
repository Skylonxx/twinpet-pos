// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type Snap = {
  docs: Array<{ id: string; data: () => Record<string, unknown> }>;
  metadata: { fromCache: boolean; hasPendingWrites?: boolean };
  docChanges?: () => Array<{ type: string; doc: { id: string } }>;
};

type OnNext = (snap: Snap) => void;
type OnError = (err: { code?: string }) => void;

const unsub = vi.fn();
let listeners: Array<{
  path: string;
  options: unknown;
  onNext: OnNext;
  onError: OnError;
}> = [];

const onSnapshotSpy = vi.fn(
  (col: { path: string }, optionsOrNext: unknown, maybeNext?: OnNext, maybeErr?: OnError) => {
    const hasOpts = typeof optionsOrNext === 'object' && optionsOrNext !== null && !('docs' in (optionsOrNext as object)) && typeof maybeNext === 'function';
    const onNext = (hasOpts ? maybeNext : optionsOrNext) as OnNext;
    const onError = (hasOpts ? maybeErr : maybeNext) as OnError;
    const options = hasOpts ? optionsOrNext : undefined;
    listeners.push({ path: col.path, options, onNext, onError });
    return unsub;
  },
);

vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }),
  onSnapshot: (...args: unknown[]) => onSnapshotSpy(...(args as [never, never, never, never])),
}));

vi.mock('../firebase', () => ({
  db: {},
  isFirebaseConfigured: true,
  collections: { orders: 'orders', orderItems: 'orderItems' },
}));

import { useOrderItemsLive } from './useOrderItemsLive';

function Probe({
  branchId,
  orderId,
  onRender,
}: {
  branchId: string | null;
  orderId: string | null;
  onRender: (v: ReturnType<typeof useOrderItemsLive>) => void;
}) {
  onRender(useOrderItemsLive(branchId, orderId));
  return null;
}

function itemSnap(id: string, fromCache: boolean, extra: Record<string, unknown> = {}): Snap {
  return {
    docs: [{ id, data: () => ({ productSnap: { name: id }, qty: 1, ...extra }) }],
    metadata: { fromCache, hasPendingWrites: false },
    docChanges: () => [],
  };
}

function emptySnap(fromCache: boolean): Snap {
  return { docs: [], metadata: { fromCache, hasPendingWrites: false }, docChanges: () => [] };
}

afterEach(() => {
  cleanup();
  listeners = [];
  unsub.mockClear();
  onSnapshotSpy.mockClear();
});

beforeEach(() => {
  listeners = [];
});

describe('useOrderItemsLive B4', () => {
  test('E27 canonical open attaches exactly one child listener with includeMetadataChanges', () => {
    render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: () => {} }));
    expect(onSnapshotSpy).toHaveBeenCalledTimes(1);
    expect(listeners[0].path).toBe('orders/X/orderItems');
    expect(listeners[0].options).toEqual({ includeMetadataChanges: true });
  });

  test('E28 pending-overlay (null orderId) attaches nothing', () => {
    render(createElement(Probe, { branchId: 'A', orderId: null, onRender: () => {} }));
    expect(onSnapshotSpy).toHaveBeenCalledTimes(0);
  });

  test('E29 close detaches and returns idle empty', () => {
    const renders: Array<ReturnType<typeof useOrderItemsLive>> = [];
    const view = render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => renders.push(v) }));
    act(() => listeners[0].onNext(itemSnap('a1', false)));
    flushSync(() => view.rerender(createElement(Probe, { branchId: 'A', orderId: null, onRender: (v) => renders.push(v) })));
    const last = renders[renders.length - 1];
    expect(unsub).toHaveBeenCalled();
    expect(last.items).toEqual([]);
    expect(last.state).toBe('idle');
  });

  test('E30 order switch detaches old and never shows A items under B', () => {
    const renders: Array<ReturnType<typeof useOrderItemsLive>> = [];
    const view = render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => renders.push(v) }));
    act(() => listeners[0].onNext(itemSnap('a1', false)));
    flushSync(() => view.rerender(createElement(Probe, { branchId: 'A', orderId: 'Y', onRender: (v) => renders.push(v) })));
    const firstY = renders.find((r, i) => i > 0 && r.state === 'loading');
    expect(firstY?.items).toEqual([]);
    expect(unsub).toHaveBeenCalled();
  });

  test('E31 unmount detaches', () => {
    const view = render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: () => {} }));
    view.unmount();
    expect(unsub).toHaveBeenCalled();
  });

  test('E32 branch A→B with orderId null: immediate idle empty fromCache false; no B attach', () => {
    const renders: Array<ReturnType<typeof useOrderItemsLive>> = [];
    const view = render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => renders.push(v) }));
    act(() => listeners[0].onNext(itemSnap('a1', false)));
    renders.length = 0;
    flushSync(() => view.rerender(createElement(Probe, { branchId: 'B', orderId: null, onRender: (v) => renders.push(v) })));
    expect(renders[0].items).toEqual([]);
    expect(renders[0].state).toBe('idle');
    expect(renders[0].fromCache).toBe(false);
    expect(listeners.filter((l) => l.path.includes('/B/')).length).toBe(0);
  });

  test('E33 cache snapshot is never confirmed live', () => {
    const renders: Array<ReturnType<typeof useOrderItemsLive>> = [];
    render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => renders.push(v) }));
    act(() => listeners[0].onNext(itemSnap('a1', true)));
    const last = renders[renders.length - 1];
    expect(last.fromCache).toBe(true);
    expect(last.state).not.toBe('live');
  });

  test('E34 cache-empty is unavailable', () => {
    const renders: Array<ReturnType<typeof useOrderItemsLive>> = [];
    render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => renders.push(v) }));
    act(() => listeners[0].onNext(emptySnap(true)));
    expect(renders[renders.length - 1].state).toBe('unavailable');
  });

  test('E35 server snapshot is live', () => {
    const renders: Array<ReturnType<typeof useOrderItemsLive>> = [];
    render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => renders.push(v) }));
    act(() => listeners[0].onNext(itemSnap('a1', false)));
    const last = renders[renders.length - 1];
    expect(last.fromCache).toBe(false);
    expect(last.state).toBe('live');
    expect(last.items[0].id).toBe('a1');
  });

  test('E36 child removals clear items', () => {
    const renders: Array<ReturnType<typeof useOrderItemsLive>> = [];
    render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => renders.push(v) }));
    act(() => listeners[0].onNext(itemSnap('a1', false)));
    act(() => listeners[0].onNext(emptySnap(false)));
    expect(renders[renders.length - 1].items).toEqual([]);
    expect(renders[renders.length - 1].state).toBe('empty');
  });

  test('E37 same-id recreate does not require parent removal', () => {
    const renders: Array<ReturnType<typeof useOrderItemsLive>> = [];
    render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => renders.push(v) }));
    act(() => listeners[0].onNext(itemSnap('a1', false)));
    act(() => listeners[0].onNext(emptySnap(false)));
    act(() => listeners[0].onNext(itemSnap('b1', false)));
    expect(renders[renders.length - 1].items[0].id).toBe('b1');
  });

  test('E38 incarnation-B additions render B only', () => {
    const renders: Array<ReturnType<typeof useOrderItemsLive>> = [];
    render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => renders.push(v) }));
    act(() => listeners[0].onNext(itemSnap('a1', false)));
    act(() => listeners[0].onNext(itemSnap('b1', false)));
    expect(renders[renders.length - 1].items.map((i) => i.id)).toEqual(['b1']);
  });

  test('E39 listener error clears items', () => {
    const renders: Array<ReturnType<typeof useOrderItemsLive>> = [];
    render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => renders.push(v) }));
    act(() => listeners[0].onNext(itemSnap('a1', false)));
    act(() => listeners[0].onError({ code: 'permission-denied' }));
    const last = renders[renders.length - 1];
    expect(last.items).toEqual([]);
    expect(last.state).toBe('error');
    expect(last.fromCache).toBe(false);
    expect(last.state).not.toBe('live');
    expect('verdict' in last).toBe(false);
  });

  test('E40 child live cannot be treated as row CURRENT in this hook', () => {
    const renders: Array<ReturnType<typeof useOrderItemsLive>> = [];
    render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => renders.push(v) }));
    act(() => listeners[0].onNext(itemSnap('a1', false)));
    expect('verdict' in renders[renders.length - 1]).toBe(false);
  });

  test('E41 child listener is not a receipt-authority input', async () => {
    const src = (await import('./useOrderItemsLive.ts?raw')).default as string;
    expect(src.includes('decideReceiptAuthority')).toBe(false);
    expect(src.includes('AUTHORITATIVE')).toBe(false);
  });

  test('E42 at most one child listener active', () => {
    const view = render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: () => {} }));
    view.rerender(createElement(Probe, { branchId: 'A', orderId: 'Y', onRender: () => {} }));
    expect(listeners.length - unsub.mock.calls.length).toBeLessThanOrEqual(1);
  });

  test('E43 same-pair L1 cannot overwrite L2 after reopen', () => {
    const renders: Array<ReturnType<typeof useOrderItemsLive>> = [];
    const view = render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => renders.push(v) }));
    const l1 = listeners[0];
    act(() => l1.onNext(itemSnap('old', false)));
    flushSync(() => view.rerender(createElement(Probe, { branchId: 'A', orderId: 'Z', onRender: (v) => renders.push(v) })));
    flushSync(() => view.rerender(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => renders.push(v) })));
    const beforeL2 = renders[renders.length - 1];
    expect(beforeL2.items).toEqual([]);
    expect(beforeL2.state).toBe('loading');
    expect(beforeL2.fromCache).toBe(false);
    const l2 = listeners[listeners.length - 1];
    expect(l2).not.toBe(l1);
    act(() => l2.onNext(itemSnap('new', false)));
    act(() => l1.onNext(itemSnap('late-old', false)));
    expect(renders[renders.length - 1].items[0].id).toBe('new');
  });

  test('E45 branch A→B same canonical X: immediate loading empty fromCache false then rebind', () => {
    const renders: Array<ReturnType<typeof useOrderItemsLive>> = [];
    const view = render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => renders.push(v) }));
    act(() => listeners[0].onNext(itemSnap('a1', false)));
    renders.length = 0;
    flushSync(() => view.rerender(createElement(Probe, { branchId: 'B', orderId: 'X', onRender: (v) => renders.push(v) })));
    expect(renders[0].items).toEqual([]);
    expect(renders[0].state).toBe('loading');
    expect(renders[0].fromCache).toBe(false);
    expect(unsub).toHaveBeenCalled();
    expect(listeners[listeners.length - 1].path).toBe('orders/X/orderItems');
  });

  test('T42 server-confirmed empty is empty; cache empty remains unavailable', () => {
    const renders: Array<ReturnType<typeof useOrderItemsLive>> = [];
    render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => renders.push(v) }));
    act(() => listeners[0].onNext(emptySnap(false)));
    expect(renders[renders.length - 1].state).toBe('empty');
    act(() => listeners[0].onNext(emptySnap(true)));
    expect(renders[renders.length - 1].state).toBe('unavailable');
  });

  test('T43 live / loading / error / idle matrix is preserved', () => {
    const idle: Array<ReturnType<typeof useOrderItemsLive>> = [];
    render(createElement(Probe, { branchId: null, orderId: null, onRender: (v) => idle.push(v) }));
    expect(idle[0].state).toBe('idle');

    const liveRenders: Array<ReturnType<typeof useOrderItemsLive>> = [];
    render(createElement(Probe, { branchId: 'A', orderId: 'X', onRender: (v) => liveRenders.push(v) }));
    expect(liveRenders[0].state).toBe('loading');
    act(() => listeners[listeners.length - 1].onNext(itemSnap('a1', false)));
    expect(liveRenders[liveRenders.length - 1].state).toBe('live');
    act(() => listeners[listeners.length - 1].onError({ code: 'permission-denied' }));
    expect(liveRenders[liveRenders.length - 1].state).toBe('error');
  });
});
