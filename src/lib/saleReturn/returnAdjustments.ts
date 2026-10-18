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

import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
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

export type SaleReturnAdjustmentsState = {
  /** `ready` = every accepted Return for the branch is loaded and parsed exactly. */
  status: 'loading' | 'ready' | 'unavailable';
  adjustments: SaleReturnAdjustment[];
  byOrder: Map<string, OrderReturnSummary>;
};

const EMPTY: SaleReturnAdjustmentsState = { status: 'loading', adjustments: [], byOrder: new Map() };

/**
 * Live accepted Returns for a branch. Any read error (offline cold cache, rules
 * not yet deployed, permission) or ANY malformed record ⇒ `unavailable`, so the
 * consuming surface labels its figures gross instead of guessing.
 */
export function useSaleReturnAdjustments(branchId: string | null): SaleReturnAdjustmentsState {
  const [state, setState] = useState<SaleReturnAdjustmentsState>(EMPTY);

  useEffect(() => {
    if (!branchId) return;
    if (!isFirebaseConfigured) {
      // Dev mock mode has no Return records.
      queueMicrotask(() => setState({ status: 'ready', adjustments: [], byOrder: new Map() }));
      return;
    }
    let firestore: typeof db | null;
    try {
      firestore = db;
    } catch {
      firestore = null;
    }
    if (!firestore) {
      // No Firestore handle: cannot prove the figures are net → gross label.
      queueMicrotask(() => setState({ status: 'unavailable', adjustments: [], byOrder: new Map() }));
      return;
    }
    const q = query(collection(firestore, SALE_RETURNS_COLLECTION), where('branchId', '==', branchId));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const parsed: SaleReturnAdjustment[] = [];
        let malformed = false;
        for (const d of snap.docs) {
          const a = parseSaleReturnRecord(d.id, d.data());
          if (a == null) malformed = true;
          else parsed.push(a);
        }
        const adjustments = dedupeReturns(parsed);
        setState({
          status: malformed ? 'unavailable' : 'ready',
          adjustments,
          byOrder: summarizeReturnsByOrder(adjustments),
        });
      },
      () => setState({ status: 'unavailable', adjustments: [], byOrder: new Map() }),
    );
    return () => {
      unsub();
      setState(EMPTY);
    };
  }, [branchId]);

  return branchId ? state : EMPTY;
}
