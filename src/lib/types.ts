/**
 * TwinPet POS — Firestore types
 */

import type { Timestamp } from 'firebase/firestore';

export type { Timestamp };

export type DocId = string;

export type SoftDelete = {
  deletedAt: Timestamp | null;
};

export type UserRole = 'admin' | 'manager' | 'staff';

export type OrderStatus = 'completed' | 'voided' | 'pending_payment';

export type StockMovementType =
  | 'sale'
  | 'receive'
  | 'adjust'
  | 'transfer_in'
  | 'transfer_out'
  | 'void';

export type PaymentMethod = 'cash' | 'qr' | 'kbank' | 'card' | 'credit';

export type QuotationStatus =
  | 'draft'
  | 'sent'
  | 'accepted'
  | 'rejected'
  | 'expired';

export type ReceivingStatus = 'draft' | 'completed' | 'cancelled';

export type ReceivingPayStatus = 'paid' | 'pending' | 'partial';

export type CreditTransactionType = 'charge' | 'payment' | 'adjust';

export type AuditAction = 'create' | 'update' | 'delete' | 'void' | 'refund';

// -----------------------------
// branches
// -----------------------------

export type Branch = {
  id: string; // "LDP-001"
  name: string;
  address: string;
  phone: string;
  email: string;
  taxId: string;
  logoUrl: string | null;
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

// -----------------------------
// users
// -----------------------------

export type UserPermissions = {
  canVoidOrder: boolean;
  canEditPrice: boolean;
  canViewReport: boolean;
  canManageStock: boolean;
  canManageStaff: boolean;
};

export type User = SoftDelete & {
  id: string; // Firebase Auth UID
  firstName: string;
  lastName: string;
  username: string;
  pin: string; // bcrypt hashed
  role: UserRole;
  branchIds: string[];
  permissions: UserPermissions;
  isActive: boolean;
  lastLoginAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

// -----------------------------
// products + productStocks (subcollection)
// -----------------------------

export type UomConversion = {
  /** Unit label — must match a name from the global master unit list */
  unit: string;
  /** Product-specific multiplier: 1 `unit` = `factor` × product.baseUnit */
  factor: number;
  barcode?: string | null;
  /** Per-tier prices for this unit — keys match customer.customerType */
  tierPrices?: Record<string, number>;
};

export type ProductPrice = {
  /** Price-level id this base/list price belongs to — defaults to {@link RETAIL_PRICE_LEVEL_ID} */
  priceLevelId: string;
  unit: string; // "ชิ้น"
  price: number;
};

/** Per-branch POS presentation for a category. */
export interface CategoryBranchSetting {
  /** POS category-bar ordering for this branch (ascending — lower shows first). */
  displayOrder: number;
  /** When false, the category is hidden from this branch's POS sell screen. */
  isVisibleInPos: boolean;
  /** Optional solid background color for the category block (e.g. "#534ab7"). */
  backgroundColor?: string;
  /** Optional background image URL for the category block. */
  imageUrl?: string;
}

/** Per-branch POS presentation for a product. */
export interface ProductBranchSetting {
  /** When false, hidden from this branch's POS grids (still scannable by exact code). */
  isVisibleInPos: boolean;
  /** Custom sort positions per category key ('best-sellers' or a category id). */
  sortOrders: Record<string, number>;
}

export type ProductCategory = {
  id: string;
  name: string;
  /** Branch-scoped ordering / visibility / styling. Keyed by branchId. */
  branchSettings?: Record<string, CategoryBranchSetting>;
};

export type Product = SoftDelete & {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  category: string;
  description: string;
  imageUrl: string | null;
  /** Stock-keeping unit — smallest inventory unit for this product */
  baseUnit: string;
  /** Alternate sell/receive units with product-specific conversion to baseUnit */
  uomConversions: UomConversion[];
  prices: ProductPrice[];
  /** Per-tier base-unit prices — key is tier id (e.g. retail, wholesale, agent1) */
  tierPrices?: Record<string, number>;
  /** Manual standard/base cost — editable in product form; not updated by GRNs */
  cost: number;
  /** HQ master/central price (ราคากลาง) — admin/manager only; reference price for branches */
  basePrice?: number;
  /** Moving average from GRN receipts — system calculated */
  avgCost: number;
  reorderPoint: number; // global (per-branch lives in ProductStock)
  isActive: boolean;
  /** ปิดการแจ้งเตือนสต็อก — ซ่อนจาก low/critical/OOS alerts (เช่น สินค้าตามฤดูกาล). ค่าเริ่มต้น false เมื่อไม่ระบุ */
  muteAlerts?: boolean;
  /** สินค้าคิด VAT — ค่าเริ่มต้น true เมื่อไม่ระบุ */
  hasVat?: boolean;
  /** อนุญาตขายเมื่อสต็อกหมด (overselling) — ต่อสินค้า */
  allowNegativeStock?: boolean;
  /** Branch-scoped POS ordering / visibility. Keyed by branchId. */
  branchSettings?: Record<string, ProductBranchSetting>;
  /** นโยบายแจ้งเตือนวันหมดอายุ — ใช้ค่าเริ่มต้นเมื่อไม่ระบุ */
  expiryPolicyId?: string | null;
  /** Branches carrying this product — empty array or absent means all branches */
  availableBranches?: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type ProductStock = {
  branchId: string;
  totalStockBase: number;
  reorderPoint: number;
  /** Branch-level tier price overrides — keys match customer.customerType / price-level id */
  overrideTierPrices?: Record<string, number>;
  /** Branch-level flat price override applied when no tier price matches */
  overridePrice?: number;
  lastMovementAt: Timestamp;
  updatedAt: Timestamp;
};

// -----------------------------
// stockLots + stockMovements
// -----------------------------

export type StockLot = {
  id: string;
  productId: string;
  branchId: string;
  receivingId: string;
  costPerUnit: number;
  qtyReceived: number;
  qtyRemaining: number;
  receivedAt: Timestamp;
  expiryDate: Timestamp | null;
  isDepleted: boolean;
  createdAt: Timestamp;
  // Added by business rules section (negative stock).
  // Optional to stay compatible with earlier data.
  isGhost?: boolean;
};

export type StockMovement = {
  id: string;
  productId: string;
  branchId: string;
  type: StockMovementType;
  qty: number; // + in, - out (base unit)
  costPerUnit: number;
  refId: string;
  refType: string; // "order" | "receiving" | "adjustment" | ...
  note: string;
  createdBy: string; // userId
  createdAt: Timestamp;
};

// -----------------------------
// customers
// -----------------------------

export type ContactType = 'retail' | 'wholesale' | 'supplier';

/**
 * Canonical id of the built-in retail / base price level. Replaces the legacy
 * hardcoded `'RETAIL'` string sentinel — the base price in {@link ProductPrice}
 * and the default customer tier both resolve to this id.
 */
export const RETAIL_PRICE_LEVEL_ID = 'retail';

/** CRM / pricing tier id — the retail level is the default (e.g. retail, wholesale, agent1, farm_large) */
export const DEFAULT_CUSTOMER_TIER = RETAIL_PRICE_LEVEL_ID;

// -----------------------------
// suppliers (root collection — HQ managed)
// -----------------------------

/**
 * Supplier (ผู้จำหน่าย) — root-level collection.
 * `allowedBranchIds: ['ALL']` means visible at every branch.
 * Otherwise only branches listed can see/use this supplier.
 */
export type Supplier = SoftDelete & {
  id: string;
  code: string; // e.g. "SUP-001"
  name: string;
  contactName: string;
  phone: string;
  email: string | null;
  taxId: string | null;
  address: string | null;
  bankName: string | null;
  bankAccount: string | null;
  note: string;
  isActive: boolean;
  /** ['ALL'] = ทุกสาขา, otherwise list of specific branch IDs */
  allowedBranchIds: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type Customer = SoftDelete & {
  id: string;
  branchId: string;
  /** Display name for CRM, receipts, and POS */
  name: string;
  memberNo: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  taxId: string | null;
  address: string | null;
  contactType: ContactType;
  /** Dynamic pricing tier — defaults to {@link DEFAULT_CUSTOMER_TIER} when empty */
  customerType: string;
  bankName: string | null;
  bankAccount: string | null;
  priceLevelId: string;
  creditLimit: number;
  creditDays: number;
  /** Payment term length in days (e.g. 15, 30, 45) — overrides {@link creditDays} when set */
  creditTermDays?: number;
  /** Most recent credit purchase (POS credit sale) */
  lastCreditPurchaseDate?: Timestamp;
  /** Most recent credit payment received */
  lastPaymentDate?: Timestamp;
  /** Current unpaid credit balance (THB) — denormalized for CRM badges */
  outstandingBalance?: number;
  totalSpent: number;
  /** Total THB spent all time (CRM lifetime value) */
  lifetimeValue: number;
  /** Current reward points */
  points: number;
  lastVisitAt: Timestamp | null;
  tags: string[];
  note: string;
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

// -----------------------------
// priceLevels + master unit names (uomUnits collection)
// -----------------------------

export type PriceLevel = {
  id: string;
  name: string;
  code: string;
  order: number;
  isActive: boolean;
  /** true = available at every branch. Branch-scoped levels set this false + a branchId. */
  isGlobal: boolean;
  /** Owning branch for a branch-scoped level; null for global levels. */
  branchId: string | null;
  desc?: string;
};

/** Global unit name registry — conversion factors are stored per product in uomConversions */
export type UomUnit = {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
};

// -----------------------------
// orders + orderItems (subcollection)
// -----------------------------

export type CustomerSnap = {
  name: string;
  phone: string;
  taxId: string | null;
};

export type Order = {
  id: string;
  billId: string;
  branchId: string;
  customerId: string | null;
  customerSnap: CustomerSnap | null;
  staffId: string;
  staffName: string;
  /** Shift active when the sale was recorded — used to reverse shift totals on void */
  shiftId?: string;
  status: OrderStatus;
  subtotal: number;
  discountAmt: number;
  billDiscount: number;
  vatRate: number;
  vatAmt: number;
  surcharge: number;
  total: number;
  paidAmt: number;
  changeAmt: number;
  creditAmt: number;
  /** Total cost of goods sold (Σ orderItems.fifoCost) captured at sale time. */
  cogs?: number;
  /** Gross profit (subtotal − discounts − cogs) captured at sale time. */
  profit?: number;
  priceLevelId: string;
  note: string;
  voidReason: string | null;
  voidedBy: string | null;
  voidedAt: Timestamp | null;
  printCount: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type ProductSnap = {
  name: string;
  sku: string;
  category: string;
  /**
   * Barcode of the exact UOM sold, snapshotted at checkout for audit accuracy.
   * Absent on legacy bills (pre-snapshot) and null when the sold unit has no
   * barcode — readers must fall back gracefully (see SalesHistory hybrid lookup).
   */
  barcode?: string | null;
};

export type LotRef = {
  lotId: string;
  qty: number; // base unit qty cut from this lot
  cost: number; // costPerUnit used
};

export type OrderItem = {
  id: string;
  productId: string;
  productSnap: ProductSnap;
  unit: string;
  unitFactor: number;
  qty: number;
  qtyBase: number;
  unitPrice: number;
  originalPrice?: number;
  discountAmt: number;
  lineTotal: number;
  fifoCost: number;
  lotRefs: LotRef[];
};

// -----------------------------
// payments
// -----------------------------

export type Payment = {
  id: string;
  orderId: string;
  branchId: string;
  method: PaymentMethod;
  amount: number;
  ref: string | null;
  createdAt: Timestamp;
};

// -----------------------------
// quotations + quotationItems (subcollection)
// -----------------------------

export type Quotation = {
  id: string;
  branchId: string;
  customerId: string | null;
  customerSnap: Record<string, unknown> | null;
  staffId: string;
  status: QuotationStatus;
  validUntil: Timestamp;
  subtotal: number;
  discountAmt: number;
  vatAmt: number;
  total: number;
  note: string;
  convertedToOrderId: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type QuotationItem = Omit<OrderItem, 'fifoCost' | 'lotRefs'>;

// -----------------------------
// receivings + receivingItems (subcollection)
// -----------------------------

export type Receiving = {
  id: string;
  branchId: string;
  supplierId: string | null;
  supplierName: string;
  staffId: string;
  status: ReceivingStatus;
  subtotal: number;
  discountAmt: number;
  vatRate: number;
  vatAmt: number;
  total: number;
  payStatus: ReceivingPayStatus;
  paidAmt: number;
  note: string;
  receivedAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type ReceivingProductSnap = {
  name: string;
  sku: string;
};

export type ReceivingItem = {
  id: string;
  productId: string;
  productSnap: ReceivingProductSnap;
  unit: string;
  unitFactor: number;
  qty: number;
  qtyBase: number;
  costPerUnit: number;
  costBase: number;
  discountAmt: number;
  lineTotal: number;
  lotId: string;
};

// -----------------------------
// parkedOrders + parkedItems (subcollection)
// -----------------------------

export type ParkedOrderStatus = 'parked' | 'resumed' | 'cancelled';

export type ParkedOrder = {
  id: string;
  branchId: string;
  deviceId: string;
  parkedByUserId: string;
  parkedByName: string;
  customerId: string | null;
  customerSnap: Record<string, unknown> | null;
  priceLevelId: string;
  note: string;
  subtotal: number;
  discountAmt: number;
  total: number;
  itemCount: number;
  status: ParkedOrderStatus;
  parkedAt: Timestamp;
  resumedAt: Timestamp | null;
  resumedByUserId: string | null;
  expiresAt: Timestamp;
};

export type ParkedItem = Omit<OrderItem, 'fifoCost' | 'lotRefs'>;

// -----------------------------
// creditAccounts + creditTransactions
// -----------------------------

export type CreditAccount = {
  customerId: string;
  branchId: string;
  creditLimit: number;
  creditUsed: number;
  creditBalance: number;
  overdueAmt: number;
  lastTransAt: Timestamp | null;
  updatedAt: Timestamp;
};

export type CreditTransaction = {
  id: string;
  customerId: string;
  branchId: string;
  type: CreditTransactionType;
  amount: number;
  balance: number;
  refOrderId: string | null;
  note: string;
  createdBy: string;
  createdAt: Timestamp;
  dueDate: Timestamp | null;
  isPaid: boolean;
  paidAt: Timestamp | null;
};

/** Records cash/transfer payments applied against customer credit debt */
export type CreditPaymentTransaction = {
  id: string;
  customerId: string;
  amount: number;
  /** Method used to pay off the debt */
  paymentMethod: 'cash' | 'transfer';
  shiftId?: string;
  createdAt: Timestamp;
  notes?: string;
};

// -----------------------------
// settings (per-branch)
// -----------------------------

export type NotificationChannelConfig = {
  line: boolean;
  email: boolean;
};

export type SettingsNotifications = {
  lowStock: NotificationChannelConfig;
  voidOrder: NotificationChannelConfig;
  overCredit: NotificationChannelConfig;
  dailySummary: NotificationChannelConfig;
};

export type Settings = {
  branchId: string;
  vatRegistered: boolean;
  vatRate: number;
  priceIncludesVat: boolean;
  paymentMethods: Record<PaymentMethod, boolean>;
  receiptHeader: string;
  receiptFooter: string;
  receiptLogoUrl: string | null;
  showBarcodeOnReceipt: boolean;
  showQrOnReceipt: boolean;
  pinMaxAttempts: number;
  sessionTimeoutMin: number;
  notifications: SettingsNotifications;
  lineNotifyToken: string | null;
  allowNegativeStock: boolean;
  negativeStockWarning: boolean;
  parkedOrderExpiryHours: number;
  posPrefix?: string | null;
  updatedAt: Timestamp;
};

// -----------------------------
// posDevices
// -----------------------------

export type PosDeviceType = 'desktop' | 'tablet' | 'mobile';

export type PosDevice = {
  id: string;
  branchId: string;
  name: string;
  type: PosDeviceType;
  token: string;
  isOnline: boolean;
  lastSeenAt: Timestamp | null;
  currentUserId: string | null;
  createdAt: Timestamp;
};

// -----------------------------
// shifts (cashier shift management)
// -----------------------------

export type ShiftStatus = 'open' | 'closed';

export type Shift = {
  id: string;
  branchId: string;
  staffId: string;
  staffName: string;
  status: ShiftStatus;
  openedAt: Timestamp;
  closedAt: Timestamp | null;
  startingCash: number;
  actualCashCount: number;
  expectedCash: number;
  expectedQr: number;
  expectedKbank: number;
  expectedCard: number;
  expectedCredit: number;
  totalBills: number;
  payInTotal: number;
  payOutTotal: number;
  variance: number;
  note: string;
};

export type CashTransactionType = 'pay_in' | 'pay_out';

export type CashTransaction = {
  id: string;
  shiftId: string;
  branchId: string;
  staffId: string;
  staffName: string;
  type: CashTransactionType;
  amount: number;
  note: string;
  createdAt: Timestamp;
};

// -----------------------------
// staffActivities
// -----------------------------

export type StaffActivity = {
  id: string;
  branchId: string;
  userId: string;
  userName: string;
  action: string;
  detail: string;
  refId: string | null;
  ip: string | null;
  deviceId: string | null;
  createdAt: Timestamp;
};

// -----------------------------
// auditLogs
// -----------------------------

export type AuditLog = {
  id: string;
  collection: string;
  docId: string;
  action: AuditAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changedFields: string[];
  reason: string | null;
  changedBy: string;
  changedByName: string;
  changedAt: Timestamp;
};

