import { useCallback, useEffect, useMemo, useState } from 'react';
import { BRANCH_OPTIONS, getBranchLabel } from '../lib/branches';
import { useAuth } from '../lib/hooks/useAuth';
import { downloadCsv } from '../lib/stockReport/exportCsv';
import {
  avatarClass,
  formatLastLogin,
  LOG_ICONS,
  logFilterMatch,
  PERM_MODULES,
  roleBadgeClass,
  roleLabel,
  setsFromMatrix,
  userInitials,
  type LogFilter,
  type StaffFormData,
  type StaffTab,
} from '../lib/staffManagement/types';
import { useStaffManagement } from '../lib/staffManagement/useStaffManagement';
import type { User, UserRole } from '../lib/types';
import './StaffManagementPage.css';

const LOG_CHIPS: { id: LogFilter; label: string }[] = [
  { id: 'all', label: 'ทั้งหมด' },
  { id: 'login', label: 'เข้า/ออก' },
  { id: 'sale', label: 'การขาย' },
  { id: 'edit', label: 'แก้ไขสินค้า' },
  { id: 'void', label: 'ยกเลิก/Void' },
  { id: 'discount', label: 'ส่วนลด' },
];

const EMPTY_FORM: StaffFormData = {
  firstName: '',
  lastName: '',
  username: '',
  password: '',
  pin: '',
  role: 'staff',
  branchIds: [],
};

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="sm-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="sm-toggle-track" />
      <div className="sm-toggle-thumb" />
    </label>
  );
}

