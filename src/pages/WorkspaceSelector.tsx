import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { fetchAllBranches } from '../lib/admin/branchManagement';
import { useAuth } from '../lib/hooks/useAuth';
import type { Branch } from '../lib/types';
import './WorkspaceSelector.css';

type Step = 'choose' | 'branch';

export default function WorkspaceSelector() {
  const { user, setBranchId } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('choose');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [loadingBranches, setLoadingBranches] = useState(false);

  // Non-Global-Admin users should not reach this page.
  if (user && !user.branchIds.includes('ALL')) {
    return <Navigate to="/dashboard" replace />;
  }

  const displayName = user ? `${user.firstName} ${user.lastName}`.trim() : '';

  const handleAdminChoice = () => {
    navigate('/admin', { replace: true });
  };

  const handlePosChoice = async () => {
    setLoadingBranches(true);
    try {
      const all = await fetchAllBranches();
      const active = all.filter((b) => b.isActive !== false);
      setBranches(active);
      setSelectedBranchId(active[0]?.id ?? '');
    } finally {
      setLoadingBranches(false);
    }
    setStep('branch');
  };

  const handleEnterPOS = () => {
    if (!selectedBranchId) return;
    setBranchId(selectedBranchId);
    navigate('/dashboard', { replace: true });
  };

  // ── Step 2: branch picker ─────────────────────────────────────────────────

  if (step === 'branch') {
    return (
      <div className="ws-page">
        <div className="ws-box">
          <div className="ws-header">
            <div className="ws-logo">🏪</div>
            <div className="ws-welcome">เลือกสาขา</div>
            <div className="ws-sub">เลือกสาขาที่ต้องการเปิด POS</div>
          </div>

          <div className="ws-branch-card">
            <div className="ws-branch-head">
              <i className="ti ti-building-store" aria-hidden="true" />
              สาขาที่ต้องการทำงาน
            </div>

            <div className="ws-field">
              <span className="ws-label">สาขา</span>
              <select
                className="ws-select"
                value={selectedBranchId}
                onChange={(e) => setSelectedBranchId(e.target.value)}
                disabled={branches.length === 0}
              >
                {branches.length === 0 ? (
                  <option value="">กำลังโหลดสาขา...</option>
                ) : (
                  branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name?.trim() || b.id}
                      {b.name?.trim() ? ` (${b.id})` : ''}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="ws-btn-row">
              <button
                type="button"
                className="ws-btn ws-btn-ghost"
                onClick={() => setStep('choose')}
              >
                <i className="ti ti-arrow-left" aria-hidden="true" />
                ย้อนกลับ
              </button>
              <button
                type="button"
                className="ws-btn ws-btn-primary"
                onClick={handleEnterPOS}
                disabled={!selectedBranchId}
              >
                <i className="ti ti-login" aria-hidden="true" />
                เข้าสู่ POS
              </button>
            </div>
          </div>

          <p className="ws-footer-hint">
            Global Admin · เข้าสู่ระบบด้วยสิทธิ์เต็ม
          </p>
        </div>
      </div>
    );
  }

  // ── Step 1: workspace chooser ─────────────────────────────────────────────

  return (
    <div className="ws-page">
      <div className="ws-box">
        <div className="ws-header">
          <div className="ws-logo">🐾</div>
          <div className="ws-welcome">สวัสดี{displayName ? `, ${displayName}` : ''}!</div>
          <div className="ws-sub">กรุณาเลือกโหมดการทำงาน</div>
        </div>

        <div className="ws-cards">
          <button
            type="button"
            className="ws-card"
            onClick={() => void handlePosChoice()}
            disabled={loadingBranches}
          >
            <span className="ws-card-icon">🛒</span>
            <span className="ws-card-title">เข้าใช้งานหน้าร้าน</span>
            <span className="ws-card-sub">POS · การขาย สต็อก และรับสินค้าเข้า</span>
          </button>

          <button
            type="button"
            className="ws-card"
            onClick={handleAdminChoice}
          >
            <span className="ws-card-icon">📊</span>
            <span className="ws-card-title">เข้าใช้งานระบบบริหาร</span>
            <span className="ws-card-sub">Admin · ภาพรวม สาขา พนักงาน และรายงาน</span>
          </button>
        </div>

        <p className="ws-footer-hint">
          Global Admin · เข้าสู่ระบบด้วยสิทธิ์เต็ม — สามารถเข้าถึงได้ทุกส่วน
        </p>
      </div>
    </div>
  );
}
