import type { StockReportProduct } from '../stockReport/types';
import type { StockLot } from '../types';
import { stockLotTimestampToDate } from './fifoQueueUtils';
import {
  computeExpiryAlert,
  DEFAULT_EXPIRY_POLICIES,
  resolveExpiryPolicy,
  type ExpiryAlertLevel,
  type ExpiryPolicy,
} from './expiryPolicyTypes';
import { normalizeStockLot } from './stockLotQueries';

export type FifoTableRow = {
  lot: StockLot;
  product: StockReportProduct;
  fifoIndex: number;
  alertLevel: ExpiryAlertLevel;
  daysLeft: number | null;
};

export type FifoExpiryFilter = '' | ExpiryAlertLevel;

export function safeLotRemaining(lot: StockLot | Record<string, unknown>): number {
  const raw = lot as Record<string, unknown>;
  const n = Number(raw.qtyRemaining ?? raw.remainingQty ?? 0);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export function normalizeFifoLot(lot: StockLot): StockLot {
  try {
    return normalizeStockLot(lot.id, lot as unknown as Record<string, unknown>);
  } catch {
    return {
      ...lot,
      qtyRemaining: safeLotRemaining(lot),
      qtyReceived: Number(lot.qtyReceived) || safeLotRemaining(lot),
    };
  }
}

export function safeLotReceivedIso(lot: StockLot): string | null {
  try {
    const d = stockLotTimestampToDate(lot.receivedAt);
    if (!d || !Number.isFinite(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

export function lotMatchesReceivedDateRange(
  lot: StockLot,
  from: string,
  to: string,
): boolean {
  if (!from && !to) return true;
  const iso = safeLotReceivedIso(lot);
  if (!iso) return true;
  return (!from || iso >= from) && (!to || iso <= to);
}

/** ทั้งหมด = never filter by alert level */
export function matchesFifoExpiryFilter(
  level: ExpiryAlertLevel,
  filter: FifoExpiryFilter,
): boolean {
  if (filter === '') return true;
  return level === filter;
}

export function safeComputeExpiryAlert(
  expiryValue: unknown,
  policies: ExpiryPolicy[],
  policyId?: string | null,
): { level: ExpiryAlertLevel; daysLeft: number | null } {
  try {
    const policyList =
      Array.isArray(policies) && policies.length > 0 ? policies : DEFAULT_EXPIRY_POLICIES;
    const policy = resolveExpiryPolicy(policyId, policyList);
    return computeExpiryAlert(expiryValue, policy);
  } catch {
    return { level: 'safe', daysLeft: null };
  }
}

function expirySortWeight(level: ExpiryAlertLevel): number {
  if (level === 'critical') return 0;
  if (level === 'warning') return 1;
  return 2;
}

function safeReceivedAtMs(lot: StockLot): number {
  try {
    const d = stockLotTimestampToDate(lot.receivedAt);
    return d && Number.isFinite(d.getTime()) ? d.getTime() : 0;
  } catch {
    return 0;
  }
}

export function countSystemActiveLots(products: StockReportProduct[]): number {
  let count = 0;
  for (const product of products) {
    for (const rawLot of product.lots ?? []) {
      try {
        const lot = normalizeFifoLot(rawLot);
        if (safeLotRemaining(lot) > 0) count += 1;
      } catch {
        /* skip bad lot */
      }
    }
  }
  return count;
}

export type BuildFifoTableRowsInput = {
  products: StockReportProduct[];
  policies: ExpiryPolicy[];
  search: string;
  category: string;
  pickedProductIds: Set<string>;
  receivedFrom: string;
  receivedTo: string;
  expiryFilter: FifoExpiryFilter;
};

/** Build FIFO rows — each lot is isolated; one bad record cannot empty the table */
export function buildFifoTableRows(input: BuildFifoTableRowsInput): FifoTableRow[] {
  const {
    products,
    policies,
    search,
    category,
    pickedProductIds,
    receivedFrom,
    receivedTo,
    expiryFilter,
  } = input;

  const q = search.trim().toLowerCase();
  const rows: FifoTableRow[] = [];

  for (const product of products) {
    if (!product) continue;

    try {
      const nameSku = `${product.name ?? ''}${product.sku ?? ''}`.toLowerCase();
      if (category && product.category !== category) continue;
      if (q && !nameSku.includes(q)) continue;
      if (pickedProductIds.size > 0 && !pickedProductIds.has(product.id)) continue;

      const normalizedLots: StockLot[] = [];
      for (const rawLot of product.lots ?? []) {
        try {
          const lot = normalizeFifoLot(rawLot);
          if (safeLotRemaining(lot) <= 0) continue;
          if (!lotMatchesReceivedDateRange(lot, receivedFrom, receivedTo)) continue;
          normalizedLots.push(lot);
        } catch (err) {
          console.warn('[FIFO] skipped lot during normalize', product.id, err);
        }
      }

      normalizedLots.sort((a, b) => safeReceivedAtMs(a) - safeReceivedAtMs(b));

      normalizedLots.forEach((lot, index) => {
        try {
          const { level, daysLeft } = safeComputeExpiryAlert(
            lot.expiryDate,
            policies,
            product.expiryPolicyId,
          );

          if (!matchesFifoExpiryFilter(level, expiryFilter)) return;

          rows.push({
            lot,
            product,
            fifoIndex: index + 1,
            alertLevel: level,
            daysLeft,
          });
        } catch (err) {
          console.warn('[FIFO] skipped lot during alert calc', lot.id, err);
          if (expiryFilter === '' || expiryFilter === 'safe') {
            rows.push({
              lot,
              product,
              fifoIndex: index + 1,
              alertLevel: 'safe',
              daysLeft: null,
            });
          }
        }
      });
    } catch (err) {
      console.warn('[FIFO] skipped product', product.id, err);
    }
  }

  return rows.sort((a, b) => {
    const aw = expirySortWeight(a.alertLevel);
    const bw = expirySortWeight(b.alertLevel);
    if (aw !== bw) return aw - bw;
    const ad = a.daysLeft ?? Number.MAX_SAFE_INTEGER;
    const bd = b.daysLeft ?? Number.MAX_SAFE_INTEGER;
    if (ad !== bd) return ad - bd;
    return safeReceivedAtMs(a.lot) - safeReceivedAtMs(b.lot);
  });
}

export function fifoHasActiveToolbarFilters(input: {
  search: string;
  category: string;
  pickedProductIds: Set<string>;
  receivedFrom: string;
  receivedTo: string;
  expiryFilter: FifoExpiryFilter;
}): boolean {
  return (
    !!input.category ||
    !!input.search.trim() ||
    input.pickedProductIds.size > 0 ||
    !!input.receivedFrom ||
    !!input.receivedTo ||
    input.expiryFilter !== ''
  );
}
