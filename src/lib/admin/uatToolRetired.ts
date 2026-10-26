/**
 * 019 — retired UAT-only client tools.
 *
 * The global master-data hard deletes (customers / suppliers / categories) and the
 * Seed Zone (`seedMockData`) are refused on EVERY runtime — including local, dev and
 * offline — before their first Firestore read, auth call, batch or write. A client
 * cannot make them safe:
 *   - hard deletes are cross-branch and paged, so a failure leaves a partial wipe, and
 *     the sales / credit / receiving / Return records that reference the deleted
 *     customers, suppliers and categories are left dangling;
 *   - the seeder upserts FIXED ids (PROD-001, …), overwriting the real
 *     `productStocks.totalStockBase` and `stockLots.qtyRemaining` (FIFO) of any
 *     product that collides with them.
 * Bringing them back needs a separately authorized server-side tool. The previous
 * implementations are in git history (dc8f446).
 *
 * This is deliberately distinct from the 018 Danger Zone refusal
 * (`DangerZoneResetBlockedError`), whose wording is about shift / cash / refund records.
 */

export const UAT_TOOL_RETIRED_CODE = 'uat_tool_retired_unsafe_client_write' as const;

export const UAT_MASTER_HARD_DELETE_RETIRED_MESSAGE =
  'ยกเลิกเครื่องมือนี้แล้วเพื่อความปลอดภัย — คำสั่งนี้ไม่ได้อ่านหรือลบข้อมูลใด ๆ: ' +
  'การลบลูกค้า ซัพพลายเออร์ หรือหมวดหมู่ทั้งหมดของทุกสาขาแบบถาวร ' +
  'ทำให้ประวัติการขาย เครดิต การรับสินค้า และการคืนเงินอ้างอิงถึงข้อมูลที่ไม่มีอยู่แล้ว ' +
  'และแอปนี้ลบให้ครบหรือย้อนกลับไม่ได้ การเพิ่ม แก้ไข หรือลบข้อมูลทีละรายการตามปกติยังใช้งานได้';

export const UAT_SEED_RETIRED_MESSAGE =
  'ยกเลิกเครื่องมือนี้แล้วเพื่อความปลอดภัย — คำสั่งนี้ไม่ได้เขียนข้อมูลใด ๆ: ' +
  'การนำเข้าข้อมูลตัวอย่างใช้รหัสคงที่ (เช่น PROD-001) และเขียนทับสินค้า ' +
  'สต็อกคงเหลือ และล็อต FIFO จริงที่มีรหัสเดียวกันได้';

/** Typed refusal of a retired UAT tool; thrown before anything is read, authenticated or written. */
export class UatToolRetiredError extends Error {
  readonly code = UAT_TOOL_RETIRED_CODE;
  readonly action: string;

  constructor(action: string, message: string) {
    super(message);
    this.name = 'UatToolRetiredError';
    this.action = action;
  }
}

export function refuseRetiredUatTool(action: string, message: string): never {
  throw new UatToolRetiredError(action, message);
}
