import { useCallback, useEffect, useState } from 'react';
import { useExpiryPolicies } from '../../lib/inventory/useExpiryPolicies';
import type { ExpiryPolicy } from '../../lib/inventory/expiryPolicyTypes';

function newPolicyId(): string {
  return `exp-${Date.now()}`;
}

export default function ExpiryPolicySettings() {
  const { policies, saving, savePolicies } = useExpiryPolicies();
  const [draft, setDraft] = useState<ExpiryPolicy[]>(policies);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft(policies);
    setDirty(false);
  }, [policies]);

  const syncDraft = useCallback((next: ExpiryPolicy[]) => {
    setDraft(next);
    setDirty(true);
  }, []);

  const updateRow = (id: string, patch: Partial<ExpiryPolicy>) => {
    syncDraft(
      draft.map((p) => {
        if (p.id !== id) return p;
        return { ...p, ...patch };
      }),
    );
  };

  const setDefault = (id: string) => {
    syncDraft(draft.map((p) => ({ ...p, isDefault: p.id === id })));
  };

  const addPolicy = () => {
    syncDraft([
      ...draft,
      {
        id: newPolicyId(),
        name: 'นโยบายใหม่',
        warningDays: 30,
        criticalDays: 7,
      },
    ]);
  };

  const removePolicy = (id: string) => {
    if (draft.length <= 1) return;
    const next = draft.filter((p) => p.id !== id);
    if (!next.some((p) => p.isDefault)) {
      next[0]!.isDefault = true;
    }
    syncDraft(next);
  };

  const handleSave = async () => {
    const cleaned = draft.map((p) => ({
      ...p,
      name: p.name.trim() || 'ไม่มีชื่อ',
      warningDays: Math.max(0, Math.round(p.warningDays)),
      criticalDays: Math.max(0, Math.round(p.criticalDays)),
    }));
    await savePolicies(cleaned);
    setDirty(false);
  };

  const handleReset = () => {
    setDraft(policies);
    setDirty(false);
  };

  return (
    <>
      <div className="stg-section-title">นโยบายวันหมดอายุ</div>
      <div className="stg-section-sub">
        กำหนดช่วงเตือนล่วงหน้าก่อนวันหมดอายุ — ใช้คำนวณสถานะ Lot ใน FIFO Queue และกำหนดต่อสินค้าได้
      </div>
      <div className="stg-card">
        <div className="stg-card-head">
          <i className="ti ti-calendar-event" aria-hidden="true" /> นโยบายทั้งหมด
          <div className="stg-card-head-right">
            {dirty ? (
              <button type="button" className="stg-btn stg-btn-ghost stg-btn-sm" onClick={handleReset}>
                ยกเลิก
              </button>
            ) : null}
            <button
              type="button"
              className="stg-btn stg-btn-primary stg-btn-sm"
              disabled={!dirty || saving}
              onClick={() => void handleSave()}
            >
              {saving ? 'กำลังบันทึก…' : 'บันทึก'}
            </button>
          </div>
        </div>
        <div className="stg-card-body stg-card-body-flush">
          <table className="stg-uom-table">
            <thead>
              <tr>
                <th>ชื่อนโยบาย</th>
                <th>เฝ้าระวัง (วัน)</th>
                <th>วิกฤต (วัน)</th>
                <th>ค่าเริ่มต้น</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.map((p) => (
                <tr key={p.id}>
                  <td>
                    <input
                      className="stg-form-input stg-input-inline stg-input-w110"
                      value={p.name}
                      onChange={(e) => updateRow(p.id, { name: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      className="stg-form-input stg-input-inline stg-input-w80"
                      value={p.warningDays}
                      onChange={(e) => updateRow(p.id, { warningDays: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      className="stg-form-input stg-input-inline stg-input-w80"
                      value={p.criticalDays}
                      onChange={(e) => updateRow(p.id, { criticalDays: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <input
                        type="radio"
                        name="expiry-default"
                        checked={!!p.isDefault}
                        onChange={() => setDefault(p.id)}
                      />
                      ค่าเริ่มต้น
                    </label>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="stg-icon-btn"
                      title="ลบ"
                      disabled={draft.length <= 1}
                      onClick={() => removePolicy(p.id)}
                      style={{ opacity: draft.length <= 1 ? 0.3 : 1 }}
                    >
                      <i className="ti ti-trash" style={{ fontSize: 14, color: 'var(--danger)' }} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="stg-card-body">
          <button type="button" className="stg-btn stg-btn-ghost stg-btn-sm" onClick={addPolicy}>
            <i className="ti ti-plus" aria-hidden="true" /> เพิ่มนโยบาย
          </button>
          <p className="stg-section-sub" style={{ marginTop: 12, marginBottom: 0 }}>
            เมื่อ Lot เหลือ ≤ วันเฝ้าระวัง จะแสดงป้ายสีเหลือง เมื่อ ≤ วันวิกฤต จะแสดงป้ายสีแดง
            มอบหมายนโยบายต่อสินค้าได้ที่หน้าแก้ไขสินค้า (แท็บสต็อก)
          </p>
        </div>
      </div>
    </>
  );
}
