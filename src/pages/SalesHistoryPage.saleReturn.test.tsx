// @vitest-environment jsdom

/**
 * Return/Refund V1 (D-RET-8) — Sales History `คืนสินค้า / คืนเงิน` through the
 * real SalesHistoryPage + SaleReturnModal + ManagerPinModal stack. Only the
 * callable adapters, the active-shift read and the roster subscription are
 * mocked. Return is a distinct flow: it never touches the Void flow.
 */
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SaleRecord } from '../lib/salesHistory/types';
import type { VoidIntentRecord } from '../lib/pos/offline/voidIntentStore';
import type { ApproverRosterState } from '../lib/auth/useApproverRoster';
import type { SaleReturnContextResult, SubmitSaleReturnResult } from '../lib/saleReturn/saleReturnService';
import type { SaleReturnContextView } from '../lib/saleReturn/saleReturnTypes';

const historyState = {
  records: [] as SaleRecord[],
  loading: false,
  error: null as Error | null,
  refresh: vi.fn(),
  syncDevRecords: vi.fn(),
};

const rosterState: ApproverRosterState = {
  status: 'ready',
  fromCache: false,
  candidates: [{ userId: 'mgr-1', displayName: 'Manager One', username: 'm1', role: 'manager' }],
};

const fetchContextMock = vi.fn<(orderId: string, branchId: string) => Promise<SaleReturnContextResult>>();
const submitMock = vi.fn<(input: Record<string, unknown>) => Promise<SubmitSaleReturnResult>>();
const refreshShiftMock = vi.fn(async () => undefined);
const getActiveShiftMock = vi.fn(async () => ({ id: 'SH1' }) as never);
const projectVoidMock = vi.fn();

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'staff1', role: 'staff', name: 'Dao', firstName: 'Dao', lastName: 'K' },
    branchId: 'LDP-001',
    ensurePrivilegedStaffSession: async () => 'ready',
    invalidateStaffSession: () => undefined,
  }),
}));
vi.mock('../lib/salesHistory/useSalesHistory', () => ({ useSalesHistory: () => historyState }));
vi.mock('../lib/salesHistory/useOrderItemsLive', () => ({ useOrderItemsLive: () => ({ items: [], state: 'live', fromCache: false }) }));
vi.mock('../lib/pos/usePosProducts', () => ({ usePosProducts: () => ({ products: [] }) }));
vi.mock('../lib/documents/receiptFetch', () => ({ fetchOrderReceipt: vi.fn() }));
vi.mock('../lib/documents/receiptSettings', () => ({ loadReceiptSettingsForOrderBranch: vi.fn() }));
vi.mock('../components/documents/ThermalReceipt', () => ({ default: () => null }));
// The page defaults to "today"; the Return fixtures are cross-day sales, so the
// mocked range control widens the filter to the last 7 days on click.
vi.mock('../components/common/DateRangeDropdown', () => ({
  DateRangeDropdown: (props: { onChange: (v: { preset: string; from: string; to: string }) => void }) =>
    createElement('button', {
      'data-testid': 'date-range',
      type: 'button',
      onClick: () => props.onChange({ preset: '7d', from: '', to: '' }),
    }),
}));
vi.mock('../lib/firebase', () => ({ isFirebaseConfigured: true }));
vi.mock('../lib/voidOrder', () => ({ voidOrderSafe: vi.fn() }));
vi.mock('../lib/branches', () => ({ getBranchLabel: (id: string) => id }));
vi.mock('../lib/pos/offline/voidIntentStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pos/offline/voidIntentStore')>();
  return { ...actual, listVoidIntents: async () => [] as VoidIntentRecord[], subscribeVoidIntentStore: () => () => {} };
});
vi.mock('../lib/auth/useApproverRoster', () => ({ useApproverRoster: () => rosterState }));
vi.mock('../lib/pos/offline/projectPrivilegedOfflineAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pos/offline/projectPrivilegedOfflineAction')>();
  return { ...actual, projectPrivilegedOfflineAction: (input: unknown) => projectVoidMock(input) };
});
vi.mock('../lib/pos/shiftService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pos/shiftService')>();
  return { ...actual, getActiveShift: () => getActiveShiftMock() };
});
vi.mock('../lib/saleReturn/saleReturnService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/saleReturn/saleReturnService')>();
  return {
    ...actual,
    fetchSaleReturnContext: (orderId: string, branchId: string) => fetchContextMock(orderId, branchId),
    submitSaleReturnRequest: (input: Record<string, unknown>) => submitMock(input),
    refreshShiftFromServer: () => refreshShiftMock(),
    newReturnAttemptId: () => 'attempt-ui-0001',
  };
});

