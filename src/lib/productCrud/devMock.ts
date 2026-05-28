import type { Product, ProductStock, StockLot, StockMovement } from '../types';
import type { ProductListItem } from './types';
import { CATEGORY_EMOJI, getRetailPrice } from './types';

function ts(d = new Date()): Product['createdAt'] {
  return { toDate: () => d } as Product['createdAt'];
}

type Raw = {
  id: string;
  name: string;
  sku: string;
  barcode: string;
  cat: string;
  price: number;
  cost?: number;
  avgCost: number;
  stock: number;
  minStock: number;
  emoji: string;
  active: boolean;
  hasUom: boolean;
  noVat?: boolean;
  uom?: Array<{ unit: string; factor: number; prices?: Record<string, number> }>;
};

const RAW: Raw[] = [
  { id: '1', name: "Hill's Science Diet สุนัขสูงอายุ 7+ 5.67kg", sku: 'SKU001', barcode: '8850007890123', cat: 'อาหารสัตว์', price: 2400, avgCost: 1820, stock: 98, minStock: 10, emoji: '🐕', active: true, hasUom: false },
  { id: '2', name: 'Royal Canin Mini Indoor Senior 3kg', sku: 'SKU002', barcode: '3182550789456', cat: 'อาหารสัตว์', price: 1029, avgCost: 780, stock: 96, minStock: 10, emoji: '🐩', active: true, hasUom: false },
  { id: '3', name: 'Maxima อาหารเปียก กระป๋อง 380g', sku: 'SKU003', barcode: '8850001234567', cat: 'อาหารสัตว์', price: 79, avgCost: 45, stock: 99, minStock: 20, emoji: '🥫', active: true, hasUom: true, uom: [{ unit: 'แพ็ค', factor: 6, prices: { RETAIL: 450 } }] },
  { id: '4', name: 'Smart Heart อาหารลูกสุนัข 8kg', sku: 'SKU004', barcode: '8850009876543', cat: 'อาหารสัตว์', price: 759, avgCost: 580, stock: 8, minStock: 10, emoji: '🐶', active: true, hasUom: false },
  { id: '5', name: 'Jerhigh ฮอทดอกบาร์ รสไก่ 150g', sku: 'SKU005', barcode: '8858753012345', cat: 'ทรีทและขนม', price: 45, avgCost: 28, stock: 99, minStock: 30, emoji: '🌭', active: true, hasUom: true, uom: [{ unit: 'โหล', factor: 12, prices: { RETAIL: 510 } }] },
  { id: '6', name: 'Biscal ขนมคุกกี้สุนัข สูตรชีส 60g', sku: 'SKU006', barcode: '8858753098765', cat: 'ทรีทและขนม', price: 197, avgCost: 120, stock: 100, minStock: 15, emoji: '🍪', active: true, hasUom: false },
  { id: '7', name: 'Pedigree เดนตาสติก แท่งขัดฟัน', sku: 'SKU007', barcode: '8850003456789', cat: 'ทรีทและขนม', price: 199, avgCost: 140, stock: 3, minStock: 10, emoji: '🦷', active: true, hasUom: false },
  { id: '8', name: 'Kaniva อาหารแมวโต รสแกะทูน่า 8kg', sku: 'SKU008', barcode: '8858656001234', cat: 'อาหารสัตว์', price: 890, avgCost: 650, stock: 0, minStock: 5, emoji: '🐱', active: false, hasUom: false, noVat: true },
  { id: '9', name: 'Purina ONE แมวโต รสทูน่า 1.8kg', sku: 'SKU009', barcode: '7613287890123', cat: 'อาหารสัตว์', price: 540, avgCost: 390, stock: 27, minStock: 10, emoji: '🐟', active: true, hasUom: false },
  { id: '10', name: 'Boltz ของเล่นแมว ไม้เท้าขนนก', sku: 'SKU010', barcode: '8858888012345', cat: 'ของเล่น', price: 149, avgCost: 70, stock: 18, minStock: 5, emoji: '🪄', active: true, hasUom: false },
  { id: '11', name: 'Fresh Step กรายแมวก้อน 20L', sku: 'SKU011', barcode: '0044600309768', cat: 'กรายแมว', price: 399, avgCost: 250, stock: 14, minStock: 8, emoji: '🪣', active: true, hasUom: false },
  { id: '12', name: 'Nekko Kitten อาหารเปียกลูกแมว 70g', sku: 'SKU012', barcode: '8858636001234', cat: 'อาหารสัตว์', price: 25, avgCost: 14, stock: 88, minStock: 50, emoji: '🐈', active: true, hasUom: true },
];

