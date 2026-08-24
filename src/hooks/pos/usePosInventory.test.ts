// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { InventorySnapshot } from '../../lib/pos/inventoryRepository';
import type { PosProduct } from '../../lib/pos/types';
import type { LocalSalesDeltaState } from '../../lib/hooks/useLocalSalesDelta';

const getInventorySnapshot = vi.fn();
const localSales: LocalSalesDeltaState = {
  delta: new Map(),
  normalSettlementSeq: 0,
  lastNormalSettlementOrderIds: [],
  lastNormalSettlementProductIds: [],
};

vi.mock('../../lib/pos/inventoryRepository', () => ({
  getInventorySnapshot: (...args: unknown[]) => getInventorySnapshot(...args),
}));

vi.mock('../../lib/hooks/useLocalSalesDelta', () => ({
  useLocalSalesDelta: () => localSales,
}));

import { usePosInventory } from './usePosInventory';

function product(id: string, stock: number, asOf: 'server' | 'cache' = 'server'): PosProduct {
  return {
    id,
    name: id,
    sku: id,
    barcode: null,
    category: 'cat',
    emoji: '📦',
    imageUrl: null,
    stock,
    stockTruth: { state: 'known', asOf, localDeltaApplied: false },
    baseUnit: 'ชิ้น',
    uomOptions: [{ unit: 'ชิ้น', factor: 1, price: 1 }],
  };
}

function snapshot(products: PosProduct[], fromCache = false): InventorySnapshot {
  return {
    products,
    categories: [],
    sorting: {},
    quickMenus: [],
    fromCache,
    provenance: {
      products: { fromCache },
      stock: { fromCache },
      categories: { fromCache },
      observedAtLocal: 1,
    },
  };
}

function resetLocalSales() {
  localSales.delta = new Map();
  localSales.normalSettlementSeq = 0;
  localSales.lastNormalSettlementOrderIds = [];
  localSales.lastNormalSettlementProductIds = [];
}

afterEach(() => {
  cleanup();
  resetLocalSales();
  getInventorySnapshot.mockReset();
});

