/**
 * Phase 7 (Offline void — Phase B): PURE reversal planners.
 *
 * A sale that already SETTLED (cut FIFO lots, decremented stock, posted credit,
 * wrote a canonical `orders` doc) and is then voided must be reversed server-side
 * — the offline client cannot. These planners are pure data→delta functions with
 * zero `firebase-admin` dependency, so they are fully unit-testable; the
 * transaction wrapper in `reconcileOrder.ts` just applies the deltas.
 *
 * NOT handled here (by design): shift totals — the terminal is the single writer
 * of its drawer (it derives from the local ledger, which already drops a voided
 * order), so the reconciler must never touch `shifts.expected*`.
 */

/** Virtual lot id used when a sale oversells real stock — it has no lot doc. */
export const OVERSELL_LOT_ID = 'oversell';

export type ReversalLotRef = { lotId: string; qty: number; cost?: number };
export type ReversalLine = {
  productId: string;
  qtyBase: number;
  lotRefs?: ReversalLotRef[];
};

/** Quantity to add back to a real FIFO lot's `qtyRemaining`. */
export type LotRestock = { lotId: string; qty: number };
/** Quantity to add back to a product's branch `totalStockBase`. */
export type StockRestore = { productId: string; qtyBase: number };

export type CreditAccountData = { creditUsed: number; creditLimit: number };
export type CreditReversal = {
  /** Absolute (clamped) new `creditUsed` for the account. */
  newCreditUsed: number;
  /** Absolute new `creditBalance` (= limit − used). */
  newCreditBalance: number;
  /** Amount to subtract from the customer's `outstandingBalance`. */
  outstandingDecrement: number;
};

/**
 * Plan FIFO lot restocks: add each consumed `lotRef.qty` back to its lot,
 * MERGED per lot id (a lot cut across multiple lines is restocked once). The
 * virtual {@link OVERSELL_LOT_ID} is skipped — it has no lot doc to credit.
 */
export function planLotRestocks(lines: readonly ReversalLine[]): LotRestock[] {
  const byLot = new Map<string, number>();
  for (const line of lines) {
    for (const ref of line.lotRefs ?? []) {
      if (ref.lotId === OVERSELL_LOT_ID) continue;
      if (!(ref.qty > 0)) continue;
      byLot.set(ref.lotId, (byLot.get(ref.lotId) ?? 0) + ref.qty);
    }
  }
  return [...byLot.entries()].map(([lotId, qty]) => ({ lotId, qty }));
}

/**
 * Plan product-stock restores: add each line's `qtyBase` back to the product's
 * branch stock, MERGED per product id (the same product on multiple lines is
 * summed into one increment).
 */
export function planStockRestores(lines: readonly ReversalLine[]): StockRestore[] {
  const byProduct = new Map<string, number>();
  for (const line of lines) {
    const qty = line.qtyBase ?? 0;
    if (!(qty > 0)) continue;
    byProduct.set(line.productId, (byProduct.get(line.productId) ?? 0) + qty);
  }
  return [...byProduct.entries()].map(([productId, qtyBase]) => ({ productId, qtyBase }));
}

/**
 * Plan the credit reversal for a voided settled sale. Returns `null` when the
 * sale had no credit component or the customer has no credit account to reverse.
 * `creditUsed` is clamped at 0 to defend against inconsistent data.
 */
export function planCreditReversal(
  creditAmt: number,
  credData: CreditAccountData | null,
): CreditReversal | null {
  if (!(creditAmt > 0) || !credData) return null;
  const newCreditUsed = Math.max(0, credData.creditUsed - creditAmt);
  const newCreditBalance = credData.creditLimit - newCreditUsed;
  return { newCreditUsed, newCreditBalance, outstandingDecrement: creditAmt };
}
