import type { PosProduct, UomOption } from '../../lib/pos/types';
import { formatMoney } from '../../lib/pos/cartUtils';

type UomModalProps = {
  product: PosProduct | null;
  onSelect: (option: UomOption) => void;
  onClose: () => void;
};

export default function UomModal({ product, onSelect, onClose }: UomModalProps) {
  if (!product) return null;

  return (
    <div className="pos-modal-bg" role="dialog" aria-modal="true">
      <div className="pos-uom-popup">
        <div>
          <div className="pos-uom-popup-title">{product.name}</div>
          <div className="pos-uom-popup-sub">กรุณาเลือกหน่วยนับก่อนเพิ่มลงตะกร้า</div>
        </div>
        <div className="pos-uom-options">
          {product.uomOptions.map((opt) => (
            <button
              key={opt.unit}
              type="button"
              className="pos-uom-opt"
              onClick={() => onSelect(opt)}
            >
              <div className="pos-uom-opt-left">
                <div className="pos-uom-opt-name">{opt.unit}</div>
                <div className="pos-uom-opt-eq">
                  {opt.factor === 1 ? 'หน่วยฐาน' : `= ${opt.factor} ${product.baseUnit}`}
                </div>
              </div>
              <div className="pos-uom-opt-price">฿{formatMoney(opt.price)}</div>
            </button>
          ))}
        </div>
        <button type="button" className="pos-uom-cancel" onClick={onClose}>
          ยกเลิก
        </button>
      </div>
    </div>
  );
}
