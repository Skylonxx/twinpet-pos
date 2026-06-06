/**
 * Pure view helpers for the Reconciliation Exceptions admin page. NO Firebase
 * imports → node-unit-testable (see exceptionRows.test.ts). The page/hook compose
 * these; React rendering itself is verified by a manual emulator smoke test.
 */

/** Mirror of the backend RECONCILE_RETRY_CAP (functions/src/retryReconcile.ts). */
export const RECONCILE_RETRY_CAP = 3;

/** One row in the exceptions list — only admin-safe, already-sanitized fields. */
export type ReconExceptionRow = {
  id: string;
  billId: string;
  branchId: string;
  staffName: string;
  total: number;
  reconcileAttempts: number;
  adminRetryCount: number;
  lastReconcileError: string;
  firstReconcileError: string;
  voidRequested: boolean;
  /** Epoch ms (or null) for display ordering — derived from Firestore Timestamps. */
  lastErrorAtMs: number | null;
};

function tsToMs(v: unknown): number | null {
  if (v && typeof v === 'object' && 'toMillis' in (v as Record<string, unknown>)) {
    try {
      return (v as { toMillis: () => number }).toMillis();
    } catch {
      return null;
    }
  }
  if (typeof v === 'number') return v;
  return null;
}

/** Map a raw `asyncOrders` exception doc to a safe view row. */
export function mapExceptionRow(id: string, data: Record<string, unknown>): ReconExceptionRow {
  return {
    id,
    billId: typeof data.billId === 'string' ? data.billId : id,
    branchId: typeof data.branchId === 'string' ? data.branchId : '—',
    staffName: typeof data.staffName === 'string' ? data.staffName : '—',
    total: typeof data.total === 'number' ? data.total : 0,
    reconcileAttempts: typeof data.reconcileAttempts === 'number' ? data.reconcileAttempts : 0,
    adminRetryCount: typeof data.adminRetryCount === 'number' ? data.adminRetryCount : 0,
    // These are already SANITIZED strings written by the server — surface as-is.
    lastReconcileError:
      typeof data.lastReconcileError === 'string'
        ? data.lastReconcileError
        : typeof data.reconcileError === 'string'
          ? data.reconcileError
          : '—',
    firstReconcileError: typeof data.reconcileError === 'string' ? data.reconcileError : '—',
    voidRequested: data.voidRequested === true,
    lastErrorAtMs: tsToMs(data.lastReconcileErrorAt) ?? tsToMs(data.firstFailedAt),
  };
}

/**
 * Why a Retry button is disabled, or null if it's allowed. Mirrors the server
 * guards (cap, voidRequested) so the UI never offers an action the callable will
 * reject; `inFlight` blocks double-clicks.
 */
export function retryDisableReason(
  row: Pick<ReconExceptionRow, 'reconcileAttempts' | 'voidRequested'>,
  inFlight: boolean,
): string | null {
  if (inFlight) return 'กำลังดำเนินการ...';
  if (row.voidRequested) return 'รายการนี้ขอยกเลิก (void) — จัดการผ่านเส้นทาง void';
  if (row.reconcileAttempts >= RECONCILE_RETRY_CAP) return 'เกินจำนวนครั้งสูงสุด — ต้องตรวจสอบด้วยตนเอง';
  return null;
}

/** Map an HttpsError code from retryReconcile to an admin-facing message. */
export function mapRetryError(code: string | undefined): string {
  switch (code) {
    case 'permission-denied':
      return 'ไม่มีสิทธิ์ (เฉพาะ admin)';
    case 'failed-precondition':
      return 'รีทรายไม่ได้ (สถานะไม่ใช่ exception หรือเป็นรายการ void)';
    case 'resource-exhausted':
      return 'เกินจำนวนครั้งสูงสุด — ต้องตรวจสอบด้วยตนเอง';
    case 'not-found':
      return 'ไม่พบรายการ (อาจถูกเคลียร์แล้ว)';
    case 'unauthenticated':
      return 'กรุณาเข้าสู่ระบบใหม่';
    default:
      return 'รีทรายไม่สำเร็จ กรุณาลองใหม่';
  }
}
