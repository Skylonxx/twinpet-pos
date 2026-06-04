import { useCallback, useEffect, useMemo, useState } from 'react';
import StaffFormModal from '../../components/staff/StaffFormModal';
import { fetchAllBranches } from '../../lib/admin/branchManagement';
import { getBranchLabel, seedBranchLabelCache } from '../../lib/branches';
import { useAuth } from '../../lib/hooks/useAuth';
import { downloadCsv } from '../../lib/stockReport/exportCsv';
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
} from '../../lib/staffManagement/types';
import { useStaffManagement } from '../../lib/staffManagement/useStaffManagement';
import type { User } from '../../lib/types';
import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../../components/ui';
import '../StaffManagementPage.css';

const LOG_CHIPS: { id: LogFilter; label: string }[] = [
  { id: 'all', label: 'ทั้งหมด' },
  { id: 'login', label: 'เข้า/ออก' },
  { id: 'sale', label: 'การขาย' },
  { id: 'edit', label: 'แก้ไขสินค้า' },
  { id: 'void', label: 'ยกเลิก/Void' },
  { id: 'discount', label: 'ส่วนลด' },
];

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

export default function AdminStaffManagementPage() {
  const { branchId, user: actor } = useAuth();
  const [allBranches, setAllBranches] = useState<Array<{ id: string; name: string }>>([]);
  const actorInfo = actor
    ? { id: actor.id, name: `${actor.firstName} ${actor.lastName}` }
    : null;

  const activityBranchId = branchId ?? actor?.branchIds[0] ?? null;

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
  } = useStaffManagement(activityBranchId, actorInfo, { hq: true });

  useEffect(() => {
    void fetchAllBranches().then((list) => {
      seedBranchLabelCache(list);
      setAllBranches(list.map((b) => ({ id: b.id, name: b.name?.trim() || b.id })));
    });
  }, []);

  const branchLabel = useCallback(
    (id: string) => allBranches.find((b) => b.id === id)?.name ?? getBranchLabel(id),
    [allBranches],
  );

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
    if (!editUser && !/^\d{4}$/.test(form.pin)) {
      showToast('กรุณากรอก PIN 4 หลักสำหรับพนักงานใหม่', 'warn');
      return;
    }
    if (editUser && form.pin && !/^\d{4}$/.test(form.pin)) {
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
          <div className="sm-topbar-title">จัดการพนักงาน (Admin HQ)</div>
          <div className="sm-topbar-sub">Staff Management — ทุกสาขา</div>
        </div>
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
              <div className="flex-1 min-h-0 overflow-auto">
                <Table hoverable className="min-w-[700px]">
                  <TableHead className="sticky top-0 z-[1]">
                    <TableRow>
                      <TableHeadCell>พนักงาน</TableHeadCell>
                      <TableHeadCell>Role</TableHeadCell>
                      <TableHeadCell>สาขา</TableHeadCell>
                      <TableHeadCell>สถานะ</TableHeadCell>
                      <TableHeadCell>เข้าสู่ระบบล่าสุด</TableHeadCell>
                      <TableHeadCell className="text-right">Actions</TableHeadCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredUsers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6}>
                          <div className="sm-empty-state">
                            <i className="ti ti-users-off" aria-hidden="true" />
                            <p>ไม่พบพนักงานที่ตรงตามเงื่อนไข</p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredUsers.map((u) => (
                        <TableRow key={u.id}>
                          <TableCell>
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
                          </TableCell>
                          <TableCell>
                            <span className={`sm-role-badge ${roleBadgeClass(u.role)}`}>
                              {roleLabel(u.role)}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="sm-branch-tags">
                              {u.branchIds.map((bid) => (
                                <span key={bid} className="sm-branch-tag">
                                  {branchLabel(bid)}
                                </span>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell>
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
                          </TableCell>
                          <TableCell style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {formatLastLogin(u.lastLoginAt)}
                          </TableCell>
                          <TableCell>
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
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
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
              <div className="sm-perm-scroll">
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
              <div className="flex-1 min-h-0 overflow-auto">
                <Table hoverable className="min-w-[700px]">
                  <TableHead className="sticky top-0 z-[1]">
                    <TableRow>
                      <TableHeadCell>เวลา</TableHeadCell>
                      <TableHeadCell>พนักงาน</TableHeadCell>
                      <TableHeadCell>ประเภท</TableHeadCell>
                      <TableHeadCell>รายละเอียด</TableHeadCell>
                      <TableHeadCell>IP / Terminal</TableHeadCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredLogs.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5}>
                          <div className="sm-empty-state">
                            <i className="ti ti-history-off" aria-hidden="true" />
                            <p>ไม่พบรายการในหมวดนี้</p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredLogs.map((l) => {
                        const meta = LOG_ICONS[l.action] ?? LOG_ICONS.EDIT!;
                        const u = users.find((x) => x.id === l.userId);
                        const t = formatActivityTime(l.createdAt);
                        return (
                          <TableRow key={l.id}>
                            <TableCell style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                              <div style={{ fontWeight: 500 }}>{t.time}</div>
                              <div style={{ color: 'var(--text-muted)' }}>{t.date}</div>
                            </TableCell>
                            <TableCell>
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
                            </TableCell>
                            <TableCell>
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
                            </TableCell>
                            <TableCell style={{ fontSize: 13, maxWidth: 260 }}>{l.detail}</TableCell>
                            <TableCell
                              style={{
                                fontSize: 11,
                                color: 'var(--text-muted)',
                                fontFamily: "'Sarabun',sans-serif",
                              }}
                            >
                              {[l.ip, l.deviceId].filter(Boolean).join(' · ') || '—'}
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
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

      <StaffFormModal
        open={staffModalOpen}
        editUser={editUser}
        branches={allBranches}
        branchPicker="dropdown"
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
