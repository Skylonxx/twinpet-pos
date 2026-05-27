import type { PaymentMethod } from '../types';
import type { DashboardPaymentRecord, DashboardSaleLine, StockMapEntry } from './types';

const PRODUCTS = [
  { id: '1', name: 'Royal Canin Adult 3kg', cat: 'อาหารสุนัข', reorder: 20 },
  { id: '2', name: 'Hills Science Diet Cat', cat: 'อาหารแมว', reorder: 20 },
  { id: '3', name: 'Whiskas Tuna 85g (24pc)', cat: 'อาหารแมว', reorder: 12 },
  { id: '4', name: 'Purina Pro Plan Puppy', cat: 'อาหารสุนัข', reorder: 15 },
  { id: '5', name: 'Pedigree Dentastix', cat: 'อาหารสุนัข', reorder: 10 },
  { id: '6', name: 'Cat Scratcher Deluxe', cat: 'ของเล่น', reorder: 5 },
  { id: '7', name: 'Frontline Plus Dog L', cat: 'ยาและวิตามิน', reorder: 8 },
  { id: '8', name: 'Catit Water Fountain', cat: 'อุปกรณ์', reorder: 4 },
  { id: '9', name: 'Petsafe Clicker', cat: 'ของเล่น', reorder: 5 },
  { id: '10', name: 'Tidy Cats Clumping 8kg', cat: 'ทรายแมว', reorder: 20 },
  { id: '11', name: 'NexGard Chewable M', cat: 'ยาและวิตามิน', reorder: 8 },
  { id: '12', name: 'Rolf Club 3D Collar Cat', cat: 'อุปกรณ์', reorder: 6 },
] as const;

const STOCK: Record<string, number> = {
  '1': 48,
  '2': 15,
  '3': 6,
  '4': 32,
  '5': 0,
  '6': 8,
  '7': 22,
  '8': 3,
  '9': 18,
  '10': 40,
  '11': 5,
  '12': 11,
};

type RawSale = {
  date: string;
  h: number;
  bill: string;
  prodId: string;
  qty: number;
  rev: number;
  cogs: number;
  cust: string;
  pay: PaymentMethod;
};

