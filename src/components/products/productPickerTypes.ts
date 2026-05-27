import type { CSSProperties } from 'react';
import type { PosProduct } from '../../lib/pos/types';
import { CATEGORY_EMOJI, CATEGORY_STYLE } from '../../lib/productCrud/types';
import type { ProductListItem } from '../../lib/productCrud/types';

export type ProductPickerSearchType = 'name' | 'sku' | 'barcode' | 'cat';

export type ProductPickerItem = {
  id: string;
  name: string;
  sku: string;
  barcode: string;
  category: string;
  emoji: string;
  stock: number;
  /** Barcodes on alternate UOM units (for picker search) */
  uomBarcodes: string[];
};

const CATEGORY_CLASS: Record<string, string> = {
  'อาหารสัตว์': 'cat-food',
  'ทรีทและขนม': 'cat-treat',
  'ของเล่น': 'cat-toy',
  'กรายแมว': 'cat-litter',
  'อาหารเสริมสัตว์': 'cat-supp',
  'ผลิตภัณฑ์ดูแล': 'cat-supp',
};

export function categoryBadgeClass(category: string): string {
  return CATEGORY_CLASS[category] ?? 'cat-other';
}

export function categoryBadgeStyle(category: string): CSSProperties | undefined {
  if (CATEGORY_CLASS[category]) return undefined;
  const style = CATEGORY_STYLE[category];
  if (!style) return undefined;
  return { background: style.background, color: style.color };
}

export function stockClass(stock: number): string {
  if (stock < 0) return 'stock-neg';
  if (stock === 0) return 'stock-zero';
  return 'stock-pos';
}

export function productListItemToPickerItem(product: ProductListItem): ProductPickerItem {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode ?? '—',
    category: product.category,
    emoji: product.emoji || CATEGORY_EMOJI[product.category] || '📦',
    stock: product.stock,
    uomBarcodes: product.uomConversions
      .map((u) => u.barcode?.trim())
      .filter((b): b is string => Boolean(b)),
  };
}

export function posProductToPickerItem(product: PosProduct & { barcode?: string | null }): ProductPickerItem {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode ?? '—',
    category: product.category,
    emoji: product.emoji || CATEGORY_EMOJI[product.category] || '📦',
    stock: product.stock,
    uomBarcodes: [],
  };
}

function matchesPickerSearch(p: ProductPickerItem, q: string): boolean {
  const term = q.toLowerCase();
  const mainBarcode = p.barcode !== '—' ? p.barcode : '';
  return (
    p.name.toLowerCase().includes(term) ||
    p.sku.toLowerCase().includes(term) ||
    mainBarcode.toLowerCase().includes(term) ||
    p.uomBarcodes.some((b) => b.toLowerCase().includes(term))
  );
}

export function filterPickerProducts(
  products: ProductPickerItem[],
  type: ProductPickerSearchType,
  query: string,
): ProductPickerItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return products;

  return products.filter((p) => {
    switch (type) {
      case 'name':
        return p.name.toLowerCase().includes(q);
      case 'sku':
        return p.sku.toLowerCase().includes(q);
      case 'barcode': {
        const mainBarcode = p.barcode !== '—' ? p.barcode : '';
        return (
          mainBarcode.toLowerCase().includes(q) ||
          p.uomBarcodes.some((b) => b.toLowerCase().includes(q))
        );
      }
      case 'cat':
        return p.category.toLowerCase().includes(q);
      default:
        return matchesPickerSearch(p, q);
    }
  });
}

export const PICKER_PAGE_SIZE = 25;

export function buildPageNumbers(page: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  if (page <= 4) {
    return [1, 2, 3, 4, 5, '…', totalPages];
  }
  if (page >= totalPages - 3) {
    return [1, '…', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, '…', page - 1, page, page + 1, '…', totalPages];
}