function StaffModal({
  open,
  editUser,
  onClose,
  onSave,
  saving,
}: {
  open: boolean;
  editUser: User | null;
  onClose: () => void;
  onSave: (form: StaffFormData) => Promise<void>;
  saving: boolean;
}) {
  const [form, setForm] = useState<StaffFormData>(EMPTY_FORM);

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
      setForm({ ...EMPTY_FORM, branchIds: [BRANCH_OPTIONS[0]!.id] });
    }
  }, [open, editUser]);

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
                onChange={(e) => set('role', e.target.value as UserRole)}
              >
                <option value="staff">Staff</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="sm-form-group">
              <label className="sm-form-label">PIN (4 หลัก)</label>
              <input
                className="sm-form-input"
                type="password"
                value={form.pin}
                onChange={(e) => set('pin', e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="••••"
                maxLength={4}
                inputMode="numeric"
              />
              <span className="sm-form-hint">ใช้สำหรับ Quick Switch ขณะใช้งาน POS</span>
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
                {editUser ? 'ปล่อยว่างเพื่อไม่เปลี่ยน password' : 'ต้องกรอก password สำหรับพนักงานใหม่'}
              </span>
            </div>
          </div>

          <div className="sm-form-section-title">
            <i className="ti ti-building-store" aria-hidden="true" /> สาขาที่เข้าถึงได้
          </div>
          <div className="sm-branch-check-grid">
            {BRANCH_OPTIONS.map((b) => {
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
                  <i className="ti ti-building-store" style={{ fontSize: 15, color: 'var(--p600)' }} aria-hidden="true" />
                  {b.label.replace('สาขา ', '')}
                </label>
              );
            })}
          </div>
        </div>
        <div className="sm-modal-footer">
          <button type="button" className="sm-btn sm-btn-ghost" onClick={onClose}>
            ยกเลิก
          </button>
          <button type="button" className="sm-btn sm-btn-primary" disabled={saving} onClick={handleSave}>
            <i className="ti ti-check" aria-hidden="true" /> {saving ? 'กำลังบันทึก...' : 'บันทึก'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({
  open,
  title,
  desc,
  iconClass,
  icon,
  okLabel,
  okClass,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  desc: string;
  iconClass: string;
  icon: string;
  okLabel: string;
  okClass: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div className="sm-modal-overlay" onClick={onClose}>
      <div className="sm-modal sm-confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sm-confirm-body">
          <div className={`sm-confirm-icon ${iconClass}`}>
            <i className={`ti ${icon}`} aria-hidden="true" />
          </div>
          <div className="sm-confirm-title">{title}</div>
          <div className="sm-confirm-desc">{desc}</div>
        </div>
        <div className="sm-modal-footer">
          <button type="button" className="sm-btn sm-btn-ghost" onClick={onClose}>
            ยกเลิก
          </button>
          <button type="button" className={`sm-btn ${okClass}`} onClick={onConfirm}>
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function StaffManagementPage() {
  const { branchId, user: actor } = useAuth();
  const actorInfo = actor
    ? { id: actor.id, name: `${actor.firstName} ${actor.lastName}` }
    : null;

  const {
    users,
    activities,
    roleMatrix,
    loading,
    error,
    saveUser,
    toggleActive,
    softDeleteUser,
    updateRoleMatrix,
    resetRoleMatrix,
  } = useStaffManagement(branchId, actorInfo);

  const [tab, setTab] = useState<StaffTab>('staff');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [staffModalOpen, setStaffModalOpen] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [confirm, setConfirm] = useState<{ userId: string; name: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'info' | 'warn' } | null>(null);
  const [clock, setClock] = useState('');

  const branchDisplay = branchId ? getBranchLabel(branchId) : '—';
  const permSets = useMemo(() => setsFromMatrix(roleMatrix), [roleMatrix]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      const mq =
        !q ||
        `${u.firstName} ${u.lastName} ${u.username}`.toLowerCase().includes(q);
      const mr = !roleFilter || roleLabel(u.role) === roleFilter;
      const ms =
        !statusFilter ||
        (statusFilter === 'active' ? u.isActive : !u.isActive);
      return mq && mr && ms;
    });
  }, [users, search, roleFilter, statusFilter]);

  const filteredLogs = useMemo(
    () => activities.filter((a) => logFilterMatch(a.action, logFilter)),
    [activities, logFilter],
  );

  const stats = useMemo(
    () => ({
      total: users.length,
      active: users.filter((u) => u.isActive).length,
      admin: users.filter((u) => u.role === 'admin').length,
      manager: users.filter((u) => u.role === 'manager').length,
      staff: users.filter((u) => u.role === 'staff').length,
    }),
    [users],
  );

  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString('th-TH', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(id);
  }, [toast]);

  const showToast = (msg: string, type: 'success' | 'info' | 'warn' = 'info') =>
    setToast({ msg, type });

  const openAdd = () => {
    setEditUser(null);
    setStaffModalOpen(true);
  };

  const openEdit = (u: User) => {
    setEditUser(u);
    setStaffModalOpen(true);
  };

  const handleSave = async (form: StaffFormData) => {
    if (!form.firstName.trim() || !form.lastName.trim() || !form.username.trim()) {
      showToast('กรุณากรอกข้อมูลที่จำเป็น', 'warn');
      return;
    }
    if (!form.branchIds.length) {
      showToast('กรุณาเลือกสาขาอย่างน้อย 1 สาขา', 'warn');
      return;
    }
    if (!editUser && !form.password) {
      showToast('กรุณากรอก password สำหรับพนักงานใหม่', 'warn');
      return;
    }
    if (form.pin && !/^\d{4}$/.test(form.pin)) {
      showToast('PIN ต้องเป็นตัวเลข 4 หลัก', 'warn');
      return;
    }

    setSaving(true);
    try {
      await saveUser(form, editUser?.id);
      setStaffModalOpen(false);
      showToast(
        editUser
          ? `อัปเดตข้อมูล "${form.firstName} ${form.lastName}" เรียบร้อย`
          : `เพิ่มพนักงาน "${form.firstName} ${form.lastName}" เรียบร้อย`,
        'success',
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ', 'warn');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = useCallback(async () => {
    if (!confirm) return;
    const target = users.find((u) => u.id === confirm.userId);
    if (target?.role === 'admin' && users.filter((u) => u.role === 'admin').length <= 1) {
      showToast('ต้องมี Admin อย่างน้อย 1 คน', 'warn');
      setConfirm(null);
      return;
    }
    await softDeleteUser(confirm.userId);
    setConfirm(null);
    showToast(`ลบ "${confirm.name}" เรียบร้อย`, 'success');
  }, [confirm, users, softDeleteUser]);

  const exportLogCsv = () => {
    const rows: string[][] = [
      ['Date', 'Time', 'Staff', 'Role', 'Type', 'Detail', 'IP', 'Device'],
    ];
    for (const l of filteredLogs) {
      const u = users.find((x) => x.id === l.userId);
      const d = l.createdAt.toDate();
      rows.push([
        d.toLocaleDateString('th-TH'),
        d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
        l.userName,
        u ? roleLabel(u.role) : '',
        l.action,
        l.detail,
        l.ip ?? '',
        l.deviceId ?? '',
      ]);
    }
    downloadCsv(rows, 'activity_log');
    showToast('Export CSV เรียบร้อย', 'success');
  };

  const formatActivityTime = (ts: User['lastLoginAt']) => {
    if (!ts) return { time: '—', date: '' };
    const d = ts.toDate();
    return {
      time: d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
      date: d.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: '2-digit' }),
    };
  };

  return (
    <div className="sm-page">
      <div className="sm-topbar">
        <div className="sm-topbar-icon">
          <i className="ti ti-users" aria-hidden="true" />
        </div>
        <div className="sm-topbar-center">
          <div className="sm-topbar-title">จัดการพนักงาน &amp; สิทธิ์</div>
          <div className="sm-topbar-sub">Staff &amp; Permissions Management</div>
        </div>
        <span className="sm-branch-badge">
          <i className="ti ti-map-pin" style={{ fontSize: 12 }} aria-hidden="true" />
          สาขา: {branchDisplay}
        </span>
        <button type="button" className="sm-btn sm-btn-primary" onClick={openAdd}>
          <i className="ti ti-user-plus" aria-hidden="true" /> เพิ่มพนักงาน
        </button>
      </div>

      <div className="sm-tabs-bar">
        <button
          type="button"
          className={`sm-tab-btn${tab === 'staff' ? ' active' : ''}`}
          onClick={() => setTab('staff')}
        >
          <i className="ti ti-id-badge" aria-hidden="true" /> พนักงาน
          <span className="sm-tab-badge">{users.length}</span>
        </button>
        <button
          type="button"
          className={`sm-tab-btn${tab === 'permissions' ? ' active' : ''}`}
          onClick={() => setTab('permissions')}
        >
          <i className="ti ti-shield-lock" aria-hidden="true" /> สิทธิ์การใช้งาน
        </button>
        <button
          type="button"
          className={`sm-tab-btn${tab === 'activity' ? ' active' : ''}`}
          onClick={() => setTab('activity')}
        >
          <i className="ti ti-timeline" aria-hidden="true" /> ประวัติการใช้งาน
          <span className="sm-tab-badge">{activities.length}</span>
        </button>
      </div>

      <div className="sm-content">
        {loading ? (
          <div className="sm-loading">กำลังโหลดข้อมูล...</div>
        ) : error ? (
          <div className="sm-loading" style={{ color: 'var(--danger)' }}>
            โหลดข้อมูลไม่สำเร็จ: {error.message}
          </div>
        ) : tab === 'staff' ? (
          <>
            <div className="sm-toolbar">
              <div className="sm-search-wrap">
                <i className="ti ti-search" aria-hidden="true" />
                <input
                  type="text"
                  placeholder="ค้นหาชื่อ, username..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <select
                className="sm-select-filter"
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
              >
                <option value="">ทุก Role</option>
                <option value="Admin">Admin</option>
                <option value="Manager">Manager</option>
                <option value="Staff">Staff</option>
              </select>
              <select
                className="sm-select-filter"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">ทุกสถานะ</option>
                <option value="active">ใช้งาน</option>
                <option value="inactive">ปิดใช้งาน</option>
              </select>
            </div>
            <div className="sm-card">
              <div className="sm-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>พนักงาน</th>
                      <th>Role</th>
                      <th>สาขา</th>
                      <th>สถานะ</th>
                      <th>เข้าสู่ระบบล่าสุด</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.length === 0 ? (
                      <tr>
                        <td colSpan={6}>
                          <div className="sm-empty-state">
                            <i className="ti ti-users-off" aria-hidden="true" />
                            <p>ไม่พบพนักงานที่ตรงตามเงื่อนไข</p>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      filteredUsers.map((u) => (
                        <tr key={u.id}>
                          <td>
                            <div className="sm-emp-cell">
                              <div className={`sm-avatar ${avatarClass(u.id)}`}>
                                {userInitials(u.firstName, u.lastName)}
                              </div>
                              <div>
                                <div className="sm-emp-name">
                                  {u.firstName} {u.lastName}
                                </div>
                                <div className="sm-emp-id">
                                  @{u.username}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className={`sm-role-badge ${roleBadgeClass(u.role)}`}>
                              {roleLabel(u.role)}
                            </span>
                          </td>
                          <td>
                            <div className="sm-branch-tags">
                              {u.branchIds.map((bid) => (
                                <span key={bid} className="sm-branch-tag">
                                  {getBranchLabel(bid)}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <Toggle
                                checked={u.isActive}
                                onChange={(v) => void toggleActive(u.id, v)}
                              />
                              <span
                                className={`sm-status-pill ${u.isActive ? 'sm-status-on' : 'sm-status-off'}`}
                              >
                                <span className={`sm-dot ${u.isActive ? 'sm-dot-on' : 'sm-dot-off'}`} />
                                {u.isActive ? 'ใช้งาน' : 'ปิดใช้งาน'}
                              </span>
                            </div>
                          </td>
                          <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {formatLastLogin(u.lastLoginAt)}
                          </td>
                          <td>
                            <div className="sm-action-group">
                              <button
                                type="button"
                                className="sm-icon-btn"
                                title="แก้ไข"
                                onClick={() => openEdit(u)}
                              >
                                <i className="ti ti-edit" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="sm-icon-btn danger"
                                title="ลบ"
                                onClick={() =>
                                  setConfirm({
                                    userId: u.id,
                                    name: `${u.firstName} ${u.lastName}`,
                                  })
                                }
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
          </>
        ) : tab === 'permissions' ? (
          <>
            <div className="sm-toolbar">
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                กำหนดสิทธิ์เข้าถึงตาม Role — Admin ถูกล็อคไว้ทั้งหมด
              </span>
              <button
                type="button"
                className="sm-btn sm-btn-ghost sm-btn-sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => {
                  void resetRoleMatrix();
                  showToast('Reset สิทธิ์เป็นค่าเริ่มต้นเรียบร้อย', 'success');
                }}
              >
                <i className="ti ti-refresh" aria-hidden="true" /> Reset Default
              </button>
            </div>
            <div className="sm-card">
              <div className="sm-perm-matrix-header">
                <span>การอนุญาต / Module</span>
                <span className="sm-perm-col-admin">Admin</span>
                <span className="sm-perm-col-manager">Manager</span>
                <span className="sm-perm-col-staff">Staff</span>
              </div>
              {PERM_MODULES.map((mod) => (
                <div key={mod.section}>
                  <div className="sm-perm-group-header">
                    <i className={`ti ${mod.icon}`} aria-hidden="true" />
                    {mod.section}
                  </div>
                  {mod.items.map((item) => (
                    <div key={item.key} className="sm-perm-row">
                      <div>
                        <div className="sm-perm-label">{item.label}</div>
                        <div className="sm-perm-desc">{item.desc}</div>
                      </div>
                      {(['admin', 'manager', 'staff'] as const).map((role) => (
                        <div key={role} className="sm-perm-cell">
                          <Toggle
                            checked={permSets[role].has(item.key)}
                            disabled={role === 'admin'}
                            onChange={(v) => void updateRoleMatrix(role, item.key, v)}
                          />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="sm-toolbar">
              <div className="sm-chip-bar">
                {LOG_CHIPS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`sm-chip${logFilter === c.id ? ' active' : ''}`}
                    onClick={() => setLogFilter(c.id)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="sm-btn sm-btn-ghost sm-btn-sm"
                style={{ marginLeft: 'auto' }}
                onClick={exportLogCsv}
              >
                <i className="ti ti-download" aria-hidden="true" /> Export CSV
              </button>
            </div>
            <div className="sm-card">
              <div className="sm-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>เวลา</th>
                      <th>พนักงาน</th>
                      <th>ประเภท</th>
                      <th>รายละเอียด</th>
                      <th>IP / Terminal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLogs.length === 0 ? (
                      <tr>
                        <td colSpan={5}>
                          <div className="sm-empty-state">
                            <i className="ti ti-history-off" aria-hidden="true" />
                            <p>ไม่พบรายการในหมวดนี้</p>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      filteredLogs.map((l) => {
                        const meta = LOG_ICONS[l.action] ?? LOG_ICONS.EDIT!;
                        const u = users.find((x) => x.id === l.userId);
                        const t = formatActivityTime(l.createdAt);
                        return (
                          <tr key={l.id}>
                            <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                              <div style={{ fontWeight: 500 }}>{t.time}</div>
                              <div style={{ color: 'var(--text-muted)' }}>{t.date}</div>
                            </td>
                            <td>
                              <div className="sm-emp-cell">
                                {u ? (
                                  <div
                                    className={`sm-avatar ${avatarClass(u.id)}`}
                                    style={{ width: 28, height: 28, fontSize: 10 }}
                                  >
                                    {userInitials(u.firstName, u.lastName)}
                                  </div>
                                ) : null}
                                <div>
                                  <div style={{ fontSize: 13, fontWeight: 500 }}>{l.userName}</div>
                                  {u ? (
                                    <span
                                      className={`sm-role-badge ${roleBadgeClass(u.role)}`}
                                      style={{ fontSize: 10 }}
                                    >
                                      {roleLabel(u.role)}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                            </td>
                            <td>
                              <div className="sm-log-cell">
                                <div
                                  className="sm-log-type-icon"
                                  style={{ background: meta.bg, color: meta.color }}
                                >
                                  <i className={`ti ${meta.icon}`} aria-hidden="true" />
                                </div>
                                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                                  {meta.label}
                                </span>
                              </div>
                            </td>
                            <td style={{ fontSize: 13, maxWidth: 260 }}>{l.detail}</td>
                            <td
                              style={{
                                fontSize: 11,
                                color: 'var(--text-muted)',
                                fontFamily: "'Sarabun',sans-serif",
                              }}
                            >
                              {[l.ip, l.deviceId].filter(Boolean).join(' · ') || '—'}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="sm-footer">
        <div className="sm-footer-stat">
          <span className="sm-footer-num">{stats.total}</span>
          <span className="sm-footer-lbl">พนักงานทั้งหมด</span>
        </div>
        <div className="sm-footer-stat">
          <span className="sm-footer-num clr-green">{stats.active}</span>
          <span className="sm-footer-lbl">ใช้งาน</span>
        </div>
        <div className="sm-footer-stat">
          <span className="sm-footer-num clr-purple">{stats.admin}</span>
          <span className="sm-footer-lbl">Admin</span>
        </div>
        <div className="sm-footer-stat">
          <span className="sm-footer-num clr-blue">{stats.manager}</span>
          <span className="sm-footer-lbl">Manager</span>
        </div>
        <div className="sm-footer-stat">
          <span className="sm-footer-num clr-gray">{stats.staff}</span>
          <span className="sm-footer-lbl">Staff</span>
        </div>
        <div className="sm-footer-spacer" />
        <div className="sm-footer-time">
          <i className="ti ti-clock" aria-hidden="true" />
          {clock}
        </div>
      </div>

      <StaffModal
        open={staffModalOpen}
        editUser={editUser}
        onClose={() => setStaffModalOpen(false)}
        onSave={handleSave}
        saving={saving}
      />

      <ConfirmModal
        open={confirm != null}
        title={`ลบพนักงาน: ${confirm?.name ?? ''}`}
        desc="ข้อมูลพนักงานจะถูก soft delete และปิดการใช้งาน ไม่สามารถเข้าระบบได้"
        iconClass="danger"
        icon="ti-trash"
        okLabel="ลบ"
        okClass="sm-btn-danger-ghost"
        onClose={() => setConfirm(null)}
        onConfirm={() => void handleDelete()}
      />

      {toast ? (
        <div className="sm-toast-wrap">
          <div className={`sm-toast ${toast.type}`}>
            <i
              className={`ti ${toast.type === 'success' ? 'ti-circle-check' : toast.type === 'warn' ? 'ti-alert-triangle' : 'ti-info-circle'}`}
              aria-hidden="true"
            />{' '}
            {toast.msg}
          </div>
        </div>
      ) : null}
    </div>
  );
}
