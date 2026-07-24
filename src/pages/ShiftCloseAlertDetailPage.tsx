import { Alert, Badge, Button, Card, Spinner } from 'flowbite-react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../lib/hooks/useAuth';
import { useBranch } from '../lib/hooks/useBranch';
import { isFirebaseConfigured } from '../lib/firebase';
import { canViewShiftCloseAlertDetail, validateRouteShiftId } from '../lib/pos/shiftClose/shiftCloseDetailGate';
import {
  isSourceConfirmedEmpty,
  useShiftCloseAlertDetail,
  type ShiftCloseAlertSourceState,
  type ShiftCloseCaseSourceState,
} from '../lib/pos/shiftClose/useShiftCloseAlertDetail';
import type { IntegrityCaution } from '../lib/pos/shiftClose/shiftCloseDetailProjection';
import ShiftCloseAdjudicationPanel from '../components/pos/ShiftCloseAdjudicationPanel';

/**
 * Packet 5 / Client-UI-B core (read-only detail) + Client-UI-C (manager
 * adjudication action surface). Sibling route to `/shift-close-review`
 * (UI-A), direct URL access only (`/shift-close-review/:shiftId`); no nav
 * entry by design. Reads `shiftCloseAlerts` + `shiftCloseCases` (both
 * single-document, branch- and ID-scoped). UI-C adds a bounded
 * acknowledge/resolve action surface via `resolveShiftCloseAlert` (the ONLY
 * write path — this page and its hook never write Firestore directly); see
 * `ShiftCloseAdjudicationPanel.tsx` + `shiftCloseAdjudicationMachine.ts` for
 * the fail-closed availability/idempotency contract. Sensitive drawer/
 * expected figures remain deliberately deferred to UI-B2 (not implemented
 * here) — the adjudication dialogs explicitly warn that figures are not
 * displayed.
 */
export default function ShiftCloseAlertDetailPage() {
  const { shiftId: rawShiftId } = useParams<{ shiftId: string }>();
  const { user } = useAuth();
  const { branchId, branch } = useBranch();
  const isAllowed = canViewShiftCloseAlertDetail(user?.role);
  const routeValidation = validateRouteShiftId(rawShiftId);

  const { alert, case: kase, integrityCautions } = useShiftCloseAlertDetail(user?.role, branchId, rawShiftId);

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
        <BackToQueueLink />
      </PageShell>
    );
  }

  if (!branchId || branchId === 'ALL') {
    return (
      <PageShell>
        <Alert color="warning">โปรดเลือกสาขาเพื่อดูข้อมูล</Alert>
        <BackToQueueLink />
      </PageShell>
    );
  }

  if (!routeValidation.ok) {
    return (
      <PageShell>
        <Alert color="failure">ลิงก์ไม่ถูกต้อง ไม่พบรหัสกะที่ระบุในลิงก์นี้</Alert>
        <BackToQueueLink />
      </PageShell>
    );
  }

  const isLoading =
    alert.status === 'pending' ||
    alert.status === 'disabled' ||
    kase.status === 'pending' ||
    kase.status === 'disabled';
  const permissionDenied = alert.errorType === 'permission-denied' || kase.errorType === 'permission-denied';
  const genericError = !permissionDenied && (alert.errorType === 'generic' || kase.errorType === 'generic');
  const offline = !isLoading && !permissionDenied && !genericError && (alert.fromCache || kase.fromCache);
  const alertConfirmedEmpty = isSourceConfirmedEmpty(alert);
  const caseConfirmedEmpty = isSourceConfirmedEmpty(kase);
  const notFound = !isLoading && !permissionDenied && !genericError && !offline && alertConfirmedEmpty && caseConfirmedEmpty;

  return (
    <PageShell shiftId={routeValidation.shiftId} branchName={branch?.name ?? branchId}>
      {isLoading ? (
        <div className="flex justify-center p-8">
          <Spinner size="xl" aria-label="Loading shift close alert detail" />
        </div>
      ) : permissionDenied ? (
        // Fallback A (frozen plan §8): the missing-vs-denied distinction is
        // dropped by design — emulator evidence proved firestore.rules
        // cannot distinguish "no such alert/case for this shift" (the
        // overwhelmingly common case) from a genuine cross-branch/role
        // access problem for a direct-by-ID read. This copy is deliberately
        // neutral and does not claim either outcome specifically.
        <Alert color="warning">
          ไม่พบข้อมูลนี้ในสาขาที่เลือก หรือไม่มีสิทธิ์เข้าถึง โปรดตรวจสอบรหัสกะหรือสิทธิ์การเข้าถึงของท่าน
        </Alert>
      ) : genericError ? (
        <Alert color="failure">ไม่สามารถโหลดข้อมูลได้ โปรดลองอีกครั้ง</Alert>
      ) : notFound ? (
        <Alert color="warning">ไม่พบรายการแจ้งเตือนกะการขายนี้ในสาขาที่เลือก</Alert>
      ) : (
        <DetailBody
          alert={alert}
          kase={kase}
          integrityCautions={integrityCautions}
          offline={offline}
          role={user?.role}
          branchId={branchId}
          routeShiftId={routeValidation.shiftId}
        />
      )}
      <BackToQueueLink />
    </PageShell>
  );
}

