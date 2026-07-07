import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../firebase';
import { roundMoney } from '../money';
import type { AsyncOrder, AsyncOrderLine, AsyncPayment } from '../types';
import { RETAIL_PRICE_LEVEL_ID } from '../types';
import { formatOfflineReceiptNumber } from './billId';
import { getLineTotal } from './cartUtils';
import {
  allocateLocalSeq,
  getDeviceId,
  getDeviceLabel,
  getReceiptDeviceSegment,
  makeAsyncOrderId,
  nextLocalSeq,
} from './deviceId';
import type { SaleIntentObserver } from './offline/saleIntentObserver';
import type { CartLine, CartTotals, PaymentSplit } from './types';

/**
 * Offline-first checkout: build a self-contained `AsyncOrder` "intent" on the
 * client and write it with a SINGLE queueable `setDoc`. No transaction, no
 * server reads — so it commits to `persistentLocalCache` instantly (online or
 * offline) and flushes on reconnect, where the `reconcileOrder` Cloud Function
 * settles it (FIFO/stock/credit/shift). Replaces the old synchronous
 * `completePosSale` transaction that failed when offline.
 */

export type SubmitAsyncOrderInput = {
  branchId: string;
  staffId: string;
  staffName: string;
  shiftId: string;
  lines: CartLine[];
  totals: CartTotals;
  billDiscount: number;
  fee: number;
  payments: PaymentSplit[];
  customerId: string | null;
  customerName: string | null;
  priceLevelId?: string;
};

export type SubmitAsyncOrderResult = { orderId: string; billId: string };

/** Optional injected sidecar; absent = current fallback (log-only) behavior. */
export type SubmitAsyncOrderDeps = {
  observer?: SaleIntentObserver;
  /** Pre-allocated identity (3B-3). Absent = legacy inline allocation, unchanged. */
  identity?: OrderIdentity;
};

function buildLine(line: CartLine): AsyncOrderLine {
  const qtyBase = line.qty * line.unitFactor;
  const lineTotal = getLineTotal(line);
  return {
    productId: line.productId,
    productSnap: {
      name: line.productName,
      sku: line.sku,
      category: line.category,
      barcode: line.barcode ?? null,
    },
    unit: line.unit,
    unitFactor: line.unitFactor,
    qty: line.qty,
    qtyBase,
    unitPrice: line.unitPrice,
    originalPrice: line.originalPrice ?? line.unitPrice,
    discountAmt: roundMoney(line.unitPrice * line.qty - lineTotal),
    lineTotal,
    // fifoCost / lotRefs are assigned by the server-side reconciler.
  };
}

export type OrderIdentity = {
  deviceId: string;
  deviceLabel: string;
  seq: number;
  /** Pre-formatted, label-aware receipt number (computed by the caller). */
  billId: string;
};

