import { productVisual } from '../stockReport/types';
import type { ProfitProduct, ProfitSaleLine } from './types';

export const DEV_CATEGORIES = [
  'อาหารสุนัข',
  'อาหารแมว',
  'ของเล่น',
  'ยาและวิตามิน',
  'อุปกรณ์',
  'ทรายแมว',
];

const PRODUCTS: ProfitProduct[] = [
  { id: '1', name: 'Royal Canin Adult 3kg', sku: 'RC-A3', category: 'อาหารสุนัข', emoji: '🐕', iconBg: '#EEEDFE', imageUrl: null },
  { id: '2', name: 'Hills Science Diet Cat', sku: 'HS-C1', category: 'อาหารแมว', emoji: '🐈', iconBg: '#E1F5EE', imageUrl: null },
  { id: '3', name: 'Whiskas Tuna 85g (24pc)', sku: 'WK-T24', category: 'อาหารแมว', emoji: '🐟', iconBg: '#E1F5EE', imageUrl: null },
  { id: '4', name: 'Purina Pro Plan Puppy', sku: 'PP-PUP', category: 'อาหารสุนัข', emoji: '🐶', iconBg: '#EEEDFE', imageUrl: null },
  { id: '5', name: 'Pedigree Dentastix', sku: 'PD-DX', category: 'อาหารสุนัข', emoji: '🦴', iconBg: '#EEEDFE', imageUrl: null },
  { id: '6', name: 'Cat Scratcher Deluxe', sku: 'CS-DX', category: 'ของเล่น', emoji: '🧸', iconBg: '#FAEEDA', imageUrl: null },
  { id: '7', name: 'Frontline Plus Dog L', sku: 'FL-DL', category: 'ยาและวิตามิน', emoji: '💊', iconBg: '#FCEBEB', imageUrl: null },
  { id: '8', name: 'Catit Water Fountain', sku: 'CW-F1', category: 'อุปกรณ์', emoji: '💧', iconBg: '#E6F1FB', imageUrl: null },
  { id: '9', name: 'Petsafe Clicker', sku: 'PC-CL', category: 'ของเล่น', emoji: '🔔', iconBg: '#FAEEDA', imageUrl: null },
  { id: '10', name: 'Tidy Cats Clumping 8kg', sku: 'TC-C8', category: 'ทรายแมว', emoji: '🪣', iconBg: '#F1EFE8', imageUrl: null },
  { id: '11', name: 'NexGard Chewable M', sku: 'NG-M', category: 'ยาและวิตามิน', emoji: '💊', iconBg: '#FCEBEB', imageUrl: null },
  { id: '12', name: 'Rolf Club 3D Collar Cat', sku: 'RC-CC', category: 'อุปกรณ์', emoji: '🎀', iconBg: '#FBEAF0', imageUrl: null },
];

type RawSale = {
  date: string;
  time: string;
  bill: string;
  prodId: string;
  qty: number;
  salePrice: number;
  fifoCost: number;
  customer: string;
};

