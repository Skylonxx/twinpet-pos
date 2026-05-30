import { useState } from 'react';
import { createPortal } from 'react-dom';
import './TransferModals.css';

type Props = {
  open: boolean;
  transferId: string;
  saving: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
};

/** Confirmation dialog for cancelling a transfer — requires a reason. */
export default function TransferCancelDialog({
  open,
  transferId,
  saving,
  onConfirm,
  onClose,
}: Props) {
  // Parent remounts via `key` on open, so a fresh initial value is enough.
  const [reason, setReason] = useState('');

  if (!open) return null;

  const canConfirm = reason.trim().length > 0 && !saving;

  return createPortal(
    <div className="tr-modal-overlay" role="dialog" aria-modal="true" onClick={() => !saving && onClose()}>
      <div className="tr-modal" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="tr-modal-head">
          <span className="tr-modal-head-id">ยกเลิกการโอนย้าย</span>
          <span className="tr-modal-head-spacer" />
          <button
            type="button"
            className="tr-modal-close"
            onClick={onClose}
            disabled={saving}
            aria-label="ปิด"
          >
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <div className="tr-modal-body">
          <div className="tr-meta-row">
            <span>เอกสาร</span>
            <strong>{transferId}</strong>
          </div>
          <div className="tr-warn">
            <i className="ti ti-alert-triangle" aria-hidden="true" /> การยกเลิกจะคืนสต็อกกลับสาขาต้นทาง
            (ตามต้นทุนเดิม) และตัดออกจากสาขาปลายทาง หากสาขาปลายทางขายสินค้าไปแล้วและสต็อกไม่พอ
            ระบบจะไม่อนุญาตให้ยกเลิก
          </div>
          <div className="tr-cancel-field">
            <label htmlFor="tr-cancel-reason">เหตุผลการยกเลิก *</label>
            <textarea
              id="tr-cancel-reason"
              rows={3}
              placeholder="ระบุเหตุผล..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        <div className="tr-modal-footer">
          <button type="button" className="tr-btn tr-btn-ghost" onClick={onClose} disabled={saving}>
            ย้อนกลับ
          </button>
          <span className="tr-spacer" />
          <button
            type="button"
            className="tr-btn tr-btn-danger"
            onClick={() => onConfirm(reason.trim())}
            disabled={!canConfirm}
          >
            {saving ? (
              <>
                <i className="ti ti-loader tr-spin" aria-hidden="true" /> กำลังยกเลิก...
              </>
            ) : (
              <>
                <i className="ti ti-ban" aria-hidden="true" /> ยืนยันการยกเลิก
              </>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