function rawToProduct(r: Raw): Product {
  const prices = [{ priceLevelId: 'RETAIL', unit: 'ชิ้น', price: r.price }];
  if (r.uom) {
    for (const u of r.uom) {
      if (u.prices?.RETAIL) prices.push({ priceLevelId: 'RETAIL', unit: u.unit, price: u.prices.RETAIL });
    }
  }
  return {
    id: r.id,
    name: r.name,
    sku: r.sku,
    barcode: r.barcode,
    category: r.cat,
    description: '',
    imageUrl: null,
    baseUnit: 'ชิ้น',
    uomConversions: (r.uom ?? []).map((u) => ({ unit: u.unit, factor: u.factor })),
    prices,
    cost: r.cost ?? r.avgCost,
    avgCost: r.avgCost,
    reorderPoint: r.minStock,
    isActive: r.active,
    hasVat: !r.noVat,
    deletedAt: null,
    createdAt: ts(),
    updatedAt: ts(),
  };
}

let devProducts = RAW.map(rawToProduct);
let devStocks: Record<string, ProductStock> = {};
let devLots: StockLot[] = [];
let devMovements: StockMovement[] = [];

function initDev() {
  devStocks = {};
  devLots = [];
  devMovements = [];
  for (const r of RAW) {
    devStocks[r.id] = {
      branchId: 'LDP-001',
      totalStockBase: r.stock,
      reorderPoint: r.minStock,
      lastMovementAt: ts(),
      updatedAt: ts(),
    };
  }

  const lotData: Record<string, Array<{ grn: string; date: Date; received: number; remaining: number; cost: number }>> = {
    '1': [
      { grn: 'GRN-0038', date: new Date('2026-04-15'), received: 50, remaining: 50, cost: 1800 },
      { grn: 'GRN-0029', date: new Date('2026-03-01'), received: 30, remaining: 28, cost: 1820 },
      { grn: 'GRN-0018', date: new Date('2026-01-10'), received: 40, remaining: 20, cost: 1790 },
      { grn: 'GRN-0010', date: new Date('2025-11-05'), received: 30, remaining: 0, cost: 1750 },
    ],
    '3': [
      { grn: 'GRN-0041', date: new Date('2026-05-20'), received: 120, remaining: 99, cost: 44 },
      { grn: 'GRN-0033', date: new Date('2026-03-15'), received: 60, remaining: 0, cost: 46 },
    ],
    '4': [
      { grn: 'GRN-0039', date: new Date('2026-04-20'), received: 10, remaining: 8, cost: 578 },
      { grn: 'GRN-0025', date: new Date('2026-02-15'), received: 20, remaining: 0, cost: 582 },
    ],
  };

  for (const [productId, batches] of Object.entries(lotData)) {
    batches.forEach((b, i) => {
      devLots.push({
        id: `lot-${productId}-${i}`,
        productId,
        branchId: 'LDP-001',
        receivingId: b.grn,
        costPerUnit: b.cost,
        qtyReceived: b.received,
        qtyRemaining: b.remaining,
        receivedAt: ts(b.date),
        expiryDate: null,
        isDepleted: b.remaining <= 0,
        createdAt: ts(b.date),
      });
    });
  }

  for (const r of RAW) {
    const hasLot = devLots.some((l) => l.productId === r.id && l.qtyRemaining > 0);
    if (!hasLot && r.stock > 0) {
      devLots.push({
        id: `lot-${r.id}-init`,
        productId: r.id,
        branchId: 'LDP-001',
        receivingId: 'GRN-INIT',
        costPerUnit: r.avgCost,
        qtyReceived: r.stock,
        qtyRemaining: r.stock,
        receivedAt: ts(new Date('2026-05-01')),
        expiryDate: null,
        isDepleted: false,
        createdAt: ts(new Date('2026-05-01')),
      });
    }
  }

  devMovements = [
    { id: 'mv-1', productId: '1', branchId: 'LDP-001', type: 'sale', qty: -1, costPerUnit: 1820, refId: 'TW-0588', refType: 'order', note: '', createdBy: 'staff', createdAt: ts(new Date('2026-05-23T15:30:00')) },
    { id: 'mv-2', productId: '1', branchId: 'LDP-001', type: 'receive', qty: 20, costPerUnit: 1800, refId: 'GRN-0038', refType: 'receiving', note: '', createdBy: 'staff', createdAt: ts(new Date('2026-05-22T10:15:00')) },
  ];
}

