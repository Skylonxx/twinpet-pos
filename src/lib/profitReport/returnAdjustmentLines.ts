/**
 * Profit / COGS report — accepted Return adjustments (D-RET-FIX-9).
 *
 * The report measures revenue as Σ line total (before bill discount) and COGS
 * as the sale-time FIFO cost. An accepted Return therefore contributes one
 * NEGATIVE line per returned sale line on the SAME basis:
 *   revenue −= gross line revenue reversed (cumulative-exact, line-total basis)
 *   COGS    −= sale-time cost of the restored cost layers
 *   profit   = revenue − COGS
 * attributed to the original sale (same bill, same sale date). The original
 * order/orderItems documents are never altered.
 */

import { productVisual } from '../stockReport/types';
import type { SaleReturnAdjustment } from '../saleReturn/returnAdjustments';
import type { ProfitSaleLine } from './types';

export type ProfitOrderMeta = { date: string; time: string; bill: string; customer: string };

export function returnAdjustmentToProfitLines(
  adjustment: SaleReturnAdjustment,
  meta: ProfitOrderMeta,
  imageByProduct?: ReadonlyMap<string, string | null>,
): ProfitSaleLine[] {
  return adjustment.lines.map((l) => {
    const category = l.category || 'อื่นๆ';
    const visual = productVisual(category);
    const revenue = -l.lineRevenueReversedMinor / 100;
    const cogs = -l.costRestoredMinor / 100;
    const profit = Math.round((revenue - cogs) * 100) / 100;
    return {
      id: `${adjustment.orderId}-ret-${adjustment.returnId}-${l.lineIndex}`,
      orderId: adjustment.orderId,
      date: meta.date,
      time: meta.time,
      bill: meta.bill,
      customer: meta.customer,
      productId: l.productId,
      productName: `คืนสินค้า ${adjustment.returnNo}: ${l.productName}`,
      productSku: l.sku,
      category,
      emoji: visual.emoji,
      iconBg: visual.iconBg,
      imageUrl: imageByProduct?.get(l.productId) ?? null,
      qty: -l.returnedQty,
      salePrice: l.unitPrice,
      revenue,
      cogs,
      profit,
      margin: 0,
      isReturnAdjustment: true,
    };
  });
}

/** All Return adjustment lines for orders present in the report (voided / unknown orders are skipped). */
export function buildReturnAdjustmentLines(
  adjustments: readonly SaleReturnAdjustment[],
  orderMeta: ReadonlyMap<string, ProfitOrderMeta>,
  imageByProduct?: ReadonlyMap<string, string | null>,
): ProfitSaleLine[] {
  const seen = new Set<string>();
  const out: ProfitSaleLine[] = [];
  for (const a of adjustments) {
    if (seen.has(a.returnId)) continue;
    seen.add(a.returnId);
    const meta = orderMeta.get(a.orderId);
    if (!meta) continue;
    out.push(...returnAdjustmentToProfitLines(a, meta, imageByProduct));
  }
  return out;
}
