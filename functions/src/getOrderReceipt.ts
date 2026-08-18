import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { Firestore } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import { evaluateReceiptCore, type ReceiptCoreResult, type ReceiptSnapshots } from './getOrderReceiptCore';

type AuthLike = { uid?: string; token?: Record<string, unknown> } | null | undefined;

function callerBranchIds(auth: AuthLike): string[] | null {
  if (!auth) return null;
  const raw = auth.token?.branchIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}

export function authorizeReceiptAccess(auth: AuthLike, orderBranchId: string): void {
  if (!auth) throw new HttpsError('unauthenticated', 'ต้องเข้าสู่ระบบก่อน');
  const ids = callerBranchIds(auth);
  if (ids == null) throw new HttpsError('unauthenticated', 'ต้องเข้าสู่ระบบก่อน');
  if (ids.length === 0) throw new HttpsError('permission-denied', 'ไม่พบสิทธิ์สาขา');
  if (ids.includes('ALL')) return;
  if (!ids.includes(orderBranchId)) {
    throw new HttpsError('permission-denied', 'ไม่มีสิทธิ์เข้าถึงสาขานี้');
  }
}

export async function performGetOrderReceipt(
  database: Firestore,
  rawRequest: unknown,
  auth: AuthLike,
): Promise<ReceiptCoreResult> {
  if (!auth) throw new HttpsError('unauthenticated', 'ต้องเข้าสู่ระบบก่อน');
  if (rawRequest == null || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
    throw new HttpsError('invalid-argument', 'คำขอไม่ถูกต้อง');
  }
  const orderId = typeof (rawRequest as { orderId?: unknown }).orderId === 'string'
    ? (rawRequest as { orderId: string }).orderId.trim()
    : '';
  if (!orderId) throw new HttpsError('invalid-argument', 'ต้องระบุ orderId');

  return database.runTransaction(async (tx) => {
    const orderRef = database.collection('orders').doc(orderId);
    const asyncRef = database.collection('asyncOrders').doc(orderId);
    const itemsSnap = await tx.get(orderRef.collection('orderItems'));
    const orderSnap = await tx.get(orderRef);
    const asyncSnap = await tx.get(asyncRef);
    const paymentsSnap = await tx.get(
      database.collection('payments').where('orderId', '==', orderId),
    );

    const order = orderSnap.exists ? (orderSnap.data() as Record<string, unknown>) : null;
    if (orderSnap.exists) {
      const branchId = typeof order?.branchId === 'string' ? order.branchId : '';
      authorizeReceiptAccess(auth, branchId);
    } else {
      const ids = callerBranchIds(auth) ?? [];
      if (ids.length === 0 && !ids.includes('ALL')) {
        throw new HttpsError('permission-denied', 'ไม่พบสิทธิ์สาขา');
      }
    }

    const snaps: ReceiptSnapshots = {
      order,
      orderExists: orderSnap.exists,
      items: itemsSnap.docs.map((d) => ({ ...(d.data() as Record<string, unknown>), id: d.id })),
      payments: paymentsSnap.docs.map((d) => ({ ...(d.data() as Record<string, unknown>), id: d.id })),
      asyncOrder: asyncSnap.exists ? (asyncSnap.data() as Record<string, unknown>) : null,
      asyncExists: asyncSnap.exists,
    };
    return evaluateReceiptCore(snaps);
  });
}

export const getOrderReceipt = onCall({ region: FUNCTIONS_REGION }, async (request) => {
  try {
    return await performGetOrderReceipt(db, request.data, request.auth ?? null);
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error('[getOrderReceipt] internal', err);
    throw new HttpsError('internal', 'ไม่สามารถออกใบเสร็จได้');
  }
});
