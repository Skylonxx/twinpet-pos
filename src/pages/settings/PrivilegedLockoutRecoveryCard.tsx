import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Label, Select } from '../../components/ui';
import { useApproverRoster } from '../../lib/auth/useApproverRoster';
import {
  getPrivilegedLockoutRecoveryInvoke,
  readPrivilegedLockoutStatus,
  runPrivilegedLockoutRecovery,
  type NativeInvoke,
  type PrivilegedLockoutRecoveryDeps,
  type PrivilegedLockoutRecoveryOutcome,
  type PrivilegedLockoutStatus,
} from '../../lib/auth/privilegedLockoutRecovery';

/**
 * Admin-only recovery of a manager's native privileged-approval lockout on
 * this device (D-V12..D-V17). Targets come only from the live approver roster
 * (canonical staff id, manager/admin, active, not deleted, branch-eligible,
 * never the admin operator). The device id, lockout id and LCT1 never reach
 * this component: it sees only display-safe status and outcome kinds.
 */

export const LOCKOUT_RECOVERY_COPY = {
  title: 'ปลดล็อกสิทธิ์อนุมัติ',
  locked: 'ผู้อนุมัติรายนี้ถูกล็อกบนเครื่องนี้',
  notLocked: 'ผู้อนุมัติรายนี้ไม่ได้ถูกล็อกบนเครื่องนี้',
  confirm: 'ปลดล็อกสิทธิ์อนุมัติของผู้จัดการรายนี้บนเครื่องนี้หรือไม่',
  success: 'ปลดล็อกสิทธิ์อนุมัติแล้ว',
  cooldownPrefix: 'ยังไม่สามารถปลดล็อกได้ กรุณารออีก',
  failure: 'ปลดล็อกสิทธิ์อนุมัติไม่สำเร็จ กรุณาติดต่อผู้ดูแลระบบ',
  notAdmin: 'ต้องเข้าสู่ระบบด้วยชื่อผู้ใช้และรหัสผ่านของผู้ดูแลระบบจึงจะปลดล็อกได้',
  nativeOnly: 'ใช้ได้เฉพาะในแอป Twinpet POS บนเครื่องนี้เท่านั้น',
  rosterError: 'โหลดรายชื่อผู้จัดการไม่สำเร็จ',
  statusError: 'ตรวจสอบสถานะการล็อกไม่สำเร็จ',
} as const;

export function cooldownText(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `${LOCKOUT_RECOVERY_COPY.cooldownPrefix} ${minutes} นาที`;
}

type Result = { tone: 'success' | 'failure' | 'warning'; text: string };

function resultFor(outcome: PrivilegedLockoutRecoveryOutcome): Result {
  switch (outcome.kind) {
    case 'recovered':
      return { tone: 'success', text: LOCKOUT_RECOVERY_COPY.success };
    case 'not_admin':
      return { tone: 'failure', text: LOCKOUT_RECOVERY_COPY.notAdmin };
    case 'not_locked':
      return { tone: 'warning', text: LOCKOUT_RECOVERY_COPY.notLocked };
    case 'cooldown':
      return { tone: 'warning', text: cooldownText(outcome.cooldownRemainingMs) };
    default:
      return { tone: 'failure', text: LOCKOUT_RECOVERY_COPY.failure };
  }
}

