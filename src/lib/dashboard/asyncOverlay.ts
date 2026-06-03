import { isLedgerSale } from '../pos/localLedger';
import type { AsyncOrder } from '../types';
import type { DashboardPaymentRecord, DashboardSaleLine } from './types';

/**
 * Hybrid-overlay adapter for the operational dashboard (Standalone POS —
 * Local-First). The dashboard reads the canonical `orders`/`payments`
 * projection, which only materializes after the reconciler settles a sale. This
 * adapter projects this terminal's still-pending `asyncOrders` into the same
 * `DashboardSaleLine` / `DashboardPaymentRecord` shapes so "today's" revenue
 * reflects offline/just-rung sales instantly, before they sync.
 *
 * COGS is unknown until the server reconciler assigns FIFO, so pending lines
 * carry `cogs: 0` — revenue (the headline) is exact; gross profit is a slight
 * over-estimate that self-corrects the moment the sale settles into canonical.
 */
export type DashboardOverlay = {
  lines: DashboardSaleLine[];
  payments: DashboardPaymentRecord[];
};

/**
 * Build the pending overlay for `[start, end]`, keyed on the device clock
 * (`clientCreatedAt`) since a pending order has no server time yet. Only
 * ledger-visible, not-yet-settled sales within the window are included.
 */
export function buildDashboardOverlay(
  orders: readonly AsyncOrder[],
  start: Date,
  end: Date,
): DashboardOverlay {
  const lines: DashboardSaleLine[] = [];
  const payments: DashboardPaymentRecord[] = [];

  for (const a of orders) {
    if (a.reconcileStatus !== 'pending_reconcile' || !isLedgerSale(a)) continue;
    const createdAt = new Date(a.clientCreatedAt);
    if (createdAt < start || createdAt > end) continue;

    const customerName = a.customerSnap?.name ?? 'สมาชิกทั่วไป';
    for (const l of a.lines) {
      lines.push({
        orderId: a.id,
        createdAt,
        productId: l.productId,
        productName: l.productSnap.name,
        category: l.productSnap.category,
        customerName,
        revenue: l.lineTotal,
        cogs: 0, // assigned by the reconciler; unknown while pending
        qty: l.qty,
        paymentMethod: 'cash',
      });
    }
    for (const p of a.payments) {
      payments.push({ orderId: a.id, method: p.method, amount: p.amount, createdAt });
    }
  }

  return { lines, payments };
}

/**
 * Merge canonical dashboard data with the pending overlay, dropping any overlay
 * rows whose `orderId` already exists in canonical (a settled sale that has both
 * a pending cache doc and a canonical projection during the brief sync window).
 */
export function mergeDashboardOverlay(
  canonicalLines: readonly DashboardSaleLine[],
  canonicalPayments: readonly DashboardPaymentRecord[],
  overlay: DashboardOverlay,
): { saleLines: DashboardSaleLine[]; paymentRecords: DashboardPaymentRecord[] } {
  const canonicalOrderIds = new Set(canonicalLines.map((l) => l.orderId));
  const canonicalPaymentOrderIds = new Set(canonicalPayments.map((p) => p.orderId));
  return {
    saleLines: [
      ...canonicalLines,
      ...overlay.lines.filter((l) => !canonicalOrderIds.has(l.orderId)),
    ],
    paymentRecords: [
      ...canonicalPayments,
      ...overlay.payments.filter((p) => !canonicalPaymentOrderIds.has(p.orderId)),
    ],
  };
}
