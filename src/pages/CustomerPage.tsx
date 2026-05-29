import { useMemo, useState } from 'react';
import CustomerDetailModal from '../components/customers/CustomerDetailModal';
import CustomerFormModal from '../components/customers/CustomerFormModal';
import TierManagementModal from '../components/customers/TierManagementModal';
import { getBranchLabel } from '../lib/branches';
import {
  contactTypeBadgeStyle,
  contactTypeLabel,
  customerFullName,
  customerInitials,
  inferContactType,
  normalizeCustomerForm,
  fmtBaht,
  type CustomerFormData,
} from '../lib/customers/types';
import { useCustomers } from '../lib/customers/useCustomers';
import { useAuth } from '../lib/hooks/useAuth';
import type { ContactType, Customer } from '../lib/types';
import './CustomerPage.css';

export default function CustomerPage() {
  const { branchId, user } = useAuth();
  const { customers, priceLevels, creditMap, loading, error, saveCustomer, softDelete, refreshDev } =
    useCustomers(branchId);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<ContactType | ''>('');
  const [formOpen, setFormOpen] = useState(false);
  const [tierModalOpen, setTierModalOpen] = useState(false);
  const [editCustomer, setEditCustomer] = useState<Customer | null>(null);
  const [detailCustomer, setDetailCustomer] = useState<Customer | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'warn' } | null>(null);

  const branchDisplay = branchId ? getBranchLabel(branchId) : '—';

  const levelMap = useMemo(() => new Map(priceLevels.map((p) => [p.id, p.name])), [priceLevels]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers.filter((c) => {
      const mq =
        !q ||
        `${c.firstName} ${c.lastName} ${c.phone} ${c.memberNo}`.toLowerCase().includes(q);
      const ms =
        !statusFilter ||
        (statusFilter === 'active' ? c.isActive : !c.isActive);
      const mt = !typeFilter || inferContactType(c) === typeFilter;
      return mq && ms && mt;
    });
  }, [customers, search, statusFilter, typeFilter]);

  const stats = useMemo(
    () => ({
      total: customers.length,
      active: customers.filter((c) => c.isActive).length,
      withCredit: customers.filter((c) => (creditMap.get(c.id)?.creditUsed ?? 0) > 0).length,
      totalDebt: [...creditMap.values()].reduce((s, a) => s + a.creditUsed, 0),
    }),
    [customers, creditMap],
  );

  const showToast = (msg: string, type: 'success' | 'warn' = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  };

  const handleSave = async (form: CustomerFormData) => {
    const normalized = normalizeCustomerForm(form);
    if (!normalized.firstName.trim() || !normalized.lastName.trim() || !normalized.phone.trim()) {
      showToast('กรุณากรอกชื่อและเบอร์โทร', 'warn');
      return;
    }
    setSaving(true);
    try {
      const saved = await saveCustomer(normalized, editCustomer?.id);
      setFormOpen(false);
      setEditCustomer(null);
      if (detailCustomer?.id === editCustomer?.id) {
        setDetailCustomer(saved);
      }
      showToast(editCustomer ? 'อัปเดตลูกค้าเรียบร้อย' : 'เพิ่มลูกค้าเรียบร้อย');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ', 'warn');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    await softDelete(deleteId);
    if (detailCustomer?.id === deleteId) setDetailCustomer(null);
    setDeleteId(null);
    showToast('ลบรายชื่อเรียบร้อย');
  };

  const openDetail = (c: Customer) => setDetailCustomer(c);

  return (
    <div className="cm-page">
      <div className="cm-topbar">
        <div className="cm-topbar-icon">
          <i className="ti ti-users" aria-hidden="true" />
        </div>
        <div className="cm-topbar-center">
          <div className="cm-topbar-title">จัดการลูกค้า</div>
          <div className="cm-topbar-sub">Customer &amp; Wholesale Management</div>
        </div>
        <span className="cm-branch-badge">
          <i className="ti ti-map-pin" style={{ fontSize: 12 }} aria-hidden="true" />
          สาขา: {branchDisplay}
        </span>
        <div className="cm-topbar-actions">
          <button
            type="button"
            className="cm-btn cm-btn-ghost"
            onClick={() => setTierModalOpen(true)}
          >
            ⚙️ จัดการกลุ่มลูกค้า
          </button>
          <button
            type="button"
            className="cm-btn cm-btn-primary"
            onClick={() => {
              setEditCustomer(null);
              setFormOpen(true);
            }}
          >
            <i className="ti ti-user-plus" aria-hidden="true" /> เพิ่มรายชื่อ
          </button>
        </div>
      </div>

      <div className="cm-content">
        <div className="cm-toolbar">
          <div className="cm-search-wrap">
            <i className="ti ti-search" aria-hidden="true" />
            <input
              type="text"
              placeholder="ค้นหาชื่อ / เบอร์โทร / รหัสสมาชิก..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="cm-select-filter"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as ContactType | '')}
          >
            <option value="">ทุกประเภท</option>
            <option value="retail">ลูกค้าทั่วไป</option>
            <option value="wholesale">ลูกค้าขายส่ง</option>
          </select>
          <select
            className="cm-select-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">ทุกสถานะ</option>
            <option value="active">ใช้งาน</option>
            <option value="inactive">ระงับ</option>
          </select>
        </div>

        {loading ? (
          <div className="cm-loading">กำลังโหลดข้อมูล...</div>
        ) : error ? (
          <div className="cm-loading" style={{ color: 'var(--red)' }}>
            โหลดข้อมูลไม่สำเร็จ: {error.message}
          </div>
        ) : (
          <div className="cm-card">
            <div className="cm-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>ชื่อ</th>
                    <th>ประเภท</th>
                    <th>รหัส</th>
                    <th>เบอร์โทร</th>
                    <th>ระดับราคา</th>
                    <th className="num">หนี้ค้าง</th>
                    <th>สถานะ</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={8}>
                        <div className="cm-empty-state">
                          <i className="ti ti-users-off" aria-hidden="true" />
                          <p>ไม่พบรายชื่อที่ตรงตามเงื่อนไข</p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filtered.map((c) => {
                      const debt = c.outstandingBalance ?? creditMap.get(c.id)?.creditUsed ?? 0;
                      const type = inferContactType(c);
                      const typeStyle = contactTypeBadgeStyle(type);
                      return (
                        <tr key={c.id} onClick={() => openDetail(c)} style={{ cursor: 'pointer' }}>
                          <td>
                            <div className="cm-emp-cell">
                              <div className="cm-avatar">
                                {customerInitials(c)}
                              </div>
                              <div>
                                <div className="cm-emp-name">{customerFullName(c)}</div>
                                {c.tags.length > 0 ? (
                                  <div className="cm-emp-sub">{c.tags.join(', ')}</div>
                                ) : null}
                              </div>
                            </div>
                          </td>
                          <td>
                            <span
                              className="cm-type-badge"
                              style={{ background: typeStyle.bg, color: typeStyle.color }}
                            >
                              {contactTypeLabel(type)}
                            </span>
                          </td>
                          <td style={{ fontFamily: "'Prompt',sans-serif", color: 'var(--p600)' }}>
                            {c.memberNo}
                          </td>
                          <td>{c.phone}</td>
                          <td>{levelMap.get(c.priceLevelId) ?? c.priceLevelId}</td>
                          <td className="num" style={{ color: debt > 0 ? 'var(--red)' : undefined }}>
                            {debt > 0 ? fmtBaht(debt) : '—'}
                          </td>
                          <td>
                            <span className={`cm-status-pill ${c.isActive ? 'cm-status-on' : 'cm-status-off'}`}>
                              <span className={`cm-dot ${c.isActive ? 'cm-dot-on' : 'cm-dot-off'}`} />
                              {c.isActive ? 'ใช้งาน' : 'ระงับ'}
                            </span>
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <div className="cm-action-group">
                              <button
                                type="button"
                                className="cm-icon-btn"
                                title="ดูรายละเอียด"
                                onClick={() => openDetail(c)}
                              >
                                <i className="ti ti-eye" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="cm-icon-btn"
                                title="แก้ไข"
                                onClick={() => {
                                  setEditCustomer(c);
                                  setFormOpen(true);
                                }}
                              >
                                <i className="ti ti-edit" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="cm-icon-btn danger"
                                title="ลบ"
                                onClick={() => setDeleteId(c.id)}
                              >
                                <i className="ti ti-trash" aria-hidden="true" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="cm-footer">
        <div className="cm-footer-stat">
          <span className="cm-footer-num">{stats.total}</span>
          <span className="cm-footer-lbl">รายชื่อทั้งหมด</span>
        </div>
        <div className="cm-footer-stat">
          <span className="cm-footer-num clr-green">{stats.active}</span>
          <span className="cm-footer-lbl">ใช้งาน</span>
        </div>
        <div className="cm-footer-stat">
          <span className="cm-footer-num clr-red">{fmtBaht(stats.totalDebt)}</span>
          <span className="cm-footer-lbl">หนี้รวม</span>
        </div>
        <div className="cm-footer-spacer" />
      </div>

      <CustomerFormModal
        open={formOpen}
        editCustomer={editCustomer}
        priceLevels={priceLevels.length ? priceLevels : [{ id: 'RETAIL', name: 'Retail' }]}
        onClose={() => {
          setFormOpen(false);
          setEditCustomer(null);
        }}
        onSave={handleSave}
        saving={saving}
      />

      {detailCustomer && branchId && user ? (
        <CustomerDetailModal
          customer={detailCustomer}
          creditAccount={creditMap.get(detailCustomer.id) ?? null}
          priceLevels={priceLevels}
          branchId={branchId}
          actorId={user.id}
          open={!!detailCustomer}
          onClose={() => setDetailCustomer(null)}
          onSave={async (form) => {
            const saved = await saveCustomer(normalizeCustomerForm(form), detailCustomer.id);
            setDetailCustomer(saved);
            refreshDev();
            showToast('บันทึกข้อมูลเรียบร้อย');
          }}
          onCreditPaid={refreshDev}
          onToast={showToast}
        />
      ) : null}

      <TierManagementModal
        open={tierModalOpen}
        onClose={() => setTierModalOpen(false)}
        onToast={showToast}
      />

      {deleteId ? (
        <div className="cm-dialog-overlay" onClick={() => setDeleteId(null)}>
          <div className="cm-dialog cm-dialog-sm" onClick={(e) => e.stopPropagation()}>
            <div className="cm-dialog-body" style={{ textAlign: 'center', padding: '24px 20px' }}>
              <i className="ti ti-trash" style={{ fontSize: 32, color: 'var(--red)', marginBottom: 12 }} aria-hidden="true" />
              <div style={{ fontWeight: 500, marginBottom: 6 }}>ยืนยันการลบ</div>
              <div style={{ fontSize: 13, color: 'var(--g400)' }}>
                ข้อมูลจะถูก soft delete และไม่แสดงในรายการ
              </div>
            </div>
            <div className="cm-dialog-footer">
              <button type="button" className="cm-btn cm-btn-ghost" onClick={() => setDeleteId(null)}>
                ยกเลิก
              </button>
              <button type="button" className="cm-btn cm-btn-danger-ghost" onClick={() => void handleDelete()}>
                ลบ
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className="cm-toast-wrap">
          <div className={`cm-toast ${toast.type}`}>{toast.msg}</div>
        </div>
      ) : null}
    </div>
  );
}
