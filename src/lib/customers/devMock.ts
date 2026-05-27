import { Timestamp } from 'firebase/firestore';
import { devApplyCreditPaymentToShift } from '../pos/shiftDevMock';
import { applyCrmSaleLocally } from './crmService';
import type { CreditAccount, CreditTransaction, CreditPaymentTransaction, Customer, Order, PriceLevel } from '../types';
import { DEFAULT_CUSTOMER_TIER } from '../types';
import type { ContactType } from '../types';

const DEV_BRANCH_ID = 'LDP-001';

function customerName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim();
}

function inferCustomerType(
  contactType: ContactType,
  tags: string[],
): string {
  if (tags.some((t) => t.toUpperCase() === 'VIP')) return 'vip';
  if (contactType === 'wholesale') return 'wholesale';
  return DEFAULT_CUSTOMER_TIER;
}

function crmFields(
  firstName: string,
  lastName: string,
  contactType: ContactType,
  tags: string[],
  totalSpent: number,
  lastVisitAt: Customer['lastVisitAt'] = null,
): Pick<Customer, 'branchId' | 'name' | 'customerType' | 'lifetimeValue' | 'lastVisitAt'> {
  return {
    branchId: DEV_BRANCH_ID,
    name: customerName(firstName, lastName),
    customerType: inferCustomerType(contactType, tags),
    lifetimeValue: totalSpent,
    lastVisitAt,
  };
}

const now = Timestamp.now();

export const DEV_PRICE_LEVELS: PriceLevel[] = [
  { id: 'RETAIL', name: 'Retail', code: 'RETAIL', order: 1, isActive: true },
  { id: 'WHOLESALE1', name: 'Wholesale 1', code: 'WHL1', order: 2, isActive: true },
  { id: 'WHOLESALE2', name: 'Wholesale 2', code: 'WHL2', order: 3, isActive: true },
];

let devCustomers: Customer[] | null = null;
let devCreditAccounts = new Map<string, CreditAccount>();
let devCreditTx: CreditTransaction[] = [];
let devCreditPayments: CreditPaymentTransaction[] = [];
let devOrders: Order[] = [];
let nextMember = 4;

function ts(d: Date): Order['createdAt'] {
  return { toDate: () => d } as Order['createdAt'];
}

