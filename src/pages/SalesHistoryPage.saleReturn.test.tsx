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
const resolveMock = vi.fn<(input: Record<string, unknown>) => Promise<SubmitSaleReturnResult>>();
const attemptIdMock = vi.fn(() => 'attempt-ui-0001');
const refreshShiftMock = vi.fn<(shiftId: string, attemptId: string) => Promise<void>>(async () => undefined);
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
    resolveSaleReturnAttempt: (input: Record<string, unknown>) => resolveMock(input),
    refreshShiftFromServer: (shiftId: string, attemptId: string) => refreshShiftMock(shiftId, attemptId),
    newReturnAttemptId: () => attemptIdMock(),
  };
});

import SalesHistoryPage from './SalesHistoryPage';
import {
  __setReturnAttemptStoreForTests,
  createInMemoryReturnAttemptStore,
} from '../lib/saleReturn/unresolvedReturnAttempt';

let attemptStore: ReturnType<typeof createInMemoryReturnAttemptStore>;

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
let storage: Map<string, string>;

function memoryStorage(): Storage {
  return {
    get length() {
      return storage.size;
    },
    clear: () => storage.clear(),
    getItem: (k: string) => storage.get(k) ?? null,
    key: (i: number) => [...storage.keys()][i] ?? null,
    removeItem: (k: string) => void storage.delete(k),
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
  };
}

beforeEach(() => {
  onlineValue = true;
  storage = new Map();
  vi.stubGlobal('localStorage', memoryStorage());
  attemptStore = createInMemoryReturnAttemptStore();
  __setReturnAttemptStoreForTests(attemptStore);
  resolveMock.mockReset();
  attemptIdMock.mockReset();
  attemptIdMock.mockReturnValue('attempt-ui-0001');
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
  vi.unstubAllGlobals();
});

function unresolvedValues(): string[] {
  return Object.values(attemptStore.dump()).map((v) => JSON.stringify(v));
}

function guardKeys(): string[] {
  return [...storage.keys()].filter((k) => k.startsWith('twinpet.shift.serverCashPending.v2:'));
}

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

    fireEvent.click(screen.getByTestId('sale-return-retry-same'));
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

// ═══ D-RET-FIX-7 — unresolved attempt survives modal close / reopen ═══════════

async function draftAndEnterPin(qty = '1'): Promise<void> {
  fireEvent.click(screen.getByTestId('sale-return-open'));
  const modal = await screen.findByTestId('sale-return-modal');
  const line = await within(modal).findByTestId('sale-return-line-0');
  fireEvent.change(within(line).getByLabelText('จำนวนคืน'), { target: { value: qty } });
  await waitFor(() => expect(getActiveShiftMock).toHaveBeenCalled());
  fireEvent.change(within(modal).getByLabelText(/ช่องทางคืนเงิน/), { target: { value: 'cash' } });
  fireEvent.change(within(modal).getByLabelText(/เหตุผลการคืน/), { target: { value: 'ลูกค้าเปลี่ยนใจ' } });
  fireEvent.change(within(modal).getByLabelText(/ผู้จัดการที่อนุมัติ/), { target: { value: 'mgr-1' } });
  fireEvent.click(within(modal).getByTestId('sale-return-request-approval'));
  await enterPin();
}

async function enterPin(): Promise<void> {
  const pin = await screen.findByTestId('sale-return-pin-modal');
  for (const d of ['1', '2', '3', '4']) fireEvent.click(within(pin).getByText(d));
  await act(async () => {
    fireEvent.click(within(pin).getByText('ยืนยัน'));
  });
}

async function closeAndReopen(): Promise<void> {
  fireEvent.click(screen.getByText('ปิด (เก็บรายการไว้)'));
  await waitFor(() => expect(screen.queryByTestId('sale-return-modal')).toBeNull());
  fireEvent.click(screen.getByTestId('sale-return-open'));
  await screen.findByTestId('sale-return-modal');
}

const committed = (idempotent: boolean): SubmitSaleReturnResult => ({
  kind: 'ok',
  returnId: 'r'.repeat(40),
  returnNo: 'RT-BILL-R1-2',
  refundId: 'r'.repeat(40),
  refundAmount: 81,
  refundMethod: 'cash',
  idempotent,
});