describe('usePosInventory composition / taint / requestId', () => {
  beforeEach(() => {
    resetLocalSales();
  });

  test('composes local-sales delta onto known stock', async () => {
    getInventorySnapshot.mockResolvedValue(snapshot([product('p1', 10)]));
    const { result, rerender } = renderHook(() => usePosInventory('B1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    localSales.delta = new Map([['p1', 3]]);
    rerender();
    expect(result.current.products[0]?.stock).toBe(7);
    expect(result.current.products[0]?.stockTruth).toEqual({
      state: 'known',
      asOf: 'server',
      localDeltaApplied: true,
    });
  });

  test('T35 retirement taint forces cache provenance until the next applied snapshot', async () => {
    getInventorySnapshot.mockResolvedValue(snapshot([product('p1', 10, 'server')]));
    const { result, rerender } = renderHook(() => usePosInventory('B1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    localSales.normalSettlementSeq = 1;
    localSales.lastNormalSettlementProductIds = ['p1'];
    rerender();
    expect(result.current.pendingRetirementRefresh).toBe(true);
    expect(result.current.products[0]?.stockTruth).toEqual({
      state: 'known',
      asOf: 'cache',
      localDeltaApplied: false,
    });
  });

  test('T34 superseded successful request cannot clear taint; T36 accepted-current apply can', async () => {
    let resolveInitial!: (value: InventorySnapshot) => void;
    let resolveStale!: (value: InventorySnapshot) => void;
    let resolveCurrent!: (value: InventorySnapshot) => void;
    getInventorySnapshot
      .mockImplementationOnce(() => new Promise<InventorySnapshot>((r) => { resolveInitial = r; }))
      .mockImplementationOnce(() => new Promise<InventorySnapshot>((r) => { resolveStale = r; }))
      .mockImplementationOnce(() => new Promise<InventorySnapshot>((r) => { resolveCurrent = r; }));

    const { result, rerender } = renderHook(() => usePosInventory('B1'));
    await act(async () => {
      resolveInitial(snapshot([product('p1', 10)]));
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    localSales.normalSettlementSeq = 1;
    localSales.lastNormalSettlementProductIds = ['p1'];
    rerender();
    expect(result.current.pendingRetirementRefresh).toBe(true);

    act(() => {
      result.current.refreshInventory();
    });
    act(() => {
      result.current.refreshInventory();
    });

    await act(async () => {
      resolveStale(snapshot([product('p1', 9)]));
    });
    expect(result.current.pendingRetirementRefresh).toBe(true);
    expect(result.current.products[0]?.stock).toBe(10);

    await act(async () => {
      resolveCurrent(snapshot([product('p1', 8)]));
    });
    expect(result.current.pendingRetirementRefresh).toBe(false);
    expect(result.current.products[0]?.stock).toBe(8);
    expect(result.current.products[0]?.stockTruth).toEqual({
      state: 'known',
      asOf: 'server',
      localDeltaApplied: false,
    });
  });

  test('T36 error path cannot clear taint', async () => {
    getInventorySnapshot.mockResolvedValueOnce(snapshot([product('p1', 10)]));
    const { result, rerender } = renderHook(() => usePosInventory('B1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    localSales.normalSettlementSeq = 1;
    localSales.lastNormalSettlementProductIds = ['p1'];
    rerender();
    expect(result.current.pendingRetirementRefresh).toBe(true);

    getInventorySnapshot.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      result.current.refreshInventory();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.pendingRetirementRefresh).toBe(true);
    expect(result.current.products[0]?.stockTruth).toEqual({
      state: 'known',
      asOf: 'cache',
      localDeltaApplied: false,
    });
  });

  test('T38 accepted-current cache-only apply clears taint but remains non-current', async () => {
    getInventorySnapshot.mockResolvedValueOnce(snapshot([product('p1', 10, 'server')], false));
    const { result, rerender } = renderHook(() => usePosInventory('B1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    localSales.normalSettlementSeq = 1;
    localSales.lastNormalSettlementProductIds = ['p1'];
    rerender();
    expect(result.current.pendingRetirementRefresh).toBe(true);

    getInventorySnapshot.mockResolvedValueOnce(snapshot([product('p1', 10, 'cache')], true));
    await act(async () => {
      result.current.refreshInventory();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.pendingRetirementRefresh).toBe(false));
    expect(result.current.fromCache).toBe(true);
    expect(result.current.products[0]?.stockTruth).toEqual({
      state: 'known',
      asOf: 'cache',
      localDeltaApplied: false,
    });
    expect(result.current.provenance?.stock.fromCache).toBe(true);
  });

  test('T39 exception-shaped local sales (no seq bump) raise no pendingRetirementRefresh', async () => {
    getInventorySnapshot.mockResolvedValue(snapshot([product('p1', 10)]));
    const { result, rerender } = renderHook(() => usePosInventory('B1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    localSales.delta = new Map();
    localSales.normalSettlementSeq = 0;
    rerender();
    expect(result.current.pendingRetirementRefresh).toBe(false);
  });

  test('RC-4 later retirement B during in-flight refresh A is not cleared by A', async () => {
    let resolveInitial!: (value: InventorySnapshot) => void;
    let resolveA!: (value: InventorySnapshot) => void;
    let resolveB!: (value: InventorySnapshot) => void;
    getInventorySnapshot
      .mockImplementationOnce(() => new Promise<InventorySnapshot>((r) => { resolveInitial = r; }))
      .mockImplementationOnce(() => new Promise<InventorySnapshot>((r) => { resolveA = r; }))
      .mockImplementationOnce(() => new Promise<InventorySnapshot>((r) => { resolveB = r; }));

    const { result, rerender } = renderHook(() => usePosInventory('B1'));
    await act(async () => {
      resolveInitial(snapshot([product('pA', 10), product('pB', 10)]));
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const byId = (id: string) => result.current.products.find((p) => p.id === id);

    localSales.normalSettlementSeq = 1;
    localSales.lastNormalSettlementProductIds = ['pA'];
    rerender();
    expect(result.current.pendingRetirementRefresh).toBe(true);
    expect(byId('pA')?.stockTruth).toEqual({
      state: 'known',
      asOf: 'cache',
      localDeltaApplied: false,
    });

    act(() => {
      result.current.refreshInventory();
    });

    localSales.normalSettlementSeq = 2;
    localSales.lastNormalSettlementProductIds = ['pB'];
    rerender();
    expect(result.current.pendingRetirementRefresh).toBe(true);
    expect(byId('pB')?.stockTruth).toEqual({
      state: 'known',
      asOf: 'cache',
      localDeltaApplied: false,
    });

    await act(async () => {
      resolveA(snapshot([product('pA', 9), product('pB', 10)]));
    });

    expect(byId('pA')?.stock).toBe(9);
    expect(byId('pA')?.stockTruth).toEqual({
      state: 'known',
      asOf: 'server',
      localDeltaApplied: false,
    });
    expect(byId('pB')?.stock).toBe(10);
    expect(byId('pB')?.stockTruth).toEqual({
      state: 'known',
      asOf: 'cache',
      localDeltaApplied: false,
    });
    expect(result.current.pendingRetirementRefresh).toBe(true);

    act(() => {
      result.current.refreshInventory();
    });
    await act(async () => {
      resolveB(snapshot([product('pA', 9), product('pB', 8)]));
    });

    expect(result.current.pendingRetirementRefresh).toBe(false);
    expect(byId('pA')?.stock).toBe(9);
    expect(byId('pA')?.stockTruth).toEqual({
      state: 'known',
      asOf: 'server',
      localDeltaApplied: false,
    });
    expect(byId('pB')?.stock).toBe(8);
    expect(byId('pB')?.stockTruth).toEqual({
      state: 'known',
      asOf: 'server',
      localDeltaApplied: false,
    });
  });
});
