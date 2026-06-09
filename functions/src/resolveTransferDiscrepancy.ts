/**
 * resolveTransferDiscrepancy — server-side, ORIGIN-controlled resolution of a
 * branch-transfer discrepancy.  [Phase 7B-2 blocker-fix]
 *
 * The destination branch can only REPORT a discrepancy (metadata). This callable
 * is the SOLE authoritative path that corrects inventory for that discrepancy, and
 * it runs under Admin SDK authority so it does NOT depend on the caller having
 * destination-branch write access. Authority is taken from the caller's verified
 * custom claims (NOT client input), and the parent transfer is the single source
 * of truth for branch identity, target branch, and per-line expected quantities.
 *
 * Why server-side: client `productStocks` / `stockLots` writes are not branch-
 * isolated in the current rules, so a destination user could otherwise mutate
 * destination stock outside the workflow. Moving the correction here closes that
 * stock-level bypass — only the origin branch can trigger it, and the whole
 * correction + discrepancy-resolution happens in ONE Admin SDK transaction.
 *
 * Safety / idempotency:
 *  - Whole correction + `status → resolved` flip is ONE transaction. A second
 *    concurrent call re-reads `resolved` and is rejected (`failed-precondition`),
 *    so the correction can never be applied twice.
 *  - Tampered / mismatched discrepancy docs are rejected before any write.
 *  - FIFO imports the SINGLE canonical server-side helper `./fifo` — the exact
 *    same module `reconcileOrder` uses, so there is no third FIFO source; Phase
 *    7B-1 cost/chronology are untouched (transfers unchanged).
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  FieldValue,
  type DocumentData,
  type DocumentReference,
  type Firestore,
} from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
// Canonical server-side FIFO source of truth (shared with reconcileOrder).
import {
  roundMoney,
  parseReceivedAtMs,
  planFifoCutFromState,
  mergeLotCuts,
  type MutableLot,
  type LotCut,
} from './fifo';

const C = {
  products: 'products',
  productStocks: 'productStocks',
  stockLots: 'stockLots',
  stockMovements: 'stockMovements',
  inventoryAdjustments: 'inventoryAdjustments',
  adjustmentItems: 'adjustmentItems',
  inventoryTransfers: 'inventoryTransfers',
  transferItems: 'transferItems',
  transferDiscrepancies: 'transferDiscrepancies',
} as const;

type AuthLike = { uid?: string; token?: Record<string, unknown> } | null | undefined;

export type ResolveDiscrepancyInput = {
  transferId?: string;
  discrepancyId?: string;
  adjustDate?: string;
  reason?: string;
  /** Display-only resolver name; the AUTHORITATIVE identity is the auth claims. */
  staffName?: string;
};

// FIFO primitives (MutableLot / LotCut shapes, roundMoney, parseReceivedAtMs,
// planFifoCutFromState, mergeLotCuts) are imported from the single canonical
// server-side source ./fifo.ts — the SAME helper reconcileOrder.ts uses.

/** Origin authority is derived from VERIFIED claims, never from client input. */
function hasBranchAccess(auth: AuthLike, branchId: string): boolean {
  const token = auth?.token ?? {};
  if (token.role === 'admin') return true;
  const branchIds = token.branchIds;
  if (Array.isArray(branchIds)) return branchIds.includes('ALL') || branchIds.includes(branchId);
  return false;
}

function genAdjId(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const suffix = String(Math.floor(Math.random() * 9000) + 1000);
  return `ADJ-${y}${m}${day}-${suffix}`;
}

/**
 * Core resolver — EXPORTED so it is unit-tested without the Functions runtime
 * (see resolveTransferDiscrepancy.test.ts). Throws HttpsError on any disallowed
 * request; returns the created adjustment id on success.
 */
