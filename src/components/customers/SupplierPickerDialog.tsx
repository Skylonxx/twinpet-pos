import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { customerFullName, customerInitials } from '../../lib/customers/types';
import type { Customer } from '../../lib/types';
import './SupplierPickerDialog.css';

type Props = {
  open: boolean;
  suppliers: Customer[];
  onSelect: (supplier: Customer) => void;
  onViewDetail: (supplier: Customer) => void;
  onClose: () => void;
};

export default function SupplierPickerDialog({
  open,
  suppliers,
  onSelect,
  onViewDetail,
  onClose,
}: Props) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter(
      (s) =>
        customerFullName(s).toLowerCase().includes(q) ||
        s.phone.includes(q) ||
        s.memberNo.toLowerCase().includes(q) ||
        (s.taxId ?? '').includes(q),
    );
  }, [suppliers, query]);

  if (!open) return null;

  return createPortal(
    <div
      className="rcv-supplier-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="spd-title"
      onClick={onClose}
    >
      <div className="rcv-supplier-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="rcv-supplier-dialog-head">
          <div>
            <h3 id="spd-title">ค้นหาผู้จำหน่าย</h3>
            <p>เลือกจากรายชื่อ Supplier ในระบบ</p>
          </div>
          <button type="button" className="rcv-supplier-close" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <div className="rcv-supplier-search">
          <i className="ti ti-search" aria-hidden="true" />
          <input
            placeholder="ค้นหาชื่อ / เบอร์โทร / รหัส / เลขผู้เสียภาษี"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        <div className="rcv-supplier-list">
          {filtered.length === 0 ? (
            <p className="rcv-supplier-empty">
              {suppliers.length === 0
                ? 'ยังไม่มีผู้จำหน่ายในระบบ — เพิ่มได้ที่หน้าจัดการลูกค้า'
                : 'ไม่พบผู้จำหน่ายที่ตรงกับคำค้นหา'}
            </p>
          ) : (
            filtered.map((s) => (
              <div key={s.id} className="rcv-supplier-row-item">
                <button
                  type="button"
                  className="rcv-supplier-select"
                  onClick={() => {
                    onSelect(s);
                    onClose();
                  }}
                >
                  <span className="rcv-supplier-avatar">{customerInitials(s)}</span>
                  <span className="rcv-supplier-info">
                    <span className="rcv-supplier-name">{customerFullName(s)}</span>
                    <span className="rcv-supplier-meta">
                      {s.memberNo} · {s.phone}
                      {s.taxId ? ` · ${s.taxId}` : ''}
                    </span>
                  </span>
                  <i className="ti ti-chevron-right rcv-supplier-chevron" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="rcv-supplier-detail-btn"
                  title="ดูรายละเอียด"
                  onClick={() => onViewDetail(s)}
                >
                  <i className="ti ti-eye" aria-hidden="true" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
