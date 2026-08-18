import type { Timestamp } from 'firebase/firestore';
import type { Customer, Order, Payment, PaymentMethod } from '../types';
import type { A4DocType } from './types';
import { A4_DOC_TYPES } from './types';

export const PAY_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'เงินสด',
  qr: 'PromptPay QR',
  kbank: 'KBank QR',
  card: 'EDC บัตร',
  credit: 'เชื่อ',
};

export function fmtBaht(n: number, decimals = 2): string {
  return parseFloat(String(n || 0)).toLocaleString('th-TH', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtBahtSymbol(n: number, decimals = 2): string {
  return `฿${fmtBaht(n, decimals)}`;
}

export function formatThaiDate(ts: Timestamp | Date, withTime = false): string {
  const d = ts instanceof Date ? ts : ts.toDate();
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const year = d.getFullYear() + 543;
  if (!withTime) return `${day}/${month}/${year}`;
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${day}/${month}/${year}  ${h}:${m}`;
}

export function customerDisplayName(
  customer: Customer | null | undefined,
  order: Order,
): string {
  if (customer) return `${customer.firstName} ${customer.lastName}`.trim();
  return order.customerSnap?.name ?? '';
}

export function customerPhone(
  customer: Customer | null | undefined,
  order: Order,
): string {
  if (customer?.phone) return customer.phone;
  return order.customerSnap?.phone ?? '';
}

export function customerTaxId(
  customer: Customer | null | undefined,
  order: Order,
): string | null {
  if (customer?.taxId) return customer.taxId;
  return order.customerSnap?.taxId ?? null;
}

export function primaryPayLabel(order: Order, payments?: Payment[]): string {
  if (payments && payments.length > 0) {
    const labels = distinctMethodLabels(payments);
    return labels.join(' + ');
  }
  if (order.creditAmt > 0 && order.paidAmt === 0) return 'เชื่อ';
  if (order.creditAmt > 0) return 'หลายช่องทาง';
  return 'เงินสด';
}

const METHOD_ORDER: PaymentMethod[] = ['cash', 'qr', 'kbank', 'card', 'credit'];

export function sumAllPayments(payments: Payment[]): number {
  return payments.reduce((s, p) => s + p.amount, 0);
}

export function sumCash(payments: Payment[]): number {
  return payments.reduce((s, p) => (p.method === 'cash' ? s + p.amount : s), 0);
}

export function sumCredit(payments: Payment[]): number {
  return payments.reduce((s, p) => (p.method === 'credit' ? s + p.amount : s), 0);
}

export function distinctMethodLabels(payments: Payment[]): string[] {
  const set = new Set(payments.map((p) => p.method));
  return METHOD_ORDER.filter((m) => set.has(m)).map((m) => PAY_METHOD_LABELS[m]);
}

export type PaymentPresentation =
  | { ok: true; channel: string; paidAmt: number; cashReceived: number; changeAmt: number; creditAmt: number; dueAmt: number; rows: Payment[] }
  | { ok: false; reason: 'empty_payments' };

export function presentPayments(order: Order, payments: Payment[]): PaymentPresentation {
  if ((!payments || payments.length === 0) && order.total > 0) {
    return { ok: false, reason: 'empty_payments' };
  }
  const list = payments ?? [];
  return {
    ok: true,
    channel: distinctMethodLabels(list).join(' + ') || PAY_METHOD_LABELS.cash,
    paidAmt: order.paidAmt,
    cashReceived: sumCash(list),
    changeAmt: order.changeAmt,
    creditAmt: sumCredit(list),
    dueAmt: order.status === 'pending_payment' ? Math.round((order.total - order.paidAmt) * 100) / 100 : 0,
    rows: list,
  };
}

export function cashReceived(_order: Order, payments?: Payment[]): number {
  return sumCash(payments ?? []);
}

export function buildDocNumber(docType: A4DocType, order: Order): string {
  if (docType === 'receipt' && order.billId) return order.billId;
  const cfg = A4_DOC_TYPES[docType];
  const d = order.createdAt.toDate();
  const ym = `${d.getFullYear()}${(d.getMonth() + 1).toString().padStart(2, '0')}`;
  const suffix = order.id.replace(/\D/g, '').slice(-4).padStart(4, '0');
  return `${cfg.numPrefix}-${ym}-${suffix}`;
}

export function orderStamp(order: Order, docType: A4DocType): { text: string; color: string } {
  if (order.status === 'voided') return { text: 'ยกเลิก', color: '#A32D2D' };
  if (order.status === 'pending_payment') return { text: 'รอชำระ', color: '#854F0B' };
  const cfg = A4_DOC_TYPES[docType];
  return { text: cfg.stamp, color: cfg.stampColor };
}

/** Simple barcode SVG for thermal receipts */
export function barcodeSVG(text: string): string {
  const seed = [...text].reduce((a, c) => a + c.charCodeAt(0), 0);
  let bars = '';
  const n = 60;
  for (let i = 0; i < n; i++) {
    const w = ((seed * i * 31 + 7) % 3) + 1;
    const x = i * 3 + i;
    if ((seed * i) % 5 !== 0) {
      bars += `<rect x="${x}" y="0" width="${w}" height="28" fill="#111"/>`;
    }
  }
  return `<svg class="barcode-svg" width="58mm" height="10mm" viewBox="0 0 220 36" xmlns="http://www.w3.org/2000/svg">
    ${bars}
    <text x="110" y="35" text-anchor="middle" font-size="7" font-family="Sarabun,monospace" fill="#333">${text}</text>
  </svg>`;
}

export function extractVatFromInclusive(total: number, rate = 7): { base: number; vat: number } {
  const vat = Math.round(((total * rate) / (100 + rate)) * 100) / 100;
  const base = Math.round((total - vat) * 100) / 100;
  return { base, vat };
}
