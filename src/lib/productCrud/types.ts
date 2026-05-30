import type { Product, ProductPrice, StockLot, StockMovement, UomConversion, ProductCategory } from '../types';
import { matchesCategoryFilter } from '../inventory/categoryService';

export type StockFilter = '' | 'low' | 'out';

export type DrawerTab = 'info' | 'pricing' | 'stock' | 'history';

export const DRAWER_TABS: { id: DrawerTab; label: string }[] = [
  { id: 'info', label: 'ข้อมูลสินค้า' },
  { id: 'pricing', label: 'หน่วยย่อย & ราคาส่ง' },
  { id: 'stock', label: 'สต็อก' },
  { id: 'history', label: 'ประวัติ' },
];

export type PriceTierDef = {
  id: string;
  name: string;
  color: string;
};

export const PRICE_TIERS: PriceTierDef[] = [
  { id: 'RETAIL', name: 'ราคาปกติ', color: '#534AB7' },
  { id: 'WHOLESALE1', name: 'VIP', color: '#1D9E75' },
  { id: 'WHOLESALE2', name: 'ราคาส่ง', color: '#BA7517' },
  { id: 'MEMBER', name: 'สมาชิก Gold', color: '#D4537E' },
];

export const CATEGORIES = [
  'อาหารสัตว์',
  'ทรีทและขนม',
  'ของเล่น',
  'กรายแมว',
  'ผลิตภัณฑ์ดูแล',
] as const;

export const CATEGORY_STYLE: Record<string, { background: string; color: string }> = {
  'อาหารสัตว์': { background: '#E1F5EE', color: '#085041' },
  'ทรีทและขนม': { background: '#FAEEDA', color: '#633806' },
  'ของเล่น': { background: '#FAECE7', color: '#993C1D' },
  'กรายแมว': { background: '#F1EFE8', color: '#444441' },
  'ผลิตภัณฑ์ดูแล': { background: '#FBEAF0', color: '#72243E' },
};

export const CATEGORY_EMOJI: Record<string, string> = {
  'อาหารสัตว์': '🐾',
  'ทรีทและขนม': '🍪',
  'ของเล่น': '🧸',
  'กรายแมว': '🪣',
  'ผลิตภัณฑ์ดูแล': '💊',
};

export type ProductUomFormRow = {
  id: string;
  unit: string;
  factor: number;
  barcode: string;
  prices: Record<string, number>;
  /** Tier prices for this UOM unit (non-base rows only in Firestore) */
  tierPrices: Record<string, number>;
  expanded: boolean;
  isBase: boolean;
};

export type ProductFormData = {
  name: string;
  sku: string;
  barcode: string;
  imageUrl: string;
  /** Selected category id from settings */
  categoryId: string;
  category: string;
  description: string;
  baseUnit: string;
  hasUom: boolean;
  isActive: boolean;
  reorderPoint: number;
  /** Manual standard/base cost (maps to Product.cost) */
  cost: number;
  /** HQ master/central price ราคากลาง — visible to all, editable by admin/manager only */
  basePrice: number;
  simplePrices: Record<string, number>;
  /** CRM dynamic tier prices (base unit) — keys match customer.customerType */
  tierPrices: Record<string, number>;
  allowNegativeStock: boolean;
  /** Expiry alert policy id — empty uses system default */
  expiryPolicyId: string;
  uomRows: ProductUomFormRow[];
};

export type ProductFormFieldErrors = Partial<
  Record<'name' | 'categoryId' | 'unit' | 'price' | 'cost', string>
>;

const REQUIRED_FIELD_MSG = 'กรุณาระบุข้อมูล';

export type ProductListItem = Product & {
  stock: number;
  branchReorderPoint: number;
  emoji: string;
  retailPrice: number;
};

export type FifoLotRow = StockLot & {
  fifoOrder: number | null;
  isNext: boolean;
  grnLabel: string;
};

