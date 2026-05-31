/**
 * Developer / UAT helpers to wipe test transactions and reset the database to a
 * clean state. These permanently delete documents — only exposed behind the
 * "Danger Zone" tools on the Branch Management admin page.
 *
 * All deletions are paged and committed in chunks so they respect Firestore's
 * 500-write-per-batch limit, regardless of how many test documents exist.
 *
 * Collection names follow {@link collections} (see docs/twinpet_firestore_schema.md):
 *   - orders               + orderItems     (subcollection)
 *   - payments             (top-level, linked to orders)
 *   - receivings           + receivingItems (subcollection)  ← purchases / GRN
 *   - inventoryTransfers   + transferItems  (subcollection)  ← branch transfers
 *   - inventoryAdjustments + adjustmentItems (subcollection)
 *   - stockMovements       (the stock ledger / "movements")
 *   - stockLots            (the FIFO lots / "fifo-lots")
 *   - products/{id}/productStocks/{branchId}.totalStockBase   ← per-branch stock
 */
import {
  collection,
  collectionGroup,
  getDocs,
  limit,
  query,
  serverTimestamp,
  writeBatch,
  type CollectionReference,
  type Firestore,
  type Query,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import { ensureFirebaseAuth } from '../firebaseAuth';

/** Firestore caps a single committed batch at 500 writes. */
const BATCH_LIMIT = 500;

/** Per-collection counts of how many documents were touched. */
export type DeletionSummary = Record<string, number>;

function requireDb(): Firestore {
  if (!isFirebaseConfigured || !db) {
    throw new Error('ไม่รองรับการล้างข้อมูลในโหมด dev (Firebase ไม่ได้ตั้งค่า)');
  }
  return db;
}

/**
 * Delete every document matched by `source`, paging in chunks of {@link BATCH_LIMIT}
 * so we never load the whole collection into memory or exceed the batch limit.
 * Re-queries after each commit because the just-deleted docs drop out of the result.
 */
async function deleteAllInChunks(
  firestore: Firestore,
  source: Query | CollectionReference,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const snap = await getDocs(query(source, limit(BATCH_LIMIT)));
    if (snap.empty) break;

    const batch = writeBatch(firestore);
    for (const docSnap of snap.docs) {
      batch.delete(docSnap.ref);
    }
    await batch.commit();

    deleted += snap.size;
    if (snap.size < BATCH_LIMIT) break;
  }
  return deleted;
}

/**
 * Delete a top-level collection together with one named subcollection under each
 * of its documents. Subcollection docs are removed first so no orphans remain.
 */
async function deleteCollectionWithSubcollection(
  firestore: Firestore,
  parentCollection: string,
  subcollection: string,
): Promise<{ parents: number; children: number }> {
  let parents = 0;
  let children = 0;

  for (;;) {
    const parentSnap = await getDocs(
      query(collection(firestore, parentCollection), limit(BATCH_LIMIT)),
    );
    if (parentSnap.empty) break;

    // Clear each parent's subcollection before removing the parent itself.
    for (const parentDoc of parentSnap.docs) {
      children += await deleteAllInChunks(
        firestore,
        collection(parentDoc.ref, subcollection),
      );
    }

    const batch = writeBatch(firestore);
    for (const parentDoc of parentSnap.docs) {
      batch.delete(parentDoc.ref);
    }
    await batch.commit();

    parents += parentSnap.size;
    if (parentSnap.size < BATCH_LIMIT) break;
  }

  return { parents, children };
}

/**
 * Delete all sales history: every `orders` document, its `orderItems`
 * subcollection, and the linked `payments`.
 */
export async function clearSalesData(): Promise<DeletionSummary> {
  const firestore = requireDb();
  await ensureFirebaseAuth();

  const orders = await deleteCollectionWithSubcollection(
    firestore,
    collections.orders,
    collections.orderItems,
  );
  const payments = await deleteAllInChunks(
    firestore,
    collection(firestore, collections.payments),
  );

  return {
    orders: orders.parents,
    orderItems: orders.children,
    payments,
  };
}

/**
 * Delete inventory transactions: purchases/GRN (`receivings`), branch transfers
 * (`inventoryTransfers`), and stock adjustments (`inventoryAdjustments`),
 * including each one's item subcollection.
 */
export async function clearInventoryTransactions(): Promise<DeletionSummary> {
  const firestore = requireDb();
  await ensureFirebaseAuth();

  const receivings = await deleteCollectionWithSubcollection(
    firestore,
    collections.receivings,
    collections.receivingItems,
  );
  const transfers = await deleteCollectionWithSubcollection(
    firestore,
    collections.inventoryTransfers,
    collections.transferItems,
  );
  const adjustments = await deleteCollectionWithSubcollection(
    firestore,
    collections.inventoryAdjustments,
    collections.adjustmentItems,
  );

  return {
    receivings: receivings.parents,
    receivingItems: receivings.children,
    inventoryTransfers: transfers.parents,
    transferItems: transfers.children,
    inventoryAdjustments: adjustments.parents,
    adjustmentItems: adjustments.children,
  };
}