function seedCustomers(): Customer[] {
  return [
    {
      id: 'cust-m003',
      memberNo: 'M000003',
      ...crmFields('น้ำ', 'แก้วกานต์', 'wholesale', ['VIP', 'ลูกค้าประจำ'], 48500, ts(new Date('2026-05-20'))),
      firstName: 'น้ำ',
      lastName: 'แก้วกานต์',
      phone: '081-234-5678',
      email: 'nam.kaew@email.com',
      taxId: '0105563012345',
      address: '123 ถ.ลาดพร้าว แขวงจอมพล เขตจตุจักร กรุงเทพฯ 10900',
      contactType: 'wholesale',
      bankName: null,
      bankAccount: null,
      priceLevelId: 'WHOLESALE1',
      creditLimit: 10000,
      creditDays: 30,
      creditTermDays: 30,
      lastCreditPurchaseDate: ts(new Date('2026-04-10')),
      outstandingBalance: 2500,
      totalSpent: 48500,
      points: 98,
      tags: ['VIP', 'ลูกค้าประจำ'],
      note: 'ลูกค้าขอใบกำกับภาษีทุกครั้ง',
      isActive: true,
      createdAt: ts(new Date('2023-01-15')),
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: 'cust-m001',
      memberNo: 'M000001',
      ...crmFields('สมชาย', 'มีชัย', 'retail', [], 12400, ts(new Date('2026-05-18'))),
      firstName: 'สมชาย',
      lastName: 'มีชัย',
      phone: '089-876-5432',
      email: null,
      taxId: null,
      address: '45 ซ.สukhumvit กรุงเทพฯ',
      contactType: 'retail',
      bankName: null,
      bankAccount: null,
      priceLevelId: 'RETAIL',
      creditLimit: 0,
      creditDays: 0,
      totalSpent: 12400,
      points: 45,
      tags: [],
      note: '',
      isActive: true,
      createdAt: ts(new Date('2024-03-10')),
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: 'cust-m002',
      memberNo: 'M000002',
      ...crmFields('วิไล', 'พงษ์ศรี', 'wholesale', ['Wholesale'], 128000, ts(new Date('2026-05-22'))),
      firstName: 'วิไล',
      lastName: 'พงษ์ศรี',
      phone: '062-111-2233',
      email: 'wilai@email.com',
      taxId: null,
      address: null,
      contactType: 'wholesale',
      bankName: null,
      bankAccount: null,
      priceLevelId: 'WHOLESALE2',
      creditLimit: 50000,
      creditDays: 45,
      creditTermDays: 45,
      lastCreditPurchaseDate: ts(new Date('2026-05-20')),
      outstandingBalance: 8200,
      totalSpent: 128000,
      points: 320,
      tags: ['Wholesale'],
      note: '',
      isActive: true,
      createdAt: ts(new Date('2022-08-20')),
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: 'cust-m004',
      memberNo: 'M000004',
      ...crmFields('มนัส', 'ศรีสุข', 'retail', [], 3200),
      firstName: 'มนัส',
      lastName: 'ศรีสุข',
      phone: '091-555-6677',
      email: null,
      taxId: null,
      address: '88 ถ.พหลโยธิน',
      contactType: 'retail',
      bankName: null,
      bankAccount: null,
      priceLevelId: 'RETAIL',
      creditLimit: 5000,
      creditDays: 15,
      outstandingBalance: 0,
      totalSpent: 3200,
      points: 12,
      tags: [],
      note: '',
      isActive: false,
      createdAt: ts(new Date('2025-01-05')),
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: 'cust-sup001',
      memberNo: 'SUP-0001',
      ...crmFields('บริษัท เพ็ทฟู้ด', 'ดิสทริบิวชั่น จำกัด', 'supplier', ['Supplier', 'อาหารสัตว์'], 0),
      firstName: 'บริษัท เพ็ทฟู้ด',
      lastName: 'ดิสทริบิวชั่น จำกัด',
      phone: '02-555-1234',
      email: 'account@petfood.co.th',
      taxId: '0105567890123',
      address: '99 ถ.บางนา-ตราด กม.15 สมุทรปราการ',
      contactType: 'supplier',
      bankName: 'ธนาคารกสิกรไทย',
      bankAccount: '123-4-56789-0',
      priceLevelId: 'RETAIL',
      creditLimit: 0,
      creditDays: 0,
      totalSpent: 0,
      points: 0,
      tags: ['Supplier', 'อาหารสัตว์'],
      note: 'Supplier หลัก — สั่งทุกวันจันทร์',
      isActive: true,
      createdAt: ts(new Date('2024-06-01')),
      updatedAt: now,
      deletedAt: null,
    },
  ];
}

function seedCredit(): void {
  devCreditAccounts.set('cust-m003', {
    customerId: 'cust-m003',
    branchId: 'LDP-001',
    creditLimit: 10000,
    creditUsed: 2500,
    creditBalance: 7500,
    overdueAmt: 0,
    lastTransAt: ts(new Date('2026-05-20')),
    updatedAt: now,
  });
  devCreditAccounts.set('cust-m002', {
    customerId: 'cust-m002',
    branchId: 'LDP-001',
    creditLimit: 50000,
    creditUsed: 8200,
    creditBalance: 41800,
    overdueAmt: 0,
    lastTransAt: ts(new Date('2026-05-22')),
    updatedAt: now,
  });
  devCreditAccounts.set('cust-m004', {
    customerId: 'cust-m004',
    branchId: 'LDP-001',
    creditLimit: 5000,
    creditUsed: 0,
    creditBalance: 5000,
    overdueAmt: 0,
    lastTransAt: null,
    updatedAt: now,
  });

  devCreditTx = [
    {
      id: 'ctx-1',
      customerId: 'cust-m003',
      branchId: 'LDP-001',
      type: 'payment',
      amount: 1200,
      balance: 7500,
      refOrderId: 'TW-1120',
      note: 'ชำระหนี้ Order #1120 — โอนเงิน',
      createdBy: 'dev-somchai',
      createdAt: ts(new Date('2026-05-20')),
      dueDate: null,
      isPaid: true,
      paidAt: ts(new Date('2026-05-20')),
    },
    {
      id: 'ctx-2',
      customerId: 'cust-m003',
      branchId: 'LDP-001',
      type: 'payment',
      amount: 3500,
      balance: 8700,
      refOrderId: 'TW-1098',
      note: 'ชำระหนี้ Order #1098 — เงินสด',
      createdBy: 'dev-suda',
      createdAt: ts(new Date('2026-05-10')),
      dueDate: null,
      isPaid: true,
      paidAt: ts(new Date('2026-05-10')),
    },
    {
      id: 'ctx-3',
      customerId: 'cust-m003',
      branchId: 'LDP-001',
      type: 'charge',
      amount: 2500,
      balance: 7500,
      refOrderId: 'TW-1085',
      note: 'Order #1085 ค้างชำระ',
      createdBy: 'dev-suda',
      createdAt: ts(new Date('2026-05-01')),
      dueDate: ts(new Date('2026-06-01')),
      isPaid: false,
      paidAt: null,
    },
  ];

  devCreditPayments = [
    {
      id: 'cpay-1',
      customerId: 'cust-m003',
      amount: 1200,
      paymentMethod: 'transfer',
      createdAt: ts(new Date('2026-05-20')),
      notes: 'ชำระหนี้ Order #1120',
    },
    {
      id: 'cpay-2',
      customerId: 'cust-m003',
      amount: 3500,
      paymentMethod: 'cash',
      createdAt: ts(new Date('2026-05-10')),
      notes: 'ชำระหนี้ Order #1098',
    },
    {
      id: 'cpay-3',
      customerId: 'cust-m002',
      amount: 2000,
      paymentMethod: 'transfer',
      createdAt: ts(new Date('2026-05-18')),
      notes: 'รับชำระที่เคาน์เตอร์',
    },
  ];
}

