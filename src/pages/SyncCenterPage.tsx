/**
 * PK-4 Operator Sync Center — /sync-center
 * Sole production owner of canonical mutation context.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Card,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeadCell,
  TableRow,
} from '../components/ui';
import { useAuth } from '../lib/hooks/useAuth';
import { useBranch } from '../lib/hooks/useBranch';
import { isFirebaseConfigured } from '../lib/firebase';
import { getDeviceId } from '../lib/pos/deviceId';
import { useMountCanonicalSyncContext } from '../lib/pos/offline/canonicalSyncContext';
import {
  canOpenAdminReconciliation,
  canViewSyncCenter,
} from '../lib/pos/offline/syncCenterAuthority';
import {
  CHANNEL_NAME_TH,
  SCOPE_UNAVAILABLE_COPY,
  SYNC_CENTER_ATTENTION_CAP,
  SYNC_CENTER_CHANNEL_ORDER,
  SYNC_CENTER_HISTORY_CAP,
  aggregateForbidsClean,
  thaiStateLabel,
  type SyncCenterItemState,
  type SyncCenterRow,
} from '../lib/pos/offline/syncCenterModel';
import { useSyncCenterState } from '../hooks/pos/useSyncCenterState';
import { getBranchLabel } from '../lib/branches';

function formatHm(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function deviceLabel(row: SyncCenterRow, scopeDeviceId: string): string {
  if (row.channel === 'offline_reversal') return 'สาขานี้';
  if (row.deviceId == null) return 'ไม่ทราบเครื่อง';
  if (row.deviceId === scopeDeviceId) return 'เครื่องนี้';
  return row.deviceId;
}

function stateBadgeColor(state: SyncCenterItemState): string {
  if (state === 'attention' || state === 'unknown') return 'warning';
  if (state === 'confirmed') return 'success';
  if (state === 'in_flight') return 'info';
  return 'gray';
}

function ItemRowActions(props: {
  row: SyncCenterRow;
  role: 'admin' | 'manager' | 'staff';
  busyId: string | null;
  onRetry: (row: SyncCenterRow) => void;
}) {
  const { row, role, busyId, onRetry } = props;
  if (row.deviceId === null && row.channel !== 'offline_reversal') {
    return <span className="text-xs text-[var(--text-muted)]">ไม่ทราบเครื่อง</span>;
  }
  if (row.channel === 'void_intent' && row.state === 'attention') {
    return (
      <span className="text-xs text-[var(--text-secondary)]">
        หยุดส่งแล้ว — ต้องให้เจ้าหน้าที่ตรวจสอบ
      </span>
    );
  }
  if (row.attemptCeilingReached) {
    return <span className="text-xs text-[var(--text-secondary)]">ระบบจะไม่ลองส่งรายการนี้อีก</span>;
  }
  if (row.actionable.includes('item_retry_now')) {
    const pending = busyId === row.id;
    return (
      <Button
        size="xs"
        color="purple"
        disabled={pending}
        onClick={() => onRetry(row)}
        title={pending ? 'กำลังส่งคำขอนี้' : 'ลองส่งรายการนี้ตอนนี้'}
      >
        {pending ? 'กำลังส่ง…' : 'ลองส่งรายการนี้ตอนนี้'}
      </Button>
    );
  }
  if (row.actionable.includes('open_manual_review')) {
    return (
      <Link to="/manual-review" className="text-xs font-medium text-[var(--p600)] underline">
        ตรวจสอบด้วยตนเอง
      </Link>
    );
  }
  if (row.actionable.includes('open_shift_close_review')) {
    return (
      <Link to="/shift-close-review" className="text-xs font-medium text-[var(--p600)] underline">
        ตรวจสอบการปิดรอบ
      </Link>
    );
  }
  if (
    (row.channel === 'void_intent' || row.channel === 'offline_reversal') &&
    (row.state === 'waiting_retry' || row.state === 'pending') &&
    role === 'staff'
  ) {
    return (
      <span className="text-xs text-[var(--text-secondary)]">ต้องให้ผู้จัดการดำเนินการ</span>
    );
  }
  return <span className="text-xs text-[var(--text-muted)]">—</span>;
}

function RowCard(props: {
  row: SyncCenterRow;
  scopeDeviceId: string;
  role: 'admin' | 'manager' | 'staff';
  busyId: string | null;
  onRetry: (row: SyncCenterRow) => void;
}) {
  const { row, scopeDeviceId, role, busyId, onRetry } = props;
  return (
    <Card className="min-w-0">
      <div className="flex flex-col gap-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge color="purple">{CHANNEL_NAME_TH[row.channel]}</Badge>
          <Badge color={stateBadgeColor(row.state)}>{thaiStateLabel(row.state)}</Badge>
          {row.isStale && <Badge color="warning">ค้างนาน</Badge>}
        </div>
        <div className="font-mono text-xs text-[var(--text-secondary)]" title={row.id}>
          {row.id}
        </div>
        <div className="text-[var(--text-primary)]">{row.reasonTh}</div>
        <div className="text-xs text-[var(--text-muted)]">
          {deviceLabel(row, scopeDeviceId)}
          {row.attempts != null ? ` · ลองแล้ว ${row.attempts}/8` : ''}
          {row.lastErrorAtMs != null ? ` · ผิดพลาดล่าสุด ${formatHm(row.lastErrorAtMs)}` : ''}
        </div>
        <ItemRowActions row={row} role={role} busyId={busyId} onRetry={onRetry} />
      </div>
    </Card>
  );
}

function RowTable(props: {
  rows: SyncCenterRow[];
  scopeDeviceId: string;
  role: 'admin' | 'manager' | 'staff';
  busyId: string | null;
  onRetry: (row: SyncCenterRow) => void;
}) {
  return (
    <div className="overflow-x-auto min-w-0">
      <Table>
        <TableHead>
          <TableRow>
            <TableHeadCell>ช่องทาง</TableHeadCell>
            <TableHeadCell>รายการ</TableHeadCell>
            <TableHeadCell>สถานะ</TableHeadCell>
            <TableHeadCell>รายละเอียด</TableHeadCell>
            <TableHeadCell>เครื่อง</TableHeadCell>
            <TableHeadCell>การทำงาน</TableHeadCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {props.rows.map((row) => (
            <TableRow key={`${row.channel}:${row.id}`}>
              <TableCell>{CHANNEL_NAME_TH[row.channel]}</TableCell>
              <TableCell>
                <span className="font-mono text-xs" title={row.id}>
                  {row.id}
                </span>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1">
                  {row.state === 'attention' && (
                    <i className="ti ti-alert-triangle" aria-hidden="true" />
                  )}
                  {thaiStateLabel(row.state)}
                </span>
              </TableCell>
              <TableCell>{row.reasonTh}</TableCell>
              <TableCell>{deviceLabel(row, props.scopeDeviceId)}</TableCell>
              <TableCell>
                <ItemRowActions
                  row={row}
                  role={props.role}
                  busyId={props.busyId}
                  onRetry={props.onRetry}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function SectionList(props: {
  rows: SyncCenterRow[];
  scopeDeviceId: string;
  role: 'admin' | 'manager' | 'staff';
  busyId: string | null;
  onRetry: (row: SyncCenterRow) => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-2 md:hidden">
        {props.rows.map((row) => (
          <RowCard
            key={`${row.channel}:${row.id}`}
            row={row}
            scopeDeviceId={props.scopeDeviceId}
            role={props.role}
            busyId={props.busyId}
            onRetry={props.onRetry}
          />
        ))}
      </div>
      <div className="hidden md:block">
        <RowTable {...props} />
      </div>
    </>
  );
}

export default function SyncCenterPage() {
  useMountCanonicalSyncContext();
  const { user, branchId } = useAuth();
  const { branch } = useBranch();
  const role = user?.role ?? 'staff';
  const {
    view,
    status,
    isBusy,
    isOnline,
    retryItem,
    resweep,
    actor,
  } = useSyncCenterState();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const deviceId = getDeviceId();
  const branchDisplay = branch?.name ?? (branchId ? getBranchLabel(branchId) : '—');

  const onRetry = async (row: SyncCenterRow) => {
    setBusyId(row.id);
    setFeedback(null);
    try {
      const result = await retryItem(row);
      if (result.mutation === 'noop') {
        setFeedback(
          result.mutationReason === 'already_eligible'
            ? 'รายการนี้พร้อมส่งอยู่แล้ว'
            : result.mutationReason === 'offline'
              ? 'ยังออฟไลน์อยู่ — ยังส่งไม่ได้'
              : result.mutationReason === 'out_of_scope' || result.mutationReason === 'stale_scope'
                ? 'รายการนี้ไม่อยู่ในสาขาหรือเครื่องปัจจุบัน'
                : `ยังส่งไม่ได้ (${result.mutationReason ?? 'ไม่ทราบสาเหตุ'})`,
        );
      } else {
        setFeedback('รับคำขอแล้ว — กำลังตรวจสอบสถานะจากข้อมูลในเครื่อง');
      }
    } finally {
      setBusyId(null);
    }
  };

  const onResweep = async () => {
    setFeedback(null);
    const result = await resweep();
    if (!result.accepted) {
      setFeedback(
        result.reason === 'offline' ? 'ยังออฟไลน์อยู่ — ยังส่งไม่ได้' : 'ยังตรวจสอบใหม่ไม่ได้ตอนนี้',
      );
      return;
    }
    setFeedback('รับคำขอตรวจสอบทั้งเครื่องแล้ว — ผลจะอัปเดตจากข้อมูลในเครื่อง');
  };

  if (!isFirebaseConfigured) {
    return (
      <div className="p-4">
        <Alert color="warning">ระบบยังไม่พร้อมใช้งาน</Alert>
      </div>
    );
  }
  if (!canViewSyncCenter(role)) {
    return (
      <div className="p-4">
        <Alert color="failure">ไม่มีสิทธิ์ดูศูนย์ซิงก์</Alert>
      </div>
    );
  }
  if (status === 'pending' && view.status !== 'scope_unavailable') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center p-4">
        <Spinner aria-label="กำลังโหลดศูนย์ซิงก์" />
      </div>
    );
  }
  if (view.status === 'scope_unavailable') {
    return (
      <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-4 overflow-x-hidden p-4">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]" style={{ fontFamily: "'Prompt', sans-serif" }}>
          ศูนย์ซิงก์
        </h1>
        <Alert color="warning">{SCOPE_UNAVAILABLE_COPY[view.reason]}</Alert>
        <Button disabled title="ยังเลือกสาขาไม่ได้">
          ตรวจสอบและส่งใหม่ทั้งหมด
        </Button>
      </div>
    );
  }

  const agg = view.aggregate;
  const attentionRows = agg.rows
    .filter((r) => r.state === 'attention')
    .sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))
    .slice(0, SYNC_CENTER_ATTENTION_CAP);
  const pendingRows = agg.rows
    .filter((r) => r.state === 'pending' || r.state === 'in_flight' || r.state === 'waiting_retry')
    .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0))
    .slice(0, SYNC_CENTER_ATTENTION_CAP);
  const historyRows = agg.rows
    .filter((r) => r.state === 'confirmed')
    .sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))
    .slice(0, SYNC_CENTER_HISTORY_CAP * 5);

  const showManualReviewLink =
    (role === 'manager' || role === 'admin') &&
    agg.rows.some((r) => r.channel === 'offline_reversal' && r.reasonCode === 'manual_review_required');
  const showShiftReviewLink =
    (role === 'manager' || role === 'admin') &&
    agg.rows.some((r) => r.channel === 'shift_intent' && r.state === 'attention');
  const showAdminLink = canOpenAdminReconciliation(role);
  const readableOk = agg.channels
    .filter((c) => c.channel !== 'trusted_resume')
    .every((c) => c.availability === 'ok');
  const attentionEmptyCopy = readableOk
    ? 'ไม่มีรายการที่ต้องตรวจสอบ'
    : 'ไม่พบรายการ แต่บางช่องทางอ่านไม่ได้';

  const channelById = new Map(agg.channels.map((ch) => [ch.channel, ch]));

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-4 overflow-x-hidden p-4">
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]" style={{ fontFamily: "'Prompt', sans-serif" }}>
          ศูนย์ซิงก์
        </h1>
        <p className="text-xs text-[var(--text-secondary)]">
          สาขา{branchDisplay} · เครื่อง {deviceId}
        </p>
      </header>

      <section
        aria-live="polite"
        className="flex min-w-0 flex-col gap-3 rounded-lg border border-[var(--border)] bg-white p-3 md:flex-row md:flex-wrap md:items-center"
      >
        {!isOnline && (
          <span className="inline-flex items-center gap-1 text-sm text-[var(--warn)]">
            <i className="ti ti-wifi-off" aria-hidden="true" />
            ออฟไลน์ — ขายต่อได้ ข้อมูลถูกบันทึกไว้ในเครื่อง
          </span>
        )}
        <span>รอส่ง {agg.unifiedPending}</span>
        <span className="inline-flex items-center gap-1">
          {agg.unifiedAttention > 0 && <i className="ti ti-alert-triangle" aria-hidden="true" />}
          ต้องตรวจสอบ {agg.unifiedAttention}
        </span>
        <span>อ่านไม่ได้ {agg.unavailableChannelCount}</span>
        <span>
          {agg.lastSyncCheckAtMs != null
            ? `ตรวจสอบการซิงก์ล่าสุด ${formatHm(agg.lastSyncCheckAtMs)}`
            : 'ยังไม่ได้ตรวจสอบสำหรับสาขานี้'}
        </span>
        {!agg.webLocksAvailable && (
          <span className="text-xs text-[var(--text-muted)]">อุปกรณ์นี้ไม่รองรับการล็อกหลายแท็บ</span>
        )}
        <Button
          color="purple"
          disabled={isBusy}
          onClick={() => void onResweep()}
          title={isBusy ? 'กำลังตรวจสอบอยู่' : 'ตรวจสอบและส่งใหม่ทั้งหมด'}
        >
          ตรวจสอบและส่งใหม่ทั้งหมด
        </Button>
      </section>

      {feedback && (
        <Alert color="info">
          {feedback}
        </Alert>
      )}

      {aggregateForbidsClean(agg) ? null : (
        <p className="text-sm text-[var(--text-secondary)]">ไม่มีรายการค้าง</p>
      )}

      <section className="min-w-0">
        <h2 className="mb-2 text-sm font-semibold">ภาพรวมห้าช่องทาง</h2>
        <div className="overflow-x-auto min-w-0">
          <Table>
            <TableHead>
              <TableRow>
                <TableHeadCell>ช่องทาง</TableHeadCell>
                <TableHeadCell>รอส่ง</TableHeadCell>
                <TableHeadCell>กำลังส่ง</TableHeadCell>
                <TableHeadCell>รอรอบถัดไป</TableHeadCell>
                <TableHeadCell>ต้องตรวจสอบ</TableHeadCell>
                <TableHeadCell>สถานะการอ่าน</TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {SYNC_CENTER_CHANNEL_ORDER.map((channel) => {
                const summary = channelById.get(channel);
                const unavailable = summary?.availability !== 'ok';
                return (
                  <TableRow key={channel}>
                    <TableCell>{CHANNEL_NAME_TH[channel]}</TableCell>
                    <TableCell>
                      {unavailable && channel !== 'trusted_resume' ? '—' : (summary?.pending ?? 0)}
                    </TableCell>
                    <TableCell>
                      {unavailable && channel !== 'trusted_resume' ? '—' : (summary?.inFlight ?? 0)}
                    </TableCell>
                    <TableCell>
                      {unavailable && channel !== 'trusted_resume' ? '—' : (summary?.waitingRetry ?? 0)}
                    </TableCell>
                    <TableCell>
                      {unavailable && channel !== 'trusted_resume' ? '—' : (summary?.attention ?? 0)}
                    </TableCell>
                    <TableCell>
                      {channel === 'trusted_resume'
                        ? `อ่านสถานะไม่ได้ — ${summary?.unavailableReason ?? 'ไม่ทราบสถานะ'}`
                        : unavailable
                          ? summary?.unavailableReason ?? 'อ่านข้อมูลช่องทางนี้ไม่ได้'
                          : 'อ่านได้'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="min-w-0">
          <h2 className="mb-2 inline-flex items-center gap-1 text-sm font-semibold">
            <i className="ti ti-alert-triangle" aria-hidden="true" />
            ต้องตรวจสอบ
          </h2>
          {attentionRows.length === 0 ? (
            <p className="text-sm text-[var(--text-secondary)]">{attentionEmptyCopy}</p>
          ) : (
            <SectionList
              rows={attentionRows}
              scopeDeviceId={agg.scopeDeviceId}
              role={actor.role}
              busyId={busyId}
              onRetry={(row) => void onRetry(row)}
            />
          )}
        </section>
        <section className="min-w-0">
          <h2 className="mb-2 text-sm font-semibold">รอส่ง</h2>
          {pendingRows.length === 0 ? (
            <p className="text-sm text-[var(--text-secondary)]">ไม่มีรายการรอส่งที่อ่านได้</p>
          ) : (
            <SectionList
              rows={pendingRows}
              scopeDeviceId={agg.scopeDeviceId}
              role={actor.role}
              busyId={busyId}
              onRetry={(row) => void onRetry(row)}
            />
          )}
        </section>
      </div>

      <section className="min-w-0">
        <button
          type="button"
          className="mb-2 text-sm font-semibold text-[var(--p600)]"
          onClick={() => setHistoryOpen((v) => !v)}
        >
          เสร็จสิ้นแล้ว {historyOpen ? '▾' : '▸'}
        </button>
        {historyOpen && (
          historyRows.length === 0 ? (
            <p className="text-sm text-[var(--text-secondary)]">ยังไม่มีรายการที่เสร็จสิ้นในมุมมองนี้</p>
          ) : (
            <SectionList
              rows={historyRows}
              scopeDeviceId={agg.scopeDeviceId}
              role={actor.role}
              busyId={busyId}
              onRetry={(row) => void onRetry(row)}
            />
          )
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-2 text-sm">
        <h2 className="font-semibold">หน้าตรวจสอบที่เกี่ยวข้อง</h2>
        {showManualReviewLink && (
          <Link to="/manual-review" className="text-[var(--p600)] underline">
            ตรวจสอบด้วยตนเอง — รายการคืนสต็อกที่ต้องตัดสินใจ
          </Link>
        )}
        {showShiftReviewLink && (
          <Link to="/shift-close-review" className="text-[var(--p600)] underline">
            ตรวจสอบการปิดรอบ — รายการเปิด/ปิดรอบที่ถูกปฏิเสธ
          </Link>
        )}
        {showAdminLink && (
          <Link to="/admin/reconciliation-exceptions" className="text-[var(--p600)] underline">
            รายการค้างฝั่งเซิร์ฟเวอร์ — ไม่ใช่คิวเครื่องนี้
          </Link>
        )}
      </section>
    </div>
  );
}