export async function performResolveTransferDiscrepancy(
  database: Firestore,
  input: ResolveDiscrepancyInput,
  auth: AuthLike,
): Promise<{ adjustmentId: string }> {
  if (!auth) throw new HttpsError('unauthenticated', 'ต้องเข้าสู่ระบบก่อน');

  const transferId = String(input.transferId ?? '').trim();
  const discrepancyId = String(input.discrepancyId ?? '').trim();
  if (!transferId || !discrepancyId) {
    throw new HttpsError('invalid-argument', 'ต้องระบุ transferId และ discrepancyId');
  }
  const adjustDate = String(input.adjustDate ?? '').trim() || new Date().toISOString().slice(0, 10);
  const reason = (input.reason && String(input.reason).trim()) || 'ตรวจนับสต็อก';
  const resolverStaffId = (auth.token?.staffId as string | undefined) ?? auth.uid ?? null;
  const resolverStaffName = String(input.staffName ?? '').trim();

  const adjustmentId = genAdjId();

  return database.runTransaction(async (tx) => {
    const transferRef = database.collection(C.inventoryTransfers).doc(transferId);
    const transferSnap = await tx.get(transferRef);
    if (!transferSnap.exists) throw new HttpsError('not-found', 'ไม่พบเอกสารโอนย้าย');
    const transfer = transferSnap.data() as DocumentData;

    // ── ORIGIN AUTHORITY (verified claims; destination/non-origin denied) ──
    if (!hasBranchAccess(auth, transfer.fromBranchId)) {
      throw new HttpsError('permission-denied', 'เฉพาะสาขาต้นทางเท่านั้นที่อนุมัติแก้ไขส่วนต่างได้');
    }
    if (transfer.status === 'cancelled') {
      throw new HttpsError('failed-precondition', 'เอกสารนี้ถูกยกเลิกแล้ว');
    }

    const discRef = transferRef.collection(C.transferDiscrepancies).doc(discrepancyId);
    const discSnap = await tx.get(discRef);
    if (!discSnap.exists) throw new HttpsError('not-found', 'ไม่พบรายการส่วนต่าง');
    const disc = discSnap.data() as DocumentData;

    // ── IDENTITY: parent transfer is the source of truth (never trust disc) ──
    if (disc.status !== 'reported') {
      throw new HttpsError('failed-precondition', 'ส่วนต่างนี้ถูกแก้ไขแล้ว');
    }
    if (disc.transferId !== transferId) {
      throw new HttpsError('failed-precondition', 'รายการส่วนต่างไม่ตรงกับเอกสารโอนย้าย');
    }
    if (disc.fromBranchId !== transfer.fromBranchId || disc.toBranchId !== transfer.toBranchId) {
      throw new HttpsError('failed-precondition', 'สาขาในรายการส่วนต่างไม่ตรงกับเอกสารโอนย้าย');
    }
    if (disc.reportedByBranchId !== transfer.toBranchId) {
      throw new HttpsError('failed-precondition', 'ผู้รายงานส่วนต่างต้องเป็นสาขาปลายทาง');
    }

    const destBranchId = transfer.toBranchId as string;

    // Expected (shipped) qty per product from the IMMUTABLE transfer items.
    const itemsSnap = await tx.get(transferRef.collection(C.transferItems));
    const itemByProduct = new Map<string, DocumentData>();
    itemsSnap.forEach((d) => {
      const it = d.data();
      itemByProduct.set(it.productId as string, it);
    });

    // Re-derive every line; reject tampered facts / unknown products.
    type AdjLine = { productId: string; name: string; sku: string; adjustQty: number };
    const adjLines: AdjLine[] = [];
    for (const line of (disc.lines ?? []) as DocumentData[]) {
      const item = itemByProduct.get(line.productId as string);
      if (!item) {
        throw new HttpsError(
          'failed-precondition',
          `รายการส่วนต่างอ้างอิงสินค้าที่ไม่ได้อยู่ในเอกสารโอนย้าย: ${line.productId}`,
        );
      }
      const actualQty = line.actualQty;
      if (typeof actualQty !== 'number' || !Number.isFinite(actualQty) || actualQty < 0) {
        throw new HttpsError('failed-precondition', `จำนวนที่รับจริงไม่ถูกต้อง: ${item.productName}`);
      }
      const expectedQty = item.transferQty as number;
      const difference = actualQty - expectedQty;
      if (line.expectedQty !== expectedQty || line.difference !== difference) {
        throw new HttpsError(
          'failed-precondition',
          `รายการส่วนต่างถูกแก้ไขไม่ตรงกับเอกสารโอนย้าย: ${item.productName}`,
        );
      }
      if (difference !== 0) {
        adjLines.push({
          productId: item.productId as string,
          name: item.productName as string,
          sku: item.sku as string,
          adjustQty: difference,
        });
      }
    }
    if (adjLines.length === 0) {
      throw new HttpsError('failed-precondition', 'ไม่มีส่วนต่างที่ต้องแก้ไข');
    }

    // ── Read per-product: product (cost), dest stock, dest lots (negative only) ──
    const uniqueProductIds = [...new Set(adjLines.map((l) => l.productId))];
    const productData = new Map<string, DocumentData | undefined>();
    const stockRefs = new Map<string, DocumentReference>();
    const runningStock = new Map<string, number>();
    const lotsByProduct = new Map<string, MutableLot[]>();

    for (const pid of uniqueProductIds) {
      const prodSnap = await tx.get(database.collection(C.products).doc(pid));
      productData.set(pid, prodSnap.exists ? prodSnap.data() : undefined);

      const stockRef = database.collection(C.products).doc(pid).collection(C.productStocks).doc(destBranchId);
      stockRefs.set(pid, stockRef);
      const stockSnap = await tx.get(stockRef);
      runningStock.set(pid, stockSnap.exists ? ((stockSnap.data()?.totalStockBase as number) ?? 0) : 0);

      const needsLots = adjLines.some((l) => l.productId === pid && l.adjustQty < 0);
      const lots: MutableLot[] = [];
      if (needsLots) {
        const lotsSnap = await tx.get(
          database
            .collection(C.stockLots)
            .where('productId', '==', pid)
            .where('branchId', '==', destBranchId)
            .where('isDepleted', '==', false)
            .orderBy('receivedAt', 'asc'),
        );
        lotsSnap.forEach((d) => {
          const lot = d.data();
          const qtyRemaining = (lot.qtyRemaining as number) ?? 0;
          if (qtyRemaining <= 0 || lot.isDepleted === true) return;
          lots.push({
            ref: d.ref,
            id: d.id,
            qtyRemaining,
            costPerUnit: (lot.costPerUnit as number) ?? 0,
            receivedAtMs: parseReceivedAtMs(lot.receivedAt),
          });
        });
        lots.sort((a, b) => a.receivedAtMs - b.receivedAtMs);
      }
      lotsByProduct.set(pid, lots);
    }

    // ── Plan (in memory) ──
    const initialLotQty = new Map<string, number>();
    for (const lots of lotsByProduct.values()) for (const l of lots) initialLotQty.set(l.ref.path, l.qtyRemaining);

    const cutsByProduct = new Map<string, LotCut[]>();
    const newLots: Array<{ ref: DocumentReference; productId: string; qty: number; cost: number }> = [];
    const netDelta = new Map<string, number>();
    const itemPlans: Array<{ item: DocumentData; movementRef: DocumentReference }> = [];

    for (const line of adjLines) {
      const prod = productData.get(line.productId);
      const avgCost = (prod?.avgCost as number) ?? 0;
      const manualCost = (prod?.cost as number) ?? 0;
      const inboundCost = manualCost > 0 ? manualCost : avgCost;
      const current = runningStock.get(line.productId)!;
      const computedNew = current + line.adjustQty;

      let unitCost = avgCost;
      if (line.adjustQty < 0) {
        // Short receipt → FIFO-cut the oldest dest lots (mutates lotsByProduct).
        const { cuts } = planFifoCutFromState(lotsByProduct.get(line.productId)!, -line.adjustQty);
        const acc = cutsByProduct.get(line.productId) ?? [];
        acc.push(...cuts);
        cutsByProduct.set(line.productId, acc);
        unitCost = avgCost;
      } else {
        // Over receipt → create a new lot at the standard cost basis.
        const lotRef = database.collection(C.stockLots).doc();
        newLots.push({ ref: lotRef, productId: line.productId, qty: line.adjustQty, cost: inboundCost });
        unitCost = inboundCost;
      }

      runningStock.set(line.productId, computedNew);
      netDelta.set(line.productId, (netDelta.get(line.productId) ?? 0) + line.adjustQty);
      itemPlans.push({
        item: {
          productId: line.productId,
          productName: line.name,
          sku: line.sku,
          currentStock: current,
          adjustQty: line.adjustQty,
          newStock: computedNew,
          unitCost,
          valueImpact: roundMoney(line.adjustQty * unitCost),
        },
        movementRef: database.collection(C.stockMovements).doc(),
      });
    }

    const totalValueImpact = roundMoney(
      itemPlans.reduce((s, p) => s + (p.item.valueImpact as number), 0),
    );

    // ── Writes (same transaction → atomic with the resolved flip) ──
    const adjustmentRef = database.collection(C.inventoryAdjustments).doc(adjustmentId);
    tx.set(adjustmentRef, {
      id: adjustmentId,
      branchId: destBranchId,
      adjustDate,
      reason,
      note: `แก้ไขส่วนต่างการโอนย้าย ${transferId} (อนุมัติโดยสาขาต้นทาง ${transfer.fromBranchId})`,
      staffId: resolverStaffId,
      staffName: resolverStaffName,
      itemCount: itemPlans.length,
      totalValueImpact,
      status: 'completed',
      createdAt: FieldValue.serverTimestamp(),
      // Origin-gating markers (rules deny client creation of marked adjustments).
      refTransferId: transferId,
      refDiscrepancyId: discrepancyId,
    });

    for (const plan of itemPlans) {
      tx.set(adjustmentRef.collection(C.adjustmentItems).doc(), plan.item);
      tx.set(plan.movementRef, {
        id: plan.movementRef.id,
        productId: plan.item.productId,
        branchId: destBranchId,
        type: 'adjust',
        qty: plan.item.adjustQty,
        costPerUnit: plan.item.unitCost,
        refId: adjustmentId,
        refType: 'inventoryAdjustment',
        note: reason,
        createdBy: resolverStaffId,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    for (const [pid, delta] of netDelta) {
      if (delta === 0) continue;
      tx.set(
        stockRefs.get(pid)!,
        {
          branchId: destBranchId,
          totalStockBase: FieldValue.increment(delta),
          lastMovementAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    for (const [pid, cuts] of cutsByProduct) {
      void pid;
      for (const cut of mergeLotCuts(cuts)) {
        const initialQty = initialLotQty.get(cut.ref.path) ?? cut.cutQty;
        tx.update(cut.ref, {
          qtyRemaining: FieldValue.increment(-cut.cutQty),
          isDepleted: initialQty - cut.cutQty <= 0,
        });
      }
    }

    for (const nl of newLots) {
      tx.set(nl.ref, {
        id: nl.ref.id,
        productId: nl.productId,
        branchId: destBranchId,
        receivingId: adjustmentId,
        costPerUnit: nl.cost,
        qtyReceived: nl.qty,
        qtyRemaining: nl.qty,
        receivedAt: FieldValue.serverTimestamp(),
        expiryDate: null,
        isDepleted: nl.qty <= 0,
        isGhost: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    // Mark resolved ONLY after the correction — atomic with the writes above.
    tx.set(
      discRef,
      {
        status: 'resolved',
        resolvedByStaffId: resolverStaffId,
        resolvedByStaffName: resolverStaffName,
        resolvedByBranchId: transfer.fromBranchId,
        resolvedAt: FieldValue.serverTimestamp(),
        resolutionAdjustmentId: adjustmentId,
      },
      { merge: true },
    );

    return { adjustmentId };
  });
}

export const resolveTransferDiscrepancy = onCall(
  {
    region: FUNCTIONS_REGION,
    cors: [/^https?:\/\/localhost:\d+$/, /^https:\/\/.*\.firebaseapp\.com$/, /^https:\/\/.*\.web\.app$/],
  },
  async (request) => {
    const data = (request.data ?? {}) as ResolveDiscrepancyInput;
    const result = await performResolveTransferDiscrepancy(db, data, request.auth as AuthLike);
    return { success: true, ...result };
  },
);
