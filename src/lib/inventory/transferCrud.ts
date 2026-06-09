import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  runTransaction,
  serverTimestamp,
  Timestamp,
  type DocumentReference,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Product, ProductStock, StockLot, StockMovement } from '../types';
import {
  fetchActiveLotRefs,
  mergeLotCuts,
  OVERSELL_LOT_ID,
  planFifoCutFromState,
  readProductLotsInTransaction,
  type LotCut,
  type MutableLot,
} from '../fifo';
import { devCancelBranchTransfer, devConfirmBranchTransfer } from './transferDevMock';
import {
  generateTransferId,
  type BranchTransferForm,
  type BranchTransferLineInput,
  type CancelBranchTransferInput,
  type InventoryTransfer,
  type InventoryTransferItem,
  type TransferLotDetail,
} from './transferTypes';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Per-product working state assembled during the read phase. */
type ProductCtx = {
  productRef: DocumentReference;
  sourceStockRef: DocumentReference;
  destStockRef: DocumentReference;
  productName: string;
  avgCost: number;
  allowNegative: boolean;
  /** Source branch base-unit stock (totalStockBase). */
  sourceStock: number;
  /** Source lots, oldest-first. Mutated in place by per-line FIFO cuts. */
  lotPool: MutableLot[];
  /** Initial qtyRemaining per source lot path — to recompute isDepleted. */
  initialLotQty: Map<string, number>;
  /** Total base units moved out of source (= into dest) for this product. */
  totalQty: number;
};

/**
 * A destination lot to create — mirrors one source FIFO cut at the EXACT cost
 * AND the EXACT original source receipt time. `receivedAtMs` is the original
 * source-lot receipt time the dest lot must inherit as its FIFO key; `null` means
 * there is no source lot (oversell/drift remainder) so the transfer time is used.
 */
type DestLotPlan = {
  ref: DocumentReference;
  productId: string;
  qty: number;
  cost: number;
  receivedAtMs: number | null;
};

/** Fully-planned transfer line (computed in memory before any write). */
type LinePlan = {
  line: BranchTransferLineInput;
  blendedUnitCost: number;
  sourceLotDetails: TransferLotDetail[];
  destLots: DestLotPlan[];
};

