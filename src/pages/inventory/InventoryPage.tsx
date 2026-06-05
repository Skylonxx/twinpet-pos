import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/hooks/useAuth';
import { formatValueImpact, type InventoryAdjustment } from '../../lib/inventory/types';
import { useInventoryAdjustments } from '../../lib/inventory/useInventoryAdjustments';
import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../../components/ui';
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
            <Table hoverable>
              <TableHead>
                <TableRow>
                  <TableHeadCell>วันที่</TableHeadCell>
                  <TableHeadCell>ประเภท</TableHeadCell>
                  <TableHeadCell>สาเหตุ</TableHeadCell>
                  <TableHeadCell className="text-right">จำนวนรายการ</TableHeadCell>
                  <TableHeadCell className="text-right">มูลค่าผลกระทบ (฿)</TableHeadCell>
                  <TableHeadCell>ผู้ทำรายการ</TableHeadCell>
                  <TableHeadCell>สถานะ</TableHeadCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {adjLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="inv-table-msg">
                      กำลังโหลด...
                    </TableCell>
                  </TableRow>
                ) : adjustments.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7}>
                      <div className="inv-empty">
                        <div className="inv-empty-icon">
                          <i className="ti ti-box-seam" aria-hidden="true" />
                        </div>
                        <div className="inv-empty-title">ยังไม่มีประวัติการปรับปรุง</div>
                        <div className="inv-empty-sub">
                          กดปุ่ม &quot;ปรับปรุงยอด&quot; ด้านบนเพื่อสร้างเอกสารปรับยอดสต็อกครั้งแรก
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  adjustments.map((adj) => (
                    <TableRow key={adj.id}>
                      <TableCell>{formatDocDate(adj.adjustDate, adj.createdAt)}</TableCell>
                      <TableCell>ปรับปรุงสต็อก</TableCell>
                      <TableCell>{adj.reason}</TableCell>
                      <TableCell className="text-right">{adj.itemCount}</TableCell>
                      <TableCell className="text-right">
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
                      </TableCell>
                      <TableCell>{adj.staffName}</TableCell>
                      <TableCell>
                        <span className="inv-status-badge">เสร็จสิ้น</span>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </div>
  );
}