function seedOrders(): void {
  const mk = (
    id: string,
    customerId: string,
    name: string,
    phone: string,
    total: number,
    credit: number,
    status: Order['status'],
    d: Date,
  ): Order => ({
    id,
    billId: id,
    branchId: 'LDP-001',
    customerId,
    customerSnap: { name, phone, taxId: null },
    staffId: 'dev-suda',
    staffName: 'สุดา',
    status,
    subtotal: total,
    discountAmt: 0,
    billDiscount: 0,
    vatRate: 0,
    vatAmt: 0,
    surcharge: 0,
    total,
    paidAmt: credit > 0 ? 0 : total,
    changeAmt: 0,
    creditAmt: credit,
    priceLevelId: 'WHOLESALE1',
    note: '',
    voidReason: null,
    voidedBy: null,
    voidedAt: null,
    printCount: 1,
    createdAt: ts(d),
    updatedAt: ts(d),
  });

  devOrders = [
    mk('TW-1234', 'cust-m003', 'น้ำ แก้วกานต์', '081-234-5678', 759, 0, 'completed', new Date('2026-05-23')),
    mk('TW-1220', 'cust-m003', 'น้ำ แก้วกานต์', '081-234-5678', 2058, 0, 'completed', new Date('2026-05-15')),
    mk('TW-1210', 'cust-m003', 'น้ำ แก้วกานต์', '081-234-5678', 816, 0, 'completed', new Date('2026-05-10')),
    mk('TW-1198', 'cust-m003', 'น้ำ แก้วกานต์', '081-234-5678', 2400, 2400, 'pending_payment', new Date('2026-05-01')),
    mk('TW-1185', 'cust-m003', 'น้ำ แก้วกานต์', '081-234-5678', 1100, 0, 'completed', new Date('2026-04-20')),
    mk('TW-1170', 'cust-m003', 'น้ำ แก้วกานต์', '081-234-5678', 3400, 0, 'completed', new Date('2026-04-10')),
    mk('TW-1155', 'cust-m003', 'น้ำ แก้วกานต์', '081-234-5678', 1299, 0, 'voided', new Date('2026-04-01')),
    mk('TW-1140', 'cust-m003', 'น้ำ แก้วกานต์', '081-234-5678', 1116, 0, 'completed', new Date('2026-03-20')),
    mk('TW-0561', 'cust-m001', 'สมชาย มีชัย', '089-876-5432', 759, 0, 'completed', new Date('2026-05-18')),
  ];
}

export function initDevCustomers(): void {
  if (devCustomers) return;
  devCustomers = seedCustomers();
  seedCredit();
  seedOrders();
}

export function getDevCustomers(): Customer[] {
  initDevCustomers();
  return devCustomers!.filter((c) => !c.deletedAt);
}

export function getDevPriceLevels(): PriceLevel[] {
  return DEV_PRICE_LEVELS;
}

export function getDevCreditAccount(customerId: string): CreditAccount | null {
  initDevCustomers();
  return devCreditAccounts.get(customerId) ?? null;
}

