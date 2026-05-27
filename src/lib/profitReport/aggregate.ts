import type { DatePreset, ProfitAggregateRow, ProfitSaleLine } from './types';
import { CAT_COLORS, dateDiffDays } from './types';

export const PRESET_LABELS: Record<DatePreset, string> = {
  today: 'ยอดขาย vs กำไร (รายวัน — วันนี้)',
  yesterday: 'ยอดขาย vs กำไร (รายวัน — เมื่อวาน)',
  '7d': 'ยอดขาย vs กำไร (7 วันล่าสุด — รายวัน)',
  '30d': 'ยอดขาย vs กำไร (30 วันล่าสุด — รายวัน)',
  thismonth: 'ยอดขาย vs กำไร (เดือนนี้ — รายวัน)',
  lastmonth: 'ยอดขาย vs กำไร (เดือนที่แล้ว — รายวัน)',
  '1y': 'ยอดขาย vs กำไร (1 ปีล่าสุด — รายเดือน)',
};

export function buildBarChartData(
  data: ProfitSaleLine[],
  from: string,
  to: string,
): { labels: string[]; revenue: number[]; profit: number[]; monthly: boolean } {
  const diffDays = from && to ? dateDiffDays(from, to) : 7;
  const monthly = diffDays > 31;

  if (monthly) {
    const monthMap: Record<string, { rev: number; prof: number }> = {};
    for (const r of data) {
      const m = r.date.slice(0, 7);
      if (!monthMap[m]) monthMap[m] = { rev: 0, prof: 0 };
      monthMap[m].rev += r.revenue;
      monthMap[m].prof += r.profit;
    }
    const months = Object.keys(monthMap).sort();
    return {
      monthly: true,
      labels: months.map((m) => {
        const p = m.split('-');
        return `${+p[1]!}/${p[0]!.slice(2)}`;
      }),
      revenue: months.map((m) => monthMap[m]!.rev),
      profit: months.map((m) => monthMap[m]!.prof),
    };
  }

  if (!from || !to) {
    return { monthly: false, labels: [], revenue: [], profit: [] };
  }

  const labels: string[] = [];
  const revenue: number[] = [];
  const profit: number[] = [];
  const cur = new Date(from);
  const end = new Date(to);

  while (cur <= end) {
    const d = cur.toISOString().slice(0, 10);
    const p = d.split('-');
    labels.push(`${+p[2]!}/${+p[1]!}`);
    const rows = data.filter((r) => r.date === d);
    revenue.push(rows.reduce((a, r) => a + r.revenue, 0));
    profit.push(rows.reduce((a, r) => a + r.profit, 0));
    cur.setDate(cur.getDate() + 1);
  }

  return { monthly: false, labels, revenue, profit };
}

export function buildDonutData(
  data: ProfitSaleLine[],
  categories: string[],
): { labels: string[]; values: number[]; colors: string[]; total: number } {
  const catMap: Record<string, number> = {};
  for (const r of data) {
    catMap[r.category] = (catMap[r.category] ?? 0) + r.profit;
  }
  const labels = Object.keys(catMap).filter((k) => catMap[k]! > 0);
  const values = labels.map((k) => catMap[k]!);
  const colors = labels.map((l) => CAT_COLORS[categories.indexOf(l)] ?? '#888');
  const total = values.reduce((a, b) => a + b, 0);
  return { labels, values, colors, total };
}

export type TopCustomer = { name: string; revenue: number; profit: number };

export function buildTop5Customers(data: ProfitSaleLine[]): TopCustomer[] {
  const cmap: Record<string, { revenue: number; profit: number }> = {};
  for (const r of data) {
    if (!cmap[r.customer]) cmap[r.customer] = { revenue: 0, profit: 0 };
    cmap[r.customer].revenue += r.revenue;
    cmap[r.customer].profit += r.profit;
  }
  return Object.entries(cmap)
    .map(([name, vals]) => ({ name, ...vals }))
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 5);
}

