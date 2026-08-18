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
  | { ok: false; reason: 'callable_failed' | 'not_configured'; envelope: null };

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
    return { ok: true, envelope: res.data };
  } catch {
    return { ok: false, reason: 'callable_failed', envelope: null };
  }
}
