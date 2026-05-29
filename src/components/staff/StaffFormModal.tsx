import { useEffect, useState } from 'react';
import type { User, UserRole } from '../lib/types';
import type { StaffFormData } from '../lib/staffManagement/types';

export const EMPTY_STAFF_FORM: StaffFormData = {
  firstName: '',
  lastName: '',
  username: '',
  password: '',
  pin: '',
  role: 'staff',
  branchIds: [],
};

export type StaffFormModalProps = {
  open: boolean;
  editUser: User | null;
  branches: Array<{ id: string; name: string }>;
  branchPicker: 'checkbox' | 'dropdown';
  saving: boolean;
  onClose: () => void;
  onSave: (form: StaffFormData) => Promise<void>;
};

export default function StaffFormModal({
  open,
  editUser,
  branches,
  branchPicker,
  saving,
  onClose,
  onSave,
}: StaffFormModalProps) {
  const [form, setForm] = useState<StaffFormData>(EMPTY_STAFF_FORM);

  useEffect(() => {
    if (!open) return;
    if (editUser) {
      setForm({
        firstName: editUser.firstName,
        lastName: editUser.lastName,
        username: editUser.username,
        password: '',
        pin: '',
        role: editUser.role,
        branchIds: [...editUser.branchIds],
      });
    } else {
      setForm({ ...EMPTY_STAFF_FORM, branchIds: branches[0] ? [branches[0].id] : [] });
    }
  }, [open, editUser, branches]);

  if (!open) return null;

  const set = <K extends keyof StaffFormData>(key: K, val: StaffFormData[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const toggleBranch = (id: string) => {
    setForm((f) => {
      const has = f.branchIds.includes(id);
      return {
        ...f,
        branchIds: has ? f.branchIds.filter((b) => b !== id) : [...f.branchIds, id],
      };
    });
  };

  const selectedBranchId = form.branchIds[0] ?? '';

  const handleSave = async () => {
    await onSave(form);
  };

  return (
    <div className="sm-modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="sm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sm-modal-header">
          <span className="sm-modal-title">
            {editUser ? 'แก้ไขข้อมูลพนักงาน' : 'เพิ่มพนักงานใหม่'}
          </span>
          <button type="button" className="sm-icon-btn" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>
        <div className="sm-modal-body">
          <div className="sm-form-section-title">
            <i className="ti ti-user" aria-hidden="true" /> ข้อมูลส่วนตัว
          </div>
          <div className="sm-form-row">
            <div className="sm-form-group">
              <label className="sm-form-label">
                ชื่อ<span className="sm-form-required">*</span>
              </label>
              <input
                className="sm-form-input"
                value={form.firstName}
                onChange={(e) => set('firstName', e.target.value)}
                placeholder="ชื่อ"
              />
            </div>
            <div className="sm-form-group">
              <label className="sm-form-label">
                นามสกุล<span className="sm-form-required">*</span>
              </label>
              <input
                className="sm-form-input"
                value={form.lastName}
                onChange={(e) => set('lastName', e.target.value)}
                placeholder="นามสกุล"
              />
            </div>
          </div>

          <div className="sm-form-section-title">
            <i className="ti ti-shield" aria-hidden="true" /> บัญชีและสิทธิ์
          </div>
          <div className="sm-form-row">
            <div className="sm-form-group">
              <label className="sm-form-label">
                Role<span className="sm-form-required">*</span>
              </label>
              <select
                className="sm-form-select"
                value={form.role}
                onChange={(e) => {
                  const newRole = e.target.value as UserRole;
                  setForm((f) => {
                    const next = { ...f, role: newRole };
                    // Promoting to admin → default to ALL branches
                    if (newRole === 'admin' && f.branchIds[0] !== 'ALL') {
                      next.branchIds = ['ALL'];
                    }
                    // Demoting from ALL → revert to first real branch (or empty)
                    if (newRole !== 'admin' && f.branchIds[0] === 'ALL') {
                      next.branchIds = branches[0] ? [branches[0].id] : [];
                    }
                    return next;
                  });
                }}
              >
                <option value="staff">Staff</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="sm-form-group">
              <label className="sm-form-label">
                PIN (4 หลัก){!editUser && <span className="sm-form-required">*</span>}
              </label>
              <input
                className="sm-form-input"
                type="password"
                value={form.pin}
                onChange={(e) => set('pin', e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="••••"
                maxLength={4}
                inputMode="numeric"
              />
              <span className="sm-form-hint">
                {editUser
                  ? 'ปล่อยว่างเพื่อไม่เปลี่ยน PIN — ใช้ล็อกอินที่หน้า Login'
                  : 'ใช้ล็อกอินที่หน้า Login (PIN 4 หลัก)'}
              </span>
            </div>
          </div>
          <div className="sm-form-row">
            <div className="sm-form-group">
              <label className="sm-form-label">
                Username<span className="sm-form-required">*</span>
              </label>
              <input
                className="sm-form-input"
                value={form.username}
                onChange={(e) => set('username', e.target.value)}
                placeholder="username"
                autoComplete="new-password"
              />
            </div>
            <div className="sm-form-group">
              <label className="sm-form-label">Password</label>
              <input
                className="sm-form-input"
                type="password"
                value={form.password}
                onChange={(e) => set('password', e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
              />
              <span className="sm-form-hint">
                {editUser
                  ? 'ปล่อยว่างเพื่อไม่เปลี่ยน password'
                  : 'ไม่บังคับ — ระบบล็อกอินหลักใช้ PIN'}
              </span>
            </div>
          </div>

          <div className="sm-form-section-title">
            <i className="ti ti-building-store" aria-hidden="true" />
            {branchPicker === 'dropdown' ? 'สาขา' : 'สาขาที่เข้าถึงได้'}
          </div>

          {branchPicker === 'dropdown' ? (
            <div className="sm-form-group">
              <label className="sm-form-label">
                Branch<span className="sm-form-required">*</span>
              </label>
              <select
                className="sm-form-select"
                value={selectedBranchId}
                onChange={(e) => set('branchIds', e.target.value ? [e.target.value] : [])}
                disabled={branches.length === 0}
              >
                <option value="ALL">🌐 รวมทุกสาขา (Global Admin)</option>
                <option value="">— เลือกสาขา —</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.id} — {b.name || b.id}
                  </option>
                ))}
              </select>
              <span
                className="sm-form-hint"
                style={
                  selectedBranchId === 'ALL' && form.role !== 'admin'
                    ? { color: 'var(--amber, #ba7517)' }
                    : undefined
                }
              >
                {selectedBranchId === 'ALL'
                  ? form.role === 'admin'
                    ? 'Global Admin — สามารถเข้าถึงและจัดการได้ทุกสาขา'
                    : '⚠ รวมทุกสาขาเหมาะสำหรับ Admin เท่านั้น — แนะนำให้เลือก Role "Admin" ก่อน'
                  : 'มอบหมายพนักงานให้สาขาที่เลือก'}
              </span>
            </div>
          ) : (
            <div className="sm-branch-check-grid">
              {branches.map((b) => {
                const checked = form.branchIds.includes(b.id);
                return (
                  <label
                    key={b.id}
                    className={`sm-branch-check-item${checked ? ' checked' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleBranch(b.id)}
                    />
                    <i
                      className="ti ti-building-store"
                      style={{ fontSize: 15, color: 'var(--p600)' }}
                      aria-hidden="true"
                    />
                    {b.name}
                  </label>
                );
              })}
            </div>
          )}
        </div>
        <div className="sm-modal-footer">
          <button type="button" className="sm-btn sm-btn-ghost" onClick={onClose} disabled={saving}>
            ยกเลิก
          </button>
          <button
            type="button"
            className="sm-btn sm-btn-primary"
            disabled={saving}
            onClick={() => void handleSave()}
          >
            <i className="ti ti-check" aria-hidden="true" /> {saving ? 'กำลังบันทึก...' : 'บันทึก'}
          </button>
        </div>
      </div>
    </div>
  );
}
