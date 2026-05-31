/**
 * UAT mock-data seeder. This module is a pure logic handler ("the chef"): all of
 * the mock data ("the ingredients") lives in the sibling JSON files under
 * {@link ./mocks/} — mock-products.json, mock-customers.json, mock-suppliers.json,
 * and mock-pricelevels.json. This file only orchestrates reading those arrays
 * and batch-writing them to Firestore.
 *
 * Price levels (the unified tier system) are seeded into the `priceLevels`
 * collection: global tiers (`isGlobal: true`, `branchId: null`) plus a
 * branch-scoped example tier assigned to the primary branch. Products reference
 * the canonical lowercase ids (retail / wholesale / vip / agent1 / farm_large).
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
import mockProducts from './mocks/mock-products.json';
import mockCustomers from './mocks/mock-customers.json';
import mockSuppliers from './mocks/mock-suppliers.json';
import mockPriceLevels from './mocks/mock-pricelevels.json';
import type { PriceLevel } from './types';

const BATCH_LIMIT = 500;

/** Shape of a product entry in mocks/mock-products.json. */
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
  /** Seed-only stock hint — written to productStocks/{branchId}.totalStockBase, NOT to the product doc. */
  stock?: number;
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

/** Shape of a customer entry in mocks/mock-customers.json. */
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

/** Shape of a supplier entry in mocks/mock-suppliers.json — matches the `suppliers` collection schema. */
type RawSeedSupplier = {
  id: string;
  code: string;
  name: string;
  contactName: string;
  phone: string;
  email: string | null;
  taxId: string | null;
  address: string | null;
  bankName: string | null;
  bankAccount: string | null;
  note: string;
  isActive: boolean;
  allowedBranchIds: string[];
};

/** Shape of a price-level entry in mocks/mock-pricelevels.json (isGlobal/branchId set by the seeder). */
type RawSeedPriceLevel = Omit<PriceLevel, 'isGlobal' | 'branchId'>;

export type SeedSummary = {
  customers: number;
  suppliers: number;
  priceLevels: number;
  categories: number;
  creditAccounts: number;
  products: number;
  productStocks: number;
  stockLots: number;
  branches: number;
};

/**
 * Deterministic category id derived from the (often Thai) category name via a
 * 32-bit FNV-1a hash. Stable per name regardless of product ordering, so the
 * seed stays idempotent — crucially avoiding the non-deterministic `cat_<ts>`
 * fallback that `slugFromCategoryName` produces for non-ASCII names.
 */
function stableCategoryId(name: string): string {
  let h = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `cat-seed-${h.toString(36)}`;
}

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

function buildSupplierDoc(raw: RawSeedSupplier) {
  return {
    id: raw.id,
    code: raw.code,
    name: raw.name,
    contactName: raw.contactName ?? '',
    phone: raw.phone ?? '',
    email: raw.email ?? null,
    taxId: raw.taxId ?? null,
    address: raw.address ?? null,
    bankName: raw.bankName ?? null,
    bankAccount: raw.bankAccount ?? null,
    note: raw.note ?? '',
    isActive: raw.isActive ?? true,
    allowedBranchIds: raw.allowedBranchIds ?? ['ALL'],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    deletedAt: null,
  };
}

function buildProductDoc(raw: RawSeedProduct) {
  // Run through the same sanitizer the product form uses, then stamp timestamps.
  // `stock` is a seed-only hint for the productStocks subcollection — set it to
  // undefined here so the sanitizer (which strips undefined) keeps it off the
  // product document, matching the real Product schema the POS reads.
  // avgCost mirrors the standard cost so profit/COGS reporting has a real cost
  // baseline even before any GRN recalculates the moving average.
  const sanitized = sanitizeProductDocForFirestore({
    ...raw,
    stock: undefined,
    avgCost: raw.cost ?? 0,
  });
  return {
    ...sanitized,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    deletedAt: null,
  };
}

