/**
 * Canonical SERVER-SIDE FIFO primitives — the single source of truth for lot
 * cutting/merging inside Cloud Functions (Admin SDK). Both `reconcileOrder.ts`
 * (POS settlement) and `resolveTransferDiscrepancy.ts` (transfer-discrepancy
 * resolution) import these — there is no per-file FIFO copy.
 *
 * This is the server twin of the web client's `src/lib/fifo.ts`; it is kept
 * separate because Cloud Functions use the Admin SDK (`firebase-admin/firestore`)
 * whereas the client uses the web SDK. Pure + framework-free so it is directly
 * unit-tested (see fifo.test.ts).
 */
import { Timestamp, type DocumentReference } from 'firebase-admin/firestore';

/** A single lot consumed by a FIFO cut: which lot, how much, at what unit cost. */
export type LotRef = { lotId: string; qty: number; cost: number };

/** A lot during in-memory planning — `qtyRemaining` is decremented in place. */
export type MutableLot = {
  ref: DocumentReference;
  id: string;
  qtyRemaining: number;
  costPerUnit: number;
  receivedAtMs: number;
};

/** A planned consumption against one lot doc. */
export type LotCut = { ref: DocumentReference; cutQty: number };

/** Round to 2 dp (money). */
export const roundMoney = (n: number): number => Math.round(n * 100) / 100;

/** Parse a Firestore `receivedAt` (Admin Timestamp or `{ seconds }`) to epoch ms. */
export function parseReceivedAtMs(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (value && typeof value === 'object' && 'seconds' in value) {
    const s = (value as { seconds: unknown }).seconds;
    if (typeof s === 'number') return s * 1000;
  }
  return 0;
}

/** Walk lots oldest-first, cutting up to `qtyBase`. Mutates each lot's remaining. */
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
    cuts.push({ ref: lot.ref, cutQty: cut });
    lot.qtyRemaining -= cut;
    remaining -= cut;
  }
  return { cuts, lotRefs, remaining };
}

/** Collapse cuts against the same lot doc so the tx never double-writes one ref. */
export function mergeLotCuts(cuts: LotCut[]): LotCut[] {
  const byRef = new Map<string, LotCut>();
  for (const cut of cuts) {
    if (!cut.ref?.path || cut.cutQty <= 0) continue;
    const existing = byRef.get(cut.ref.path);
    if (existing) existing.cutQty += cut.cutQty;
    else byRef.set(cut.ref.path, { ...cut });
  }
  return [...byRef.values()];
}
