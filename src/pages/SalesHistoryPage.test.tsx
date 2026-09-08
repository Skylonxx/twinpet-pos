// @vitest-environment jsdom

/**
 * SEC-001 Packet E / E-1 — Sales History void CTA plumbing.
 *
 * GD-E-008: the Firebase-configured production void CTA is privileged-only.
 * This file proves the page-level plumbing: clicking the CTA opens the
 * privileged flow with the SELECTED ORDER's own branch/action/operator
 * (never the ambient `branchId`, mirroring the retired RC-D3-003 binding
 * discipline), and NEVER falls back to the legacy dev-mock void path while
 * Firebase is configured. The dev/mock path (`!isFirebaseConfigured`) is
 * preserved unchanged and is proven separately below.
 *
 * The deeper privileged flow sequencing (reason -> manager -> PIN -> D-3
 * outcomes, staleness, restart recovery) is covered by
 * `SalesHistoryPage.privilegedVoid.test.tsx`, `usePrivilegedVoidFlow.test.tsx`,
 * and `privilegedVoidFlowMachine.test.ts` — this file stays narrowly scoped
 * to the CTA-level wiring.
 */
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SaleRecord } from '../lib/salesHistory/types';
import type { VoidIntentRecord } from '../lib/pos/offline/voidIntentStore';
import type { UsePrivilegedVoidFlowResult } from '../hooks/pos/usePrivilegedVoidFlow';

const historyState = {
  records: [] as SaleRecord[],
  loading: false,
  error: null as Error | null,
  refresh: vi.fn(),
  syncDevRecords: vi.fn(),
};

let authBranchId: string | null = 'LDP-001';
let voidRows: VoidIntentRecord[] = [];
let firebaseConfigured = true;

const voidOrderSafeMock = vi.fn<(input: Record<string, unknown>) => Promise<void>>();
const openPrivilegedVoidMock = vi.fn();

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'staff1', role: 'staff', name: 'Dao', firstName: 'Dao', lastName: 'K' },
    branchId: authBranchId,
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
  get isFirebaseConfigured() {
    return firebaseConfigured;
  },
}));

vi.mock('../lib/voidOrder', () => ({
  voidOrderSafe: (input: Record<string, unknown>) => voidOrderSafeMock(input),
}));

vi.mock('../lib/branches', () => ({
  getBranchLabel: (id: string) => id,
}));

vi.mock('../lib/pos/offline/reversalLocalStore', () => ({
  createIndexedDbReversalStore: () => ({}),
}));

vi.mock('../lib/pos/offline/voidIntentStore', () => ({
  listVoidIntents: async () => voidRows,
  subscribeVoidIntentStore: () => () => {},
  utcPlus7Date: (ms: number) => new Date(ms).toISOString().slice(0, 10),
}));

vi.mock('../hooks/pos/usePrivilegedVoidFlow', () => ({
  usePrivilegedVoidFlow: (): UsePrivilegedVoidFlowResult => ({
    state: { status: 'IDLE' },
    roster: { status: 'disabled', fromCache: false, candidates: [] },
    isSubmitting: false,
    open: (order) => openPrivilegedVoidMock(order),
    submitReason: vi.fn(),
    chooseManager: vi.fn(),
    backToManagerSelect: vi.fn(),
    submitPin: vi.fn(),
    close: vi.fn(),
    retryReconciliation: vi.fn(),
  }),
}));

import SalesHistoryPage from './SalesHistoryPage';

function record(id: string, orderBranchId: string): SaleRecord {
  const createdAt = new Date();
  return {
    order: {
      id,
      billId: id,
      branchId: orderBranchId,
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
        branchId: orderBranchId,
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
  voidRows = [];
  authBranchId = 'LDP-001';
  firebaseConfigured = true;
  voidOrderSafeMock.mockReset();
  openPrivilegedVoidMock.mockReset();
});

async function openDrawerAndClickVoid(billId: string): Promise<void> {
  fireEvent.click(screen.getByText(billId));
  await waitFor(() => {
    expect(screen.getByText(/^ยกเลิกบิล/)).toBeTruthy();
  });
  fireEvent.click(screen.getByText(/^ยกเลิกบิล/));
}

describe('SalesHistoryPage — privileged-only void CTA (GD-E-008)', () => {
  test('Firebase-configured: the CTA opens the privileged flow with the ORDER\'s own branch/action/operator, never the legacy dev-mock path', async () => {
    firebaseConfigured = true;
    authBranchId = 'LDP-001';
    historyState.records = [record('BILL-A', 'LDP-001')];

    render(createElement(SalesHistoryPage));
    await waitFor(() => expect(screen.getByText('BILL-A')).toBeTruthy());
    await openDrawerAndClickVoid('BILL-A');

    expect(openPrivilegedVoidMock).toHaveBeenCalledTimes(1);
    const order = openPrivilegedVoidMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(order.targetOrderId).toBe('BILL-A');
    expect(order.targetBranchId).toBe('LDP-001');
    expect(order.operatorStaffId).toBe('staff1');
    expect(order.actionId).toBe('VOID_SETTLED_SALE');
    expect(voidOrderSafeMock).not.toHaveBeenCalled();
    // The legacy confirmation dialog never opens in the Firebase-configured path.
    expect(screen.queryByText('ยืนยันการยกเลิกบิล')).toBeNull();
  });

  test('Firebase-configured, cross-branch order: sources targetBranchId from the ORDER itself, independently of the ambient branchId', async () => {
    firebaseConfigured = true;
    authBranchId = 'LDP-002';
    historyState.records = [record('BILL-STALE', 'LDP-001')];

    render(createElement(SalesHistoryPage));
    await waitFor(() => expect(screen.getByText('BILL-STALE')).toBeTruthy());
    await openDrawerAndClickVoid('BILL-STALE');

    const order = openPrivilegedVoidMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(order.targetBranchId).toBe('LDP-001');
    expect(order.targetBranchId).not.toBe(authBranchId);
  });

  test('pending-sale order requests VOID_PENDING_SALE, settled requests VOID_SETTLED_SALE', async () => {
    firebaseConfigured = true;
    const pending = { ...record('BILL-PENDING', 'LDP-001'), pendingSync: true, verdict: 'PROVISIONAL' as const };
    historyState.records = [pending];

    render(createElement(SalesHistoryPage));
    await waitFor(() => expect(screen.getByText('BILL-PENDING')).toBeTruthy());
    await openDrawerAndClickVoid('BILL-PENDING');

    const order = openPrivilegedVoidMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(order.actionId).toBe('VOID_PENDING_SALE');
  });

  test('dev/mock mode (no Firebase): the legacy void dialog still works, and the privileged flow is never opened', async () => {
    firebaseConfigured = false;
    historyState.records = [record('BILL-DEV', 'LDP-001')];
    voidOrderSafeMock.mockResolvedValue(undefined);

    render(createElement(SalesHistoryPage));
    await waitFor(() => expect(screen.getByText('BILL-DEV')).toBeTruthy());
    await openDrawerAndClickVoid('BILL-DEV');

    const title = await screen.findByText('ยืนยันการยกเลิกบิล');
    const dialog = title.closest('[role="dialog"]') as HTMLElement;
    fireEvent.change(dialog.querySelector('select')!, { target: { value: 'ลูกค้าเปลี่ยนใจ' } });
    fireEvent.click(screen.getByText('ยืนยันยกเลิกบิล'));

    await waitFor(() => expect(voidOrderSafeMock).toHaveBeenCalledTimes(1));
    expect(openPrivilegedVoidMock).not.toHaveBeenCalled();
  });
});