export function getDevCreditTransactions(customerId: string): CreditTransaction[] {
  initDevCustomers();
  return devCreditTx
    .filter((t) => t.customerId === customerId)
    .sort((a, b) => b.createdAt.toDate().getTime() - a.createdAt.toDate().getTime());
}

export function getDevCustomerOrders(customerId: string): Order[] {
  initDevCustomers();
  return devOrders
    .filter((o) => o.customerId === customerId)
    .sort((a, b) => b.createdAt.toDate().getTime() - a.createdAt.toDate().getTime());
}

export function devSaveCustomer(customer: Customer, creditAccount?: CreditAccount | null): Customer {
  initDevCustomers();
  const idx = devCustomers!.findIndex((c) => c.id === customer.id);
  if (idx >= 0) devCustomers![idx] = customer;
  else devCustomers!.push(customer);

  if (creditAccount) {
    devCreditAccounts.set(customer.id, creditAccount);
  } else if (customer.creditLimit <= 0) {
    devCreditAccounts.delete(customer.id);
  }
  return customer;
}

export function devSoftDeleteCustomer(customerId: string): void {
  initDevCustomers();
  const c = devCustomers!.find((x) => x.id === customerId);
  if (c) {
    c.deletedAt = now;
    c.isActive = false;
    c.updatedAt = now;
  }
}

export function devApplyCrmAfterSale(
  customerId: string,
  grandTotal: number,
): { pointsEarned: number } | null {
  initDevCustomers();
  const idx = devCustomers!.findIndex((c) => c.id === customerId && !c.deletedAt);
  if (idx < 0) return null;

  const existing = devCustomers![idx]!;
  const updated = applyCrmSaleLocally(existing, grandTotal);
  devCustomers![idx] = {
    ...existing,
    lifetimeValue: updated.lifetimeValue,
    totalSpent: updated.totalSpent,
    points: updated.points,
    lastVisitAt: Timestamp.now(),
    updatedAt: now,
  };
  return { pointsEarned: updated.pointsEarned };
}

export function devGenerateMemberNo(): string {
  return `M${String(nextMember++).padStart(6, '0')}`;
}

export function devGenerateCustomerId(): string {
  return `cust-${Date.now()}`;
}

export function devPayCredit(
  customerId: string,
  branchId: string,
  amount: number,
  method: string,
  note: string,
  createdBy: string,
): CreditAccount {
  devReceiveCreditPayment(
    customerId,
    branchId,
    amount,
    method === 'เงินสด' || method === 'cash' ? 'cash' : 'transfer',
    note,
    createdBy,
  );
  const account = getDevCreditAccount(customerId);
  if (!account) throw new Error('ไม่พบบัญชีเชื่อของลูกค้า');
  return account;
}

export function devReceiveCreditPayment(
  customerId: string,
  branchId: string,
  amount: number,
  paymentMethod: 'cash' | 'transfer',
  note: string,
  createdBy: string,
  _shiftId?: string,
  paymentDate?: Date,
): number {
  initDevCustomers();
  const customerIdx = devCustomers!.findIndex((c) => c.id === customerId);
  if (customerIdx < 0) throw new Error('ไม่พบข้อมูลลูกค้า');

  const customer = devCustomers![customerIdx]!;
  const account = devCreditAccounts.get(customerId);
  const currentBalance = customer.outstandingBalance ?? account?.creditUsed ?? 0;
  const pay = Math.min(amount, currentBalance);
  if (pay <= 0) throw new Error('ไม่มียอดค้างชำระ');
  if (amount > currentBalance) throw new Error('ยอดชำระเกินหนี้ค้างชำระ');

  const paidAt = paymentDate ? ts(paymentDate) : now;

  const newOutstanding = currentBalance - pay;
  devCustomers![customerIdx] = {
    ...customer,
    outstandingBalance: newOutstanding,
    lastPaymentDate: paidAt,
    updatedAt: paidAt,
  };

  if (account) {
    account.creditUsed = newOutstanding;
    account.creditBalance = account.creditLimit - newOutstanding;
    account.lastTransAt = paidAt;
    account.updatedAt = paidAt;
    devCreditAccounts.set(customerId, account);
  }

  devCreditTx.unshift({
    id: `ctx-${Date.now()}`,
    customerId,
    branchId,
    type: 'payment',
    amount: pay,
    balance: account?.creditBalance ?? newOutstanding,
    refOrderId: null,
    note: note || `รับชำระหนี้ — ${paymentMethod === 'cash' ? 'เงินสด' : 'โอนเงิน'}`,
    createdBy,
    createdAt: paidAt,
    dueDate: null,
    isPaid: true,
    paidAt,
  });

  devCreditPayments.unshift({
    id: `cpay-${Date.now()}`,
    customerId,
    amount: pay,
    paymentMethod,
    createdAt: paidAt,
    notes: note || '',
    ...( _shiftId ? { shiftId: _shiftId } : {}),
  });

  if (_shiftId) {
    devApplyCreditPaymentToShift(_shiftId, paymentMethod, pay);
  }

  return newOutstanding;
}

