/**
 * Pure view helpers for the Reconciliation Exceptions admin page. NO Firebase
 * imports → node-unit-testable (see exceptionRows.test.ts). The page/hook compose
 * these; React rendering itself is verified by a manual emulator smoke test.
 */

/** Mirror of the backend RECONCILE_RETRY_CAP (functions/src/retryReconcile.ts). */
export const RECONCILE_RETRY_CAP = 3;

export const V9_FAULT_LIMIT = 50;
export const V9_SCOPED_FANOUT_CAP = 10;

export type ExceptionKind = 'exception' | 'void_revision_fault';

export type FaultDisplay = 'revision_malformed' | 'revision_overflow' | 'unknown_fault';

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
  kinds: ExceptionKind[];
  faultDisplay: FaultDisplay | null;
  rawFault: string | null;
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

export function mapFaultDisplay(literal: unknown): FaultDisplay {
  if (literal === 'revision_malformed') return 'revision_malformed';
  if (literal === 'revision_overflow') return 'revision_overflow';
  return 'unknown_fault';
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
    lastReconcileError:
      typeof data.lastReconcileError === 'string'
        ? data.lastReconcileError
        : typeof data.reconcileError === 'string'
          ? data.reconcileError
          : '—',
    firstReconcileError: typeof data.reconcileError === 'string' ? data.reconcileError : '—',
    voidRequested: data.voidRequested === true,
    lastErrorAtMs: tsToMs(data.lastReconcileErrorAt) ?? tsToMs(data.firstFailedAt),
    kinds: ['exception'],
    faultDisplay: null,
    rawFault: null,
  };
}

/** Value-blind V9 mapper: timestamp presence is the visibility gate, not the literal set. */
export function mapV9FaultRow(id: string, data: Record<string, unknown>): ReconExceptionRow | null {
  if (!Object.prototype.hasOwnProperty.call(data, 'voidRevisionFaultAt')) return null;
  const raw = typeof data.voidRevisionFault === 'string' ? data.voidRevisionFault : String(data.voidRevisionFault ?? '');
  return {
    id,
    billId: typeof data.billId === 'string' ? data.billId : id,
    branchId: typeof data.branchId === 'string' ? data.branchId : '—',
    staffName: typeof data.staffName === 'string' ? data.staffName : '—',
    total: typeof data.total === 'number' ? data.total : 0,
    reconcileAttempts: typeof data.reconcileAttempts === 'number' ? data.reconcileAttempts : 0,
    adminRetryCount: typeof data.adminRetryCount === 'number' ? data.adminRetryCount : 0,
    lastReconcileError: raw || 'void_revision_fault',
    firstReconcileError: raw || 'void_revision_fault',
    voidRequested: data.voidRequested === true,
    lastErrorAtMs: tsToMs(data.voidRevisionFaultAt),
    kinds: ['void_revision_fault'],
    faultDisplay: mapFaultDisplay(data.voidRevisionFault),
    rawFault: raw,
  };
}

export function mergeExceptionRows(
  exceptionRows: readonly ReconExceptionRow[],
  v9Rows: readonly ReconExceptionRow[],
): ReconExceptionRow[] {
  const byId = new Map<string, ReconExceptionRow>();
  for (const row of exceptionRows) byId.set(row.id, { ...row, kinds: [...row.kinds] });
  for (const row of v9Rows) {
    const prev = byId.get(row.id);
    if (!prev) {
      byId.set(row.id, { ...row, kinds: [...row.kinds] });
      continue;
    }
    const kinds = Array.from(new Set([...prev.kinds, ...row.kinds]));
    byId.set(row.id, {
      ...prev,
      kinds,
      faultDisplay: prev.faultDisplay ?? row.faultDisplay,
      rawFault: prev.rawFault ?? row.rawFault,
      lastErrorAtMs: Math.max(prev.lastErrorAtMs ?? 0, row.lastErrorAtMs ?? 0) || prev.lastErrorAtMs,
    });
  }
  return [...byId.values()].sort((a, b) => (b.lastErrorAtMs ?? 0) - (a.lastErrorAtMs ?? 0));
}

export function isV9Only(row: Pick<ReconExceptionRow, 'kinds'>): boolean {
  return row.kinds.length === 1 && row.kinds[0] === 'void_revision_fault';
}

/**
 * Why a Retry button is disabled, or null if it's allowed. Mirrors the server
 * guards (cap, voidRequested) so the UI never offers an action the callable will
 * reject; `inFlight` blocks double-clicks. V9-only rows never retry.
 */
export function retryDisableReason(
  row: Pick<ReconExceptionRow, 'reconcileAttempts' | 'voidRequested' | 'kinds'>,
  inFlight: boolean,
): string | null {
  if (row.kinds && isV9Only(row)) return 'revision fault — ไม่มีปุ่มรีทราย';
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
