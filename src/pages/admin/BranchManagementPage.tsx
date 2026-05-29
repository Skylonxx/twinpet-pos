import { useEffect, useState } from 'react';
import type { Branch } from '../../lib/types';
import {
  branchIsActive,
  branchToFormInput,
  createBranch,
  emptyBranchForm,
  updateBranch,
  useBranchManagement,
  validateBranchForm,
  type BranchFormInput,
} from '../../lib/admin/branchManagement';
import './BranchManagementPage.css';

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span className={`admin-branches-status${active ? ' active' : ' inactive'}`}>
      <span className="admin-branches-status-dot" aria-hidden="true" />
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

function BranchFormModal({
  open,
  mode,
  initial,
  saving,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  initial: BranchFormInput;
  saving: boolean;
  onClose: () => void;
  onSubmit: (form: BranchFormInput) => Promise<void>;
}) {
  const [form, setForm] = useState<BranchFormInput>(initial);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(initial);
      setFormError(null);
    }
  }, [open, initial]);

  if (!open) return null;

  const setField = <K extends keyof BranchFormInput>(key: K, value: BranchFormInput[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFormError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validateBranchForm(form, mode);
    if (validationError) {
      setFormError(validationError);
      return;
    }
    try {
      await onSubmit(form);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ');
    }
  };

  return (
    <div
      className="admin-branches-modal-overlay"
      role="presentation"
      onClick={saving ? undefined : onClose}
    >
      <div
        className="admin-branches-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="branch-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-branches-modal-header">
          <h2 id="branch-modal-title" className="admin-branches-modal-title">
            {mode === 'create' ? 'Add Branch' : 'Edit Branch'}
          </h2>
          <button
            type="button"
            className="admin-branches-icon-btn"
            onClick={onClose}
            disabled={saving}
            aria-label="ปิด"
          >
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="admin-branches-modal-body">
            {formError && (
              <div className="admin-branches-alert" role="alert">
                {formError}
              </div>
            )}

            <div className="admin-branches-field">
              <label className="admin-branches-label" htmlFor="branch-id">
                Branch ID
                {mode === 'create' && <span className="admin-branches-required">*</span>}
              </label>
              <input
                id="branch-id"
                className="admin-branches-input"
                value={form.id}
                onChange={(e) =>
                  setField('id', e.target.value.toUpperCase().replace(/\s/g, ''))
                }
                placeholder="LDP-002"
                disabled={mode === 'edit' || saving}
                readOnly={mode === 'edit'}
                autoComplete="off"
              />
              {mode === 'create' && (
                <span className="admin-branches-hint">ใช้เป็น Document ID ใน Firestore</span>
              )}
            </div>

            <div className="admin-branches-field">
              <label className="admin-branches-label" htmlFor="branch-name">
                Name<span className="admin-branches-required">*</span>
              </label>
              <input
                id="branch-name"
                className="admin-branches-input"
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder="ชื่อสาขา"
                disabled={saving}
              />
            </div>

            <label className="admin-branches-toggle-row">
              <span className="admin-branches-label">Status (Active)</span>
              <span className="admin-branches-toggle">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setField('isActive', e.target.checked)}
                  disabled={saving}
                />
                <span className="admin-branches-toggle-track" />
                <span className="admin-branches-toggle-thumb" />
              </span>
            </label>
          </div>

          <div className="admin-branches-modal-footer">
            <button
              type="button"
              className="admin-branches-btn"
              onClick={onClose}
              disabled={saving}
            >
              ยกเลิก
            </button>
            <button type="submit" className="admin-branches-btn admin-branches-btn-primary" disabled={saving}>
              {saving ? (
                <>
                  <i className="ti ti-loader-2 spin" aria-hidden="true" />
                  กำลังบันทึก…
                </>
              ) : mode === 'create' ? (
                'Add Branch'
              ) : (
                'Save Changes'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function BranchManagementPage() {
  const { branches, loading, error, refresh } = useBranchManagement();
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
  const [formInitial, setFormInitial] = useState<BranchFormInput>(emptyBranchForm());
  const [saving, setSaving] = useState(false);

  const openCreate = () => {
    setModalMode('create');
    setEditingBranch(null);
    setFormInitial(emptyBranchForm());
    setModalOpen(true);
  };

  const openEdit = (branch: Branch) => {
    setModalMode('edit');
    setEditingBranch(branch);
    setFormInitial(branchToFormInput(branch));
    setModalOpen(true);
  };

  const closeModal = () => {
    if (saving) return;
    setModalOpen(false);
    setEditingBranch(null);
  };

  const handleSubmit = async (form: BranchFormInput) => {
    setSaving(true);
    try {
      if (modalMode === 'create') {
        await createBranch(form);
      } else if (editingBranch) {
        await updateBranch(editingBranch.id, {
          name: form.name,
          isActive: form.isActive,
        });
      }
      setModalOpen(false);
      setEditingBranch(null);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin-branches-page">
      <div className="admin-branches-toolbar">
        <div className="admin-branches-heading">
          <h1>Branch Management</h1>
          <p>Master data — รายการสาขาทั้งหมดในระบบ</p>
        </div>
        <div className="admin-branches-actions">
          <button type="button" className="admin-branches-btn admin-branches-btn-primary" onClick={openCreate}>
            <i className="ti ti-plus" aria-hidden="true" />
            Add Branch
          </button>
          <button
            type="button"
            className="admin-branches-btn"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <i className={`ti ti-refresh${loading ? ' spin' : ''}`} aria-hidden="true" />
            Refresh Data
          </button>
        </div>
      </div>

      {error && (
        <div className="admin-branches-alert" role="alert">
          {error}
        </div>
      )}

      <div className="admin-branches-card">
        {loading && branches.length === 0 ? (
          <div className="admin-branches-loading" role="status">
            กำลังโหลดข้อมูลสาขา…
          </div>
        ) : branches.length === 0 ? (
          <div className="admin-branches-empty">
            <i className="ti ti-building-store" aria-hidden="true" />
            <p>ยังไม่มีข้อมูลสาขาในระบบ</p>
            <button type="button" className="admin-branches-btn admin-branches-btn-primary" onClick={openCreate}>
              <i className="ti ti-plus" aria-hidden="true" />
              Add Branch
            </button>
          </div>
        ) : (
          <>
            <div className="admin-branches-table-wrap">
              <table className="admin-branches-table">
                <thead>
                  <tr>
                    <th scope="col">Branch ID</th>
                    <th scope="col">Name</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="admin-branches-th-actions">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {branches.map((branch) => (
                    <tr key={branch.id}>
                      <td>
                        <span className="admin-branches-id">{branch.id}</span>
                      </td>
                      <td>
                        <span className="admin-branches-name">
                          {branch.name?.trim() || '—'}
                        </span>
                      </td>
                      <td>
                        <StatusBadge active={branchIsActive(branch)} />
                      </td>
                      <td className="admin-branches-td-actions">
                        <button
                          type="button"
                          className="admin-branches-icon-btn"
                          onClick={() => openEdit(branch)}
                          aria-label={`Edit ${branch.id}`}
                          title="Edit"
                        >
                          <i className="ti ti-pencil" aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="admin-branches-meta">
              {branches.length} สาขา
              {loading ? ' · กำลังอัปเดต…' : ''}
            </div>
          </>
        )}
      </div>

      <BranchFormModal
        open={modalOpen}
        mode={modalMode}
        initial={formInitial}
        saving={saving}
        onClose={closeModal}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
