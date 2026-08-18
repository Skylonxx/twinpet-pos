// @vitest-environment jsdom

import { createElement } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import ThermalReceipt from './ThermalReceipt';
import type { Order, OrderItem, Payment } from '../../lib/types';
import type { BranchDocumentSettings } from '../../lib/documents/types';

const settings: BranchDocumentSettings = {
  companyName: 'TwinPet',
  branchName: 'LDP',
  branchAddress: 'a',
  branchPhone: 'p',
  branchEmail: 'e',
  taxId: 't',
  logoUrl: null,
  receiptHeader: '',
  receiptFooter: 'thanks',
  vatRegistered: true,
  vatRate: 7,
  priceIncludesVat: true,
  showVatOnThermal: true,
  showBarcodeOnReceipt: false,
  showQrOnReceipt: false,
  showLogoOnReceipt: false,
  showStaffOnReceipt: true,
  showSignatureOnReceipt: true,
};

const order = {
  id: 'o1',
  billId: 'B1',
  branchId: 'br1',
  customerId: null,
  customerSnap: null,
  staffId: 's',
  staffName: 'Dao',
  status: 'completed',
  subtotal: 100,
  discountAmt: 0,
  billDiscount: 0,
  vatRate: 7,
  vatAmt: 0,
  surcharge: 0,
  total: 100,
  paidAmt: 100,
  changeAmt: 0,
  creditAmt: 0,
  priceLevelId: 'retail',
  note: '',
  voidReason: null,
  voidedBy: null,
  voidedAt: null,
  printCount: 0,
  createdAt: { toDate: () => new Date('2026-01-01') },
  updatedAt: { toDate: () => new Date('2026-01-01') },
} as unknown as Order;

const items: OrderItem[] = [
  {
    id: 'i1',
    productId: 'p1',
    productSnap: { name: 'Food', sku: 'SKU', category: 'cat' },
    unit: 'ea',
    unitFactor: 1,
    qty: 1,
    qtyBase: 1,
    unitPrice: 100,
    discountAmt: 0,
    lineTotal: 100,
    fifoCost: 0,
    lotRefs: [],
  },
];

const payments: Payment[] = [
  {
    id: 'p1',
    orderId: 'o1',
    branchId: 'br1',
    method: 'cash',
    amount: 100,
    ref: null,
    createdAt: { toDate: () => new Date() } as never,
  },
];

