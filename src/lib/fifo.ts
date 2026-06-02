import {
  collection,
  getDocs,
  orderBy,
  query,
  where,
  type DocumentReference,
  type Transaction,
} from 'firebase/firestore';
import { collections, db } from './firebase';
import type { LotRef } from './types';

/**
 * Shared FIFO lot-cutting primitives for INVENTORY mutations (adjustments and
 * branch transfers — see `src/lib/inventory/*`) and void restock.
 *
 * The POS SALE path no longer lives here. With the offline-first async checkout,
 * the client writes a sale "intent" (`src/lib/pos/asyncCheckout.ts`) and the
 * server-side `reconcileOrder` Cloud Function performs the authoritative FIFO /
 * stock / credit / shift settlement (see `functions/src/reconcileOrder.ts`).
 */

export const OVERSELL_LOT_ID = 'oversell';

export type LotCut = {
  ref: DocumentReference;
  cutQty: number;
  costPerUnit: number;
};

export type MutableLot = {
  ref: DocumentReference;
  id: string;
  qtyRemaining: number;
  costPerUnit: number;
  receivedAtMs: number;
};

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
  return 0;
}

function buildLotsQuery(firestore: NonNullable<typeof db>, productId: string, branchId: string) {
  return query(
    collection(firestore, collections.stockLots),
    where('productId', '==', productId),
    where('branchId', '==', branchId),
    where('isDepleted', '==', false),
    orderBy('receivedAt', 'asc'),
  );
}

/** Discover lot doc refs (outside tx) — same pattern as confirmReceiving ghost lots */
export async function fetchActiveLotRefs(
  firestore: NonNullable<typeof db>,
  productId: string,
  branchId: string,
): Promise<DocumentReference[]> {
  const snap = await getDocs(buildLotsQuery(firestore, productId, branchId));
  return snap.docs.map((d) => d.ref);
}

/** Read fresh lot qty inside tx — one tx.get per ref, all reads before writes */
export async function readProductLotsInTransaction(
  tx: Transaction,
  lotRefs: DocumentReference[],
): Promise<MutableLot[]> {
  const lots: MutableLot[] = [];

  for (const lotRef of lotRefs) {
    const snap = await tx.get(lotRef);
    if (!snap.exists()) continue;

    const lot = snap.data();
    const qtyRemaining = (lot.qtyRemaining as number) ?? 0;
    if (qtyRemaining <= 0 || lot.isDepleted === true) continue;

    lots.push({
      ref: lotRef,
      id: snap.id,
      qtyRemaining,
      costPerUnit: (lot.costPerUnit as number) ?? 0,
      receivedAtMs: parseReceivedAtMs(lot.receivedAt),
    });
  }

  lots.sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  return lots;
}

/**
 * Walk `lots` oldest-first, cutting up to `qtyBase` base units.
 * MUTATES each lot's `qtyRemaining` in place so the same array can be passed
 * to multiple sequential cuts (e.g. several lines for the same product).
 * Returns the per-lot cuts, the cut refs, and any `remaining` demand that the
 * available lots could not cover.
 */
export function planFifoCutFromState(
  lots: MutableLot[],
  qtyBase: number,
): { cuts: LotCut[]; lotRefs: LotRef[]; remaining: number } {
  let remaining = qtyBase;
  const cuts: LotCut[] = [];
  const lotRefs: LotRef[] = [];

  for (const lot of lots) {
    if (remaining <= 0) break;
    if (lot.qtyRemaining <= 0) continue;

    const cut = Math.min(remaining, lot.qtyRemaining);
    lotRefs.push({ lotId: lot.id, qty: cut, cost: lot.costPerUnit });
    cuts.push({
      ref: lot.ref,
      cutQty: cut,
      costPerUnit: lot.costPerUnit,
    });
    lot.qtyRemaining -= cut;
    remaining -= cut;
  }

  return { cuts, lotRefs, remaining };
}

/** Collapse multiple cuts against the same lot doc into a single cut — so one
 *  transaction never issues two conflicting writes to the same lot ref. */
export function mergeLotCuts(cuts: LotCut[]): LotCut[] {
  const byRef = new Map<string, LotCut>();
  for (const cut of cuts) {
    if (!cut.ref?.path || cut.cutQty <= 0) continue;
    const existing = byRef.get(cut.ref.path);
    if (!existing) {
      byRef.set(cut.ref.path, { ...cut });
      continue;
    }
    existing.cutQty += cut.cutQty;
  }
  return [...byRef.values()];
}
