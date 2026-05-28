import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  open: boolean;
  units: string[];
  saving: boolean;
  onSave: (units: string[]) => Promise<void>;
  onClose: () => void;
};

export default function UnitManagerModal({ open, units, saving, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<string[]>(units);
  const [newUnit, setNewUnit] = useState('');

  useEffect(() => {
    if (open) {
      setDraft(units);
      setNewUnit('');
    }
  }, [open, units]);

  if (!open) return null;

  const addUnit = () => {
    const name = newUnit.trim();
    if (!name || draft.includes(name)) return;
    setDraft((prev) => [...prev, name]);
    setNewUnit('');
  };

  const removeUnit = (name: string) => {
    if (draft.length <= 1) return;
    setDraft((prev) => prev.filter((u) => u !== name));
  };

  return createPortal(
    <div className="pc-modal-overlay pc-modal-overlay--stack" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="pc-unit-mgr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pc-unit-mgr-head">
          <div>
            <div className="pc-unit-mgr-title">จัดการหน่วยนับ</div>
            <div className="pc-unit-mgr-sub">เพิ่มหรือลบชื่อหน่วยนับที่ใช้ในระบบ</div>
          </div>
          <button type="button" className="pc-fifo-close" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" style={{ fontSize: 12 }} aria-hidden="true" />
          </button>
        </div>

        <div className="pc-unit-mgr-body">
          <div className="pc-unit-add-row">
            <input
              className="pc-unit-add-input"
              value={newUnit}
              placeholder="ชื่อหน่วยใหม่ เช่น ลัง, ถุง"
              onChange={(e) => setNewUnit(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addUnit()}
            />
            <button type="button" className="pc-unit-add-btn" onClick={addUnit} disabled={!newUnit.trim()}>
              <i className="ti ti-plus" aria-hidden="true" /> เพิ่ม
            </button>
          </div>

          <ul className="pc-unit-list">
            {draft.map((name) => (
              <li key={name} className="pc-unit-list-item">
                <span>{name}</span>
                <button
                  type="button"
                  className="pc-unit-del-btn"
                  onClick={() => removeUnit(name)}
                  disabled={draft.length <= 1}
                  aria-label={`ลบ ${name}`}
                >
                  <i className="ti ti-trash" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="pc-unit-mgr-footer">
          <button type="button" className="pc-close-modal-btn" onClick={onClose}>
            ยกเลิก
          </button>
          <button
            type="button"
            className="pc-unit-save-btn"
            disabled={saving}
            onClick={() => void onSave(draft).then(onClose)}
          >
            {saving ? 'กำลังบันทึก...' : 'บันทึก'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
