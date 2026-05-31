import type { Order, OrderItem, Payment, PaymentMethod } from '../types';
import { formatReceiptNumber } from '../pos/billId';
import type { SaleRecord } from './types';

function ts(date: Date): Order['createdAt'] {
  return { toDate: () => date } as Order['createdAt'];
}

function pay(
  orderId: string,
  branchId: string,
  method: PaymentMethod,
  amount: number,
  idx: number,
): Payment {
  return {
    id: `pay-${orderId}-${idx}`,
    orderId,
    branchId,
    method,
    amount,
    ref: null,
    createdAt: ts(new Date()) as Payment['createdAt'],
  };
}

function item(
  id: string,
  productId: string,
  name: string,
  sku: string,
  qty: number,
  unitPrice: number,
  discountAmt: number,
): OrderItem {
  const lineTotal = unitPrice * qty - discountAmt;
  return {
    id,
    productId,
    productSnap: { name, sku, category: '' },
    unit: 'ชิ้น',
    unitFactor: 1,
    qty,
    qtyBase: qty,
    unitPrice,
    discountAmt,
    lineTotal,
    fifoCost: lineTotal * 0.65,
    lotRefs: [{ lotId: `lot-${productId}`, qty, cost: unitPrice * 0.65 }],
  };
}

type MockRow = {
  id: string;
  billId?: string;
  h: number;
  m: number;
  customer: { name: string; phone: string; tier: string } | null;
  payments: Array<{ method: PaymentMethod; amount: number }>;
  staff: string;
  billDiscount: number;
  fee: number;
  status: Order['status'];
  voidReason?: string;
  items: Array<{ sku: string; name: string; qty: number; price: number; disc: number }>;
};

