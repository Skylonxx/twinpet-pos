import type { PosProduct } from '../pos/types';
import type { Product } from '../types';
import type { ProductListItem } from '../productCrud/types';

export type ReceivingLine = {
  lineKey: string;
  productId: string;
  productName: string;
  sku: string;
  hasVat: boolean;
  unit: string;
  unitFactor: number;
  qty: number;
  costPerUnit: number;
  itemDiscount: number;
  hasExpiry: boolean;
  expiryDate: string;
};

export type ConfirmReceivingInput = {
  branchId: string;
  staffId: string;
  staffName: string;
  supplierId: string | null;
  supplierName: string;
  note: string;
  finalDiscount: number;
  lines: ReceivingLine[];
  /** Finalize an existing draft GRN (uses this id instead of generating a new one) */
  receivingId?: string;
};

export function productHasVat(product: Pick<Product, 'hasVat'> | null | undefined): boolean {
  return product?.hasVat !== false;
}

export function clampMoney(n: number): number {
  return Math.max(0, n);
}

export function lineGross(line: ReceivingLine): number {
  return line.qty * line.costPerUnit;
}

export function maxItemDiscount(line: ReceivingLine): number {
  return lineGross(line);
}

export function emptyLineFromProduct(product: PosProduct, hasVat = true): ReceivingLine {
  const uom = product.uomOptions[0]!;
  return {
    lineKey: `${product.id}-${Date.now()}`,
    productId: product.id,
    productName: product.name,
    sku: product.sku,
    hasVat,
    unit: uom.unit,
    unitFactor: uom.factor,
    qty: 1,
    costPerUnit: 0,
    itemDiscount: 0,
    hasExpiry: false,
    expiryDate: '',
  };
}

export function emptyLineFromProductListItem(product: ProductListItem): ReceivingLine {
  const unit = product.baseUnit;
  const factor = 1;
  return {
    lineKey: `${product.id}-${Date.now()}`,
    productId: product.id,
    productName: product.name,
    sku: product.sku,
    hasVat: productHasVat(product),
    unit,
    unitFactor: factor,
    qty: 1,
    costPerUnit: (product.cost ?? product.avgCost ?? 0) * factor,
    itemDiscount: 0,
    hasExpiry: false,
    expiryDate: '',
  };
}

export function productListItemToPosProduct(product: ProductListItem): PosProduct {
  const uomOptions = [
    { unit: product.baseUnit, factor: 1, price: product.retailPrice },
    ...product.uomConversions.map((c) => {
      const price =
        product.prices.find((p) => p.unit === c.unit && p.priceLevelId === 'RETAIL')?.price ??
        product.retailPrice * c.factor;
      return { unit: c.unit, factor: c.factor, price };
    }),
  ];
  const unique = new Map<string, (typeof uomOptions)[0]>();
  for (const o of uomOptions) unique.set(o.unit, o);
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode ?? null,
    category: product.category,
    emoji: product.emoji,
    imageUrl: product.imageUrl ?? null,
    stock: product.stock,
    baseUnit: product.baseUnit,
    uomOptions: [...unique.values()],
  };
}

export function uomOptionsForProduct(product: ProductListItem) {
  return productListItemToPosProduct(product).uomOptions;
}

export function lineQtyBase(line: ReceivingLine): number {
  return line.qty * line.unitFactor;
}

export function lineCostBase(line: ReceivingLine): number {
  if (line.unitFactor <= 0) return line.costPerUnit;
  return line.costPerUnit / line.unitFactor;
}

export function lineSubtotal(line: ReceivingLine): number {
  return clampMoney(lineGross(line) - (line.itemDiscount || 0));
}

export function receivingSubtotal(lines: ReceivingLine[]): number {
  return lines.reduce((s, l) => s + lineSubtotal(l), 0);
}

export function receivingGrandTotal(lines: ReceivingLine[], finalDiscount: number): number {
  return clampMoney(receivingSubtotal(lines) - finalDiscount);
}

export function computeNewAvgCost(
  currentStock: number,
  currentAvgCost: number,
  qtyBase: number,
  costBase: number,
): number {
  const newStock = currentStock + qtyBase;
  if (newStock <= 0) return costBase;
  return (Math.max(0, currentStock) * currentAvgCost + qtyBase * costBase) / newStock;
}

export const CATEGORY_TYPE_TAG: Record<string, string> = {
  'อาหารสัตว์': 'type-food',
  'ทรีทและขนม': 'type-treat',
  'ของเล่น': 'type-toy',
  'กรายแมว': 'type-litter',
  'ผลิตภัณฑ์ดูแล': 'type-supp',
  'อาหารเสริมสัตว์': 'type-supp',
};

export function fmtMoney(n: number): string {
  return parseFloat(String(n || 0)).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function generateGrnId(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const suffix = String(Math.floor(Math.random() * 9000) + 1000);
  return `GRN-${y}${m}${day}-${suffix}`;
}