describe('ThermalReceipt authority markers', () => {
  test('J01/J02 PROVISIONAL in-document marker is inside the print tree', () => {
    const { container } = render(
      createElement(ThermalReceipt, {
        order,
        orderItems: items,
        payments,
        branchSettings: settings,
        authority: 'PROVISIONAL',
        isHistoricalReprint: false,
      }),
    );
    expect(container.querySelector('[data-receipt-marker="provisional"]')?.textContent).toMatch(/PROVISIONAL/);
  });

  test('J02 COPY marker is independent of authority', () => {
    const { container } = render(
      createElement(ThermalReceipt, {
        order,
        orderItems: items,
        payments,
        branchSettings: settings,
        authority: 'PROVISIONAL',
        isCopy: true,
        isHistoricalReprint: false,
      }),
    );
    expect(container.querySelector('[data-receipt-marker="copy"]')).toBeTruthy();
    expect(container.querySelector('[data-receipt-marker="provisional"]')).toBeTruthy();

    const viaStatus = render(
      createElement(ThermalReceipt, {
        order,
        orderItems: items,
        payments,
        branchSettings: settings,
        authority: 'AUTHORITATIVE',
        copyStatus: 'COPY',
        isHistoricalReprint: true,
      }),
    );
    expect(viaStatus.container.querySelector('[data-receipt-marker="copy"]')?.textContent).toMatch(/COPY/);
    expect(viaStatus.container.querySelector('[data-receipt-marker="provisional"]')).toBeNull();
    expect(viaStatus.container.querySelector('[data-receipt-marker="unproven"]')).toBeNull();
    expect(viaStatus.container.querySelector('[data-receipt-marker="refused"]')).toBeNull();
  });

  test('G-D6 AUTHORITATIVE historical reprint suppresses VAT breakdown', () => {
    const { container } = render(
      createElement(ThermalReceipt, {
        order,
        orderItems: items,
        payments,
        branchSettings: settings,
        authority: 'AUTHORITATIVE',
        isHistoricalReprint: true,
      }),
    );
    expect(container.textContent ?? '').not.toMatch(/VAT 7%/);
  });

  test('J03 cash: label เงินสด, รับเงิน from cash amount, เงินทอน from order.changeAmt', () => {
    const { container } = render(
      createElement(ThermalReceipt, {
        order: { ...order, changeAmt: 20, paidAmt: 120, total: 100 },
        orderItems: items,
        payments: [{ ...payments[0], amount: 120 }],
        branchSettings: settings,
        authority: 'PROVISIONAL',
        isHistoricalReprint: false,
      }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('เงินสด');
    expect(text).toContain('รับเงิน');
    expect(text).toContain('เงินทอน');
  });

  test('J04 QR (qr and kbank): labels, no cash/change block, ชำระ=order.total', () => {
    const { container } = render(
      createElement(ThermalReceipt, {
        order: { ...order, changeAmt: 0, paidAmt: 100 },
        orderItems: items,
        payments: [{ ...payments[0], method: 'qr', amount: 100 }],
        branchSettings: settings,
        authority: 'PROVISIONAL',
        isHistoricalReprint: false,
      }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('PromptPay QR');
    expect(text).not.toContain('รับเงิน');
    expect(text).toContain('ชำระ');
  });

  test('J05 card: correct label and non-cash block', () => {
    const { container } = render(
      createElement(ThermalReceipt, {
        order,
        orderItems: items,
        payments: [{ ...payments[0], method: 'card' }],
        branchSettings: settings,
        authority: 'PROVISIONAL',
        isHistoricalReprint: false,
      }),
    );
    expect(container.textContent ?? '').toContain('EDC บัตร');
  });

  test('J06 credit: correct label and non-cash block', () => {
    const { container } = render(
      createElement(ThermalReceipt, {
        order: { ...order, creditAmt: 100, paidAmt: 0 },
        orderItems: items,
        payments: [{ ...payments[0], method: 'credit' }],
        branchSettings: settings,
        authority: 'PROVISIONAL',
        isHistoricalReprint: false,
      }),
    );
    expect(container.textContent ?? '').toContain('เชื่อ');
  });

  test('J07 split cash+QR: joined label, per-method breakdown, cash/change because cash exists', () => {
    const { container } = render(
      createElement(ThermalReceipt, {
        order: { ...order, paidAmt: 100, changeAmt: 0 },
        orderItems: items,
        payments: [
          { ...payments[0], method: 'cash', amount: 40, id: 'c' },
          { ...payments[0], method: 'qr', amount: 60, id: 'q' },
        ],
        branchSettings: settings,
        authority: 'PROVISIONAL',
        isHistoricalReprint: false,
      }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('เงินสด');
    expect(text).toContain('PromptPay QR');
    expect(text).toContain('รับเงิน');
  });

  test('J08 header-only fallback never used when payments are supplied', () => {
    const { container } = render(
      createElement(ThermalReceipt, {
        order: { ...order, creditAmt: 100, paidAmt: 0 },
        orderItems: items,
        payments: [{ ...payments[0], method: 'qr', amount: 100 }],
        branchSettings: settings,
        authority: 'PROVISIONAL',
        isHistoricalReprint: false,
      }),
    );
    expect(container.textContent ?? '').toContain('PromptPay QR');
    expect(container.textContent ?? '').not.toMatch(/^เชื่อ$/m);
  });

  test('J09 productSnap.name renders from envelope items', () => {
    const { container } = render(
      createElement(ThermalReceipt, {
        order,
        orderItems: items,
        payments,
        branchSettings: settings,
        authority: 'PROVISIONAL',
        isHistoricalReprint: false,
      }),
    );
    expect(container.textContent ?? '').toContain('Food');
  });

  test('J10 pick-list mode renders productSnap.sku', () => {
    const { container } = render(
      createElement(ThermalReceipt, {
        order,
        orderItems: items,
        payments,
        branchSettings: settings,
        authority: 'PROVISIONAL',
        isHistoricalReprint: false,
        mode: 'picklist',
      }),
    );
    expect(container.textContent ?? '').toContain('SKU');
  });

  test('J11 VAT breakdown suppressed on AUTHORITATIVE historical reprint', () => {
    const { container } = render(
      createElement(ThermalReceipt, {
        order,
        orderItems: items,
        payments,
        branchSettings: { ...settings, vatRegistered: true, vatRate: 7, showVatOnThermal: true },
        authority: 'AUTHORITATIVE',
        isHistoricalReprint: true,
      }),
    );
    expect(container.textContent ?? '').not.toMatch(/VAT 7%/);
  });

  test('J12 empty payments + nonzero total refuses inside the document', () => {
    const { container } = render(
      createElement(ThermalReceipt, {
        order,
        orderItems: items,
        payments: [],
        branchSettings: settings,
        authority: 'UNPROVEN',
        authorityReason: 'projection_cardinality',
        copyStatus: 'COPY',
        isHistoricalReprint: true,
      }),
    );
    const text = container.textContent ?? '';
    expect(container.querySelector('[data-receipt-marker="unproven"]')?.textContent).toMatch(/UNPROVEN/);
    expect(container.querySelector('[data-receipt-unproven-reason="projection_cardinality"]')?.textContent).toBe(
      'projection_cardinality',
    );
    expect(text).toContain('projection_cardinality');
    expect(text).toContain('ไม่พบรายการชำระ');
    expect(text).not.toMatch(/AUTHORITATIVE/);
    expect(container.querySelector('[data-receipt-marker="provisional"]')).toBeNull();
    expect(container.querySelector('[data-receipt-marker="refused"]')).toBeNull();
    expect(container.querySelector('[data-receipt-marker="unproven"]')).toBeTruthy();
    expect(text).not.toContain('Food');
  });

  test('UNPROVEN historical COPY cannot render as an unmarked authoritative COPY', () => {
    const { container } = render(
      createElement(ThermalReceipt, {
        order,
        orderItems: items,
        payments,
        branchSettings: settings,
        authority: 'UNPROVEN',
        authorityReason: 'revision_malformed',
        copyStatus: 'COPY',
        isHistoricalReprint: true,
      }),
    );
    expect(container.querySelector('[data-receipt-marker="unproven"]')?.textContent).toMatch(/UNPROVEN/);
    expect(container.querySelector('[data-receipt-unproven-reason="revision_malformed"]')?.textContent).toBe(
      'revision_malformed',
    );
    expect(container.querySelector('[data-receipt-marker="copy"]')?.textContent).toMatch(/COPY/);
    expect(container.querySelector('[data-receipt-marker="provisional"]')).toBeNull();
    expect(container.querySelector('[data-receipt-marker="refused"]')).toBeNull();
  });

  test('REFUSED envelope cannot render as an ordinary COPY', () => {
    const { container } = render(
      createElement(ThermalReceipt, {
        order,
        orderItems: items,
        payments,
        branchSettings: settings,
        authority: 'REFUSED',
        authorityReason: 'order_voided',
        copyStatus: 'COPY',
        isHistoricalReprint: true,
      }),
    );
    expect(container.querySelector('[data-receipt-marker="refused"]')?.textContent).toMatch(/order_voided/);
    expect(container.querySelector('[data-receipt-marker="copy"]')).toBeNull();
    expect(container.textContent ?? '').not.toContain('Food');
    expect(container.textContent ?? '').not.toMatch(/สำเนา \/ COPY/);
  });

  test('J31 showStaffOnReceipt / showSignatureOnReceipt suppressed on AUTHORITATIVE historical reprint; PROVISIONAL unaffected', () => {
    const historical = render(
      createElement(ThermalReceipt, {
        order,
        orderItems: items,
        payments,
        branchSettings: { ...settings, showStaffOnReceipt: true, showSignatureOnReceipt: true },
        authority: 'AUTHORITATIVE',
        isHistoricalReprint: true,
      }),
    );
    expect(historical.container.textContent ?? '').not.toContain('พนักงาน');
    const slip = render(
      createElement(ThermalReceipt, {
        order,
        orderItems: items,
        payments,
        branchSettings: { ...settings, showStaffOnReceipt: true, showSignatureOnReceipt: true },
        authority: 'PROVISIONAL',
        isHistoricalReprint: false,
      }),
    );
    expect(slip.container.textContent ?? '').toContain('พนักงาน');
  });
});