import SalesHistoryPage from './SalesHistoryPage';

function record(id: string, over: Partial<SaleRecord['order']> = {}, pendingSync = false): SaleRecord {
  const createdAt = new Date(Date.now() - 3 * 86_400_000); // cross-day sale
  return {
    order: {
      id,
      billId: id,
      branchId: 'LDP-001',
      customerId: null,
      customerSnap: null,
      staffId: 's',
      staffName: 'Dao',
      status: 'completed',
      subtotal: 1050,
      discountAmt: 50,
      billDiscount: 105,
      vatRate: 0,
      vatAmt: 0,
      surcharge: 0,
      total: 945,
      paidAmt: 1000,
      changeAmt: 55,
      creditAmt: 0,
      priceLevelId: 'RETAIL',
      note: '',
      voidReason: null,
      voidedBy: null,
      voidedAt: null,
      printCount: 0,
      createdAt: createdAt as never,
      updatedAt: createdAt as never,
      ...over,
    },
    payments: [{ id: 'p1', orderId: id, branchId: 'LDP-001', method: 'cash', amount: 1000, ref: null, createdAt: createdAt as never }],
    items: [],
    pendingSync,
    verdict: pendingSync ? 'PROVISIONAL' : 'CURRENT',
    verdictReason: null,
  };
}

function context(over: Partial<SaleReturnContextView> = {}): SaleReturnContextView {
  return {
    orderId: 'BILL-R1',
    billId: 'BILL-R1',
    branchId: 'LDP-001',
    customerName: 'คุณลูกค้า',
    saleCreatedAtMs: Date.now() - 3 * 86_400_000,
    total: 945,
    refundedTotal: 162,
    returnCount: 1,
    fullyReturned: false,
    lines: [
      {
        lineIndex: 0,
        productId: 'P1',
        productName: 'อาหารแมว',
        sku: 'CF',
        unit: 'ถุง',
        soldQty: 5,
        returnedQty: 2,
        returnableQty: 3,
        soldQtyMilli: 5000,
        returnedQtyMilli: 2000,
        unitPrice: 100,
        lineDiscount: 50,
        lineTotal: 450,
        billDiscountAlloc: 45,
        feeAlloc: 0,
        refundableShareMinor: 40500,
        refundedAmount: 162,
      },
    ],
    refundMethods: [{ method: 'cash', remaining: 783 }],
    ...over,
  };
}

let onlineValue = true;

beforeEach(() => {
  onlineValue = true;
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => onlineValue });
  fetchContextMock.mockReset();
  submitMock.mockReset();
  refreshShiftMock.mockClear();
  getActiveShiftMock.mockClear();
  projectVoidMock.mockReset();
});

afterEach(() => {
  cleanup();
  historyState.records = [];
});

async function openReturn(billId: string): Promise<void> {
  render(createElement(SalesHistoryPage));
  fireEvent.click(screen.getByTestId('date-range'));
  await waitFor(() => expect(screen.getByText(billId)).toBeTruthy());
  fireEvent.click(screen.getByText(billId));
  await waitFor(() => expect(screen.getByTestId('sale-return-open')).toBeTruthy());
}

