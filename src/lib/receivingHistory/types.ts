import type { Receiving, ReceivingItem, ReceivingStatus } from '../types';
import type { ReceivingLine } from '../receiving/types';
import { lineQtyBase, lineSubtotal } from '../receiving/types';

export type ReceivingRecord = {
  receiving: Receiving;
  items: ReceivingItem[];
};

export type ReceivingStatusFilter = 'all' | ReceivingStatus;

export type ReceivingFilters = {
  search: string;
  dateFrom: Date;
  dateTo: Date;
  status: ReceivingStatusFilter;
};

export type DatePreset = 'today' | '7d' | '30d' | 'month' | 'custom';

export function receivingTimestamp(r: Receiving): Date {
  const ts = r.receivedAt ?? r.createdAt;
  if (ts && typeof ts === 'object' && 'toDate' in ts && typeof ts.toDate === 'function') {
    return ts.toDate();
  }
  return new Date();
}

export function formatReceivingDate(r: Receiving): string {
  return receivingTimestamp(r).toLocaleDateString('th-TH', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  });
}

export function formatReceivingDateTime(r: Receiving): string {
  const d = receivingTimestamp(r);
  return d.toLocaleString('th-TH', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getDateRange(
  preset: DatePreset,
  customFrom: string,
  customTo: string,
): { start: Date; end: Date } {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  let start: Date;

  switch (preset) {
    case 'today':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case '7d':
      start = new Date(end);
      start.setDate(start.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      break;
    case '30d':
      start = new Date(end);
      start.setDate(start.getDate() - 29);
      start.setHours(0, 0, 0, 0);
      break;
    case 'month':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    default: {
      const from = customFrom ? new Date(customFrom) : new Date(end);
      from.setHours(0, 0, 0, 0);
      const to = customTo ? new Date(customTo) : new Date(end);
      to.setHours(23, 59, 59, 999);
      return { start: from, end: to };
    }
  }
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

export function datePresetLabel(preset: DatePreset, from: string, to: string): string {
  if (preset === 'today') return 'วันนี้';
  if (preset === '7d') return '7 วันล่าสุด';
  if (preset === '30d') return '30 วันล่าสุด';
  if (preset === 'month') return 'เดือนนี้';
  if (from && to) return `${from} — ${to}`;
  return 'กำหนดเอง';
}

export function filterReceivings(records: ReceivingRecord[], filters: ReceivingFilters): ReceivingRecord[] {
  const q = filters.search.trim().toLowerCase();
  return records.filter(({ receiving, items }) => {
    const d = receivingTimestamp(receiving);
    if (d < filters.dateFrom || d > filters.dateTo) return false;
    if (filters.status !== 'all' && receiving.status !== filters.status) return false;
    if (!q) return true;
    const hay = [
      receiving.id,
      receiving.supplierName,
      receiving.note,
      ...items.map((i) => `${i.productSnap.name}${i.productSnap.sku}`),
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

export function computeReceivingSummary(records: ReceivingRecord[]) {
  let totalAmt = 0;
  let grnCount = 0;
  let lineCount = 0;
  for (const r of records) {
    if (r.receiving.status === 'cancelled') continue;
    totalAmt += r.receiving.total;
    grnCount += 1;
    lineCount += r.items.length;
  }
  return { totalAmt, grnCount, lineCount };
}

export type EditReceivingLine = ReceivingLine & {
  /** Existing receivingItems doc id when editing */
  itemId?: string;
};

export type UpdateReceivingInput = {
  receivingId: string;
  branchId: string;
  staffId: string;
  supplierId: string | null;
  supplierName: string;
  note: string;
  finalDiscount: number;
  lines: EditReceivingLine[];
};

export type CancelReceivingInput = {
  receivingId: string;
  branchId: string;
  staffId: string;
  reason: string;
  note?: string;
};

export type DraftReceivingLine = EditReceivingLine;

export type SaveReceivingDraftInput = {
  receivingId?: string;
  branchId: string;
  staffId: string;
  supplierId: string | null;
  supplierName: string;
  note: string;
  finalDiscount: number;
  lines: DraftReceivingLine[];
};

export const DRAFT_LOT_ID = 'DRAFT';

export type ReceivingEditNavState = {
  toast?: string;
  draftSeed?: {
    receivingId: string;
    formValues: import('../receiving/receivingFormUtils').ReceivingFormValues;
  };
};

const LOAD_RECEIVING_RETRY_MS = [0, 250, 500, 800];

export async function loadReceivingWithRetry(
  loadReceiving: (id: string) => Promise<Receiving | null>,
  receivingId: string,
): Promise<Receiving | null> {
  for (let attempt = 0; attempt < LOAD_RECEIVING_RETRY_MS.length; attempt++) {
    const delay = LOAD_RECEIVING_RETRY_MS[attempt];
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const doc = await loadReceiving(receivingId);
    if (doc) return doc;
  }
  return null;
}

export function receivingItemToLine(item: ReceivingItem): EditReceivingLine {
  return {
    lineKey: item.id,
    itemId: item.id,
    productId: item.productId,
    productName: item.productSnap.name,
    sku: item.productSnap.sku,
    hasVat: true,
    unit: item.unit,
    unitFactor: item.unitFactor,
    qty: item.qty,
    costPerUnit: item.costPerUnit,
    itemDiscount: item.discountAmt,
    hasExpiry: false,
    expiryDate: '',
  };
}

export function lineMatchesItem(line: EditReceivingLine, item: ReceivingItem): boolean {
  return line.itemId === item.id;
}

export function receivingLineTotal(line: ReceivingLine): number {
  return lineSubtotal(line);
}

export function receivingLinesQtyBase(lines: ReceivingLine[]): number {
  return lines.reduce((s, l) => s + lineQtyBase(l), 0);
}

export const RECEIVING_STATUS_LABELS: Record<ReceivingStatus, string> = {
  completed: 'สำเร็จ',
  draft: 'แบบร่าง',
  cancelled: 'ยกเลิก',
};
