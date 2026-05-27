import {
  collection,
  doc,
  increment,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Product, ProductStock, StockMovement } from '../types';
import { devConfirmInventoryAdjustment } from './devMock';
import {
  computeLineImpact,
  computeTotalValueImpact,
  generateAdjId,
  newStock,
  type ConfirmInventoryAdjustmentInput,
  type InventoryAdjustmentItem,
} from './types';

export async function confirmInventoryAdjustment(
  input: ConfirmInventoryAdjustmentInput,
): Promise<string> {
  const activeLines = input.lines.filter((l) => l.adjustQty !== 0);
  if (activeLines.length === 0) {
    throw new Error('ไม่มีรายการที่ปรับปรุง');
  }

  for (const line of activeLines) {
    if (newStock(line) < 0) {
      throw new Error(`ยอดคงเหลือใหม่ติดลบ: ${line.name}`);
    }
  }

  if (!isFirebaseConfigured || !db) {
    return devConfirmInventoryAdjustment({ ...input, lines: activeLines });
  }

  const firestore = db;
  const adjustmentId = generateAdjId();
  const uniqueProductIds = [...new Set(activeLines.map((l) => l.productId))];

  await runTransaction(firestore, async (tx) => {
    const now = serverTimestamp();
    const adjustmentRef = doc(firestore, collections.inventoryAdjustments, adjustmentId);
    const itemsCol = collection(adjustmentRef, collections.adjustmentItems);

    // ── Phase 1: READS ONLY ──────────────────────────────────────────────
    const productCtx = new Map<
      string,
      { avgCost: number; stockRef: ReturnType<typeof doc>; currentStock: number }
    >();

    for (const productId of uniqueProductIds) {
      const productRef = doc(firestore, collections.products, productId);
      const stockRef = doc(
        firestore,
        collections.products,
        productId,
        collections.productStocks,
        input.branchId,
      );

      const [productSnap, stockSnap] = await Promise.all([tx.get(productRef), tx.get(stockRef)]);

      if (!productSnap.exists()) {
        throw new Error(`ไม่พบสินค้า: ${productId}`);
      }

      const product = productSnap.data() as Product;
      const stock = stockSnap.exists() ? (stockSnap.data() as ProductStock) : null;

      productCtx.set(productId, {
        avgCost: product.avgCost ?? 0,
        stockRef,
        currentStock: stock?.totalStockBase ?? 0,
      });
    }

    // ── Phase 2: COMPUTE in memory ───────────────────────────────────────
    const items: InventoryAdjustmentItem[] = activeLines.map((line) => {
      const ctx = productCtx.get(line.productId);
      if (!ctx) throw new Error(`ไม่พบข้อมูลสินค้า: ${line.productId}`);

      const currentStock = ctx.currentStock;
      const { unitCost, valueImpact } = computeLineImpact(line.adjustQty, ctx.avgCost);
      const computedNewStock = currentStock + line.adjustQty;

      if (computedNewStock < 0) {
        throw new Error(`ยอดคงเหลือใหม่ติดลบ: ${line.name}`);
      }

      // Track running stock for duplicate products in same adjustment
      productCtx.set(line.productId, {
        ...ctx,
        currentStock: computedNewStock,
      });

      return {
        productId: line.productId,
        productName: line.name,
        sku: line.sku,
        currentStock,
        adjustQty: line.adjustQty,
        newStock: computedNewStock,
        unitCost,
        valueImpact,
      };
    });

    const totalValueImpact = computeTotalValueImpact(items);

    // ── Phase 3: WRITES ONLY ─────────────────────────────────────────────
    tx.set(adjustmentRef, {
      id: adjustmentId,
      branchId: input.branchId,
      adjustDate: input.adjustDate,
      reason: input.reason,
      note: input.note.trim(),
      staffId: input.staffId,
      staffName: input.staffName,
      itemCount: items.length,
      totalValueImpact,
      status: 'completed',
      createdAt: now,
    });

    for (const item of items) {
      const ctx = productCtx.get(item.productId);
      if (!ctx) continue;

      const itemRef = doc(itemsCol);
      tx.set(itemRef, item);

      tx.set(
        ctx.stockRef,
        {
          branchId: input.branchId,
          totalStockBase: increment(item.adjustQty),
          lastMovementAt: now,
          updatedAt: now,
        },
        { merge: true },
      );

      const movementRef = doc(collection(firestore, collections.stockMovements));
      const movement: Omit<StockMovement, 'id'> = {
        productId: item.productId,
        branchId: input.branchId,
        type: 'adjust',
        qty: item.adjustQty,
        costPerUnit: item.unitCost,
        refId: adjustmentId,
        refType: 'inventoryAdjustment',
        note: input.reason,
        createdBy: input.staffId,
        createdAt: now as StockMovement['createdAt'],
      };
      tx.set(movementRef, movement);
    }
  });

  return adjustmentId;
}