describe('SalesHistoryPage — คืนสินค้า / คืนเงิน', () => {
  test('cross-day eligible sale: shows sold / returned / returnable, previews refund, Manager approves, success shows record number', async () => {
    fetchContextMock.mockResolvedValue({ kind: 'ok', classification: 'RETURN_ELIGIBLE', reason: null, context: context() });
    submitMock.mockResolvedValue({
      kind: 'ok',
      returnId: 'r'.repeat(40),
      returnNo: 'RT-BILL-R1-2',
      refundId: 'r'.repeat(40),
      refundAmount: 81,
      refundMethod: 'cash',
      idempotent: false,
    });
    historyState.records = [record('BILL-R1')];
    await openReturn('BILL-R1');

    // The cross-day Void stays disabled; Return is offered.
    expect(screen.getByText('ยกเลิกบิล (ข้ามวัน)')).toBeTruthy();
    fireEvent.click(screen.getByTestId('sale-return-open'));

    const modal = await screen.findByTestId('sale-return-modal');
    const line = await within(modal).findByTestId('sale-return-line-0');
    expect(within(line).getByText('ขาย 5')).toBeTruthy();
    expect(within(line).getByText('คืนแล้ว 2')).toBeTruthy();
    expect(within(line).getByText('คืนได้ 3')).toBeTruthy();
    expect(fetchContextMock).toHaveBeenCalledWith('BILL-R1', 'LDP-001');

    fireEvent.change(within(line).getByLabelText('จำนวนคืน'), { target: { value: '1' } });
    expect(within(modal).getByTestId('sale-return-total').textContent).toContain('81.00');
    await waitFor(() => expect(getActiveShiftMock).toHaveBeenCalled());
    fireEvent.change(within(modal).getByLabelText(/ช่องทางคืนเงิน/), { target: { value: 'cash' } });
    fireEvent.change(within(modal).getByLabelText(/เหตุผลการคืน/), { target: { value: 'สินค้าชำรุด/เสียหาย' } });
    fireEvent.change(within(modal).getByLabelText(/ผู้จัดการที่อนุมัติ/), { target: { value: 'mgr-1' } });
    fireEvent.click(within(modal).getByTestId('sale-return-request-approval'));

    const pinModal = await screen.findByTestId('sale-return-pin-modal');
    expect(within(pinModal).getByTestId('sale-return-approver').textContent).toContain('Manager One');
    for (const d of ['1', '2', '3', '4']) fireEvent.click(within(pinModal).getByText(d));
    await act(async () => {
      fireEvent.click(within(pinModal).getByText('ยืนยัน'));
    });

    await waitFor(() => expect(screen.getByTestId('sale-return-success')).toBeTruthy());
    expect(screen.getByTestId('sale-return-success').textContent).toContain('RT-BILL-R1-2');
    expect(submitMock).toHaveBeenCalledTimes(1);
    const sent = submitMock.mock.calls[0]![0];
    expect(sent).toMatchObject({
      attemptId: 'attempt-ui-0001',
      orderId: 'BILL-R1',
      branchId: 'LDP-001',
      lines: [{ lineIndex: 0, productId: 'P1', qty: 1 }],
      refundMethod: 'cash',
      expectedRefundAmount: 81,
      shiftId: 'SH1',
      approverStaffId: 'mgr-1',
      pin: '1234',
      reason: 'สินค้าชำรุด/เสียหาย',
    });
    expect(refreshShiftMock).toHaveBeenCalledTimes(1);
    expect(projectVoidMock).not.toHaveBeenCalled();
  });

  test('qty above returnable is blocked locally with a visible error (no approval, no submit)', async () => {
    fetchContextMock.mockResolvedValue({ kind: 'ok', classification: 'RETURN_ELIGIBLE', reason: null, context: context() });
    historyState.records = [record('BILL-R1')];
    await openReturn('BILL-R1');
    fireEvent.click(screen.getByTestId('sale-return-open'));
    const line = await screen.findByTestId('sale-return-line-0');
    fireEvent.change(within(line).getByLabelText('จำนวนคืน'), { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('sale-return-request-approval'));
    expect(screen.getByTestId('sale-return-error').textContent).toContain('คืนได้สูงสุด 3');
    expect(screen.queryByTestId('sale-return-pin-modal')).toBeNull();
    expect(submitMock).not.toHaveBeenCalled();
  });

  test('fully returned / unsupported historical evidence fail closed with a visible reason', async () => {
    fetchContextMock.mockResolvedValueOnce({ kind: 'ok', classification: 'RETURN_NOT_ELIGIBLE', reason: 'fully_returned', context: context({ fullyReturned: true }) });
    historyState.records = [record('BILL-R1')];
    await openReturn('BILL-R1');
    fireEvent.click(screen.getByTestId('sale-return-open'));
    expect((await screen.findByTestId('sale-return-blocked')).textContent).toContain('คืนสินค้าครบทุกรายการแล้ว');
    cleanup();

    fetchContextMock.mockResolvedValueOnce({ kind: 'ok', classification: 'RETURN_UNSUPPORTED_EVIDENCE', reason: 'line_evidence_missing', context: null });
    historyState.records = [record('BILL-R1')];
    await openReturn('BILL-R1');
    fireEvent.click(screen.getByTestId('sale-return-open'));
    expect((await screen.findByTestId('sale-return-blocked')).textContent).toContain('ระบบไม่คืนสินค้าแบบเดา');
    expect(submitMock).not.toHaveBeenCalled();
  });

  test('online-required: offline device disables the action with the exact copy and never calls the server', async () => {
    onlineValue = false;
    historyState.records = [record('BILL-R1')];
    await openReturn('BILL-R1');
    const btn = screen.getByTestId('sale-return-open') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('ต้องออนไลน์เพื่อคืนสินค้า/คืนเงิน');
    expect(fetchContextMock).not.toHaveBeenCalled();
  });

  test('pending-sync and credit sales are not offered a Return; voided sale shows no Return action', async () => {
    historyState.records = [record('BILL-P', {}, true)];
    await openReturn('BILL-P');
    expect((screen.getByTestId('sale-return-open') as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    historyState.records = [record('BILL-C', { status: 'pending_payment', creditAmt: 945 })];
    await openReturn('BILL-C');
    expect((screen.getByTestId('sale-return-open') as HTMLButtonElement).title).toContain('เงินเชื่อ');
    cleanup();

    historyState.records = [record('BILL-V', { status: 'voided' })];
    render(createElement(SalesHistoryPage));
    fireEvent.click(screen.getByTestId('date-range'));
    await waitFor(() => expect(screen.getByText('BILL-V')).toBeTruthy());
    fireEvent.click(screen.getByText('BILL-V'));
    await waitFor(() => expect(screen.getByText('บิลถูกยกเลิกแล้ว')).toBeTruthy());
    expect(screen.queryByTestId('sale-return-open')).toBeNull();
  });

  test('transport failure is reported as UNKNOWN (no false success) and the retry re-sends the SAME attempt', async () => {
    fetchContextMock.mockResolvedValue({ kind: 'ok', classification: 'RETURN_ELIGIBLE', reason: null, context: context() });
    submitMock.mockResolvedValueOnce({ kind: 'unknown' }).mockResolvedValueOnce({
      kind: 'ok',
      returnId: 'r'.repeat(40),
      returnNo: 'RT-BILL-R1-2',
      refundId: 'r'.repeat(40),
      refundAmount: 81,
      refundMethod: 'cash',
      idempotent: true,
    });
    historyState.records = [record('BILL-R1')];
    await openReturn('BILL-R1');
    fireEvent.click(screen.getByTestId('sale-return-open'));
    const modal = await screen.findByTestId('sale-return-modal');
    const line = await within(modal).findByTestId('sale-return-line-0');
    fireEvent.change(within(line).getByLabelText('จำนวนคืน'), { target: { value: '1' } });
    await waitFor(() => expect(getActiveShiftMock).toHaveBeenCalled());
    fireEvent.change(within(modal).getByLabelText(/ช่องทางคืนเงิน/), { target: { value: 'cash' } });
    fireEvent.change(within(modal).getByLabelText(/เหตุผลการคืน/), { target: { value: 'ลูกค้าเปลี่ยนใจ' } });
    fireEvent.change(within(modal).getByLabelText(/ผู้จัดการที่อนุมัติ/), { target: { value: 'mgr-1' } });
    fireEvent.click(within(modal).getByTestId('sale-return-request-approval'));

    let pin = await screen.findByTestId('sale-return-pin-modal');
    for (const d of ['1', '2', '3', '4']) fireEvent.click(within(pin).getByText(d));
    await act(async () => {
      fireEvent.click(within(pin).getByText('ยืนยัน'));
    });
    await waitFor(() => expect(screen.getByTestId('sale-return-unknown')).toBeTruthy());
    expect(screen.queryByTestId('sale-return-success')).toBeNull();

    fireEvent.click(screen.getByText('ส่งอีกครั้ง'));
    pin = await screen.findByTestId('sale-return-pin-modal');
    for (const d of ['1', '2', '3', '4']) fireEvent.click(within(pin).getByText(d));
    await act(async () => {
      fireEvent.click(within(pin).getByText('ยืนยัน'));
    });
    await waitFor(() => expect(screen.getByTestId('sale-return-success')).toBeTruthy());
    expect(submitMock.mock.calls[0]![0].attemptId).toBe(submitMock.mock.calls[1]![0].attemptId);
    expect(submitMock.mock.calls[0]![0].lines).toEqual(submitMock.mock.calls[1]![0].lines);
  });

  test('server rejection is a visible red alert, never a success', async () => {
    fetchContextMock.mockResolvedValue({ kind: 'ok', classification: 'RETURN_ELIGIBLE', reason: null, context: context() });
    submitMock.mockResolvedValue({ kind: 'error', code: 'approver_not_eligible' });
    historyState.records = [record('BILL-R1')];
    await openReturn('BILL-R1');
    fireEvent.click(screen.getByTestId('sale-return-open'));
    const modal = await screen.findByTestId('sale-return-modal');
    const line = await within(modal).findByTestId('sale-return-line-0');
    fireEvent.change(within(line).getByLabelText('จำนวนคืน'), { target: { value: '1' } });
    await waitFor(() => expect(getActiveShiftMock).toHaveBeenCalled());
    fireEvent.change(within(modal).getByLabelText(/ช่องทางคืนเงิน/), { target: { value: 'cash' } });
    fireEvent.change(within(modal).getByLabelText(/เหตุผลการคืน/), { target: { value: 'ลูกค้าเปลี่ยนใจ' } });
    fireEvent.change(within(modal).getByLabelText(/ผู้จัดการที่อนุมัติ/), { target: { value: 'mgr-1' } });
    fireEvent.click(within(modal).getByTestId('sale-return-request-approval'));
    const pin = await screen.findByTestId('sale-return-pin-modal');
    for (const d of ['1', '2', '3', '4']) fireEvent.click(within(pin).getByText(d));
    await act(async () => {
      fireEvent.click(within(pin).getByText('ยืนยัน'));
    });
    await waitFor(() => expect(screen.getByTestId('sale-return-error')).toBeTruthy());
    expect(screen.getByTestId('sale-return-error').textContent).toContain('ผู้อนุมัติไม่มีสิทธิ์อนุมัติการคืนสินค้า');
    expect(screen.queryByTestId('sale-return-success')).toBeNull();
  });
});
