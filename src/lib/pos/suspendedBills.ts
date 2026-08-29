import type { PosCustomerPick } from '../../components/customers/CustomerPickerModal';
import type { CartLine, ItemDiscountType } from './types';
import { bytesEqual, canonicalJsonUtf8 } from '../platform/durableStore/canonicalDigest';
import { encodeDurableKey, sortEncodedKeys } from '../platform/durableStore/kvKeyCodec';
import { registerDomainDumper } from '../platform/durableStore/bootDurableStore';
import { buildP13ManifestEvidence } from '../platform/durableStore/epochSelector';

export type SuspendedBill = {
  id: string;
  note: string;
  cartItems: CartLine[];
  customerId: string | null;
  discount: number;
  createdAt: string;
  /** Snapshot for restore — not part of the public contract but required locally */
  customer: PosCustomerPick | null;
  discountPercent: boolean;
  feeRate: number;
  totalAmount: number;
  itemCount: number;
};

const STORAGE_PREFIX = 'twinpet-suspended-bills';

function storageKey(branchId: string): string {
  return `${STORAGE_PREFIX}:${branchId}`;
}

function parseBill(raw: unknown): SuspendedBill | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.note !== 'string' || !Array.isArray(o.cartItems)) {
    return null;
  }
  return {
    id: o.id,
    note: o.note,
    cartItems: o.cartItems as CartLine[],
    customerId: typeof o.customerId === 'string' ? o.customerId : null,
    discount: typeof o.discount === 'number' ? o.discount : 0,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date().toISOString(),
    customer: (o.customer as PosCustomerPick | null) ?? null,
    discountPercent: Boolean(o.discountPercent),
    feeRate: typeof o.feeRate === 'number' ? o.feeRate : 0,
    totalAmount: typeof o.totalAmount === 'number' ? o.totalAmount : 0,
    itemCount: typeof o.itemCount === 'number' ? o.itemCount : o.cartItems.length,
  };
}

export function loadSuspendedBills(branchId: string): SuspendedBill[] {
  try {
    const raw = localStorage.getItem(storageKey(branchId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseBill).filter((b): b is SuspendedBill => b !== null);
  } catch {
    return [];
  }
}

export function saveSuspendedBills(branchId: string, bills: SuspendedBill[]): void {
  localStorage.setItem(storageKey(branchId), JSON.stringify(bills));
}

export const SUSPENDED_BILLS_LEGACY_PREFIX = 'twinpet-suspended-bills:';
const SESSION_BRANCH_KEY = 'twinpet_branch_id';

const CARTLINE_ALLOWED_KEYS = new Set([
  'lineKey',
  'productId',
  'productName',
  'category',
  'sku',
  'barcode',
  'unit',
  'unitFactor',
  'unitPrice',
  'originalPrice',
  'qty',
  'discount',
]);
const DISCOUNT_ALLOWED_KEYS = new Set(['type', 'val']);
const DISCOUNT_TYPES = new Set<ItemDiscountType>([
  'none',
  'disc_thb',
  'disc_pct',
  'disc_per_unit',
  'override',
]);

export type P13MigrationFailureCode =
  | 'empty_branch_suffix'
  | 'malformed_branch_json'
  | 'invalid_bill'
  | 'divergent_duplicate'
  | 'invalid_cartline';

export class P13MigrationError extends Error {
  readonly code: P13MigrationFailureCode;
  readonly branchId?: string;
  constructor(code: P13MigrationFailureCode, message: string, branchId?: string) {
    super(message);
    this.name = 'P13MigrationError';
    this.code = code;
    this.branchId = branchId;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function ownKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value);
}

export function validateMigrationCartLine(raw: unknown): CartLine {
  if (!isPlainObject(raw)) {
    throw new P13MigrationError('invalid_cartline', 'cart line is not a plain object');
  }
  for (const key of ownKeys(raw)) {
    if (!CARTLINE_ALLOWED_KEYS.has(key)) {
      throw new P13MigrationError('invalid_cartline', `unknown cart line field "${key}"`);
    }
  }
  const requiredStrings = ['lineKey', 'productId', 'productName', 'category', 'sku', 'unit'] as const;
  for (const field of requiredStrings) {
    if (typeof raw[field] !== 'string') {
      throw new P13MigrationError('invalid_cartline', `cart line field "${field}" must be a string`);
    }
  }
  if (raw.lineKey === '') {
    throw new P13MigrationError('invalid_cartline', 'cart line lineKey must be non-empty');
  }
  for (const field of ['unitFactor', 'unitPrice', 'qty'] as const) {
    if (!isFiniteNumber(raw[field])) {
      throw new P13MigrationError('invalid_cartline', `cart line field "${field}" must be a finite number`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'discount') || !isPlainObject(raw.discount)) {
    throw new P13MigrationError('invalid_cartline', 'cart line discount must be a plain object');
  }
  for (const key of ownKeys(raw.discount)) {
    if (!DISCOUNT_ALLOWED_KEYS.has(key)) {
      throw new P13MigrationError('invalid_cartline', `unknown discount field "${key}"`);
    }
  }
  if (typeof raw.discount.type !== 'string' || !DISCOUNT_TYPES.has(raw.discount.type as ItemDiscountType)) {
    throw new P13MigrationError('invalid_cartline', 'cart line discount.type is invalid');
  }
  if (!isFiniteNumber(raw.discount.val)) {
    throw new P13MigrationError('invalid_cartline', 'cart line discount.val must be a finite number');
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'barcode')) {
    if (raw.barcode !== null && typeof raw.barcode !== 'string') {
      throw new P13MigrationError('invalid_cartline', 'cart line barcode must be string or null');
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'originalPrice')) {
    if (!isFiniteNumber(raw.originalPrice)) {
      throw new P13MigrationError('invalid_cartline', 'cart line originalPrice must be a finite number');
    }
  }
  const line: CartLine = {
    lineKey: raw.lineKey as string,
    productId: raw.productId as string,
    productName: raw.productName as string,
    category: raw.category as string,
    sku: raw.sku as string,
    unit: raw.unit as string,
    unitFactor: raw.unitFactor as number,
    unitPrice: raw.unitPrice as number,
    qty: raw.qty as number,
    discount: { type: raw.discount.type as ItemDiscountType, val: raw.discount.val as number },
  };
  if (Object.prototype.hasOwnProperty.call(raw, 'barcode')) {
    line.barcode = raw.barcode as string | null;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'originalPrice')) {
    line.originalPrice = raw.originalPrice as number;
  }
  return line;
}

