import {
  collection,
  doc,
  increment,
  runTransaction,
  serverTimestamp,
  type DocumentReference,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Product, ProductStock, StockLot, StockMovement } from '../types';
import {
  fetchActiveLotRefs,
  mergeLotCuts,
  planFifoCutFromState,
  readProductLotsInTransaction,
  type MutableLot,
} from '../fifo';
import { devConfirmInventoryAdjustment } from './devMock';
import {
  computeLineImpact,
  computeTotalValueImpact,
  generateAdjId,
  type ConfirmInventoryAdjustmentInput,
  type InventoryAdjustmentItem,
} from './types';

/** A freshly created lot for a positive (ADJUST_IN) adjustment line. */
type NewLotPlan = {
  ref: DocumentReference;
  mutable: MutableLot;
  costPerUnit: number;
  /** Original amount created (base units) — `mutable.qtyRemaining` may shrink
   *  if a later negative line in the same adjustment cuts from this lot. */
  qtyReceived: number;
};

/** Per-product working state assembled during the read phase. */
type ProductCtx = {
  productRef: DocumentReference;
  stockRef: DocumentReference;
  avgCost: number;
  allowNegative: boolean;
  /** Running base-unit stock, advanced line-by-line (handles duplicate products). */
  runningStock: number;
  /** Net base-unit delta across all lines for this product (for one stock write). */
  netDelta: number;
  /** Existing lots (oldest-first) + appended new-lot mutables. Mutated by FIFO cuts. */
  lotPool: MutableLot[];
  /** Initial qtyRemaining per EXISTING lot path — to recompute isDepleted. */
  initialLotQty: Map<string, number>;
  /** New lots created by positive lines, keyed by ref path. */
  newLots: Map<string, NewLotPlan>;
  /** Accumulated FIFO cuts (against existing and/or new lots). */
  cuts: ReturnType<typeof planFifoCutFromState>['cuts'];
};

/**
 * Confirm an inventory adjustment — now FIFO lot-aware.
 *
 * Every quantity is in BASE UNITS (`AdjustmentLine.adjustQty` is already a
 * base-unit signed delta, so no unit-factor conversion is needed here).
 *
 * Per line:
 *   • adjustQty < 0 (ADJUST_OUT / shrinkage): decrement `totalStockBase` AND
 *     FIFO-cut the oldest `stockLots`. Throws if the resulting stock is
 *     negative and the product disallows negative stock.
 *   • adjustQty > 0 (ADJUST_IN): increment `totalStockBase` AND create a new
 *     lot priced at the product's current `avgCost` (0 when none).
 *   • Always append a `stockMovements` ledger row (type 'adjust').
 *
 * Strict 3-phase transaction: lot refs are queried OUTSIDE the tx, then
 * Phase 1 reads → Phase 2 plans in memory → Phase 3 writes.
 */
