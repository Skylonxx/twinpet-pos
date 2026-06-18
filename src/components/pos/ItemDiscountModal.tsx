import { useEffect, useState } from 'react';
import type { CartLine, ItemDiscountType } from '../../lib/pos/types';
import { formatMoney, IDP_LABELS } from '../../lib/pos/cartUtils';
import NumpadDialog from './NumpadDialog';

type ItemDiscountModalProps = {
  line: CartLine | null;
  onSave: (type: ItemDiscountType, val: number) => void;
  onClose: () => void;
};

type IdpMode = Exclude<ItemDiscountType, 'none'>;

export default function ItemDiscountModal({
  line,
  onSave,
  onClose,
}: ItemDiscountModalProps) {
  const [mode, setMode] = useState<IdpMode>('disc_thb');
  const [value, setValue] = useState('');
  // UI-06 hotfix Fix 2: the value field opens the custom on-screen numpad on touch (like the
  // bill-discount field) instead of falling back to the native mobile keyboard.
  const [numpadOpen, setNumpadOpen] = useState(false);

  useEffect(() => {
    if (!line) return;
    if (line.discount.type !== 'none') {
      setMode(line.discount.type as IdpMode);
      setValue(String(line.discount.val || ''));
    } else {
      setMode('disc_thb');
      setValue('');
    }
  }, [line]);

  if (!line) return null;

  const base = line.unitPrice * line.qty;
  const num = parseFloat(value) || 0;
  let preview = base;
  if (mode === 'disc_thb') preview = Math.max(0, base - num);
  else if (mode === 'disc_pct') preview = Math.max(0, base * (1 - num / 100));
  else if (mode === 'override') preview = Math.max(0, num * line.qty);

  return (
    <div className="pos-modal-bg" role="dialog" aria-modal="true">
      <div className="pos-item-disc-popup">
        <div>
          <div className="pos-idp-title">แก้ไขราคา / ส่วนลดรายชิ้น</div>
          <div className="pos-idp-prod">{line.productName}</div>
        </div>
        <div className="pos-idp-tabs">
          {(['disc_thb', 'disc_pct', 'override'] as IdpMode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={`pos-idp-tab${mode === m ? ' on' : ''}`}
              onClick={() => {
                setMode(m);
                setValue('');
              }}
            >
              {m === 'disc_thb' ? 'ลด ฿' : m === 'disc_pct' ? 'ลด %' : 'แก้ราคา'}
            </button>
          ))}
        </div>
        <div className="pos-idp-input-wrap">
          <div className="pos-idp-input-lbl">{IDP_LABELS[mode]}</div>
          <input
            className="pos-idp-input"
            type="number"
            min={0}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onPointerDown={(e) => {
              // Touch/click opens the custom POS numpad instead of the native mobile keyboard,
              // mirroring the bill-discount field. preventDefault suppresses (does not force)
              // native focus so the dialog isn't fighting an on-screen keyboard; physical keyboard
              // (Tab) editing of the field still works for desktop. Discount math is unchanged --
              // the numpad only writes back into `value`, which onSave already parses.
              e.preventDefault();
              setNumpadOpen(true);
            }}
          />
        </div>
        <div className="pos-idp-result">
          <span className="pos-idp-result-lbl">ราคาหลังปรับ</span>
          <span className="pos-idp-result-val">฿{formatMoney(preview)}</span>
        </div>
        <div className="pos-idp-actions">
          <button type="button" className="pos-idp-cancel" onClick={onClose}>
            ยกเลิก
          </button>
          <button
            type="button"
            className="pos-idp-save"
            onClick={() => {
              onSave(num > 0 ? mode : 'none', num);
              onClose();
            }}
          >
            บันทึก
          </button>
        </div>
      </div>

      {/* UI-06 hotfix Fix 2: custom on-screen numpad for the value field. Reuses the touch-only
          NumpadDialog in decimal/zero mode so it accepts the same values the field parses
          (`parseFloat(...) || 0`). It portals above this modal and writes back into `value` only --
          no discount math, no auto-submit (the existing Save button still applies the discount). */}
      <NumpadDialog
        open={numpadOpen}
        title={IDP_LABELS[mode]}
        initialValue={num}
        allowDecimal
        allowZero
        maxLength={7}
        onClose={() => setNumpadOpen(false)}
        onConfirm={(v) => {
          setValue(String(v));
          setNumpadOpen(false);
        }}
      />
    </div>
  );
}