/**
 * Confirm a direct branch-to-branch stock transfer — FIFO lot-aware with
 * EXACT cost preservation.
 *
 * The actual FIFO cost travels with the stock: every lot cut from the source
 * branch is mirrored into a destination lot at the SAME costPerUnit and qty
 * (never a single lot at avgCost). The exact cuts are persisted on each
 * transfer item as `sourceLotDetails` so valuation stays correct and a later
 * cancel can restore the source branch at the original cost basis.
 *
 * All quantities are BASE UNITS. Strict 3-phase transaction: source lot refs
 * are queried OUTSIDE the tx, then Phase 1 reads → Phase 2 plan → Phase 3 write.
 */
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
  for (const line of activeLines) {
    if (line.transferQty <= 0) {
      throw new Error(`จำนวนโอนต้องมากกว่า 0: ${line.name}`);
    }
  }

  // Dev / no-Firebase path is summary-only (no lot simulation) — unchanged.
  if (!isFirebaseConfigured || !db) {
    return devConfirmBranchTransfer(form, activeLines);
  }

  const firestore = db;
  const transferId = generateTransferId();
  const uniqueProductIds = [...new Set(activeLines.map((l) => l.productId))];

  // ── Pre-transaction: discover source lot refs (queries can't run in a tx) ──
  const lotRefsByProduct = new Map<string, DocumentReference[]>();
  for (const productId of uniqueProductIds) {
    lotRefsByProduct.set(
      productId,
      await fetchActiveLotRefs(firestore, productId, form.fromBranchId),
    );
  }

  await runTransaction(firestore, async (tx) => {
    const now = serverTimestamp();
    const transferRef = doc(firestore, collections.inventoryTransfers, transferId);
    const itemsCol = collection(transferRef, collections.transferItems);

    // ── Phase 1: READS ONLY ──────────────────────────────────────────────
    const productCtx = new Map<string, ProductCtx>();

    for (const productId of uniqueProductIds) {
      const productRef = doc(firestore, collections.products, productId);
      const sourceStockRef = doc(
        firestore,
        collections.products,
        productId,
        collections.productStocks,
        form.fromBranchId,
      );
      const destStockRef = doc(
        firestore,
        collections.products,
        productId,
        collections.productStocks,
        form.toBranchId,
      );

      const [productSnap, sourceSnap] = await Promise.all([
        tx.get(productRef),
        tx.get(sourceStockRef),
      ]);

      if (!productSnap.exists()) {
        const name = activeLines.find((l) => l.productId === productId)?.name ?? productId;
        throw new Error(`ไม่พบสินค้า: ${name}`);
      }

      const product = productSnap.data() as Product;
      const lotPool = await readProductLotsInTransaction(
        tx,
        lotRefsByProduct.get(productId) ?? [],
      );
      const initialLotQty = new Map<string, number>();
      for (const lot of lotPool) {
        initialLotQty.set(lot.ref.path, lot.qtyRemaining);
      }

      productCtx.set(productId, {
        productRef,
        sourceStockRef,
        destStockRef,
        productName: activeLines.find((l) => l.productId === productId)?.name ?? productId,
        avgCost: product.avgCost ?? 0,
        allowNegative: product.allowNegativeStock === true,
        sourceStock: sourceSnap.exists()
          ? (sourceSnap.data() as ProductStock).totalStockBase
          : 0,
        lotPool,
        initialLotQty,
        totalQty: 0,
      });
    }

    // ── Phase 2: PLAN in memory (no tx I/O — doc() only generates ids) ────
    for (const line of activeLines) {
      const ctx = productCtx.get(line.productId);
      if (!ctx) throw new Error(`ไม่พบข้อมูลสินค้า: ${line.name}`);
      ctx.totalQty += line.transferQty;
    }

    // Source sufficiency — authoritative guard on totalStockBase (per product).
    for (const ctx of productCtx.values()) {
      if (ctx.totalQty > 0 && ctx.sourceStock < ctx.totalQty && !ctx.allowNegative) {
        throw new Error(
          `สต็อกไม่เพียงพอ: ${ctx.productName} (คงเหลือ ${ctx.sourceStock})`,
        );
      }
    }

    const cutsByProduct = new Map<string, LotCut[]>();
    const linePlans: LinePlan[] = [];

    for (const line of activeLines) {
      const ctx = productCtx.get(line.productId)!;

      // FIFO cut THIS line from the shared (mutated) pool → exact cost cuts.
      const { cuts, lotRefs, remaining } = planFifoCutFromState(ctx.lotPool, line.transferQty);

      const acc = cutsByProduct.get(line.productId) ?? [];
      acc.push(...cuts);
      cutsByProduct.set(line.productId, acc);

      // Mirror each source cut into the item detail AND a matching dest lot.
      // `receivedAtMs` carries the ORIGINAL source lot receipt time so the dest
      // lot inherits the source FIFO chronology (not the transfer arrival time).
      const sourceLotDetails: TransferLotDetail[] = lotRefs.map((r) => ({
        lotId: r.lotId,
        costPerUnit: r.cost,
        qty: r.qty,
        receivedAtMs: r.receivedAtMs,
      }));
      const destLots: DestLotPlan[] = lotRefs.map((r) => ({
        ref: doc(collection(firestore, collections.stockLots)),
        productId: line.productId,
        qty: r.qty,
        cost: r.cost,
        receivedAtMs: r.receivedAtMs ?? null,
      }));

      // Oversell / drift remainder has no source lot — fall back to avgCost so
      // the quantity is still represented (and restorable on cancel).
      if (remaining > 0) {
        console.warn(
          `[confirmBranchTransfer] lot shortfall for ${ctx.productName}: ` +
            `${remaining} base unit(s) priced at avgCost fallback`,
        );
        // No source lot for this remainder → no chronology to inherit; the dest
        // lot keeps the transfer arrival time (receivedAtMs: null).
        sourceLotDetails.push({ lotId: OVERSELL_LOT_ID, costPerUnit: ctx.avgCost, qty: remaining });
        destLots.push({
          ref: doc(collection(firestore, collections.stockLots)),
          productId: line.productId,
          qty: remaining,
          cost: ctx.avgCost,
          receivedAtMs: null,
        });
      }

      const totalCost = sourceLotDetails.reduce((s, d) => s + d.costPerUnit * d.qty, 0);
      const blendedUnitCost = line.transferQty > 0 ? totalCost / line.transferQty : ctx.avgCost;

      linePlans.push({ line, blendedUnitCost: round2(blendedUnitCost), sourceLotDetails, destLots });
    }

    // ── Phase 3: WRITES ONLY ─────────────────────────────────────────────
    tx.set(transferRef, {
      id: transferId,
      transferDate: form.transferDate,
      fromBranchId: form.fromBranchId,
      toBranchId: form.toBranchId,
      note: form.note.trim(),
      staffId: form.staffId,
      staffName: form.staffName,
      itemCount: activeLines.length,
      status: 'completed',
      createdAt: now,
    });

    // Per-line: transfer item (with exact cuts) + paired out/in movements.
    for (const plan of linePlans) {
      const { line } = plan;

      const item: InventoryTransferItem = {
        productId: line.productId,
        productName: line.name,
        sku: line.sku,
        sourceStock: line.sourceStock,
        transferQty: line.transferQty,
        unitCost: plan.blendedUnitCost,
        sourceLotDetails: plan.sourceLotDetails,
      };
      tx.set(doc(itemsCol), item);

      const movementOut: Omit<StockMovement, 'id'> = {
        productId: line.productId,
        branchId: form.fromBranchId,
        type: 'transfer_out',
        qty: -line.transferQty,
        costPerUnit: plan.blendedUnitCost,
        refId: transferId,
        refType: 'inventoryTransfer',
        note: form.note.trim(),
        createdBy: form.staffId,
        createdAt: now as StockMovement['createdAt'],
      };
      tx.set(doc(collection(firestore, collections.stockMovements)), movementOut);

      const movementIn: Omit<StockMovement, 'id'> = {
        productId: line.productId,
        branchId: form.toBranchId,
        type: 'transfer_in',
        qty: line.transferQty,
        costPerUnit: plan.blendedUnitCost,
        refId: transferId,
        refType: 'inventoryTransfer',
        note: form.note.trim(),
        createdBy: form.staffId,
        createdAt: now as StockMovement['createdAt'],
      };
      tx.set(doc(collection(firestore, collections.stockMovements)), movementIn);
    }

    // Per-product: stock deltas + source lot cuts (merged → one write per lot).
    for (const [productId, ctx] of productCtx) {
      if (ctx.totalQty <= 0) continue;

      tx.set(
        ctx.sourceStockRef,
        {
          branchId: form.fromBranchId,
          totalStockBase: increment(-ctx.totalQty),
          lastMovementAt: now,
          updatedAt: now,
        },
        { merge: true },
      );

      tx.set(
        ctx.destStockRef,
        {
          branchId: form.toBranchId,
          totalStockBase: increment(ctx.totalQty),
          lastMovementAt: now,
          updatedAt: now,
        },
        { merge: true },
      );

      for (const cut of mergeLotCuts(cutsByProduct.get(productId) ?? [])) {
        const initialQty = ctx.initialLotQty.get(cut.ref.path) ?? cut.cutQty;
        tx.update(cut.ref, {
          qtyRemaining: increment(-cut.cutQty),
          isDepleted: initialQty - cut.cutQty <= 0,
        });
      }
    }

    // Dest lots: one per source cut, at the EXACT carried cost (never avgCost)
    // AND the EXACT original source receipt time (never the transfer arrival
    // time). Inheriting `receivedAt` keeps stock age continuous across branches
    // so FIFO depletion still consumes the oldest original receipt first.
    for (const plan of linePlans) {
      for (const destLot of plan.destLots) {
        if (destLot.qty <= 0) continue;
        const lot: StockLot = {
          id: destLot.ref.id,
          productId: destLot.productId,
          branchId: form.toBranchId,
          receivingId: transferId, // source document for this lot
          costPerUnit: destLot.cost,
          qtyReceived: destLot.qty,
          qtyRemaining: destLot.qty,
          receivedAt:
            destLot.receivedAtMs != null
              ? (Timestamp.fromMillis(destLot.receivedAtMs) as StockLot['receivedAt'])
              : (now as StockLot['receivedAt']),
          expiryDate: null,
          isDepleted: false,
          isGhost: false,
          createdAt: now as StockLot['createdAt'], // actual creation time (audit)
        };
        tx.set(destLot.ref, lot);
      }
    }
  });

  return transferId;
}