export function validateMigrationSuspendedBill(raw: unknown): SuspendedBill {
  if (!isPlainObject(raw)) {
    throw new P13MigrationError('invalid_bill', 'suspended bill is not a plain object');
  }
  if (typeof raw.id !== 'string' || raw.id === '') {
    throw new P13MigrationError('invalid_bill', 'suspended bill id is invalid');
  }
  if (typeof raw.note !== 'string') {
    throw new P13MigrationError('invalid_bill', 'suspended bill note must be a string');
  }
  if (!Array.isArray(raw.cartItems)) {
    throw new P13MigrationError('invalid_bill', 'suspended bill cartItems must be an array');
  }
  if (typeof raw.createdAt !== 'string') {
    throw new P13MigrationError('invalid_bill', 'suspended bill createdAt must be a present string');
  }
  for (const field of ['discount', 'feeRate', 'totalAmount', 'itemCount'] as const) {
    if (Object.prototype.hasOwnProperty.call(raw, field) && !isFiniteNumber(raw[field])) {
      throw new P13MigrationError('invalid_bill', `suspended bill ${field} is not a finite number`);
    }
  }
  const cartItems = raw.cartItems.map(validateMigrationCartLine);
  const lineKeys = new Set<string>();
  for (const line of cartItems) {
    if (lineKeys.has(line.lineKey)) {
      throw new P13MigrationError('invalid_cartline', 'duplicate lineKey within one suspended bill');
    }
    lineKeys.add(line.lineKey);
  }
  return {
    id: raw.id,
    note: raw.note,
    cartItems,
    customerId: typeof raw.customerId === 'string' ? raw.customerId : null,
    discount: isFiniteNumber(raw.discount) ? raw.discount : 0,
    createdAt: raw.createdAt,
    customer: (raw.customer as PosCustomerPick | null) ?? null,
    discountPercent: Boolean(raw.discountPercent),
    feeRate: isFiniteNumber(raw.feeRate) ? raw.feeRate : 0,
    totalAmount: isFiniteNumber(raw.totalAmount) ? raw.totalAmount : 0,
    itemCount: isFiniteNumber(raw.itemCount) ? raw.itemCount : cartItems.length,
  };
}

