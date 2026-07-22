import { Alert, Badge, Card, Spinner, Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from 'flowbite-react';
import { useAuth } from '../lib/hooks/useAuth';
import { useBranch } from '../lib/hooks/useBranch';
import { isFirebaseConfigured } from '../lib/firebase';
import { canViewShiftCloseReview } from '../lib/pos/shiftClose/shiftCloseReviewGate';
import { useShiftCloseReviewQueue } from '../lib/pos/shiftClose/useShiftCloseReviewQueue';
import type { ShiftCloseReviewRow } from '../lib/pos/shiftClose/shiftCloseReviewRows';

/**
 * Packet 5 / Client-UI-A — read-only, route-only manager alert queue.
 * Direct URL access only (`/shift-close-review`); no nav entry by design.
 * Reads ONLY `shiftCloseAlerts` (branch-scoped equality query) — no case
 * detail, no acknowledge/resolve actions, no callable invocation, no writes.
 */
export default function ShiftCloseReviewPage() {
  const { user } = useAuth();
  const { branchId, branch } = useBranch();
  const isAllowed = canViewShiftCloseReview(user?.role);

  const { status, actionableRows, malformedRows, totalCount, error, fromCache, lastSnapshotAtMs } =
    useShiftCloseReviewQueue(user?.role, branchId);

  if (!isFirebaseConfigured) {
    return (
      <PageShell>
        <Alert color="gray">ระบบยังไม่พร้อมใช้งาน</Alert>
      </PageShell>
    );
  }

  if (!isAllowed) {
    return (
      <PageShell>
        <Alert color="failure">
          <span className="font-medium">ข้อผิดพลาด!</span> เฉพาะผู้จัดการ (manager) หรือผู้ดูแลระบบ (admin) เท่านั้นที่เข้าถึงหน้านี้ได้
        </Alert>
      </PageShell>
    );
  }

  if (!branchId || branchId === 'ALL') {
    return (
      <PageShell>
        <Alert color="warning">โปรดเลือกสาขาเพื่อดูข้อมูล</Alert>
      </PageShell>
    );
  }

  // RC-1: `status === 'pending'` (subscribed, no snapshot callback yet) MUST
  // render as loading — never fall through to a confirmed-empty/success state.
  // `disabled` is a defensive fallback only (the page's own gate checks above
  // already mirror the hook's gate, so `disabled` should not be reachable here).
  const isLoading = status === 'pending' || status === 'disabled';

  return (
    <PageShell branchName={branch?.name ?? branchId}>
      {isLoading ? (
        <div className="flex justify-center p-8">
          <Spinner size="xl" aria-label="Loading shift close alerts" />
        </div>
      ) : error === 'permission-denied' ? (
        <Alert color="failure">
          ไม่มีสิทธิ์เข้าถึงข้อมูลของสาขานี้ โปรดติดต่อผู้ดูแลระบบเพื่อตรวจสอบสิทธิ์ (การลงชื่อเข้าใช้อีกครั้งอาจไม่สามารถแก้ไขปัญหานี้ได้)
        </Alert>
      ) : error === 'generic' ? (
        <Alert color="failure">ไม่สามารถโหลดข้อมูลได้ โปรดลองอีกครั้ง</Alert>
      ) : (
        <div className="flex flex-col gap-3">
          {/* RC-2 (R2 remediation): malformed/unknown rows are never silently
              dropped — surfaced regardless of the empty/non-empty branch
              below, listing affected shift IDs (capped) so they stay visible. */}
          {malformedRows.length > 0 && (
            <Alert color="warning">
              พบข้อมูลผิดรูปแบบ {malformedRows.length} รายการ:{' '}
              {malformedRows.slice(0, 5).map((row) => row.shiftId).join(', ')}
              {malformedRows.length > 5 ? ` (แสดง 5 รายการแรก)` : ''}
            </Alert>
          )}

          {fromCache && totalCount === 0 && (
            <Alert color="warning">รอการเชื่อมต่อ (ข้อมูลอาจยังไม่เป็นปัจจุบัน)</Alert>
          )}
          {/* RC-2 (R2 remediation): clean-success is impossible whenever
              malformed data exists — even a `resolved` row with an unknown
              reason must block "ทำรายการครบถ้วนแล้ว"/"ไม่มีการแจ้งเตือน...".
              A distinct caution state replaces it instead. */}
          {!fromCache && actionableRows.length === 0 && malformedRows.length === 0 && (
            <Alert color="success">
              {totalCount === 0 ? 'ไม่มีการแจ้งเตือนกะการขายสำหรับสาขานี้' : 'ทำรายการครบถ้วนแล้ว'}
            </Alert>
          )}
          {!fromCache && actionableRows.length === 0 && malformedRows.length > 0 && (
            <Alert color="warning">
              พบข้อมูลแจ้งเตือนที่ไม่สมบูรณ์ ต้องตรวจสอบก่อนสรุปว่าสาขานี้ไม่มีรายการค้าง
            </Alert>
          )}
          {fromCache && totalCount > 0 && (
            <Alert color="warning">
              {/* RC-1: honestly labeled as local receipt time, NOT data freshness. */}
              ข้อมูลออฟไลน์ (รับข้อมูลล่าสุดเมื่อ: {formatClockTime(lastSnapshotAtMs)})
            </Alert>
          )}

          {/* RC-3: the count must render in every confirmed/received state,
              including zero-actionable/nonzero-total ("ทำรายการครบถ้วนแล้ว"). */}
          <span className="text-sm text-gray-500 dark:text-gray-400">
            แสดง {actionableRows.length} รายการ จากทั้งหมด {totalCount} รายการ
          </span>

          {actionableRows.length > 0 && (
            <Card className="overflow-hidden p-0">
              <div className="overflow-x-auto">
                <Table hoverable>
                  <TableHead>
                    <TableHeadCell>กะ (Shift ID)</TableHeadCell>
                    <TableHeadCell>สถานะการแจ้งเตือน</TableHeadCell>
                    <TableHeadCell>สาเหตุ</TableHeadCell>
                    <TableHeadCell>เปิดเมื่อ</TableHeadCell>
                    <TableHeadCell>อัปเดตเมื่อ</TableHeadCell>
                    <TableHeadCell className="text-gray-400">รายละเอียด</TableHeadCell>
                  </TableHead>
                  <TableBody className="divide-y">
                    {actionableRows.map((row) => (
                      <ReviewRow key={row.id} row={row} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>
          )}
        </div>
      )}
    </PageShell>
  );
}

function ReviewRow({ row }: { row: ShiftCloseReviewRow }) {
  return (
    <TableRow className="bg-white dark:border-gray-700 dark:bg-gray-800">
      <TableCell className="font-mono text-xs whitespace-nowrap">{row.shiftId}</TableCell>
      <TableCell className="whitespace-nowrap">
        <Badge color={row.alertState === 'open' ? 'failure' : 'warning'} className="w-fit">
          {row.alertStateLabel}
        </Badge>
      </TableCell>
      <TableCell className="whitespace-nowrap">{row.reasonLabel}</TableCell>
      <TableCell className="whitespace-nowrap text-gray-500 dark:text-gray-400">
        {formatRelative(row.openedAtMs)}
      </TableCell>
      <TableCell className="whitespace-nowrap text-gray-500 dark:text-gray-400">
        {formatRelative(row.updatedAtMs)}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-gray-400">
        <span>v{row.caseVersion ?? '—'}</span>
        {row.acknowledgedByActor?.kind === 'manager' && (
          <span className="ml-2">รับทราบโดย {row.acknowledgedByActor.managerUid}</span>
        )}
        {row.resolvedByActor?.kind === 'manager' && (
          <span className="ml-2">แก้ไขโดย {row.resolvedByActor.managerUid}</span>
        )}
      </TableCell>
    </TableRow>
  );
}

function PageShell({ children, branchName }: { children: React.ReactNode; branchName?: string }) {
  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">รายการแจ้งเตือนกะการขาย</h1>
        {branchName && (
          <p className="text-sm text-gray-500 dark:text-gray-400">สาขา: {branchName}</p>
        )}
      </div>
      {children}
    </div>
  );
}

function formatRelative(ms: number | null): string {
  if (ms === null) return '—';
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diffSec < 60) return 'เมื่อสักครู่';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} นาทีที่แล้ว`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} ชั่วโมงที่แล้ว`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} วันที่แล้ว`;
}

function formatClockTime(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}