const SALES_RAW: RawSale[] = [
  { date: '2026-05-18', time: '09:15', bill: 'TW-0561', prodId: '1', qty: 2, salePrice: 480, fifoCost: 315, customer: 'คุณมาลี สุขใจ' },
  { date: '2026-05-18', time: '09:15', bill: 'TW-0561', prodId: '5', qty: 3, salePrice: 75, fifoCost: 55, customer: 'คุณมาลี สุขใจ' },
  { date: '2026-05-18', time: '11:30', bill: 'TW-0562', prodId: '2', qty: 1, salePrice: 360, fifoCost: 280, customer: 'คุณวิชัย เก่งมาก' },
  { date: '2026-05-18', time: '11:30', bill: 'TW-0562', prodId: '9', qty: 4, salePrice: 95, fifoCost: 75, customer: 'คุณวิชัย เก่งมาก' },
  { date: '2026-05-18', time: '14:00', bill: 'TW-0563', prodId: '10', qty: 2, salePrice: 230, fifoCost: 182, customer: 'คุณสุดา เจริญ' },
  { date: '2026-05-19', time: '08:50', bill: 'TW-0564', prodId: '4', qty: 1, salePrice: 520, fifoCost: 405, customer: 'คุณอนุชา บุญมา' },
  { date: '2026-05-19', time: '08:50', bill: 'TW-0564', prodId: '7', qty: 2, salePrice: 250, fifoCost: 190, customer: 'คุณอนุชา บุญมา' },
  { date: '2026-05-19', time: '10:20', bill: 'TW-0565', prodId: '3', qty: 5, salePrice: 120, fifoCost: 92, customer: 'คุณพรทิพย์ สง่างาม' },
  { date: '2026-05-19', time: '13:45', bill: 'TW-0566', prodId: '6', qty: 1, salePrice: 220, fifoCost: 180, customer: 'คุณณัฐ วงศ์ดี' },
  { date: '2026-05-19', time: '15:30', bill: 'TW-0567', prodId: '11', qty: 1, salePrice: 310, fifoCost: 240, customer: 'คุณมาลี สุขใจ' },
  { date: '2026-05-20', time: '09:00', bill: 'TW-0568', prodId: '5', qty: 5, salePrice: 75, fifoCost: 55, customer: 'คุณสมหมาย รักดี' },
  { date: '2026-05-20', time: '09:00', bill: 'TW-0568', prodId: '1', qty: 1, salePrice: 480, fifoCost: 320, customer: 'คุณสมหมาย รักดี' },
  { date: '2026-05-20', time: '11:00', bill: 'TW-0569', prodId: '8', qty: 1, salePrice: 820, fifoCost: 650, customer: 'คุณวิชัย เก่งมาก' },
  { date: '2026-05-20', time: '14:30', bill: 'TW-0570', prodId: '12', qty: 2, salePrice: 160, fifoCost: 120, customer: 'คุณสุดา เจริญ' },
  { date: '2026-05-20', time: '16:00', bill: 'TW-0571', prodId: '11', qty: 3, salePrice: 310, fifoCost: 240, customer: 'คุณมาลี สุขใจ' },
  { date: '2026-05-21', time: '10:10', bill: 'TW-0572', prodId: '2', qty: 2, salePrice: 360, fifoCost: 285, customer: 'คุณอนุชา บุญมา' },
  { date: '2026-05-21', time: '10:10', bill: 'TW-0572', prodId: '3', qty: 3, salePrice: 120, fifoCost: 95, customer: 'คุณอนุชา บุญมา' },
  { date: '2026-05-21', time: '12:30', bill: 'TW-0573', prodId: '4', qty: 2, salePrice: 520, fifoCost: 412, customer: 'คุณพรทิพย์ สง่างาม' },
  { date: '2026-05-21', time: '15:00', bill: 'TW-0574', prodId: '9', qty: 6, salePrice: 95, fifoCost: 75, customer: 'สมาชิกทั่วไป' },
  { date: '2026-05-21', time: '17:00', bill: 'TW-0575', prodId: '6', qty: 2, salePrice: 220, fifoCost: 180, customer: 'คุณณัฐ วงศ์ดี' },
  { date: '2026-05-22', time: '09:30', bill: 'TW-0576', prodId: '7', qty: 3, salePrice: 250, fifoCost: 195, customer: 'คุณวิชัย เก่งมาก' },
  { date: '2026-05-22', time: '09:30', bill: 'TW-0576', prodId: '10', qty: 3, salePrice: 230, fifoCost: 185, customer: 'คุณวิชัย เก่งมาก' },
  { date: '2026-05-22', time: '11:45', bill: 'TW-0577', prodId: '1', qty: 3, salePrice: 480, fifoCost: 320, customer: 'คุณมาลี สุขใจ' },
  { date: '2026-05-22', time: '14:00', bill: 'TW-0578', prodId: '8', qty: 1, salePrice: 820, fifoCost: 645, customer: 'คุณสุดา เจริญ' },
  { date: '2026-05-22', time: '16:20', bill: 'TW-0579', prodId: '5', qty: 2, salePrice: 75, fifoCost: 55, customer: 'สมาชิกทั่วไป' },
  { date: '2026-05-23', time: '08:40', bill: 'TW-0580', prodId: '11', qty: 2, salePrice: 310, fifoCost: 240, customer: 'คุณอนุชา บุญมา' },
  { date: '2026-05-23', time: '08:40', bill: 'TW-0580', prodId: '7', qty: 1, salePrice: 250, fifoCost: 195, customer: 'คุณอนุชา บุญมา' },
  { date: '2026-05-23', time: '10:30', bill: 'TW-0581', prodId: '12', qty: 3, salePrice: 160, fifoCost: 120, customer: 'คุณพรทิพย์ สง่างาม' },
  { date: '2026-05-23', time: '13:00', bill: 'TW-0581', prodId: '2', qty: 1, salePrice: 360, fifoCost: 280, customer: 'คุณพรทิพย์ สง่างาม' },
  { date: '2026-05-23', time: '15:45', bill: 'TW-0582', prodId: '3', qty: 6, salePrice: 120, fifoCost: 92, customer: 'คุณณัฐ วงศ์ดี' },
  { date: '2026-05-24', time: '09:30', bill: 'TW-0583', prodId: '4', qty: 2, salePrice: 520, fifoCost: 412, customer: 'คุณมาลี สุขใจ' },
  { date: '2026-05-24', time: '09:30', bill: 'TW-0583', prodId: '1', qty: 5, salePrice: 480, fifoCost: 320, customer: 'คุณมาลี สุขใจ' },
  { date: '2026-05-24', time: '10:45', bill: 'TW-0584', prodId: '6', qty: 2, salePrice: 220, fifoCost: 180, customer: 'คุณสมหมาย รักดี' },
  { date: '2026-05-24', time: '11:20', bill: 'TW-0585', prodId: '10', qty: 4, salePrice: 230, fifoCost: 182, customer: 'คุณวิชัย เก่งมาก' },
  { date: '2026-05-24', time: '14:00', bill: 'TW-0586', prodId: '9', qty: 3, salePrice: 95, fifoCost: 75, customer: 'คุณสุดา เจริญ' },
  { date: '2026-05-24', time: '16:30', bill: 'TW-0587', prodId: '12', qty: 1, salePrice: 160, fifoCost: 120, customer: 'สมาชิกทั่วไป' },
];

