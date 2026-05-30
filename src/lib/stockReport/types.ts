import type { Product, StockLot, StockMovement } from '../types';

export type StockTab = 'overview' | 'products' | 'fifo' | 'movement';

export type StockStatus = 'ok' | 'low' | 'critical' | 'oos';

export type StockReportProduct = {
  id: string;
  name: string;
  sku: string;
  category: string;
  emoji: string;
  iconBg: string;
  imageUrl: string | null;
  expiryPolicyId: string | null;
  qty: number;
  reorderPoint: number;
  avgCost: number;
  cogsMonth: number;
  stockValue: number;
  /** เมื่อ true สินค้าจะไม่ถูกนับใน low/critical/OOS alerts */
  muteAlerts: boolean;
  lots: StockLot[];
};

export type MovementDisplayType = 'in' | 'out' | 'adj' | 'void';

export type StockReportMovement = StockMovement & {
  productName: string;
  productSku: string;
  imageUrl: string | null;
  emoji: string;
  iconBg: string;
  displayType: MovementDisplayType;
  staffName: string;
};

export const CAT_COLORS = [
  '#534AB7',
  '#1D9E75',
  '#EF9F27',
  '#E24B4A',
  '#185FA5',
  '#D4537E',
];

export const CATEGORY_ICON: Record<string, { emoji: string; bg: string }> = {
  'อาหารสุนัข': { emoji: '🐕', bg: '#EEEDFE' },
  'อาหารแมว': { emoji: '🐈', bg: '#E1F5EE' },
  'ของเล่น': { emoji: '🧸', bg: '#FAEEDA' },
  'ยาและวิตามิน': { emoji: '💊', bg: '#FCEBEB' },
  'อุปกรณ์': { emoji: '💧', bg: '#E6F1FB' },
  'ทรายแมว': { emoji: '🪣', bg: '#F1EFE8' },
  'อาหารสัตว์': { emoji: '🐾', bg: '#EEEDFE' },
  'ทรีทและขนม': { emoji: '🦴', bg: '#FAEEDA' },
  'กรายแมว': { emoji: '🐱', bg: '#F1EFE8' },
};

export function productVisual(category: string): { emoji: string; iconBg: string } {
  const v = CATEGORY_ICON[category] ?? { emoji: '📦', bg: '#EEEDFE' };
  return { emoji: v.emoji, iconBg: v.bg };
}

export function computeAvgCostFromLots(lots: StockLot[]): number {
  const active = lots.filter((l) => !l.isDepleted && l.qtyRemaining > 0);
  const totalQty = active.reduce((s, l) => s + l.qtyRemaining, 0);
  if (totalQty <= 0) return 0;
  const totalCost = active.reduce((s, l) => s + l.qtyRemaining * l.costPerUnit, 0);
  return totalCost / totalQty;
}

export function stockStatus(qty: number, reorderPoint: number): StockStatus {
  if (qty <= 0) return 'oos';
  if (qty <= reorderPoint * 0.5) return 'critical';
  if (qty <= reorderPoint) return 'low';
  return 'ok';
}

export function movementDisplayType(type: StockMovement['type']): MovementDisplayType {
  if (type === 'receive' || type === 'transfer_in') return 'in';
  if (type === 'sale' || type === 'transfer_out') return 'out';
  if (type === 'void') return 'void';
  return 'adj';
}

export function tsToDate(ts: StockMovement['createdAt']): Date {
  if (ts && typeof ts === 'object' && 'toDate' in ts && typeof ts.toDate === 'function') {
    return ts.toDate();
  }
  return new Date();
}

export function fmtNum(n: number): string {
  return parseFloat(String(n || 0)).toLocaleString('th-TH');
}

export function fmtBaht(n: number): string {
  return `฿${fmtNum(n)}`;
}

export function fmtBahtShort(n: number): string {
  if (n >= 1000) return `฿${(n / 1000).toFixed(0)}k`;
  return fmtBaht(n);
}

export function monthStartIso(d = new Date()): string {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

export function todayIso(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function inDateRange(d: Date, from: string, to: string): boolean {
  const iso = d.toISOString().slice(0, 10);
  return (!from || iso >= from) && (!to || iso <= to);
}

export function buildProductRows(
  products: Product[],
  stocks: Map<string, number>,
  reorderMap: Map<string, number>,
  lotsByProduct: Map<string, StockLot[]>,
  cogsByProduct: Map<string, number>,
): StockReportProduct[] {
  return products.map((p) => {
    const lots = lotsByProduct.get(p.id) ?? [];
    const qty = stocks.get(p.id) ?? 0;
    const reorderPoint = reorderMap.get(p.id) ?? p.reorderPoint ?? 0;
    const avgCost = computeAvgCostFromLots(lots) || p.avgCost || 0;
    const cogsMonth = cogsByProduct.get(p.id) ?? 0;
    const visual = productVisual(p.category);
    return {
      id: p.id,
      name: p.name,
      sku: p.sku,
      category: p.category,
      emoji: visual.emoji,
      iconBg: visual.iconBg,
      imageUrl: p.imageUrl ?? null,
      expiryPolicyId: p.expiryPolicyId ?? null,
      qty,
      reorderPoint,
      avgCost,
      cogsMonth,
      stockValue: qty * avgCost,
      muteAlerts: p.muteAlerts ?? false,
      lots: [...lots].sort((a, b) => tsToDate(a.receivedAt).getTime() - tsToDate(b.receivedAt).getTime()),
    };
  });
}

export function computeCogsFromMovements(
  movements: StockMovement[],
  from: string,
  to: string,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const m of movements) {
    if (m.type !== 'sale') continue;
    const d = tsToDate(m.createdAt);
    if (!inDateRange(d, from, to)) continue;
    const qty = Math.abs(m.qty);
    map.set(m.productId, (map.get(m.productId) ?? 0) + qty * m.costPerUnit);
  }
  return map;
}

export function computeOverviewMetrics(products: StockReportProduct[], totalCogs: number) {
  const totalVal = products.reduce((s, p) => s + p.stockValue, 0);
  // Muted products still count toward valuation/SKU totals but never trigger alerts.
  const alertable = products.filter((p) => !p.muteAlerts);
  const low = alertable.filter(
    (p) => stockStatus(p.qty, p.reorderPoint) === 'low' || stockStatus(p.qty, p.reorderPoint) === 'critical',
  ).length;
  const oos = alertable.filter((p) => p.qty <= 0).length;
  const turnover = totalVal > 0 ? ((totalCogs / totalVal) * 12).toFixed(1) : '0.0';
  return { totalVal, totalCogs, low, oos, turnover, skuCount: products.length };
}

export function categoryValues(products: StockReportProduct[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const p of products) {
    map[p.category] = (map[p.category] ?? 0) + p.stockValue;
  }
  return map;
}
