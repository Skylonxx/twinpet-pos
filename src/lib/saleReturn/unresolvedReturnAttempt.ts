/**
 * Return/Refund V1 — durable recovery identity for an UNRESOLVED online Return
 * attempt (D-RET-FIX-7).
 *
 * A Return attempt whose transport outcome is unknown is a money/stock
 * operation identity: if the server committed but the response was lost,
 * minting a NEW attempt for the same physical items could restore stock and
 * refund twice. So the exact attempt is persisted (before it is sent) and
 * survives closing/reopening the modal or reloading the app; while it exists
 * the UI offers only resolve / retry of THAT attempt.
 *
 * This is NOT an offline Return queue — nothing here is ever executed
 * locally. It stores only non-secret identity/payload fields: never the PIN,
 * a Firebase token, OAC/private keys or credential hashes.
 */

import type { SaleReturnRefundMethod } from './saleReturnTypes';

export const UNRESOLVED_RETURN_STATE = 'UNKNOWN_PENDING_RESOLUTION' as const;

export type UnresolvedReturnAttempt = {
  schemaVersion: 1;
  state: typeof UNRESOLVED_RETURN_STATE;
  attemptId: string;
  orderId: string;
  branchId: string;
  requesterStaffId: string;
  lines: { lineIndex: number; productId: string; qty: number }[];
  refundMethod: SaleReturnRefundMethod;
  refundReference: string;
  reason: string;
  note: string;
  expectedRefundAmount: number;
  shiftId: string | null;
  approverStaffId: string;
  approverDisplayName: string;
  recordedAtMs: number;
};

/** The non-secret payload of one attempt (the callable input minus the PIN). */
export type ReturnAttemptPayload = Pick<
  UnresolvedReturnAttempt,
  | 'attemptId'
  | 'orderId'
  | 'branchId'
  | 'lines'
  | 'refundMethod'
  | 'refundReference'
  | 'reason'
  | 'note'
  | 'expectedRefundAmount'
  | 'shiftId'
  | 'approverStaffId'
>;

export interface AttemptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY_PREFIX = 'twinpet.saleReturn.unresolved.v1';
const REFUND_METHODS: readonly SaleReturnRefundMethod[] = ['cash', 'qr', 'kbank', 'card', 'none'];

export function unresolvedAttemptKey(branchId: string, orderId: string): string {
  return `${KEY_PREFIX}:${branchId}:${orderId}`;
}

function defaultStorage(): AttemptStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function parseRecord(raw: unknown, branchId: string, orderId: string): UnresolvedReturnAttempt | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1 || r.state !== UNRESOLVED_RETURN_STATE) return null;
  if (r.branchId !== branchId || r.orderId !== orderId) return null;
  if (!isStr(r.attemptId) || !r.attemptId || !isStr(r.requesterStaffId) || !isStr(r.approverStaffId)) return null;
  if (!isStr(r.refundReference) || !isStr(r.reason) || !isStr(r.note) || !isStr(r.approverDisplayName)) return null;
  if (!REFUND_METHODS.includes(r.refundMethod as SaleReturnRefundMethod)) return null;
  if (typeof r.expectedRefundAmount !== 'number' || !Number.isFinite(r.expectedRefundAmount)) return null;
  if (r.shiftId !== null && !isStr(r.shiftId)) return null;
  if (typeof r.recordedAtMs !== 'number') return null;
  if (!Array.isArray(r.lines) || r.lines.length === 0) return null;
  const lines: UnresolvedReturnAttempt['lines'] = [];
  for (const l of r.lines as unknown[]) {
    if (l === null || typeof l !== 'object') return null;
    const line = l as Record<string, unknown>;
    if (typeof line.lineIndex !== 'number' || !isStr(line.productId) || typeof line.qty !== 'number') return null;
    lines.push({ lineIndex: line.lineIndex, productId: line.productId, qty: line.qty });
  }
  return {
    schemaVersion: 1,
    state: UNRESOLVED_RETURN_STATE,
    attemptId: r.attemptId,
    orderId,
    branchId,
    requesterStaffId: r.requesterStaffId,
    lines,
    refundMethod: r.refundMethod as SaleReturnRefundMethod,
    refundReference: r.refundReference,
    reason: r.reason,
    note: r.note,
    expectedRefundAmount: r.expectedRefundAmount,
    shiftId: (r.shiftId as string | null) ?? null,
    approverStaffId: r.approverStaffId,
    approverDisplayName: r.approverDisplayName,
    recordedAtMs: r.recordedAtMs,
  };
}

/** `undefined` = storage unreadable (callers must fail closed: no new attempt). */
export function readUnresolvedReturnAttempt(
  branchId: string,
  orderId: string,
  storage: AttemptStorage | null = defaultStorage(),
): UnresolvedReturnAttempt | null | undefined {
  if (!storage) return undefined;
  let text: string | null;
  try {
    text = storage.getItem(unresolvedAttemptKey(branchId, orderId));
  } catch {
    return undefined;
  }
  if (text == null) return null;
  try {
    // A present-but-unreadable record still means "something unresolved".
    return parseRecord(JSON.parse(text), branchId, orderId) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the exact attempt BEFORE it is sent. Builds the record field by
 * field from the payload, so a PIN (or anything else) passed alongside can
 * never be stored. Returns false when it cannot be persisted — the caller
 * must then NOT send the attempt.
 */
export function saveUnresolvedReturnAttempt(
  payload: ReturnAttemptPayload,
  meta: { requesterStaffId: string; approverDisplayName: string; nowMs?: number },
  storage: AttemptStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  const record: UnresolvedReturnAttempt = {
    schemaVersion: 1,
    state: UNRESOLVED_RETURN_STATE,
    attemptId: payload.attemptId,
    orderId: payload.orderId,
    branchId: payload.branchId,
    requesterStaffId: meta.requesterStaffId,
    lines: payload.lines.map((l) => ({ lineIndex: l.lineIndex, productId: l.productId, qty: l.qty })),
    refundMethod: payload.refundMethod,
    refundReference: payload.refundReference,
    reason: payload.reason,
    note: payload.note,
    expectedRefundAmount: payload.expectedRefundAmount,
    shiftId: payload.shiftId,
    approverStaffId: payload.approverStaffId,
    approverDisplayName: meta.approverDisplayName,
    recordedAtMs: meta.nowMs ?? Date.now(),
  };
  try {
    storage.setItem(unresolvedAttemptKey(payload.branchId, payload.orderId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** Only after a definitive outcome of THIS attempt (committed, or fenced not-committed). */
export function clearUnresolvedReturnAttempt(
  branchId: string,
  orderId: string,
  storage: AttemptStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(unresolvedAttemptKey(branchId, orderId));
  } catch {
    /* best-effort; a stale record only forces one more PIN-less resolve */
  }
}

export function payloadFromUnresolved(rec: UnresolvedReturnAttempt): ReturnAttemptPayload {
  return {
    attemptId: rec.attemptId,
    orderId: rec.orderId,
    branchId: rec.branchId,
    lines: rec.lines,
    refundMethod: rec.refundMethod,
    refundReference: rec.refundReference,
    reason: rec.reason,
    note: rec.note,
    expectedRefundAmount: rec.expectedRefundAmount,
    shiftId: rec.shiftId,
    approverStaffId: rec.approverStaffId,
  };
}
