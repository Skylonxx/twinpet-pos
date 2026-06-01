import { useCallback, useState } from 'react';
import { useAuth } from '../../lib/hooks/useAuth';
import { useSettings } from '../../lib/settings/useSettings';
import PriceLevelManager from '../../components/admin/PriceLevelManager';
import '../SettingsPage.css';

/**
 * Dedicated admin page for managing Price Levels (tiers). Reuses the shared
 * {@link PriceLevelManager} table and the existing `useSettings` persistence
 * path (price levels are written to the `priceLevels` collection on save).
 */
export default function TierManagementPage() {
  const { branchId } = useAuth();
  const { priceLevels, setPriceLevels, loading, saving, save, cancel, isDirty } =
    useSettings(branchId);

  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'info' | 'warn' } | null>(
    null,
  );

  const showToast = useCallback(
    (msg: string, type: 'success' | 'info' | 'warn' = 'info') => {
      setToast({ msg, type });
      window.setTimeout(() => setToast(null), 2800);
    },
    [],
  );

  const handleSave = async () => {
    try {
      await save();
      showToast('บันทึกระดับราคาเรียบร้อย', 'success');
    } catch {
      showToast('บันทึกไม่สำเร็จ', 'warn');
    }
  };

  const handleCancel = () => {
    cancel();
    showToast('ยกเลิกการเปลี่ยนแปลง', 'info');
  };

  const dirty = isDirty();

  return (
    <div className="stg-page">
      <div className="stg-topbar">
        <div className="stg-topbar-icon">
          <i className="ti ti-layers-difference" aria-hidden="true" />
        </div>
        <div className="stg-topbar-center">
          <div className="stg-topbar-title">ระดับราคา (Price Level)</div>
          <div className="stg-topbar-sub">Tier Management — ใช้ร่วมกันทุกสินค้าและทุกสาขา</div>
        </div>
        <button type="button" className="stg-btn stg-btn-ghost" onClick={handleCancel} disabled={!dirty}>
          ยกเลิก
        </button>
        <button
          type="button"
          className="stg-btn stg-btn-primary"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          <i className="ti ti-check" aria-hidden="true" /> {saving ? 'กำลังบันทึก...' : 'บันทึก'}
        </button>
      </div>

      <div className="stg-body">
        <div className="stg-main">
          <div className="stg-section-title">ระดับราคาทั้งหมด</div>
          <div className="stg-section-sub">
            กำหนดระดับราคาที่ใช้ร่วมกันทุกสินค้า — สืบทอดไปยังทุกสาขา
          </div>
          {loading ? (
            <div className="stg-card">
              <div className="stg-card-body">กำลังโหลด...</div>
            </div>
          ) : (
            <PriceLevelManager
              priceLevels={priceLevels}
              setPriceLevels={setPriceLevels}
              showToast={showToast}
            />
          )}
        </div>
      </div>

      {toast ? (
        <div className="stg-toast-wrap">
          <div className={`stg-toast ${toast.type}`} role="status">
            {toast.msg}
          </div>
        </div>
      ) : null}
    </div>
  );
}
