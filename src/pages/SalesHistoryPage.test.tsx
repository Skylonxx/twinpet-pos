// @vitest-environment jsdom

/**
 * SEC-001 Packet D / D-3, RC-D3-003 — exact narrow SalesHistory safety
 * wiring. Proves the page sources `targetOrderBranchId` from the SELECTED
 * ORDER's own record (`selected.order.branchId`), independently of the
 * current trusted `branchId` (`useAuth().branchId`), and passes BOTH
 * distinct values through to `requestPendingVoid` without collapsing them
 * into a caller-invented fallback — even when they mismatch (the stale
 * cross-branch selection schedule Codex identified). The library-level
 * fail-closed enforcement of a mismatch is proven in
 * `voidPendingOrder.test.ts` against the REAL `requestPendingVoid`; this
 * page-level test only proves the UI plumbing is honest, per the narrow
 * machine-safety-only UI boundary (no modal sequencing, no new copy, no
 * ManagerPinModal/Sync Center/Packet E behavior changed or added).
 */
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SaleRecord } from '../lib/salesHistory/types';
import type { VoidIntentRecord } from '../lib/pos/offline/voidIntentStore';
import type { VoidRequestOutcome } from '../lib/pos/voidPendingOrder';

const historyState = {
  records: [] as SaleRecord[],
  loading: false,
  error: null as Error | null,
  refresh: vi.fn(),
  syncDevRecords: vi.fn(),
};

let authBranchId: string | null = 'LDP-001';
let voidRows: VoidIntentRecord[] = [];

const requestPendingVoidMock = vi.fn<(orderId: string, input: Record<string, unknown>) => Promise<VoidRequestOutcome>>();

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'staff1', role: 'staff', name: 'Dao' },
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
  isFirebaseConfigured: true,
}));

vi.mock('../lib/voidOrder', () => ({
  voidOrderSafe: vi.fn(),
}));

vi.mock('../lib/pos/voidPendingOrder', () => ({
  requestPendingVoid: (orderId: string, input: Record<string, unknown>) => requestPendingVoidMock(orderId, input),
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
  requestPendingVoidMock.mockReset();
});

async function openVoidDialogAndConfirm(billId: string): Promise<void> {
  fireEvent.click(screen.getByText(billId));
  await waitFor(() => {
    expect(screen.getByText('ยกเลิกบิล')).toBeTruthy();
  });
  fireEvent.click(screen.getByText('ยกเลิกบิล'));
  // The Sales History drawer is also `role="dialog"`, so scope to the void
  // modal specifically via its unique title rather than `getByRole('dialog')`.
  const title = await screen.findByText('ยืนยันการยกเลิกบิล');
  const dialog = title.closest('[role="dialog"]') as HTMLElement;
  const select = within(dialog).getByRole('combobox');
  fireEvent.change(select, { target: { value: 'ลูกค้าเปลี่ยนใจ' } });
  await act(async () => {
    fireEvent.click(within(dialog).getByText('ยืนยันยกเลิกบิล'));
  });
}

describe('SalesHistoryPage — RC-D3-003 target-branch binding plumbing', () => {
  test('same-branch order: requestPendingVoid receives matching branchId and targetOrderBranchId', async () => {
    authBranchId = 'LDP-001';
    historyState.records = [record('BILL-MATCH', 'LDP-001')];
    requestPendingVoidMock.mockResolvedValue({ kind: 'queued' });

    render(createElement(SalesHistoryPage));
    await waitFor(() => {
      expect(screen.getByText('BILL-MATCH')).toBeTruthy();
    });
    await openVoidDialogAndConfirm('BILL-MATCH');

    await waitFor(() => {
      expect(requestPendingVoidMock).toHaveBeenCalledTimes(1);
    });
    const [orderId, input] = requestPendingVoidMock.mock.calls[0]!;
    expect(orderId).toBe('BILL-MATCH');
    expect(input.branchId).toBe('LDP-001');
    expect(input.targetOrderBranchId).toBe('LDP-001');
  });

  test('cross-branch order (stale selection): the page still sources targetOrderBranchId from the order itself, independently of the current branchId — no page-level fallback/collapse', async () => {
    authBranchId = 'LDP-002';
    historyState.records = [record('BILL-STALE', 'LDP-001')];
    requestPendingVoidMock.mockResolvedValue({ kind: 'blocked', reason: 'authority_refused' });

    render(createElement(SalesHistoryPage));
    await waitFor(() => {
      expect(screen.getByText('BILL-STALE')).toBeTruthy();
    });
    await openVoidDialogAndConfirm('BILL-STALE');

    await waitFor(() => {
      expect(requestPendingVoidMock).toHaveBeenCalledTimes(1);
    });
    const [orderId, input] = requestPendingVoidMock.mock.calls[0]!;
    expect(orderId).toBe('BILL-STALE');
    expect(input.branchId).toBe('LDP-002');
    expect(input.targetOrderBranchId).toBe('LDP-001');
    expect(input.branchId).not.toBe(input.targetOrderBranchId);
  });
});
