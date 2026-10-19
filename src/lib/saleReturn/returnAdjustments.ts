/**
 * Return/Refund V1 — reporting adjustment source (D-RET-FIX-9 release gate).
 *
 * Original sale/order documents stay historical and immutable; accepted
 * `saleReturns` records are the ONLY adjustment source. Every owner-facing
 * surface that presents a value as current/net folds these in; a surface that
 * cannot (records not loaded, unreadable, or not yet deployed) must label its
 * figures as GROSS BEFORE RETURNS — never silently present gross as net.
 *
 * Attribution: an adjustment is attributed to its ORIGINAL sale (same order,
 * same sale date), so a bill's net = its original value − its accepted
 * Returns, consistently across Sales History and the Profit report.
 *
 * Money is accumulated in integer satang; each Return is counted once per
 * `returnId` (a replayed/duplicate record can never double-net).
 */

import { collection, onSnapshot, query, where, type Firestore } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { db, isFirebaseConfigured } from '../firebase';
import type { SaleReturnRefundMethod } from './saleReturnTypes';

export const SALE_RETURNS_COLLECTION = 'saleReturns';

export const GROSS_BEFORE_RETURNS_LABEL = 'ก่อนหักคืนสินค้า';
export const NET_AFTER_RETURNS_LABEL = 'สุทธิหลังหักคืนสินค้า';

export type ReturnAdjustmentLine = {
  lineIndex: number;
  productId: string;
  productName: string;
  sku: string;
  category: string;
  unit: string;
  returnedQty: number;
  unitPrice: number;
  /** Gross line revenue reversed (line-total basis, before bill discount). */
  lineRevenueReversedMinor: number;
  refundMinor: number;
  costRestoredMinor: number;
};

export type SaleReturnAdjustment = {
  returnId: string;
  returnNo: string;
  orderId: string;
  branchId: string;
  originalSaleCreatedAtMillis: number;
  createdAtMillis: number;
  refundMethod: SaleReturnRefundMethod;
  refundMinor: number;
  lineRevenueReversedMinor: number;
  costRestoredMinor: number;
  lines: ReturnAdjustmentLine[];
};

export type OrderReturnSummary = {
  orderId: string;
  returnCount: number;
  refundMinor: number;
  cashRefundMinor: number;
  lineRevenueReversedMinor: number;
  costRestoredMinor: number;
};

const METHODS: readonly SaleReturnRefundMethod[] = ['cash', 'qr', 'kbank', 'card', 'none'];

function minor(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e9) return null;
  const scaled = v * 100;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-4 || rounded < 0) return null;
  return rounded;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Strict parse of one accepted Return record; `null` = malformed (callers fail to GROSS). */