/** Construct the full AsyncOrder document (pure — no I/O). Exported for tests. */
export function buildAsyncOrder(
  input: SubmitAsyncOrderInput,
  ident: OrderIdentity,
): AsyncOrder {
  const grandTotal = roundMoney(input.totals.grandTotal);
  const paidAmt = roundMoney(input.payments.reduce((s, p) => s + p.amount, 0));
  const creditAmt = roundMoney(
    input.payments.filter((p) => p.method === 'credit').reduce((s, p) => s + p.amount, 0),
  );
  const discountAmt = roundMoney(
    input.lines.reduce((s, l) => s + (l.unitPrice * l.qty - getLineTotal(l)), 0),
  );
  const payments: AsyncPayment[] = input.payments
    .filter((p) => p.amount > 0)
    .map((p) => ({ method: p.method, amount: p.amount, ref: null }));

  return {
    id: makeAsyncOrderId(ident.deviceId, ident.seq),
    billId: ident.billId,
    deviceId: ident.deviceId,
    deviceLabel: ident.deviceLabel,
    branchId: input.branchId,
    shiftId: input.shiftId,
    staffId: input.staffId,
    staffName: input.staffName,
    customerId: input.customerId,
    customerSnap: input.customerName
      ? { name: input.customerName, phone: '', taxId: null }
      : null,
    priceLevelId: input.priceLevelId ?? RETAIL_PRICE_LEVEL_ID,
    lines: input.lines.map(buildLine),
    payments,
    subtotal: roundMoney(input.totals.subtotal),
    discountAmt,
    billDiscount: roundMoney(input.billDiscount),
    fee: roundMoney(input.fee),
    vatRate: 0,
    vatAmt: 0,
    total: grandTotal,
    paidAmt,
    changeAmt: roundMoney(Math.max(0, paidAmt - grandTotal)),
    creditAmt,
    status: creditAmt > 0 && paidAmt < grandTotal ? 'pending_payment' : 'completed',
    reconcileStatus: 'pending_reconcile',
    reconciledAt: null,
    note: '',
    printCount: 0,
    clientCreatedAt: Date.now(),
    // Server resolves these on flush; null in the local cache until then.
    serverCreatedAt: serverTimestamp() as never,
    updatedAt: serverTimestamp() as never,
  };
}

/**
 * Pre-allocate the full order identity via the atomic cross-tab allocator
 * (Packet 3B-3). Composition is identical to the legacy inline path — same
 * formatter, same segment, same shape — so billId/orderId are unaffected.
 * Sync fields are read before the async allocation so a failure there can
 * never consume a sequence. `allocateLocalSeq()` is bounded fail-open, so this
 * never throws beyond what the legacy inline composition already could.
 */
export async function allocateOrderIdentity(): Promise<OrderIdentity> {
  const deviceId = getDeviceId();
  const deviceLabel = getDeviceLabel();
  const deviceSegment = getReceiptDeviceSegment();
  const seq = await allocateLocalSeq();
  const billId = formatOfflineReceiptNumber(deviceSegment, seq);
  return { deviceId, deviceLabel, seq, billId };
}

/**
 * Submit a sale. Returns SYNCHRONOUSLY with the (client-authoritative) receipt
 * number. The Firestore write is fire-and-forget: its promise resolves on server
 * ack when online and stays pending — but durably queued — when offline, so we
 * must NOT await it or the cashier would be blocked during an outage.
 */
export function submitAsyncOrder(
  input: SubmitAsyncOrderInput,
  deps?: SubmitAsyncOrderDeps,
): SubmitAsyncOrderResult {
  // Pre-allocated identity (3B-3) is used verbatim — never re-allocate a
  // sequence here. Absent = legacy inline allocation, unchanged.
  const ident: OrderIdentity =
    deps?.identity ??
    (() => {
      const deviceId = getDeviceId();
      const seq = nextLocalSeq();
      // Receipt segment prefers the admin label ("iPad-01" → "IPAD01"); the doc id
      // still uses the raw device id, so uniqueness holds even if labels clash.
      const billId = formatOfflineReceiptNumber(getReceiptDeviceSegment(), seq);
      return { deviceId, deviceLabel: getDeviceLabel(), seq, billId };
    })();
  const order = buildAsyncOrder(input, ident);

  if (isFirebaseConfigured && db) {
    // RAW promise — captured before any .catch so an injected observer can still
    // classify a terminal rules rejection (permission-denied) vs offline-pending.
    const writePromise = setDoc(doc(db, 'asyncOrders', order.id), order);
    if (deps?.observer) {
      deps.observer.observe(order, writePromise);
    } else {
      // Fallback ONLY when no observer is present — current behavior, unchanged.
      void writePromise.catch((err) => {
        // Offline → resolves later on reconnect; this only logs a transient/late ack.
        console.warn('[asyncCheckout] order write not yet acked (queued, will retry)', err);
      });
    }
  }

  return { orderId: order.id, billId: order.billId };
}
