import type { AsyncOrder, AsyncPayment, OrderStatus, ReconcileStatus } from '../types';

/**
 * Local-ledger selector (Standalone POS — Local-First).
 *
 * In the local-first architecture the terminal is the SINGLE writer of its own
 * drawer/shift truth: it derives that truth from the device's local cache of
 * `asyncOrders` rather than from the server reconciler. This module is the pure
 * normalization layer that turns the raw `AsyncOrder` intent docs into a clean,
 * ordered "unified sale view" the drawer/shift math can fold over.
 *
 * Design rules (all pure, no I/O, no clock reads):
 *  - `serverCreatedAt` is `null` until the offline write flushes — never sort or
 *    branch on it; surface it only as the `pendingSync` flag and fall back to
 *    `clientCreatedAt` for the effective time.
 *  - Ordering is by `clientCreatedAt` (device-authoritative; the single writer's
 *    clock is internally monotonic), tie-broken by the local sequence so two
 *    sales stamped in the same millisecond stay deterministically ordered.
 *  - Voided / void-requested (Phase A pending tombstone) and reconcile
 *    `exception` docs are NOT sales — they are excluded from the ledger.
 */

/** A normalized, ledger-visible sale derived from one {@link AsyncOrder}. */
export type LocalSale = {
  id: string;
  billId: string;
  deviceId: string;
  shiftId: string;
  staffId: string;
  staffName: string;
  customerId: string | null;

  status: OrderStatus;
  reconcileStatus: ReconcileStatus;

  total: number;
  paidAmt: number;
  changeAmt: number;
  creditAmt: number;
  /** Per-method tender breakdown, preserved for drawer reconciliation. */
  payments: AsyncPayment[];

  /** True while the local write has not yet flushed (`serverCreatedAt` is null). */
  pendingSync: boolean;
  /** Device clock at sale time — the authoritative ordering key. */
  clientCreatedAt: number;
  /** Effective time in ms: server time once flushed, else `clientCreatedAt`. */
  occurredAt: number;
  /** Local sequence parsed from the deterministic `${deviceId}-${seq}` id. */
  sortSeq: number;
};

/**
 * The id is the deterministic `${deviceId}-${localSeq}` (the device id may itself
 * contain hyphens, so the sequence is the final dash-delimited segment).
 */
function localSeqOf(id: string): number {
  const seq = Number(id.slice(id.lastIndexOf('-') + 1));
  return Number.isFinite(seq) ? seq : 0;
}

/**
 * Effective sale time in ms-since-epoch. Prefers the authoritative server time
 * once the write has flushed; falls back to the device clock while still pending.
 */
export function effectiveMillis(order: AsyncOrder): number {
  const ts = order.serverCreatedAt;
  if (ts && typeof ts.toMillis === 'function') return ts.toMillis();
  return order.clientCreatedAt;
}

/**
 * Inclusion predicate: is this intent doc a real, ledger-visible sale?
 * Excludes voided sales, offline void-intents (Phase A pending tombstone), and
 * reconcile exceptions (surfaced separately in the admin exceptions view).
 */
export function isLedgerSale(order: AsyncOrder): boolean {
  if (order.status === 'voided') return false;
  if (order.voidRequested === true) return false;
  if (order.reconcileStatus === 'exception') return false;
  return true;
}

/** Pure projection of one {@link AsyncOrder} into the unified {@link LocalSale} view. */
export function toLocalSale(order: AsyncOrder): LocalSale {
  return {
    id: order.id,
    billId: order.billId,
    deviceId: order.deviceId,
    shiftId: order.shiftId,
    staffId: order.staffId,
    staffName: order.staffName,
    customerId: order.customerId,
    status: order.status,
    reconcileStatus: order.reconcileStatus,
    total: order.total,
    paidAmt: order.paidAmt,
    changeAmt: order.changeAmt,
    creditAmt: order.creditAmt,
    // Defensive copy: the ledger is read-only, but cloning the array AND each
    // payment object stops any downstream (React) consumer from mutating the
    // source AsyncOrder held in the Firestore cache.
    payments: order.payments.map((p) => ({ ...p })),
    pendingSync: order.serverCreatedAt == null,
    clientCreatedAt: order.clientCreatedAt,
    occurredAt: effectiveMillis(order),
    sortSeq: localSeqOf(order.id),
  };
}

/** Stable ascending order: device clock first, then local sequence as tie-break. */
function compareSales(a: LocalSale, b: LocalSale): number {
  if (a.clientCreatedAt !== b.clientCreatedAt) {
    return a.clientCreatedAt - b.clientCreatedAt;
  }
  return a.sortSeq - b.sortSeq;
}

/**
 * Build the local ledger from a cache snapshot of `asyncOrders`: drop non-sales,
 * normalize, and return chronologically ordered. Input is not mutated.
 */
export function selectLocalLedger(orders: readonly AsyncOrder[]): LocalSale[] {
  return orders
    .filter(isLedgerSale)
    .map(toLocalSale)
    .sort(compareSales);
}
