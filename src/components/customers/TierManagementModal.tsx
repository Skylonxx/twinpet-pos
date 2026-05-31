import { useEffect, useState } from 'react';
import {
  slugFromLevelName,
  usePriceLevels,
} from '../../lib/pricing/priceLevels';
import { DEFAULT_CUSTOMER_TIER } from '../../lib/types';

type Props = {
  open: boolean;
  onClose: () => void;
  onToast?: (msg: string, type?: 'success' | 'warn') => void;
};

export default function TierManagementModal({ open, onClose, onToast }: Props) {
  const { priceLevels: tiers, loading, saving, addLevel, removeLevel } = usePriceLevels();
  const [name, setName] = useState('');
  const [idInput, setIdInput] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setIdInput('');
    setDeletingId(null);
  }, [open]);

  if (!open) return null;

  const handleAdd = async () => {
    if (!name.trim()) {
      onToast?.('กรุณาระบุชื่อกลุ่มลูกค้า', 'warn');
      return;
    }
    try {
      await addLevel(name, idInput || undefined);
      setName('');
      setIdInput('');
      onToast?.('เพิ่มกลุ่มลูกค้าแล้ว');
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : 'เพิ่มกลุ่มไม่สำเร็จ', 'warn');
    }
  };

  const handleDelete = async (tierId: string) => {
    if (tierId === DEFAULT_CUSTOMER_TIER) {
      onToast?.('ไม่สามารถลบกลุ่ม retail ได้', 'warn');
      return;
    }
    setDeletingId(tierId);
    try {
      await removeLevel(tierId);
      onToast?.('ลบกลุ่มลูกค้าแล้ว');
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : 'ลบกลุ่มไม่สำเร็จ', 'warn');
    } finally {
      setDeletingId(null);
    }
  };

  const previewId = idInput.trim() || (name.trim() ? slugFromLevelName(name) : '');

  return (
    <div className="cm-dialog-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="cm-dialog cm-dialog-form cm-tier-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="cm-dialog-header cm-dialog-header-premium">
          <div>
            <span className="cm-dialog-title">จัดการกลุ่มลูกค้า</span>
            <span className="cm-dialog-subtitle">Customer Tiers — ใช้กำหนดราคาพิเศษและ CRM</span>
          </div>
          <button type="button" className="cm-icon-btn" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <div className="cm-dialog-body cm-dialog-body-form">
          <section className="cm-form-section">
            <div className="cm-form-section-title">
              <i className="ti ti-plus" aria-hidden="true" />
              เพิ่มกลุ่มใหม่
            </div>
            <div className="cm-form-row">
              <div className="cm-form-group">
                <label className="cm-form-label">
                  ชื่อกลุ่ม <span className="cm-form-required">*</span>
                </label>
                <input
                  className="cm-form-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="เช่น ขายส่ง, ลูกค้า VIP"
                />
              </div>
              <div className="cm-form-group">
                <label className="cm-form-label">รหัส (ID)</label>
                <input
                  className="cm-form-input"
                  value={idInput}
                  onChange={(e) => setIdInput(e.target.value)}
                  placeholder="ว่างไว้เพื่อสร้างอัตโนมัติ"
                />
                {previewId ? (
                  <p className="cm-form-hint">รหัสที่จะใช้: <code>{previewId}</code></p>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              className="cm-btn cm-btn-primary cm-btn-sm"
              disabled={saving || !name.trim()}
              onClick={() => void handleAdd()}
            >
              ➕ เพิ่มกลุ่ม
            </button>
          </section>

          <div className="cm-form-divider" />

          <section className="cm-form-section">
            <div className="cm-form-section-title">
              <i className="ti ti-list" aria-hidden="true" />
              กลุ่มลูกค้าทั้งหมด
            </div>
            {loading ? (
              <p className="cm-form-hint">กำลังโหลด...</p>
            ) : (
              <div className="cm-tier-table-wrap">
                <table className="cm-tier-table">
                  <thead>
                    <tr>
                      <th>ชื่อ</th>
                      <th>รหัส (ID)</th>
                      <th style={{ width: 56, textAlign: 'right' }}>ลบ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tiers.map((tier) => {
                      const isRetail = tier.id === DEFAULT_CUSTOMER_TIER;
                      return (
                        <tr key={tier.id}>
                          <td>{tier.name}</td>
                          <td>
                            <code className="cm-tier-id">{tier.id}</code>
                            {isRetail ? (
                              <span className="cm-tier-default-tag">ค่าเริ่มต้น</span>
                            ) : null}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {isRetail ? (
                              <span className="cm-form-hint">—</span>
                            ) : (
                              <button
                                type="button"
                                className="cm-icon-btn danger"
                                title="ลบกลุ่ม"
                                disabled={saving || deletingId === tier.id}
                                onClick={() => void handleDelete(tier.id)}
                              >
                                🗑️
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div className="cm-dialog-footer cm-dialog-footer-premium">
          <button type="button" className="cm-btn cm-btn-ghost" onClick={onClose}>
            ปิด
          </button>
        </div>
      </div>
    </div>
  );
}