const ROWS: MockRow[] = [
  {
    id: 'ORD-2026-0012',
    billId: 'RCP-260526-0012',
    h: 17,
    m: 45,
    customer: { name: 'น้ำ แก้วกานต์', phone: '081-234-5678', tier: 'Wholesale 1' },
    payments: [{ method: 'kbank', amount: 2058 }],
    staff: 'ชนิษา',
    billDiscount: 0,
    fee: 0,
    status: 'completed',
    items: [
      { sku: 'SKU002', name: 'Royal Canin Mini Indoor Senior 3kg', qty: 2, price: 1029, disc: 0 },
      { sku: 'SKU012', name: 'Nekko Kitten อาหารเปียก 70g', qty: 3, price: 25, disc: 5 },
    ],
  },
  {
    id: 'ORD-2026-0011',
    h: 16,
    m: 30,
    customer: { name: 'สมชาย มีชัย', phone: '089-876-5432', tier: 'Retail' },
    payments: [{ method: 'cash', amount: 759 }],
    staff: 'สมชาย',
    billDiscount: 50,
    fee: 0,
    status: 'completed',
    items: [{ sku: 'SKU004', name: 'Smart Heart อาหารลูกสุนัข 8kg', qty: 1, price: 759, disc: 50 }],
  },
  {
    id: 'ORD-2026-0010',
    h: 15,
    m: 12,
    customer: { name: 'วิไล พงษ์ศรี', phone: '062-111-2233', tier: 'Wholesale 2' },
    payments: [{ method: 'credit', amount: 5480 }],
    staff: 'ชนิษา',
    billDiscount: 100,
    fee: 0,
    status: 'pending_payment',
    items: [
      { sku: 'SKU001', name: "Hill's Science Diet สุนัขสูงอายุ 7+", qty: 2, price: 2400, disc: 0 },
      { sku: 'SKU009', name: 'Orijen สูตรแมวเด็กและแมวโต 1.8kg', qty: 1, price: 1100, disc: 100 },
      { sku: 'SKU010', name: 'Boltz ของเล่นแมว', qty: 3, price: 149, disc: 0 },
    ],
  },
  {
    id: 'ORD-2026-0009',
    h: 14,
    m: 55,
    customer: null,
    payments: [{ method: 'cash', amount: 197 }],
    staff: 'สมชาย',
    billDiscount: 0,
    fee: 0,
    status: 'completed',
    items: [{ sku: 'SKU006', name: 'Biscal ขนมคุกกี้สุนัข สูตรชีส 60g', qty: 1, price: 197, disc: 0 }],
  },
  {
    id: 'ORD-2026-0008',
    h: 14,
    m: 20,
    customer: { name: 'มนัส ศรีสุข', phone: '091-555-6677', tier: 'Retail' },
    payments: [
      { method: 'cash', amount: 250 },
      { method: 'kbank', amount: 250 },
    ],
    staff: 'ชนิษา',
    billDiscount: 0,
    fee: 15,
    status: 'completed',
    items: [
      { sku: 'SKU005', name: 'Jerhigh ฮอทดอกบาร์ รสไก่ 150g', qty: 5, price: 45, disc: 0 },
      { sku: 'SKU007', name: 'Pedigree เดนตาสติก', qty: 1, price: 199, disc: 0 },
      { sku: 'SKU012', name: 'Nekko Kitten อาหารเปียก 70g', qty: 6, price: 25, disc: 0 },
    ],
  },
  {
    id: 'ORD-2026-0007',
    h: 13,
    m: 5,
    customer: { name: 'น้ำ แก้วกานต์', phone: '081-234-5678', tier: 'Wholesale 1' },
    payments: [{ method: 'card', amount: 890 }],
    staff: 'สมชาย',
    billDiscount: 0,
    fee: 27,
    status: 'completed',
    items: [{ sku: 'SKU008', name: 'Kaniva อาหารแมวโต รสแกะทูน่า 8kg', qty: 1, price: 890, disc: 0 }],
  },
  {
    id: 'ORD-2026-0006',
    h: 11,
    m: 45,
    customer: { name: 'อรนุช ทองดี', phone: '085-999-0011', tier: 'Retail' },
    payments: [{ method: 'qr', amount: 1100 }],
    staff: 'ชนิษา',
    billDiscount: 0,
    fee: 0,
    status: 'completed',
    items: [{ sku: 'SKU009', name: 'Orijen สูตรแมวเด็กและแมวโต 1.8kg', qty: 1, price: 1100, disc: 0 }],
  },
  {
    id: 'ORD-2026-0005',
    h: 11,
    m: 20,
    customer: null,
    payments: [{ method: 'cash', amount: 429 }],
    staff: 'สมชาย',
    billDiscount: 0,
    fee: 0,
    status: 'voided',
    voidReason: 'ทดสอบระบบ',
    items: [
      { sku: 'SKU003', name: 'Maxima อาหารเปียก 380g', qty: 3, price: 79, disc: 0 },
      { sku: 'SKU005', name: 'Jerhigh ฮอทดอกบาร์', qty: 4, price: 45, disc: 0 },
    ],
  },
  {
    id: 'ORD-2026-0004',
    h: 10,
    m: 30,
    customer: { name: 'สุดา รักสะอาด', phone: '098-444-5566', tier: 'Retail' },
    payments: [{ method: 'cash', amount: 720 }],
    staff: 'ชนิษา',
    billDiscount: 0,
    fee: 0,
    status: 'completed',
    items: [
      { sku: 'SKU001', name: "Hill's Science Diet สุนัขสูงอายุ 7+", qty: 1, price: 2400, disc: 0 },
      { sku: 'SKU005', name: 'Jerhigh ฮอทดอกบาร์', qty: 5, price: 45, disc: 0 },
    ],
  },
  {
    id: 'ORD-2026-0003',
    h: 9,
    m: 55,
    customer: { name: 'ไพบูลย์ ชัยชนะ', phone: '063-777-8899', tier: 'Wholesale 1' },
    payments: [{ method: 'credit', amount: 3990 }],
    staff: 'สมชาย',
    billDiscount: 200,
    fee: 0,
    status: 'pending_payment',
    items: [
      { sku: 'SKU001', name: "Hill's Science Diet สุนัขสูงอายุ 7+", qty: 1, price: 2400, disc: 200 },
      { sku: 'SKU002', name: 'Royal Canin Mini Indoor Senior 3kg', qty: 2, price: 1029, disc: 0 },
    ],
  },
  {
    id: 'ORD-2026-0002',
    h: 9,
    m: 20,
    customer: null,
    payments: [{ method: 'cash', amount: 236 }],
    staff: 'ชนิษา',
    billDiscount: 0,
    fee: 0,
    status: 'completed',
    items: [{ sku: 'SKU003', name: 'Maxima อาหารเปียก 380g', qty: 3, price: 79, disc: 0 }],
  },
  {
    id: 'ORD-2026-0001',
    h: 8,
    m: 45,
    customer: { name: 'น้ำ แก้วกานต์', phone: '081-234-5678', tier: 'Wholesale 1' },
    payments: [{ method: 'cash', amount: 350 }],
    staff: 'สมชาย',
    billDiscount: 0,
    fee: 0,
    status: 'voided',
    voidReason: 'ลูกค้าเปลี่ยนใจ',
    items: [{ sku: 'SKU011', name: 'Fresh Step กรายแมวก้อน 20L', qty: 1, price: 399, disc: 0 }],
  },
];

