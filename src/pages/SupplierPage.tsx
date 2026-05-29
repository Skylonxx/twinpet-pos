import { useMemo, useState } from 'react';
import PosSupplierModal from '../components/receiving/PosSupplierModal';
import { getBranchLabel } from '../lib/branches';
import { useAuth } from '../lib/hooks/useAuth';
import { useActiveSuppliers } from '../lib/pos/useSuppliers';
import type { Supplier } from '../lib/types';
import './SupplierPage.css';

export default function SupplierPage() {
  const { branchId } = useAuth();
  const suppliers = useActiveSuppliers(branchId ?? '');

  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editSupplier, setEditSupplier] = useState<Supplier | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const branchDisplay = branchId ? getBranchLabel(branchId) : '—';

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.code.toLowerCase().includes(q) ||
        s.phone.includes(q) ||
        s.contactName.toLowerCase().includes(q) ||
        (s.taxId ?? '').includes(q),
    );
  }, [suppliers, search]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  };

  const openAdd = () => {
    setEditSupplier(null);
    setModalOpen(true);
  };

  const openEdit = (s: Supplier) => {
    setEditSupplier(s);
    setModalOpen(true);
  };

  const handleClose = () => {
    setModalOpen(false);
    setEditSupplier(null);
  };

  const handleSaved = (s: Supplier) => {
    showToast(editSupplier ? `อัปเดต "${s.name}" เรียบร้อย` : `เพิ่ม "${s.name}" เรียบร้อย`);
  };

  if (!branchId) return null;

  return (
    <div className="sup-page">
      {/* Top Bar */}
      <div className="sup-topbar">
        <div className="sup-topbar-icon">
          <i className="ti ti-truck" aria-hidden="true" />
        </div>
        <div className="sup-topbar-center">
          <div className="sup-topbar-title">ข้อมูลผู้จำหน่าย</div>
          <div className="sup-topbar-sub">Supplier Directory · สาขา {branchDisplay}</div>
        </div>
        <button type="button" className="sup-btn sup-btn-primary" onClick={openAdd}>
          <i className="ti ti-plus" aria-hidden="true" />
          เพิ่มผู้จำหน่าย
        </button>
      </div>

      {/* Content */}
      <div className="sup-content">
        {/* Search toolbar */}
        <div className="sup-toolbar">
          <div className="sup-search-wrap">
            <i className="ti ti-search" aria-hidden="true" />
            <input
              type="text"
              placeholder="ค้นหาชื่อ / รหัส / เบอร์โทร / เลขภาษี..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="sup-search-clear"
                onClick={() => setSearch('')}
                aria-label="ล้าง"
              >
                <i className="ti ti-x" aria-hidden="true" />
              </button>
            )}
          </div>
          <span className="sup-count-badge">
            {filtered.length} รายการ
          </span>
        </div>

        {/* Table */}
        <div className="sup-card">
          <div className="sup-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>รหัส</th>
                  <th>ชื่อผู้จำหน่าย</th>
                  <th>ผู้ติดต่อ</th>
                  <th>เบอร์โทร</th>
                  <th>เลขผู้เสียภาษี</th>
                  <th>ที่อยู่</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="sup-empty">
                        <i className="ti ti-truck-off" aria-hidden="true" />
                        <p>
                          {suppliers.length === 0
                            ? 'ยังไม่มีผู้จำหน่ายในระบบ — กด "เพิ่มผู้จำหน่าย" เพื่อเพิ่มรายการแรก'
                            : 'ไม่พบผู้จำหน่ายที่ตรงกับคำค้นหา'}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filtered.map((s) => (
                    <tr
                      key={s.id}
                      className="sup-row-clickable"
                      onClick={() => openEdit(s)}
                      title="คลิกเพื่อแก้ไข"
                    >
                      <td>
                        <span className="sup-code">{s.code}</span>
                      </td>
                      <td>
                        <div className="sup-name-cell">
                          <div className="sup-avatar">{(s.name[0] ?? 'S').toUpperCase()}</div>
                          <span className="sup-name">{s.name}</span>
                        </div>
                      </td>
                      <td className="sup-text-muted">{s.contactName || '—'}</td>
                      <td>{s.phone || '—'}</td>
                      <td className="sup-mono">{s.taxId || '—'}</td>
                      <td className="sup-text-muted sup-address">{s.address || '—'}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="sup-action-group">
                          <button
                            type="button"
                            className="sup-icon-btn"
                            title="แก้ไข"
                            onClick={() => openEdit(s)}
                          >
                            <i className="ti ti-edit" aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Footer stats */}
      <div className="sup-footer">
        <div className="sup-footer-stat">
          <span className="sup-footer-num">{suppliers.length}</span>
          <span className="sup-footer-lbl">ผู้จำหน่ายทั้งหมด</span>
        </div>
        <div className="sup-footer-stat">
          <span className="sup-footer-num sup-footer-num--green">{filtered.length}</span>
          <span className="sup-footer-lbl">แสดงผล</span>
        </div>
        <div className="sup-footer-spacer" />
        <a
          href="/admin/suppliers"
          target="_blank"
          rel="noopener noreferrer"
          className="sup-admin-link"
        >
          <i className="ti ti-external-link" aria-hidden="true" />
          จัดการผู้จำหน่ายทั้งหมด (Admin)
        </a>
      </div>

      {/* Add/Edit Modal */}
      <PosSupplierModal
        open={modalOpen}
        branchId={branchId}
        editSupplier={editSupplier}
        onSaved={handleSaved}
        onClose={handleClose}
      />

      {/* Toast */}
      {toast ? (
        <div className="sup-toast-wrap">
          <div className="sup-toast">
            <i className="ti ti-circle-check" aria-hidden="true" />
            {toast}
          </div>
        </div>
      ) : null}
    </div>
  );
}
