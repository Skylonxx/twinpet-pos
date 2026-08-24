// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AsyncOrder } from '../types';

type OnNext = (snap: { docs: Array<{ id: string; data: () => AsyncOrder }> }) => void;

const listeners: OnNext[] = [];
const getDeviceId = vi.fn(() => 'DEV1');

vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, name: string) => ({ name }),
  onSnapshot: (_q: unknown, next: OnNext) => {
    listeners.push(next);
    return vi.fn();
  },
  query: (ref: unknown) => ref,
  where: vi.fn((field: string, _op: string, value: string) => ({ field, value })),
}));

vi.mock('../firebase', () => ({
  db: {},
  isFirebaseConfigured: true,
}));

vi.mock('../pos/deviceId', () => ({
  getDeviceId: () => getDeviceId(),
}));

import { useLocalSalesDelta } from './useLocalSalesDelta';

function orderDoc(id: string, overrides: Partial<AsyncOrder> = {}): { id: string; data: () => AsyncOrder } {
  return {
    id,
    data: () =>
      ({
        id,
        billId: id,
        deviceId: 'DEV1',
        branchId: 'B1',
        shiftId: 'S1',
        staffId: 'U1',
        staffName: 'Staff',
        customerId: null,
        customerSnap: null,
        priceLevelId: 'retail',
        lines: [
          {
            productId: 'p1',
            productSnap: { name: 'p1', sku: 'p1', category: 'cat' },
            unit: 'ชิ้น',
            unitFactor: 1,
            qty: 2,
            qtyBase: 2,
            unitPrice: 10,
            discountAmt: 0,
            lineTotal: 10,
          },
        ],
        payments: [],
        subtotal: 0,
        discountAmt: 0,
        billDiscount: 0,
        fee: 0,
        vatRate: 0,
        vatAmt: 0,
        total: 0,
        paidAmt: 0,
        changeAmt: 0,
        creditAmt: 0,
        status: 'completed',
        reconcileStatus: 'pending_reconcile',
        reconciledAt: null,
        note: '',
        printCount: 0,
        clientCreatedAt: 1,
        serverCreatedAt: null,
        updatedAt: null,
        ...overrides,
      }) as AsyncOrder,
  };
}

afterEach(() => {
  cleanup();
  listeners.length = 0;
  getDeviceId.mockReturnValue('DEV1');
});

describe('useLocalSalesDelta', () => {
  test('T31-scope fail-closed on null and ALL — no listener, empty delta', () => {
    const { result: n } = renderHook(() => useLocalSalesDelta(null));
    expect(n.current.delta.size).toBe(0);
    expect(listeners.length).toBe(0);
    const { result: a } = renderHook(() => useLocalSalesDelta('ALL'));
    expect(a.current.delta.size).toBe(0);
    expect(listeners.length).toBe(0);
  });

  test('scopes the listener with caller branchId + getDeviceId()', () => {
    renderHook(() => useLocalSalesDelta('B1'));
    expect(getDeviceId).toHaveBeenCalled();
    expect(listeners.length).toBe(1);
  });

  test('T23/T33 retirement seq increments only on normal settlement and coalesces in one seq step per snapshot', () => {
    const { result } = renderHook(() => useLocalSalesDelta('B1'));
    act(() => listeners[0]!({ docs: [orderDoc('a'), orderDoc('b')] }));
    expect(result.current.delta.get('p1')).toBe(4);
    expect(result.current.normalSettlementSeq).toBe(0);
    act(() =>
      listeners[0]!({
        docs: [
          orderDoc('a', { reconcileStatus: 'settled' }),
          orderDoc('b', { reconcileStatus: 'settled' }),
        ],
      }),
    );
    expect(result.current.normalSettlementSeq).toBe(1);
    expect(result.current.lastNormalSettlementOrderIds).toEqual(['a', 'b']);
    expect(result.current.delta.size).toBe(0);
  });

  test('T24 exception snapshot does not increment normalSettlementSeq', () => {
    const { result } = renderHook(() => useLocalSalesDelta('B1'));
    act(() => listeners[0]!({ docs: [orderDoc('a')] }));
    act(() => listeners[0]!({ docs: [orderDoc('a', { reconcileStatus: 'exception' })] }));
    expect(result.current.normalSettlementSeq).toBe(0);
    expect(result.current.delta.size).toBe(0);
  });
});
