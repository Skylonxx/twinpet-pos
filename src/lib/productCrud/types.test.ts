import { describe, expect, test } from 'vitest';
import { formToProduct, validateProductForm, type ProductFormData, type ProductUomFormRow } from './types';

function row(over: Partial<ProductUomFormRow> & Pick<ProductUomFormRow, 'id' | 'unit' | 'isBase'>): ProductUomFormRow {
  return {
    factor: 1,
    barcode: '',
    prices: {},
    tierPrices: {},
    expanded: false,
    ...over,
  };
}

function form(over: Partial<ProductFormData> = {}): ProductFormData {
  return {
    name: 'Food',
    sku: 'SKU1',
    barcode: '',
    imageUrl: '',
    categoryId: 'cat1',
    category: 'อาหารสัตว์',
    description: '',
    baseUnit: 'ชิ้น',
    hasUom: true,
    isActive: true,
    isBestSeller: false,
    muteAlerts: false,
    reorderPoint: 0,
    cost: 10,
    basePrice: 100,
    simplePrices: { retail: 100 },
    tierPrices: {},
    overrideTierPrices: {},
    availableBranches: [],
    allowNegativeStock: false,
    warnOnOversell: true,
    expiryPolicyId: '',
    uomRows: [
      row({ id: 'base', unit: 'ชิ้น', isBase: true, factor: 1 }),
      row({ id: 'pack', unit: 'ลัง', isBase: false, factor: 12 }),
    ],
    ...over,
  };
}

describe('G31 Product CRUD unitFactor producer boundary', () => {
  test('G31 badFactor when factor is non-finite or <= 0; persist drops factor<=0', () => {
    const zero = validateProductForm(form({
      uomRows: [
        row({ id: 'base', unit: 'ชิ้น', isBase: true, factor: 1 }),
        row({ id: 'pack', unit: 'ลัง', isBase: false, factor: 0 }),
      ],
    }));
    expect(zero.unit).toBe('ตัวคูณต้องมากกว่า 0');

    const neg = validateProductForm(form({
      uomRows: [
        row({ id: 'base', unit: 'ชิ้น', isBase: true, factor: 1 }),
        row({ id: 'pack', unit: 'ลัง', isBase: false, factor: -2 }),
      ],
    }));
    expect(neg.unit).toBe('ตัวคูณต้องมากกว่า 0');

    const nan = validateProductForm(form({
      uomRows: [
        row({ id: 'base', unit: 'ชิ้น', isBase: true, factor: 1 }),
        row({ id: 'pack', unit: 'ลัง', isBase: false, factor: Number.NaN }),
      ],
    }));
    expect(nan.unit).toBe('ตัวคูณต้องมากกว่า 0');

    const persisted = formToProduct(form({
      uomRows: [
        row({ id: 'base', unit: 'ชิ้น', isBase: true, factor: 1 }),
        row({ id: 'pack', unit: 'ลัง', isBase: false, factor: 0 }),
        row({ id: 'ok', unit: 'กล่อง', isBase: false, factor: 6 }),
      ],
    }), 'p1');
    expect(persisted.uomConversions?.some((u) => u.factor <= 0)).toBe(false);
    expect(persisted.uomConversions?.some((u) => u.unit === 'กล่อง' && u.factor === 6)).toBe(true);
  });
});
