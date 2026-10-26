/**
 * UAT mock-data seeder — RETIRED (019).
 *
 * `seedMockData` is refused on every runtime, before its first Firestore read, auth
 * call, batch or write ({@link UatToolRetiredError}). The old seeder upserted FIXED
 * ids (`PROD-001`, `CUST-001`, …) with `merge`, so on a database that holds real data
 * it overwrote any colliding product, its `productStocks/{branchId}.totalStockBase`
 * and its seed FIFO lot `stockLots/{productId}_{branchId}_seed` (`qtyRemaining`), and
 * a failure part-way left a partial seed. A client cannot make that safe.
 *
 * The mock fixtures under {@link ./mocks/} are left untouched and are no longer
 * imported by any source file. A UAT seed needs a separately authorized server-side
 * tool. The previous implementation is in git history (dc8f446).
 */
import { refuseRetiredUatTool, UAT_SEED_RETIRED_MESSAGE } from './admin/uatToolRetired';

/** Retired (019): would upsert fixed-id customers, suppliers, products, stock and FIFO lots. */
export async function seedMockData(): Promise<never> {
  return refuseRetiredUatTool('seedMockData', UAT_SEED_RETIRED_MESSAGE);
}
