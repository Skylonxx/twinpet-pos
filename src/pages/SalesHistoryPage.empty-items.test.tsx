// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SaleRecord } from '../lib/salesHistory/types';

const live = {
  items: [] as Array<{ id: string }>,
  state: 'empty' as 'empty' | 'unavailable' | 'error' | 'loading' | 'live',
  fromCache: false,
};

const historyState = {
  records: [] as SaleRecord[],
  loading: false,
  error: null as Error | null,
  refresh: vi.fn(),
  syncDevRecords: vi.fn(),
};

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'staff1', role: 'staff', name: 'Dao' },
    branchId: 'br-display',
  }),
}));

vi.mock('../lib/salesHistory/useSalesHistory', () => ({
  useSalesHistory: () => historyState,
}));

vi.mock('../lib/salesHistory/useOrderItemsLive', () => ({
  useOrderItemsLive: () => live,
}));

vi.mock('../lib/pos/usePosProducts', () => ({
  usePosProducts: () => ({ products: [] }),
}));

vi.mock('../lib/documents/receiptFetch', () => ({
  fetchOrderReceipt: vi.fn(),
}));

vi.mock('../lib/documents/receiptSettings', () => ({
  loadReceiptSettingsForOrderBranch: vi.fn().mockResolvedValue({}),
}));

vi.mock('../components/documents/ThermalReceipt', () => ({
  default: () => createElement('div', { 'data-testid': 'thermal-receipt' }),
}));

vi.mock('../components/common/DateRangeDropdown', () => ({
  DateRangeDropdown: () => createElement('div', { 'data-testid': 'date-range' }),
}));

vi.mock('../lib/firebase', () => ({
  isFirebaseConfigured: true,
}));

vi.mock('../lib/voidOrder', () => ({
  voidOrderSafe: vi.fn(),
}));

vi.mock('../lib/pos/voidPendingOrder', () => ({
  requestPendingVoid: vi.fn(),
}));

vi.mock('../lib/pos/offline/reversalLocalStore', () => ({
  createIndexedDbReversalStore: () => ({}),
}));

vi.mock('../lib/pos/offline/voidIntentStore', () => ({
  listVoidIntents: vi.fn().mockResolvedValue([]),
  subscribeVoidIntentStore: () => () => {},
}));

vi.mock('../lib/branches', () => ({
  getBranchLabel: (id: string) => id,
}));

import SalesHistoryPage from './SalesHistoryPage';

function record(id: string): SaleRecord {
  const createdAt = new Date();
  return {
    order: {
      id,
      billId: id,
      branchId: 'br-display',
      customerId: null,
      customerSnap: null,
      staffId: 's',
      staffName: 'Dao',
      status: 'completed',
      subtotal: 100,
      discountAmt: 0,
      billDiscount: 0,
      vatRate: 0,
      vatAmt: 0,
      surcharge: 0,
      total: 100,
      paidAmt: 100,
      changeAmt: 0,
      creditAmt: 0,
      priceLevelId: 'RETAIL',
      note: '',
      voidReason: null,
      voidedBy: null,
      voidedAt: null,
      printCount: 0,
      createdAt: createdAt as never,
      updatedAt: createdAt as never,
    },
    payments: [
      {
        id: 'p1',
        orderId: id,
        branchId: 'br-display',
        method: 'cash',
        amount: 100,
        ref: null,
        createdAt: createdAt as never,
      },
    ],
    items: [],
    pendingSync: false,
    verdict: 'CURRENT',
    verdictReason: null,
  };
}

afterEach(() => {
  cleanup();
  historyState.records = [];
  live.state = 'empty';
  live.fromCache = false;
});

describe('SalesHistoryPage empty items', () => {
  test('T45 itemsEmpty copy is distinct from unavailable / error / loading', () => {
    historyState.records = [record('BILL-1')];

    live.state = 'empty';
    render(<SalesHistoryPage />);
    fireEvent.click(screen.getByText('BILL-1'));
    expect(screen.getByText('บิลนี้ไม่มีรายการสินค้า')).toBeTruthy();

    cleanup();
    live.state = 'unavailable';
    render(<SalesHistoryPage />);
    fireEvent.click(screen.getByText('BILL-1'));
    expect(screen.getByText('ไม่พบรายการสินค้าของบิลนี้ / กำลังตรวจสอบ')).toBeTruthy();

    cleanup();
    live.state = 'error';
    render(<SalesHistoryPage />);
    fireEvent.click(screen.getByText('BILL-1'));
    expect(screen.getByText('ไม่สามารถโหลดรายการสินค้าได้')).toBeTruthy();

    cleanup();
    live.state = 'loading';
    render(<SalesHistoryPage />);
    fireEvent.click(screen.getByText('BILL-1'));
    expect(screen.getByText('กำลังโหลดรายการ...')).toBeTruthy();
  });
});
