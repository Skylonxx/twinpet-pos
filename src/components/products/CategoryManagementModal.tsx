import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import '../../pages/CustomerPage.css';
import {
  slugFromCategoryName,
  useCategories,
} from '../../lib/inventory/categoryService';

const DEFAULT_CATEGORY_ID = 'general';

type Props = {
  open: boolean;
  onClose: () => void;
  onToast?: (msg: string, type?: 'success' | 'warn') => void;
};

export default function CategoryManagementModal({ open, onClose, onToast }: Props) {
  const { categories, loading, saving, addCategory, removeCategory } = useCategories();
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
      onToast?.('กรุณาระบุชื่อหมวดหมู่', 'warn');
      return;
    }
    try {
      await addCategory(name, idInput || undefined);
      setName('');
      setIdInput('');
      onToast?.('เพิ่มหมวดหมู่แล้ว');
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : 'เพิ่มหมวดหมู่ไม่สำเร็จ', 'warn');
    }
  };

  const handleDelete = async (categoryId: string) => {
    if (categoryId === DEFAULT_CATEGORY_ID) {
      onToast?.('ไม่สามารถลบหมวดหมู่ทั่วไปได้', 'warn');
      return;
    }
    setDeletingId(categoryId);
    try {
      await removeCategory(categoryId);
      onToast?.('ลบหมวดหมู่แล้ว');
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : 'ลบหมวดหมู่ไม่สำเร็จ', 'warn');
    } finally {
      setDeletingId(null);
    }
  };

  const previewId = idInput.trim() || (name.trim() ? slugFromCategoryName(name) : '');

  // Portaled to <body> with an elevated z-index so it always stacks ABOVE the
  // ProductDrawer overlay (.pc-dialog-overlay, z-index: 1000), which also portals
  // to body. Without this the modal renders behind the drawer it was opened from.
  return createPortal(
    <div
      className="cm-dialog-overlay"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{ zIndex: 1200 }}
    >
      <div className="cm-dialog cm-dialog-form cm-tier-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="cm-dialog-header cm-dialog-header-premium">
          <div>
            <span className="cm-dialog-title">จัดการหมวดหมู่</span>
            <span className="cm-dialog-subtitle">Product Categories — ใช้จัดกลุ่มสินค้าใน POS และรายงาน</span>
          </div>
          <button type="button" className="cm-icon-btn" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <div className="cm-dialog-body cm-dialog-body-form">
          <section className="cm-form-section">
            <div className="cm-form-section-title">
              <i className="ti ti-plus" aria-hidden="true" />
              เพิ่มหมวดหมู่ใหม่
            </div>
            <div className="cm-form-row">
              <div className="cm-form-group">
                <label className="cm-form-label">
                  ชื่อหมวดหมู่ <span className="cm-form-required">*</span>
                </label>
                <input
                  className="cm-form-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="เช่น อาหารสัตว์, ของเล่น"
                  onKeyDown={(e) => e.key === 'Enter' && void handleAdd()}
                />
              </div>
              <div className="cm-form-group">
                <label className="cm-form-label">รหัส (ID)</label>
                <input
                  className="cm-form-input"
                  value={idInput}
                  onChange={(e) => setIdInput(e.target.value)}
                  placeholder="ว่างไว้เพื่อสร้างอัตโนมัติ"
                  onKeyDown={(e) => e.key === 'Enter' && void handleAdd()}
                />
                {previewId ? (
                  <p className="cm-form-hint">
                    รหัสที่จะใช้: <code>{previewId}</code>
                  </p>
                ) : null}
              </div>
            </div>
            <div className="cm-form-actions">
              <button
                type="button"
                className="cm-btn cm-btn-primary cm-btn-sm"
                disabled={saving || !name.trim()}
                onClick={() => void handleAdd()}
              >
                ➕ เพิ่มหมวดหมู่
              </button>
            </div>
          </section>

          <div className="cm-form-divider" />

          <section className="cm-form-section">
            <div className="cm-form-section-title">
              <i className="ti ti-list" aria-hidden="true" />
              หมวดหมู่ทั้งหมด
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
                    {categories.map((cat) => {
                      const isDefault = cat.id === DEFAULT_CATEGORY_ID;
                      return (
                        <tr key={cat.id}>
                          <td>{cat.name}</td>
                          <td>
                            <code className="cm-tier-id">{cat.id}</code>
                            {isDefault ? (
                              <span className="cm-tier-default-tag">ค่าเริ่มต้น</span>
                            ) : null}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {isDefault ? (
                              <span className="cm-form-hint">—</span>
                            ) : (
                              <button
                                type="button"
                                className="cm-icon-btn danger"
                                title="ลบหมวดหมู่"
                                disabled={saving || deletingId === cat.id}
                                onClick={() => void handleDelete(cat.id)}
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
    </div>,
    document.body,
  );
}