export function parseSaleReturnRecord(id: string, data: unknown): SaleReturnAdjustment | null {
  const d = obj(data);
  if (!d || d.schemaVersion !== 1 || d.status !== 'completed') return null;
  if (str(d.returnId) !== id || !str(d.originalOrderId) || !str(d.branchId)) return null;
  const refund = obj(d.refund);
  const totals = obj(d.totals);
  if (!refund || !totals || !Array.isArray(d.lines) || d.lines.length === 0) return null;
  const method = refund.method as SaleReturnRefundMethod;
  if (!METHODS.includes(method)) return null;
  const refundMinor = minor(refund.amount);
  const totalRevenue = minor(totals.lineRevenueReversed);
  const totalCost = minor(totals.costRestored);
  if (refundMinor == null || totalRevenue == null || totalCost == null) return null;

  const lines: ReturnAdjustmentLine[] = [];
  let sumRefund = 0;
  let sumRevenue = 0;
  let sumCost = 0;
  for (const raw of d.lines as unknown[]) {
    const l = obj(raw);
    const pricing = obj(l?.pricing);
    const cost = obj(l?.cost);
    if (!l || !pricing || !cost) return null;
    const rev = minor(pricing.lineRevenueReversed);
    const ref = minor(pricing.refundAmount);
    const cst = minor(cost.total);
    const unitPrice = minor(pricing.unitPrice);
    if (rev == null || ref == null || cst == null || unitPrice == null) return null;
    if (typeof l.lineIndex !== 'number' || typeof l.returnedQty !== 'number' || !(l.returnedQty > 0)) return null;
    if (!str(l.productId)) return null;
    sumRefund += ref;
    sumRevenue += rev;
    sumCost += cst;
    lines.push({
      lineIndex: l.lineIndex,
      productId: str(l.productId),
      productName: str(l.productName),
      sku: str(l.sku),
      category: str(l.category),
      unit: str(l.unit),
      returnedQty: l.returnedQty,
      unitPrice: unitPrice / 100,
      lineRevenueReversedMinor: rev,
      refundMinor: ref,
      costRestoredMinor: cst,
    });
  }
  // The record must reconcile with itself exactly (totals are sums of the lines).
  if (sumRefund !== refundMinor || sumRevenue !== totalRevenue || sumCost !== totalCost) return null;
  return {
    returnId: id,
    returnNo: str(d.returnNo),
    orderId: str(d.originalOrderId),
    branchId: str(d.branchId),
    originalSaleCreatedAtMillis: typeof d.originalSaleCreatedAtMillis === 'number' ? d.originalSaleCreatedAtMillis : 0,
    createdAtMillis: typeof d.createdAtMillis === 'number' ? d.createdAtMillis : 0,
    refundMethod: method,
    refundMinor,
    lineRevenueReversedMinor: totalRevenue,
    costRestoredMinor: totalCost,
    lines,
  };
}

/** Dedupe by returnId (first wins), then aggregate per original order, in satang. */
export function summarizeReturnsByOrder(adjustments: readonly SaleReturnAdjustment[]): Map<string, OrderReturnSummary> {
  const seen = new Set<string>();
  const out = new Map<string, OrderReturnSummary>();
  for (const a of adjustments) {
    if (seen.has(a.returnId)) continue;
    seen.add(a.returnId);
    const cur = out.get(a.orderId) ?? {
      orderId: a.orderId,
      returnCount: 0,
      refundMinor: 0,
      cashRefundMinor: 0,
      lineRevenueReversedMinor: 0,
      costRestoredMinor: 0,
    };
    cur.returnCount += 1;
    cur.refundMinor += a.refundMinor;
    if (a.refundMethod === 'cash') cur.cashRefundMinor += a.refundMinor;
    cur.lineRevenueReversedMinor += a.lineRevenueReversedMinor;
    cur.costRestoredMinor += a.costRestoredMinor;
    out.set(a.orderId, cur);
  }
  return out;
}

export function dedupeReturns(adjustments: readonly SaleReturnAdjustment[]): SaleReturnAdjustment[] {
  const seen = new Set<string>();
  return adjustments.filter((a) => (seen.has(a.returnId) ? false : (seen.add(a.returnId), true)));
}

/** A bill's current value after its accepted Returns — never below 0. */
export function netAfterReturns(originalTotal: number, summary: OrderReturnSummary | undefined): number {
  const orig = Math.round(originalTotal * 100);
  return Math.max(0, orig - (summary?.refundMinor ?? 0)) / 100;
}

/**
 * Completeness of the branch's accepted-Return set (final-gate fix §1):
 *  - `loading`     — no listener event yet for this branch/subscription.
 *  - `unconfirmed` — the latest event came from the local cache
 *                    (`metadata.fromCache === true`): offline, before the first
 *                    server answer, or after connectivity was lost. A cached
 *                    result — even a valid or empty one — is NOT proof that
 *                    every accepted Return is present.
 *  - `ready`       — the latest event is a server-confirmed (non-cache) query
 *                    snapshot for exactly this branch and every record parsed.
 *  - `unavailable` — read error, or any malformed/foreign record.
 * Only `ready` may be presented as net; every other state is gross.
 */
