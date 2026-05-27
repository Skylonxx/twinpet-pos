import type { CreditAccount, Customer, Order } from '../types';
import type { ContactType } from '../types';
import { DEFAULT_CUSTOMER_TIER } from '../types';

export type CustomerTab = 'sales' | 'credit' | 'products' | 'pricing' | 'info';

export type CustomerWithCredit = Customer & {
  creditAccount: CreditAccount | null;
  currentBalance: number;
};

export type CustomerFormData = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  taxId: string;
  address: string;
  contactType: ContactType;
  bankName: string;
  bankAccount: string;
  priceLevelId: string;
  creditLimit: number;
  creditDays: number;
  note: string;
  tags: string;
  /** CRM tier key — must match product tierPrices keys */
  customerType: string;
  isActive: boolean;
};

export type PayCreditInput = {
  customerId: string;
  branchId: string;
  amount: number;
  method: 'cash' | 'transfer';
  note: string;
  createdBy: string;
};

export type CustomerOrderRow = {
  id: string;
  date: string;
  itemsSummary: string;
  total: number;
  payLabel: string;
  status: 'paid' | 'pending' | 'cancel';
};

export type TopProductRow = {
  productId: string;
  name: string;
  sku: string;
  qty: number;
  revenue: number;
};

export const CONTACT_TYPE_OPTIONS: Array<{
  id: ContactType;
  icon: string;
  label: string;
  desc: string;
}> = [
  {
    id: 'retail',
    icon: '🛒',
    label: 'ลูกค้าทั่วไป',
    desc: 'Retail — ราคามาตรฐาน',
  },
  {
    id: 'wholesale',
    icon: '📦',
    label: 'ลูกค้าขายส่ง',
    desc: 'Wholesale — ราคาพิเศษ',
  },
  {
    id: 'supplier',
    icon: '🏭',
    label: 'ผู้จำหน่าย',
    desc: 'Supplier — ซัพพลายเออร์',
  },
];

export const TIER_CARDS: Array<{
  id: string;
  icon: string;
  name: string;
  desc: string;
  badge: string;
  badgeStyle: { bg: string; color: string };
}> = [
  {
    id: 'RETAIL',
    icon: '🛒',
    name: 'Retail',
    desc: 'ลูกค้าทั่วไป\nราคามาตรฐาน',
    badge: 'General',
    badgeStyle: { bg: 'var(--g100)', color: 'var(--g600)' },
  },
  {
    id: 'WHOLESALE1',
    icon: '⭐',
    name: 'Wholesale 1',
    desc: 'ลูกค้าส่งระดับ 1\nราคาพิเศษ',
    badge: 'Silver',
    badgeStyle: { bg: 'var(--amber50)', color: 'var(--amber)' },
  },
  {
    id: 'WHOLESALE2',
    icon: '💎',
    name: 'Wholesale 2',
    desc: 'ลูกค้าส่งระดับ 2\nราคาสุดพิเศษ',
    badge: 'Gold',
    badgeStyle: { bg: 'var(--p50)', color: 'var(--p800)' },
  },
];

export function customerFullName(c: Pick<Customer, 'firstName' | 'lastName'>): string {
  return `${c.firstName} ${c.lastName}`.trim();
}

export function inferCustomerType(c: {
  customerType?: string;
  contactType?: ContactType;
  tags?: string[];
}): string {
  if (c.customerType?.trim()) return c.customerType.trim();
  if (c.tags?.some((t) => t.toUpperCase() === 'VIP')) return 'vip';
  if (c.contactType === 'wholesale') return 'wholesale';
  return DEFAULT_CUSTOMER_TIER;
}

export function customerCrmFields(
  fields: {
    firstName: string;
    lastName: string;
    contactType: ContactType;
    tags: string[];
    totalSpent?: number;
    lifetimeValue?: number;
    lastVisitAt?: Customer['lastVisitAt'];
    customerType?: string;
    name?: string;
  },
  branchId: string,
): Pick<Customer, 'branchId' | 'name' | 'customerType' | 'lifetimeValue' | 'lastVisitAt'> {
  const totalSpent = fields.totalSpent ?? 0;
  return {
    branchId,
    name: fields.name ?? customerFullName(fields),
    customerType: fields.customerType?.trim() || inferCustomerType(fields),
    lifetimeValue: fields.lifetimeValue ?? totalSpent,
    lastVisitAt: fields.lastVisitAt ?? null,
  };
}

export function customerInitials(c: Pick<Customer, 'firstName' | 'lastName'>): string {
  return `${c.firstName.charAt(0)}${c.lastName.charAt(0)}`;
}