/** Per-product working state for a cancel (reverse) transaction. */
type CancelCtx = {
  sourceStockRef: DocumentReference;
  destStockRef: DocumentReference;
  productName: string;
  allowNegative: boolean;
  destStock: number;
  /** Destination lots, oldest-first. Mutated by per-item FIFO cuts. */
  destLotPool: MutableLot[];
  initialDestLotQty: Map<string, number>;
};

/**
 * A source lot to (re)create on cancel — restores the EXACT original cost AND,
 * when known, the EXACT original receipt time so source FIFO chronology is
 * preserved. `receivedAtMs` is `null` for legacy items saved without it (falls
 * back to the cancel time).
 */
type SrcRestorePlan = {
  ref: DocumentReference;
  productId: string;
  qty: number;
  cost: number;
  receivedAtMs: number | null;
};

/**
 * Cancel a completed branch transfer — atomic, FIFO-correct, cost-exact reverse.
 *
 *   • Destination: FIFO-cut `transferQty` from the dest branch's lots and
 *     decrement `totalStockBase` (blocks when insufficient and the product
 *     disallows negative stock).
 *   • Source: recreate lots from each item's `sourceLotDetails` at the ORIGINAL
 *     costPerUnit (never avgCost) and increment `totalStockBase`.
 *   • Reversal `stockMovements` on both branches; transfer marked 'cancelled'.
 */
