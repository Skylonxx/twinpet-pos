// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const toast = vi.fn();

vi.mock('../lib/hooks/useBranchSettings', () => {
  const paymentMethods = { cash: true, qr: true, kbank: true, card: true, credit: true };
  return {
    useBranchSettings: () => ({
      paymentMethods,
      requiresPasswordForVoid: true,
      loading: false,
    }),
  };
});

vi.mock('./ui/use-toast', () => ({
  toast: (...args: unknown[]) => toast(...args),
}));

import PaymentModal from './PaymentModal';

afterEach(() => {
  cleanup();
  toast.mockReset();
});

describe('PaymentModal G-D2 Option A', () => {
  test('J17 in-document PROVISIONAL marker is inside the print tree', async () => {
    const src = (await import('./PaymentModal.tsx?raw')).default as string;
    expect(src).toMatch(/data-receipt-marker="provisional"/);
    expect(src).toMatch(/ใบเสร็จชั่วคราว \/ PROVISIONAL/);
  });

  test('J18 G-D2 Option A auto-print fires under marked policy', async () => {
    const src = (await import('./PaymentModal.tsx?raw')).default as string;
    expect(src).toMatch(/autoPrint/);
    expect(src).toMatch(/handlePrint/);
    const onConfirm = vi.fn(async () => 'order-1');
    render(
      createElement(PaymentModal, {
        open: true,
        branchId: 'br1',
        grandTotal: 100,
        subtotal: 100,
        billDiscount: 0,
        fee: 0,
        lines: [{ productName: 'Food', sku: 'SKU1', qty: 1, unit: 'ea', lineTotal: 100 }],
        onClose: () => {},
        onConfirm,
        onNewSale: () => {},
      }),
    );
    fireEvent.click(screen.getByLabelText('ใส่ยอดที่เหลือทั้งหมด'));
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันชำระเงิน' }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('พิมพ์ใบเสร็จ'),
        }),
      );
    });
    expect(document.querySelector('[data-receipt-marker="provisional"]')).toBeTruthy();
  });

  test('J19 G-D2 Option B manual print refused is not selected in this component', async () => {
    const src = (await import('./PaymentModal.tsx?raw')).default as string;
    expect(src.includes("gd2ImmediateSlip('B')")).toBe(false);
    expect(src).toMatch(/PROVISIONAL/);
  });

  test('J20 G-D2 Option B auto-print effect does not fire in this Option A component', async () => {
    const src = (await import('./PaymentModal.tsx?raw')).default as string;
    expect(src.includes("gd2ImmediateSlip('B')")).toBe(false);
    expect(src).toMatch(/autoPrint = true/);
  });

  test('J21 no connectivity listener; no addEventListener; frozen keyboard substrings absent', async () => {
    const src = (await import('./PaymentModal.tsx?raw')).default as string;
    expect(src.includes('addEventListener')).toBe(false);
    expect(src.includes('onKeyDown')).toBe(false);
    expect(src.includes('isComposing')).toBe(false);
  });

  test('H05 Option B remains an unselected branch in the authority module, not this component', async () => {
    const src = (await import('./PaymentModal.tsx?raw')).default as string;
    expect(src.includes("gd2ImmediateSlip('B')")).toBe(false);
    expect(src).toMatch(/PROVISIONAL/);
  });
});