/**
 * Seed customers, suppliers, and products into Firestore from the bundled mock
 * JSON files. Returns counts of everything written.
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

  // Customers and suppliers live in STRICTLY SEPARATE Firestore collections
  // (`customers` vs `suppliers`) with different schemas, so they are seeded
  // independently below.
  const rawCustomers = mockCustomers as unknown as RawSeedCustomer[];
  const rawSuppliers = mockSuppliers as unknown as RawSeedSupplier[];
  const rawProducts = mockProducts as unknown as RawSeedProduct[];
  const rawPriceLevels = mockPriceLevels as unknown as {
    global: RawSeedPriceLevel[];
    branch: RawSeedPriceLevel[];
  };

  const writer = createBatchWriter(firestore);
  const summary: SeedSummary = {
    customers: 0,
    suppliers: 0,
    priceLevels: 0,
    categories: 0,
    creditAccounts: 0,
    products: 0,
    productStocks: 0,
    stockLots: 0,
    branches: targetBranches.length,
  };

  // ── Price levels (unified tier system) — global + a branch-scoped example ──
  for (const lvl of rawPriceLevels.global) {
    await writer.set(doc(firestore, collections.priceLevels, lvl.id), {
      ...lvl,
      isGlobal: true,
      branchId: null,
    });
    summary.priceLevels += 1;
  }
  const branchTierIds: string[] = [];
  for (const lvl of rawPriceLevels.branch) {
    await writer.set(doc(firestore, collections.priceLevels, lvl.id), {
      ...lvl,
      isGlobal: false,
      branchId: primaryBranchId,
    });
    branchTierIds.push(lvl.id);
    summary.priceLevels += 1;
  }

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

  // ── Suppliers (separate `suppliers` collection, written by code-based id) ──
  for (const raw of rawSuppliers) {
    const supplierDoc = buildSupplierDoc(raw);
    await writer.set(doc(firestore, collections.suppliers, raw.id), supplierDoc);
    summary.suppliers += 1;
  }

  // ── Master categories (DERIVED from products, deterministic ids) ──
  // Seeded BEFORE products so each product's `category` name resolves to a real
  // master doc instead of showing as "(legacy)". Products keep their existing
  // name strings; the category picker matches by name, so no product edits needed.
  const categoryNames = [...new Set(rawProducts.map((p) => p.category).filter(Boolean))];
  for (const name of categoryNames) {
    const id = stableCategoryId(name);
    await writer.set(doc(firestore, collections.categories, id), { id, name });
    summary.categories += 1;
  }

  // ── Products + a productStocks doc per branch ──
  for (const raw of rawProducts) {
    const productDoc = buildProductDoc(raw);
    await writer.set(doc(firestore, collections.products, raw.id), productDoc);
    summary.products += 1;

    for (const branch of targetBranches) {
      // Demonstrate branch-scoped tiers: give the primary branch a 10%-off price
      // for the branch-only price level(s) via the productStocks override map.
      const basePrice = raw.basePrice ?? 0;
      const overrideTierPrices: Record<string, number> =
        branch.id === primaryBranchId && basePrice > 0
          ? Object.fromEntries(
              branchTierIds.map((id) => [id, Math.round(basePrice * 0.9 * 100) / 100]),
            )
          : {};
      const stockDoc = stripUndefinedDeep({
        branchId: branch.id,
        reorderPoint: raw.reorderPoint ?? 0,
        overrideTierPrices,
        // POS reads stock from this field (usePosProducts: data.totalStockBase).
        totalStockBase: raw.stock ?? 0,
        lastMovementAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }) as Record<string, unknown>;
      await writer.set(
        doc(firestore, collections.products, raw.id, collections.productStocks, branch.id),
        stockDoc,
      );
      summary.productStocks += 1;

      // ── FIFO lot: a single seed lot so sales draw real cost (not oversell) ──
      // costPerUnit is per BASE unit (== product.cost) and qtyRemaining mirrors
      // the seeded stock, so COGS = qtyBase × cost is accurate end-to-end.
      const seedStock = raw.stock ?? 0;
      if (seedStock > 0) {
        const lotId = `${raw.id}_${branch.id}_seed`;
        const lotDoc = stripUndefinedDeep({
          id: lotId,
          productId: raw.id,
          branchId: branch.id,
          receivingId: 'SEED',
          costPerUnit: raw.cost ?? 0,
          qtyReceived: seedStock,
          qtyRemaining: seedStock,
          receivedAt: serverTimestamp(),
          expiryDate: null,
          isDepleted: false,
          createdAt: serverTimestamp(),
        }) as Record<string, unknown>;
        await writer.set(doc(firestore, collections.stockLots, lotId), lotDoc);
        summary.stockLots += 1;
      }
    }
  }

  await writer.flush();
  return summary;
}
