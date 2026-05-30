import type { PaymentMethod } from '../types';

export type ItemDiscountType = 'none' | 'disc_thb' | 'disc_pct' | 'override';

export type CartLine = {
  lineKey: string;
  productId: string;
  productName: string;
  category: string;
  sku: string;
  unit: string;
  unitFactor: number;
  unitPrice: number;
  originalPrice?: number;
  qty: number;
  discount: { type: ItemDiscountType; val: number };
};

export type UomOption = {
  unit: string;
  factor: number;
  price: number;
  /** UOM-specific barcode — present when scanned to auto-select this unit */
  barcode?: string | null;
};

export type PosProduct = {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  category: string;
  emoji: string;
  imageUrl: string | null;
  stock: number;
  baseUnit: string;
  allowNegativeStock?: boolean;
  tierPrices?: Record<string, number>;
  /** Branch-level tier price overrides — takes precedence over tierPrices when non-empty */
  overrideTierPrices?: Record<string, number>;
  uomOptions: UomOption[];
};

export type PaymentSplit = {
  method: PaymentMethod;
  amount: number;
};

export type CartTotals = {
  subtotal: number;
  billDiscount: number;
  fee: number;
  grandTotal: number;
  itemCount: number;
  totalQty: number;
};
