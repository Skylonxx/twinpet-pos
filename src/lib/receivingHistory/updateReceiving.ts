import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import { devUpdateReceiving } from '../receiving/devMock';
import {
  lineCostBase,
  lineQtyBase,
  lineSubtotal,
  receivingGrandTotal,
  receivingSubtotal,
} from '../receiving/types';
import type { ProductStock, Receiving, ReceivingItem, StockLot, StockMovement } from '../types';
import type { EditReceivingLine, UpdateReceivingInput } from './types';

export type { UpdateReceivingInput };

function parseExpiry(line: EditReceivingLine): Date | null {
  if (!line.hasExpiry || !line.expiryDate) return null;
  const d = new Date(line.expiryDate);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function updateReceiving(input: UpdateReceivingInput): Promise<void> {
  if (input.lines.length === 0) {
    throw new Error('ต้องมีอย่างน้อย 1 รายการสินค้า');
  }

  for (const line of input.lines) {
    if (line.qty <= 0) throw new Error(`จำนวนไม่ถูกต้อง: ${line.productName}`);
    if (line.costPerUnit < 0) throw new Error(`ต้นทุนไม่ถูกต้อง: ${line.productName}`);
  }

  if (!isFirebaseConfigured || !db) {
    devUpdateReceiving(input);
    return;
  }

  const firestore = db;
  const receivingRef = doc(firestore, collections.receivings, input.receivingId);
  const receivingSnap = await getDoc(receivingRef);
  if (!receivingSnap.exists()) throw new Error('ไม่พบเอกสารรับเข้า');

  const receiving = { ...(receivingSnap.data() as Receiving), id: receivingSnap.id };
  if (receiving.branchId !== input.branchId) {
    throw new Error('เอกสารนี้ไม่ใช่ของสาขาปัจจุบัน');
  }
  if (receiving.status === 'cancelled') {
    throw new Error('ไม่สามารถแก้ไขเอกสารที่ยกเลิกแล้ว');
  }
  if (receiving.status === 'draft') {
    throw new Error('ใช้บันทึกแบบร่างหรือยืนยันรับเข้าสำหรับเอกสารแบบร่าง');
  }

  const itemsCol = collection(receivingRef, collections.receivingItems);

  const existingItemsSnap = await getDocs(itemsCol);
  const existingItems = existingItemsSnap.docs.map((d) => ({
    ...(d.data() as ReceivingItem),
    id: d.id,
  }));

  const movementsSnap = await getDocs(
    query(
      collection(firestore, collections.stockMovements),
      where('branchId', '==', input.branchId),
      where('refId', '==', input.receivingId),
      where('refType', '==', 'receiving'),
    ),
  );
  const existingMovements = movementsSnap.docs.map((d) => ({
    ...(d.data() as StockMovement),
    id: d.id,
  }));

  const stockSnaps = new Map<string, number>();
  const lotSnaps = new Map<string, StockLot>();

  async function loadStock(productId: string) {
    if (stockSnaps.has(productId)) return;
    const ref = doc(
      firestore,
      collections.products,
      productId,
      collections.productStocks,
      input.branchId,
    );
    const stockDoc = await getDoc(ref);
    stockSnaps.set(
      productId,
      (stockDoc.data() as ProductStock | undefined)?.totalStockBase ?? 0,
    );
  }

  async function loadLot(lotId: string) {
    if (!lotId || lotSnaps.has(lotId)) return;
    const lotDoc = await getDoc(doc(firestore, collections.stockLots, lotId));
    if (lotDoc.exists()) {
      lotSnaps.set(lotId, { ...(lotDoc.data() as StockLot), id: lotDoc.id });
    }
  }

  const productIds = new Set<string>();
  for (const item of existingItems) productIds.add(item.productId);
  for (const line of input.lines) productIds.add(line.productId);
  await Promise.all([...productIds].map((pid) => loadStock(pid)));
  await Promise.all(existingItems.map((item) => loadLot(item.lotId)));

  const newItemIds = new Set(
    input.lines.map((l) => l.itemId).filter((id): id is string => !!id),
  );
  const removedItems = existingItems.filter((item) => !newItemIds.has(item.id));

  function bumpStock(productId: string, delta: number) {
    stockSnaps.set(productId, (stockSnaps.get(productId) ?? 0) + delta);
  }

  const batch = writeBatch(firestore);
  const now = serverTimestamp();

  for (const item of removedItems) {
    bumpStock(item.productId, -item.qtyBase);
    const lot = lotSnaps.get(item.lotId);
    if (lot) {
      lot.qtyRemaining -= item.qtyBase;
      lot.qtyReceived = Math.max(0, lot.qtyReceived - item.qtyBase);
      lot.isDepleted = lot.qtyRemaining <= 0;
      batch.update(doc(firestore, collections.stockLots, lot.id), {
        qtyRemaining: lot.qtyRemaining,
        qtyReceived: lot.qtyReceived,
        isDepleted: lot.isDepleted,
        updatedAt: now,
      });
    }
    const mv = existingMovements.find((m) => m.productId === item.productId);
    if (mv) batch.delete(doc(firestore, collections.stockMovements, mv.id));
    batch.delete(doc(itemsCol, item.id));
  }

  for (const line of input.lines) {
    const qtyBase = lineQtyBase(line);
    const costBase = lineCostBase(line);
    const existing = line.itemId ? existingItems.find((i) => i.id === line.itemId) : undefined;

    if (existing && existing.productId === line.productId) {
      const delta = qtyBase - existing.qtyBase;
      bumpStock(line.productId, delta);
      const lot = lotSnaps.get(existing.lotId);
      if (lot) {
        lot.qtyRemaining += delta;
        lot.qtyReceived = Math.max(0, lot.qtyReceived + delta);
        lot.costPerUnit = costBase;
        lot.isDepleted = lot.qtyRemaining <= 0;
        batch.update(doc(firestore, collections.stockLots, lot.id), {
          qtyRemaining: lot.qtyRemaining,
          qtyReceived: lot.qtyReceived,
          costPerUnit: costBase,
          isDepleted: lot.isDepleted,
          expiryDate: parseExpiry(line) ? Timestamp.fromDate(parseExpiry(line)!) : lot.expiryDate,
          updatedAt: now,
        });
      }
      batch.set(doc(itemsCol, existing.id), {
        id: existing.id,
        productId: line.productId,
        productSnap: { name: line.productName, sku: line.sku },
        unit: line.unit,
        unitFactor: line.unitFactor,
        qty: line.qty,
        qtyBase,
        costPerUnit: line.costPerUnit,
        costBase,
        discountAmt: line.itemDiscount,
        lineTotal: lineSubtotal(line),
        lotId: existing.lotId,
      } satisfies ReceivingItem);
      const mv = existingMovements.find((m) => m.productId === existing.productId);
      if (mv) {
        batch.update(doc(firestore, collections.stockMovements, mv.id), {
          qty: qtyBase,
          costPerUnit: costBase,
          note: input.note,
        });
      }
    } else {
      if (existing) {
        bumpStock(existing.productId, -existing.qtyBase);
        const oldLot = lotSnaps.get(existing.lotId);
        if (oldLot) {
          oldLot.qtyRemaining -= existing.qtyBase;
          oldLot.qtyReceived = Math.max(0, oldLot.qtyReceived - existing.qtyBase);
          oldLot.isDepleted = oldLot.qtyRemaining <= 0;
          batch.update(doc(firestore, collections.stockLots, oldLot.id), {
            qtyRemaining: oldLot.qtyRemaining,
            qtyReceived: oldLot.qtyReceived,
            isDepleted: oldLot.isDepleted,
            updatedAt: now,
          });
        }
        const mv = existingMovements.find((m) => m.productId === existing.productId);
        if (mv) batch.delete(doc(firestore, collections.stockMovements, mv.id));
      }

      bumpStock(line.productId, qtyBase);
      const lotRef = doc(collection(firestore, collections.stockLots));
      batch.set(lotRef, {
        id: lotRef.id,
        productId: line.productId,
        branchId: input.branchId,
        receivingId: input.receivingId,
        costPerUnit: costBase,
        qtyReceived: qtyBase,
        qtyRemaining: qtyBase,
        receivedAt: now as StockLot['receivedAt'],
        expiryDate: parseExpiry(line) ? Timestamp.fromDate(parseExpiry(line)!) : null,
        isDepleted: qtyBase <= 0,
        isGhost: false,
        createdAt: now as StockLot['createdAt'],
      } satisfies StockLot);

      const itemRef = existing ? doc(itemsCol, existing.id) : doc(itemsCol);
      batch.set(itemRef, {
        id: itemRef.id,
        productId: line.productId,
        productSnap: { name: line.productName, sku: line.sku },
        unit: line.unit,
        unitFactor: line.unitFactor,
        qty: line.qty,
        qtyBase,
        costPerUnit: line.costPerUnit,
        costBase,
        discountAmt: line.itemDiscount,
        lineTotal: lineSubtotal(line),
        lotId: lotRef.id,
      } satisfies ReceivingItem);

      const movementRef = doc(collection(firestore, collections.stockMovements));
      batch.set(movementRef, {
        id: movementRef.id,
        productId: line.productId,
        branchId: input.branchId,
        type: 'receive',
        qty: qtyBase,
        costPerUnit: costBase,
        refId: input.receivingId,
        refType: 'receiving',
        note: input.note,
        createdBy: input.staffId,
        createdAt: now as StockMovement['createdAt'],
      } satisfies StockMovement);
    }
  }

  for (const [productId, total] of stockSnaps.entries()) {
    const stockRef = doc(
      firestore,
      collections.products,
      productId,
      collections.productStocks,
      input.branchId,
    );
    batch.set(
      stockRef,
      {
        branchId: input.branchId,
        totalStockBase: total,
        lastMovementAt: now,
        updatedAt: now,
      },
      { merge: true },
    );
  }

  const linesSubtotal = receivingSubtotal(input.lines);
  const billDiscount = Math.max(0, input.finalDiscount || 0);
  const grandTotal = receivingGrandTotal(input.lines, billDiscount);

  batch.update(receivingRef, {
    supplierId: input.supplierId,
    supplierName: input.supplierName.trim() || '—',
    subtotal: linesSubtotal,
    discountAmt: billDiscount,
    total: grandTotal,
    paidAmt: grandTotal,
    note: input.note,
    updatedAt: now,
  });

  await batch.commit();
}