export async function cancelBranchTransfer(input: CancelBranchTransferInput): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) throw new Error('กรุณาระบุเหตุผลการยกเลิก');

  if (!isFirebaseConfigured || !db) {
    devCancelBranchTransfer(input.transferId);
    return;
  }

  const firestore = db;
  const transferRef = doc(firestore, collections.inventoryTransfers, input.transferId);

  // ── Pre-transaction reads (doc + subcollection items + dest lot refs) ──
  const transferSnap = await getDoc(transferRef);
  if (!transferSnap.exists()) throw new Error('ไม่พบเอกสารโอนย้าย');
  const transfer = transferSnap.data() as InventoryTransfer;
  if (transfer.status === 'cancelled') throw new Error('เอกสารนี้ถูกยกเลิกแล้ว');

  const itemsSnap = await getDocs(collection(transferRef, collections.transferItems));
  const items = itemsSnap.docs.map((d) => ({ ...(d.data() as InventoryTransferItem), id: d.id }));
  if (items.length === 0) throw new Error('ไม่พบรายการในเอกสารโอนย้าย');

  const { fromBranchId, toBranchId } = transfer;
  const uniqueProductIds = [...new Set(items.map((i) => i.productId))];

  // Destination lots to FIFO-cut on reversal.
  const destLotRefsByProduct = new Map<string, DocumentReference[]>();
  for (const productId of uniqueProductIds) {
    destLotRefsByProduct.set(
      productId,
      await fetchActiveLotRefs(firestore, productId, toBranchId),
    );
  }

  await runTransaction(firestore, async (tx) => {
    const now = serverTimestamp();

    // ── Phase 1: READS ONLY ──────────────────────────────────────────────
    const fresh = await tx.get(transferRef);
    if (!fresh.exists()) throw new Error('ไม่พบเอกสารโอนย้าย');
    if ((fresh.data() as InventoryTransfer).status === 'cancelled') {
      throw new Error('เอกสารนี้ถูกยกเลิกแล้ว');
    }

    const ctxById = new Map<string, CancelCtx>();
    for (const productId of uniqueProductIds) {
      const productRef = doc(firestore, collections.products, productId);
      const sourceStockRef = doc(
        firestore,
        collections.products,
        productId,
        collections.productStocks,
        fromBranchId,
      );
      const destStockRef = doc(
        firestore,
        collections.products,
        productId,
        collections.productStocks,
        toBranchId,
      );

      const [productSnap, destSnap] = await Promise.all([
        tx.get(productRef),
        tx.get(destStockRef),
      ]);

      const destLotPool = await readProductLotsInTransaction(
        tx,
        destLotRefsByProduct.get(productId) ?? [],
      );
      const initialDestLotQty = new Map<string, number>();
      for (const lot of destLotPool) initialDestLotQty.set(lot.ref.path, lot.qtyRemaining);

      ctxById.set(productId, {
        sourceStockRef,
        destStockRef,
        productName: items.find((i) => i.productId === productId)?.productName ?? productId,
        allowNegative:
          productSnap.exists() && (productSnap.data() as Product).allowNegativeStock === true,
        destStock: destSnap.exists() ? (destSnap.data() as ProductStock).totalStockBase : 0,
        destLotPool,
        initialDestLotQty,
      });
    }

    // ── Phase 2: PLAN in memory ──────────────────────────────────────────
    const destQtyByProduct = new Map<string, number>();
    for (const item of items) {
      destQtyByProduct.set(
        item.productId,
        (destQtyByProduct.get(item.productId) ?? 0) + item.transferQty,
      );
    }

    // Destination sufficiency — authoritative guard on totalStockBase.
    for (const [productId, qty] of destQtyByProduct) {
      const ctx = ctxById.get(productId)!;
      if (ctx.destStock < qty && !ctx.allowNegative) {
        throw new Error(
          `ไม่สามารถยกเลิก: สต็อกปลายทางไม่พอสำหรับ ${ctx.productName} (คงเหลือ ${ctx.destStock})`,
        );
      }
    }

    const destCutsByProduct = new Map<string, LotCut[]>();
    const srcRestorePlans: SrcRestorePlan[] = [];

    for (const item of items) {
      const ctx = ctxById.get(item.productId)!;

      // Destination: FIFO-cut the returned quantity.
      const { cuts, remaining } = planFifoCutFromState(ctx.destLotPool, item.transferQty);
      const acc = destCutsByProduct.get(item.productId) ?? [];
      acc.push(...cuts);
      destCutsByProduct.set(item.productId, acc);
      if (remaining > 0) {
        console.warn(
          `[cancelBranchTransfer] dest lot shortfall for ${ctx.productName}: ` +
            `${remaining} base unit(s) not covered by lots (totalStockBase ok)`,
        );
      }

      // Source: recreate lots at the EXACT original cost from saved details.
      const details = item.sourceLotDetails ?? [];
      if (details.length > 0) {
        for (const d of details) {
          if (d.qty <= 0) continue;
          srcRestorePlans.push({
            ref: doc(collection(firestore, collections.stockLots)),
            productId: item.productId,
            qty: d.qty,
            cost: d.costPerUnit,
            // Restore at the original source receipt time when tracked.
            receivedAtMs: d.receivedAtMs ?? null,
          });
        }
      } else {
        // Legacy transfer saved before exact-cost tracking — best-effort single
        // lot at the stored blended unitCost (no original receipt time known).
        srcRestorePlans.push({
          ref: doc(collection(firestore, collections.stockLots)),
          productId: item.productId,
          qty: item.transferQty,
          cost: item.unitCost ?? 0,
          receivedAtMs: null,
        });
      }
    }

    // ── Phase 3: WRITES ONLY ─────────────────────────────────────────────
    for (const [productId, qty] of destQtyByProduct) {
      const ctx = ctxById.get(productId)!;

      tx.set(
        ctx.destStockRef,
        {
          branchId: toBranchId,
          totalStockBase: increment(-qty),
          lastMovementAt: now,
          updatedAt: now,
        },
        { merge: true },
      );
      tx.set(
        ctx.sourceStockRef,
        {
          branchId: fromBranchId,
          totalStockBase: increment(qty),
          lastMovementAt: now,
          updatedAt: now,
        },
        { merge: true },
      );

      for (const cut of mergeLotCuts(destCutsByProduct.get(productId) ?? [])) {
        const initialQty = ctx.initialDestLotQty.get(cut.ref.path) ?? cut.cutQty;
        tx.update(cut.ref, {
          qtyRemaining: increment(-cut.cutQty),
          isDepleted: initialQty - cut.cutQty <= 0,
        });
      }
    }

    // Source restore lots — at the exact original cost basis.
    for (const plan of srcRestorePlans) {
      const lot: StockLot = {
        id: plan.ref.id,
        productId: plan.productId,
        branchId: fromBranchId,
        receivingId: input.transferId, // source document for this restore lot
        costPerUnit: plan.cost,
        qtyReceived: plan.qty,
        qtyRemaining: plan.qty,
        receivedAt:
          plan.receivedAtMs != null
            ? (Timestamp.fromMillis(plan.receivedAtMs) as StockLot['receivedAt'])
            : (now as StockLot['receivedAt']),
        expiryDate: null,
        isDepleted: false,
        isGhost: false,
        createdAt: now as StockLot['createdAt'],
      };
      tx.set(plan.ref, lot);
    }

    // Reversal movements: source gets stock back (transfer_in +), dest loses it.
    const note = `ยกเลิกโอนย้าย: ${reason}`;
    for (const item of items) {
      const back: Omit<StockMovement, 'id'> = {
        productId: item.productId,
        branchId: fromBranchId,
        type: 'transfer_in',
        qty: item.transferQty,
        costPerUnit: item.unitCost ?? 0,
        refId: input.transferId,
        refType: 'inventoryTransfer',
        note,
        createdBy: input.staffId,
        createdAt: now as StockMovement['createdAt'],
      };
      tx.set(doc(collection(firestore, collections.stockMovements)), back);

      const out: Omit<StockMovement, 'id'> = {
        productId: item.productId,
        branchId: toBranchId,
        type: 'transfer_out',
        qty: -item.transferQty,
        costPerUnit: item.unitCost ?? 0,
        refId: input.transferId,
        refType: 'inventoryTransfer',
        note,
        createdBy: input.staffId,
        createdAt: now as StockMovement['createdAt'],
      };
      tx.set(doc(collection(firestore, collections.stockMovements)), out);
    }

    tx.update(transferRef, {
      status: 'cancelled',
      cancelledBy: input.staffId,
      cancelledByName: input.staffName,
      cancelledAt: now,
      cancelReason: reason,
      note: [transfer.note, `ยกเลิก: ${reason}`].filter(Boolean).join(' · '),
      updatedAt: now,
    });
  });
}

/**
 * Edit a completed transfer = atomic "Cancel original + Create new".
 *
 * Two sequential transactions in the SAFE order: cancel first (returns stock to
 * the source at its exact original cost basis), then create the edited transfer.
 * If the create step fails, the original is already cancelled and stock is back
 * at the source — a consistent state (the edit simply did not apply), never a
 * double-move or phantom stock. The caller should surface the error and let the
 * admin retry.
 *
 * Returns the NEW transfer id.
 */
export async function editBranchTransfer(
  originalTransferId: string,
  form: BranchTransferForm,
  items: BranchTransferLineInput[],
  reason?: string,
): Promise<string> {
  await cancelBranchTransfer({
    transferId: originalTransferId,
    staffId: form.staffId,
    staffName: form.staffName,
    reason: reason?.trim() || 'แก้ไขรายการโอนย้าย',
  });
  return confirmBranchTransfer(form, items);
}
