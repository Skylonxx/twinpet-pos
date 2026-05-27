import { createPortal } from 'react-dom';

type Props = {
  open: boolean;
  productName: string;
  saving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ProductSaveConfirmDialog({
  open,
  productName,
  saving,
  onConfirm,
  onCancel,
}: Props) {
  if (!open) return null;

  return createPortal(
    <div className="pc-modal-overlay" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="pc-save-confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pc-save-confirm-icon">
          <i className="ti ti-device-floppy" aria-hidden="true" />
        </div>
        <div className="pc-save-confirm-title">ยืนยันการบันทึกข้อมูลสินค้าใช่หรือไม่?</div>
        <div className="pc-save-confirm-name">{productName || '—'}</div>
        <div className="pc-save-confirm-actions">
          <button type="button" className="pc-close-modal-btn" onClick={onCancel} disabled={saving}>
            ยกเลิก
          </button>
          <button type="button" className="pc-save-confirm-btn" onClick={onConfirm} disabled={saving}>
            {saving ? 'กำลังบันทึก...' : 'ยืนยันบันทึก'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
