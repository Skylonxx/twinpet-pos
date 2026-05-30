import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/hooks/useAuth';
import { formatValueImpact, type InventoryAdjustment } from '../../lib/inventory/types';
import { useInventoryAdjustments } from '../../lib/inventory/useInventoryAdjustments';
import './InventoryPage.css';

function formatDocDate(dateStr: string, createdAt: InventoryAdjustment['createdAt']): string {
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
  const { adjustments, loading: adjLoading } = useInventoryAdjustments(branchId);

  return (
    <div className="inv-page">
      <header className="inv-topbar">
        <span className="inv-topbar-title">จัดการสต็อก</span>
        <div className="inv-topbar-actions">
          <button
            type="button"
            className="inv-add-btn inv-add-btn-secondary"
            onClick={() => navigate('/inventory/adjust?mode=in')}
          >
            <i className="ti ti-arrow-down-left" aria-hidden="true" /> ปรับปรุงยอด (รับเข้า)
          </button>
          <button
            type="button"
            className="inv-add-btn"
            onClick={() => navigate('/inventory/adjust?mode=out')}
          >
            <i className="ti ti-arrow-up-right" aria-hidden="true" /> ปรับปรุงยอด (จ่ายออก)
          </button>
        </div>
      </header>

      <div className="inv-content">
        <div className="inv-card">
          <div className="inv-card-head">ประวัติการปรับปรุงสต็อก</div>

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
                          กดปุ่ม &quot;ปรับปรุงยอด&quot; ด้านบนเพื่อสร้างเอกสารปรับยอดสต็อกครั้งแรก
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
        </div>
      </div>
    </div>
  );
}
