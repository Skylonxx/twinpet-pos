import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../lib/hooks/useAuth';
import { canViewReconciliationExceptions } from '../../lib/reconciliation/adminGate';
import { useReconciliationExceptions } from '../../lib/reconciliation/useReconciliationExceptions';
import { callRetryReconcile } from '../../lib/reconciliation/retryReconcile';
import { mapRetryError, retryDisableReason } from '../../lib/reconciliation/exceptionRows';
import './ReconciliationExceptionsPage.css';

/**
 * Track B Step 2 — Reconciliation Exceptions admin page (ROUTE-ONLY).
 * Reached by direct URL `/admin/reconciliation-exceptions` only — no dashboard
 * card, no nav link. Read-only Firestore subscription + the secured
 * `retryReconcile` callable. Plain CSS (no Flowbite) so it stays orthogonal to
 * the stash@{0} Flowbite migration.
 */
export default function ReconciliationExceptionsPage() {
  const { user } = useAuth();
  // Admin gate FIRST. `isAdmin` drives the query's `enabled` flag, so a non-admin
  // never starts the Firestore exception subscription (the security boundary —
  // we do NOT rely on AdminLayout for enforcement).
  const isAdmin = canViewReconciliationExceptions(user?.role);
  const { rows, loading, error } = useReconciliationExceptions(isAdmin);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const onRetry = useCallback(async (orderId: string) => {
    if (!window.confirm(`รีทรายการกระทบยอดของบิล ${orderId}?`)) return;
    setBusyId(orderId);
    try {
      await callRetryReconcile(orderId);
      setToast(`ส่งคำขอรีทราย ${orderId} แล้ว — ระบบกำลังประมวลผลใหม่`);
    } catch (err) {
      const code = (err as { code?: string }).code?.replace(/^functions\//, '');
      setToast(mapRetryError(code));
    } finally {
      setBusyId(null);
    }
  }, []);

  // Degrade SAFELY for any non-admin who reaches the direct URL (independent of
  // the AdminLayout gate) — never crash, never show cross-branch data. The query
  // above was already gated off (enabled=false), so nothing was read.
  if (!isAdmin) {
    return (
      <div className="recex-page">
        <div className="recex-empty">เฉพาะผู้ดูแลระบบ (admin) เท่านั้นที่เข้าถึงหน้านี้ได้</div>
      </div>
    );
  }

  return (
    <div className="recex-page">
      <header className="recex-topbar">
        <div>
          <div className="recex-title">รายการกระทบยอดค้าง (Reconciliation Exceptions)</div>
          <div className="recex-sub">การซ่อมแซมด้วยตนเอง — ใช้เมื่อจำเป็นเท่านั้น</div>
        </div>
        <span className="recex-count">{loading ? '…' : `${rows.length} รายการ`}</span>
      </header>

      {error ? (
        <div className="recex-error">โหลดข้อมูลไม่สำเร็จ: {error}</div>
      ) : loading ? (
        <div className="recex-empty">กำลังโหลด...</div>
      ) : rows.length === 0 ? (
        <div className="recex-empty">ไม่มีรายการกระทบยอดค้าง 🎉</div>
      ) : (
        <div className="recex-table-wrap">
          <table className="recex-table">
            <thead>
              <tr>
                <th>บิล</th>
                <th>สาขา</th>
                <th>พนักงาน</th>
                <th className="recex-right">ยอด</th>
                <th className="recex-right">ครั้ง</th>
                <th>ข้อผิดพลาดล่าสุด</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const disabled = retryDisableReason(r, busyId === r.id);
                return (
                  <tr key={r.id}>
                    <td className="recex-mono">{r.billId}</td>
                    <td>{r.branchId}</td>
                    <td>{r.staffName}</td>
                    <td className="recex-right">{r.total.toLocaleString('th-TH')}</td>
                    <td className="recex-right">
                      {r.reconcileAttempts}
                      {r.voidRequested ? <span className="recex-badge">void</span> : null}
                    </td>
                    <td className="recex-err" title={r.lastReconcileError}>{r.lastReconcileError}</td>
                    <td className="recex-right">
                      <button
                        type="button"
                        className="recex-retry-btn"
                        disabled={disabled !== null}
                        title={disabled ?? 'รีทราย'}
                        onClick={() => void onRetry(r.id)}
                      >
                        {busyId === r.id ? '...' : 'รีทราย'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {toast ? <div className="recex-toast" role="status">{toast}</div> : null}
    </div>
  );
}