initDev();

export function getDevProductList(_branchId: string): ProductListItem[] {
  return devProducts
    .filter((p) => !p.deletedAt)
    .map((p) => {
      const stock = devStocks[p.id]?.totalStockBase ?? 0;
      const branchReorderPoint = devStocks[p.id]?.reorderPoint ?? p.reorderPoint;
      const emoji = RAW.find((r) => r.id === p.id)?.emoji ?? CATEGORY_EMOJI[p.category] ?? '📦';
      return {
        ...p,
        stock,
        branchReorderPoint,
        emoji,
        retailPrice: getRetailPrice(p),
      };
    });
}

export function getDevLots(productId: string, branchId: string): StockLot[] {
  return devLots
    .filter((l) => l.productId === productId && l.branchId === branchId)
    .sort((a, b) => a.receivedAt.toDate().getTime() - b.receivedAt.toDate().getTime());
}

export function getDevMovements(productId: string, branchId: string): StockMovement[] {
  return devMovements
    .filter((m) => m.productId === productId && m.branchId === branchId)
    .sort((a, b) => b.createdAt.toDate().getTime() - a.createdAt.toDate().getTime());
}

export function devSaveProduct(product: Product, stock?: ProductStock) {
  const idx = devProducts.findIndex((p) => p.id === product.id);
  if (idx >= 0) devProducts[idx] = { ...product, updatedAt: ts() };
  else devProducts.push({ ...product, createdAt: ts(), updatedAt: ts(), deletedAt: null });
  if (stock) {
    devStocks[product.id] = {
      ...stock,
      totalStockBase: stock.totalStockBase ?? 0,
    };
  }
}

export function devSoftDeleteProduct(id: string) {
  devProducts = devProducts.map((p) =>
    p.id === id ? { ...p, deletedAt: ts(), isActive: false, updatedAt: ts() } : p,
  );
}

export function devUpdateLotCost(lotId: string, cost: number) {
  devLots = devLots.map((l) => (l.id === lotId ? { ...l, costPerUnit: cost } : l));
  const lot = devLots.find((l) => l.id === lotId);
  if (!lot) return;
  const active = devLots.filter((l) => l.productId === lot.productId && l.qtyRemaining > 0);
  const totalQty = active.reduce((s, l) => s + l.qtyRemaining, 0);
  const totalVal = active.reduce((s, l) => s + l.qtyRemaining * l.costPerUnit, 0);
  if (totalQty > 0) {
    devProducts = devProducts.map((p) =>
      p.id === lot.productId ? { ...p, avgCost: totalVal / totalQty } : p,
    );
  }
}

export function devGetProduct(id: string): Product | undefined {
  return devProducts.find((p) => p.id === id && !p.deletedAt);
}
