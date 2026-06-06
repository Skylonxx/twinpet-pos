/**
 * retryReconcile — admin-only, idempotent re-arm of a FAILED reconciliation.
 * [Phase 2 Track B, Step 1 — backend safety only; no Admin UI in this step]
 *
 * Manual Admin Repair Flow is a SAFETY NET, not daily operational work — see
 * docs/reports/phase-2-track-b-proposal.md. This re-arms an `exception` async
 * order back to `pending_reconcile`; the existing `reconcileOrder` trigger then
 * runs the guarded `reconcileSale`. We NEVER call `reconcileSale` directly here.
 *
 * Idempotency / double-deduction safety:
 *  - `reconcileSale` settles in ONE transaction (all-or-nothing), so an
 *    `exception` means NOTHING was committed → re-running cannot double-deduct.
 *  - Re-arm runs in a transaction and only acts when status is `exception`.
 *  - An already-`settled` order is a safe no-op (never re-settled).
 *  - The retry CAP bounds runaway retries (manual investigation past the cap).
 *  - A `voidRequested` order is NEVER re-armed to reconcile — the void path owns
 *    it (the trigger routes `voidRequested` → handleVoidIntent first).
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';

/** Max TOTAL settlement attempts (automatic + admin retries) before manual investigation. */
export const RECONCILE_RETRY_CAP = 3;

type AuthLike = { uid?: string; token?: Record<string, unknown> } | null | undefined;

export type RetryResult =
  | { status: 're-armed'; attempts: number }
  | { status: 'noop_already_settled' };

/**
 * Core re-arm logic — EXTRACTED + EXPORTED so it is unit-tested without the
 * Functions runtime (see retryReconcile.test.ts). Throws HttpsError on any
 * disallowed request; returns the outcome on success/no-op.
 */
export async function performReconcileRetry(
  database: Firestore,
  orderId: string,
  auth: AuthLike,
): Promise<RetryResult> {
  if (!auth) throw new HttpsError('unauthenticated', 'ต้องเข้าสู่ระบบก่อน');
  if (auth.token?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'เฉพาะผู้ดูแลระบบ (admin) เท่านั้นที่รีทรายได้');
  }
  const id = String(orderId ?? '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'ต้องระบุ orderId');

  const ref = database.collection('asyncOrders').doc(id);

  return database.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', `ไม่พบ asyncOrders/${id}`);
    const o = snap.data() as Record<string, unknown>;

    // Already settled → safe, idempotent no-op (never re-settle).
    if (o.reconcileStatus === 'settled') return { status: 'noop_already_settled' };

    // Only a genuine failure may be retried.
    if (o.reconcileStatus !== 'exception') {
      throw new HttpsError('failed-precondition', 'รีทรายได้เฉพาะรายการที่สถานะ exception');
    }

    // voidRequested + exception: do NOT re-arm to reconcile. The void path owns
    // this order (the trigger routes voidRequested → handleVoidIntent first);
    // re-arming would risk settling a sale the user asked to void.
    if (o.voidRequested === true) {
      throw new HttpsError(
        'failed-precondition',
        'รายการนี้ถูกขอยกเลิก (void) — ต้องจัดการผ่านเส้นทาง void ไม่ใช่การรีทรายการกระทบยอด',
      );
    }

    const attempts = typeof o.reconcileAttempts === 'number' ? o.reconcileAttempts : 0;
    if (attempts >= RECONCILE_RETRY_CAP) {
      throw new HttpsError(
        'resource-exhausted',
        `เกินจำนวนครั้งสูงสุด (${RECONCILE_RETRY_CAP}) — ต้องตรวจสอบด้วยตนเอง`,
      );
    }

    // Re-arm ONLY: flip status so the existing trigger re-runs the guarded settle.
    // Audit: count admin-requested retries distinctly + record who/when.
    tx.set(
      ref,
      {
        reconcileStatus: 'pending_reconcile',
        adminRetryCount: FieldValue.increment(1),
        lastRetryBy: (auth.token?.staffId as string | undefined) ?? auth.uid ?? null,
        lastRetryAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return { status: 're-armed', attempts };
  });
}

export const retryReconcile = onCall(
  {
    region: FUNCTIONS_REGION,
    cors: [/^https?:\/\/localhost:\d+$/, /^https:\/\/.*\.firebaseapp\.com$/, /^https:\/\/.*\.web\.app$/],
  },
  async (request) => {
    const orderId = (request.data as { orderId?: string } | undefined)?.orderId ?? '';
    const result = await performReconcileRetry(db, orderId, request.auth as AuthLike);
    return { success: true, ...result };
  },
);
