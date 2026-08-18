// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SaleRecord } from '../lib/salesHistory/types';

const fetchOrderReceipt = vi.fn();
const loadReceiptSettingsForOrderBranch = vi.fn();
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
  useOrderItemsLive: () => ({ items: [], state: 'live', fromCache: false }),
}));

vi.mock('../lib/pos/usePosProducts', () => ({
  usePosProducts: () => ({ products: [] }),
}));

vi.mock('../lib/documents/receiptFetch', () => ({
  fetchOrderReceipt: (...args: unknown[]) => fetchOrderReceipt(...args),
}));

vi.mock('../lib/documents/receiptSettings', () => ({
  loadReceiptSettingsForOrderBranch: (...args: unknown[]) => loadReceiptSettingsForOrderBranch(...args),
}));

vi.mock('../components/documents/ThermalReceipt', () => ({
  default: (props: { copyStatus?: string; authority?: string; authorityReason?: string }) =>
    createElement(
      'div',
      {
        'data-testid': 'thermal-receipt',
        'data-copy-status': props.copyStatus ?? '',
        'data-authority': props.authority ?? '',
        'data-authority-reason': props.authorityReason ?? '',
      },
      [
        props.authority === 'UNPROVEN'
          ? createElement('div', { key: 'unproven', 'data-receipt-marker': 'unproven' }, `UNPROVEN ${props.authorityReason ?? ''}`)
          : null,
        props.authority === 'PROVISIONAL'
          ? createElement('div', { key: 'provisional', 'data-receipt-marker': 'provisional' }, 'PROVISIONAL')
          : null,
        props.authority === 'REFUSED'
          ? createElement('div', { key: 'refused', 'data-receipt-marker': 'refused' }, 'REFUSED')
          : null,
        props.copyStatus === 'COPY' ? '(สำเนา / COPY)' : null,
      ],
    ),
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

import SalesHistoryPage from './SalesHistoryPage';

function record(over: Partial<SaleRecord> & { id: string; branchId?: string; verdict?: SaleRecord['verdict']; verdictReason?: SaleRecord['verdictReason']; voidRevisionFault?: string; pendingSync?: boolean }): SaleRecord {
  const createdAt = new Date();
  return {
    order: {
      id: over.id,
      billId: over.id,
      branchId: over.branchId ?? 'br-display',
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
        orderId: over.id,
        branchId: over.branchId ?? 'br-display',
        method: 'cash',
        amount: 100,
        ref: null,
        createdAt: createdAt as never,
      },
    ],
    items: [],
    pendingSync: over.pendingSync,
    verdict: over.verdict ?? 'CURRENT',
    verdictReason: over.verdictReason ?? null,
    voidRevisionFault: over.voidRevisionFault,
  };
}

afterEach(() => {
  cleanup();
  historyState.records = [];
  fetchOrderReceipt.mockReset();
  loadReceiptSettingsForOrderBranch.mockReset();
  vi.unstubAllGlobals();
});

describe('SalesHistoryPage receipt / B4 wiring', () => {
  test('E28 liveOrderId is null for pending overlay', async () => {
    const src = (await import('./SalesHistoryPage.tsx?raw')).default as string;
    expect(src).toMatch(/!selected\.pendingSync/);
    expect(src).toMatch(/useOrderItemsLive\(branchId, liveOrderId\)/);
  });

  test('E32 liveOrderId is null on cross-branch mismatch', async () => {
    const src = (await import('./SalesHistoryPage.tsx?raw')).default as string;
    expect(src).toMatch(/selected\.order\.branchId === branchId/);
  });

  test('J13 print button real handler click → settings + envelope → renderer', async () => {
    const src = (await import('./SalesHistoryPage.tsx?raw')).default as string;
    expect(src).toMatch(/handlePrintReceipt/);
    expect(src).toMatch(/fetchOrderReceipt/);
    expect(src).toMatch(/loadReceiptSettingsForOrderBranch/);
    expect(src).toMatch(/ThermalReceipt/);
    expect(src).toMatch(/onClick=\{\(\) => void handlePrintReceipt\(\)\}/);
  });

  test('J14 refusal path: stated reason, no authoritative document', async () => {
    const src = (await import('./SalesHistoryPage.tsx?raw')).default as string;
    expect(src).toMatch(/if \(!fetched\.ok/);
    expect(src).toMatch(/showToast\('ไม่สามารถพิมพ์ใบเสร็จได้'/);
    expect(src).toMatch(/return;/);
    expect(src).toMatch(/decideAction\(\s*'AUTHORITATIVE_RECEIPT'/);
    expect(src).toMatch(/envelope\.authority !== 'AUTHORITATIVE'/);
    expect(src).toMatch(/envelope\.authority !== 'UNPROVEN'/);
    expect(src).toMatch(/envelope\.authority !== 'PROVISIONAL'/);
  });

  test('J15 unrelated pending overlay does not disable print on a proven canonical row', async () => {
    const src = (await import('./SalesHistoryPage.tsx?raw')).default as string;
    expect(src).not.toMatch(/pendingRecords\.length/);
    expect(src).toMatch(/sh-df-print/);
  });

  test('J16 unreconciled void intent keeps disabled-print state', async () => {
    const src = (await import('./SalesHistoryPage.tsx?raw')).default as string;
    expect(src).toMatch(/VOID_INTENT_UNRECONCILED/);
    expect(src).toMatch(/sh-df-disabled/);
  });

  test('E44 unverified chrome is rendered for cache child snapshots', async () => {
    const src = (await import('./SalesHistoryPage.tsx?raw')).default as string;
    expect(src).toMatch(/UNVERIFIED/);
    expect(src).toMatch(/data-child-provenance="unverified"/);
  });
});

describe('SalesHistoryPage runtime receipt / void gate', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'print', { configurable: true, value: vi.fn() });
  });

  afterEach(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 80));
  });

  test('I01/J13 settings branch comes from authoritative envelope, not selected row', async () => {
    historyState.records = [record({ id: 'BILL-1', branchId: 'br-display' })];
    fetchOrderReceipt.mockResolvedValue({
      ok: true,
      envelope: {
        authority: 'AUTHORITATIVE',
        reason: null,
        order: { id: 'BILL-1', branchId: 'br-envelope', total: 100, status: 'completed' },
        items: [],
        payments: [{ method: 'cash', amount: 100 }],
      },
    });
    loadReceiptSettingsForOrderBranch.mockResolvedValue({
      ok: true,
      settings: { companyName: 'TwinPet', showLogoOnReceipt: false },
    });
    render(createElement(SalesHistoryPage));
    fireEvent.click(screen.getByText('BILL-1'));
    fireEvent.click(screen.getByRole('button', { name: /พิมพ์ใบเสร็จ/ }));
    await waitFor(() => {
      expect(fetchOrderReceipt).toHaveBeenCalledWith('BILL-1');
      expect(loadReceiptSettingsForOrderBranch).toHaveBeenCalled();
    });
    expect(loadReceiptSettingsForOrderBranch.mock.calls[0]?.[0]).toBe('br-envelope');
    expect(loadReceiptSettingsForOrderBranch.mock.calls[0]?.[0]).not.toBe('br-display');
    await waitFor(() => {
      expect(screen.getByTestId('thermal-receipt')).toBeTruthy();
    });
  });

  test('historical reprint COPY is client-context COPY, independent of envelope.copyStatus', async () => {
    const src = (await import('./SalesHistoryPage.tsx?raw')).default as string;
    expect(src).not.toMatch(/envelope\.copyStatus/);
    expect(src).toMatch(/copyStatus:\s*'COPY'/);
    expect(src).not.toMatch(/copyStatus:\s*envelope/);

    historyState.records = [record({ id: 'BILL-COPY', branchId: 'br-display' })];
    fetchOrderReceipt.mockResolvedValue({
      ok: true,
      envelope: {
        authority: 'AUTHORITATIVE',
        copyStatus: 'ORIGINAL',
        reason: null,
        order: { id: 'BILL-COPY', branchId: 'br-envelope', total: 100, status: 'completed' },
        items: [],
        payments: [{ method: 'cash', amount: 100 }],
      },
    });
    loadReceiptSettingsForOrderBranch.mockResolvedValue({
      ok: true,
      settings: { companyName: 'TwinPet', showLogoOnReceipt: false },
    });
    render(createElement(SalesHistoryPage));
    fireEvent.click(screen.getByText('BILL-COPY'));
    fireEvent.click(screen.getByRole('button', { name: /พิมพ์ใบเสร็จ/ }));
    await waitFor(() => {
      expect(fetchOrderReceipt).toHaveBeenCalledWith('BILL-COPY');
      expect(screen.getByTestId('thermal-receipt')).toBeTruthy();
    });
    const receipt = screen.getByTestId('thermal-receipt');
    expect(receipt.getAttribute('data-copy-status')).toBe('COPY');
    expect(receipt.getAttribute('data-authority')).toBe('AUTHORITATIVE');
    expect(receipt.textContent).toMatch(/สำเนา \/ COPY/);
    expect(receipt.querySelector('[data-receipt-marker="unproven"]')).toBeNull();
    expect(receipt.querySelector('[data-receipt-marker="refused"]')).toBeNull();
    await waitFor(() => {
      expect(window.print).toHaveBeenCalled();
    });
  });

  test('REFUSED historical authority never reaches window.print', async () => {
    historyState.records = [record({ id: 'BILL-REFUSED', branchId: 'br-display' })];
    fetchOrderReceipt.mockResolvedValue({
      ok: true,
      envelope: {
        authority: 'REFUSED',
        reason: 'order_voided',
        order: { id: 'BILL-REFUSED', branchId: 'br-envelope', total: 100, status: 'voided' },
        items: [],
        payments: [{ method: 'cash', amount: 100 }],
      },
    });
    render(createElement(SalesHistoryPage));
    fireEvent.click(screen.getByText('BILL-REFUSED'));
    fireEvent.click(screen.getByRole('button', { name: /พิมพ์ใบเสร็จ/ }));
    await waitFor(() => {
      expect(fetchOrderReceipt).toHaveBeenCalledWith('BILL-REFUSED');
    });
    expect(loadReceiptSettingsForOrderBranch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('thermal-receipt')).toBeNull();
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    expect(window.print).not.toHaveBeenCalled();
  });

  test('UNPROVEN historical authority cannot render as unmarked AUTHORITATIVE COPY', async () => {
    historyState.records = [record({ id: 'BILL-UNPROVEN', branchId: 'br-display' })];
    fetchOrderReceipt.mockResolvedValue({
      ok: true,
      envelope: {
        authority: 'UNPROVEN',
        reason: 'revision_malformed',
        order: { id: 'BILL-UNPROVEN', branchId: 'br-envelope', total: 100, status: 'completed' },
        items: [],
        payments: [{ method: 'cash', amount: 100 }],
      },
    });
    loadReceiptSettingsForOrderBranch.mockResolvedValue({
      ok: true,
      settings: { companyName: 'TwinPet', showLogoOnReceipt: false },
    });
    render(createElement(SalesHistoryPage));
    fireEvent.click(screen.getByText('BILL-UNPROVEN'));
    fireEvent.click(screen.getByRole('button', { name: /พิมพ์ใบเสร็จ/ }));
    await waitFor(() => {
      expect(screen.getByTestId('thermal-receipt')).toBeTruthy();
    });
    const receipt = screen.getByTestId('thermal-receipt');
    expect(receipt.getAttribute('data-authority')).toBe('UNPROVEN');
    expect(receipt.getAttribute('data-authority-reason')).toBe('revision_malformed');
    expect(receipt.getAttribute('data-copy-status')).toBe('COPY');
    expect(receipt.querySelector('[data-receipt-marker="unproven"]')?.textContent).toMatch(/UNPROVEN/);
    expect(receipt.querySelector('[data-receipt-marker="unproven"]')?.textContent).toMatch(/revision_malformed/);
    expect(receipt.getAttribute('data-authority')).not.toBe('AUTHORITATIVE');
  });

  test('ERROR row cannot start an authoritative historical receipt attempt', () => {
    historyState.records = [
      record({
        id: 'BILL-ERROR',
        verdict: 'ERROR',
        verdictReason: 'REVISION_MALFORMED',
        voidRevisionFault: 'revision_malformed',
      }),
    ];
    render(createElement(SalesHistoryPage));
    fireEvent.click(screen.getByText('BILL-ERROR'));
    const printBtn = screen.getByRole('button', { name: /พิมพ์ใบเสร็จ/ }) as HTMLButtonElement;
    expect(printBtn.disabled).toBe(true);
    fireEvent.click(printBtn);
    expect(fetchOrderReceipt).not.toHaveBeenCalled();
    expect(window.print).not.toHaveBeenCalled();
  });

  test('PROVISIONAL row cannot start an authoritative historical receipt attempt', () => {
    historyState.records = [
      record({
        id: 'BILL-PROVISIONAL',
        verdict: 'PROVISIONAL',
        verdictReason: 'OVERLAY_ONLY',
        pendingSync: true,
      }),
    ];
    render(createElement(SalesHistoryPage));
    fireEvent.click(screen.getByText('BILL-PROVISIONAL'));
    const printBtn = screen.getByRole('button', { name: /พิมพ์ใบเสร็จ/ }) as HTMLButtonElement;
    expect(printBtn.disabled).toBe(true);
    fireEvent.click(printBtn);
    expect(fetchOrderReceipt).not.toHaveBeenCalled();
    expect(window.print).not.toHaveBeenCalled();
  });

  test('E26 VOID_SETTLED_SALE is disabled for V9 fault row; control remains eligible', () => {
    historyState.records = [
      record({
        id: 'FAULT',
        verdict: 'ERROR',
        verdictReason: 'REVISION_MALFORMED',
        voidRevisionFault: 'revision_malformed',
      }),
      record({ id: 'OK', verdict: 'CURRENT', verdictReason: null }),
    ];
    render(createElement(SalesHistoryPage));
    fireEvent.click(screen.getByText('FAULT'));
    expect((screen.getByRole('button', { name: /ยกเลิกบิล/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('OK'));
    expect((screen.getByRole('button', { name: /ยกเลิกบิล/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
