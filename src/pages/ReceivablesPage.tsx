import { useMemo, useState } from 'react';
import DebtorManagerDialog from '../components/customers/DebtorManagerDialog';
import { getBranchLabel } from '../lib/branches';
import {
  creditPaymentMethodLabel,
  formatCreditPaymentDate,
  formatCustomerActivityDate,
  getCustomerLastActivity,
  isCustomerCreditOverdue,
  useCreditPaymentHistory,
  useDebtors,
} from '../lib/customers/creditService';
import { customerFullName, fmtBaht, fmtBahtDec } from '../lib/customers/types';
import { useCustomers } from '../lib/customers/useCustomers';
import { useAuth } from '../lib/hooks/useAuth';
import './ReceivablesPage.css';

type ReceivablesTab = 'debtors' | 'history';

const MIN_BALANCE_OPTIONS = [
  { value: 0, label: 'ยอดค้างทั้งหมด' },
  { value: 1000, label: 'มากกว่า ฿1,000' },
  { value: 10000, label: 'มากกว่า ฿10,000' },
] as const;

export default function ReceivablesPage() {
  const { branchId, user } = useAuth();
  const [tab, setTab] = useState<ReceivablesTab>('debtors');
  const [refreshKey, setRefreshKey] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [minBalanceFilter, setMinBalanceFilter] = useState(0);
  const [activeDebtorId, setActiveDebtorId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'warn' } | null>(null);

  const { debtors, loading: debtorsLoading } = useDebtors(branchId, refreshKey);
  const { paymentHistory, loading: historyLoading } = useCreditPaymentHistory(branchId, refreshKey);
  const { creditMap, refreshDev } = useCustomers(branchId);

  const branchDisplay = branchId ? getBranchLabel(branchId) : '—';

  const activeDebtor = useMemo(
    () => (activeDebtorId ? debtors.find((c) => c.id === activeDebtorId) ?? null : null),
    [activeDebtorId, debtors],
  );

  const filteredDebtors = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return debtors.filter((c) => {
      const balance = c.outstandingBalance ?? 0;
      if (balance <= minBalanceFilter) return false;
      if (!q) return true;
      const haystack = [
        customerFullName(c),
        c.phone,
        c.memberNo,
        c.firstName,
        c.lastName,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [debtors, searchTerm, minBalanceFilter]);

  const totalDebt = useMemo(
    () => debtors.reduce((sum, c) => sum + (c.outstandingBalance ?? 0), 0),
    [debtors],
  );

  const showToast = (msg: string, type: 'success' | 'warn' = 'success') => {
    setToast({ msg, type });
    window.setTimeout(() => setToast(null), 2800);
  };

  const handlePaymentSuccess = () => {
    setRefreshKey((k) => k + 1);
    refreshDev();
  };

  return (
    <div className="ar-page">
      <div className="ar-topbar">
        <div className="ar-topbar-icon">
          <i className="ti ti-notebook" aria-hidden="true" />
        </div>
        <div className="ar-topbar-center">
          <div className="ar-topbar-title">สมุดบัญชีลูกหนี้</div>
          <div className="ar-topbar-sub">Accounts Receivable</div>
        </div>
        <span className="ar-branch-badge">
          <i className="ti ti-map-pin" style={{ fontSize: 12 }} aria-hidden="true" />
          สาขา: {branchDisplay}
        </span>
      </div>

      <div className="ar-summary-row">
        <div className="ar-summary-card">
          <div className="ar-summary-label">ยอดหนี้ค้างชำระรวมทั้งหมด</div>
          <div className="ar-summary-value">{fmtBaht(totalDebt)}</div>
          <div className="ar-summary-meta">{debtors.length} ลูกหนี้คงค้าง</div>
        </div>
      </div>

      <div className="ar-toolbar">
        <div className="ar-search-wrap">
          <i className="ti ti-search" aria-hidden="true" />
          <input
            type="text"
            placeholder="ค้นหาชื่อ / เบอร์โทร / รหัสสมาชิก..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <select
          className="ar-select-filter"
          value={minBalanceFilter}
          onChange={(e) => setMinBalanceFilter(Number(e.target.value))}
        >
          {MIN_BALANCE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="ar-tabs">
        <button
          type="button"
          className={`ar-tab${tab === 'debtors' ? ' active' : ''}`}
          onClick={() => setTab('debtors')}
        >
          ลูกหนี้คงค้าง
        </button>
        <button
          type="button"
          className={`ar-tab${tab === 'history' ? ' active' : ''}`}
          onClick={() => setTab('history')}
        >
          ประวัติรับชำระ
        </button>
      </div>

      <div className="ar-body">
        {tab === 'debtors' ? (
          <div className="ar-table-wrap">
            <table className="ar-table">
              <thead>
                <tr>
                  <th>ชื่อลูกค้า</th>
                  <th>เบอร์โทร</th>
                  <th className="r">ยอดค้างชำระ</th>
                  <th>วันที่เคลื่อนไหวล่าสุด</th>
                  <th>สถานะ</th>
                  <th style={{ width: 120, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {debtorsLoading ? (
                  <tr>
                    <td colSpan={6} className="ar-empty">
                      กำลังโหลด...
                    </td>
                  </tr>
                ) : filteredDebtors.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="ar-empty">
                      {debtors.length === 0 ? 'ไม่มีลูกหนี้คงค้าง' : 'ไม่พบรายการที่ตรงตามเงื่อนไข'}
                    </td>
                  </tr>
                ) : (
                  filteredDebtors.map((c) => {
                    const lastActivity = getCustomerLastActivity(c);
                    const overdue = isCustomerCreditOverdue(c);

                    return (
                      <tr key={c.id}>
                        <td>
                          <div className="ar-name">{customerFullName(c)}</div>
                          <div className="ar-sub">{c.memberNo}</div>
                        </td>
                        <td>{c.phone}</td>
                        <td className="r ar-debt">{fmtBahtDec(c.outstandingBalance ?? 0)}</td>
                        <td>
                          {lastActivity ? (
                            <>
                              <div className="ar-activity-label">{lastActivity.label}</div>
                              <div className="ar-activity-date">
                                {formatCustomerActivityDate(lastActivity.date)}
                              </div>
                            </>
                          ) : (
                            <span className="ar-muted">—</span>
                          )}
                        </td>
                        <td>
                          {overdue ? (
                            <span className="ar-badge-overdue">🔴 เกินกำหนด</span>
                          ) : (
                            <span className="ar-badge-ok">ปกติ</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className="ar-action-btn ar-action-btn-manage"
                            onClick={() => setActiveDebtorId(c.id)}
                          >
                            จัดการ
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="ar-table-wrap">
            <table className="ar-table">
              <thead>
                <tr>
                  <th>วันที่/เวลา</th>
                  <th>ลูกค้า</th>
                  <th className="r">ยอดชำระ</th>
                  <th>วิธีชำระ</th>
                  <th>หมายเหตุ</th>
                </tr>
              </thead>
              <tbody>
                {historyLoading ? (
                  <tr>
                    <td colSpan={5} className="ar-empty">
                      กำลังโหลด...
                    </td>
                  </tr>
                ) : paymentHistory.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="ar-empty">
                      ยังไม่มีประวัติรับชำระ
                    </td>
                  </tr>
                ) : (
                  paymentHistory.map((p) => (
                    <tr key={p.id}>
                      <td>{formatCreditPaymentDate(p.createdAt)}</td>
                      <td>
                        <div className="ar-name">{p.customerName}</div>
                        <div className="ar-sub">{p.customerId}</div>
                      </td>
                      <td className="r">{fmtBahtDec(p.amount)}</td>
                      <td>{creditPaymentMethodLabel(p.paymentMethod)}</td>
                      <td className="ar-notes">{p.notes || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {activeDebtor && branchId && user ? (
        <DebtorManagerDialog
          customer={activeDebtor}
          branchId={branchId}
          actorId={user.id}
          creditAccount={creditMap.get(activeDebtor.id) ?? null}
          refreshKey={refreshKey}
          isOpen
          onClose={() => setActiveDebtorId(null)}
          onSuccess={handlePaymentSuccess}
          onToast={showToast}
        />
      ) : null}

      {toast ? (
        <div className="ar-toast-wrap">
          <div className={`ar-toast ar-toast-${toast.type}`}>{toast.msg}</div>
        </div>
      ) : null}
    </div>
  );
}
