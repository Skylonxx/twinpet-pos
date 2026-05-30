import type { StockReportProduct } from './types';

export type SortDirection = 'asc' | 'desc';

export type StockProductSortKey =
  | 'name'
  | 'sku'
  | 'qty'
  | 'stockValue'
  | 'avgCost'
  | 'cogs'
  | 'category';

export type LowStockSortKey = 'name' | 'sku' | 'qty' | 'reorderPoint' | 'avgCost' | 'stockValue';

export function sortStockProducts<T extends StockReportProduct>(
  list: T[],
  key: StockProductSortKey,
  direction: SortDirection,
): T[] {
  const mult = direction === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    let av: string | number;
    let bv: string | number;
    switch (key) {
      case 'name':
        av = a.name.toLowerCase();
        bv = b.name.toLowerCase();
        break;
      case 'sku':
        av = a.sku.toLowerCase();
        bv = b.sku.toLowerCase();
        break;
      case 'qty':
        av = a.qty;
        bv = b.qty;
        break;
      case 'stockValue':
        av = a.stockValue;
        bv = b.stockValue;
        break;
      case 'avgCost':
        av = a.avgCost;
        bv = b.avgCost;
        break;
      case 'cogs':
        av = a.cogsMonth;
        bv = b.cogsMonth;
        break;
      case 'category':
        av = a.category.toLowerCase();
        bv = b.category.toLowerCase();
        break;
      default:
        return 0;
    }
    if (av < bv) return -1 * mult;
    if (av > bv) return 1 * mult;
    return 0;
  });
}

export function sortLowStockProducts(
  list: StockReportProduct[],
  key: LowStockSortKey,
  direction: SortDirection,
): StockReportProduct[] {
  const mult = direction === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    let av: string | number;
    let bv: string | number;
    switch (key) {
      case 'name':
        av = a.name.toLowerCase();
        bv = b.name.toLowerCase();
        break;
      case 'sku':
        av = a.sku.toLowerCase();
        bv = b.sku.toLowerCase();
        break;
      case 'qty':
        av = a.qty;
        bv = b.qty;
        break;
      case 'reorderPoint':
        av = a.reorderPoint;
        bv = b.reorderPoint;
        break;
      case 'avgCost':
        av = a.avgCost;
        bv = b.avgCost;
        break;
      case 'stockValue':
        av = a.stockValue;
        bv = b.stockValue;
        break;
      default:
        return 0;
    }
    if (av < bv) return -1 * mult;
    if (av > bv) return 1 * mult;
    return 0;
  });
}
