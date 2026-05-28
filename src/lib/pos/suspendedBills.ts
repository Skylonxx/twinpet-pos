import type { PosCustomerPick } from '../../components/customers/CustomerPickerModal';
import type { CartLine } from './types';

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

export function cartLinesToRecord(lines: CartLine[]): Record<string, CartLine> {
  const cart: Record<string, CartLine> = {};
  for (const line of lines) {
    cart[line.lineKey] = { ...line };
  }
  return cart;
}