const RAW: RawSale[] = [
  { date: '2026-05-24', h: 9, bill: 'TW-0583', prodId: '1', qty: 5, rev: 2400, cogs: 1600, cust: 'คุณมาลี สุขใจ', pay: 'card' },
  { date: '2026-05-24', h: 9, bill: 'TW-0583', prodId: '4', qty: 2, rev: 1040, cogs: 824, cust: 'คุณมาลี สุขใจ', pay: 'card' },
  { date: '2026-05-24', h: 10, bill: 'TW-0584', prodId: '6', qty: 2, rev: 440, cogs: 360, cust: 'สมาชิกทั่วไป', pay: 'qr' },
  { date: '2026-05-24', h: 11, bill: 'TW-0585', prodId: '10', qty: 4, rev: 920, cogs: 728, cust: 'คุณวิชัย เก่งมาก', pay: 'cash' },
  { date: '2026-05-24', h: 14, bill: 'TW-0586', prodId: '9', qty: 3, rev: 285, cogs: 225, cust: 'คุณสุดา เจริญ', pay: 'kbank' },
  { date: '2026-05-24', h: 16, bill: 'TW-0587', prodId: '12', qty: 1, rev: 160, cogs: 120, cust: 'สมาชิกทั่วไป', pay: 'cash' },
  { date: '2026-05-24', h: 16, bill: 'TW-0587', prodId: '7', qty: 1, rev: 250, cogs: 195, cust: 'คุณอนุชา บุญมา', pay: 'cash' },
  // Split-payment bill: cash + QR on same order
  { date: '2026-05-24', h: 13, bill: 'TW-0588', prodId: '2', qty: 2, rev: 720, cogs: 560, cust: 'คุณพรทิพย์ สง่างาม', pay: 'cash' },
  { date: '2026-05-24', h: 13, bill: 'TW-0588', prodId: '4', qty: 1, rev: 520, cogs: 405, cust: 'คุณพรทิพย์ สง่างาม', pay: 'qr' },
  { date: '2026-05-18', h: 9, bill: 'TW-0561', prodId: '1', qty: 2, rev: 960, cogs: 630, cust: 'คุณมาลี สุขใจ', pay: 'card' },
  { date: '2026-05-18', h: 11, bill: 'TW-0562', prodId: '2', qty: 1, rev: 360, cogs: 280, cust: 'คุณวิชัย เก่งมาก', pay: 'cash' },
  { date: '2026-05-19', h: 9, bill: 'TW-0564', prodId: '4', qty: 1, rev: 520, cogs: 405, cust: 'คุณอนุชา บุญมา', pay: 'qr' },
  { date: '2026-05-19', h: 10, bill: 'TW-0565', prodId: '3', qty: 5, rev: 600, cogs: 460, cust: 'คุณพรทิพย์ สง่างาม', pay: 'cash' },
  { date: '2026-05-20', h: 9, bill: 'TW-0568', prodId: '5', qty: 5, rev: 375, cogs: 275, cust: 'คุณสมหมาย รักดี', pay: 'kbank' },
  { date: '2026-05-20', h: 11, bill: 'TW-0569', prodId: '8', qty: 1, rev: 820, cogs: 650, cust: 'คุณวิชัย เก่งมาก', pay: 'card' },
  { date: '2026-05-21', h: 10, bill: 'TW-0572', prodId: '2', qty: 2, rev: 720, cogs: 570, cust: 'คุณอนุชา บุญมา', pay: 'credit' },
  { date: '2026-05-21', h: 12, bill: 'TW-0573', prodId: '4', qty: 2, rev: 1040, cogs: 824, cust: 'คุณพรทิพย์ สง่างาม', pay: 'card' },
  { date: '2026-05-22', h: 9, bill: 'TW-0576', prodId: '7', qty: 3, rev: 750, cogs: 585, cust: 'คุณวิชัย เก่งมาก', pay: 'cash' },
  { date: '2026-05-22', h: 11, bill: 'TW-0577', prodId: '1', qty: 3, rev: 1440, cogs: 960, cust: 'คุณมาลี สุขใจ', pay: 'qr' },
  { date: '2026-05-23', h: 8, bill: 'TW-0580', prodId: '11', qty: 2, rev: 620, cogs: 480, cust: 'คุณอนุชา บุญมา', pay: 'credit' },
  { date: '2026-05-23', h: 15, bill: 'TW-0582', prodId: '3', qty: 6, rev: 720, cogs: 552, cust: 'คุณณัฐ วงศ์ดี', pay: 'kbank' },
];

function parseDate(date: string, hour: number): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!, hour, 0, 0, 0);
}

export function getDevDashboardPayments(): DashboardPaymentRecord[] {
  const byBillMethod = new Map<
    string,
    { method: PaymentMethod; amount: number; date: string; h: number }
  >();

  for (const r of RAW) {
    const key = `${r.bill}::${r.pay}`;
    const existing = byBillMethod.get(key);
    if (!existing) {
      byBillMethod.set(key, { method: r.pay, amount: r.rev, date: r.date, h: r.h });
    } else {
      existing.amount += r.rev;
    }
  }

  return [...byBillMethod.entries()].map(([key, v]) => ({
    orderId: key.split('::')[0]!,
    method: v.method,
    amount: v.amount,
    createdAt: parseDate(v.date, v.h),
  }));
}

export function getDevDashboardSaleLines(): DashboardSaleLine[] {
  return RAW.map((r) => {
    const product = PRODUCTS.find((p) => p.id === r.prodId);
    return {
      orderId: r.bill,
      createdAt: parseDate(r.date, r.h),
      productId: r.prodId,
      productName: product?.name ?? r.prodId,
      category: product?.cat ?? 'อื่นๆ',
      customerName: r.cust,
      revenue: r.rev,
      cogs: r.cogs,
      qty: r.qty,
      paymentMethod: r.pay,
    };
  });
}

export function getDevStockByProduct(): Map<string, StockMapEntry> {
  const map = new Map<string, StockMapEntry>();
  for (const p of PRODUCTS) {
    map.set(p.id, { qty: STOCK[p.id] ?? 0, reorderPoint: p.reorder, name: p.name });
  }
  return map;
}

/** Fixed "now" aligned with mock data */
export function getDevDashboardNow(): Date {
  return new Date(2026, 4, 24, 17, 0, 0, 0);
}
