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
};

export type PosProduct = {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  category: string;
  emoji: string;
  stock: number;
  baseUnit: string;
  allowNegativeStock?: boolean;
  tierPrices?: Record<string, number>;
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
