export type GroupBy = 'bill' | 'cat' | 'product' | 'customer';

export type DatePreset =
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d'
  | 'thismonth'
  | 'lastmonth'
  | '1y';

export type ProfitProduct = {
  id: string;
  name: string;
  sku: string;
  category: string;
  emoji: string;
  iconBg: string;
};

export type ProfitSaleLine = {
  id: string;
  orderId: string;
  date: string;
  time: string;
  bill: string;
  customer: string;
  productId: string;
  productName: string;
  productSku: string;
  category: string;
  emoji: string;
  iconBg: string;
  qty: number;
  salePrice: number;
  revenue: number;
  cogs: number;
  profit: number;
  margin: number;
};

export type ProfitAggregateRow = {
  key: string;
  qty: number;
  revenue: number;
  cogs: number;
  profit: number;
  margin: number;
  count: number;
  bills: number;
  productName?: string;
  productSku?: string;
  category?: string;
  emoji?: string;
  iconBg?: string;
  customer?: string;
};

export type SortField =
  | 'date'
  | 'bill'
  | 'customer'
  | 'product'
  | 'cat'
  | 'qty'
  | 'revenue'
  | 'cogs'
  | 'profit'
  | 'margin'
  | 'count'
  | 'bills';

export const CAT_COLORS = [
  '#534AB7',
  '#1D9E75',
  '#EF9F27',
  '#E24B4A',
  '#185FA5',
  '#D4537E',
];

export const PAGE_SIZE = 10;

export function fmtNum(n: number): string {
  return parseFloat(String(n || 0)).toLocaleString('th-TH');
}

export function fmtBaht(n: number): string {
  return `฿${fmtNum(Math.round(n))}`;
}

export function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

export function todayIso(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function dateAdd(iso: string, days: number): string {
  const dt = new Date(iso);
  dt.setDate(dt.getDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function applyDatePreset(preset: DatePreset, ref = new Date()): { from: string; to: string } {
  const to = todayIso(ref);
  if (preset === 'today') return { from: to, to };
  if (preset === 'yesterday') {
    const y = dateAdd(to, -1);
    return { from: y, to: y };
  }
  if (preset === '7d') return { from: dateAdd(to, -6), to };
  if (preset === '30d') return { from: dateAdd(to, -29), to };
  if (preset === 'thismonth') {
    return { from: `${to.slice(0, 7)}-01`, to };
  }
  if (preset === 'lastmonth') {
    const d = new Date(ref);
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    const from = d.toISOString().slice(0, 10);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { from, to: last.toISOString().slice(0, 10) };
  }
  return { from: dateAdd(to, -364), to };
}

export function marginClass(m: number): string {
  if (m >= 20) return 'pr-margin-ok';
  if (m >= 10) return 'pr-margin-mid';
  return 'pr-margin-low';
}

export function marginBarColor(m: number): string {
  if (m >= 20) return 'var(--success)';
  if (m >= 10) return 'var(--warn)';
  return 'var(--danger)';
}

export function computeKpi(data: ProfitSaleLine[]) {
  const revenue = data.reduce((s, r) => s + r.revenue, 0);
  const cogs = data.reduce((s, r) => s + r.cogs, 0);
  const profit = data.reduce((s, r) => s + r.profit, 0);
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  const bills = new Set(data.map((r) => r.bill)).size;
  return { revenue, cogs, profit, margin, bills, lineCount: data.length };
}

export function aggregateLines(data: ProfitSaleLine[], groupBy: GroupBy): ProfitAggregateRow[] {
  const map = new Map<string, ProfitSaleLine[]>();
  for (const line of data) {
    const key =
      groupBy === 'cat'
        ? line.category
        : groupBy === 'product'
          ? line.productId
          : groupBy === 'customer'
            ? line.customer
            : line.bill;
    const list = map.get(key) ?? [];
    list.push(line);
    map.set(key, list);
  }

  return [...map.entries()].map(([key, items]) => {
    const qty = items.reduce((s, r) => s + r.qty, 0);
    const revenue = items.reduce((s, r) => s + r.revenue, 0);
    const cogs = items.reduce((s, r) => s + r.cogs, 0);
    const profit = items.reduce((s, r) => s + r.profit, 0);
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
    const first = items[0]!;
    return {
      key,
      qty,
      revenue,
      cogs,
      profit,
      margin,
      count: items.length,
      bills: new Set(items.map((r) => r.bill)).size,
      productName: first.productName,
      productSku: first.productSku,
      category: first.category,
      emoji: first.emoji,
      iconBg: first.iconBg,
      customer: first.customer,
    };
  });
}

export function dateDiffDays(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000);
}
