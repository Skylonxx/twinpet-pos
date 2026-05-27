import type { PaymentMethod } from '../types';
import { eachCalendarDay, isWithinRange, TREND_TITLES } from './periods';
import type {
  AggregateDashboardParams,
  DashboardAggregates,
  DashboardPaymentRecord,
  DashboardPeriod,
  DashboardSaleLine,
  PeriodBounds,
  StockAlertRow,
  StockMapEntry,
} from './types';

const CATEGORY_COLORS = [
  '#534AB7',
  '#1D9E75',
  '#EF9F27',
  '#E24B4A',
  '#185FA5',
  '#D4537E',
  '#6B62C9',
  '#854F0B',
] as const;

const PAYMENT_ORDER: PaymentMethod[] = ['cash', 'qr', 'kbank', 'card', 'credit'];

const TODAY_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17] as const;

export const EMPTY_DASHBOARD_AGGREGATES: DashboardAggregates = {
  kpi: {
    revenue: 0,
    profit: 0,
    bills: 0,
    margin: 0,
    prevRevenue: 0,
    prevProfit: 0,
    prevBills: 0,
  },
  trendTitle: TREND_TITLES.today,
  trend: [],
  categories: [],
  topProducts: [],
  topCustomers: [],
  payments: PAYMENT_ORDER.map((method) => ({
    method,
    revenue: 0,
    bills: 0,
    pct: 0,
    barWidth: 0,
  })),
  stockAlerts: [],
};

function filterLines(
  lines: DashboardSaleLine[],
  start: Date,
  end: Date,
): DashboardSaleLine[] {
  return lines.filter((l) => isWithinRange(l.createdAt, start, end));
}

function sumRevenue(lines: DashboardSaleLine[]): number {
  return lines.reduce((acc, l) => acc + l.revenue, 0);
}

/** Profit = revenue − true fifoCost captured at sale time */
function sumProfit(lines: DashboardSaleLine[]): number {
  return lines.reduce((acc, l) => acc + (l.revenue - l.cogs), 0);
}

function countBills(lines: DashboardSaleLine[]): number {
  return new Set(lines.map((l) => l.orderId)).size;
}

function formatDayLabel(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function buildTrend(
  period: DashboardPeriod,
  lines: DashboardSaleLine[],
  bounds: PeriodBounds,
): DashboardAggregates['trend'] {
  if (period === 'today') {
    return TODAY_HOURS.map((h) => {
      const hourLines = lines.filter((l) => l.createdAt.getHours() === h);
      return {
        label: `${h}:00`,
        revenue: sumRevenue(hourLines),
        profit: sumProfit(hourLines),
      };
    });
  }

  return eachCalendarDay(bounds.start, bounds.end).map((day) => {
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const dayEnd = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      23,
      59,
      59,
      999,
    );
    const dayLines = filterLines(lines, dayStart, dayEnd);
    return {
      label: formatDayLabel(day),
      revenue: sumRevenue(dayLines),
      profit: sumProfit(dayLines),
    };
  });
}

function buildCategories(lines: DashboardSaleLine[]): DashboardAggregates['categories'] {
  const map = new Map<string, number>();
  for (const line of lines) {
    map.set(line.category, (map.get(line.category) ?? 0) + line.revenue);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, revenue], i) => ({
      category,
      revenue,
      color: CATEGORY_COLORS[i % CATEGORY_COLORS.length]!,
    }));
}

