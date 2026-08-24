import { beforeEach, describe, expect, test, vi } from 'vitest';

const getDocs = vi.fn();
const getDoc = vi.fn();

vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, name: string) => ({ name }),
  collectionGroup: (_db: unknown, name: string) => ({ group: name }),
  doc: (_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }),
  getDoc: (...args: unknown[]) => getDoc(...args),
  getDocFromCache: vi.fn(),
  getDocs: (...args: unknown[]) => getDocs(...args),
  getDocsFromCache: vi.fn(),
  query: (ref: unknown) => ref,
  where: vi.fn(),
}));

vi.mock('../firebase', () => ({
  db: {},
  isFirebaseConfigured: true,
  collections: { products: 'products', categories: 'categories', productStocks: 'productStocks' },
}));

vi.mock('../admin/quickMenuStore', () => ({ getQuickMenus: async () => [] }));
vi.mock('./productSorting', () => ({ getBranchSortOrders: async () => ({}) }));
vi.mock('./offline/reversalStockOverlay', () => ({
  readReversalOverlay: vi.fn(async () => new Map<string, number>()),
}));

import { applyReversalOverlay, fetchStockByProduct, getInventorySnapshot } from './inventoryRepository';
import { stockEntryFromStockDoc, type StockEntry } from './posProductMapper';
import { isInventoryOverallFresh } from './types';

function productDoc(id: string) {
  return {
    id,
    data: () => ({
      name: id,
      sku: id,
      barcode: null,
      category: 'อาหารสัตว์',
      description: '',
      imageUrl: null,
      baseUnit: 'ชิ้น',
      uomConversions: [],
      prices: [{ priceLevelId: 'retail', unit: 'ชิ้น', price: 10 }],
      cost: 0,
      avgCost: 0,
      reorderPoint: 0,
      isActive: true,
      deletedAt: null,
    }),
  };
}

describe('inventoryRepository stockTruth', () => {
  beforeEach(() => {
    getDocs.mockReset();
    getDoc.mockReset();
  });

  test('T01 fetchStockByProduct missing/non-numeric is unknown not silent 0 truth', async () => {
    getDocs.mockResolvedValue({
      docs: [
        {
          ref: { parent: { parent: { id: 'missing-num' } } },
          data: () => ({ totalStockBase: 'nope' }),
        },
      ],
      metadata: { fromCache: false },
    });
    const { entries } = await fetchStockByProduct('B1', ['missing-num', 'absent']);
    expect(entries.get('missing-num')?.stockTruth.state).toBe('unknown');
    expect(entries.get('missing-num')?.stock).toBe(0);
    expect(entries.has('absent')).toBe(false);
  });

  test('T06 server stock 0 is known', async () => {
    getDocs.mockResolvedValue({
      docs: [
        {
          ref: { parent: { parent: { id: 'zero' } } },
          data: () => ({ totalStockBase: 0 }),
        },
      ],
      metadata: { fromCache: false },
    });
    const { entries, fromCache } = await fetchStockByProduct('B1', ['zero']);
    expect(fromCache).toBe(false);
    expect(entries.get('zero')).toEqual({
      stock: 0,
      stockTruth: { state: 'known', asOf: 'server', localDeltaApplied: false },
      overrideTierPrices: undefined,
    });
  });

  test('T03 applyReversalOverlay reversal-only seed stays unknown', () => {
    const map = new Map<string, StockEntry>();
    applyReversalOverlay(map, new Map([['ghost', 4]]));
    expect(map.get('ghost')).toEqual({
      stock: 4,
      stockTruth: { state: 'unknown' },
      overrideTierPrices: undefined,
    });
  });

  test('T18/T19 reversal overlay preserves known and unknown', () => {
    const map = new Map<string, StockEntry>([
      ['k', stockEntryFromStockDoc({ totalStockBase: 8 }, false)],
      ['u', stockEntryFromStockDoc(undefined, false)],
    ]);
    applyReversalOverlay(map, new Map([['k', 1], ['u', 2]]));
    expect(map.get('k')?.stock).toBe(9);
    expect(map.get('k')?.stockTruth).toEqual({
      state: 'known',
      asOf: 'server',
      localDeltaApplied: false,
    });
    expect(map.get('u')?.stock).toBe(2);
    expect(map.get('u')?.stockTruth.state).toBe('unknown');
  });

  test('T10 mixed-source snapshot is whole-snapshot non-fresh', async () => {
    getDocs.mockImplementation(async (q: { name?: string; group?: string }) => {
      if (q.name === 'products') {
        return { docs: [productDoc('p1')], metadata: { fromCache: false } };
      }
      if (q.name === 'categories') {
        return { docs: [], metadata: { fromCache: false } };
      }
      if (q.group === 'productStocks') {
        return {
          docs: [
            {
              ref: { parent: { parent: { id: 'p1' } } },
              data: () => ({ totalStockBase: 5 }),
            },
          ],
          metadata: { fromCache: true },
        };
      }
      return { docs: [], metadata: { fromCache: false } };
    });
    const snap = await getInventorySnapshot('B1');
    expect(snap.provenance?.products.fromCache).toBe(false);
    expect(snap.provenance?.stock.fromCache).toBe(true);
    expect(isInventoryOverallFresh(snap.provenance)).toBe(false);
    expect(snap.fromCache).toBe(true);
    expect(snap.products[0]?.stockTruth).toEqual({
      state: 'known',
      asOf: 'cache',
      localDeltaApplied: false,
    });
  });
});
