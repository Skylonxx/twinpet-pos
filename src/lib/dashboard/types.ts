import type {
  CustomerSnap,
  Order,
  OrderItem,
  OrderStatus,
  Payment,
  PaymentMethod,
  ProductSnap,
} from '../types';

// ── Period ────────────────────────────────────────────────────────────────────

export type DashboardPeriod = 'today' | 'week' | 'month';

export type PeriodBounds = {
  /** Inclusive start of the active analytics window (local time) */
  start: Date;
  /** Inclusive end of the active analytics window (local time) */
  end: Date;
  /** Inclusive start of the comparison window */
  prevStart: Date;
  /** Inclusive end of the comparison window */
  prevEnd: Date;
  /** Earliest timestamp to fetch from Firestore (covers current + previous) */
  fetchStart: Date;
};

// ── Firestore document shapes (dashboard subset) ─────────────────────────────

/** `orders/{id}` fields consumed by analytics */
export type DashboardOrderDoc = Pick<
  Order,
  | 'branchId'
  | 'status'
  | 'subtotal'
  | 'total'
  | 'paidAmt'
  | 'creditAmt'
  | 'customerSnap'
  | 'createdAt'
> & {
  id: string;
  status: OrderStatus;
  customerSnap: CustomerSnap | null;
};

/** `orders/{id}/orderItems/{itemId}` fields consumed by analytics */
export type DashboardOrderItemDoc = Pick<
  OrderItem,
  'productId' | 'productSnap' | 'qty' | 'lineTotal' | 'fifoCost'
> & {
  id: string;
  productSnap: ProductSnap;
};

/** Top-level `payments/{id}` fields consumed by analytics */
export type DashboardPaymentDoc = Pick<
  Payment,
  'orderId' | 'branchId' | 'method' | 'amount' | 'createdAt'
> & {
  id: string;
};

/** Branch stock row from `products/{id}/productStocks/{branchId}` */
export type DashboardStockDoc = {
  productId: string;
  name: string;
  qty: number;
  reorderPoint: number;
};

// ── Normalized pipeline rows ──────────────────────────────────────────────────

/** Flattened sale line — one row per order item with COGS for profit */
export type DashboardSaleLine = {
  orderId: string;
  createdAt: Date;
  productId: string;
  productName: string;
  category: string;
  customerName: string;
  revenue: number;
  /** True cost from `orderItems.fifoCost` recorded at sale time */
  cogs: number;
  qty: number;
  paymentMethod: PaymentMethod;
};

/** Payment slice supporting split-tender orders */
export type DashboardPaymentRecord = {
  orderId: string;
  method: PaymentMethod;
  amount: number;
  createdAt: Date;
};

export type StockMapEntry = {
  qty: number;
  reorderPoint: number;
  name: string;
};

// ── Aggregated UI models ──────────────────────────────────────────────────────

export type KpiMetrics = {
  revenue: number;
  profit: number;
  bills: number;
  margin: number;
  prevRevenue: number;
  prevProfit: number;
  prevBills: number;
};

export type TrendPoint = {
  label: string;
  revenue: number;
  profit: number;
};

export type CategorySlice = {
  category: string;
  revenue: number;
  color: string;
};

export type TopProductRow = {
  productId: string;
  name: string;
  category: string;
  revenue: number;
  profit: number;
};

export type TopCustomerRow = {
  name: string;
  revenue: number;
  bills: number;
};

export type PaymentChannelRow = {
  method: PaymentMethod;
  revenue: number;
  bills: number;
  pct: number;
  barWidth: number;
};

export type StockAlertRow = {
  productId: string;
  name: string;
  qty: number;
  reorderPoint: number;
  critical: boolean;
};

export type DashboardAggregates = {
  kpi: KpiMetrics;
  trendTitle: string;
  trend: TrendPoint[];
  categories: CategorySlice[];
  topProducts: TopProductRow[];
  topCustomers: TopCustomerRow[];
  payments: PaymentChannelRow[];
  stockAlerts: StockAlertRow[];
};

// ── Hook & aggregator signatures ──────────────────────────────────────────────

export type UseDashboardDataResult = {
  saleLines: DashboardSaleLine[];
  paymentRecords: DashboardPaymentRecord[];
  stockMap: Map<string, StockMapEntry>;
  loading: boolean;
  error: Error | null;
  now: Date;
  bounds: PeriodBounds | null;
};

export type AggregateDashboardParams = {
  period: DashboardPeriod;
  saleLines: DashboardSaleLine[];
  paymentRecords: DashboardPaymentRecord[];
  stockMap: Map<string, StockMapEntry>;
  now: Date;
  bounds: PeriodBounds;
};
