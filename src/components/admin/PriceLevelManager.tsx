import { useState } from 'react';
import type { PriceLevelRow } from '../../lib/settings/types';
import '../../pages/SettingsPage.css';

type Props = {
  priceLevels: PriceLevelRow[];
  setPriceLevels: (rows: PriceLevelRow[]) => void;
  showToast?: (msg: string, type?: 'success' | 'info' | 'warn') => void;
};

type TierFormData = { name: string; code: string; desc: string };

const EMPTY_TIER_FORM: TierFormData = { name: '', code: '', desc: '' };

/**
 * Reusable Price Level (Tier) table + add/edit controls. Extracted from the
 * Settings page so the same UI can back the dedicated admin Tier Management page.
 *
 * Adding a tier opens a modal dialog (Name / Code / Description) — the "สถานะ"
 * (Status) column/field is intentionally omitted; `isActive`/`isGlobal` are still
 * defaulted on new rows. Existing rows stay inline-editable in the table.
 */
export default function PriceLevelManager({ priceLevels, setPriceLevels, showToast }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [tierForm, setTierForm] = useState<TierFormData>(EMPTY_TIER_FORM);

  const openAddDialog = () => {
    setTierForm(EMPTY_TIER_FORM);
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setTierForm(EMPTY_TIER_FORM);
  };

  const setField = (key: keyof TierFormData, val: string) =>
    setTierForm((f) => ({ ...f, [key]: val }));

  const handleAddTier = () => {
    const name = tierForm.name.trim();
    const code = tierForm.code.trim().toUpperCase();
    if (!name || !code) {
      showToast?.('กรุณาระบุชื่อระดับและรหัส', 'warn');
      return;
    }
    if (priceLevels.some((p) => p.code.toUpperCase() === code)) {
      showToast?.('รหัสนี้ถูกใช้แล้ว', 'warn');
      return;
    }
    const id = `pl_${Date.now().toString(36)}`;
    setPriceLevels([
      ...priceLevels,
      {
        id,
        name,
        code,
        order: priceLevels.length + 1,
        isActive: true,
        isGlobal: true,
        branchId: null,
        desc: tierForm.desc.trim(),
      },
    ]);
    showToast?.('เพิ่มระดับราคาแล้ว', 'success');
    closeDialog();
  };

  const removePriceLevel = (id: string) => {
    if (priceLevels.length <= 1) {
      showToast?.('ต้องมีอย่างน้อย 1 ระดับ', 'warn');
      return;
    }
    setPriceLevels(priceLevels.filter((p) => p.id !== id));
  };

  const updatePriceLevel = (id: string, patch: Partial<PriceLevelRow>) => {
    setPriceLevels(priceLevels.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  return (
    <div className="stg-card">
      <div className="stg-card-head">
        <i className="ti ti-layers-difference" aria-hidden="true" /> ระดับราคาทั้งหมด
        <div className="stg-card-head-right">
          <button type="button" className="stg-btn stg-btn-primary" onClick={openAddDialog}>
            <i className="ti ti-plus" aria-hidden="true" /> เพิ่มระดับราคา
          </button>
        </div>
      </div>
      <div className="stg-card-body stg-card-body-flush">
        <table className="stg-price-table">
          <thead>
            <tr>
              <th>ชื่อระดับ</th>
              <th>รหัส</th>
              <th>คำอธิบาย</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {priceLevels.map((p) => (
              <tr key={p.id}>
                <td>
                  <input className="stg-form-input stg-input-inline" value={p.name} onChange={(e) => updatePriceLevel(p.id, { name: e.target.value })} />
                </td>
                <td><span className="stg-code">{p.code}</span></td>
                <td>
                  <input className="stg-form-input stg-input-inline" value={p.desc} onChange={(e) => updatePriceLevel(p.id, { desc: e.target.value })} />
                </td>
                <td>
                  <button type="button" className="stg-icon-btn" onClick={() => removePriceLevel(p.id)} title="ลบ">
                    <i className="ti ti-trash" style={{ fontSize: 14, color: 'var(--danger)' }} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add Tier Modal — mirrors the Settings page's existing modal pattern */}
      {dialogOpen ? (
        <div className="stg-modal-overlay open" role="dialog" aria-modal="true" onClick={closeDialog}>
          <div className="stg-modal" onClick={(e) => e.stopPropagation()}>
            <div className="stg-modal-header">
              <span className="stg-modal-title">เพิ่มระดับราคา</span>
              <button type="button" className="stg-icon-btn" onClick={closeDialog} aria-label="ปิด">
                <i className="ti ti-x" aria-hidden="true" />
              </button>
            </div>
            <div className="stg-modal-body">
              <div className="stg-form-group">
                <label className="stg-form-label">ชื่อระดับ *</label>
                <input
                  className="stg-form-input"
                  value={tierForm.name}
                  autoFocus
                  onChange={(e) => setField('name', e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddTier()}
                  placeholder="เช่น ราคาส่ง, ราคาตัวแทน"
                />
              </div>
              <div className="stg-form-group" style={{ marginTop: 8 }}>
                <label className="stg-form-label">รหัส *</label>
                <input
                  className="stg-form-input"
                  value={tierForm.code}
                  onChange={(e) => setField('code', e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddTier()}
                  placeholder="เช่น WHOLESALE, AGENT"
                />
              </div>
              <div className="stg-form-group" style={{ marginTop: 8 }}>
                <label className="stg-form-label">คำอธิบาย</label>
                <input
                  className="stg-form-input"
                  value={tierForm.desc}
                  onChange={(e) => setField('desc', e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddTier()}
                  placeholder="คำอธิบายเพิ่มเติม (ไม่บังคับ)"
                />
              </div>
            </div>
            <div className="stg-modal-footer">
              <button type="button" className="stg-btn stg-btn-ghost" onClick={closeDialog}>
                ยกเลิก
              </button>
              <button type="button" className="stg-btn stg-btn-primary" onClick={handleAddTier}>
                <i className="ti ti-check" aria-hidden="true" /> เพิ่มระดับ
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
