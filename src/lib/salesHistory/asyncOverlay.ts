import type { AsyncOrder, Order, OrderItem, Payment, Timestamp } from '../types';
import type { SaleRecord } from './types';

/**
 * Hybrid-overlay adapter (Standalone POS — Local-First).
 *
 * Sales History reads the canonical `orders` projection, which only exists AFTER
 * the reconciler settles a sale — so a just-rung / offline sale would be invisible
 * until it syncs. To close that gap we OVERLAY this terminal's still-pending
 * `asyncOrders` as synthetic {@link SaleRecord}s flagged `pendingSync`, rendered
 * with a "⏳ รอซิงก์" badge and a disabled Void button. Once a sale settles it
 * leaves the pending overlay and the canonical row takes over (deduped by id), so
 * no row is ever shown twice.
 *
 * `createdAt` is intentionally the numeric `clientCreatedAt` (ms) — Sales History
 * reads it through `parseTimestamp`, which accepts a number — because a pending
 * order has no `serverCreatedAt` yet.
 */
function asyncOrderToSaleRecord(a: AsyncOrder): SaleRecord {
  // parseTimestamp() accepts a number, so the device clock orders/filters fine.
  const createdAt = a.clientCreatedAt as unknown as Timestamp;

  const order: Order = {
    id: a.id,
    billId: a.billId,
    branchId: a.branchId,
    customerId: a.customerId,
    customerSnap: a.customerSnap,
    staffId: a.staffId,
    staffName: a.staffName,
    shiftId: a.shiftId,
    status: a.status,
    subtotal: a.subtotal,
    discountAmt: a.discountAmt,
    billDiscount: a.billDiscount,
    vatRate: a.vatRate,
    vatAmt: a.vatAmt,
    surcharge: a.fee,
    total: a.total,
    paidAmt: a.paidAmt,
    changeAmt: a.changeAmt,
    creditAmt: a.creditAmt,
    cogs: a.cogs,
    profit: a.profit,
    priceLevelId: a.priceLevelId,
    note: a.note,
    voidReason: a.voidReason ?? null,
    voidedBy: a.voidedBy ?? null,
    voidedAt: a.voidedAt ?? null,
    printCount: a.printCount,
    createdAt,
    updatedAt: createdAt,
  };

  const payments: Payment[] = a.payments.map((p, i) => ({
    id: `${a.id}-p${i}`,
    orderId: a.id,
    branchId: a.branchId,
    method: p.method,
    amount: p.amount,
    ref: p.ref ?? null,
    createdAt,
  }));

  const items: OrderItem[] = a.lines.map((l, i) => ({
    id: `${a.id}-i${i}`,
    productId: l.productId,
    productSnap: l.productSnap,
    unit: l.unit,
    unitFactor: l.unitFactor,
    qty: l.qty,
    qtyBase: l.qtyBase,
    unitPrice: l.unitPrice,
    originalPrice: l.originalPrice,
    discountAmt: l.discountAmt,
    lineTotal: l.lineTotal,
    fifoCost: l.fifoCost ?? 0,
    lotRefs: l.lotRefs ?? [],
  }));

  return { order, payments, items, pendingSync: true };
}

/**
 * Build the pending overlay rows from a cache snapshot of this device's
 * `asyncOrders`. Includes every NOT-yet-settled order (`pending_reconcile`),
 * which by definition excludes settled (→ canonical projection) and `exception`
 * docs.
 *
 * NOTE (Phase 6 — offline void): voided / void-requested pending orders are
 * deliberately KEPT here so the cashier sees the bill LINGER in history with a
 * "ยกเลิก" (voided) badge — clear confirmation their void took effect. This is a
 * display-only choice: the drawer (`selectLocalLedger`) and dashboard
 * (`buildDashboardOverlay`) still run `isLedgerSale`, so a voided bill is
 * strictly EXCLUDED from all totals. `computeSummary` likewise skips voided rows.
 */
export function buildPendingOverlay(orders: readonly AsyncOrder[]): SaleRecord[] {
  return orders
    .filter((o) => o.reconcileStatus === 'pending_reconcile')
    .map(asyncOrderToSaleRecord);
}

/**
 * Merge canonical Sales-History records with the pending overlay. Canonical wins
 * on id collision (defensive — a settled sale should already have left the
 * overlay). Sorting is left to the caller's existing `createdAt desc` memo.
 */
export function mergeWithOverlay(
  canonical: readonly SaleRecord[],
  overlay: readonly SaleRecord[],
): SaleRecord[] {
  const seen = new Set(canonical.map((r) => r.order.id));
  return [...canonical, ...overlay.filter((r) => !seen.has(r.order.id))];
}