export function fmtBaht(n: number): string {
  return parseFloat(String(n || 0)).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function sanitizeProductForm(
  form: ProductFormData,
  categories: ProductCategory[] = [],
): ProductFormData {
  const categoryId = form.categoryId.trim();
  const category =
    categories.find((c) => c.id === categoryId)?.name ?? form.category.trim();
  const sku = form.sku.trim();
  const barcode = form.barcode.trim();
  const cost = Number.isFinite(form.cost) ? Math.max(0, form.cost) : 0;
  const basePrice = Number.isFinite(form.basePrice) ? Math.max(0, form.basePrice) : 0;
  const retail = Math.max(0, resolveRetailPrice(form) || 0);

  const simplePrices = {
    ...form.simplePrices,
    RETAIL: form.hasUom ? form.simplePrices.RETAIL : retail,
  };

  const uomRows = form.uomRows.map((row) => ({
    ...row,
    prices: {
      ...row.prices,
      RETAIL:
        row.isBase && form.hasUom
          ? Math.max(0, row.prices.RETAIL ?? 0)
          : row.prices.RETAIL,
    },
  }));

  return {
    ...form,
    name: form.name.trim(),
    sku,
    barcode,
    categoryId,
    category,
    baseUnit: form.baseUnit.trim() || 'ชิ้น',
    cost,
    basePrice,
    simplePrices,
    uomRows,
    reorderPoint: Number.isFinite(form.reorderPoint) ? Math.max(0, form.reorderPoint) : 0,
  };
}

function resolveRetailPrice(form: ProductFormData): number {
  const main = form.simplePrices.RETAIL;
  if (main != null && Number.isFinite(main)) return main;
  if (form.hasUom) {
    const baseRow = form.uomRows.find((r) => r.isBase);
    return baseRow?.prices.RETAIL ?? Number.NaN;
  }
  return Number.NaN;
}

export function validateProductForm(form: ProductFormData): ProductFormFieldErrors {
  const errors: ProductFormFieldErrors = {};

  if (!form.name.trim()) errors.name = REQUIRED_FIELD_MSG;
  if (!form.categoryId.trim() && !form.category.trim()) errors.categoryId = REQUIRED_FIELD_MSG;
  if (!form.baseUnit.trim()) errors.unit = REQUIRED_FIELD_MSG;

  if (form.hasUom) {
    const subs = form.uomRows.filter((r) => !r.isBase);
    if (subs.length === 0) {
      errors.unit = 'กรุณาเพิ่มอย่างน้อย 1 หน่วยย่อย';
    }
    const missingSubUnit = subs.some((r) => !r.unit.trim());
    if (missingSubUnit) errors.unit = REQUIRED_FIELD_MSG;
    const badFactor = subs.some((r) => !Number.isFinite(r.factor) || r.factor <= 0);
    if (badFactor) errors.unit = 'ตัวคูณต้องมากกว่า 0';
    const seen = new Set<string>();
    for (const r of subs) {
      const name = r.unit.trim();
      if (!name) continue;
      if (name === form.baseUnit.trim()) {
        errors.unit = 'หน่วยย่อยต้องไม่ซ้ำกับหน่วยฐาน';
        break;
      }
      if (seen.has(name)) {
        errors.unit = 'หน่วยย่อยซ้ำกัน';
        break;
      }
      seen.add(name);
    }
  }

  const retailPrice = resolveRetailPrice(form);
  if (retailPrice == null || !Number.isFinite(retailPrice) || retailPrice < 0) {
    errors.price = REQUIRED_FIELD_MSG;
  }

  const cost = form.cost;
  if (!Number.isFinite(cost) || cost < 0) {
    errors.cost = REQUIRED_FIELD_MSG;
  }

  return errors;
}

/** Greedy UOM breakdown — largest factor first, remainder in base unit */
export function formatUomBreakdown(
  totalBase: number,
  uomRows: ProductUomFormRow[],
): string | null {
  const largerUnits = uomRows
    .filter((r) => !r.isBase && r.factor > 0)
    .sort((a, b) => b.factor - a.factor);

  if (largerUnits.length === 0) return null;

  let remaining = totalBase;
  const parts: string[] = [];

  for (const u of largerUnits) {
    const count = Math.floor(remaining / u.factor);
    if (count > 0) {
      parts.push(`${count} ${u.unit}`);
      remaining -= count * u.factor;
    }
  }

  const baseUnit = uomRows.find((r) => r.isBase)?.unit ?? 'ชิ้น';
  if (remaining > 0) {
    parts.push(`${remaining} ${baseUnit}`);
  }

  return parts.length > 0 ? parts.join(' ') : null;
}

export function stockStatus(stock: number, minStock: number): { cls: string; lbl: string } {
  if (stock === 0) return { cls: 'pc-stock-out', lbl: 'หมด' };
  if (stock <= minStock) return { cls: 'pc-stock-low', lbl: `${stock} ⚠` };
  return { cls: 'pc-stock-ok', lbl: String(stock) };
}

export function getRetailPrice(product: Product): number {
  return (
    product.prices.find((p) => p.priceLevelId === 'RETAIL' && p.unit === product.baseUnit)?.price ??
    product.prices[0]?.price ??
    0
  );
}

export function sanitizeTierPrices(
  tierPrices: Record<string, number>,
): Record<string, number> | undefined {
  const cleaned: Record<string, number> = {};
  for (const [key, val] of Object.entries(tierPrices)) {
    const k = key.trim();
    if (!k || !Number.isFinite(val) || val <= 0) continue;
    cleaned[k] = val;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export function emptyForm(): ProductFormData {
  return {
    name: '',
    sku: '',
    barcode: '',
    imageUrl: '',
    categoryId: '',
    category: '',
    description: '',
    baseUnit: 'ชิ้น',
    hasUom: false,
    isActive: true,
    reorderPoint: 10,
    cost: 0,
    basePrice: 0,
    simplePrices: { RETAIL: 0 },
    tierPrices: {},
    allowNegativeStock: false,
    expiryPolicyId: '',
    uomRows: [
      {
        id: 'base',
        unit: 'ชิ้น',
        factor: 1,
        barcode: '',
        prices: { RETAIL: 0 },
        tierPrices: {},
        expanded: true,
        isBase: true,
      },
    ],
  };
}

export function productToForm(product: Product): ProductFormData {
  const hasUom = product.uomConversions.length > 0;
  const retailPrice =
    product.prices.find((x) => x.priceLevelId === 'RETAIL' && x.unit === product.baseUnit)?.price ??
    product.prices.find((x) => x.unit === product.baseUnit)?.price ??
    0;
  const simplePrices: Record<string, number> = { RETAIL: retailPrice };

  const baseRow: ProductUomFormRow = {
    id: 'base',
    unit: product.baseUnit,
    factor: 1,
    barcode: product.barcode ?? '',
    prices: { ...simplePrices },
    tierPrices: { ...(product.tierPrices ?? {}) },
    expanded: true,
    isBase: true,
  };

  const uomRows: ProductUomFormRow[] = [baseRow];
  for (const conv of product.uomConversions) {
    const unitRetail =
      product.prices.find((x) => x.priceLevelId === 'RETAIL' && x.unit === conv.unit)?.price ??
      product.prices.find((x) => x.unit === conv.unit)?.price ??
      0;
    uomRows.push({
      id: `uom-${conv.unit}`,
      unit: conv.unit,
      factor: conv.factor,
      barcode: conv.barcode ?? '',
      prices: { RETAIL: unitRetail },
      tierPrices: { ...(conv.tierPrices ?? {}) },
      expanded: true,
      isBase: false,
    });
  }

  return {
    name: product.name,
    sku: product.sku ?? '',
    barcode: product.barcode ?? '',
    imageUrl: product.imageUrl ?? '',
    categoryId: '',
    category: product.category,
    description: product.description,
    baseUnit: product.baseUnit,
    hasUom,
    isActive: product.isActive,
    reorderPoint: product.reorderPoint,
    cost: product.cost ?? product.avgCost ?? 0,
    basePrice: product.basePrice ?? 0,
    simplePrices,
    tierPrices: { ...(product.tierPrices ?? {}) },
    allowNegativeStock: product.allowNegativeStock ?? false,
    expiryPolicyId: product.expiryPolicyId ?? '',
    uomRows,
  };
}

export function formToProduct(form: ProductFormData, id: string): Omit<Product, 'createdAt' | 'updatedAt' | 'deletedAt' | 'avgCost'> {
  const uomConversions: UomConversion[] = form.hasUom
    ? form.uomRows
        .filter((r) => !r.isBase && r.unit.trim() && Number.isFinite(r.factor) && r.factor > 0)
        .map((r) => {
          const conv: UomConversion = {
            unit: r.unit.trim(),
            factor: r.factor,
          };
          if (r.barcode.trim()) conv.barcode = r.barcode.trim();
          const uomTiers = sanitizeTierPrices(r.tierPrices ?? {});
          if (uomTiers) conv.tierPrices = uomTiers;
          return conv;
        })
    : [];

  const prices: ProductPrice[] = [];
  const pushRetailPrice = (unit: string, price: number | undefined) => {
    if (price != null && price > 0) {
      prices.push({ priceLevelId: 'RETAIL', unit, price });
    }
  };

  if (form.hasUom) {
    for (const row of form.uomRows) {
      pushRetailPrice(row.unit, row.prices.RETAIL);
    }
  } else {
    pushRetailPrice(form.baseUnit, form.simplePrices.RETAIL);
  }

  const productTierPrices = sanitizeTierPrices(form.tierPrices);

  const base: Omit<Product, 'createdAt' | 'updatedAt' | 'deletedAt' | 'avgCost'> = {
    id,
    name: form.name.trim(),
    sku: form.sku.trim(),
    barcode: form.barcode.trim() || null,
    category: form.category,
    description: form.description,
    imageUrl: form.imageUrl.trim() || null,
    baseUnit: form.baseUnit,
    uomConversions,
    prices,
    allowNegativeStock: form.allowNegativeStock,
    reorderPoint: form.reorderPoint,
    cost: Number.isFinite(form.cost) ? Math.max(0, form.cost) : 0,
    basePrice: Number.isFinite(form.basePrice) && form.basePrice > 0 ? form.basePrice : undefined,
    isActive: form.isActive,
  };

  if (form.expiryPolicyId.trim()) {
    base.expiryPolicyId = form.expiryPolicyId.trim();
  }

  if (productTierPrices) {
    base.tierPrices = productTierPrices;
  }

  return base;
}

export function filterProducts(
  items: ProductListItem[],
  search: string,
  categoryFilterId: string,
  stockFilter: StockFilter,
  categories: ProductCategory[] = [],
): ProductListItem[] {
  const q = search.trim().toLowerCase();
  return items.filter((p) => {
    const matchQ =
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.sku.toLowerCase().includes(q) ||
      (p.barcode ?? '').toLowerCase().includes(q) ||
      p.uomConversions.some(
        (uom) => uom.barcode && uom.barcode.toLowerCase().includes(q),
      );
    const matchCat = matchesCategoryFilter(p.category, categoryFilterId, categories);
    const matchStock =
      !stockFilter ||
      (stockFilter === 'low' && p.stock > 0 && p.stock <= p.branchReorderPoint) ||
      (stockFilter === 'out' && p.stock === 0);
    return matchQ && matchCat && matchStock;
  });
}

export type StockHistoryRow = {
  date: string;
  type: string;
  qty: number;
  balance: number;
  by: string;
};

export function movementLabel(type: StockMovement['type']): string {
  const map: Record<StockMovement['type'], string> = {
    sale: 'ขาย',
    receive: 'รับเข้า',
    adjust: 'ปรับยอด',
    transfer_in: 'โอนเข้า',
    transfer_out: 'โอนออก',
    void: 'คืนสต็อก',
  };
  return map[type] ?? type;
}
