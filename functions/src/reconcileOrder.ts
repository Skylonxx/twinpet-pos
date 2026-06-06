/**
 * reconcileOrder — server-side settlement of offline-first sales.  [P1]
 *
 * The client writes an `asyncOrders/{orderId}` doc using ONLY queueable ops (no
 * transaction, no server reads) so the sale commits offline and flushes on
 * reconnect. THIS function is the single authoritative consistency boundary: it
 * applies FIFO lot cutting, stock decrement, credit posting and shift roll-ups
 * that cannot be done safely on the client. Core logic is migrated from the old
 * client-side `src/lib/fifo.ts#completePosSale`.
 *
 * Invariants (see OFFLINE_CHECKOUT_ANALYSIS.md):
 *  - IDEMPOTENT: triggers are at-least-once; the doc id is the idempotency key.
 *    The whole settlement runs in ONE transaction that flips `reconcileStatus`
 *    to `settled`, so a re-delivery reads `settled` and exits with no writes.
 *  - CLIENT-AUTHORITATIVE NUMBER: `billId` is never renumbered.
 *  - NEGATIVE STOCK TOLERATED: the sale already happened offline, so the
 *    reconciler NEVER blocks on insufficient stock — it oversells, records an
 *    OVERSELL lot cut, and flags `hadOversell` for admin audit.
 */

// 2nd Gen (v2) trigger pointed at the configured Firestore database + region
// (firebase.json → firestore.database / firestore.location), so Eventarc's
// same-region requirement is satisfied — function and database are co-located.
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type DocumentReference,
} from 'firebase-admin/firestore';
// Shared Admin SDK handle — already pointed at the configured database (see ./db).
import { db } from './db';
import { FIRESTORE_DATABASE_ID, FUNCTIONS_REGION } from './deployConfig';
import { handleVoidIntent } from './voidIntent';

const C = {
  products: 'products',
  productStocks: 'productStocks',
  stockLots: 'stockLots',
  stockMovements: 'stockMovements',
  customers: 'customers',
  creditAccounts: 'creditAccounts',
  creditTransactions: 'creditTransactions',
  shifts: 'shifts',
  asyncOrders: 'asyncOrders',
  posDevices: 'posDevices',
  auditLogs: 'auditLogs',
  // Canonical sales collections — dual-written for backward-compat with reports.
  orders: 'orders',
  orderItems: 'orderItems',
  payments: 'payments',
} as const;

const OVERSELL_LOT_ID = 'oversell';

