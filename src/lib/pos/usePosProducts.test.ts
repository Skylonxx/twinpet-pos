// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type Snap = {
  docs: Array<{
    id?: string;
    ref?: { parent: { parent?: { id: string } } };
    data: () => Record<string, unknown>;
    exists?: () => boolean;
    metadata?: { fromCache: boolean };
  }>;
  metadata: { fromCache: boolean };
};

type OnNext = (snap: Snap | { exists: () => boolean; data: () => Record<string, unknown>; metadata: { fromCache: boolean } }) => void;
type OnErr = (err: { code?: string }) => void;

const listeners: Array<{ kind: string; onNext: OnNext; onErr?: OnErr }> = [];

vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, name: string) => ({ kind: 'col', name }),
  collectionGroup: (_db: unknown, name: string) => ({ kind: 'group', name }),
  doc: (_db: unknown, ...segments: string[]) => ({ kind: 'doc', path: segments.join('/') }),
  onSnapshot: (ref: { kind: string; name?: string }, next: OnNext, err?: OnErr) => {
    const kind = ref.kind === 'group' ? 'stockGroup' : ref.kind === 'doc' ? 'stockDoc' : ref.name ?? 'col';
    listeners.push({ kind, onNext: next, onErr: err });
    return vi.fn();
  },
  query: (ref: unknown) => ref,
  where: vi.fn(),
}));

vi.mock('../firebase', () => ({
  db: {},
  isFirebaseConfigured: true,
  collections: { products: 'products', productStocks: 'productStocks' },
}));

import { usePosProducts } from './usePosProducts';

function productSnap(id: string): Snap {
  return {
    docs: [
      {
        id,
        data: () => ({
          name: id,
          sku: id,
          barcode: null,
          category: 'อาหารสัตว์',
          uomConversions: [],
          prices: [{ priceLevelId: 'retail', unit: 'ชิ้น', price: 10 }],
          baseUnit: 'ชิ้น',
          isActive: true,
        }),
      },
    ],
    metadata: { fromCache: false },
  };
}

afterEach(() => {
  cleanup();
  listeners.length = 0;
});

describe('usePosProducts FZ-4', () => {
  beforeEach(() => {
    listeners.length = 0;
  });

  test('T04 collection-group missing/non-numeric totalStockBase is unknown', () => {
    const { result } = renderHook(() => usePosProducts('B1'));
    const productListener = listeners.find((l) => l.kind === 'products') ?? listeners[0];
    const stockListener = listeners.find((l) => l.kind === 'stockGroup') ?? listeners[1];
    act(() => productListener?.onNext(productSnap('p1') as never));
    act(() =>
      stockListener?.onNext({
        docs: [
          {
            ref: { parent: { parent: { id: 'p1' } } },
            data: () => ({}),
          },
        ],
        metadata: { fromCache: false },
      } as never),
    );
    expect(result.current.products[0]?.stockTruth.state).toBe('unknown');
    expect(result.current.products[0]?.stock).toBe(0);
  });

  test('T06 collection-group numeric 0 is known', () => {
    const { result } = renderHook(() => usePosProducts('B1'));
    const productListener = listeners.find((l) => l.kind === 'products') ?? listeners[0];
    const stockListener = listeners.find((l) => l.kind === 'stockGroup') ?? listeners[1];
    act(() => productListener?.onNext(productSnap('p1') as never));
    act(() =>
      stockListener?.onNext({
        docs: [
          {
            ref: { parent: { parent: { id: 'p1' } } },
            data: () => ({ totalStockBase: 0 }),
          },
        ],
        metadata: { fromCache: false },
      } as never),
    );
    expect(result.current.products[0]?.stock).toBe(0);
    expect(result.current.products[0]?.stockTruth).toEqual({
      state: 'known',
      asOf: 'server',
      localDeltaApplied: false,
    });
  });

  test('T05 per-product fallback listener missing doc is unknown', () => {
    const { result } = renderHook(() => usePosProducts('B1'));
    const productListener = listeners.find((l) => l.kind === 'products') ?? listeners[0];
    const stockListener = listeners.find((l) => l.kind === 'stockGroup') ?? listeners[1];
    act(() => productListener?.onNext(productSnap('p1') as never));
    act(() => stockListener?.onErr?.({ code: 'failed-precondition' }));
    const perProduct = listeners.find((l) => l.kind === 'stockDoc');
    expect(perProduct).toBeTruthy();
    act(() =>
      perProduct?.onNext({
        exists: () => false,
        data: () => ({}),
        metadata: { fromCache: false },
      } as never),
    );
    expect(result.current.products[0]?.stockTruth.state).toBe('unknown');
  });
});