function toLine(raw: RawSale, idx: number): ProfitSaleLine {
  const prod = PRODUCTS.find((p) => p.id === raw.prodId)!;
  const revenue = raw.qty * raw.salePrice;
  const cogs = raw.qty * raw.fifoCost;
  const profit = revenue - cogs;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  return {
    id: String(idx + 1),
    orderId: raw.bill,
    date: raw.date,
    time: raw.time,
    bill: raw.bill,
    customer: raw.customer,
    productId: prod.id,
    productName: prod.name,
    productSku: prod.sku,
    category: prod.category,
    emoji: prod.emoji,
    iconBg: prod.iconBg,
    imageUrl: prod.imageUrl ?? null,
    qty: raw.qty,
    salePrice: raw.salePrice,
    revenue,
    cogs,
    profit,
    margin,
  };
}

const DEV_LINES = SALES_RAW.map(toLine);

export function getDevProfitProducts(): ProfitProduct[] {
  return PRODUCTS;
}

export function getDevProfitLines(_branchId: string): ProfitSaleLine[] {
  return DEV_LINES;
}

export function orderToProfitLines(
  order: {
    id: string;
    billId?: string;
    customerSnap: { name: string } | null;
    createdAt: { toDate(): Date };
    status: string;
  },
  items: Array<{
    id: string;
    productId: string;
    productSnap: { name: string; sku: string; category: string };
    qty: number;
    unitPrice: number;
    lineTotal: number;
    fifoCost: number;
  }>,
): ProfitSaleLine[] {
  if (order.status === 'voided') return [];
  const created = order.createdAt.toDate();
  const date = created.toISOString().slice(0, 10);
  const time = created.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false });
  const customer = order.customerSnap?.name ?? 'สมาชิกทั่วไป';

  return items.map((item) => {
    const visual = productVisual(item.productSnap.category);
    const revenue = item.lineTotal;
    const cogs = item.fifoCost;
    const profit = revenue - cogs;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
    return {
      id: `${order.id}-${item.id}`,
      orderId: order.id,
      date,
      time,
      bill: order.billId || order.id,
      customer,
      productId: item.productId,
      productName: item.productSnap.name,
      productSku: item.productSnap.sku,
      category: item.productSnap.category || 'อื่นๆ',
      emoji: visual.emoji,
      iconBg: visual.iconBg,
      imageUrl: null,
      qty: item.qty,
      salePrice: item.unitPrice,
      revenue,
      cogs,
      profit,
      margin,
    };
  });
}
