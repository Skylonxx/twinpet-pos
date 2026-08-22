// @vitest-environment jsdom

import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SaleRecord } from '../lib/salesHistory/types';
import type { VoidIntentRecord } from '../lib/pos/offline/voidIntentStore';

const historyState = {
  records: [] as SaleRecord[],
  loading: false,
  error: null as Error | null,
  refresh: vi.fn(),
  syncDevRecords: vi.fn(),
};

let voidRows: VoidIntentRecord[] = [];
let storeListener: (() => void) | null = null;

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
  useOrderItemsLive: () => ({ items: [], state: 'live', fromCache: false }),
}));

vi.mock('../lib/pos/usePosProducts', () => ({
  usePosProducts: () => ({ products: [] }),
}));

vi.mock('../lib/documents/receiptFetch', () => ({
  fetchOrderReceipt: vi.fn(),
}));

vi.mock('../lib/documents/receiptSettings', () => ({
  loadReceiptSettingsForOrderBranch: vi.fn(),
}));

vi.mock('../components/documents/ThermalReceipt', () => ({
  default: () => null,
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

vi.mock('../lib/branches', () => ({
  getBranchLabel: (id: string) => id,
}));

vi.mock('../lib/pos/offline/reversalLocalStore', () => ({
  createIndexedDbReversalStore: () => ({}),
}));

vi.mock('../lib/pos/offline/voidIntentStore', () => ({
  listVoidIntents: async () => voidRows,
  subscribeVoidIntentStore: (fn: () => void) => {
    storeListener = fn;
    return () => {
      storeListener = null;
    };
  },
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

function terminalIntent(orderId: string): VoidIntentRecord {
  return {
    orderId,
    branchId: 'br-display',
    deviceId: 'dev-1',
    reason: 'ลูกค้าเปลี่ยนใจ',
    note: null,
    voidedBy: 'staff1',
    status: 'terminal',
    attempts: 1,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    nextEligibleAtMs: 0,
    claimOwner: null,
    claimExpiresAtMs: null,
    lastErrorClass: 'permission_denied',
    lastErrorAtMs: Date.now(),
    terminalReason: 'staff_identity_mismatch',
    confirmedAtMs: null,
    observedServerCreatedAtMs: null,
    schemaVersion: 1,
  };
}

afterEach(() => {
  cleanup();
  historyState.records = [];
  voidRows = [];
  storeListener = null;
});

describe('SalesHistoryPage PK-3 same-tab terminal void freshness', () => {
  beforeEach(() => {
    historyState.records = [record('BILL-TERM')];
    voidRows = [];
  });

  test('already-mounted page updates row and drawer when a queued void becomes terminal', async () => {
    render(createElement(SalesHistoryPage));
    await waitFor(() => {
      expect(screen.getByText('BILL-TERM')).toBeTruthy();
    });
    expect(screen.queryByText('ยกเลิกไม่สำเร็จ')).toBeNull();

    voidRows = [terminalIntent('BILL-TERM')];
    await act(async () => {
      storeListener?.();
    });

    await waitFor(() => {
      expect(screen.getByText('ยกเลิกไม่สำเร็จ')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('BILL-TERM'));
    await waitFor(() => {
      expect(
        screen.getByText(
          'คำขอยกเลิกไม่ได้ถูกส่ง เพราะพนักงานที่ขอไม่ตรงกับพนักงานปัจจุบัน — ให้ผู้จัดการตรวจสอบ',
        ),
      ).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /ซิงก์|Sync Center/i })).toBeNull();
  });

  test('unmount unsubscribes and ignores a later store notification', async () => {
    const view = render(createElement(SalesHistoryPage));
    await waitFor(() => {
      expect(screen.getByText('BILL-TERM')).toBeTruthy();
    });
    const leaked = storeListener;
    expect(leaked).toBeTypeOf('function');
    view.unmount();
    expect(storeListener).toBeNull();

    voidRows = [terminalIntent('BILL-TERM')];
    await act(async () => {
      leaked?.();
    });
    expect(screen.queryByText('ยกเลิกไม่สำเร็จ')).toBeNull();
  });
});
