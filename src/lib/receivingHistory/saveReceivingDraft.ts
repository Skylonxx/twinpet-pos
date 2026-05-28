import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import {
  generateGrnId,
  lineCostBase,
  lineQtyBase,
  lineSubtotal,
  receivingGrandTotal,
  receivingSubtotal,
} from '../receiving/types';
import { devSaveReceivingDraft } from '../receiving/devMock';
import type { Receiving } from '../types';
import { DRAFT_LOT_ID, type SaveReceivingDraftInput } from './types';

export type { SaveReceivingDraftInput };
export { DRAFT_LOT_ID };

export async function saveReceivingDraft(input: SaveReceivingDraftInput): Promise<string> {
  if (!isFirebaseConfigured || !db) {
    return devSaveReceivingDraft(input);
  }

  const firestore = db;
  const receivingId = input.receivingId ?? generateGrnId();
  const receivingRef = doc(firestore, collections.receivings, receivingId);
  const now = serverTimestamp();

  if (input.receivingId) {
    const snap = await getDoc(receivingRef);
    if (!snap.exists()) throw new Error('ไม่พบเอกสารรับเข้า');
    const existing = snap.data() as Receiving;
    if (existing.branchId !== input.branchId) {
      throw new Error('เอกสารนี้ไม่ใช่ของสาขาปัจจุบัน');
    }
    if (existing.status !== 'draft') {
      throw new Error('เอกสารนี้ไม่ใช่แบบร่าง');
    }
  }

  const itemsCol = collection(receivingRef, collections.receivingItems);
  const existingItemsSnap = await getDocs(itemsCol);

  const linesSubtotal = receivingSubtotal(input.lines);
  const billDiscount = Math.max(0, input.finalDiscount || 0);
  const grandTotal = receivingGrandTotal(input.lines, billDiscount);

  const batch = writeBatch(firestore);

  for (const itemDoc of existingItemsSnap.docs) {
    batch.delete(itemDoc.ref);
  }

  for (const line of input.lines) {
    const qtyBase = lineQtyBase(line);
    const costBase = lineCostBase(line);
    const itemRef = line.itemId ? doc(itemsCol, line.itemId) : doc(itemsCol);
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
      lotId: DRAFT_LOT_ID,
    });
  }

  if (input.receivingId) {
    batch.update(receivingRef, {
      supplierId: input.supplierId,
      supplierName: input.supplierName.trim() || '—',
      subtotal: linesSubtotal,
      discountAmt: billDiscount,
      total: grandTotal,
      paidAmt: 0,
      payStatus: 'pending',
      note: input.note,
      status: 'draft',
      updatedAt: now,
    });
  } else {
    batch.set(receivingRef, {
      id: receivingId,
      branchId: input.branchId,
      supplierId: input.supplierId,
      supplierName: input.supplierName.trim() || '—',
      staffId: input.staffId,
      status: 'draft',
      subtotal: linesSubtotal,
      discountAmt: billDiscount,
      vatRate: 0,
      vatAmt: 0,
      total: grandTotal,
      payStatus: 'pending',
      paidAmt: 0,
      note: input.note,
      receivedAt: now as Receiving['receivedAt'],
      createdAt: now as Receiving['createdAt'],
      updatedAt: now as Receiving['updatedAt'],
    } satisfies Receiving);
  }

  await batch.commit();
  return receivingId;
}