export function inferContactType(c: Pick<Customer, 'contactType' | 'priceLevelId'>): ContactType {
  if (c.contactType) return c.contactType;
  if (c.priceLevelId === 'WHOLESALE1' || c.priceLevelId === 'WHOLESALE2') return 'wholesale';
  return 'retail';
}

export function contactTypeLabel(type: ContactType): string {
  return CONTACT_TYPE_OPTIONS.find((o) => o.id === type)?.label ?? type;
}

export function customerTypeLabel(type: string): string {
  const known: Record<string, string> = {
    retail: 'ลูกค้าทั่วไป',
    wholesale: 'ลูกค้าขายส่ง',
    vip: 'VIP',
  };
  const key = type?.trim() || DEFAULT_CUSTOMER_TIER;
  return known[key] ?? key;
}

export function customerTypeBadgeStyle(type: string): { bg: string; color: string } {
  const key = type?.trim() || DEFAULT_CUSTOMER_TIER;
  switch (key) {
    case 'vip':
      return { bg: 'var(--p50)', color: 'var(--p800)' };
    case 'wholesale':
      return { bg: 'var(--amber50)', color: 'var(--amber)' };
    case 'retail':
      return { bg: 'var(--g100)', color: 'var(--g600)' };
    default:
      return { bg: 'var(--g50)', color: 'var(--p700)' };
  }
}

export function formatCustomerLastVisit(ts: Customer['lastVisitAt']): string {
  if (!ts || typeof ts !== 'object' || !('toDate' in ts)) return '—';
  return (ts as { toDate: () => Date }).toDate().toLocaleDateString('th-TH', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function contactTypeBadgeStyle(type: ContactType): { bg: string; color: string } {
  if (type === 'supplier') return { bg: '#E8F0FE', color: '#185FA5' };
  if (type === 'wholesale') return { bg: 'var(--amber50)', color: 'var(--amber)' };
  return { bg: 'var(--g100)', color: 'var(--g600)' };
}

export function fmtBaht(n: number): string {
  return `฿${parseFloat(String(n || 0)).toLocaleString('th-TH', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export function fmtBahtDec(n: number): string {
  return `฿${parseFloat(String(n || 0)).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function orderStatusLabel(status: Order['status'], creditAmt: number): CustomerOrderRow['status'] {
  if (status === 'voided') return 'cancel';
  if (status === 'pending_payment' || creditAmt > 0) return 'pending';
  return 'paid';
}

export function payMethodLabel(order: Order): string {
  if (order.creditAmt > 0 && order.paidAmt === 0) return 'เชื่อ';
  if (order.creditAmt > 0) return 'หลายช่องทาง';
  return 'เงินสด';
}

export const EMPTY_FORM: CustomerFormData = {
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
  taxId: '',
  address: '',
  contactType: 'retail',
  bankName: '',
  bankAccount: '',
  priceLevelId: 'RETAIL',
  creditLimit: 0,
  creditDays: 30,
  note: '',
  tags: '',
  customerType: DEFAULT_CUSTOMER_TIER,
  isActive: true,
};

export function customerToForm(c: Customer): CustomerFormData {
  const contactType = inferContactType(c);
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    phone: c.phone,
    email: c.email ?? '',
    taxId: c.taxId ?? '',
    address: c.address ?? '',
    contactType,
    bankName: c.bankName ?? '',
    bankAccount: c.bankAccount ?? '',
    priceLevelId: c.priceLevelId,
    creditLimit: c.creditLimit,
    creditDays: c.creditDays,
    note: c.note,
    tags: c.tags.join(', '),
    customerType: inferCustomerType(c),
    isActive: c.isActive,
  };
}

export function creditUsagePct(account: CreditAccount | null, limit: number): number {
  if (!account || limit <= 0) return 0;
  return Math.min(100, Math.round((account.creditUsed / limit) * 100));
}

export function normalizeCustomerForm(form: CustomerFormData): CustomerFormData {
  const contactType = form.contactType;
  const customerType = form.customerType.trim() || DEFAULT_CUSTOMER_TIER;
  return {
    ...form,
    customerType,
    priceLevelId:
      contactType === 'retail'
        ? 'RETAIL'
        : contactType === 'supplier'
          ? 'RETAIL'
          : form.priceLevelId,
    creditLimit: contactType === 'supplier' ? 0 : form.creditLimit,
    creditDays: contactType === 'supplier' ? 0 : form.creditDays,
    bankName: contactType === 'supplier' ? form.bankName : '',
    bankAccount: contactType === 'supplier' ? form.bankAccount : '',
  };
}
