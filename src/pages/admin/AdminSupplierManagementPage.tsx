import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { fetchAllBranches } from '../../lib/admin/branchManagement';
import {
  emptySupplierForm,
  fmtBranchScope,
  supplierInitials,
  supplierToForm,
  useSupplierManagement,
  type SupplierFormData,
} from '../../lib/admin/supplierManagement';
import type { Branch, Supplier } from '../../lib/types';
import '../CustomerPage.css';
import './AdminSupplierManagementPage.css';

// ─── Form Modal ───────────────────────────────────────────────────────────────

interface SupplierFormModalProps {
  open: boolean;
  editSupplier: Supplier | null;
  branches: Branch[];
  onClose: () => void;
  onSave: (form: SupplierFormData, editId?: string) => Promise<void>;
  saving: boolean;
}

function SectionTitle({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="cm-form-section-title">
      <i className={`ti ${icon}`} aria-hidden="true" />
      {children}
    </div>
  );
}

function SupplierFormModal({
  open,
  editSupplier,
  branches,
  onClose,
  onSave,
  saving,
}: SupplierFormModalProps) {
  const [form, setForm] = useState<SupplierFormData>(emptySupplierForm);
  const [formError, setFormError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setForm(editSupplier ? supplierToForm(editSupplier) : emptySupplierForm());
    setFormError(null);
    setTimeout(() => firstRef.current?.focus(), 60);
  }, [open, editSupplier]);

  if (!open) return null;

  const isEdit = editSupplier !== null;
  const isAll = form.allowedBranchIds.includes('ALL');

  const set = <K extends keyof SupplierFormData>(key: K, val: SupplierFormData[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const toggleAll = () => {
    setForm((f) => ({
      ...f,
      allowedBranchIds: f.allowedBranchIds.includes('ALL') ? [] : ['ALL'],
    }));
  };

  const toggleBranch = (branchId: string) => {
    setForm((f) => {
      const next = f.allowedBranchIds.filter((id) => id !== 'ALL');
      if (next.includes(branchId)) {
        return { ...f, allowedBranchIds: next.filter((id) => id !== branchId) };
      }
      return { ...f, allowedBranchIds: [...next, branchId] };
    });
  };

  const handleSubmit = async () => {
    setFormError(null);
    try {
      await onSave(form, editSupplier?.id);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ');
    }
  };

  const title = isEdit ? 'แก้ไขข้อมูลผู้จำหน่าย' : 'เพิ่มผู้จำหน่ายใหม่';

  return (
    <div className="cm-dialog-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="cm-dialog cm-dialog-form" onClick={(e) => e.stopPropagation()}>
        <div className="cm-dialog-header cm-dialog-header-premium">
          <div>
            <span className="cm-dialog-title">{title}</span>
            <span className="cm-dialog-subtitle">Supplier · ข้อมูลผู้จำหน่าย / คู่ค้า</span>
          </div>
          <button type="button" className="cm-icon-btn" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <div className="cm-dialog-body cm-dialog-body-form">
          {formError && (
            <div style={{
              marginTop: '16px',
              padding: '10px 14px',
              background: '#faece7',
              color: '#993c1d',
              border: '1px solid #facfbd',
              borderRadius: '8px',
              fontSize: '13px',
            }}>
              {formError}
            </div>
          )}

          {/* Section 1: General Info */}
          <section className="cm-form-section">
            <SectionTitle icon="ti-user">ข้อมูลทั่วไป</SectionTitle>
            <div className="cm-form-group" style={{ marginBottom: '12px' }}>
              <label className="cm-form-label">
                รหัสผู้จำหน่าย <span className="cm-form-required">*</span>
                {isEdit && (
                  <span style={{ fontWeight: 400, fontSize: '11px', marginLeft: '6px', color: 'var(--g400)' }}>
                    (ไม่สามารถแก้ไขได้)
                  </span>
                )}
              </label>
              <input
                ref={firstRef}
                className="cm-form-input"
                value={form.code}
                disabled={isEdit || saving}
                onChange={(e) => set('code', e.target.value.toUpperCase())}
                placeholder="SUP-001"
                style={isEdit ? { background: 'var(--g50)', color: 'var(--g400)' } : undefined}
              />
            </div>
            <div className="cm-form-row">
              <div className="cm-form-group">
                <label className="cm-form-label">
                  ชื่อบริษัท / ผู้จำหน่าย <span className="cm-form-required">*</span>
                </label>
                <input
                  className="cm-form-input"
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="บริษัท เพ็ทฟู้ดส์ จำกัด"
                  disabled={saving}
                />
              </div>
              <div className="cm-form-group">
                <label className="cm-form-label">ชื่อผู้ติดต่อ</label>
                <input
                  className="cm-form-input"
                  value={form.contactName}
                  onChange={(e) => set('contactName', e.target.value)}
                  placeholder="คุณสมชาย"
                  disabled={saving}
                />
              </div>
            </div>
            <div className="cm-form-row">
              <div className="cm-form-group">
                <label className="cm-form-label">
                  เบอร์โทรศัพท์ <span className="cm-form-required">*</span>
                </label>
                <input
                  className="cm-form-input"
                  value={form.phone}
                  onChange={(e) => set('phone', e.target.value)}
                  placeholder="02-123-4567"
                  disabled={saving}
                />
              </div>
              <div className="cm-form-group">
                <label className="cm-form-label">อีเมล</label>
                <input
                  className="cm-form-input"
                  type="email"
                  value={form.email}
                  onChange={(e) => set('email', e.target.value)}
                  placeholder="info@supplier.com"
                  disabled={saving}
                />
              </div>
            </div>
          </section>

          <div className="cm-form-divider" />

          {/* Section 2: Address / Tax */}
          <section className="cm-form-section">
            <SectionTitle icon="ti-map-pin">ข้อมูลที่อยู่ / ภาษี</SectionTitle>
            <div className="cm-form-group">
              <label className="cm-form-label">เลขประจำตัวผู้เสียภาษี</label>
              <input
                className="cm-form-input"
                value={form.taxId}
                onChange={(e) => set('taxId', e.target.value)}
                placeholder="0105560000000"
                disabled={saving}
              />
            </div>
            <div className="cm-form-group">
              <label className="cm-form-label">ที่อยู่</label>
              <textarea
                className="cm-form-textarea"
                value={form.address}
                onChange={(e) => set('address', e.target.value)}
                rows={2}
                placeholder="ที่อยู่บริษัทสำหรับออกเอกสาร / ใบกำกับภาษี"
                disabled={saving}
              />
            </div>
          </section>

          <div className="cm-form-divider" />

          {/* Section 3: Bank Account */}
          <section className="cm-form-section">
            <SectionTitle icon="ti-building-bank">ข้อมูลบัญชีธนาคาร</SectionTitle>
            <div className="cm-form-row">
              <div className="cm-form-group">
                <label className="cm-form-label">ชื่อธนาคาร</label>
                <input
                  className="cm-form-input"
                  value={form.bankName}
                  onChange={(e) => set('bankName', e.target.value)}
                  placeholder="กสิกรไทย / กรุงไทย..."
                  disabled={saving}
                />
              </div>
              <div className="cm-form-group">
                <label className="cm-form-label">เลขที่บัญชี</label>
                <input
                  className="cm-form-input"
                  value={form.bankAccount}
                  onChange={(e) => set('bankAccount', e.target.value)}
                  placeholder="xxx-x-xxxxx-x"
                  disabled={saving}
                />
              </div>
            </div>
          </section>

          <div className="cm-form-divider" />

          {/* Section 4: Notes + Status */}
          <section className="cm-form-section">
            <SectionTitle icon="ti-notes">หมายเหตุ / สถานะ</SectionTitle>
            <div className="cm-form-group">
              <textarea
                className="cm-form-textarea"
                value={form.note}
                onChange={(e) => set('note', e.target.value)}
                rows={2}
                placeholder="หมายเหตุ / บันทึกเพิ่มเติม"
                disabled={saving}
              />
            </div>
            <div className="cm-form-group">
              <label className="cm-form-label">สถานะ</label>
              <select
                className="cm-form-select"
                value={form.isActive ? 'active' : 'inactive'}
                onChange={(e) => set('isActive', e.target.value === 'active')}
                disabled={saving}
              >
                <option value="active">ใช้งานอยู่</option>
                <option value="inactive">ระงับชั่วคราว</option>
              </select>
            </div>
          </section>

          <div className="cm-form-divider" />

          {/* Section 5: Branch Visibility (Admin-only) */}
          <section className="cm-form-section">
            <SectionTitle icon="ti-world">สิทธิ์การเข้าถึง / สาขา</SectionTitle>
            <label style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '10px 14px', marginBottom: '10px',
              background: isAll ? 'var(--p50)' : 'var(--g50)',
              border: `1.5px solid ${isAll ? 'var(--p600)' : 'var(--g200)'}`,
              borderRadius: '10px', cursor: saving ? 'not-allowed' : 'pointer',
              fontSize: '13px', color: isAll ? 'var(--p900)' : 'var(--g600)',
            }}>
              <input type="checkbox" checked={isAll} onChange={toggleAll} disabled={saving} />
              <i
                className="ti ti-world"
                style={{ color: isAll ? 'var(--p600)' : 'var(--g400)', fontSize: '16px' }}
                aria-hidden="true"
              />
              ใช้งานได้ทุกสาขา (All Branches)
            </label>
            {!isAll && (
              branches.length === 0 ? (
                <p className="cm-form-hint">กำลังโหลดรายการสาขา…</p>
              ) : (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                  gap: '8px',
                }}>
                  {branches.map((b) => {
                    const checked = form.allowedBranchIds.includes(b.id);
                    return (
                      <label
                        key={b.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '8px',
                          padding: '8px 12px',
                          border: `1.5px solid ${checked ? 'var(--p600)' : 'rgba(0,0,0,0.13)'}`,
                          borderRadius: '8px',
                          background: checked ? 'var(--p50)' : '#fff',
                          cursor: saving ? 'not-allowed' : 'pointer',
                          fontSize: '13px', color: 'var(--p900)',
                          transition: 'all 0.15s',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleBranch(b.id)}
                          disabled={saving}
                        />
                        <span>
                          <strong>{b.id}</strong>
                          {b.name ? ` — ${b.name}` : ''}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )
            )}
          </section>
        </div>

        <div className="cm-dialog-footer cm-dialog-footer-premium">
          <button type="button" className="cm-btn cm-btn-ghost" onClick={onClose}>
            ยกเลิก
          </button>
          <button
            type="button"
            className="cm-btn cm-btn-primary"
            disabled={saving}
            onClick={() => void handleSubmit()}
          >
            {saving ? 'กำลังบันทึก...' : 'บันทึก'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminSupplierManagementPage() {
  const { suppliers, loading, error, saveSupplier, softDeleteSupplier } = useSupplierManagement();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editSupplier, setEditSupplier] = useState<Supplier | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'warn' } | null>(null);

  useEffect(() => {
    void fetchAllBranches().then(setBranches);
  }, []);

  const showToast = (msg: string, type: 'success' | 'warn' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return suppliers.filter((s) => {
      const mq =
        !q ||
        `${s.name} ${s.code} ${s.contactName} ${s.phone}`.toLowerCase().includes(q);
      const ms =
        !statusFilter ||
        (statusFilter === 'active' ? s.isActive : !s.isActive);
      return mq && ms;
    });
  }, [suppliers, search, statusFilter]);

  const stats = useMemo(
    () => ({
      total: suppliers.length,
      active: suppliers.filter((s) => s.isActive).length,
      allBranch: suppliers.filter((s) => s.allowedBranchIds.includes('ALL')).length,
    }),
    [suppliers],
  );

  const handleSave = async (form: SupplierFormData, editId?: string) => {
    setSaving(true);
    try {
      await saveSupplier(form, editId);
      setFormOpen(false);
      setEditSupplier(null);
      showToast(editId ? 'อัปเดตผู้จำหน่ายเรียบร้อย' : 'เพิ่มผู้จำหน่ายเรียบร้อย');
    } catch (err) {
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    await softDeleteSupplier(deleteId);
    setDeleteId(null);
    showToast('ลบผู้จำหน่ายเรียบร้อย');
  };

  return (
    <div className="asup-page">
      {/* Topbar */}
      <div className="asup-topbar">
        <div className="asup-topbar-icon">
          <i className="ti ti-truck-delivery" aria-hidden="true" />
        </div>
        <div className="asup-topbar-center">
          <div className="asup-topbar-title">จัดการผู้จำหน่าย (ซัพพลายเออร์)</div>
          <div className="asup-topbar-sub">Supplier Management — Centralized HQ</div>
        </div>
        <span className="asup-hq-badge">
          <i className="ti ti-shield-lock" style={{ fontSize: 12 }} aria-hidden="true" />
          HQ — ทุกสาขา
        </span>
        <div className="asup-topbar-actions">
          <button
            type="button"
            className="asup-btn asup-btn-primary"
            onClick={() => {
              setEditSupplier(null);
              setFormOpen(true);
            }}
          >
            <i className="ti ti-plus" aria-hidden="true" /> เพิ่มผู้จำหน่าย
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="asup-content">
        <div className="asup-toolbar">
          <div className="asup-search-wrap">
            <i className="ti ti-search" aria-hidden="true" />
            <input
              type="text"
              placeholder="ค้นหาชื่อ / รหัส / เบอร์โทร..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="asup-select-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">ทุกสถานะ</option>
            <option value="active">ใช้งาน</option>
            <option value="inactive">ระงับ</option>
          </select>
        </div>

        {loading ? (
          <div className="asup-loading">กำลังโหลดข้อมูล...</div>
        ) : error ? (
          <div className="asup-loading" style={{ color: 'var(--red)' }}>
            โหลดข้อมูลไม่สำเร็จ: {error}
          </div>
        ) : (
          <div className="asup-card">
            <div className="asup-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>ชื่อผู้จำหน่าย</th>
                    <th>รหัส</th>
                    <th>ผู้ติดต่อ / โทร</th>
                    <th>สาขาที่ใช้งานได้</th>
                    <th>สถานะ</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={6}>
                        <div className="asup-empty-state">
                          <i className="ti ti-building-off" aria-hidden="true" />
                          <p>ไม่พบผู้จำหน่ายที่ตรงตามเงื่อนไข</p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filtered.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <div className="asup-emp-cell">
                            <div className="asup-avatar">{supplierInitials(s)}</div>
                            <div>
                              <div className="asup-emp-name">{s.name}</div>
                              {s.taxId && (
                                <div className="asup-emp-sub">TAX: {s.taxId}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className="asup-code">{s.code}</span>
                        </td>
                        <td>
                          <div>{s.contactName || '—'}</div>
                          <div style={{ fontSize: 12, color: 'var(--g400)' }}>{s.phone}</div>
                        </td>
                        <td>
                          <span
                            className={`asup-scope-pill ${
                              s.allowedBranchIds.includes('ALL') ? 'asup-scope-all' : 'asup-scope-some'
                            }`}
                          >
                            <i
                              className={`ti ${
                                s.allowedBranchIds.includes('ALL')
                                  ? 'ti-world'
                                  : 'ti-building-store'
                              }`}
                              aria-hidden="true"
                            />
                            {fmtBranchScope(s.allowedBranchIds)}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`asup-status-pill ${s.isActive ? 'asup-status-on' : 'asup-status-off'}`}
                          >
                            <span className="asup-dot" />
                            {s.isActive ? 'ใช้งาน' : 'ระงับ'}
                          </span>
                        </td>
                        <td>
                          <div className="asup-action-group">
                            <button
                              type="button"
                              className="asup-icon-btn"
                              title="แก้ไข"
                              onClick={() => {
                                setEditSupplier(s);
                                setFormOpen(true);
                              }}
                            >
                              <i className="ti ti-edit" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="asup-icon-btn danger"
                              title="ลบ"
                              onClick={() => setDeleteId(s.id)}
                            >
                              <i className="ti ti-trash" aria-hidden="true" />
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
        )}
      </div>

      {/* Footer stats */}
      <div className="asup-footer">
        <div className="asup-footer-stat">
          <span className="asup-footer-num">{stats.total}</span>
          <span className="asup-footer-lbl">ทั้งหมด</span>
        </div>
        <div className="asup-footer-stat">
          <span className="asup-footer-num clr-green">{stats.active}</span>
          <span className="asup-footer-lbl">ใช้งาน</span>
        </div>
        <div className="asup-footer-stat">
          <span className="asup-footer-num clr-purple">{stats.allBranch}</span>
          <span className="asup-footer-lbl">ทุกสาขา</span>
        </div>
        <div className="asup-footer-spacer" />
      </div>

      {/* Add / Edit form modal */}
      <SupplierFormModal
        open={formOpen}
        editSupplier={editSupplier}
        branches={branches}
        onClose={() => {
          setFormOpen(false);
          setEditSupplier(null);
        }}
        onSave={handleSave}
        saving={saving}
      />

      {/* Delete confirmation */}
      {deleteId ? (
        <div className="asup-dialog-overlay" onClick={() => setDeleteId(null)}>
          <div className="asup-dialog asup-dialog-sm" onClick={(e) => e.stopPropagation()}>
            <div className="asup-dialog-body" style={{ textAlign: 'center', padding: '24px 20px' }}>
              <i
                className="ti ti-trash"
                style={{ fontSize: 32, color: 'var(--red)', marginBottom: 12, display: 'block' }}
                aria-hidden="true"
              />
              <div style={{ fontWeight: 500, marginBottom: 6 }}>ยืนยันการลบ</div>
              <div style={{ fontSize: 13, color: 'var(--g400)' }}>
                ข้อมูลจะถูก soft delete และไม่แสดงในรายการ
              </div>
            </div>
            <div className="asup-dialog-footer">
              <button
                type="button"
                className="asup-btn asup-btn-ghost"
                onClick={() => setDeleteId(null)}
              >
                ยกเลิก
              </button>
              <button
                type="button"
                className="asup-btn asup-btn-danger-ghost"
                onClick={() => void handleDelete()}
              >
                ลบ
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Toast */}
      {toast ? (
        <div className="asup-toast-wrap">
          <div className={`asup-toast ${toast.type}`}>{toast.msg}</div>
        </div>
      ) : null}
    </div>
  );
}