function DetailBody({
  alert,
  kase,
  integrityCautions,
  offline,
  role,
  branchId,
  routeShiftId,
}: {
  alert: ShiftCloseAlertSourceState;
  kase: ShiftCloseCaseSourceState;
  integrityCautions: IntegrityCaution[];
  offline: boolean;
  role: string | null | undefined;
  branchId: string;
  routeShiftId: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      {offline && <Alert color="warning">ข้อมูลออฟไลน์ (ยังไม่ยืนยันกับเซิร์ฟเวอร์ อาจไม่เป็นปัจจุบัน)</Alert>}

      {integrityCautions.length > 0 && (
        <Alert color="warning">
          พบข้อมูลที่ต้องตรวจสอบเพิ่มเติม: {integrityCautions.map((c) => INTEGRITY_CAUTION_LABELS[c]).join(', ')}
        </Alert>
      )}

      {alert.row ? (
        <Card>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge color={alert.row.alertState === 'open' ? 'failure' : 'warning'} className="w-fit">
                {alert.row.alertStateLabel}
              </Badge>
              {alert.row.reasonLabel !== '—' && (
                <Badge color="gray" className="w-fit">
                  {alert.row.reasonLabel}
                </Badge>
              )}
            </div>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <DetailField label="เปิดเมื่อ" value={formatDateTime(alert.row.openedAtMs)} />
              <DetailField label="อัปเดตเมื่อ" value={formatDateTime(alert.row.updatedAtMs)} />
            </dl>
          </div>
        </Card>
      ) : alert.fromCache ? (
        // RC-1 remediation: a cache-derived empty read is NOT a confirmed
        // absence — only a server-confirmed empty read may claim that.
        <Alert color="gray">ข้อมูลการแจ้งเตือนยังไม่ยืนยันกับเซิร์ฟเวอร์ (ออฟไลน์) ยังสรุปไม่ได้ว่าไม่มีข้อมูล</Alert>
      ) : (
        <Alert color="warning">ไม่พบข้อมูลการแจ้งเตือนของรายการนี้ในสาขานี้ (พบเฉพาะข้อมูลกะ)</Alert>
      )}

      {kase.projection ? (
        <Card>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge color={caseBadgeColor(kase.projection.processingState)} className="w-fit">
                {kase.projection.processingStateLabel}
              </Badge>
              <Badge color={caseBadgeColor(kase.projection.settlementState)} className="w-fit">
                {kase.projection.settlementStateLabel}
              </Badge>
            </div>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <DetailField label="อัปเดตเมื่อ" value={formatDateTime(kase.projection.updatedAtMs)} />
              <DetailField label="มีรอบตรวจสอบที่เลือกแล้ว" value={kase.projection.hasSelectedRun ? 'มี' : 'ยังไม่มี'} />
            </dl>
            <Alert color="gray">
              ตัวเลขเงินสด/ลิ้นชัก: ต้องเปิดสิทธิ์เพิ่มเติม (UI-B2)
            </Alert>
            {kase.projection.caseVersion !== null && (
              <span className="text-xs text-gray-400">v{kase.projection.caseVersion}</span>
            )}
          </div>
        </Card>
      ) : kase.fromCache ? (
        // RC-1 remediation: a cache-derived empty read is NOT a confirmed
        // absence — only a server-confirmed empty read may claim that.
        <Alert color="gray">ข้อมูลกรณีตรวจสอบยังไม่ยืนยันกับเซิร์ฟเวอร์ (ออฟไลน์) ยังสรุปไม่ได้ว่าไม่มีข้อมูล</Alert>
      ) : (
        <Alert color="warning">ไม่พบข้อมูลกรณีการตรวจสอบของรายการนี้ในสาขานี้ (พบเฉพาะข้อมูลการแจ้งเตือน)</Alert>
      )}

      <ShiftCloseAdjudicationPanel
        role={role}
        branchId={branchId}
        routeShiftId={routeShiftId}
        alertSource={alert}
        caseSource={kase}
        integrityCautions={integrityCautions}
      />
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-sm text-gray-900 dark:text-white">{value}</dd>
    </div>
  );
}

