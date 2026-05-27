import { createPortal } from 'react-dom';
import './TransferConfirmDialog.css';

type Props = {
  open: boolean;
  itemCount: number;
  fromBranchLabel: string;
  toBranchLabel: string;
  saving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function TransferConfirmDialog({
  open,
  itemCount,
  fromBranchLabel,
  toBranchLabel,
  saving,
  onConfirm,
  onCancel,
}: Props) {
  if (!open) return null;

  return createPortal(
    <div className="inv-tr-modal-overlay" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="inv-tr-confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="inv-tr-confirm-icon">
          <i className="ti ti-arrows-exchange" aria-hidden="true" />
        </div>
        <div className="inv-tr-confirm-title">ยืนยันการโอนย้ายสต็อก</div>
        <div className="inv-tr-confirm-summary">
          โอนย้าย <strong>{itemCount}</strong> รายการ
        </div>
        <div className="inv-tr-confirm-route">
          {fromBranchLabel}
          <i className="ti ti-arrow-right" aria-hidden="true" />
          {toBranchLabel}
        </div>
        <div className="inv-tr-confirm-sub">
          สต็อกจะถูกหักจากสาขาต้นทางและเพิ่มในสาขาปลายทางทันที ยืนยันหรือไม่?
        </div>
        <div className="inv-tr-confirm-actions">
          <button type="button" className="inv-tr-confirm-cancel" onClick={onCancel} disabled={saving}>
            ยกเลิก
          </button>
          <button type="button" className="inv-tr-confirm-submit" onClick={onConfirm} disabled={saving}>
            {saving ? (
              <>
                <i className="ti ti-loader inv-tr-confirm-spin" aria-hidden="true" />
                กำลังบันทึก...
              </>
            ) : (
              'ยืนยัน'
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
