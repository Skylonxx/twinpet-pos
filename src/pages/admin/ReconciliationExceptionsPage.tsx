import { useCallback, useEffect, useState } from 'react';
import { Table, TableHead, TableHeadCell, TableBody, TableRow, TableCell, Button, Badge, Alert, Spinner, Card } from 'flowbite-react';
import { useAuth } from '../../lib/hooks/useAuth';
import { canViewReconciliationExceptions } from '../../lib/reconciliation/adminGate';
import { useReconciliationExceptions } from '../../lib/reconciliation/useReconciliationExceptions';
import { callRetryReconcile } from '../../lib/reconciliation/retryReconcile';
import { mapRetryError, retryDisableReason } from '../../lib/reconciliation/exceptionRows';
import './ReconciliationExceptionsPage.css';

/**
 * Track B Step 2 / Phase 4 Step 4 — Reconciliation Exceptions admin page.
 * Route-only access via `/admin/reconciliation-exceptions`.
 * Refactored to use Flowbite React with Anti-Silent Failure UX.
 */
export default function ReconciliationExceptionsPage() {
  const { user } = useAuth();
  // Admin gate FIRST.
  const isAdmin = canViewReconciliationExceptions(user?.role);
  const { rows, loading, error } = useReconciliationExceptions(isAdmin);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'failure' } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const onRetry = useCallback(async (orderId: string) => {
    if (!window.confirm(`ส่งคำขอรีทรายรายการกระทบยอดของบิล ${orderId}?`)) return;
    setBusyId(orderId);
    setToast(null);
    try {
      await callRetryReconcile(orderId);
      // Async-safe success wording — backend only arms the state, doesn't immediately guarantee success
      setToast({ message: `ส่งคำขอ retry บิล ${orderId} แล้ว ระบบจะประมวลผลต่อ`, type: 'success' });
    } catch (err) {
      const code = (err as { code?: string }).code?.replace(/^functions\//, '');
      setToast({ message: mapRetryError(code) || 'เกิดข้อผิดพลาดในการเชื่อมต่อ', type: 'failure' });
    } finally {
      setBusyId(null);
    }
  }, []);

  if (!isAdmin) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Alert color="failure">
          <span className="font-medium">ข้อผิดพลาด!</span> เฉพาะผู้ดูแลระบบ (admin) เท่านั้นที่เข้าถึงหน้านี้ได้
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">รายการกระทบยอดค้าง</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            (Reconciliation Exceptions) การซ่อมแซมด้วยตนเอง — ใช้เมื่อจำเป็นเท่านั้น
          </p>
        </div>
        <Badge color="gray" size="sm" className="w-fit">
          {loading ? <Spinner size="sm" /> : `${rows.length} รายการ`}
        </Badge>
      </div>

      {toast && (
        <Alert color={toast.type} onDismiss={() => setToast(null)}>
          {toast.message}
        </Alert>
      )}

      {error ? (
        <Alert color="failure">
          <span className="font-medium">โหลดข้อมูลไม่สำเร็จ:</span> {error}
        </Alert>
      ) : loading ? (
        <div className="flex justify-center p-8">
          <Spinner size="xl" aria-label="Loading exceptions" />
        </div>
      ) : rows.length === 0 ? (
        <Alert color="success">
          ไม่มีรายการกระทบยอดค้าง 🎉
        </Alert>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <Table hoverable>
              <TableHead>
                <TableHeadCell>บิล</TableHeadCell>
                <TableHeadCell>สาขา</TableHeadCell>
                <TableHeadCell>พนักงาน</TableHeadCell>
                <TableHeadCell className="text-right">ยอด</TableHeadCell>
                <TableHeadCell className="text-right">ครั้ง</TableHeadCell>
                <TableHeadCell>ข้อผิดพลาดล่าสุด</TableHeadCell>
                <TableHeadCell>
                  <span className="sr-only">การกระทำ</span>
                </TableHeadCell>
              </TableHead>
              <TableBody className="divide-y">
                {rows.map((r) => {
                  const disabledReason = retryDisableReason(r, busyId === r.id);
                  const isBusy = busyId === r.id;
                  return (
                    <TableRow key={r.id} className="bg-white dark:border-gray-700 dark:bg-gray-800">
                      <TableCell className="font-mono text-xs whitespace-nowrap">{r.billId}</TableCell>
                      <TableCell className="whitespace-nowrap">{r.branchId}</TableCell>
                      <TableCell className="whitespace-nowrap">{r.staffName}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">{r.total.toLocaleString('th-TH')}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <span>{r.reconcileAttempts}</span>
                          {r.voidRequested && <Badge color="warning">void</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-red-600 dark:text-red-400 max-w-xs truncate" title={r.lastReconcileError}>
                        {r.lastReconcileError}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          color="light"
                          disabled={disabledReason !== null || isBusy}
                          title={disabledReason ?? 'รีทราย'}
                          onClick={() => void onRetry(r.id)}
                        >
                          {isBusy ? <Spinner size="sm" /> : 'รีทราย'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}
