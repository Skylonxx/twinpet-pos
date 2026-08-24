import type { AsyncOrder, OrderStatus, ReconcileStatus } from '../types';
import type { PosProduct, StockTruth } from './types';
import { UNKNOWN_STOCK_TRUTH } from './types';

export type EligibleLocalSaleSnap = {
  productIds: string[];
};

export type RetirementClassification = {
  /** Genuine atomic decrement + settled — the only outcome that raises a refresh. */
  normalSettlement: string[];
  /** Exception, voidRequested, tombstone, missing doc, or other non-proof exits. */
  other: string[];
  /** Product ids from normal-settlement retirements only (for retirement taint). */
  affectedProductIds: string[];
};

function lineProductId(line: AsyncOrder['lines'][number]): string | null {
  const productId = line.productId;
  if (typeof productId !== 'string' || productId.length === 0) return null;
  return productId;
}

function lineQtyBase(line: AsyncOrder['lines'][number]): number | null {
  const qtyBase = line.qtyBase;
  if (typeof qtyBase !== 'number' || !Number.isFinite(qtyBase) || qtyBase <= 0) return null;
  return qtyBase;
}

function validLineProductIds(order: AsyncOrder): string[] {
  const ids: string[] = [];
  for (const line of order.lines ?? []) {
    const productId = lineProductId(line);
    if (!productId) continue;
    if (lineQtyBase(line) == null) continue;
    ids.push(productId);
  }
  return ids;
}

/**
 * Eligibility: this terminal's still-pending, non-voided sale.
 * `voidRequested` / `voided` / non-`pending_reconcile` are excluded immediately.
 */
export function isEligibleLocalSale(order: AsyncOrder): boolean {
  if (order.status === 'voided') return false;
  if (order.voidRequested === true) return false;
  if (order.reconcileStatus !== 'pending_reconcile') return false;
  return true;
}

/**
 * Pure productId → summed qtyBase selector. Caller supplies pre-scoped orders
 * (branch+device query). Malformed lines are skipped per-line.
 */
export function selectLocalSalesDelta(orders: readonly AsyncOrder[]): Map<string, number> {
  const delta = new Map<string, number>();
  for (const order of orders) {
    if (!isEligibleLocalSale(order)) continue;
    for (const line of order.lines ?? []) {
      const productId = lineProductId(line);
      if (!productId) continue;
      const qtyBase = lineQtyBase(line);
      if (qtyBase == null) continue;
      delta.set(productId, (delta.get(productId) ?? 0) + qtyBase);
    }
  }
  return delta;
}

export function eligibleSnapshotFromOrders(
  orders: readonly AsyncOrder[],
): Map<string, EligibleLocalSaleSnap> {
  const next = new Map<string, EligibleLocalSaleSnap>();
  for (const order of orders) {
    if (!isEligibleLocalSale(order)) continue;
    next.set(order.id, { productIds: validLineProductIds(order) });
  }
  return next;
}

/**
 * Diff previous-eligible vs current orders. Voided / voidRequested are classified
 * BEFORE `reconcileStatus === 'settled'` so a pending-void tombstone is never
 * misread as stock-catch-up proof.
 */
export function classifyLocalSaleRetirements(
  previousEligible: ReadonlyMap<string, EligibleLocalSaleSnap>,
  currentOrders: readonly AsyncOrder[],
): RetirementClassification {
  const currentById = new Map(currentOrders.map((order) => [order.id, order]));
  const currentEligible = new Set(
    currentOrders.filter(isEligibleLocalSale).map((order) => order.id),
  );
  const normalSettlement: string[] = [];
  const other: string[] = [];
  const affectedProductIds: string[] = [];

  for (const [id, prev] of previousEligible) {
    if (currentEligible.has(id)) continue;
    const order = currentById.get(id);
    if (!order) {
      other.push(id);
      continue;
    }
    if (order.voidRequested === true || order.status === 'voided') {
      other.push(id);
      continue;
    }
    if (order.reconcileStatus === 'exception') {
      other.push(id);
      continue;
    }
    if (order.reconcileStatus === 'settled') {
      normalSettlement.push(id);
      affectedProductIds.push(...prev.productIds);
      continue;
    }
    other.push(id);
  }

  return { normalSettlement, other, affectedProductIds };
}

function withLocalDeltaApplied(truth: StockTruth): StockTruth {
  if (truth.state !== 'known') return truth;
  if (truth.localDeltaApplied) return truth;
  return { ...truth, localDeltaApplied: true };
}

const TAINT_TRUTH: StockTruth = { state: 'known', asOf: 'cache', localDeltaApplied: false };

/**
 * Fold local-sales qty into POS products. An overlay may change the numeric stock;
 * it may never upgrade `unknown` → `known`. Retirement taint forces known products
 * to non-current cache provenance until the next accepted-current snapshot apply.
 */
export function applyLocalSalesDeltaToProducts(
  products: readonly PosProduct[],
  delta: ReadonlyMap<string, number>,
  taintProductIds?: ReadonlySet<string>,
): PosProduct[] {
  let changed = false;
  const next = products.map((product) => {
    const sold = delta.get(product.id) ?? 0;
    let stock = product.stock;
    let stockTruth = product.stockTruth;
    if (sold > 0) {
      stock = stock - sold;
      stockTruth = withLocalDeltaApplied(stockTruth);
    }
    if (taintProductIds?.has(product.id) && stockTruth.state === 'known') {
      stockTruth = TAINT_TRUTH;
    }
    if (stock === product.stock && stockTruth === product.stockTruth) return product;
    changed = true;
    return { ...product, stock, stockTruth };
  });
  return changed ? next : (products as PosProduct[]);
}

/** Test/helper: carry unknown through a reversal-style numeric overlay. */
export function overlayNumericStock(
  stock: number,
  stockTruth: StockTruth | undefined,
  delta: number,
): { stock: number; stockTruth: StockTruth } {
  return {
    stock: stock + delta,
    stockTruth: stockTruth ?? UNKNOWN_STOCK_TRUTH,
  };
}

export type { OrderStatus, ReconcileStatus };