/**
 * Delete the stock ledger (`stockMovements`) and the FIFO lots (`stockLots`).
 */
export async function clearStockLedgerAndFifo(): Promise<DeletionSummary> {
  const firestore = requireDb();
  await ensureFirebaseAuth();

  const movements = await deleteAllInChunks(
    firestore,
    collection(firestore, collections.stockMovements),
  );
  const fifoLots = await deleteAllInChunks(
    firestore,
    collection(firestore, collections.stockLots),
  );

  return {
    stockMovements: movements,
    stockLots: fifoLots,
  };
}

/**
 * Reset running stock balances to zero across all products: every
 * `products/{id}/productStocks/{branchId}` doc gets `totalStockBase = 0`, and the
 * product's moving-average `avgCost` (a GRN-derived running balance) is cleared.
 * Master data (name, prices, units) is left untouched.
 */
export async function resetAllProductStocks(): Promise<DeletionSummary> {
  const firestore = requireDb();
  await ensureFirebaseAuth();

  let products = 0;
  let stockDocs = 0;

  // One batch accumulates mixed product + productStock writes; flush at the limit.
  let batch = writeBatch(firestore);
  let pending = 0;
  const flushIfFull = async () => {
    if (pending >= BATCH_LIMIT) {
      await batch.commit();
      batch = writeBatch(firestore);
      pending = 0;
    }
  };

  const productsSnap = await getDocs(collection(firestore, collections.products));
  for (const productDoc of productsSnap.docs) {
    batch.update(productDoc.ref, { avgCost: 0, updatedAt: serverTimestamp() });
    pending += 1;
    products += 1;
    await flushIfFull();

    const stockSnap = await getDocs(
      collection(productDoc.ref, collections.productStocks),
    );
    for (const stockDoc of stockSnap.docs) {
      batch.update(stockDoc.ref, {
        totalStockBase: 0,
        lastMovementAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      pending += 1;
      stockDocs += 1;
      await flushIfFull();
    }
  }

  if (pending > 0) {
    await batch.commit();
  }

  return {
    products,
    productStocks: stockDocs,
  };
}

/**
 * Delete shift/cash-drawer history: `shifts` and `cashTransactions`.
 */
export async function clearShiftAndCashData(): Promise<DeletionSummary> {
  const firestore = requireDb();
  await ensureFirebaseAuth();

  const shifts = await deleteAllInChunks(
    firestore,
    collection(firestore, collections.shifts),
  );
  const cashTransactions = await deleteAllInChunks(
    firestore,
    collection(firestore, collections.cashTransactions),
  );

  return { shifts, cashTransactions };
}

/**
 * Delete credit ledger history: `creditTransactions` and `creditPayments`.
 * Note: this does not touch `creditAccounts`/`customers` balances — that is
 * customer master data, not a transaction; reset those separately if needed.
 */
export async function clearCreditData(): Promise<DeletionSummary> {
  const firestore = requireDb();
  await ensureFirebaseAuth();

  const creditTransactions = await deleteAllInChunks(
    firestore,
    collection(firestore, collections.creditTransactions),
  );
  const creditPayments = await deleteAllInChunks(
    firestore,
    collection(firestore, collections.creditPayments),
  );

  return { creditTransactions, creditPayments };
}

/**
 * Delete system logs: `auditLogs` and `staffActivities`.
 */
export async function clearSystemLogs(): Promise<DeletionSummary> {
  const firestore = requireDb();
  await ensureFirebaseAuth();

  const auditLogs = await deleteAllInChunks(
    firestore,
    collection(firestore, collections.auditLogs),
  );
  const staffActivities = await deleteAllInChunks(
    firestore,
    collection(firestore, collections.staffActivities),
  );

  return { auditLogs, staffActivities };
}

/**
 * Reset denormalized credit balances back to a clean slate so no "ghost debt"
 * survives after {@link clearCreditData} removes the underlying transactions:
 *   - `customers.outstandingBalance` → 0 (and the now-dangling credit-history
 *     timestamps `lastCreditPurchaseDate` / `lastPaymentDate` are cleared).
 *   - `creditAccounts`: `creditUsed` → 0, `overdueAmt` → 0, and `creditBalance`
 *     restored to the account's own `creditLimit` (balance = limit − used).
 *
 * Only credit fields are touched — CRM lifetime values (totalSpent, points, …)
 * and customer master data are left intact.
 */
export async function resetCustomerCreditBalances(): Promise<DeletionSummary> {
  const firestore = requireDb();
  await ensureFirebaseAuth();

  let customers = 0;
  let creditAccounts = 0;

  // One batch accumulates mixed customer + creditAccount writes; flush at the limit.
  let batch = writeBatch(firestore);
  let pending = 0;
  const flushIfFull = async () => {
    if (pending >= BATCH_LIMIT) {
      await batch.commit();
      batch = writeBatch(firestore);
      pending = 0;
    }
  };

  const customersSnap = await getDocs(collection(firestore, collections.customers));
  for (const customerDoc of customersSnap.docs) {
    batch.update(customerDoc.ref, {
      outstandingBalance: 0,
      lastCreditPurchaseDate: null,
      lastPaymentDate: null,
      updatedAt: serverTimestamp(),
    });
    pending += 1;
    customers += 1;
    await flushIfFull();
  }

  const accountsSnap = await getDocs(collection(firestore, collections.creditAccounts));
  for (const accountDoc of accountsSnap.docs) {
    const creditLimit = (accountDoc.data().creditLimit as number) ?? 0;
    batch.update(accountDoc.ref, {
      creditUsed: 0,
      // creditBalance = creditLimit − creditUsed; with usage cleared it equals the limit.
      creditBalance: creditLimit,
      overdueAmt: 0,
      lastTransAt: null,
      updatedAt: serverTimestamp(),
    });
    pending += 1;
    creditAccounts += 1;
    await flushIfFull();
  }

  if (pending > 0) {
    await batch.commit();
  }

  return {
    customersCreditReset: customers,
    creditAccountsReset: creditAccounts,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Hard-delete master data (UAT only) — these remove catalog/contact records
// entirely, not just their transactions. Use with extreme care.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hard-delete the entire product catalog. The per-branch `productStocks`
 * subcollection docs are removed first via a `collectionGroup` query (so no
 * orphaned subcollections survive their parent), then the `products` docs.
 */
export async function hardDeleteProducts(): Promise<DeletionSummary> {
  const firestore = requireDb();
  await ensureFirebaseAuth();

  // collectionGroup sweeps every productStocks doc regardless of parent product.
  const productStocks = await deleteAllInChunks(
    firestore,
    collectionGroup(firestore, collections.productStocks),
  );
  const products = await deleteAllInChunks(
    firestore,
    collection(firestore, collections.products),
  );

  return { productStocks, products };
}

/**
 * Hard-delete all customers along with their `creditAccounts` (a 1:1 master-data
 * record keyed by customerId). Credit accounts are removed first to avoid leaving
 * them orphaned.
 */
export async function hardDeleteCustomers(): Promise<DeletionSummary> {
  const firestore = requireDb();
  await ensureFirebaseAuth();

  const creditAccounts = await deleteAllInChunks(
    firestore,
    collection(firestore, collections.creditAccounts),
  );
  const customers = await deleteAllInChunks(
    firestore,
    collection(firestore, collections.customers),
  );

  return { creditAccounts, customers };
}

/**
 * Hard-delete all supplier master records.
 */
export async function hardDeleteSuppliers(): Promise<DeletionSummary> {
  const firestore = requireDb();
  await ensureFirebaseAuth();

  const suppliers = await deleteAllInChunks(
    firestore,
    collection(firestore, collections.suppliers),
  );

  return { suppliers };
}

/** Protected default category — must never be deleted (mirrors categoryService). */
const GENERAL_CATEGORY_ID = 'general';

/**
 * Hard-delete all product categories EXCEPT the protected default ('general').
 * Paged in chunks; the preserved 'general' doc is filtered out of every batch,
 * so once only it remains the loop finds nothing deletable and terminates.
 */
export async function hardDeleteCategories(): Promise<DeletionSummary> {
  const firestore = requireDb();
  await ensureFirebaseAuth();

  let categories = 0;
  for (;;) {
    const snap = await getDocs(
      query(collection(firestore, collections.categories), limit(BATCH_LIMIT)),
    );
    const deletable = snap.docs.filter((d) => d.id !== GENERAL_CATEGORY_ID);
    if (deletable.length === 0) break;

    const batch = writeBatch(firestore);
    for (const docSnap of deletable) batch.delete(docSnap.ref);
    await batch.commit();
    categories += deletable.length;

    if (snap.size < BATCH_LIMIT) break;
  }

  return { categories };
}

/**
 * Factory reset: run every clear/reset step in dependency-safe order and return
 * the merged document counts. Transactions are removed first, then the ledger and
 * FIFO lots, then peripheral history (shifts/cash, credit, logs), then credit
 * balances are zeroed, and finally product stock balances are zeroed.
 */
export async function clearAllTransactionData(): Promise<DeletionSummary> {
  const sales = await clearSalesData();
  const inventory = await clearInventoryTransactions();
  const ledger = await clearStockLedgerAndFifo();
  const shiftAndCash = await clearShiftAndCashData();
  const credit = await clearCreditData();
  const logs = await clearSystemLogs();
  const creditBalances = await resetCustomerCreditBalances();
  const stocks = await resetAllProductStocks();

  return {
    ...sales,
    ...inventory,
    ...ledger,
    ...shiftAndCash,
    ...credit,
    ...logs,
    ...creditBalances,
    ...stocks,
  };
}
