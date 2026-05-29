import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Supplier } from '../../lib/types';
import './SupplierPickerDialog.css';

type Props = {
  open: boolean;
  suppliers: Supplier[];
  onSelect: (supplier: Supplier) => void;
  /** Called when user clicks "ระบุชื่อเอง" — switches the form to free-text mode */
  onManualEntry: () => void;
  /** Called when user clicks "เพิ่มผู้จำหน่ายใหม่" — opens PosSupplierModal */
  onAddNew: (prefillName: string) => void;
  onClose: () => void;
};

function supplierInitials(s: Supplier): string {
  return (s.name.trim()[0] ?? 'S').toUpperCase();
}

export default function SupplierPickerDialog({
  open,
  suppliers,
  onSelect,
  onManualEntry,
  onAddNew,
  onClose,
}: Props) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.code.toLowerCase().includes(q) ||
        s.contactName.toLowerCase().includes(q) ||
        s.phone.includes(q) ||
        (s.taxId ?? '').includes(q),
    );
  }, [suppliers, query]);

  if (!open) return null;

  const handleSelect = (s: Supplier) => {
    onSelect(s);
    onClose();
    setQuery('');
  };

  const handleManual = () => {
    onManualEntry();
    onClose();
    setQuery('');
  };

  return createPortal(
    <div
      className="rcv-supplier-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="spd-title"
      onClick={onClose}
    >
      <div className="rcv-supplier-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="rcv-supplier-dialog-head">
          <div>
            <h3 id="spd-title">เลือกผู้จำหน่าย</h3>
            <p>
              {suppliers.length > 0
                ? `${suppliers.length} รายการจากระบบ Supplier catalog`
                : 'ยังไม่มีผู้จำหน่ายในระบบ — เพิ่มได้ที่ Admin › Suppliers'}
            </p>
          </div>
          <button
            type="button"
            className="rcv-supplier-close"
            onClick={onClose}
            aria-label="ปิด"
          >
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        {/* Search */}
        <div className="rcv-supplier-search">
          <i className="ti ti-search" aria-hidden="true" />
          <input
            ref={inputRef}
            placeholder="ค้นหาชื่อ / รหัส / ผู้ติดต่อ / เบอร์โทร"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {query ? (
            <button
              type="button"
              className="rcv-supplier-search-clear"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              aria-label="ล้าง"
            >
              <i className="ti ti-x" aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {/* List */}
        <div className="rcv-supplier-list">
          {filtered.length === 0 ? (
            <p className="rcv-supplier-empty">
              {suppliers.length === 0
                ? 'ยังไม่มีผู้จำหน่ายในระบบ'
                : 'ไม่พบผู้จำหน่ายที่ตรงกับคำค้นหา'}
            </p>
          ) : (
            filtered.map((s) => (
              <div key={s.id} className="rcv-supplier-row-item">
                <button
                  type="button"
                  className="rcv-supplier-select"
                  onClick={() => handleSelect(s)}
                >
                  <span className="rcv-supplier-avatar">{supplierInitials(s)}</span>
                  <span className="rcv-supplier-info">
                    <span className="rcv-supplier-name">{s.name}</span>
                    <span className="rcv-supplier-meta">
                      {s.code}
                      {s.contactName ? ` · ${s.contactName}` : ''}
                      {s.phone ? ` · ${s.phone}` : ''}
                      {s.taxId ? ` · TAX: ${s.taxId}` : ''}
                    </span>
                  </span>
                  <i className="ti ti-chevron-right rcv-supplier-chevron" aria-hidden="true" />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="rcv-supplier-dialog-footer">
          <button
            type="button"
            className="rcv-supplier-footer-addnew"
            onClick={() => {
              const prefill = query.trim();
              setQuery('');
              onAddNew(prefill);
              onClose();
            }}
          >
            <i className="ti ti-plus" aria-hidden="true" />
            เพิ่มผู้จำหน่ายใหม่
          </button>

          <div className="rcv-supplier-footer-sep" />

          <button
            type="button"
            className="rcv-supplier-footer-manual"
            onClick={handleManual}
          >
            <i className="ti ti-pencil" aria-hidden="true" />
            ระบุชื่อเอง
          </button>

          <a
            href="/admin/suppliers"
            target="_blank"
            rel="noopener noreferrer"
            className="rcv-supplier-footer-admin"
          >
            <i className="ti ti-external-link" aria-hidden="true" />
            Admin
          </a>
        </div>
      </div>
    </div>,
    document.body,
  );
}
