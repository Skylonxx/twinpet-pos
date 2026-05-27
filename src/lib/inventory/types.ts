import type { ProductPickerItem } from '../../components/products/productPickerTypes';
import type { Timestamp } from '../types';

export const ADJUSTMENT_REASONS = [
  'ตรวจนับสต็อก',
  'สินค้าชำรุด',
  'สินค้าสูญหาย',
  'นำไปใช้ในกิจการ',
  'อื่นๆ',
] as const;

export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

/** Form state line (before confirm) */
export type AdjustmentLine = {
  lineKey: string;
  productId: string;
  name: string;
  sku: string;
  currentStock: number;
  adjustQty: number;
};

/** Persisted line item on inventoryAdjustments document / subcollection */
export type InventoryAdjustmentItem = {
  productId: string;
  productName: string;
  sku: string;
  currentStock: number;
  adjustQty: number;
  newStock: number;
  unitCost: number;
  valueImpact: number;
};

/** Root inventoryAdjustments document */
export type InventoryAdjustment = {
  id: string;
  branchId: string;
  adjustDate: string;
  reason: AdjustmentReason;
  note: string;
  staffId: string;
  staffName: string;
  itemCount: number;
  totalValueImpact: number;
  status: 'completed';
  createdAt: Timestamp;
};

export type ConfirmAdjustmentLineInput = {
  productId: string;
  name: string;
  sku: string;
  currentStock: number;
  adjustQty: number;
};

export type ConfirmInventoryAdjustmentInput = {
  branchId: string;
  staffId: string;
  staffName: string;
  adjustDate: string;
  reason: AdjustmentReason;
  note: string;
  lines: ConfirmAdjustmentLineInput[];
};

export function lineFromPickerItem(item: ProductPickerItem): AdjustmentLine {
  return {
    lineKey: `adj-${item.id}-${Date.now()}`,
    productId: item.id,
    name: item.name,
    sku: item.sku,
    currentStock: item.stock,
    adjustQty: 0,
  };
}

export function newStock(line: Pick<AdjustmentLine, 'currentStock' | 'adjustQty'>): number {
  return line.currentStock + line.adjustQty;
}

export function formatAdjustQty(qty: number): string {
  if (qty > 0) return `+${qty}`;
  if (qty < 0) return String(qty);
  return '0';
}

export function computeLineImpact(adjustQty: number, avgCost: number): {
  unitCost: number;
  valueImpact: number;
} {
  const unitCost = avgCost;
  const valueImpact = adjustQty * unitCost;
  return { unitCost, valueImpact };
}

export function computeTotalValueImpact(items: Pick<InventoryAdjustmentItem, 'valueImpact'>[]): number {
  return items.reduce((sum, item) => sum + item.valueImpact, 0);
}

export function formatValueImpact(amount: number): string {
  const abs = Math.abs(amount).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (amount > 0) return `+฿${abs}`;
  if (amount < 0) return `-฿${abs}`;
  return `฿${abs}`;
}

export function generateAdjId(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const suffix = String(Math.floor(Math.random() * 9000) + 1000);
  return `ADJ-${y}${m}${day}-${suffix}`;
}
