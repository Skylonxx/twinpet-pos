import type { Product, StockLot, StockMovement } from '../types';

function ts(d: Date): Product['createdAt'] {
  return { toDate: () => d } as Product['createdAt'];
}

const RAW_PRODUCTS = [
  { id: '1', name: 'Royal Canin Adult 3kg', sku: 'RC-A3', category: 'อาหารสุนัข', qty: 48, reorder: 20, avgCost: 320, cogs: 6400, emoji: '🐕', iconBg: '#EEEDFE' },
  { id: '2', name: 'Hills Science Diet Cat', sku: 'HS-C1', category: 'อาหารแมว', qty: 15, reorder: 20, avgCost: 285, cogs: 5700, emoji: '🐈', iconBg: '#E1F5EE' },
  { id: '3', name: 'Whiskas Tuna 85g (24pc)', sku: 'WK-T24', category: 'อาหารแมว', qty: 6, reorder: 12, avgCost: 95, cogs: 2850, emoji: '🐟', iconBg: '#E1F5EE' },
  { id: '4', name: 'Purina Pro Plan Puppy', sku: 'PP-PUP', category: 'อาหารสุนัข', qty: 32, reorder: 15, avgCost: 410, cogs: 4100, emoji: '🐶', iconBg: '#EEEDFE' },
  { id: '5', name: 'Pedigree Dentastix', sku: 'PD-DX', category: 'อาหารสุนัข', qty: 0, reorder: 10, avgCost: 55, cogs: 1650, emoji: '🦴', iconBg: '#EEEDFE' },
  { id: '6', name: 'Cat Scratcher Deluxe', sku: 'CS-DX', category: 'ของเล่น', qty: 8, reorder: 5, avgCost: 180, cogs: 720, emoji: '🧸', iconBg: '#FAEEDA' },
  { id: '7', name: 'Frontline Plus Dog L', sku: 'FL-DL', category: 'ยาและวิตามิน', qty: 22, reorder: 8, avgCost: 195, cogs: 1950, emoji: '💊', iconBg: '#FCEBEB' },
  { id: '8', name: 'Catit Water Fountain', sku: 'CW-F1', category: 'อุปกรณ์', qty: 3, reorder: 4, avgCost: 650, cogs: 1950, emoji: '💧', iconBg: '#E6F1FB' },
  { id: '9', name: 'Petsafe Clicker', sku: 'PC-CL', category: 'ของเล่น', qty: 18, reorder: 5, avgCost: 75, cogs: 450, emoji: '🔔', iconBg: '#FAEEDA' },
  { id: '10', name: 'Tidy Cats Clumping 8kg', sku: 'TC-C8', category: 'ทรายแมว', qty: 40, reorder: 20, avgCost: 185, cogs: 3700, emoji: '🪣', iconBg: '#F1EFE8' },
  { id: '11', name: 'NexGard Chewable M', sku: 'NG-M', category: 'ยาและวิตามิน', qty: 5, reorder: 8, avgCost: 240, cogs: 2400, emoji: '💊', iconBg: '#FCEBEB' },
  { id: '12', name: 'Rolf Club 3D Collar Cat', sku: 'RC-CC', category: 'อุปกรณ์', qty: 11, reorder: 6, avgCost: 120, cogs: 960, emoji: '🎀', iconBg: '#FBEAF0' },
];

function lot(
  id: string,
  productId: string,
  branchId: string,
  receivingId: string,
  received: Date,
  qtyReceived: number,
  qtyRemaining: number,
  costPerUnit: number,
  expiry: Date | null,
): StockLot {
  return {
    id,
    productId,
    branchId,
    receivingId,
    costPerUnit,
    qtyReceived,
    qtyRemaining,
    receivedAt: ts(received),
    expiryDate: expiry ? ts(expiry) : null,
    isDepleted: qtyRemaining <= 0,
    createdAt: ts(received),
  };
}

function movement(
  id: string,
  productId: string,
  branchId: string,
  type: StockMovement['type'],
  qty: number,
  costPerUnit: number,
  refId: string,
  created: Date,
  note: string,
): StockMovement {
  return {
    id,
    productId,
    branchId,
    type,
    qty,
    costPerUnit,
    refId,
    refType: type === 'receive' ? 'receiving' : type === 'sale' ? 'order' : 'adjust',
    note,
    createdBy: 'dev-staff',
    createdAt: ts(created),
  };
}

