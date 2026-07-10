import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fmtBaht } from '../../lib/dashboard/format';
import {
  calcShiftDrawerExpected,
  closeShift,
  getActiveShift,
  openShift,
  type ShiftCloseConfirmation,
} from '../../lib/pos/shiftService';
import { SHIFT_CLOSE_INTENT_STALE_AGE_MS } from '../../lib/pos/offline/shiftCloseIntentTypes';
import type { Shift } from '../../lib/types';
import './ShiftModals.css';

type OpenShiftModalProps = {
  branchId: string;
  staffId: string;
  staffName: string;
  onSuccess: (shift: Shift) => void;
};

export function OpenShiftModal({
  branchId,
  staffId,
  staffName,
  onSuccess,
}: OpenShiftModalProps) {
  const [startingCash, setStartingCash] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpen = useCallback(async () => {
    const cash = parseFloat(startingCash) || 0;
    if (cash < 0) {
      setError('กรุณาระบุเงินทอนเริ่มต้นที่ถูกต้อง');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await openShift(branchId, staffId, staffName, cash);
      const shift = await getActiveShift(branchId, staffId);
      if (!shift) {
        throw new Error('เปิดกะไม่สำเร็จ');
      }
      onSuccess(shift);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'เปิดกะไม่สำเร็จ');
    } finally {
      setSubmitting(false);
    }
  }, [branchId, staffId, staffName, startingCash, onSuccess]);

  return createPortal(
    <div className="shift-modal-bg" role="dialog" aria-modal="true" aria-label="เปิดกะ">
      <div className="shift-modal">
        <div className="shift-modal-icon" aria-hidden="true">
          <i className="ti ti-clock-play" />
        </div>
        <div>
          <h2 className="shift-modal-title">เปิดกะขาย</h2>
          <p className="shift-modal-sub">
            กรุณาระบุเงินทอนเริ่มต้นในลิ้นชักก่อนเริ่มขาย
            <br />
            พนักงาน: {staffName}
          </p>
        </div>
        <div className="shift-modal-field">
          <label className="shift-modal-label" htmlFor="shift-start-cash">
            เงินทอนเริ่มต้น (Starting Cash)
          </label>
          <input
            id="shift-start-cash"
            className="shift-modal-input"
            type="number"
            min={0}
            step="0.01"
            placeholder="0.00"
            value={startingCash}
            onChange={(e) => setStartingCash(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleOpen();
            }}
          />
        </div>
        {error && <p className="shift-modal-error">{error}</p>}
        <div className="shift-modal-actions">
          <button
            type="button"
            className="shift-modal-btn shift-modal-btn--primary"
            disabled={submitting}
            onClick={() => void handleOpen()}
          >
            {submitting ? 'กำลังเปิดกะ...' : 'เปิดกะ'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Packet 7C-B2 — boot fail-closed / attention state (fixes the RC-3 boot-guard
 * fail-open gap). Rendered by `POSPage.tsx` INSTEAD OF `OpenShiftModal` when the
 * local close-intent store could not be read at boot: the app cannot safely
 * prove whether the cached shift is already closed on this device, so it must
 * neither re-open the (possibly already-closed) drawer nor offer to open a
 * replacement shift (which would risk a duplicate open). Purely a render
 * guard — it never mutates shift state itself.
 */
type ShiftBootBlockedModalProps = {
  onRetry: () => void;
};

export function ShiftBootBlockedModal({ onRetry }: ShiftBootBlockedModalProps) {
  return createPortal(
    <div className="shift-modal-bg" role="dialog" aria-modal="true" aria-label="ไม่สามารถยืนยันสถานะกะได้">
      <div className="shift-modal">
        <div className="shift-modal-icon" aria-hidden="true">
          <i className="ti ti-alert-triangle" />
        </div>
        <div>
          <h2 className="shift-modal-title">ไม่สามารถยืนยันสถานะกะได้</h2>
          <p className="shift-modal-sub">
            ระบบไม่สามารถตรวจสอบสถานะการปิดกะล่าสุดในเครื่องนี้ได้ในขณะนี้
            เพื่อความปลอดภัย ระบบจะยังไม่เปิดลิ้นชักเดิมหรือให้เปิดกะใหม่ จนกว่าจะตรวจสอบได้
          </p>
        </div>
        <div className="shift-modal-actions">
          <button
            type="button"
            className="shift-modal-btn shift-modal-btn--primary"
            onClick={onRetry}
          >
            ลองตรวจสอบอีกครั้ง
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type CloseShiftModalProps = {
  shift: Shift;
  onClose: () => void;
  onSuccess: () => void;
  /**
   * Read-only, THIS-terminal count of local sale-intents still waiting to sync
   * (Packet 7A). Presentation only — never gates `handleClose`/the confirm
   * button, and never touches shift totals, variance, or the close payload.
   */
  pendingSyncCount?: number;
  /** True when the oldest pending entry has aged past the sync-panel's stale threshold. */
  pendingSyncStale?: boolean;
};

/**
 * Packet 7C-B1 replaces the 7C-A hard offline block with the optimistic local
 * close path: `closeShift` now verifies from the local cache only and never
 * awaits the network, so it resolves quickly even while offline. The timeout
 * backstop is kept only as a defensive guard for the online-but-unreachable
 * edge (e.g. a hung IndexedDB open) — not as the primary offline path.
 */
const CLOSE_SHIFT_TIMEOUT_MESSAGE =
  'ปิดกะยังไม่สำเร็จ ระบบเชื่อมต่อมีปัญหา กรุณาตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง';
const CLOSE_SHIFT_TIMEOUT_MS = 10_000;
const CLOSE_SHIFT_TIMEOUT_MARKER = 'shift-close-timeout';

// Accepts the nullable `closedAt` as well as the non-null `openedAt` — the
// runtime guard below already returns the em-dash fallback for null/unresolved
// values, so the parameter type is widened to `Timestamp | null` (matching
// `Shift['closedAt']`) rather than silenced with an unsafe cast/`!` assertion.
function formatShiftTime(ts: Shift['closedAt']): string {
  if (!ts || typeof ts !== 'object' || !('toDate' in ts)) return '—';
  return (ts as { toDate: () => Date }).toDate().toLocaleString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDeviceTime(ms: number): string {
  return new Date(ms).toLocaleString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Packet 7C-B2 — resolved server `closedAt`, once confirmation-grade proof exists. */
function formatServerTime(d: Date): string {
  return d.toLocaleString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Packet 7C-B1: `closeShift` never awaits the shift-doc write, so the Z-report
 * always renders from a frozen local snapshot. While `closedOffline &&
 * syncState === 'pending'`, `closedAt` is honestly still queued (never
 * back-filled with a fake server time) — show the device-clock
 * `closedAtLocal` instead, clearly labeled as device time.
 *
 * Packet 7C-B2: once `confirmation` resolves to `confirmed`, prefer the
 * RESOLVED server `closedAt` it carries — this is the honest confirmation
 * signal, never available from the write-ack promise alone.
 */
function getClosedTimeLabel(shift: Shift, confirmation: ShiftCloseConfirmation | null): string {
  if (confirmation?.outcome === 'confirmed') {
    return formatServerTime(confirmation.closedAt);
  }
  const isSyncPending = shift.closedOffline === true && shift.syncState === 'pending';
  if (isSyncPending && typeof shift.closedAtLocal === 'number') {
    return `${formatDeviceTime(shift.closedAtLocal)} (เวลาเครื่อง)`;
  }
  return formatShiftTime(shift.closedAt);
}

function getVarianceDisplay(variance: number): {
  label: string;
  value: string;
  className: string;
} {
  const fmt = (n: number) => fmtBaht(n, { decimals: 2 });
  if (variance === 0) {
    return {
      label: 'ส่วนต่าง (ครบพอดี)',
      value: fmt(0),
      className: 'shift-zreport-row--variance-zero',
    };
  }
  if (variance > 0) {
    return {
      label: 'ส่วนต่าง (เงินเกิน)',
      value: `+${fmt(variance)}`,
      className: 'shift-zreport-row--variance-pos',
    };
  }
  return {
    label: 'ส่วนต่าง (เงินขาด)',
    value: `-${fmt(Math.abs(variance))}`,
    className: 'shift-zreport-row--variance-neg',
  };
}

/**
 * Packet 7C-B2 — derive the Z-report's sync badge state from the frozen shift
 * snapshot plus the (at most once-resolving) same-runtime confirmation handle.
 * `attention` covers both a genuine write rejection and a confirmed identity
 * mismatch — 7C-B2 only flags either; it never adjudicates or claims a fix.
 * `still_pending`/`unreachable` confirmation outcomes intentionally collapse
 * back into `pending`/`stale` — a later boot/reconnect sweep (not this mounted
 * component) is what retries them.
 */
type ShiftSyncBadgeState = 'none' | 'pending' | 'stale' | 'confirmed' | 'attention';

function getSyncBadgeState(
  shift: Shift,
  confirmation: ShiftCloseConfirmation | null,
  nowMs: number,
): ShiftSyncBadgeState {
  if (confirmation?.outcome === 'confirmed') return 'confirmed';
  if (confirmation?.outcome === 'identity_mismatch' || confirmation?.outcome === 'rejected') {
    return 'attention';
  }
  const isSyncPending = shift.closedOffline === true && shift.syncState === 'pending';
  if (!isSyncPending) return 'none';
  if (typeof shift.closedAtLocal === 'number' && nowMs - shift.closedAtLocal >= SHIFT_CLOSE_INTENT_STALE_AGE_MS) {
    return 'stale';
  }
  return 'pending';
}

function ZReportView({
  shift,
  confirmation,
  onPrint,
  onDone,
}: {
  shift: Shift;
  confirmation: ShiftCloseConfirmation | null;
  onPrint: () => void;
  onDone: () => void;
}) {
  const totalExpected = calcShiftDrawerExpected(shift);
  const varianceDisplay = getVarianceDisplay(shift.variance);
  const fmt = (n: number) => fmtBaht(n, { decimals: 2 });

  // Re-check staleness periodically while still pending/unconfirmed — a purely
  // computed display concern (`isStaleClosePending`'s age threshold), never a
  // stored transition. Stops ticking once a terminal outcome (confirmed/attention)
  // is known.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (confirmation?.outcome === 'confirmed' || confirmation?.outcome === 'identity_mismatch' || confirmation?.outcome === 'rejected') {
      return;
    }
    const id = setInterval(() => setNowTick(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [confirmation]);

  const badgeState = getSyncBadgeState(shift, confirmation, nowTick);

  return (
    <div className="shift-zreport">
      <div className="shift-zreport-head">
        <div className="shift-modal-icon" style={{ margin: '0 auto' }} aria-hidden="true">
          <i className="ti ti-report-analytics" />
        </div>
        <h2 className="shift-zreport-title">ปิดกะสำเร็จ — Z-Report</h2>
        <p className="shift-zreport-meta">
          {shift.staffName} · เปิดกะ {formatShiftTime(shift.openedAt)} · ปิดกะ{' '}
          {getClosedTimeLabel(shift, confirmation)}
        </p>
        {badgeState === 'pending' && (
          <div
            className="shift-zreport-sync-badge"
            role="status"
            data-testid="shift-zreport-sync-pending"
          >
            <i className="ti ti-cloud-off" aria-hidden="true" />
            <span>ปิดกะแล้ว (รอซิงก์) — บันทึกในเครื่องนี้แล้ว ยังไม่ได้รับการยืนยันจากเซิร์ฟเวอร์</span>
          </div>
        )}
        {badgeState === 'stale' && (
          <div
            className="shift-zreport-sync-badge shift-zreport-sync-badge--stale"
            role="status"
            data-testid="shift-zreport-sync-stale"
          >
            <i className="ti ti-alert-triangle" aria-hidden="true" />
            <span>รอซิงก์นานผิดปกติ — กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่</span>
          </div>
        )}
        {badgeState === 'confirmed' && (
          <div
            className="shift-zreport-sync-badge shift-zreport-sync-badge--confirmed"
            role="status"
            data-testid="shift-zreport-sync-confirmed"
          >
            <i className="ti ti-cloud-check" aria-hidden="true" />
            <span>ปิดกะแล้ว — เซิร์ฟเวอร์บันทึกเวลาปิดกะแล้ว</span>
          </div>
        )}
        {badgeState === 'attention' && (
          <div
            className="shift-zreport-sync-badge shift-zreport-sync-badge--attention"
            role="status"
            data-testid="shift-zreport-sync-attention"
          >
            <i className="ti ti-alert-octagon" aria-hidden="true" />
            <span>การปิดกะนี้ต้องตรวจสอบ — โปรดติดต่อผู้ดูแล</span>
          </div>
        )}
      </div>

      <div className="shift-zreport-grid">
        <div className="shift-zreport-section">สรุปเงินสด</div>
        <div className="shift-zreport-row">
          <span>เงินทอนเริ่มต้น</span>
          <strong>{fmt(shift.startingCash)}</strong>
        </div>
        <div className="shift-zreport-row">
          <span>ยอดขายเงินสด</span>
          <strong>{fmt(shift.expectedCash)}</strong>
        </div>
        {shift.payInTotal > 0 && (
          <div className="shift-zreport-row shift-zreport-row--pay-in">
            <span>นำเงินเข้า (Pay-in)</span>
            <strong>+{fmt(shift.payInTotal)}</strong>
          </div>
        )}
        {shift.payOutTotal > 0 && (
          <div className="shift-zreport-row shift-zreport-row--pay-out">
            <span>นำเงินออก (Pay-out)</span>
            <strong>-{fmt(shift.payOutTotal)}</strong>
          </div>
        )}
        <div className="shift-zreport-row shift-zreport-row--highlight">
          <span>ยอดเงินที่ต้องมีในลิ้นชัก</span>
          <strong>{fmt(totalExpected)}</strong>
        </div>
        <div className="shift-zreport-row">
          <span>นับเงินสดจริง</span>
          <strong>{fmt(shift.actualCashCount)}</strong>
        </div>
        <div
          className={`shift-zreport-row shift-zreport-row--highlight ${varianceDisplay.className}`}
        >
          <span>{varianceDisplay.label}</span>
          <strong>{varianceDisplay.value}</strong>
        </div>

        <div className="shift-zreport-section">ช่องทางชำระเงิน</div>
        <div className="shift-zreport-row">
          <span>PromptPay QR</span>
          <strong>{fmt(shift.expectedQr)}</strong>
        </div>
        <div className="shift-zreport-row">
          <span>QR KBank</span>
          <strong>{fmt(shift.expectedKbank)}</strong>
        </div>
        <div className="shift-zreport-row">
          <span>EDC บัตร</span>
          <strong>{fmt(shift.expectedCard)}</strong>
        </div>
        <div className="shift-zreport-row">
          <span>เงินเชื่อ</span>
          <strong>{fmt(shift.expectedCredit)}</strong>
        </div>
        <div className="shift-zreport-row">
          <span>จำนวนบิลทั้งหมด</span>
          <strong>{shift.totalBills} บิล</strong>
        </div>
      </div>

      <div className="shift-modal-actions">
        <button type="button" className="shift-modal-btn shift-modal-btn--ghost" onClick={onPrint}>
          พิมพ์ใบสรุปกะ
        </button>
        <button type="button" className="shift-modal-btn shift-modal-btn--primary" onClick={onDone}>
          ตกลง
        </button>
      </div>
    </div>
  );
}

export function CloseShiftModal({
  shift,
  onClose,
  onSuccess,
  pendingSyncCount = 0,
  pendingSyncStale = false,
}: CloseShiftModalProps) {
  const [actualCash, setActualCash] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closedShift, setClosedShift] = useState<Shift | null>(null);
  // Packet 7C-B2 — same-runtime confirmation state, observed (never awaited by
  // the close flow itself) from `closeShift`'s `whenServerConfirmed` handle.
  const [confirmation, setConfirmation] = useState<ShiftCloseConfirmation | null>(null);
  const closeAttemptRef = useRef(0);
  // Packet 7C-B2 (Codex remediation) — mounted guard for the late confirmation
  // observer. `whenServerConfirmed` resolves only AFTER the queued write ACKs
  // and a confirmation-grade server read completes, so it can settle long after
  // the cashier dismissed the Z-report (which unmounts this modal). Without this
  // guard, its `.then()` would call `setConfirmation()` on an unmounted tree.
  // This only suppresses the stale UI update; the underlying journal
  // reconciliation still runs inside `closeShift` regardless.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleClose = useCallback(async () => {
    const count = parseFloat(actualCash);
    if (Number.isNaN(count) || count < 0) {
      setError('กรุณาระบุจำนวนเงินสดที่นับได้');
      return;
    }

    const attemptId = ++closeAttemptRef.current;
    setSubmitting(true);
    setError(null);
    setConfirmation(null);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutGuard = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(CLOSE_SHIFT_TIMEOUT_MARKER)),
        CLOSE_SHIFT_TIMEOUT_MS,
      );
    });

    try {
      const result = await Promise.race([closeShift(shift, count, note.trim()), timeoutGuard]);
      if (closeAttemptRef.current !== attemptId) return;
      setClosedShift(result);
      // Observe-only: never gates the close success above. `whenServerConfirmed`
      // may be absent on a plain mocked/legacy result shape — guarded, not awaited.
      // The `mountedRef` + `attemptId` checks together ensure a late resolution
      // never updates state after unmount / report dismissal / a newer attempt.
      if (result.whenServerConfirmed) {
        void result.whenServerConfirmed.then((outcome) => {
          if (mountedRef.current && closeAttemptRef.current === attemptId) {
            setConfirmation(outcome);
          }
        });
      }
    } catch (err) {
      if (closeAttemptRef.current !== attemptId) return;
      if (err instanceof Error && err.message === CLOSE_SHIFT_TIMEOUT_MARKER) {
        setError(CLOSE_SHIFT_TIMEOUT_MESSAGE);
      } else {
        setError(err instanceof Error ? err.message : 'ปิดกะไม่สำเร็จ');
      }
    } finally {
      clearTimeout(timeoutId);
      if (closeAttemptRef.current === attemptId) setSubmitting(false);
    }
  }, [shift, actualCash, note]);

  const handlePrint = useCallback(() => {
    if (!closedShift) return;
    const totalExpected = calcShiftDrawerExpected(closedShift);
    const fmt = (n: number) => fmtBaht(n, { decimals: 2 });
    window.alert(
      `[Mock Print Z-Report]\n` +
        `พนักงาน: ${closedShift.staffName}\n` +
        `เงินทอนเริ่มต้น: ${fmt(closedShift.startingCash)}\n` +
        `ยอดขายเงินสด: ${fmt(closedShift.expectedCash)}\n` +
        (closedShift.payInTotal > 0 ? `นำเงินเข้า: +${fmt(closedShift.payInTotal)}\n` : '') +
        (closedShift.payOutTotal > 0 ? `นำเงินออก: -${fmt(closedShift.payOutTotal)}\n` : '') +
        `ยอดที่ต้องมีในลิ้นชัก: ${fmt(totalExpected)}\n` +
        `นับจริง: ${fmt(closedShift.actualCashCount)}\n` +
        `ส่วนต่าง: ${closedShift.variance >= 0 ? '+' : '-'}${fmt(Math.abs(closedShift.variance))}\n` +
        `บิล: ${closedShift.totalBills}`,
    );
  }, [closedShift]);

  return createPortal(
    <div
      className="shift-modal-bg"
      role="dialog"
      aria-modal="true"
      aria-label="ปิดกะ"
      onClick={(e) => {
        if (e.target === e.currentTarget && !closedShift) onClose();
      }}
    >
      <div className="shift-modal">
        {closedShift ? (
          <ZReportView
            shift={closedShift}
            confirmation={confirmation}
            onPrint={handlePrint}
            onDone={onSuccess}
          />
        ) : (
          <>
            <div className="shift-modal-icon" aria-hidden="true">
              <i className="ti ti-lock" />
            </div>
            <div>
              <h2 className="shift-modal-title">ปิดกะขาย</h2>
              <p className="shift-modal-sub">
                นับเงินสดในลิ้นชักและบันทึกผลก่อนปิดกะ
                <br />
                ยอดเงินที่ต้องมีในลิ้นชัก:{' '}
                {fmtBaht(calcShiftDrawerExpected(shift), { decimals: 2 })}
              </p>
            </div>
            {pendingSyncCount > 0 && (
              <div
                className={`shift-close-warning${pendingSyncStale ? ' shift-close-warning--stale' : ''}`}
                role="status"
                data-testid="shift-close-pending-warning"
              >
                <i className="ti ti-device-desktop-cog" aria-hidden="true" />
                <div>
                  {pendingSyncStale ? (
                    <>
                      <strong>มีบิลรอซิงก์นานผิดปกติจากเครื่องนี้ {pendingSyncCount} บิล</strong>
                      <p>กรุณาตรวจสอบสถานะซิงก์ก่อนปิดกะ</p>
                    </>
                  ) : (
                    <>
                      <strong>มีบิลรอซิงก์จากเครื่องนี้ {pendingSyncCount} บิล</strong>
                      <p>บิลเหล่านี้บันทึกในเครื่องแล้ว แต่อาจยังไม่ซิงก์ขึ้นระบบ กรุณาตรวจสอบก่อนปิดกะ</p>
                    </>
                  )}
                </div>
              </div>
            )}
            <div className="shift-modal-field">
              <label className="shift-modal-label" htmlFor="shift-actual-cash">
                นับเงินสดในลิ้นชัก (Actual Cash in Drawer)
              </label>
              <input
                id="shift-actual-cash"
                className="shift-modal-input"
                type="number"
                min={0}
                step="0.01"
                placeholder="0.00"
                value={actualCash}
                onChange={(e) => setActualCash(e.target.value)}
                autoFocus
              />
            </div>
            <div className="shift-modal-field">
              <label className="shift-modal-label" htmlFor="shift-close-note">
                หมายเหตุ (Note)
              </label>
              <textarea
                id="shift-close-note"
                className="shift-modal-textarea"
                placeholder="ไม่บังคับ"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            {error && <p className="shift-modal-error">{error}</p>}
            <div className="shift-modal-actions">
              <button
                type="button"
                className="shift-modal-btn shift-modal-btn--ghost"
                disabled={submitting}
                onClick={onClose}
              >
                ยกเลิก
              </button>
              <button
                type="button"
                className="shift-modal-btn shift-modal-btn--primary"
                disabled={submitting}
                onClick={() => void handleClose()}
              >
                {submitting ? 'กำลังปิดกะ...' : 'ปิดกะ'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