describe('SalesHistoryPage — unresolved Return attempt recovery (D-RET-FIX-7)', () => {
  test('response lost AFTER commit → close → reopen → same attempt recovered → PIN-less resolve, no second effect', async () => {
    fetchContextMock.mockResolvedValue({ kind: 'ok', classification: 'RETURN_ELIGIBLE', reason: null, context: context() });
    submitMock.mockResolvedValueOnce({ kind: 'unknown' });
    resolveMock.mockResolvedValueOnce(committed(true));
    historyState.records = [record('BILL-R1')];
    await openReturn('BILL-R1');
    await draftAndEnterPin();
    await waitFor(() => expect(screen.getByTestId('sale-return-unknown')).toBeTruthy());

    // Persisted, non-secret: no PIN anywhere in the stored record.
    const stored = unresolvedValues();
    expect(stored).toHaveLength(1);
    // The cash attempt's shift guard was persisted before the send, also secret-free.
    expect(guardKeys()).toEqual(['twinpet.shift.serverCashPending.v2:SH1:attempt-ui-0001']);
    expect(storage.get(guardKeys()[0]!)).not.toContain('1234');
    expect(stored[0]).toContain('attempt-ui-0001');
    expect(stored[0]).not.toContain('1234');
    expect(JSON.parse(stored[0]!)).not.toHaveProperty('pin');

    await closeAndReopen();
    // Recovered: the SAME attempt, read-only — no editable form, no new approval request.
    expect(screen.getByTestId('sale-return-unknown')).toBeTruthy();
    expect(screen.getByTestId('sale-return-locked-summary').textContent).toContain('× 1');
    expect(screen.queryByTestId('sale-return-lines')).toBeNull();
    expect(screen.queryByTestId('sale-return-request-approval')).toBeNull();
    expect(attemptIdMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sale-return-resolve'));
    });
    await waitFor(() => expect(screen.getByTestId('sale-return-success')).toBeTruthy());
    expect(screen.getByTestId('sale-return-success').textContent).toContain('ไม่ได้คืนซ้ำ');
    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(resolveMock.mock.calls[0]![0]).toMatchObject({ attemptId: 'attempt-ui-0001', lines: [{ lineIndex: 0, productId: 'P1', qty: 1 }] });
    expect(resolveMock.mock.calls[0]![0]).not.toHaveProperty('pin');
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(unresolvedValues()).toHaveLength(0);
    // Committed: the guard is handed to the shift sync, never cleared on the ack alone.
    expect(refreshShiftMock).toHaveBeenCalledWith('SH1', 'attempt-ui-0001');
    expect(guardKeys()).toHaveLength(1);
  });

  test('response lost BEFORE commit → reopen → retry of the SAME attempt with the PIN commits once', async () => {
    fetchContextMock.mockResolvedValue({ kind: 'ok', classification: 'RETURN_ELIGIBLE', reason: null, context: context() });
    submitMock.mockResolvedValueOnce({ kind: 'unknown' }).mockResolvedValueOnce(committed(false));
    historyState.records = [record('BILL-R1')];
    await openReturn('BILL-R1');
    await draftAndEnterPin();
    await waitFor(() => expect(screen.getByTestId('sale-return-unknown')).toBeTruthy());
    await closeAndReopen();

    fireEvent.click(screen.getByTestId('sale-return-retry-same'));
    await enterPin();
    await waitFor(() => expect(screen.getByTestId('sale-return-success')).toBeTruthy());
    expect(submitMock).toHaveBeenCalledTimes(2);
    expect(submitMock.mock.calls[1]![0]).toMatchObject({ attemptId: 'attempt-ui-0001', expectedRefundAmount: 81, pin: '1234' });
    expect(unresolvedValues()).toHaveLength(0);
    expect(refreshShiftMock).toHaveBeenCalledWith('SH1', 'attempt-ui-0001');
  });

  test('a rejection of a retry does NOT clear the unresolved attempt (only a server fence does)', async () => {
    fetchContextMock.mockResolvedValue({ kind: 'ok', classification: 'RETURN_ELIGIBLE', reason: null, context: context() });
    submitMock.mockResolvedValueOnce({ kind: 'unknown' }).mockResolvedValueOnce({ kind: 'error', code: 'expired_approval' });
    resolveMock.mockResolvedValueOnce({ kind: 'error', code: 'attempt_not_committed' });
    attemptIdMock.mockReturnValueOnce('attempt-ui-0001').mockReturnValueOnce('attempt-ui-0002');
    historyState.records = [record('BILL-R1')];
    await openReturn('BILL-R1');
    await draftAndEnterPin();
    await waitFor(() => expect(screen.getByTestId('sale-return-unknown')).toBeTruthy());

    fireEvent.click(screen.getByTestId('sale-return-retry-same'));
    await enterPin();
    await waitFor(() => expect(screen.getByTestId('sale-return-unknown').textContent).toContain('การอนุมัติหมดอายุ'));
    expect(unresolvedValues()).toHaveLength(1);
    expect(guardKeys()).toHaveLength(1);

    // Definitive resolution: the server fenced the attempt → a NEW attempt is allowed.
    await act(async () => {
      fireEvent.click(screen.getByTestId('sale-return-resolve'));
    });
    await waitFor(() => expect(screen.getByTestId('sale-return-error').textContent).toContain('เริ่มรายการใหม่ได้'));
    expect(storage.size + unresolvedValues().length).toBe(0);
    expect(screen.getByTestId('sale-return-lines')).toBeTruthy();
  });

  test('first and only send definitively rejected → nothing kept, the form is usable again', async () => {
    fetchContextMock.mockResolvedValue({ kind: 'ok', classification: 'RETURN_ELIGIBLE', reason: null, context: context() });
    submitMock.mockResolvedValueOnce({ kind: 'error', code: 'refund_cap_exceeded' });
    historyState.records = [record('BILL-R1')];
    await openReturn('BILL-R1');
    await draftAndEnterPin();
    await waitFor(() => expect(screen.getByTestId('sale-return-error')).toBeTruthy());
    expect(storage.size + unresolvedValues().length).toBe(0);
  });

  test('a stored attempt of ANOTHER user on this device blocks both actions', async () => {
    fetchContextMock.mockResolvedValue({ kind: 'ok', classification: 'RETURN_ELIGIBLE', reason: null, context: context() });
    await attemptStore.transact('readwrite', (txn) =>
      txn.put('twinpet.saleReturn.unresolved.v1:LDP-001:BILL-R1', {
        schemaVersion: 1,
        state: 'UNKNOWN_PENDING_RESOLUTION',
        attemptId: 'attempt-x',
        orderId: 'BILL-R1',
        branchId: 'LDP-001',
        requesterStaffId: 'someone-else',
        lines: [{ lineIndex: 0, productId: 'P1', qty: 1 }],
        refundMethod: 'cash',
        refundReference: '',
        reason: 'x',
        note: '',
        expectedRefundAmount: 81,
        shiftId: 'SH1',
        approverStaffId: 'mgr-1',
        approverDisplayName: 'Manager One',
        recordedAtMs: 1,
      }),
    );
    historyState.records = [record('BILL-R1')];
    await openReturn('BILL-R1');
    fireEvent.click(screen.getByTestId('sale-return-open'));
    expect(await screen.findByTestId('sale-return-foreign-attempt')).toBeTruthy();
    expect((screen.getByTestId('sale-return-resolve') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('sale-return-retry-same') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('SalesHistoryPage — oversell + single-tender V1 limits (D-RET-FIX-4 / D-RET-FIX-10)', () => {
  test('oversold part of a line is not offered and is explained', async () => {
    const base = context();
    fetchContextMock.mockResolvedValue({
      kind: 'ok',
      classification: 'RETURN_ELIGIBLE',
      reason: null,
      context: context({ lines: [{ ...base.lines[0]!, supportedReturnableQty: 1, supportedReturnableQtyMilli: 1000, oversellLimited: true }] }),
    });
    historyState.records = [record('BILL-R1')];
    await openReturn('BILL-R1');
    fireEvent.click(screen.getByTestId('sale-return-open'));
    const line = await screen.findByTestId('sale-return-line-0');
    expect(within(line).getByText('คืนได้ 1')).toBeTruthy();
    expect(within(line).getByTestId('sale-return-oversell-0')).toBeTruthy();
    fireEvent.change(within(line).getByLabelText('จำนวนคืน'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('sale-return-request-approval'));
    expect(screen.getByTestId('sale-return-error').textContent).toContain('สต็อกติดลบ');
    expect(submitMock).not.toHaveBeenCalled();
  });

  test('no single original tender can cover the refund → explicit unsupported state, approval disabled', async () => {
    fetchContextMock.mockResolvedValue({
      kind: 'ok',
      classification: 'RETURN_ELIGIBLE',
      reason: null,
      context: context({ refundMethods: [{ method: 'cash', remaining: 100 }, { method: 'card', remaining: 100 }] }),
    });
    historyState.records = [record('BILL-R1')];
    await openReturn('BILL-R1');
    fireEvent.click(screen.getByTestId('sale-return-open'));
    const line = await screen.findByTestId('sale-return-line-0');
    fireEvent.change(within(line).getByLabelText('จำนวนคืน'), { target: { value: '3' } }); // ฿243 > 100 per tender
    expect((await screen.findByTestId('sale-return-single-tender')).textContent).toContain('คืนเงินได้ทางเดียวต่อรายการ');
    expect(screen.getByTestId('sale-return-single-tender').textContent).not.toMatch(/แยก.*หลายรายการ/);
    expect((screen.getByTestId('sale-return-request-approval') as HTMLButtonElement).disabled).toBe(true);
  });
});
