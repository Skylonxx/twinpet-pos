import type { Order, OrderItem, Payment, PaymentMethod } from '../types';

export type SaleStatus = 'paid' | 'credit' | 'void';

export type SaleRecord = {
  order: Order;
  payments: Payment[];
  items: OrderItem[];
  /**
   * True for hybrid-overlay rows synthesized from a still-pending `asyncOrders`
   * doc (sale written locally, not yet settled on the server). Drives the
   * "⏳ รอซิงก์" badge and disables Void. Absent/false for canonical rows.
   */
  pendingSync?: boolean;
  /**
   * True for a SETTLED canonical row whose `asyncOrder` carries a `voidRequested`
   * intent that the server reconciler has not yet applied (offline/in-flight
   * void). Drives the "ยกเลิก (รอซิงก์)" badge; transitions to the normal "ยกเลิก"
   * once the reconciler flips the canonical `orders` doc to `voided`. Treated as
   * voided for summary totals so it never inflates revenue.
   */
  voidPendingSync?: boolean;
};

export type StatusFilter = 'all' | SaleStatus;

export type DatePreset =
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d'
  | 'month'
  | 'custom';

export type SalesFilters = {
  search: string;
  status: StatusFilter;
  paymentMethod: PaymentMethod | 'all';
  datePreset: DatePreset;
  dateFrom: string;
  dateTo: string;
};

export function saleDisplayStatus(order: Order): SaleStatus {
  if (order.status === 'voided') return 'void';
  if (order.status === 'pending_payment') return 'credit';
  return 'paid';
}

export function parseTimestamp(value: unknown): Date {
  if (value == null) return new Date(0);
  if (value instanceof Date) return value;
  if (typeof value === 'object' && value !== null) {
    if ('toDate' in value && typeof (value as { toDate: unknown }).toDate === 'function') {
      return (value as { toDate: () => Date }).toDate();
    }
    if ('seconds' in value && typeof (value as { seconds: unknown }).seconds === 'number') {
      return new Date((value as { seconds: number }).seconds * 1000);
    }
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}

export function orderCreatedAt(order: Order): Date {
  return parseTimestamp(order.createdAt);
}

export function formatSaleTime(d: Date): string {
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatSaleDate(d: Date): string {
  return d.toLocaleDateString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatSaleDateTime(d: Date): string {
  return `วันที่ ${formatSaleDate(d)} เวลา ${formatSaleTime(d)} น.`;
}

export function customerInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]!.charAt(0)}${parts[1]!.charAt(0)}`;
  }
  return name.slice(0, 2);
}

export const VOID_REASONS = [
  'ลูกค้าเปลี่ยนใจ',
  'สินค้าผิด',
  'ราคาผิดพลาด',
  'ทดสอบระบบ',
  'อื่นๆ',
] as const;

export const PAYMENT_FILTER_OPTIONS: Array<{ value: PaymentMethod | 'all'; label: string }> = [
  { value: 'all', label: 'ช่องทางทั้งหมด' },
  { value: 'cash', label: 'เงินสด' },
  { value: 'qr', label: 'PromptPay QR' },
  { value: 'kbank', label: 'QR KBank' },
  { value: 'card', label: 'EDC' },
  { value: 'credit', label: 'เงินเชื่อ' },
];

export const PAY_METHOD_META: Record<
  PaymentMethod,
  { label: string; icon: string; chipClass: string }
> = {
  cash: { label: 'เงินสด', icon: 'ti-cash', chipClass: 'sh-pay-cash' },
  qr: { label: 'PromptPay', icon: 'ti-qrcode', chipClass: 'sh-pay-transfer' },
  kbank: { label: 'KBank', icon: 'ti-building-bank', chipClass: 'sh-pay-transfer' },
  card: { label: 'EDC', icon: 'ti-credit-card', chipClass: 'sh-pay-card' },
  credit: { label: 'เชื่อ', icon: 'ti-clock-dollar', chipClass: 'sh-pay-credit' },
};

export function getDateRange(
  preset: DatePreset,
  customFrom: string,
  customTo: string,
  now = new Date(),
): { start: Date; end: Date } {
  const start = new Date(now);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  start.setHours(0, 0, 0, 0);

  if (preset === 'today') {
    return { start, end };
  }

  if (preset === 'yesterday') {
    start.setDate(start.getDate() - 1);
    end.setDate(end.getDate() - 1);
    return { start, end };
  }

  if (preset === '7d') {
    start.setDate(start.getDate() - 6);
    return { start, end };
  }

  if (preset === '30d') {
    start.setDate(start.getDate() - 29);
    return { start, end };
  }

  if (preset === 'month') {
    start.setDate(1);
    return { start, end };
  }

  const from = customFrom ? new Date(customFrom) : start;
  const to = customTo ? new Date(customTo) : end;
  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);
  return { start: from, end: to };
}

export function datePresetLabel(preset: DatePreset): string {
  const map: Record<DatePreset, string> = {
    today: 'วันนี้',
    yesterday: 'เมื่อวาน',
    '7d': '7 วันล่าสุด',
    '30d': '30 วันล่าสุด',
    month: 'เดือนนี้',
    custom: 'กำหนดเอง',
  };
  return map[preset];
}

export function filterSales(records: SaleRecord[], filters: SalesFilters): SaleRecord[] {
  const q = filters.search.trim().toLowerCase();
  const { start, end } = getDateRange(filters.datePreset, filters.dateFrom, filters.dateTo);

  return records.filter(({ order, payments }) => {
    const created = orderCreatedAt(order);
    if (created < start || created > end) return false;

    const status = saleDisplayStatus(order);
    if (filters.status !== 'all' && status !== filters.status) return false;

    if (filters.paymentMethod !== 'all') {
      const hasPaymentMethod =
        payments.some((p) => p.method === filters.paymentMethod) ||
        (filters.paymentMethod === 'credit' && order.creditAmt > 0);
      if (!hasPaymentMethod) return false;
    }

    if (!q) return true;

    const name = order.customerSnap?.name?.toLowerCase() ?? '';
    const phone = order.customerSnap?.phone ?? '';
    return (
      order.id.toLowerCase().includes(q) ||
      order.billId.toLowerCase().includes(q) ||
      name.includes(q) ||
      phone.includes(q) ||
      order.staffName.toLowerCase().includes(q)
    );
  });
}

export function computeSummary(records: SaleRecord[]) {
  let totalAmt = 0;
  let paidCount = 0;
  let paidAmt = 0;
  let creditCount = 0;
  let creditAmt = 0;
  let voidCount = 0;
  let cashAmt = 0;

  for (const record of records) {
    const { order, payments } = record;
    const status = saleDisplayStatus(order);
    // A settled void still in-flight (voidPendingSync) is treated as voided so it
    // never inflates revenue — keeping the summary consistent with the drawer,
    // which already drops it via the local ledger.
    if (record.voidPendingSync || status === 'void') {
      voidCount += 1;
      continue;
    }

    totalAmt += order.total;
    if (status === 'paid') {
      paidCount += 1;
      paidAmt += order.total;
    } else {
      creditCount += 1;
      creditAmt += order.total;
    }

    for (const p of payments) {
      if (p.method === 'cash') cashAmt += p.amount;
    }
  }

  return {
    totalAmt,
    billCount: paidCount + creditCount,
    paidCount,
    paidAmt,
    creditCount,
    creditAmt,
    voidCount,
    cashAmt,
  };
}
