import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getBranchLabel } from '../../lib/branches';
import { useAuth } from '../../lib/hooks/useAuth';
import { formatValueImpact, type InventoryAdjustment } from '../../lib/inventory/types';
import type { InventoryTransfer } from '../../lib/inventory/transferTypes';
import { useInventoryAdjustments } from '../../lib/inventory/useInventoryAdjustments';
import { useInventoryTransfers } from '../../lib/inventory/useInventoryTransfers';
import './InventoryPage.css';

type TabId = 'adjustments' | 'transfers';

function formatDocDate(
  dateStr: string,
  createdAt: InventoryAdjustment['createdAt'] | InventoryTransfer['createdAt'],
): string {
  if (dateStr) {
    const d = new Date(dateStr);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString('th-TH', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
    }
  }
  if (createdAt && typeof createdAt === 'object' && 'toDate' in createdAt) {
    return (createdAt as { toDate: () => Date }).toDate().toLocaleDateString('th-TH', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  }
  return '—';
}

export default function InventoryPage() {
  const navigate = useNavigate();
  const { branchId } = useAuth();
  const [activeTab, setActiveTab] = useState<TabId>('adjustments');
  const { adjustments, loading: adjLoading } = useInventoryAdjustments(branchId);
  const { transfers, loading: trLoading } = useInventoryTransfers(branchId);

  return (
    <div className="inv-page">
      <header className="inv-topbar">
        <span className="inv-topbar-title">จัดการสต็อก</span>
        <div className="inv-topbar-actions">
          <button
            type="button"
            className="inv-add-btn inv-add-btn-secondary"
            onClick={() => navigate('/inventory/transfer')}
          >
            <i className="ti ti-arrows-exchange" aria-hidden="true" /> โอนย้ายสินค้า
          </button>
          <button type="button" className="inv-add-btn" onClick={() => navigate('/inventory/adjust')}>
            <i className="ti ti-plus" aria-hidden="true" /> ปรับปรุงยอดสต็อก
          </button>
        </div>
      </header>

      <div className="inv-content">
        <div className="inv-card">
          <div className="inv-card-head inv-card-head-tabs">
            <div className="inv-tabs">
              <button
                type="button"
                className={`inv-tab${activeTab === 'adjustments' ? ' active' : ''}`}
                onClick={() => setActiveTab('adjustments')}
              >
                ประวัติปรับปรุง
              </button>
              <button
                type="button"
                className={`inv-tab${activeTab === 'transfers' ? ' active' : ''}`}
                onClick={() => setActiveTab('transfers')}
              >
                ประวัติโอนย้าย
              </button>
            </div>
          </div>

          {activeTab === 'adjustments' ? (
            <div className="inv-table-wrap">
              <table className="inv-table">
                <thead>
                  <tr>
                    <th>วันที่</th>
                    <th>ประเภท</th>
                    <th>สาเหตุ</th>
                    <th className="inv-r">จำนวนรายการ</th>
                    <th className="inv-r">มูลค่าผลกระทบ (฿)</th>
                    <th>ผู้ทำรายการ</th>
                    <th>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {adjLoading ? (
                    <tr>
                      <td colSpan={7} className="inv-table-msg">
                        กำลังโหลด...
                      </td>
                    </tr>
                  ) : adjustments.length === 0 ? (
                    <tr>
                      <td colSpan={7}>
                        <div className="inv-empty">
                          <div className="inv-empty-icon">
                            <i className="ti ti-box-seam" aria-hidden="true" />
                          </div>
                          <div className="inv-empty-title">ยังไม่มีประวัติการปรับปรุง</div>
                          <div className="inv-empty-sub">
                            กด &quot;+ ปรับปรุงยอดสต็อก&quot; เพื่อสร้างเอกสารปรับยอดสต็อกครั้งแรก
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    adjustments.map((adj) => (
                      <tr key={adj.id}>
                        <td>{formatDocDate(adj.adjustDate, adj.createdAt)}</td>
                        <td>ปรับปรุงสต็อก</td>
                        <td>{adj.reason}</td>
                        <td className="inv-r">{adj.itemCount}</td>
                        <td className="inv-r">
                          <span
                            className={
                              adj.totalValueImpact < 0
                                ? 'inv-value-neg'
                                : adj.totalValueImpact > 0
                                  ? 'inv-value-pos'
                                  : 'inv-value-zero'
                            }
                          >
                            {formatValueImpact(adj.totalValueImpact)}
                          </span>
                        </td>
                        <td>{adj.staffName}</td>
                        <td>
                          <span className="inv-status-badge">เสร็จสิ้น</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="inv-table-wrap">
              <table className="inv-table">
                <thead>
                  <tr>
                    <th>วันที่</th>
                    <th>เลขที่โอน</th>
                    <th>ต้นทาง ➔ ปลายทาง</th>
                    <th className="inv-r">รายการ</th>
                    <th>หมายเหตุ</th>
                  </tr>
                </thead>
                <tbody>
                  {trLoading ? (
                    <tr>
                      <td colSpan={5} className="inv-table-msg">
                        กำลังโหลด...
                      </td>
                    </tr>
                  ) : transfers.length === 0 ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="inv-empty">
                          <div className="inv-empty-icon">
                            <i className="ti ti-arrows-exchange" aria-hidden="true" />
                          </div>
                          <div className="inv-empty-title">ยังไม่มีประวัติการโอนย้าย</div>
                          <div className="inv-empty-sub">
                            กด &quot;โอนย้ายสินค้า&quot; เพื่อสร้างเอกสารโอนย้ายครั้งแรก
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    transfers.map((tr) => (
                      <tr key={tr.id}>
                        <td>{formatDocDate(tr.transferDate, tr.createdAt)}</td>
                        <td>
                          <span className="inv-tr-id">{tr.id}</span>
                        </td>
                        <td>
                          <span className="inv-tr-route">
                            {getBranchLabel(tr.fromBranchId)}
                            <i className="ti ti-arrow-right" aria-hidden="true" />
                            {getBranchLabel(tr.toBranchId)}
                          </span>
                        </td>
                        <td className="inv-r">{tr.itemCount}</td>
                        <td className="inv-tr-note">{tr.note || '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
