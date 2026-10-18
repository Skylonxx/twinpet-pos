/**
 * Return/Refund V1 — client adapters for `getSaleReturnContext` /
 * `submitSaleReturn`. Never throw. Online-only (D-RET-11): when the device is
 * offline nothing is queued — a money-affecting Return is never written
 * locally. The approver PIN travels only in the callable payload.
 */

import type {
  SaleReturnClassification,
  SaleReturnContextView,
  SaleReturnErrorCode,
  SaleReturnRefundMethod,
} from './saleReturnTypes';
import { SALE_RETURN_ERROR_COPY } from './saleReturnTypes';

export type CallableTransport = (name: string, payload: unknown) => Promise<unknown>;

let cachedTransport: CallableTransport | null = null;

async function getDefaultTransport(): Promise<CallableTransport> {
  if (cachedTransport) return cachedTransport;
  const [{ getFunctions, httpsCallable, connectFunctionsEmulator }, { app, USE_EMULATOR }] = await Promise.all([
    import('firebase/functions'),
    import('../firebase'),
  ]);
  if (!app) throw new Error('Firebase not configured');
  const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);
  if (USE_EMULATOR) connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  cachedTransport = async (name, payload) => (await httpsCallable(functions, name)(payload)).data;
  return cachedTransport;
}

export function isDeviceOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isErrorCode(v: unknown): v is SaleReturnErrorCode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SALE_RETURN_ERROR_COPY, v);
}

export type SaleReturnContextResult =
  | { kind: 'ok'; classification: SaleReturnClassification; reason: string | null; context: SaleReturnContextView | null }
  | { kind: 'error'; code: SaleReturnErrorCode }
  | { kind: 'offline' }
  | { kind: 'unavailable' };

export async function fetchSaleReturnContext(
  orderId: string,
  branchId: string,
  transport?: CallableTransport,
): Promise<SaleReturnContextResult> {
  if (isDeviceOffline()) return { kind: 'offline' };
  try {
    const call = transport ?? (await getDefaultTransport());
    const raw = await call('getSaleReturnContext', { orderId, branchId });
    if (!isPlainObject(raw)) return { kind: 'unavailable' };
    if (raw.ok === true) {
      const c = raw.classification;
      if (c !== 'RETURN_ELIGIBLE' && c !== 'RETURN_NOT_ELIGIBLE' && c !== 'RETURN_UNSUPPORTED_EVIDENCE') {
        return { kind: 'unavailable' };
      }
      const context = isPlainObject(raw.context) ? (raw.context as unknown as SaleReturnContextView) : null;
      if (c === 'RETURN_ELIGIBLE' && (!context || !Array.isArray(context.lines))) return { kind: 'unavailable' };
      return { kind: 'ok', classification: c, reason: typeof raw.reason === 'string' ? raw.reason : null, context };
    }
    if (raw.ok === false && isErrorCode(raw.code)) return { kind: 'error', code: raw.code };
    return { kind: 'unavailable' };
  } catch {
    return isDeviceOffline() ? { kind: 'offline' } : { kind: 'unavailable' };
  }
}

export type SubmitSaleReturnInput = {
  attemptId: string;
  orderId: string;
  branchId: string;
  lines: { lineIndex: number; productId: string; qty: number }[];
  refundMethod: SaleReturnRefundMethod;
  refundReference: string;
  reason: string;
  note: string;
  expectedRefundAmount: number;
  shiftId: string | null;
  approverStaffId: string;
  pin: string;
};

export type SubmitSaleReturnResult =
  | {
      kind: 'ok';
      returnId: string;
      returnNo: string;
      refundId: string | null;
      refundAmount: number;
      refundMethod: SaleReturnRefundMethod;
      idempotent: boolean;
    }
  | { kind: 'error'; code: SaleReturnErrorCode }
  | { kind: 'offline' }
  /** Transport failure — the server may or may not have committed; retry the SAME attempt. */
  | { kind: 'unknown' };

export async function submitSaleReturnRequest(
  input: SubmitSaleReturnInput,
  transport?: CallableTransport,
): Promise<SubmitSaleReturnResult> {
  // Online-required: never queue a money-affecting Return locally.
  if (isDeviceOffline()) return { kind: 'offline' };
  try {
    const call = transport ?? (await getDefaultTransport());
    const raw = await call('submitSaleReturn', { ...input, shiftId: input.shiftId ?? '' });
    if (!isPlainObject(raw)) return { kind: 'unknown' };
    if (raw.ok === true) {
      if (typeof raw.returnId !== 'string' || typeof raw.returnNo !== 'string' || typeof raw.refundAmount !== 'number') {
        return { kind: 'unknown' };
      }
      return {
        kind: 'ok',
        returnId: raw.returnId,
        returnNo: raw.returnNo,
        refundId: typeof raw.refundId === 'string' ? raw.refundId : null,
        refundAmount: raw.refundAmount,
        refundMethod: raw.refundMethod as SaleReturnRefundMethod,
        idempotent: raw.idempotent === true,
      };
    }
    if (raw.ok === false && isErrorCode(raw.code)) return { kind: 'error', code: raw.code };
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

export function newReturnAttemptId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `ret-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * After a cash refund the server appended a pay-out to the shift's
 * `cashEntries[]`. Pull the shift from the server so the local cache (which
 * the POS boot read and drawer fold use) carries it. Best-effort; the POS
 * boot read is server-first anyway when online.
 */
export async function refreshShiftFromServer(shiftId: string): Promise<void> {
  try {
    const [{ doc, getDocFromServer }, { db, collections }] = await Promise.all([
      import('firebase/firestore'),
      import('../firebase'),
    ]);
    if (!db) return;
    await getDocFromServer(doc(db, collections.shifts, shiftId));
  } catch {
    /* best-effort cache refresh only */
  }
}
