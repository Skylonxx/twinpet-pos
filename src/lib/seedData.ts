/**
 * UAT mock-data seeder. Uploads the bundled {@link ./mock-data.json} customers
 * and products (plus 5 extra generated products) into Firestore so testers have
 * a realistic catalog to work with.
 *
 * Design notes:
 *  - Docs are written with their explicit IDs (PROD-001, CUST-001, …) via
 *    `setDoc(..., { merge: true })`, so re-running the seed is idempotent — it
 *    overwrites the seeded docs rather than creating duplicates.
 *  - Every doc gets `createdAt` / `updatedAt` via `serverTimestamp()` (and
 *    `deletedAt: null`). The CRM / catalog UI reads these and crashes without
 *    them, so they are mandatory.
 *  - Each product also gets a `productStocks/{branchId}` subcollection doc for
 *    every branch (baseline `totalStockBase: 0`), matching the app's own
 *    create flow so stock reports / POS don't choke on missing stock docs.
 *  - Writes are committed in batches that respect Firestore's 500-write limit.
 */
import {
  doc,
  serverTimestamp,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from './firebase';
import { ensureFirebaseAuth } from './firebaseAuth';
import { branchIsActive, fetchAllBranches } from './admin/branchManagement';
import { sanitizeProductDocForFirestore, stripUndefinedDeep } from './firestoreSanitize';
import mockData from './mock-data.json';

const BATCH_LIMIT = 500;

/** Shape of a product entry in mock-data.json (and the generated extras). */
type RawSeedProduct = {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  category: string;
  description: string;
  imageUrl: string | null;
  baseUnit: string;
  cost: number;
  basePrice?: number;
  prices: Array<{ priceLevelId: string; unit: string; price: number }>;
  tierPrices?: Record<string, number>;
  uomConversions: Array<{
    unit: string;
    factor: number;
    barcode?: string;
    tierPrices?: Record<string, number>;
  }>;
  allowNegativeStock: boolean;
  reorderPoint: number;
  isActive: boolean;
  muteAlerts: boolean;
};

/** Shape of a customer/supplier entry in mock-data.json. */
type RawSeedCustomer = {
  id: string;
  firstName: string;
  lastName: string;
  contactType: 'retail' | 'wholesale' | 'supplier';
  customerType: string;
  priceLevelId: string;
  creditLimit: number;
  creditDays: number;
  isActive: boolean;
  phone: string;
  tags: string[];
};

export type SeedSummary = {
  customers: number;
  creditAccounts: number;
  products: number;
  productStocks: number;
  branches: number;
};

/**
 * 5 additional products generated in memory to round the catalog out to 10,
 * covering the full category set requested for UAT. Same schema as the JSON
 * products (UOM conversions + per-tier prices).
 */
const GENERATED_PRODUCTS: RawSeedProduct[] = [
  {
    id: 'PROD-006',
    sku: 'CP-PIG-901',
    barcode: '885000000006',
    name: 'อาหารหมูเล็ก CP 901',
    category: 'อาหารหมู',
    description: 'อาหารสุกรเล็ก แรกเกิด–25 กก.',
    imageUrl: null,
    baseUnit: 'กก.',
    cost: 18,
    basePrice: 24,
    prices: [
      { priceLevelId: 'RETAIL', unit: 'กก.', price: 24 },
      { priceLevelId: 'RETAIL', unit: 'กระสอบ', price: 690 },
    ],
    tierPrices: { WHOLESALE1: 23, WHOLESALE2: 22, MEMBER: 23.5 },
    uomConversions: [
      {
        unit: 'กระสอบ',
        factor: 30,
        barcode: '885000000006-S',
        tierPrices: { WHOLESALE1: 670, WHOLESALE2: 650 },
      },
    ],
    allowNegativeStock: true,
    reorderPoint: 40,
    isActive: true,
    muteAlerts: false,
  },
  {
    id: 'PROD-007',
    sku: 'BTG-CHICK-311',
    barcode: '885000000007',
    name: 'อาหารไก่ไข่ เบทาโกร 311',
    category: 'อาหารไก่',
    description: 'อาหารไก่ไข่ระยะให้ไข่',
    imageUrl: null,
    baseUnit: 'กก.',
    cost: 16,
    basePrice: 21,
    prices: [
      { priceLevelId: 'RETAIL', unit: 'กก.', price: 21 },
      { priceLevelId: 'RETAIL', unit: 'กระสอบ', price: 600 },
    ],
    tierPrices: { WHOLESALE1: 20, WHOLESALE2: 19, MEMBER: 20.5 },
    uomConversions: [
      {
        unit: 'กระสอบ',
        factor: 30,
        barcode: '885000000007-S',
        tierPrices: { WHOLESALE1: 580, WHOLESALE2: 560 },
      },
    ],
    allowNegativeStock: true,
    reorderPoint: 40,
    isActive: true,
    muteAlerts: false,
  },
  {
    id: 'PROD-008',
    sku: 'COW-CONC-21',
    barcode: '885000000008',
    name: 'อาหารข้นโคนม 21% โปรตีน',
    category: 'อาหารวัว',
    description: 'อาหารข้นสำหรับโคนมรีดนม',
    imageUrl: null,
    baseUnit: 'กก.',
    cost: 13,
    basePrice: 18,
    prices: [
      { priceLevelId: 'RETAIL', unit: 'กก.', price: 18 },
      { priceLevelId: 'RETAIL', unit: 'กระสอบ', price: 500 },
    ],
    tierPrices: { WHOLESALE1: 17, WHOLESALE2: 16, MEMBER: 17.5 },
    uomConversions: [
      {
        unit: 'กระสอบ',
        factor: 30,
        barcode: '885000000008-S',
        tierPrices: { WHOLESALE1: 480, WHOLESALE2: 460 },
      },
    ],
    allowNegativeStock: true,
    reorderPoint: 30,
    isActive: true,
    muteAlerts: false,
  },
  {
    id: 'PROD-009',
    sku: 'MED-VITA-MIX',
    barcode: '885000000009',
    name: 'วิตามินรวมละลายน้ำ สำหรับสัตว์',
    category: 'ยาสัตว์',
    description: 'วิตามินรวมเสริมภูมิ ละลายน้ำให้สัตว์ปีก',
    imageUrl: null,
    baseUnit: 'ซอง',
    cost: 25,
    basePrice: 45,
    prices: [
      { priceLevelId: 'RETAIL', unit: 'ซอง', price: 45 },
      { priceLevelId: 'RETAIL', unit: 'กล่อง', price: 800 },
    ],
    tierPrices: { WHOLESALE1: 42, WHOLESALE2: 40, MEMBER: 43 },
    uomConversions: [
      {
        unit: 'กล่อง',
        factor: 20,
        barcode: '885000000009-B20',
        tierPrices: { WHOLESALE1: 780, WHOLESALE2: 760 },
      },
    ],
    allowNegativeStock: true,
    reorderPoint: 24,
    isActive: true,
    muteAlerts: false,
  },
  {
    id: 'PROD-010',
    sku: 'FARM-FEEDER-AUTO',
    barcode: '885000000010',
    name: 'ถังให้อาหารอัตโนมัติ 10 กก.',
    category: 'อุปกรณ์ฟาร์ม',
    description: 'ถังให้อาหารไก่/หมูแบบอัตโนมัติ',
    imageUrl: null,
    baseUnit: 'ใบ',
    cost: 120,
    basePrice: 220,
    prices: [
      { priceLevelId: 'RETAIL', unit: 'ใบ', price: 220 },
      { priceLevelId: 'RETAIL', unit: 'แพ็ค', price: 2000 },
    ],
    tierPrices: { WHOLESALE1: 200, WHOLESALE2: 190, MEMBER: 210 },
    uomConversions: [
      {
        unit: 'แพ็ค',
        factor: 10,
        barcode: '885000000010-P10',
        tierPrices: { WHOLESALE1: 1950, WHOLESALE2: 1900 },
      },
    ],
    allowNegativeStock: true,
    reorderPoint: 10,
    isActive: true,
    muteAlerts: false,
  },
];

function requireDb(): Firestore {
  if (!isFirebaseConfigured || !db) {
    throw new Error('ไม่รองรับการ seed ข้อมูลในโหมด dev (Firebase ไม่ได้ตั้งค่า)');
  }
  return db;
}

/** A writeBatch wrapper that auto-commits every {@link BATCH_LIMIT} writes. */
function createBatchWriter(firestore: Firestore) {
  let batch = writeBatch(firestore);
  let pending = 0;

  return {
    async set(ref: Parameters<typeof batch.set>[0], data: Record<string, unknown>) {
      batch.set(ref, data, { merge: true });
      pending += 1;
      if (pending >= BATCH_LIMIT) {
        await batch.commit();
        batch = writeBatch(firestore);
        pending = 0;
      }
    },
    async flush() {
      if (pending > 0) {
        await batch.commit();
        pending = 0;
      }
    },
  };
}

function buildCustomerDoc(raw: RawSeedCustomer, branchId: string, index: number) {
  const name = `${raw.firstName} ${raw.lastName}`.trim();
  return {
    id: raw.id,
    branchId,
    name,
    memberNo: `M${String(Date.now()).slice(-5)}${index}`,
    firstName: raw.firstName,
    lastName: raw.lastName,
    phone: raw.phone ?? '',
    email: null,
    taxId: null,
    address: null,
    contactType: raw.contactType,
    customerType: raw.customerType,
    bankName: null,
    bankAccount: null,
    priceLevelId: raw.priceLevelId,
    creditLimit: raw.creditLimit,
    creditDays: raw.creditDays,
    outstandingBalance: 0,
    totalSpent: 0,
    lifetimeValue: 0,
    points: 0,
    lastVisitAt: null,
    tags: raw.tags ?? [],
    note: '',
    isActive: raw.isActive ?? true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    deletedAt: null,
  };
}

function buildProductDoc(raw: RawSeedProduct) {
  // Run through the same sanitizer the product form uses, then stamp timestamps.
  const sanitized = sanitizeProductDocForFirestore({
    ...raw,
    avgCost: 0,
  });
  return {
    ...sanitized,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    deletedAt: null,
  };
}

/**
 * Seed customers + 10 products (5 from JSON, 5 generated) into Firestore.
 * Returns counts of everything written.
 */
export async function seedMockData(): Promise<SeedSummary> {
  const firestore = requireDb();
  await ensureFirebaseAuth();

  const branches = await fetchAllBranches();
  const activeBranches = branches.filter(branchIsActive);
  const targetBranches = activeBranches.length > 0 ? activeBranches : branches;
  if (targetBranches.length === 0) {
    throw new Error('ไม่พบสาขาในระบบ — กรุณาสร้างสาขาก่อน seed ข้อมูล');
  }
  const primaryBranchId = targetBranches[0]!.id;

  const rawCustomers = mockData.customers as unknown as RawSeedCustomer[];
  const rawProducts = [
    ...(mockData.products as unknown as RawSeedProduct[]),
    ...GENERATED_PRODUCTS,
  ];

  const writer = createBatchWriter(firestore);
  const summary: SeedSummary = {
    customers: 0,
    creditAccounts: 0,
    products: 0,
    productStocks: 0,
    branches: targetBranches.length,
  };

  // ── Customers (+ credit accounts for credit-enabled, non-supplier customers) ──
  for (let index = 0; index < rawCustomers.length; index += 1) {
    const raw = rawCustomers[index]!;
    const customerDoc = buildCustomerDoc(raw, primaryBranchId, index);
    await writer.set(doc(firestore, collections.customers, raw.id), customerDoc);
    summary.customers += 1;

    if (raw.creditLimit > 0 && raw.contactType !== 'supplier') {
      await writer.set(doc(firestore, collections.creditAccounts, raw.id), {
        customerId: raw.id,
        branchId: primaryBranchId,
        creditLimit: raw.creditLimit,
        creditUsed: 0,
        creditBalance: raw.creditLimit,
        overdueAmt: 0,
        lastTransAt: null,
        updatedAt: serverTimestamp(),
      });
      summary.creditAccounts += 1;
    }
  }

  // ── Products + a productStocks doc per branch ──
  for (const raw of rawProducts) {
    const productDoc = buildProductDoc(raw);
    await writer.set(doc(firestore, collections.products, raw.id), productDoc);
    summary.products += 1;

    for (const branch of targetBranches) {
      const stockDoc = stripUndefinedDeep({
        branchId: branch.id,
        reorderPoint: raw.reorderPoint ?? 0,
        overrideTierPrices: {},
        totalStockBase: 0,
        lastMovementAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }) as Record<string, unknown>;
      await writer.set(
        doc(firestore, collections.products, raw.id, collections.productStocks, branch.id),
        stockDoc,
      );
      summary.productStocks += 1;
    }
  }

  await writer.flush();
  return summary;
}
