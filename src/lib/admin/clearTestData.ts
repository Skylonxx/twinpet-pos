/**
 * Developer / UAT helpers to wipe test data — only exposed behind the
 * "Danger Zone" tools on the Branch Management admin page.
 *
 * 018 reset safety: every reset that would write shifts, cash, sales, the credit
 * ledger, system logs or inventory is REFUSED before its first read, auth call or
 * write ({@link DangerZoneResetBlockedError}). A client cannot make those resets
 * safe:
 *   - `cashTransactions/rfd_*` (the server refund ledger) is undeletable by any
 *     client (017 Rules). A paged purge therefore fails part-way, after earlier
 *     500-write batches — and, in Factory Reset, whole earlier domains — have
 *     already committed.
 *   - Server-only records that reference these collections are unreadable to every
 *     client (Rules catch-all deny): `shiftCloseAuthorityRecords`, `saleRefunds`,
 *     `saleReturnLedgers`, `saleReturnAuditEvents` (incl. rejection audits written
 *     without any `saleReturns` doc) and `saleReturnAttemptResolutions`. The shift
 *     close journal (`shiftCloseEvidence` / `Cases` / `AuditEvents` / `Alerts` /
 *     `ValidationRuns`) is built from orders, asyncOrders, cash and creditPayments.
 *     Their absence can never be proven from here, so a "safe if empty" preflight
 *     is impossible, not merely expensive.
 * A UAT purge of those domains needs a separately authorized server-side tool.
 * The pre-018 implementations are in git history (d19a7cf).
 *
 * 019: the master data hard deletes (customers, suppliers, categories) are retired
 * the same way ({@link UatToolRetiredError}, see ./uatToolRetired): global, cross-branch,
 * paged and non-atomic, they leave sales, credit and receiving records dangling.
 * Ordinary per-record customer / supplier / category CRUD is unaffected.
 */
import {
  refuseRetiredUatTool,
  UAT_MASTER_HARD_DELETE_RETIRED_MESSAGE,
} from './uatToolRetired';

/** Per-collection counts of how many documents were touched. */
export type DeletionSummary = Record<string, number>;

export const DANGER_ZONE_RESET_BLOCKED_CODE = 'reset_blocked_server_owned_records' as const;

export const DANGER_ZONE_RESET_BLOCKED_MESSAGE =
  'ระงับเพื่อความปลอดภัย — ไม่มีข้อมูลถูกลบ: ข้อมูลกะ เงินสด การขาย เครดิต บันทึกระบบ และสต็อก ' +
  'เชื่อมโยงกับบันทึกการปิดกะและการคืนเงินที่เซิร์ฟเวอร์เป็นเจ้าของ ซึ่งแอปนี้ตรวจสอบหรือลบไม่ได้ ' +
  'การล้างเพียงบางส่วนจะทำให้ประวัติไม่ครบและไม่สอดคล้องกัน';

/** Typed refusal of a Danger Zone reset; thrown before anything is read or written. */
export class DangerZoneResetBlockedError extends Error {
  readonly code = DANGER_ZONE_RESET_BLOCKED_CODE;
  readonly action: string;

  constructor(action: string) {
    super(DANGER_ZONE_RESET_BLOCKED_MESSAGE);
    this.name = 'DangerZoneResetBlockedError';
    this.action = action;
  }
}

function refuseUnsafeReset(action: string): never {
  throw new DangerZoneResetBlockedError(action);
}

/** Blocked (018): would delete orders + orderItems, payments and asyncOrders. */
export async function clearSalesData(): Promise<DeletionSummary> {
  return refuseUnsafeReset('clearSalesData');
}

/** Blocked (018): would delete receivings, inventoryTransfers and inventoryAdjustments (+ items). */
export async function clearInventoryTransactions(): Promise<DeletionSummary> {
  return refuseUnsafeReset('clearInventoryTransactions');
}

/** Blocked (018): would delete the stock ledger (`stockMovements`) and FIFO lots (`stockLots`). */
export async function clearStockLedgerAndFifo(): Promise<DeletionSummary> {
  return refuseUnsafeReset('clearStockLedgerAndFifo');
}

