import type { StockTruth } from './types';

/** Human-facing placeholder when stock truth is unknown. Never a fabricated number. */
export const UNKNOWN_STOCK_LABEL = 'สต็อกไม่ทราบ';

/**
 * The single sanctioned place a `(stock, stockTruth)` pair becomes human-facing text.
 * Unknown never emits the bare numeric fallback. Locale/unit formatting stays with the caller.
 */
export function formatStockTruth(stockTruth: StockTruth, stock: number): string {
  if (stockTruth.state === 'unknown') return UNKNOWN_STOCK_LABEL;
  return String(stock);
}