export type SaleReturnAdjustmentsStatus = 'loading' | 'unconfirmed' | 'ready' | 'unavailable';

export type SaleReturnAdjustmentsState = {
  /** The branch this state was derived for; a state is never reused for another branch. */
  branchId: string | null;
  status: SaleReturnAdjustmentsStatus;
  /** Populated only when `status === 'ready'` (never a partial set). */
  adjustments: SaleReturnAdjustment[];
  byOrder: Map<string, OrderReturnSummary>;
};

function emptyState(branchId: string | null, status: SaleReturnAdjustmentsStatus): SaleReturnAdjustmentsState {
  return { branchId, status, adjustments: [], byOrder: new Map() };
}

/** Minimal shape of a Firestore query snapshot this module relies on. */
export type SaleReturnSnapshotLike = {
  docs: ReadonlyArray<{ id: string; data(): unknown }>;
  metadata: { fromCache: boolean };
};

/**
 * Pure: one listener event → state. Malformed data fails closed whatever its
 * source; a cache-sourced event is `unconfirmed` and exposes no adjustments,
 * so no surface can mix an incomplete set into a "net" figure.
 */
export function adjustmentsStateFromSnapshot(branchId: string, snap: SaleReturnSnapshotLike): SaleReturnAdjustmentsState {
  const parsed: SaleReturnAdjustment[] = [];
  for (const d of snap.docs) {
    const a = parseSaleReturnRecord(d.id, d.data());
    if (a == null || a.branchId !== branchId) return emptyState(branchId, 'unavailable');
    parsed.push(a);
  }
  if (snap.metadata?.fromCache !== false) return emptyState(branchId, 'unconfirmed');
  const adjustments = dedupeReturns(parsed);
  return { branchId, status: 'ready', adjustments, byOrder: summarizeReturnsByOrder(adjustments) };
}

/** Listener adapter seam: production = `onSnapshot(query, { includeMetadataChanges: true }, …)`. */
export type SaleReturnAdjustmentsListen = (
  branchId: string,
  onNext: (snap: SaleReturnSnapshotLike) => void,
  onError: (err: unknown) => void,
) => () => void;

/**
 * One subscription generation for one branch. After the returned unsubscribe
 * runs, late events from this generation are dropped, so a previous branch's
 * (or previous mount's) `ready` can never be published for the current one.
 */
export function subscribeSaleReturnAdjustments(
  branchId: string,
  emit: (state: SaleReturnAdjustmentsState) => void,
  listen: SaleReturnAdjustmentsListen,
): () => void {
  let active = true;
  let unsub: () => void = () => {};
  try {
    unsub = listen(
      branchId,
      (snap) => {
        if (!active) return;
        let next: SaleReturnAdjustmentsState;
        try {
          next = adjustmentsStateFromSnapshot(branchId, snap);
        } catch {
          next = emptyState(branchId, 'unavailable');
        }
        emit(next);
      },
      () => {
        if (active) emit(emptyState(branchId, 'unavailable'));
      },
    );
  } catch {
    queueMicrotask(() => {
      if (active) emit(emptyState(branchId, 'unavailable'));
    });
  }
  return () => {
    active = false;
    unsub();
  };
}

/**
 * Metadata changes are REQUIRED: without them a cache → server transition with
 * unchanged documents raises no event and the state would stay `unconfirmed`;
 * with them a loss of connectivity after a confirmation re-raises the snapshot
 * with `fromCache: true` and the surfaces demote to gross (policy: a figure
 * whose completeness cannot currently be re-established is never shown as net).
 */
export function firestoreSaleReturnAdjustmentsListen(firestore: Firestore): SaleReturnAdjustmentsListen {
  return (branchId, onNext, onError) =>
    onSnapshot(
      query(collection(firestore, SALE_RETURNS_COLLECTION), where('branchId', '==', branchId)),
      { includeMetadataChanges: true },
      onNext,
      onError,
    );
}