export async function confirmInventoryAdjustment(
  input: ConfirmInventoryAdjustmentInput,
): Promise<string> {
  const activeLines = input.lines.filter((l) => l.adjustQty !== 0);
  if (activeLines.length === 0) {
    throw new Error('ไม่มีรายการที่ปรับปรุง');
  }

  // Dev / no-Firebase path is summary-only (no lot simulation) — unchanged.
  if (!isFirebaseConfigured || !db) {
    return devConfirmInventoryAdjustment({ ...input, lines: activeLines });
  }

  const firestore = db;
  const adjustmentId = generateAdjId();
  const uniqueProductIds = [...new Set(activeLines.map((l) => l.productId))];

  // Only products with a deduction need their existing lots read for FIFO cuts.
  const productsNeedingLots = new Set(
    activeLines.filter((l) => l.adjustQty < 0).map((l) => l.productId),
  );

  // ── Pre-transaction: discover lot refs (queries can't run inside a tx) ──
  const lotRefsByProduct = new Map<string, DocumentReference[]>();
  for (const productId of productsNeedingLots) {
    lotRefsByProduct.set(
      productId,
      await fetchActiveLotRefs(firestore, productId, input.branchId),
    );
  }

  await runTransaction(firestore, async (tx) => {
    const now = serverTimestamp();
    const adjustmentRef = doc(firestore, collections.inventoryAdjustments, adjustmentId);
    const itemsCol = collection(adjustmentRef, collections.adjustmentItems);

    // ── Phase 1: READS ONLY ──────────────────────────────────────────────
    const productCtx = new Map<string, ProductCtx>();

    for (const productId of uniqueProductIds) {
      const productRef = doc(firestore, collections.products, productId);
      const stockRef = doc(
        firestore,
        collections.products,
        productId,
        collections.productStocks,
        input.branchId,
      );

      const [productSnap, stockSnap] = await Promise.all([
        tx.get(productRef),
        tx.get(stockRef),
      ]);

      if (!productSnap.exists()) {
        throw new Error(`ไม่พบสินค้า: ${productId}`);
      }

      const product = productSnap.data() as Product;
      const stock = stockSnap.exists() ? (stockSnap.data() as ProductStock) : null;

      let lotPool: MutableLot[] = [];
      const initialLotQty = new Map<string, number>();
      if (productsNeedingLots.has(productId)) {
        const refs = lotRefsByProduct.get(productId) ?? [];
        lotPool = await readProductLotsInTransaction(tx, refs);
        for (const lot of lotPool) {
          initialLotQty.set(lot.ref.path, lot.qtyRemaining);
        }
      }

      productCtx.set(productId, {
        productRef,
        stockRef,
        avgCost: product.avgCost ?? 0,
        allowNegative: product.allowNegativeStock === true,
        runningStock: stock?.totalStockBase ?? 0,
        netDelta: 0,
        lotPool,
        initialLotQty,
        newLots: new Map(),
        cuts: [],
      });
    }

    // ── Phase 2: PLAN in memory (no tx I/O — doc() only generates ids) ────
    const itemPlans: Array<{
      item: InventoryAdjustmentItem;
      movementRef: DocumentReference;
    }> = [];

    for (const line of activeLines) {
      const ctx = productCtx.get(line.productId);
      if (!ctx) throw new Error(`ไม่พบข้อมูลสินค้า: ${line.productId}`);

      const currentStock = ctx.runningStock;
      const computedNewStock = currentStock + line.adjustQty;

      if (computedNewStock < 0 && !ctx.allowNegative) {
        throw new Error(`ยอดคงเหลือใหม่ติดลบ: ${line.name}`);
      }

      const { unitCost, valueImpact } = computeLineImpact(line.adjustQty, ctx.avgCost);

      if (line.adjustQty < 0) {
        // ADJUST_OUT — FIFO cut the oldest lots (mutates ctx.lotPool in place).
        const need = Math.abs(line.adjustQty);
        const { cuts, remaining } = planFifoCutFromState(ctx.lotPool, need);
        ctx.cuts.push(...cuts);

        // Counter said OK but lots fell short → pre-existing lot/counter drift.
        // We don't block here (the authoritative totalStockBase guard above
        // already passed); the un-lotted remainder is counter-only, matching
        // how the POS sale path tolerates oversell.
        if (remaining > 0) {
          console.warn(
            `[confirmInventoryAdjustment] lot shortfall for ${line.name}: ` +
              `${remaining} base unit(s) not covered by lots (totalStockBase ok)`,
          );
        }
      } else {
        // ADJUST_IN — create a new lot priced at current avgCost (0 if none).
        const lotRef = doc(collection(firestore, collections.stockLots));
        const mutable: MutableLot = {
          ref: lotRef,
          id: lotRef.id,
          qtyRemaining: line.adjustQty,
          costPerUnit: ctx.avgCost,
          receivedAtMs: Date.now(), // newest → only cut after existing lots
        };
        ctx.newLots.set(lotRef.path, {
          ref: lotRef,
          mutable,
          costPerUnit: ctx.avgCost,
          qtyReceived: line.adjustQty,
        });
        // Make it available to any later negative line for the same product.
        ctx.lotPool.push(mutable);
      }

      ctx.runningStock = computedNewStock;
      ctx.netDelta += line.adjustQty;

      itemPlans.push({
        item: {
          productId: line.productId,
          productName: line.name,
          sku: line.sku,
          currentStock,
          adjustQty: line.adjustQty,
          newStock: computedNewStock,
          unitCost,
          valueImpact,
        },
        movementRef: doc(collection(firestore, collections.stockMovements)),
      });
    }

    const totalValueImpact = computeTotalValueImpact(itemPlans.map((p) => p.item));

    // ── Phase 3: WRITES ONLY ─────────────────────────────────────────────
    tx.set(adjustmentRef, {
      id: adjustmentId,
      branchId: input.branchId,
      adjustDate: input.adjustDate,
      reason: input.reason,
      note: input.note.trim(),
      staffId: input.staffId,
      staffName: input.staffName,
      itemCount: itemPlans.length,
      totalValueImpact,
      status: 'completed',
      createdAt: now,
    });

    // Per-line: adjustment item + stock movement ledger row.
    for (const plan of itemPlans) {
      const itemRef = doc(itemsCol);
      tx.set(itemRef, plan.item);

      const movement: Omit<StockMovement, 'id'> = {
        productId: plan.item.productId,
        branchId: input.branchId,
        type: 'adjust',
        qty: plan.item.adjustQty,
        costPerUnit: plan.item.unitCost,
        refId: adjustmentId,
        refType: 'inventoryAdjustment',
        note: input.reason,
        createdBy: input.staffId,
        createdAt: now as StockMovement['createdAt'],
      };
      tx.set(plan.movementRef, movement);
    }

    // Per-product: one stock delta, existing-lot cuts, and new-lot creates.
    for (const [productId, ctx] of productCtx) {
      if (ctx.netDelta !== 0) {
        tx.set(
          ctx.stockRef,
          {
            branchId: input.branchId,
            totalStockBase: increment(ctx.netDelta),
            lastMovementAt: now,
            updatedAt: now,
          },
          { merge: true },
        );
      }

      const newLotPaths = new Set(ctx.newLots.keys());

      // Apply cuts to EXISTING lots (new lots are written with their final qty
      // below, so skip them here to avoid two writes to the same doc).
      for (const cut of mergeLotCuts(ctx.cuts)) {
        if (newLotPaths.has(cut.ref.path)) continue;
        const initialQty = ctx.initialLotQty.get(cut.ref.path) ?? cut.cutQty;
        tx.update(cut.ref, {
          qtyRemaining: increment(-cut.cutQty),
          isDepleted: initialQty - cut.cutQty <= 0,
        });
      }

      // Create new lots with their FINAL qtyRemaining (after any same-tx cuts).
      for (const newLot of ctx.newLots.values()) {
        const finalQty = newLot.mutable.qtyRemaining;
        const lot: StockLot = {
          id: newLot.ref.id,
          productId,
          branchId: input.branchId,
          receivingId: adjustmentId, // source document for this lot
          costPerUnit: newLot.costPerUnit,
          qtyReceived: newLot.qtyReceived,
          qtyRemaining: finalQty,
          receivedAt: now as StockLot['receivedAt'],
          expiryDate: null,
          isDepleted: finalQty <= 0,
          isGhost: false,
          createdAt: now as StockLot['createdAt'],
        };
        tx.set(newLot.ref, lot);
      }
    }
  });

  return adjustmentId;
}
