import type { PaymentMethod, ProductBranchSetting } from '../types';

// 7C-UI-06-ENHANCEMENT: `disc_per_unit` is a per-unit baht discount -- the row discount is the
// entered amount multiplied by the line quantity (see getLineTotal in cartUtils). Modes stay
// explicit (no implicit inference) so each path is type-checked exhaustively.
export type ItemDiscountType = 'none' | 'disc_thb' | 'disc_pct' | 'disc_per_unit' | 'override';

export type CartLine = {
  lineKey: string;
  productId: string;
  productName: string;
  category: string;
  sku: string;
  /** Barcode of the selected UOM — carried to the order snapshot at checkout. */
  barcode?: string | null;
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

/** Per-query cache provenance for one inventory dimension. Never persisted. */
export type SourceProvenance = { fromCache: boolean };

/**
 * Composite pull provenance for products + stock + categories.
 * `observedAtLocal` is a client wall-clock only — never a server timestamp,
 * never written to localStorage/IndexedDB.
 */
export type InventoryProvenance = {
  products: SourceProvenance;
  stock: SourceProvenance;
  categories: SourceProvenance;
  observedAtLocal: number;
};

/** Whole-snapshot freshness: all three dimensions must be server-fresh in the same pull. */
export function isInventoryOverallFresh(provenance: InventoryProvenance | undefined): boolean {
  if (!provenance) return false;
  return (
    provenance.products.fromCache === false &&
    provenance.stock.fromCache === false &&
    provenance.categories.fromCache === false
  );
}

/**
 * Sibling truth for `PosProduct.stock`. The numeric `stock` field remains the
 * arithmetic value (and may still hold a legacy 0 when unknown) — it is NEVER
 * the truth signal on its own.
 */
export type StockTruth =
  | { state: 'unknown' }
  | { state: 'known'; asOf: 'server' | 'cache'; localDeltaApplied: boolean };

export const UNKNOWN_STOCK_TRUTH: StockTruth = { state: 'unknown' };

export type PosProduct = {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  category: string;
  emoji: string;
  imageUrl: string | null;
  stock: number;
  /** REQUIRED sibling of `stock` — unknown must never be inferred from a bare 0. */
  stockTruth: StockTruth;
  baseUnit: string;
  allowNegativeStock?: boolean;
  /** Stock Matrix Tier 2 — warn (yellow toast) on oversell when overselling is allowed.
      Projected from `Product.warnOnOversell`; absent/legacy normalized to `true` by the mapper. */
  warnOnOversell?: boolean;
  /** ⭐ สินค้าขายดี membership (UI-10). Projected from `Product.isBestSeller`;
      absent/legacy is normalized to `false` by the mapper. POS ⭐ tab filters on this. */
  isBestSeller?: boolean;
  tierPrices?: Record<string, number>;
  /** Branch-level tier price overrides — takes precedence over tierPrices when non-empty */
  overrideTierPrices?: Record<string, number>;
  /** Branch-scoped POS ordering / visibility, keyed by branchId. */
  branchSettings?: Record<string, ProductBranchSetting>;
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
