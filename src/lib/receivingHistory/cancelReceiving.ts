import {
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
import { devCancelReceiving } from '../receiving/devMock';
import type { ProductStock, Receiving, ReceivingItem, StockLot, StockMovement } from '../types';
import type { CancelReceivingInput } from './types';

export type { CancelReceivingInput };

export async function cancelReceiving(input: CancelReceivingInput): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) throw new Error('กรุณาระบุเหตุผลการยกเลิก');

  if (!isFirebaseConfigured || !db) {
    devCancelReceiving(input);
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
    throw new Error('เอกสารนี้ถูกยกเลิกแล้ว');
  }

  const itemsCol = collection(receivingRef, collections.receivingItems);
  const itemsSnap = await getDocs(itemsCol);
  const items = itemsSnap.docs.map((d) => ({
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
  const movements = movementsSnap.docs.map((d) => ({
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

  await Promise.all([...new Set(items.map((i) => i.productId))].map((pid) => loadStock(pid)));
  await Promise.all(items.map((item) => loadLot(item.lotId)));

  const batch = writeBatch(firestore);
  const now = serverTimestamp();
  const voidNote = input.note?.trim() ? `${reason} — ${input.note.trim()}` : reason;

  for (const item of items) {
    stockSnaps.set(item.productId, (stockSnaps.get(item.productId) ?? 0) - item.qtyBase);

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

    const receiveMv = movements.find(
      (m) => m.productId === item.productId && m.type === 'receive',
    );
    if (receiveMv) {
      batch.delete(doc(firestore, collections.stockMovements, receiveMv.id));
    }

    const voidMvRef = doc(collection(firestore, collections.stockMovements));
    batch.set(voidMvRef, {
      id: voidMvRef.id,
      productId: item.productId,
      branchId: input.branchId,
      type: 'void',
      qty: item.qtyBase,
      costPerUnit: item.costBase,
      refId: input.receivingId,
      refType: 'receiving',
      note: voidNote,
      createdBy: input.staffId,
      createdAt: now as StockMovement['createdAt'],
    } satisfies StockMovement);
  }

  for (const [productId, total] of stockSnaps.entries()) {
    batch.set(
      doc(firestore, collections.products, productId, collections.productStocks, input.branchId),
      {
        branchId: input.branchId,
        totalStockBase: total,
        lastMovementAt: now,
        updatedAt: now,
      },
      { merge: true },
    );
  }

  const cancelNote = [receiving.note, `ยกเลิก: ${voidNote}`].filter(Boolean).join(' · ');

  batch.update(receivingRef, {
    status: 'cancelled',
    note: cancelNote,
    updatedAt: now,
  });

  await batch.commit();
}
