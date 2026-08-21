import { Timestamp } from 'firebase/firestore';
import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import { app, isFirebaseConfigured, USE_EMULATOR } from '../firebase';
import type { ReceiptAuthority, ReceiptAuthorityReason } from './receiptAuthority';

export type ReceiptEnvelope = {
  authority: ReceiptAuthority;
  reason: ReceiptAuthorityReason;
  order: Record<string, unknown> | null;
  items: Record<string, unknown>[];
  payments: Record<string, unknown>[];
};

export type ReceiptFetchResult =
  | { ok: true; envelope: ReceiptEnvelope }
  | { ok: false; reason: 'callable_failed' | 'not_configured' | 'malformed_receipt_payload'; envelope: null };

type TimestampLike = { toDate: () => Date };

type TimestampNorm =
  | { kind: 'ok'; value: Timestamp | TimestampLike }
  | { kind: 'null' }
  | { kind: 'unrecognized' };

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

function isTimestampLike(value: unknown): value is TimestampLike {
  return typeof value === 'object' && value !== null && typeof (value as { toDate?: unknown }).toDate === 'function';
}

function timestampFromParts(seconds: unknown, nanoseconds: unknown): Timestamp | null {
  if (!isFiniteInteger(seconds) || !isFiniteInteger(nanoseconds)) return null;
  try {
    return new Timestamp(seconds, nanoseconds);
  } catch {
    return null;
  }
}

function normalizeOrderTimestamp(value: unknown): TimestampNorm {
  if (value === null) return { kind: 'null' };
  if (isTimestampLike(value)) return { kind: 'ok', value };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { kind: 'unrecognized' };
    try {
      return { kind: 'ok', value: Timestamp.fromDate(value) };
    } catch {
      return { kind: 'unrecognized' };
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    if ('_seconds' in rec || '_nanoseconds' in rec) {
      const ts = timestampFromParts(rec._seconds, rec._nanoseconds);
      return ts ? { kind: 'ok', value: ts } : { kind: 'unrecognized' };
    }
    if ('seconds' in rec || 'nanoseconds' in rec) {
      const ts = timestampFromParts(rec.seconds, rec.nanoseconds);
      return ts ? { kind: 'ok', value: ts } : { kind: 'unrecognized' };
    }
  }
  return { kind: 'unrecognized' };
}

function normalizeReceiptOrder(
  order: Record<string, unknown>,
): { ok: true; order: Record<string, unknown> } | { ok: false } {
  const created = normalizeOrderTimestamp(order.createdAt);
  if (created.kind !== 'ok') return { ok: false };

  const next: Record<string, unknown> = { ...order, createdAt: created.value };

  const updated = normalizeOrderTimestamp(order.updatedAt);
  if (updated.kind === 'ok') next.updatedAt = updated.value;

  const voided = normalizeOrderTimestamp(order.voidedAt);
  if (voided.kind === 'ok') next.voidedAt = voided.value;
  else if (voided.kind === 'null') next.voidedAt = null;

  return { ok: true, order: next };
}

function normalizeReceiptEnvelope(envelope: ReceiptEnvelope): ReceiptFetchResult {
  if (envelope.order === null) {
    return { ok: true, envelope };
  }
  if (typeof envelope.order !== 'object' || Array.isArray(envelope.order)) {
    return { ok: false, reason: 'malformed_receipt_payload', envelope: null };
  }
  const normalized = normalizeReceiptOrder(envelope.order);
  if (!normalized.ok) {
    return { ok: false, reason: 'malformed_receipt_payload', envelope: null };
  }
  return {
    ok: true,
    envelope: {
      ...envelope,
      order: normalized.order,
    },
  };
}

export async function fetchOrderReceipt(orderId: string): Promise<ReceiptFetchResult> {
  if (!isFirebaseConfigured || !app) {
    return { ok: false, reason: 'not_configured', envelope: null };
  }
  try {
    const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);
    if (USE_EMULATOR) {
      connectFunctionsEmulator(functions, '127.0.0.1', 5001);
    }
    const callable = httpsCallable<{ orderId: string }, ReceiptEnvelope>(functions, 'getOrderReceipt');
    const res = await callable({ orderId });
    return normalizeReceiptEnvelope(res.data);
  } catch {
    return { ok: false, reason: 'callable_failed', envelope: null };
  }
}
