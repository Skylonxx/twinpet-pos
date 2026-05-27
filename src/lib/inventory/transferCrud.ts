import {
  collection,
  doc,
  getDoc,
  increment,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Product, ProductStock, StockMovement } from '../types';
import { devConfirmBranchTransfer } from './transferDevMock';
import {
  generateTransferId,
  type BranchTransferForm,
  type BranchTransferLineInput,
  type InventoryTransferItem,
} from './transferTypes';

export async function confirmBranchTransfer(
  form: BranchTransferForm,
  items: BranchTransferLineInput[],
): Promise<string> {
  const activeLines = items.filter((l) => l.transferQty > 0);
  if (activeLines.length === 0) {
    throw new Error('ไม่มีรายการที่โอนย้าย');
  }

  if (!form.toBranchId) {
    throw new Error('กรุณาเลือกสาขาปลายทาง');
  }

  if (form.toBranchId === form.fromBranchId) {
    throw new Error('สาขาปลายทางต้องไม่ซ้ำกับสาขาต้นทาง');
  }

  if (!isFirebaseConfigured || !db) {
    return devConfirmBranchTransfer(form, activeLines);
  }

  const firestore = db;
  const transferId = generateTransferId();
  const transferRef = doc(firestore, collections.inventoryTransfers, transferId);
  const itemsCol = collection(transferRef, collections.transferItems);
  const now = serverTimestamp();

  // Pre-read stock & cost before batch writes
  const productCtx = new Map<
    string,
    {
      avgCost: number;
      sourceStockRef: ReturnType<typeof doc>;
      destStockRef: ReturnType<typeof doc>;
      sourceStock: number;
    }
  >();

  for (const line of activeLines) {
    if (line.transferQty <= 0) {
      throw new Error(`จำนวนโอนต้องมากกว่า 0: ${line.name}`);
    }

    const productRef = doc(firestore, collections.products, line.productId);
    const sourceStockRef = doc(
      firestore,
      collections.products,
      line.productId,
      collections.productStocks,
      form.fromBranchId,
    );
    const destStockRef = doc(
      firestore,
      collections.products,
      line.productId,
      collections.productStocks,
      form.toBranchId,
    );

    const existing = productCtx.get(line.productId);
    if (existing) {
      if (line.transferQty > existing.sourceStock) {
        throw new Error(`สต็อกไม่เพียงพอ: ${line.name}`);
      }
      productCtx.set(line.productId, {
        ...existing,
        sourceStock: existing.sourceStock - line.transferQty,
      });
      continue;
    }

    const [productSnap, sourceSnap] = await Promise.all([
      getDoc(productRef),
      getDoc(sourceStockRef),
    ]);

    if (!productSnap.exists()) {
      throw new Error(`ไม่พบสินค้า: ${line.name}`);
    }

    const product = productSnap.data() as Product;
    const sourceStock = sourceSnap.exists()
      ? (sourceSnap.data() as ProductStock).totalStockBase
      : 0;

    if (line.transferQty > sourceStock) {
      throw new Error(`สต็อกไม่เพียงพอ: ${line.name} (คงเหลือ ${sourceStock})`);
    }

    productCtx.set(line.productId, {
      avgCost: product.avgCost ?? 0,
      sourceStockRef,
      destStockRef,
      sourceStock: sourceStock - line.transferQty,
    });
  }

  const savedItems: InventoryTransferItem[] = activeLines.map((line) => {
    const ctx = productCtx.get(line.productId);
    if (!ctx) throw new Error(`ไม่พบข้อมูลสินค้า: ${line.name}`);
    return {
      productId: line.productId,
      productName: line.name,
      sku: line.sku,
      sourceStock: line.sourceStock,
      transferQty: line.transferQty,
      unitCost: ctx.avgCost,
    };
  });

  const batch = writeBatch(firestore);

  batch.set(transferRef, {
    id: transferId,
    transferDate: form.transferDate,
    fromBranchId: form.fromBranchId,
    toBranchId: form.toBranchId,
    note: form.note.trim(),
    staffId: form.staffId,
    staffName: form.staffName,
    itemCount: savedItems.length,
    status: 'completed',
    createdAt: now,
  });

  for (const item of savedItems) {
    const ctx = productCtx.get(item.productId);
    if (!ctx) continue;

    batch.set(doc(itemsCol), item);

    batch.set(
      ctx.sourceStockRef,
      {
        branchId: form.fromBranchId,
        totalStockBase: increment(-item.transferQty),
        lastMovementAt: now,
        updatedAt: now,
      },
      { merge: true },
    );

    batch.set(
      ctx.destStockRef,
      {
        branchId: form.toBranchId,
        totalStockBase: increment(item.transferQty),
        lastMovementAt: now,
        updatedAt: now,
      },
      { merge: true },
    );

    const movementOutRef = doc(collection(firestore, collections.stockMovements));
    const movementOut: Omit<StockMovement, 'id'> = {
      productId: item.productId,
      branchId: form.fromBranchId,
      type: 'transfer_out',
      qty: -item.transferQty,
      costPerUnit: item.unitCost,
      refId: transferId,
      refType: 'inventoryTransfer',
      note: form.note.trim(),
      createdBy: form.staffId,
      createdAt: now as StockMovement['createdAt'],
    };
    batch.set(movementOutRef, movementOut);

    const movementInRef = doc(collection(firestore, collections.stockMovements));
    const movementIn: Omit<StockMovement, 'id'> = {
      productId: item.productId,
      branchId: form.toBranchId,
      type: 'transfer_in',
      qty: item.transferQty,
      costPerUnit: item.unitCost,
      refId: transferId,
      refType: 'inventoryTransfer',
      note: form.note.trim(),
      createdBy: form.staffId,
      createdAt: now as StockMovement['createdAt'],
    };
    batch.set(movementInRef, movementIn);
  }

  await batch.commit();
  return transferId;
}
