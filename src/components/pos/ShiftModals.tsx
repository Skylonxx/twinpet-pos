import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { fmtBaht } from '../../lib/dashboard/format';
import { calcShiftDrawerExpected, closeShift, getActiveShift, openShift } from '../../lib/pos/shiftService';
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
            {submitting ? 'กำลังเปิดกะ...' : '✅ เปิดกะ'}
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
};

function formatShiftTime(ts: Shift['openedAt']): string {
  if (!ts || typeof ts !== 'object' || !('toDate' in ts)) return '—';
  return (ts as { toDate: () => Date }).toDate().toLocaleString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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

function ZReportView({
  shift,
  onPrint,
  onDone,
}: {
  shift: Shift;
  onPrint: () => void;
  onDone: () => void;
}) {
  const totalExpected = calcShiftDrawerExpected(shift);
  const varianceDisplay = getVarianceDisplay(shift.variance);
  const fmt = (n: number) => fmtBaht(n, { decimals: 2 });

  return (
    <div className="shift-zreport">
      <div className="shift-zreport-head">
        <div className="shift-modal-icon" style={{ margin: '0 auto' }} aria-hidden="true">
          <i className="ti ti-report-analytics" />
        </div>
        <h2 className="shift-zreport-title">ปิดกะสำเร็จ — Z-Report</h2>
        <p className="shift-zreport-meta">
          {shift.staffName} · เปิดกะ {formatShiftTime(shift.openedAt)}
        </p>
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
          🖨️ พิมพ์ใบสรุปกะ
        </button>
        <button type="button" className="shift-modal-btn shift-modal-btn--primary" onClick={onDone}>
          ✅ ตกลง
        </button>
      </div>
    </div>
  );
}

export function CloseShiftModal({ shift, onClose, onSuccess }: CloseShiftModalProps) {
  const [actualCash, setActualCash] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closedShift, setClosedShift] = useState<Shift | null>(null);

  const handleClose = useCallback(async () => {
    const count = parseFloat(actualCash);
    if (Number.isNaN(count) || count < 0) {
      setError('กรุณาระบุจำนวนเงินสดที่นับได้');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await closeShift(shift.id, count, note.trim());
      setClosedShift(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ปิดกะไม่สำเร็จ');
    } finally {
      setSubmitting(false);
    }
  }, [shift.id, actualCash, note]);

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
                {submitting ? 'กำลังปิดกะ...' : '🔒 ปิดกะ'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