/** Blocked (018): would zero every `productStocks.totalStockBase` and product `avgCost`. */
export async function resetAllProductStocks(): Promise<DeletionSummary> {
  return refuseUnsafeReset('resetAllProductStocks');
}

/** Blocked (018): would delete `shifts` and `cashTransactions` (incl. undeletable `rfd_*`). */
export async function clearShiftAndCashData(): Promise<DeletionSummary> {
  return refuseUnsafeReset('clearShiftAndCashData');
}

/** Blocked (018): would delete `creditTransactions` and `creditPayments`. */
export async function clearCreditData(): Promise<DeletionSummary> {
  return refuseUnsafeReset('clearCreditData');
}

/** Blocked (018): would delete `auditLogs` (incl. server `saleReturn_*` entries) and `staffActivities`. */
export async function clearSystemLogs(): Promise<DeletionSummary> {
  return refuseUnsafeReset('clearSystemLogs');
}

/** Blocked (018): would zero customer outstanding balances and credit account usage. */
export async function resetCustomerCreditBalances(): Promise<DeletionSummary> {
  return refuseUnsafeReset('resetCustomerCreditBalances');
}

// ───────────────────────────────────────────────────────────────────────────
// Hard-delete master data (UAT only) — these remove catalog/contact records
// entirely, not just their transactions. Use with extreme care.
// ───────────────────────────────────────────────────────────────────────────

/** Blocked (018): would delete every `productStocks` doc (inventory) and every product. */
export async function hardDeleteProducts(): Promise<DeletionSummary> {
  return refuseUnsafeReset('hardDeleteProducts');
}

/**
 * Retired (019): would hard-delete every `creditAccounts` doc and then every customer,
 * across all branches, leaving credit payments / sales / Return CRM references dangling.
 */
export async function hardDeleteCustomers(): Promise<DeletionSummary> {
  return refuseRetiredUatTool('hardDeleteCustomers', UAT_MASTER_HARD_DELETE_RETIRED_MESSAGE);
}

/** Retired (019): would hard-delete every supplier across all branches (receiving references dangle). */
export async function hardDeleteSuppliers(): Promise<DeletionSummary> {
  return refuseRetiredUatTool('hardDeleteSuppliers', UAT_MASTER_HARD_DELETE_RETIRED_MESSAGE);
}

/** Retired (019): would hard-delete every category except 'general' across all branches. */
export async function hardDeleteCategories(): Promise<DeletionSummary> {
  return refuseRetiredUatTool('hardDeleteCategories', UAT_MASTER_HARD_DELETE_RETIRED_MESSAGE);
}

/** Blocked (018): Factory Reset — would run every transaction / ledger / stock reset above in sequence. */
export async function clearAllTransactionData(): Promise<DeletionSummary> {
  return refuseUnsafeReset('clearAllTransactionData');
}

const RETIRED_UAT_TOOLS: ReadonlySet<() => Promise<DeletionSummary>> = new Set([
  hardDeleteCustomers,
  hardDeleteSuppliers,
  hardDeleteCategories,
]);

const BLOCKED_RESETS: ReadonlySet<() => Promise<DeletionSummary>> = new Set([
  clearSalesData,
  clearInventoryTransactions,
  clearStockLedgerAndFifo,
  resetAllProductStocks,
  clearShiftAndCashData,
  clearCreditData,
  clearSystemLogs,
  resetCustomerCreditBalances,
  hardDeleteProducts,
  clearAllTransactionData,
]);

/** Whether a Danger Zone action is refused by the 018 reset safety gate (drives the UI). */
export function isResetBlocked(run: () => Promise<DeletionSummary>): boolean {
  return BLOCKED_RESETS.has(run);
}

/** Whether a Danger Zone action is a retired UAT master hard delete (019; drives the UI). */
export function isUatToolRetired(run: () => Promise<DeletionSummary>): boolean {
  return RETIRED_UAT_TOOLS.has(run);
}