export default function PrivilegedLockoutRecoveryCard({
  branchId,
  operator,
  deps,
}: {
  branchId: string | null;
  operator: { id: string; role: string } | null | undefined;
  /** Test seam only; production uses the native bridge and primary Firebase app. */
  deps?: PrivilegedLockoutRecoveryDeps;
}) {
  const isAdmin = operator?.role === 'admin';
  const [invoke] = useState<NativeInvoke | null>(() =>
    deps?.invoke !== undefined ? deps.invoke : getPrivilegedLockoutRecoveryInvoke(),
  );
  const roster = useApproverRoster({
    enabled: isAdmin && invoke != null,
    branchId,
    requesterStaffId: operator?.id ?? null,
  });
  const [selectedId, setSelectedId] = useState('');
  const [status, setStatus] = useState<PrivilegedLockoutStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  // Synchronous one-episode guard: a second click before re-render is a no-op.
  const runningRef = useRef(false);
  const readSeqRef = useRef(0);

  const refreshStatus = useCallback(
    async (managerStaffId: string) => {
      const seq = ++readSeqRef.current;
      setStatus(null);
      if (!managerStaffId) return;
      const next = await readPrivilegedLockoutStatus(managerStaffId, { invoke });
      if (seq === readSeqRef.current) setStatus(next);
    },
    [invoke],
  );

  useEffect(() => {
    void refreshStatus(selectedId);
  }, [selectedId, refreshStatus]);

  if (!isAdmin) return null;

  const candidates = roster.status === 'ready' ? roster.candidates : [];
  const selected = candidates.find((c) => c.userId === selectedId) ?? null;

  const confirmRecovery = async () => {
    if (runningRef.current || !selected) return;
    runningRef.current = true;
    setBusy(true);
    try {
      const outcome = await runPrivilegedLockoutRecovery(
        { managerStaffId: selected.userId, operator },
        { ...deps, invoke },
      );
      setResult(resultFor(outcome));
    } finally {
      setConfirming(false);
      setBusy(false);
      runningRef.current = false;
    }
  };

  const closeResult = () => {
    setResult(null);
    void refreshStatus(selectedId);
  };

  let body: ReactNode;
  if (!invoke) {
    body = <Alert color="gray">{LOCKOUT_RECOVERY_COPY.nativeOnly}</Alert>;
  } else if (result) {
    body = (
      <div className="flex flex-col gap-3">
        <Alert color={result.tone} role={result.tone === 'success' ? 'status' : 'alert'}>
          {result.text}
        </Alert>
        <div>
          <Button color="light" className="min-h-11" onClick={closeResult}>
            ปิด
          </Button>
        </div>
      </div>
    );
  } else if (roster.status === 'error') {
    body = (
      <Alert color="failure" role="alert">
        {LOCKOUT_RECOVERY_COPY.rosterError}
      </Alert>
    );
  } else if (roster.status !== 'ready') {
    body = <div className="stg-form-hint">กำลังโหลดรายชื่อผู้จัดการ…</div>;
  } else {
    let statusBlock: ReactNode = null;
    if (selected && status === null) {
      statusBlock = <div className="stg-form-hint">กำลังตรวจสอบสถานะการล็อก…</div>;
    } else if (selected && status?.kind === 'unavailable') {
      statusBlock = (
        <Alert color="failure" role="alert">
          {LOCKOUT_RECOVERY_COPY.statusError}
        </Alert>
      );
    } else if (selected && status?.kind === 'not_locked') {
      statusBlock = <div className="stg-form-hint">{LOCKOUT_RECOVERY_COPY.notLocked}</div>;
    } else if (selected && status?.kind === 'locked') {
      const coolingDown = status.cooldownRemainingMs > 0;
      statusBlock = (
        <div className="flex flex-col gap-3">
          <Alert color="warning">{LOCKOUT_RECOVERY_COPY.locked}</Alert>
          {coolingDown ? (
            <div className="stg-form-hint">{cooldownText(status.cooldownRemainingMs)}</div>
          ) : confirming ? (
            <div className="flex flex-col gap-3">
              <div className="text-sm font-medium">{LOCKOUT_RECOVERY_COPY.confirm}</div>
              <div className="flex flex-wrap gap-2">
                <Button color="failure" className="min-h-11" onClick={() => void confirmRecovery()} disabled={busy}>
                  {busy ? 'กำลังปลดล็อก…' : 'ยืนยันปลดล็อก'}
                </Button>
                <Button color="light" className="min-h-11" onClick={() => setConfirming(false)} disabled={busy}>
                  ยกเลิก
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button className="min-h-11" onClick={() => setConfirming(true)}>
                {LOCKOUT_RECOVERY_COPY.title}
              </Button>
            </div>
          )}
        </div>
      );
    }
    body = (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="privileged-lockout-manager">ผู้จัดการ / ผู้อนุมัติ</Label>
          <Select
            id="privileged-lockout-manager"
            value={selectedId}
            onChange={(e) => {
              setConfirming(false);
              setSelectedId(e.target.value);
            }}
            disabled={busy}
          >
            <option value="">— เลือกผู้จัดการ —</option>
            {candidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.username ? `${c.displayName} (${c.username})` : c.displayName}
              </option>
            ))}
          </Select>
        </div>
        {statusBlock}
      </div>
    );
  }

  return (
    <div className="stg-card" data-testid="privileged-lockout-recovery-card">
      <div className="stg-card-head">
        <i className="ti ti-lock-open" aria-hidden="true" /> {LOCKOUT_RECOVERY_COPY.title}
      </div>
      <div className="stg-card-body">{body}</div>
    </div>
  );
}