/** Parse the trailing sequence from an async order id (`${deviceId}-${seq}`). */
function parseSeqFromId(orderId: string): number {
  const dash = orderId.lastIndexOf('-');
  if (dash < 0) return 0;
  const n = Number.parseInt(orderId.slice(dash + 1), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── Local shapes (the functions package is independent of the web app) ──
type ReconcileStatus = 'pending_reconcile' | 'settled' | 'exception';
type LotRef = { lotId: string; qty: number; cost: number };

type AsyncPayment = { method: string; amount: number; ref?: string | null };
type AsyncLine = {
  productId: string;
  productSnap: { name: string; sku: string; category: string; barcode?: string | null };
  unit: string;
  unitFactor: number;
  qty: number;
  qtyBase: number;
  unitPrice: number;
  originalPrice?: number;
  discountAmt: number;
  lineTotal: number;
  fifoCost?: number;
  lotRefs?: LotRef[];
};
type AsyncOrderDoc = {
  id: string;
  billId: string;
  deviceId?: string;
  branchId: string;
  shiftId: string;
  staffId: string;
  staffName: string;
  customerId: string | null;
  customerSnap?: { name: string; phone: string; taxId: string | null } | null;
  priceLevelId: string;
  lines: AsyncLine[];
  payments: AsyncPayment[];
  subtotal: number;
  discountAmt?: number;
  billDiscount?: number;
  fee?: number;
  total: number;
  paidAmt: number;
  changeAmt?: number;
  creditAmt: number;
  reconcileStatus: ReconcileStatus;
  /** Total settlement attempts that have FAILED (automatic + post-retry). */
  reconcileAttempts?: number;
  /** First failure's admin-safe error (set once, preserved for debugging). */
  reconcileError?: string | null;
  voidRequested?: boolean;
  voidReason?: string | null;
  voidedBy?: string | null;
  /** Phase 7 idempotency flag — set once a SETTLED order's reversal is applied. */
  voidReconciled?: boolean;
  /** Device clock at sale — used as the canonical order `createdAt` (true sale day). */
  clientCreatedAt?: number;
};

type MutableLot = {
  ref: DocumentReference;
  id: string;
  qtyRemaining: number;
  costPerUnit: number;
  receivedAtMs: number;
};
type LotCut = { ref: DocumentReference; cutQty: number };

// ── Pure helpers (ported from fifo.ts / shiftService.ts) ──
const roundMoney = (n: number): number => Math.round(n * 100) / 100;

function parseReceivedAtMs(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (value && typeof value === 'object' && 'seconds' in value) {
    const s = (value as { seconds: unknown }).seconds;
    if (typeof s === 'number') return s * 1000;
  }
  return 0;
}

/** Walk lots oldest-first, cutting up to `qtyBase`. Mutates each lot's remaining. */
function planFifoCutFromState(
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
function mergeLotCuts(cuts: LotCut[]): LotCut[] {
  const byRef = new Map<string, LotCut>();
  for (const cut of cuts) {
    if (!cut.ref?.path || cut.cutQty <= 0) continue;
    const existing = byRef.get(cut.ref.path);
    if (existing) existing.cutQty += cut.cutQty;
    else byRef.set(cut.ref.path, { ...cut });
  }
  return [...byRef.values()];
}

/** Cost for an oversold qty (no lot covers it): newest lot cost → product cost → avgCost → 0. */
function resolveOversellCost(sourceLots: MutableLot[], product: DocumentData | undefined): number {
  for (let i = sourceLots.length - 1; i >= 0; i -= 1) {
    const cost = sourceLots[i]?.costPerUnit ?? 0;
    if (cost > 0) return cost;
  }
  const manual = product?.cost;
  if (typeof manual === 'number' && manual > 0) return manual;
  const avg = product?.avgCost;
  if (typeof avg === 'number' && avg > 0) return avg;
  return 0;
}

/**
 * Trigger on WRITE (create + update) so we catch both the initial sale and a
 * later offline void-intent flag on the same doc.
 */
/** Minimal shape the handler reads — the real FirestoreEvent is assignable to it. */
type WrittenEvent = {
  data?: {
    after?: { exists: boolean; ref: DocumentReference; data: () => DocumentData | undefined };
  };
};

/**
 * Trigger handler — EXTRACTED and EXPORTED so the routing is unit-tested without
 * an emulator (see reconcileTrigger.test.ts). The `voidRequested` gate runs
 * FIRST — before the pending-only reconcile gate — so a SETTLED void is routed to
 * `handleVoidIntent` and is NEVER silently dropped.
 */
export async function reconcileOnWrite(event: WrittenEvent): Promise<void> {
  const after = event.data?.after;
  if (!after || !after.exists) return; // deleted — nothing to do
  const data = after.data() as AsyncOrderDoc | undefined;
  if (!data) return;

  // Routing gate: ANY void-intent (pending OR settled) → handleVoidIntent, BEFORE
  // the `reconcileStatus !== 'pending_reconcile'` gate below.
  if (data.voidRequested) {
    try {
      await handleVoidIntent(db, after.ref);
    } catch (err) {
      // Make a failed void VISIBLE on the doc — never a silent stuck void.
      await after.ref.set(
        {
          voidError: err instanceof Error ? err.message : String(err),
          voidErroredAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      throw err; // also surface to Cloud Functions logs for retry/alerting
    }
    return;
  }

  if (data.reconcileStatus !== 'pending_reconcile') return;

  try {
    await reconcileSale(after.ref);
  } catch (err) {
    // Admin-visible fields are SANITIZED (message only, single-lined, truncated).
    // The full/raw error is preserved ONLY in the Cloud Functions logs via the
    // rethrow below — never written to an admin-facing field.
    const safeError = sanitizeReconcileError(err);
    const patch: Record<string, unknown> = {
      reconcileStatus: 'exception' satisfies ReconcileStatus,
      // ATOMIC counter — server-side increment against the CURRENT stored value,
      // never the (possibly stale) event payload. Safe under duplicate trigger
      // deliveries / concurrent attempts. Counts every FAILED settle (initial
      // automatic + each post-retry attempt).
      reconcileAttempts: FieldValue.increment(1),
      lastReconcileError: safeError,
      lastReconcileErrorAt: FieldValue.serverTimestamp(),
      reconciledAt: FieldValue.serverTimestamp(),
    };
    // Preserve the FIRST failure's error + time as a stable debugging anchor.
    if (data.reconcileError == null) {
      patch.reconcileError = safeError;
      patch.firstFailedAt = FieldValue.serverTimestamp();
    }
    await after.ref.set(patch, { merge: true });
    throw err; // full (unsanitized) error still surfaces to Cloud Functions logs
  }
}

const MAX_ADMIN_ERROR_LEN = 300;

/**
 * Admin-safe error string for the async-order doc: the error MESSAGE only (never
 * the stack or internal objects), collapsed to a single line and truncated. Raw
 * detail stays in Cloud Functions logs (the handler rethrows), not in Firestore.
 */
export function sanitizeReconcileError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return 'unknown error';
  return oneLine.length > MAX_ADMIN_ERROR_LEN
    ? `${oneLine.slice(0, MAX_ADMIN_ERROR_LEN)}…`
    : oneLine;
}

/**
 * Patch fragment merged into the doc when a sale (re)settles SUCCESSFULLY:
 * clears the ACTIVE error state and, if this settle recovered a prior failure,
 * preserves the (already-sanitized) previous error in a historical audit field.
 * No raw/internal detail is ever surfaced — `previousReconcileError` is the
 * sanitized string we had stored. Exported for unit testing.
 */
export function buildRecoveryAuditPatch(order: {
  reconcileError?: unknown;
  lastReconcileError?: unknown;
}): Record<string, unknown> {
  const prior =
    typeof order.lastReconcileError === 'string'
      ? order.lastReconcileError
      : typeof order.reconcileError === 'string'
        ? order.reconcileError
        : null;
  const patch: Record<string, unknown> = {
    // Clear active error state on success.
    reconcileError: FieldValue.delete(),
    lastReconcileError: FieldValue.delete(),
    lastReconcileErrorAt: FieldValue.delete(),
    firstFailedAt: FieldValue.delete(),
  };
  if (prior) {
    patch.previousReconcileError = prior; // sanitized history (recovery audit)
    patch.reconcileRecoveredAt = FieldValue.serverTimestamp();
  }
  return patch;
}

export const reconcileOrder = onDocumentWritten(
  { document: 'asyncOrders/{orderId}', region: FUNCTIONS_REGION, database: FIRESTORE_DATABASE_ID },
  (event) => reconcileOnWrite(event),
);

/** Settle ONE offline sale atomically. Mirrors the old `completePosSale` phases. */
async function reconcileSale(orderRef: DocumentReference): Promise<void> {
  await db.runTransaction(async (tx) => {
    // ── Phase 1: reads (all before any write) ──
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return;
    const order = orderSnap.data() as AsyncOrderDoc;
    // In-transaction idempotency guard — re-delivery races settle here.
    if (order.reconcileStatus !== 'pending_reconcile') return;

    const branchId = order.branchId;
    const productIds = [...new Set(order.lines.map((l) => l.productId))];

    const stockRefs = new Map<string, DocumentReference>();
    const productData = new Map<string, DocumentData | undefined>();
    for (const pid of productIds) {
      const stockRef = db
        .collection(C.products)
        .doc(pid)
        .collection(C.productStocks)
        .doc(branchId);
      stockRefs.set(pid, stockRef);
      // No stock read needed: we tolerate oversell and use FieldValue.increment,
      // so we never read totalStockBase (fewer read-locks → fewer tx aborts).
      const prodSnap = await tx.get(db.collection(C.products).doc(pid));
      productData.set(pid, prodSnap.exists ? prodSnap.data() : undefined);
    }

    // Admin SDK can run queries inside a transaction (unlike the web SDK).
    const lotsByProduct = new Map<string, MutableLot[]>();
    for (const pid of productIds) {
      const lotsSnap = await tx.get(
        db
          .collection(C.stockLots)
          .where('productId', '==', pid)
          .where('branchId', '==', branchId)
          .where('isDepleted', '==', false)
          .orderBy('receivedAt', 'asc'),
      );
      const lots: MutableLot[] = [];
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
      lotsByProduct.set(pid, lots);
    }

    let custRef: DocumentReference | null = null;
    let custData: DocumentData | null = null;
    let credRef: DocumentReference | null = null;
    let credData: DocumentData | null = null;
    if (order.customerId) {
      custRef = db.collection(C.customers).doc(order.customerId);
      const cs = await tx.get(custRef);
      custData = cs.exists ? (cs.data() ?? null) : null;
      if (order.creditAmt > 0) {
        credRef = db.collection(C.creditAccounts).doc(order.customerId);
        const credSnap = await tx.get(credRef);
        credData = credSnap.exists ? (credSnap.data() ?? null) : null;
      }
    }

    // Per-device receipt high-watermark — O(1) source for the Claim recovery flow.
    // Read here (locks the device doc) so the max is computed atomically even if
    // two sales from the same device reconcile concurrently.
    const orderSeq = parseSeqFromId(orderRef.id);
    let deviceRef: DocumentReference | null = null;
    let currentLastSeq = 0;
    if (order.deviceId) {
      deviceRef = db.collection(C.posDevices).doc(order.deviceId);
      const devSnap = await tx.get(deviceRef);
      const stored = devSnap.exists ? devSnap.data()?.lastSeq : undefined;
      currentLastSeq = typeof stored === 'number' ? stored : 0;
    }

    // ── Phase 2: plan FIFO (in memory) — never throws; oversell tolerated ──
    const initialLotQty = new Map<string, number>();
    for (const lots of lotsByProduct.values()) {
      for (const l of lots) initialLotQty.set(l.ref.path, l.qtyRemaining);
    }

    const stockDeduct = new Map<string, number>();
    const allLotCuts: LotCut[] = [];
    const enrichedLines: AsyncLine[] = [];
    let hadOversell = false;

    for (const line of order.lines) {
      const qtyBase = line.qtyBase || line.qty * line.unitFactor;
      stockDeduct.set(line.productId, (stockDeduct.get(line.productId) ?? 0) + qtyBase);

      const lots = lotsByProduct.get(line.productId) ?? [];
      const { cuts, lotRefs, remaining } = planFifoCutFromState(lots, qtyBase);

      if (remaining > 0) {
        // Oversell tolerance: fabricate a costed oversell ref instead of blocking.
        hadOversell = true;
        lotRefs.push({
          lotId: OVERSELL_LOT_ID,
          qty: remaining,
          cost: resolveOversellCost(lots, productData.get(line.productId)),
        });
      }
      allLotCuts.push(...cuts);

      const fifoCost = roundMoney(lotRefs.reduce((s, r) => s + r.qty * r.cost, 0));
      enrichedLines.push({ ...line, qtyBase, fifoCost, lotRefs });
    }

    const grandTotal = roundMoney(order.total);
    const totalCogs = roundMoney(enrichedLines.reduce((s, l) => s + (l.fifoCost ?? 0), 0));
    const grossProfit = roundMoney(roundMoney(order.subtotal) - totalCogs);

    // ── Phase 3: writes ──
    // Lot consumption (may drive qtyRemaining negative — tolerated).
    for (const cut of mergeLotCuts(allLotCuts)) {
      const initialQty = initialLotQty.get(cut.ref.path) ?? cut.cutQty;
      tx.update(cut.ref, {
        qtyRemaining: FieldValue.increment(-cut.cutQty),
        isDepleted: initialQty - cut.cutQty <= 0,
      });
    }

    // Stock decrement — NO sufficiency guard; totalStockBase may go negative.
    for (const pid of productIds) {
      const deduct = stockDeduct.get(pid) ?? 0;
      if (deduct <= 0) continue;
      tx.set(
        stockRefs.get(pid)!,
        {
          branchId,
          totalStockBase: FieldValue.increment(-deduct),
          lastMovementAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    // Stock movements (audit trail; oversell visible via negative running stock).
    for (const line of enrichedLines) {
      const moveRef = db.collection(C.stockMovements).doc();
      tx.set(moveRef, {
        id: moveRef.id,
        productId: line.productId,
        branchId,
        type: 'sale',
        qty: -(line.qtyBase ?? 0),
        costPerUnit: line.lotRefs?.[0]?.cost ?? 0,
        refId: order.billId,
        refType: 'order',
        note: '',
        createdBy: order.staffId,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    // Shift roll-up REMOVED — drawer single-writer (Standalone POS, Local-First):
    // the terminal is the sole authority for its shift totals, derived from its
    // local `asyncOrders` ledger (see selectLocalLedger / deriveShiftDrawer) and
    // committed onto the shift doc at close. The reconciler must NOT touch
    // `shifts.expected*` or it would double-count against the client's ledger.

    // Advance the device's receipt high-watermark (atomic max via the read above)
    // so "Claim Device" can resume numbering in O(1) without scanning orders.
    if (deviceRef && orderSeq > currentLastSeq) {
      tx.set(
        deviceRef,
        { lastSeq: orderSeq, lastSeqAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }

    // Credit posting + CRM. Credit limit is NOT enforced here — the offline sale
    // already happened; over-limit is surfaced for audit, never reversed.
    if (order.customerId && custRef && custData) {
      const crm: Record<string, unknown> = {
        lifetimeValue: FieldValue.increment(grandTotal),
        totalSpent: FieldValue.increment(grandTotal),
        lastVisitAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        // Loyalty points are feature-flagged off in the app; wire via a server
        // setting when the business enables loyalty (keeps parity for now).
      };
      if (order.creditAmt > 0) {
        crm.outstandingBalance = FieldValue.increment(order.creditAmt);
        crm.lastCreditPurchaseDate = Timestamp.now();
        if (credRef && credData) {
          const creditLimit = (credData.creditLimit as number) ?? 0;
          const newUsed = ((credData.creditUsed as number) ?? 0) + order.creditAmt;
          tx.update(credRef, {
            creditUsed: FieldValue.increment(order.creditAmt),
            creditBalance: creditLimit - newUsed,
            lastTransAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          const creditTxRef = db.collection(C.creditTransactions).doc();
          tx.set(creditTxRef, {
            id: creditTxRef.id,
            customerId: order.customerId,
            branchId,
            type: 'charge',
            amount: order.creditAmt,
            balance: creditLimit - newUsed,
            refOrderId: order.id,
            note: '',
            createdBy: order.staffId,
            createdAt: FieldValue.serverTimestamp(),
            dueDate: null,
            isPaid: false,
            paidAt: null,
          });
        }
      }
      tx.update(custRef, crm);
    }

    const settledStatus = order.creditAmt > 0 && order.paidAmt < grandTotal ? 'pending_payment' : 'completed';

    // ── Dual-write to canonical `orders`/`orderItems`/`payments` ──
    // Keeps all existing reports/void working unchanged. The canonical doc id ==
    // the async order id (deterministic), so a (guarded) re-run overwrites rather
    // than duplicates. `createdAt` uses the SALE time (device clock) so a sale
    // made days ago offline reports under its real day, not the sync day.
    const saleTime = Timestamp.fromMillis(order.clientCreatedAt || Date.now());
    const canonicalRef = db.collection(C.orders).doc(order.id);
    tx.set(canonicalRef, {
      id: order.id,
      billId: order.billId,
      branchId,
      customerId: order.customerId,
      customerSnap: order.customerSnap ?? null,
      staffId: order.staffId,
      staffName: order.staffName,
      shiftId: order.shiftId,
      status: settledStatus,
      subtotal: roundMoney(order.subtotal),
      discountAmt: roundMoney(order.discountAmt ?? 0),
      billDiscount: roundMoney(order.billDiscount ?? 0),
      vatRate: 0,
      vatAmt: 0,
      surcharge: roundMoney(order.fee ?? 0),
      total: grandTotal,
      paidAmt: roundMoney(order.paidAmt),
      changeAmt: roundMoney(order.changeAmt ?? 0),
      creditAmt: order.creditAmt,
      cogs: totalCogs,
      profit: grossProfit,
      priceLevelId: order.priceLevelId,
      note: '',
      voidReason: null,
      voidedBy: null,
      voidedAt: null,
      printCount: 0,
      createdAt: saleTime,
      updatedAt: FieldValue.serverTimestamp(),
      // Provenance back to the offline source.
      asyncOrderId: order.id,
      deviceId: order.deviceId ?? null,
    });

    const itemsCol = canonicalRef.collection(C.orderItems);
    for (const line of enrichedLines) {
      const itemRef = itemsCol.doc();
      tx.set(itemRef, {
        id: itemRef.id,
        productId: line.productId,
        productSnap: line.productSnap,
        unit: line.unit,
        unitFactor: line.unitFactor,
        qty: line.qty,
        qtyBase: line.qtyBase,
        unitPrice: line.unitPrice,
        originalPrice: line.originalPrice ?? line.unitPrice,
        discountAmt: line.discountAmt,
        lineTotal: line.lineTotal,
        fifoCost: line.fifoCost ?? 0,
        lotRefs: line.lotRefs ?? [],
      });
    }

    for (const pay of order.payments) {
      if (pay.amount <= 0) continue;
      const payRef = db.collection(C.payments).doc();
      tx.set(payRef, {
        id: payRef.id,
        orderId: order.id,
        branchId,
        method: pay.method,
        amount: pay.amount,
        ref: pay.ref ?? null,
        createdAt: saleTime,
      });
    }

    // Settle the async order — same transaction flips the idempotency flag.
    // On a recovered retry, also clear the active error state and preserve the
    // sanitized prior error in a historical audit field (buildRecoveryAuditPatch).
    tx.set(
      orderRef,
      {
        reconcileStatus: 'settled' satisfies ReconcileStatus,
        reconciledAt: FieldValue.serverTimestamp(),
        status: settledStatus,
        lines: enrichedLines,
        cogs: totalCogs,
        profit: grossProfit,
        hadOversell,
        updatedAt: FieldValue.serverTimestamp(),
        ...buildRecoveryAuditPatch(order),
      },
      { merge: true },
    );
  });
}

// Offline void is handled by handleVoidIntent (./voidIntent.ts), invoked from the
// trigger's voidRequested gate above. Extracted there so it can be unit-tested
// against an injected (fake) Firestore — see voidIntent.test.ts.

// TODO (separate fn): scheduled `sweepStuckOrders` — retry `exception`/stale
// `pending_reconcile` orders past an SLA, and alert on stale devices.

