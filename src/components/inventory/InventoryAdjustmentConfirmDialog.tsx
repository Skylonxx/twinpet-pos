import { createPortal } from 'react-dom';
import { formatValueImpact } from '../../lib/inventory/types';
import './InventoryAdjustmentConfirmDialog.css';

type Props = {
  open: boolean;
  itemCount: number;
  totalValueImpact: number;
  saving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function InventoryAdjustmentConfirmDialog({
  open,
  itemCount,
  totalValueImpact,
  saving,
  onConfirm,
  onCancel,
}: Props) {
  if (!open) return null;

  const impactClass =
    totalValueImpact < 0 ? 'inv-adj-confirm-impact-neg' : totalValueImpact > 0 ? 'inv-adj-confirm-impact-pos' : '';

  return createPortal(
    <div className="inv-adj-modal-overlay" role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="inv-adj-confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="inv-adj-confirm-icon">
          <i className="ti ti-box-seam" aria-hidden="true" />
        </div>
        <div className="inv-adj-confirm-title">ยืนยันการปรับปรุงสต็อก</div>
        <div className="inv-adj-confirm-summary">
          คุณกำลังปรับปรุงยอดสต็อกจำนวน <strong>{itemCount}</strong> รายการ
        </div>
        <div className={`inv-adj-confirm-impact ${impactClass}`}>
          มูลค่าผลกระทบรวม: {formatValueImpact(totalValueImpact)}
        </div>
        <div className="inv-adj-confirm-sub">
          การปรับปรุงนี้จะส่งผลต่อจำนวนสินค้าและมูลค่าต้นทุนทันที ยืนยันหรือไม่?
        </div>
        <div className="inv-adj-confirm-actions">
          <button type="button" className="inv-adj-confirm-cancel" onClick={onCancel} disabled={saving}>
            ยกเลิก
          </button>
          <button type="button" className="inv-adj-confirm-submit" onClick={onConfirm} disabled={saving}>
            {saving ? (
              <>
                <i className="ti ti-loader inv-adj-confirm-spin" aria-hidden="true" />
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