/** Caption for a surface that is NOT net (`where` = position of the figures). */
export function grossBasisNote(status: SaleReturnAdjustmentsStatus, where: 'above' | 'below'): string {
  const figures = where === 'above' ? 'ตัวเลขด้านบน' : 'ตัวเลขด้านล่าง';
  if (status === 'loading') return `กำลังโหลดรายการคืนสินค้า — ${figures}ยังเป็นยอดก่อนหักคืนสินค้า`;
  if (status === 'unconfirmed') {
    return `ยังยืนยันรายการคืนสินค้าครบถ้วนกับเซิร์ฟเวอร์ไม่ได้ (ออฟไลน์หรือใช้ข้อมูลในเครื่อง) — ${figures}เป็นยอดก่อนหักคืนสินค้า (ไม่ใช่ยอดสุทธิ)`;
  }
  return `โหลดรายการคืนสินค้าไม่ได้ — ${figures}เป็นยอดก่อนหักคืนสินค้า (ไม่ใช่ยอดสุทธิ)`;
}

/**
 * Hook state slot: the adjustments state is owned by exactly one subscription
 * generation. `generation` advances synchronously (during render) on every
 * branch change, so a state confirmed by an earlier generation — even one for
 * the same branchId after A → B → A — is never returned, and an emit from an
 * earlier generation is rejected at the state update.
 */
type AdjustmentsSlot = {
  generation: number;
  branchId: string | null;
  state: SaleReturnAdjustmentsState;
};

/**
 * Live accepted Returns for a branch, net-eligible ONLY when server-confirmed
 * complete (see {@link SaleReturnAdjustmentsStatus}) by the CURRENT
 * subscription generation. Any read error (rules not yet deployed, permission)
 * or ANY malformed record ⇒ `unavailable`. `listenOverride` is a test seam and
 * must be referentially stable.
 */
export function useSaleReturnAdjustments(
  branchId: string | null,
  listenOverride?: SaleReturnAdjustmentsListen,
): SaleReturnAdjustmentsState {
  const [slot, setSlot] = useState<AdjustmentsSlot>(() => ({
    generation: 0,
    branchId,
    state: emptyState(branchId, 'loading'),
  }));

  // Render-phase invalidation (React "adjust state when a prop changes"): a
  // branch change starts a new generation BEFORE anything is rendered or
  // committed with it. This pass returns `loading`, never the prior state.
  let current = slot;
  if (slot.branchId !== branchId) {
    current = { generation: slot.generation + 1, branchId, state: emptyState(branchId, 'loading') };
    setSlot(current);
  }
  const generation = current.generation;

  useEffect(() => {
    if (!branchId) return;
    const setState = (next: SaleReturnAdjustmentsState) =>
      setSlot((prev) =>
        prev.generation === generation && prev.branchId === branchId && next.branchId === branchId
          ? { ...prev, state: next }
          : prev,
      );
    let listen = listenOverride;
    if (!listen) {
      if (!isFirebaseConfigured) {
        // Dev mock mode has no Return records.
        let live = true;
        queueMicrotask(() => {
          if (live) setState({ branchId, status: 'ready', adjustments: [], byOrder: new Map() });
        });
        return () => {
          live = false;
        };
      }
      let firestore: Firestore | null;
      try {
        firestore = db ?? null;
      } catch {
        firestore = null;
      }
      if (!firestore) {
        // No Firestore handle: cannot prove the figures are net → gross label.
        let live = true;
        queueMicrotask(() => {
          if (live) setState(emptyState(branchId, 'unavailable'));
        });
        return () => {
          live = false;
        };
      }
      listen = firestoreSaleReturnAdjustmentsListen(firestore);
    }
    return subscribeSaleReturnAdjustments(branchId, setState, listen);
  }, [branchId, listenOverride, generation]);

  // A state derived for another branch/generation (or none yet) is never reused.
  const loading = useMemo(() => emptyState(branchId, 'loading'), [branchId]);
  return branchId && current.state.branchId === branchId ? current.state : loading;
}