function buildTopProducts(lines: DashboardSaleLine[]): DashboardAggregates['topProducts'] {
  const map = new Map<
    string,
    { name: string; category: string; revenue: number; profit: number }
  >();

  for (const line of lines) {
    const cur = map.get(line.productId) ?? {
      name: line.productName,
      category: line.category,
      revenue: 0,
      profit: 0,
    };
    cur.revenue += line.revenue;
    cur.profit += line.revenue - line.cogs;
    map.set(line.productId, cur);
  }

  return [...map.entries()]
    .map(([productId, v]) => ({ productId, ...v }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);
}

function buildTopCustomers(lines: DashboardSaleLine[]): DashboardAggregates['topCustomers'] {
  const map = new Map<string, { revenue: number; bills: Set<string> }>();

  for (const line of lines) {
    const cur = map.get(line.customerName) ?? { revenue: 0, bills: new Set<string>() };
    cur.revenue += line.revenue;
    cur.bills.add(line.orderId);
    map.set(line.customerName, cur);
  }

  return [...map.entries()]
    .map(([name, v]) => ({ name, revenue: v.revenue, bills: v.bills.size }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);
}

function buildPayments(
  lines: DashboardSaleLine[],
  paymentRecords: DashboardPaymentRecord[],
): DashboardAggregates['payments'] {
  const orderIds = new Set(lines.map((l) => l.orderId));
  const scoped = paymentRecords.filter((p) => orderIds.has(p.orderId));

  const payMap = new Map<PaymentMethod, { revenue: number; bills: Set<string> }>();

  if (scoped.length > 0) {
    for (const p of scoped) {
      const cur = payMap.get(p.method) ?? { revenue: 0, bills: new Set<string>() };
      cur.revenue += p.amount;
      cur.bills.add(p.orderId);
      payMap.set(p.method, cur);
    }
  } else {
    for (const line of lines) {
      const cur = payMap.get(line.paymentMethod) ?? { revenue: 0, bills: new Set<string>() };
      cur.revenue += line.revenue;
      cur.bills.add(line.orderId);
      payMap.set(line.paymentMethod, cur);
    }
  }

  const totalRev = PAYMENT_ORDER.reduce((acc, k) => acc + (payMap.get(k)?.revenue ?? 0), 0);
  const maxRev = Math.max(...PAYMENT_ORDER.map((k) => payMap.get(k)?.revenue ?? 0), 1);

  return PAYMENT_ORDER.map((method) => {
    const val = payMap.get(method) ?? { revenue: 0, bills: new Set<string>() };
    return {
      method,
      revenue: val.revenue,
      bills: val.bills.size,
      pct: totalRev > 0 ? (val.revenue / totalRev) * 100 : 0,
      barWidth: (val.revenue / maxRev) * 100,
    };
  });
}

function buildStockAlerts(stockMap: Map<string, StockMapEntry>): StockAlertRow[] {
  return [...stockMap.entries()]
    .map(([productId, v]) => ({
      productId,
      name: v.name,
      qty: v.qty,
      reorderPoint: v.reorderPoint,
      critical: v.reorderPoint > 0 && (v.qty === 0 || v.qty <= v.reorderPoint * 0.4),
    }))
    .filter((p) => p.reorderPoint > 0 && p.qty <= p.reorderPoint)
    .sort((a, b) => a.qty - b.qty)
    .slice(0, 6);
}

export function aggregateDashboard(
  period: DashboardPeriod,
  saleLines: DashboardSaleLine[],
  paymentRecords: DashboardPaymentRecord[],
  stockMap: Map<string, StockMapEntry>,
  _now: Date,
  bounds: PeriodBounds,
): DashboardAggregates {
  const current = filterLines(saleLines, bounds.start, bounds.end);
  const previous = filterLines(saleLines, bounds.prevStart, bounds.prevEnd);

  const revenue = sumRevenue(current);
  const profit = sumProfit(current);
  const bills = countBills(current);
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  return {
    kpi: {
      revenue,
      profit,
      bills,
      margin,
      prevRevenue: sumRevenue(previous),
      prevProfit: sumProfit(previous),
      prevBills: countBills(previous),
    },
    trendTitle: TREND_TITLES[period],
    trend: buildTrend(period, current, bounds),
    categories: buildCategories(current),
    topProducts: buildTopProducts(current),
    topCustomers: buildTopCustomers(current),
    payments: buildPayments(current, paymentRecords),
    stockAlerts: buildStockAlerts(stockMap),
  };
}

/** Object-style overload for typed call sites */
export function aggregateDashboardFromParams(params: AggregateDashboardParams): DashboardAggregates {
  const { period, saleLines, paymentRecords, stockMap, now, bounds } = params;
  return aggregateDashboard(period, saleLines, paymentRecords, stockMap, now, bounds);
}

export function pctChange(current: number, previous: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return 0;
  if (previous <= 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}