export function getDevStockReportData(branchId: string) {
  const products: Product[] = RAW_PRODUCTS.map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    barcode: null,
    category: p.category,
    description: '',
    imageUrl: null,
    baseUnit: 'ชิ้น',
    uomConversions: [],
    prices: [],
    avgCost: p.avgCost,
    reorderPoint: p.reorder,
    isActive: true,
    deletedAt: null,
    createdAt: ts(new Date()),
    updatedAt: ts(new Date()),
  }));

  const stocks = new Map(RAW_PRODUCTS.map((p) => [p.id, p.qty]));
  const reorderMap = new Map(RAW_PRODUCTS.map((p) => [p.id, p.reorder]));

  const lotsByProduct = new Map<string, StockLot[]>([
    [
      '1',
      [
        lot('lot-1a', '1', branchId, 'GRN-0078', new Date('2026-04-01'), 30, 18, 315, new Date('2027-04-01')),
        lot('lot-1b', '1', branchId, 'GRN-0085', new Date('2026-05-02'), 40, 30, 320, new Date('2027-05-02')),
      ],
    ],
    ['2', [lot('lot-2a', '2', branchId, 'GRN-0079', new Date('2026-04-05'), 20, 15, 280, new Date('2027-04-05'))]],
    ['3', [lot('lot-3a', '3', branchId, 'GRN-0080', new Date('2026-04-10'), 24, 6, 92, new Date('2026-10-10'))]],
    [
      '4',
      [
        lot('lot-4a', '4', branchId, 'GRN-0081', new Date('2026-04-15'), 20, 12, 405, new Date('2027-04-15')),
        lot('lot-4b', '4', branchId, 'GRN-0088', new Date('2026-05-10'), 24, 20, 412, new Date('2027-05-10')),
      ],
    ],
    [
      '7',
      [
        lot('lot-7a', '7', branchId, 'GRN-0082', new Date('2026-04-20'), 12, 8, 190, new Date('2027-04-20')),
        lot('lot-7b', '7', branchId, 'GRN-0087', new Date('2026-05-05'), 20, 14, 198, new Date('2027-05-05')),
      ],
    ],
    ['10', [lot('lot-10a', '10', branchId, 'GRN-0083', new Date('2026-05-01'), 50, 40, 182, new Date('2028-05-01'))]],
  ]);

  const now = new Date();
  const movements: StockMovement[] = [
    movement('mv1', '1', branchId, 'receive', 40, 320, 'GRN-0088', new Date(now.getFullYear(), now.getMonth(), now.getDate(), 11, 20), ''),
    movement('mv2', '3', branchId, 'void', 1, 92, 'VOID-0024', new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 45), ''),
    movement('mv3', '4', branchId, 'sale', -2, 410, 'TW-0583', new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 30), ''),
    movement('mv4', '2', branchId, 'sale', -3, 285, 'TW-0582', new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 55), ''),
    movement('mv5', '10', branchId, 'receive', 50, 182, 'GRN-0087', new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 15, 0), ''),
    movement('mv6', '7', branchId, 'sale', -1, 195, 'TW-0580', new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 14, 20), ''),
    movement('mv7', '12', branchId, 'adjust', -2, 120, 'ADJ-0011', new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 16, 10), ''),
    movement('mv8', '1', branchId, 'sale', -5, 315, 'TW-0578', new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 11, 30), ''),
    movement('mv9', '4', branchId, 'receive', 24, 412, 'GRN-0086', new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3, 9, 0), ''),
    movement('mv10', '6', branchId, 'sale', -2, 180, 'TW-0575', new Date(now.getFullYear(), now.getMonth(), now.getDate() - 4, 14, 0), ''),
    movement('mv11', '11', branchId, 'sale', -3, 240, 'TW-0571', new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5, 10, 15), ''),
    movement('mv12', '5', branchId, 'sale', -5, 55, 'TW-0568', new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 16, 30), ''),
    movement('mv13', '8', branchId, 'receive', 5, 645, 'GRN-0085', new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, 9, 45), ''),
    movement('mv14', '9', branchId, 'sale', -4, 75, 'TW-0562', new Date(now.getFullYear(), now.getMonth(), now.getDate() - 8, 11, 0), ''),
    movement('mv15', '3', branchId, 'receive', 24, 92, 'GRN-0084', new Date(now.getFullYear(), now.getMonth(), now.getDate() - 9, 14, 0), ''),
    movement('mv16', '7', branchId, 'receive', 20, 198, 'GRN-0083', new Date(now.getFullYear(), now.getMonth(), now.getDate() - 10, 10, 30), ''),
  ];

  const cogsByProduct = new Map(RAW_PRODUCTS.map((p) => [p.id, p.cogs]));

  const visualMap = new Map(
    RAW_PRODUCTS.map((p) => [p.id, { emoji: p.emoji, iconBg: p.iconBg }]),
  );

  return { products, stocks, reorderMap, lotsByProduct, movements, cogsByProduct, visualMap };
}

export function getDevCategories(): string[] {
  return [...new Set(RAW_PRODUCTS.map((p) => p.category))];
}
