import {
  Timestamp,
  collection,
  doc,
  getDocs,
  increment,
  query,
  runTransaction,
  serverTimestamp,
  where,
  type DocumentReference,
  type Firestore,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { ProductStock, Receiving, ReceivingItem, Settings, StockLot, StockMovement } from '../types';
import { devConfirmReceiving } from './devMock';
import { allocateReceivingNumber } from './receivingId';
import {
  lineCostBase,
  lineQtyBase,
  lineSubtotal,
  receivingGrandTotal,
  receivingSubtotal,
  type ConfirmReceivingInput,
  type ReceivingLine,
} from './types';

async function queryGhostLots(firestore: Firestore, productId: string, branchId: string) {
  const snap = await getDocs(
    query(
      collection(firestore, collections.stockLots),
      where('productId', '==', productId),
      where('branchId', '==', branchId),
      where('isGhost', '==', true),
      where('isDepleted', '==', false),
    ),
  );
  return snap.docs;
}

function parseExpiry(line: ReceivingLine): Date | null {
  if (!line.hasExpiry || !line.expiryDate) return null;
  const d = new Date(line.expiryDate);
  return Number.isNaN(d.getTime()) ? null : d;
}

type GhostLotState = {
  ref: DocumentReference;
  qtyRemaining: number;
  isGhost: boolean;
  isDepleted: boolean;
};

type ProductReadContext = {
  productId: string;
  productStockRef: DocumentReference;
  productRef: DocumentReference;
  currentStock: number;
  avgCost: number;
  productExists: boolean;
  ghosts: GhostLotState[];
};

type LineWritePlan = {
  line: ReceivingLine;
  qtyBase: number;
  costBase: number;
  lineSubtotal: number;
  primaryLotId: string;
  ghostUpdates: Array<{
    ref: DocumentReference;
    qtyRemaining: number;
    isGhost: boolean;
    isDepleted: boolean;
  }>;
  newLot: {
    ref: DocumentReference;
    qty: number;
    expiryDate: Date | null;
  } | null;
  movementRef: DocumentReference;
  itemRef: DocumentReference;
  newAvgCost: number;
};

export async function confirmReceiving(input: ConfirmReceivingInput): Promise<string> {
  if (input.lines.length === 0) {
    throw new Error('ไม่มีรายการสินค้า');
  }

  for (const line of input.lines) {
    if (line.qty <= 0) throw new Error(`จำนวนไม่ถูกต้อง: ${line.productName}`);
    if (line.costPerUnit < 0) throw new Error(`ต้นทุนไม่ถูกต้อง: ${line.productName}`);
  }

  if (!isFirebaseConfigured || !db) {
    return devConfirmReceiving(input);
  }

  const firestore = db;
  const receivingId =
    input.receivingId ??
    (await allocateReceivingNumber(firestore));
  const isFinalizingDraft = Boolean(input.receivingId);

  const uniqueProductIds = [...new Set(input.lines.map((l) => l.productId))];

  const ghostLotRefsByProduct = new Map<string, Awaited<ReturnType<typeof queryGhostLots>>>();
  for (const productId of uniqueProductIds) {
    ghostLotRefsByProduct.set(
      productId,
      await queryGhostLots(firestore, productId, input.branchId),
    );
  }

  let draftItemRefs: ReturnType<typeof doc>[] = [];
  if (isFinalizingDraft) {
    const preReceivingRef = doc(firestore, collections.receivings, receivingId);
    const preItemsCol = collection(preReceivingRef, collections.receivingItems);
    const oldItemsSnap = await getDocs(preItemsCol);
    draftItemRefs = oldItemsSnap.docs.map((d) => d.ref);
  }

  await runTransaction(firestore, async (tx) => {
    const now = serverTimestamp();
    const receivingRef = doc(firestore, collections.receivings, receivingId);
    const itemsCol = collection(receivingRef, collections.receivingItems);

    // ── Phase 1: ALL READS ───────────────────────────────────────────────
    if (isFinalizingDraft) {
      const existingSnap = await tx.get(receivingRef);
      if (!existingSnap.exists()) {
        throw new Error('ไม่พบเอกสารรับเข้า');
      }
      const existing = existingSnap.data() as Receiving;
      if (existing.branchId !== input.branchId) {
        throw new Error('เอกสารนี้ไม่ใช่ของสาขาปัจจุบัน');
      }
      if (existing.status !== 'draft') {
        throw new Error('เอกสารนี้ไม่ใช่แบบร่าง');
      }
    }

    const settingsRef = doc(firestore, collections.settings, input.branchId);
    const settingsSnap = await tx.get(settingsRef);
    const allowNegativeStock =
      (settingsSnap.data() as Settings | undefined)?.allowNegativeStock ?? false;

    const productCtx = new Map<string, ProductReadContext>();

    for (const productId of uniqueProductIds) {
      const productStockRef = doc(
        firestore,
        collections.products,
        productId,
        collections.productStocks,
        input.branchId,
      );
      const productRef = doc(firestore, collections.products, productId);

      const [stockSnap, productSnap] = await Promise.all([
        tx.get(productStockRef),
        tx.get(productRef),
      ]);

      const ghosts: GhostLotState[] = [];
      if (allowNegativeStock) {
        const ghostRefs = ghostLotRefsByProduct.get(productId) ?? [];
        for (const ghostDoc of ghostRefs) {
          const ghostSnap = await tx.get(ghostDoc.ref);
          if (!ghostSnap.exists()) continue;
          const ghost = ghostSnap.data() as StockLot;
          if (!ghost.isGhost || ghost.isDepleted || ghost.qtyRemaining >= 0) continue;
          ghosts.push({
            ref: ghostDoc.ref,
            qtyRemaining: ghost.qtyRemaining,
            isGhost: ghost.isGhost ?? true,
            isDepleted: ghost.isDepleted,
          });
        }
      }

      productCtx.set(productId, {
        productId,
        productStockRef,
        productRef,
        currentStock: (stockSnap.data() as ProductStock | undefined)?.totalStockBase ?? 0,
        avgCost: productSnap.exists() ? ((productSnap.data().avgCost as number) ?? 0) : 0,
        productExists: productSnap.exists(),
        ghosts,
      });
    }

    // ── Phase 2: PLAN WRITES (in memory only) ────────────────────────────
    const writePlans: LineWritePlan[] = [];

    for (const line of input.lines) {
      const ctx = productCtx.get(line.productId);
      if (!ctx) {
        throw new Error(`ไม่พบข้อมูลสินค้า: ${line.productName}`);
      }

      const qtyBase = lineQtyBase(line);
      const costBase = lineCostBase(line);

      let incoming = qtyBase;
      let primaryLotId = '';
      const ghostUpdates: LineWritePlan['ghostUpdates'] = [];

      if (allowNegativeStock) {
        for (const ghost of ctx.ghosts) {
          if (incoming <= 0 || ghost.isDepleted || ghost.qtyRemaining >= 0) continue;

          const deficit = Math.abs(ghost.qtyRemaining);
          const reconcileQty = Math.min(incoming, deficit);
          const newRemaining = ghost.qtyRemaining + reconcileQty;

          ghost.qtyRemaining = newRemaining;
          ghost.isGhost = newRemaining < 0;
          ghost.isDepleted = newRemaining === 0;

          ghostUpdates.push({
            ref: ghost.ref,
            qtyRemaining: newRemaining,
            isGhost: ghost.isGhost,
            isDepleted: ghost.isDepleted,
          });

          if (!primaryLotId) primaryLotId = ghost.ref.id;
          incoming -= reconcileQty;
        }
      }

      let newLot: LineWritePlan['newLot'] = null;
      if (incoming > 0) {
        const lotRef = doc(collection(firestore, collections.stockLots));
        newLot = {
          ref: lotRef,
          qty: incoming,
          expiryDate: parseExpiry(line),
        };
        primaryLotId = lotRef.id;
      }

      const oldStock = ctx.currentStock;
      const newStock = oldStock + qtyBase;
      const newAvgCost =
        newStock > 0
          ? (Math.max(0, oldStock) * ctx.avgCost + qtyBase * costBase) / newStock
          : costBase;

      ctx.currentStock = newStock;
      ctx.avgCost = newAvgCost;

      writePlans.push({
        line,
        qtyBase,
        costBase,
        lineSubtotal: lineSubtotal(line),
        primaryLotId,
        ghostUpdates,
        newLot,
        movementRef: doc(collection(firestore, collections.stockMovements)),
        itemRef: doc(itemsCol),
        newAvgCost,
      });
    }

    // ── Phase 3: ALL WRITES ──────────────────────────────────────────────
    if (isFinalizingDraft) {
      for (const itemRef of draftItemRefs) {
        tx.delete(itemRef);
      }
    }

    for (const plan of writePlans) {
      const ctx = productCtx.get(plan.line.productId)!;

      for (const ghostUpdate of plan.ghostUpdates) {
        tx.update(ghostUpdate.ref, {
          qtyRemaining: ghostUpdate.qtyRemaining,
          costPerUnit: plan.costBase,
          isGhost: ghostUpdate.isGhost,
          isDepleted: ghostUpdate.isDepleted,
          receivingId,
        });
      }

      if (plan.newLot) {
        const lot: StockLot = {
          id: plan.newLot.ref.id,
          productId: plan.line.productId,
          branchId: input.branchId,
          receivingId,
          costPerUnit: plan.costBase,
          qtyReceived: plan.newLot.qty,
          qtyRemaining: plan.newLot.qty,
          receivedAt: now as never,
          expiryDate: plan.newLot.expiryDate ? Timestamp.fromDate(plan.newLot.expiryDate) : null,
          isDepleted: false,
          isGhost: false,
          createdAt: now as never,
        };
        tx.set(plan.newLot.ref, lot);
      }

      tx.set(
        ctx.productStockRef,
        {
          branchId: input.branchId,
          totalStockBase: increment(plan.qtyBase),
          lastMovementAt: now,
          updatedAt: now,
        },
        { merge: true },
      );

      if (ctx.productExists) {
        tx.update(ctx.productRef, { avgCost: plan.newAvgCost, updatedAt: now });
      }

      const movement: StockMovement = {
        id: plan.movementRef.id,
        productId: plan.line.productId,
        branchId: input.branchId,
        type: 'receive',
        qty: plan.qtyBase,
        costPerUnit: plan.costBase,
        refId: receivingId,
        refType: 'receiving',
        note: input.note,
        createdBy: input.staffId,
        createdAt: now as never,
      };
      tx.set(plan.movementRef, movement);

      const item: ReceivingItem = {
        id: plan.itemRef.id,
        productId: plan.line.productId,
        productSnap: { name: plan.line.productName, sku: plan.line.sku },
        unit: plan.line.unit,
        unitFactor: plan.line.unitFactor,
        qty: plan.line.qty,
        qtyBase: plan.qtyBase,
        costPerUnit: plan.line.costPerUnit,
        costBase: plan.costBase,
        discountAmt: plan.line.itemDiscount,
        lineTotal: plan.lineSubtotal,
        lotId: plan.primaryLotId,
      };
      tx.set(plan.itemRef, item);
    }

    const linesSubtotal = receivingSubtotal(input.lines);
    const billDiscount = Math.max(0, input.finalDiscount || 0);
    const grandTotal = receivingGrandTotal(input.lines, billDiscount);

    const receiving: Receiving = {
      id: receivingId,
      branchId: input.branchId,
      supplierId: input.supplierId,
      supplierName: input.supplierName.trim() || '—',
      staffId: input.staffId,
      status: 'completed',
      subtotal: linesSubtotal,
      discountAmt: billDiscount,
      vatRate: 0,
      vatAmt: 0,
      total: grandTotal,
      payStatus: 'paid',
      paidAmt: grandTotal,
      note: input.note,
      receivedAt: now as never,
      createdAt: now as never,
      updatedAt: now as never,
    };
    if (isFinalizingDraft) {
      tx.update(receivingRef, {
        supplierId: receiving.supplierId,
        supplierName: receiving.supplierName,
        status: 'completed',
        subtotal: receiving.subtotal,
        discountAmt: receiving.discountAmt,
        total: receiving.total,
        payStatus: receiving.payStatus,
        paidAmt: receiving.paidAmt,
        note: receiving.note,
        receivedAt: now,
        updatedAt: now,
      });
    } else {
      tx.set(receivingRef, receiving);
    }
  });

  return receivingId;
}