export function devApplyCreditCharge(
  customerId: string,
  branchId: string,
  creditAmt: number,
  orderId: string,
  createdBy: string,
): number {
  initDevCustomers();
  const customerIdx = devCustomers!.findIndex((c) => c.id === customerId);
  if (customerIdx < 0) throw new Error('ไม่พบข้อมูลลูกค้า');

  const customer = devCustomers![customerIdx]!;
  let account = devCreditAccounts.get(customerId);
  if (!account && customer.creditLimit > 0) {
    account = {
      customerId,
      branchId,
      creditLimit: customer.creditLimit,
      creditUsed: 0,
      creditBalance: customer.creditLimit,
      overdueAmt: 0,
      lastTransAt: null,
      updatedAt: now,
    };
    devCreditAccounts.set(customerId, account);
  }
  if (!account) throw new Error('ไม่พบบัญชีเชื่อของลูกค้า');

  const currentBalance = customer.outstandingBalance ?? account.creditUsed;
  const newOutstanding = currentBalance + creditAmt;
  if (newOutstanding > account.creditLimit) {
    throw new Error('ยอดเชื่อเกินวงเงินที่กำหนด');
  }

  account.creditUsed = newOutstanding;
  account.creditBalance = account.creditLimit - newOutstanding;
  account.lastTransAt = now;
  account.updatedAt = now;
  devCreditAccounts.set(customerId, account);

  devCustomers![customerIdx] = {
    ...customer,
    outstandingBalance: newOutstanding,
    lastCreditPurchaseDate: now,
    updatedAt: now,
  };

  devCreditTx.unshift({
    id: `ctx-${Date.now()}`,
    customerId,
    branchId,
    type: 'charge',
    amount: creditAmt,
    balance: account.creditBalance,
    refOrderId: orderId,
    note: '',
    createdBy,
    createdAt: now,
    dueDate: null,
    isPaid: false,
    paidAt: null,
  });

  return newOutstanding;
}

export function getDevDebtors(branchId: string): Customer[] {
  initDevCustomers();
  return getDevCustomers()
    .filter(
      (c) =>
        c.branchId === branchId &&
        !c.deletedAt &&
        (c.outstandingBalance ?? 0) > 0,
    )
    .sort((a, b) => (b.outstandingBalance ?? 0) - (a.outstandingBalance ?? 0));
}

export function getDevCreditPayments(branchId: string): CreditPaymentTransaction[] {
  initDevCustomers();
  const customerIds = new Set(
    getDevCustomers().filter((c) => c.branchId === branchId).map((c) => c.id),
  );
  return devCreditPayments
    .filter((p) => customerIds.has(p.customerId))
    .sort(
      (a, b) =>
        b.createdAt.toDate().getTime() - a.createdAt.toDate().getTime(),
    );
}

export function getDevCustomerCreditPayments(customerId: string): CreditPaymentTransaction[] {
  initDevCustomers();
  return devCreditPayments
    .filter((p) => p.customerId === customerId)
    .sort(
      (a, b) =>
        b.createdAt.toDate().getTime() - a.createdAt.toDate().getTime(),
    );
}

export const DEV_TOP_PRODUCTS: Record<string, Array<{ name: string; sku: string; qty: number; revenue: number }>> = {
  'cust-m003': [
    { name: 'Royal Canin Mini Indoor Senior 3kg', sku: 'SKU002', qty: 12, revenue: 12348 },
    { name: 'Smart Heart อาหารลูกสุนัข 8kg', sku: 'SKU004', qty: 8, revenue: 6072 },
    { name: 'Hill\'s Science Diet สุนัขสูงอายุ 7+', sku: 'SKU001', qty: 5, revenue: 12000 },
    { name: 'Jerhigh ฮอทดอกบาร์ รสไก่ 150g', sku: 'SKU005', qty: 24, revenue: 1080 },
    { name: 'Nekko Kitten อาหารเปียก 70g', sku: 'SKU012', qty: 36, revenue: 720 },
  ],
};
