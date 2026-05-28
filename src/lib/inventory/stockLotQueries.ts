import {
  collection,
  getDocs,
  orderBy,
  query,
  where,
  type Firestore,
} from 'firebase/firestore';
import { collections } from '../firebase';
import type { StockLot } from '../types';

function parseReceivedAtMs(value: unknown): number {
  if (
    value != null &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  if (
    value != null &&
    typeof value === 'object' &&
    'seconds' in value &&
    typeof (value as { seconds: unknown }).seconds === 'number'
  ) {
    return (value as { seconds: number }).seconds * 1000;
  }
  if (value instanceof Date) return value.getTime();
  return 0;
}

function parseOptionalTimestamp(value: unknown): StockLot['expiryDate'] {
  if (value == null) return null;
  if (
    typeof value === 'object' &&
    ('toDate' in value || 'seconds' in value)
  ) {
    return value as StockLot['expiryDate'];
  }
  return null;
}

export function normalizeStockLot(id: string, raw: Record<string, unknown>): StockLot {
  const qtyRemaining = Number(raw.qtyRemaining ?? raw.remainingQty ?? 0);
  const qtyReceived = Number(raw.qtyReceived ?? raw.qty ?? qtyRemaining);
  const isDepleted = raw.isDepleted === true || qtyRemaining <= 0;
  const expiryDate = parseOptionalTimestamp(raw.expiryDate ?? raw.expDate);

  return {
    ...(raw as StockLot),
    id,
    productId: String(raw.productId ?? ''),
    branchId: String(raw.branchId ?? ''),
    receivingId: String(raw.receivingId ?? ''),
    costPerUnit: Number(raw.costPerUnit ?? 0),
    qtyReceived,
    qtyRemaining,
    isDepleted,
    expiryDate,
  };
}

function mapLotDocs(
  docs: Array<{ id: string; data: () => Record<string, unknown> }>,
): StockLot[] {
  return docs.map((d) => normalizeStockLot(d.id, d.data()));
}

function sortLotsByReceivedAt(lots: StockLot[]): StockLot[] {
  return [...lots].sort(
    (a, b) => parseReceivedAtMs(a.receivedAt) - parseReceivedAtMs(b.receivedAt),
  );
}

/** Fetch FIFO stock lots for a product at a branch (matches schema composite index). */
export async function fetchProductStockLots(
  firestore: Firestore,
  productId: string,
  branchId: string,
): Promise<StockLot[]> {
  const lotsCol = collection(firestore, collections.stockLots);

  const indexedQuery = query(
    lotsCol,
    where('productId', '==', productId),
    where('branchId', '==', branchId),
    where('isDepleted', '==', false),
    orderBy('receivedAt', 'asc'),
  );

  try {
    const snap = await getDocs(indexedQuery);
    return mapLotDocs(snap.docs);
  } catch (err) {
    console.error('[fetchProductStockLots] indexed query failed:', err);
  }

  try {
    const fallbackQuery = query(
      lotsCol,
      where('productId', '==', productId),
      where('branchId', '==', branchId),
    );
    const snap = await getDocs(fallbackQuery);
    return sortLotsByReceivedAt(
      mapLotDocs(snap.docs).filter((lot) => lot.qtyRemaining > 0 && !lot.isDepleted),
    );
  } catch (err) {
    console.error('[fetchProductStockLots] fallback query failed:', err);
    return [];
  }
}
