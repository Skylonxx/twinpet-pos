import { describe, expect, test } from 'vitest';
import { cashReceived, presentPayments, sumCash } from './formatters';
import { mergeAuthoritativeSettings } from './receiptSettings';
import type { Order, Payment } from '../types';

const order = (over: Partial<Order> = {}): Order =>
  ({
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
    createdAt: {} as never,
    updatedAt: {} as never,
    ...over,
  }) as Order;

const pay = (method: Payment['method'], amount: number, id: string = method): Payment =>
  ({
    id,
    orderId: 'o1',
    branchId: 'br1',
    method,
    amount,
    ref: null,
    createdAt: {} as never,
  });

describe('J formatters payment presentation', () => {
  test('J22 cash sum does not use Array.find', async () => {
    const src = (await import('./formatters.ts?raw')).default as string;
    expect(src.includes('.find(')).toBe(false);
    expect(sumCash([pay('cash', 100), pay('cash', 50)])).toBe(150);
    expect(cashReceived(order(), [pay('cash', 100), pay('cash', 50)])).toBe(150);
  });

  test('J23 multiple same-method non-cash rows keep both rows under one channel label', () => {
    const presented = presentPayments(order(), [pay('qr', 40, 'q1'), pay('qr', 60, 'q2')]);
    expect(presented.ok).toBe(true);
    if (presented.ok) {
      expect(presented.channel).toBe('PromptPay QR');
      expect(presented.rows).toHaveLength(2);
    }
  });

  test('J24 non-cash overpayment (QR only, changeAmt>0) still renders เงินทอน', () => {
    const presented = presentPayments(order({ paidAmt: 150, changeAmt: 50, total: 100 }), [pay('qr', 150)]);
    expect(presented.ok).toBe(true);
    if (presented.ok) expect(presented.changeAmt).toBe(50);
  });

  test('J25 positive changeAmt with zero cash rows renders เงินทอน and not รับเงิน', () => {
    const presented = presentPayments(order({ changeAmt: 20, paidAmt: 120 }), [pay('qr', 120)]);
    expect(presented.ok).toBe(true);
    if (presented.ok) {
      expect(presented.changeAmt).toBe(20);
      expect(presented.cashReceived).toBe(0);
    }
  });

  test('J26 split tender labels join all methods', () => {
    const presented = presentPayments(order(), [pay('cash', 40), pay('qr', 60)]);
    expect(presented.ok).toBe(true);
    if (presented.ok) {
      expect(presented.channel).toContain('เงินสด');
      expect(presented.channel).toContain('PromptPay QR');
      expect(presented.cashReceived).toBe(40);
    }
  });

  test('J27 partial credit / pending_payment: ชำระ is paidAmt not total; ค้างชำระ is total−paidAmt', () => {
    const presented = presentPayments(
      order({ status: 'pending_payment', total: 100, paidAmt: 40, creditAmt: 60 }),
      [pay('cash', 40), pay('credit', 60)],
    );
    expect(presented.ok).toBe(true);
    if (presented.ok) {
      expect(presented.paidAmt).toBe(40);
      expect(presented.dueAmt).toBe(60);
    }
  });

  test('J30 empty payments with nonzero total is REFUSED; Math.ceil fallback unreachable', async () => {
    expect(presentPayments(order({ total: 100 }), [])).toEqual({ ok: false, reason: 'empty_payments' });
    const src = (await import('./formatters.ts?raw')).default as string;
    expect(src.includes('Math.ceil')).toBe(false);
  });

  test('J32 showLogoOnReceipt and companyName originate from settings; absent/wrong-typed suppressed', async () => {
    const src = (await import('./receiptSettings.ts?raw')).default as string;
    expect(src).toMatch(/asString\(settings\.companyName\)/);
    expect(src).toMatch(/showLogo === true/);
    expect(src.includes("companyName: 'บริษัท ทวิน เพ็ท จำกัด'")).toBe(false);
    const merged = mergeAuthoritativeSettings(
      { name: 'LDP', address: 'a', phone: 'p', email: 'e', taxId: 't', logoUrl: null },
      { companyName: 12, showLogoOnReceipt: 'yes' },
      'AUTHORITATIVE',
      true,
    );
    expect(merged.companyName).toBe('');
    expect(merged.companyName).not.toBe('บริษัท ทวิน เพ็ท จำกัด');
    expect(merged.showLogoOnReceipt).toBe(false);
  });
});