export function filterProfitLines(
  lines: ProfitSaleLine[],
  opts: {
    search: string;
    category: string;
    from: string;
    to: string;
    productIds: Set<string>;
  },
): ProfitSaleLine[] {
  const q = opts.search.trim().toLowerCase();
  return lines.filter((r) => {
    const mq =
      !q ||
      `${r.productName}${r.productSku}${r.bill}${r.customer}`.toLowerCase().includes(q);
    const mc = !opts.category || r.category === opts.category;
    const md = (!opts.from || r.date >= opts.from) && (!opts.to || r.date <= opts.to);
    const mp = opts.productIds.size === 0 || opts.productIds.has(r.productId);
    return mq && mc && md && mp;
  });
}

export function deriveProducts(lines: ProfitSaleLine[]): Array<{
  id: string;
  name: string;
  sku: string;
  category: string;
  emoji: string;
  iconBg: string;
}> {
  const map = new Map<string, ProfitSaleLine>();
  for (const line of lines) {
    if (!map.has(line.productId)) map.set(line.productId, line);
  }
  return [...map.values()].map((l) => ({
    id: l.productId,
    name: l.productName,
    sku: l.productSku,
    category: l.category,
    emoji: l.emoji,
    iconBg: l.iconBg,
  }));
}

export function deriveCategories(lines: ProfitSaleLine[]): string[] {
  const set = new Set(lines.map((l) => l.category));
  return [...set].sort((a, b) => a.localeCompare(b, 'th'));
}

export function sortLines<T>(
  arr: T[],
  getter: (row: T) => string | number,
  dir: 'asc' | 'desc',
): T[] {
  return [...arr].sort((a, b) => {
    const av = getter(a);
    const bv = getter(b);
    if (typeof av === 'string') {
      return dir === 'asc' ? av.localeCompare(String(bv), 'th') : String(bv).localeCompare(av, 'th');
    }
    return dir === 'asc' ? av - (bv as number) : (bv as number) - av;
  });
}

import { downloadCsv } from '../stockReport/exportCsv';

export function exportProfitCsv(data: ProfitSaleLine[]): void {
  const rows: string[][] = [
    [
      'Date',
      'Time',
      'Bill',
      'Customer',
      'SKU',
      'Product',
      'Category',
      'Qty',
      'SalePrice',
      'Revenue',
      'COGS',
      'Profit',
      'Margin%',
    ],
  ];
  for (const r of data) {
    rows.push([
      r.date,
      r.time,
      r.bill,
      r.customer,
      r.productSku,
      r.productName,
      r.category,
      String(r.qty),
      String(r.salePrice),
      String(r.revenue),
      String(r.cogs),
      String(r.profit),
      r.margin.toFixed(2),
    ]);
  }
  downloadCsv(rows, 'profit_report');
}

export function aggregateFieldMap(
  groupBy: 'cat' | 'product' | 'customer',
): Record<string, (g: ProfitAggregateRow) => string | number> {
  if (groupBy === 'cat') {
    return {
      cat: (g) => g.key,
      count: (g) => g.count,
      qty: (g) => g.qty,
      revenue: (g) => g.revenue,
      cogs: (g) => g.cogs,
      profit: (g) => g.profit,
      margin: (g) => g.margin,
    };
  }
  if (groupBy === 'product') {
    return {
      product: (g) => g.productName ?? '',
      cat: (g) => g.category ?? '',
      count: (g) => g.count,
      qty: (g) => g.qty,
      revenue: (g) => g.revenue,
      cogs: (g) => g.cogs,
      profit: (g) => g.profit,
      margin: (g) => g.margin,
    };
  }
  return {
    customer: (g) => g.key,
    bills: (g) => g.bills,
    count: (g) => g.count,
    qty: (g) => g.qty,
    revenue: (g) => g.revenue,
    cogs: (g) => g.cogs,
    profit: (g) => g.profit,
    margin: (g) => g.margin,
  };
}

export function billFieldMap(): Record<string, (r: ProfitSaleLine) => string | number> {
  return {
    date: (r) => `${r.date}${r.time}`,
    bill: (r) => r.bill,
    customer: (r) => r.customer,
    product: (r) => r.productName,
    qty: (r) => r.qty,
    revenue: (r) => r.revenue,
    cogs: (r) => r.cogs,
    profit: (r) => r.profit,
    margin: (r) => r.margin,
  };
}
