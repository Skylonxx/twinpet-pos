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
import {
  clearAllTransactionData,
  clearInventoryTransactions,
  clearSalesData,
  clearStockLedgerAndFifo,
  resetAllProductStocks,
  type DeletionSummary,
} from '../../lib/admin/clearTestData';
import './BranchManagementPage.css';

const DANGER_CONFIRM =
  'คุณแน่ใจหรือไม่? ข้อมูลจะถูกลบถาวรและกู้คืนไม่ได้';

type DangerAction = {
  key: string;
  label: string;
  icon: string;
  /** Extra warning prepended to the standard confirm for the destructive master action. */
  confirmPrefix?: string;
  run: () => Promise<DeletionSummary>;
};

const DANGER_ACTIONS: DangerAction[] = [
  {
    key: 'sales',
    label: 'ลบประวัติการขายทั้งหมด',
    icon: 'ti-receipt',
    run: clearSalesData,
  },
  {
    key: 'inventory',
    label: 'ลบประวัติการรับเข้าและโอนสินค้า',
    icon: 'ti-truck-delivery',
    run: clearInventoryTransactions,
  },
  {
    key: 'ledger',
    label: 'ลบประวัติ Movement และ FIFO',
    icon: 'ti-history',
    run: clearStockLedgerAndFifo,
  },
  {
    key: 'stocks',
    label: 'รีเซ็ตสต็อกสินค้าเป็น 0',
    icon: 'ti-package-off',
    run: resetAllProductStocks,
  },
];

const FACTORY_RESET: DangerAction = {
  key: 'factory',
  label: '🔥 ล้างข้อมูลธุรกรรมทั้งหมด (Factory Reset)',
  icon: 'ti-flame',
  confirmPrefix:
    'นี่คือการล้างข้อมูลธุรกรรมทั้งหมด (การขาย, การรับเข้า, การโอน, Movement, FIFO และสต็อก)\n\n',
  run: clearAllTransactionData,
};

function formatSummary(summary: DeletionSummary): string {
  const entries = Object.entries(summary).filter(([, count]) => count > 0);
  if (entries.length === 0) return 'ไม่มีข้อมูลที่ต้องลบ';
  return entries.map(([name, count]) => `${name}: ${count}`).join(', ');
}

function DangerZone() {
  const [runningKey, setRunningKey] = useState<string | null>(null);
  const [status, setStatus] = useState<
    { kind: 'success' | 'error'; message: string } | null
  >(null);

  const busy = runningKey !== null;

  const handleRun = async (action: DangerAction) => {
    if (busy) return;
    const confirmMessage = `${action.confirmPrefix ?? ''}${DANGER_CONFIRM}`;
    if (!window.confirm(confirmMessage)) return;

    setRunningKey(action.key);
    setStatus(null);
    try {
      const summary = await action.run();
      setStatus({
        kind: 'success',
        message: `✅ ${action.label} สำเร็จ — ${formatSummary(summary)}`,
      });
    } catch (err) {
      console.error(`[DangerZone] ${action.key} failed`, err);
      setStatus({
        kind: 'error',
        message: `❌ ${action.label} ล้มเหลว: ${
          err instanceof Error ? err.message : 'เกิดข้อผิดพลาด'
        }`,
      });
    } finally {
      setRunningKey(null);
    }
  };

  const renderButton = (action: DangerAction, master = false) => {
    const isRunning = runningKey === action.key;
    return (
      <button
        key={action.key}
        type="button"
        className={`admin-danger-btn${master ? ' admin-danger-btn-master' : ''}`}
        onClick={() => void handleRun(action)}
        disabled={busy}
      >
        <i
          className={`ti ${isRunning ? 'ti-loader-2 spin' : action.icon}`}
          aria-hidden="true"
        />
        {isRunning ? 'กำลังดำเนินการ…' : action.label}
      </button>
    );
  };

  return (
    <section className="admin-danger-zone" aria-label="Danger Zone">
      <div className="admin-danger-header">
        <i className="ti ti-alert-triangle" aria-hidden="true" />
        <div>
          <h2 className="admin-danger-title">เครื่องมือสำหรับนักพัฒนา (Danger Zone)</h2>
          <p className="admin-danger-subtitle">
            ใช้สำหรับล้างข้อมูลทดสอบในช่วง UAT เท่านั้น — การลบเป็นการถาวรและกู้คืนไม่ได้
          </p>
        </div>
      </div>

      {status && (
        <div
          className={`admin-danger-status${
            status.kind === 'error' ? ' admin-danger-status-error' : ''
          }`}
          role={status.kind === 'error' ? 'alert' : 'status'}
        >
          {status.message}
        </div>
      )}

      <div className="admin-danger-actions">
        {DANGER_ACTIONS.map((action) => renderButton(action))}
      </div>

      <div className="admin-danger-master">{renderButton(FACTORY_RESET, true)}</div>
    </section>
  );
}

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

      <DangerZone />

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