function BackToQueueLink() {
  return (
    <Button as={Link} to="/shift-close-review" color="light" className="min-h-11 w-fit">
      กลับไปหน้ารายการแจ้งเตือน
    </Button>
  );
}

function PageShell({
  children,
  branchName,
  shiftId,
}: {
  children: React.ReactNode;
  branchName?: string;
  shiftId?: string;
}) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold break-all text-gray-900 dark:text-white">
          รายละเอียดการแจ้งเตือนกะการขาย
        </h1>
        {shiftId && (
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate font-mono text-xs text-gray-500 dark:text-gray-400"
              title={shiftId}
            >
              กะ: {shiftId}
            </span>
            <CopyShiftIdButton shiftId={shiftId} />
          </div>
        )}
        {branchName && <p className="text-sm text-gray-500 dark:text-gray-400">สาขา: {branchName}</p>}
      </div>
      {children}
    </div>
  );
}

function CopyShiftIdButton({ shiftId }: { shiftId: string }) {
  const handleCopy = () => {
    // Async rejection-safe: `writeText` returns a Promise, so a synchronous
    // try/catch alone cannot catch a denial (e.g. insecure context, blocked
    // permission). This is a non-critical convenience action — no
    // user-facing error is shown either way (cashier-safe, per
    // SKILL-UI-IMPECCABLE §5, this action carries no data-loss risk).
    void navigator.clipboard?.writeText(shiftId).catch(() => undefined);
  };
  return (
    <Button
      type="button"
      color="light"
      size="xs"
      onClick={handleCopy}
      aria-label="คัดลอกรหัสกะ"
      className="min-h-11 min-w-11 shrink-0 text-xs"
    >
      คัดลอก
    </Button>
  );
}

function caseBadgeColor(state: string): string {
  if (state === 'requires_operator_review' || state === 'permanently_unverifiable' || state === 'manual_review_required' || state === 'unknown') {
    return 'warning';
  }
  return 'gray';
}

const INTEGRITY_CAUTION_LABELS: Record<IntegrityCaution, string> = {
  alert_stored_id_mismatch: 'รหัสกะในข้อมูลแจ้งเตือนไม่ตรงกับรหัสเอกสาร',
  case_stored_id_mismatch: 'รหัสกะในข้อมูลกรณีตรวจสอบไม่ตรงกับรหัสเอกสาร',
  case_version_drift: 'เวอร์ชันข้อมูลระหว่างการแจ้งเตือนกับกรณีตรวจสอบไม่ตรงกัน',
  alert_state_unknown: 'สถานะการแจ้งเตือนไม่ทราบ (ข้อมูลผิดปกติ)',
  alert_reason_unknown: 'สาเหตุการแจ้งเตือนไม่ทราบ (ข้อมูลผิดปกติ)',
  processing_state_unknown: 'สถานะการประมวลผลไม่ทราบ (ข้อมูลผิดปกติ)',
  settlement_state_unknown: 'สถานะการยืนยันยอดไม่ทราบ (ข้อมูลผิดปกติ)',
  case_missing_for_alert: 'ไม่พบข้อมูลกรณีตรวจสอบที่คู่กับการแจ้งเตือนนี้',
  alert_missing_for_case: 'ไม่พบข้อมูลการแจ้งเตือนที่คู่กับกรณีตรวจสอบนี้',
  case_alert_state_unknown: 'สถานะการแจ้งเตือนในข้อมูลกรณีตรวจสอบไม่ทราบ (ข้อมูลผิดปกติ)',
  case_alert_state_disagreement: 'สถานะการแจ้งเตือนไม่ตรงกันระหว่างข้อมูลแจ้งเตือนกับข้อมูลกรณีตรวจสอบ',
};

function formatDateTime(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toLocaleString('th-TH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