export function discoverLegacySuspendedBillBranches(storage: Storage): string[] {
  const found = new Set<string>();
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key || !key.startsWith(SUSPENDED_BILLS_LEGACY_PREFIX)) continue;
    const branchId = key.slice(SUSPENDED_BILLS_LEGACY_PREFIX.length);
    if (branchId === '') {
      throw new P13MigrationError('empty_branch_suffix', 'legacy suspended-bills key has an empty branch suffix');
    }
    found.add(branchId);
  }
  try {
    const sessionBranch = storage.getItem(SESSION_BRANCH_KEY);
    if (sessionBranch && sessionBranch !== 'ALL') {
      found.add(sessionBranch);
    }
  } catch {
    /* session branch is a completeness cross-check only */
  }
  return decodeSortedBranchIds([...found]);
}

function decodeSortedBranchIds(branchIds: string[]): string[] {
  const encoded = branchIds.map((id) => encodeDurableKey(id));
  const order = sortEncodedKeys(encoded);
  const byEncoded = new Map(branchIds.map((id) => [encodeDurableKey(id), id]));
  return order.map((enc) => byEncoded.get(enc)!);
}

export type P13MigrationRow = {
  branchId: string;
  billId: string;
  bill: SuspendedBill;
  encodedKey: string;
  canonicalBytes: Uint8Array;
};

export type P13MigrationResult = {
  branchIds: string[];
  rows: P13MigrationRow[];
  identicalDuplicateCount: number;
  allCartLinesSchemaValid: true;
};

export function migrateLegacySuspendedBills(storage: Storage): P13MigrationResult {
  const branchIds = decodeSortedBranchIds(discoverLegacySuspendedBillBranches(storage));
  const rowsByKey = new Map<string, P13MigrationRow>();
  let identicalDuplicateCount = 0;
  for (const branchId of branchIds) {
    const raw = storage.getItem(`${SUSPENDED_BILLS_LEGACY_PREFIX}${branchId}`);
    if (raw == null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new P13MigrationError('malformed_branch_json', 'legacy branch JSON is malformed', branchId);
    }
    if (!Array.isArray(parsed)) {
      throw new P13MigrationError('malformed_branch_json', 'legacy branch JSON is not an array', branchId);
    }
    for (const element of parsed) {
      const bill = validateMigrationSuspendedBill(element);
      const encodedKey = encodeDurableKey([branchId, bill.id]);
      const canonicalBytes = canonicalJsonUtf8(bill);
      const existing = rowsByKey.get(encodedKey);
      if (!existing) {
        rowsByKey.set(encodedKey, {
          branchId,
          billId: bill.id,
          bill,
          encodedKey,
          canonicalBytes,
        });
        continue;
      }
      if (bytesEqual(existing.canonicalBytes, canonicalBytes)) {
        identicalDuplicateCount += 1;
        continue;
      }
      throw new P13MigrationError(
        'divergent_duplicate',
        'divergent duplicate [branchId,billId] in legacy P-13 source',
        branchId,
      );
    }
  }
  const orderedKeys = sortEncodedKeys([...rowsByKey.keys()]);
  const rows = orderedKeys.map((key) => rowsByKey.get(key)!);
  return {
    branchIds,
    rows,
    identicalDuplicateCount,
    allCartLinesSchemaValid: true,
  };
}

export function cartLinesToRecord(lines: CartLine[]): Record<string, CartLine> {
  const cart: Record<string, CartLine> = {};
  for (const line of lines) {
    cart[line.lineKey] = { ...line };
  }
  return cart;
}

registerDomainDumper('suspendedBills', async () => {
  if (typeof localStorage === 'undefined') {
    return {
      rows: [],
      p13: await buildP13ManifestEvidence({ branchIds: [], rows: [], identicalDuplicateCount: 0 }),
    };
  }
  const migrated = migrateLegacySuspendedBills(localStorage);
  const rows = migrated.rows.map((row) => ({
    store: 'bills',
    key: [row.branchId, row.billId],
    value: row.bill,
  }));
  return {
    rows,
    p13: await buildP13ManifestEvidence({
      branchIds: migrated.branchIds,
      rows,
      identicalDuplicateCount: migrated.identicalDuplicateCount,
    }),
  };
});