function buildRecord(row: MockRow, branchId: string, seq: number): SaleRecord {
  const today = new Date();
  today.setHours(row.h, row.m, 0, 0);

  const orderItems = row.items.map((it, idx) =>
    item(`${row.id}-item-${idx}`, it.sku, it.name, it.sku, it.qty, it.price, it.disc),
  );

  const lineDiscount = orderItems.reduce((s, i) => s + i.discountAmt, 0);
  const subtotal = orderItems.reduce((s, i) => s + i.unitPrice * i.qty, 0);
  const discountAmt = lineDiscount;
  const total = Math.max(0, subtotal - discountAmt - row.billDiscount + row.fee);
  const paidAmt = row.payments.reduce((s, p) => s + p.amount, 0);
  const creditAmt = row.payments
    .filter((p) => p.method === 'credit')
    .reduce((s, p) => s + p.amount, 0);

  const billId = row.billId ?? formatReceiptNumber('RCP', today, seq, 4);

  const order: Order = {
    id: row.id,
    billId,
    branchId,
    customerId: row.customer ? `cust-${row.id}` : null,
    customerSnap: row.customer
      ? { name: row.customer.name, phone: row.customer.phone, taxId: null }
      : null,
    staffId: 'dev-staff',
    staffName: row.staff,
    status: row.status,
    subtotal,
    discountAmt,
    billDiscount: row.billDiscount,
    vatRate: 0,
    vatAmt: 0,
    surcharge: row.fee,
    total,
    paidAmt,
    changeAmt: Math.max(0, paidAmt - total),
    creditAmt,
    priceLevelId: row.customer?.tier ?? 'retail',
    note: '',
    voidReason: row.voidReason ?? null,
    voidedBy: row.status === 'voided' ? 'dev-staff' : null,
    voidedAt: row.status === 'voided' ? ts(today) : null,
    printCount: 0,
    createdAt: ts(today),
    updatedAt: ts(today),
  };

  const payments = row.payments.map((p, idx) => pay(row.id, branchId, p.method, p.amount, idx));

  return { order, payments, items: orderItems };
}

let devRecords: SaleRecord[] = [];

export function getDevSalesRecords(branchId: string): SaleRecord[] {
  if (!devRecords.length || devRecords[0]?.order.branchId !== branchId) {
    devRecords = ROWS.map((row, idx) => buildRecord(row, branchId, idx + 1));
  }
  return devRecords;
}

export function voidDevOrder(orderId: string, reason: string, voidedBy: string): void {
  devRecords = devRecords.map((rec) => {
    if (rec.order.id !== orderId || rec.order.status === 'voided') return rec;
    const now = new Date();
    return {
      ...rec,
      order: {
        ...rec.order,
        status: 'voided',
        voidReason: reason,
        voidedBy,
        voidedAt: ts(now),
        updatedAt: ts(now),
      },
    };
  });
}

export function resetDevSalesRecords(branchId: string): SaleRecord[] {
  devRecords = ROWS.map((row, idx) => buildRecord(row, branchId, idx + 1));
  return devRecords;
}
