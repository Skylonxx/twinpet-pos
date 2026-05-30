import { createPortal } from 'react-dom';
import type { InventoryTransfer, InventoryTransferItem } from '../../lib/inventory/transferTypes';
import './TransferModals.css';

function baht(n: number): string {
  return (n || 0).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDateTime(ts: InventoryTransfer['createdAt']): string {
  const d = ts?.toDate?.();
  if (!d) return '—';
  return d.toLocaleString('th-TH', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function TransferStatusBadge({ status }: { status: InventoryTransfer['status'] }) {
  const cls = status === 'cancelled' ? 'tr-status-cancelled' : 'tr-status-completed';
  const label = status === 'cancelled' ? 'ยกเลิกแล้ว' : 'สำเร็จ';
  return <span className={`tr-status ${cls}`}>{label}</span>;
}

type Props = {
  open: boolean;
  transfer: InventoryTransfer | null;
  items: InventoryTransferItem[];
  loading: boolean;
  branchLabel: (id: string) => string;
  onClose: () => void;
  /** Provided → shows a "Cancel transfer" action (only for completed transfers). */
  onCancelTransfer?: () => void;
  /** Provided → shows an "Edit" action (only for completed transfers). */
  onEdit?: () => void;
  busy?: boolean;
};

export default function TransferDetailModal({
  open,
  transfer,
  items,
  loading,
  branchLabel,
  onClose,
  onCancelTransfer,
  onEdit,
  busy = false,
}: Props) {
  if (!open || !transfer) return null;

  const isCompleted = transfer.status === 'completed';

  return createPortal(
    <div className="tr-modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="tr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tr-modal-head">
          <span className="tr-modal-head-id">{transfer.id}</span>
          <TransferStatusBadge status={transfer.status} />
          <span className="tr-modal-head-spacer" />
          <button type="button" className="tr-modal-close" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <div className="tr-modal-body">
          <div className="tr-route">
            {branchLabel(transfer.fromBranchId)}
            <i className="ti ti-arrow-right" aria-hidden="true" />
            {branchLabel(transfer.toBranchId)}
          </div>

          <div className="tr-meta-row">
            <span>วันที่</span>
            <strong>{fmtDateTime(transfer.createdAt)}</strong>
          </div>
          <div className="tr-meta-row">
            <span>ผู้ทำรายการ</span>
            <strong>{transfer.staffName || '—'}</strong>
          </div>
          <div className="tr-meta-row">
            <span>จำนวนรายการ</span>
            <strong>{transfer.itemCount}</strong>
          </div>
          {transfer.status === 'cancelled' && transfer.cancelReason ? (
            <div className="tr-note-box">
              <strong>เหตุผลการยกเลิก:</strong> {transfer.cancelReason}
              {transfer.cancelledByName ? ` (โดย ${transfer.cancelledByName})` : ''}
            </div>
          ) : transfer.note ? (
            <div className="tr-note-box">{transfer.note}</div>
          ) : null}

          <div className="tr-sec-label">รายการที่โอนย้าย</div>
          {loading ? (
            <div style={{ padding: 16, textAlign: 'center', color: '#9b98b8', fontSize: 13 }}>
              กำลังโหลดรายการ...
            </div>
          ) : (
            <table className="tr-item-table">
              <thead>
                <tr>
                  <th>สินค้า</th>
                  <th className="r">จำนวน</th>
                  <th className="r">ต้นทุน/หน่วย</th>
                  <th className="r">มูลค่ารวม</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'center', color: '#9b98b8', padding: 16 }}>
                      ไม่มีรายการ
                    </td>
                  </tr>
                ) : (
                  items.map((item, idx) => (
                    <tr key={`${item.productId}-${idx}`}>
                      <td>
                        <div className="tr-item-name">{item.productName}</div>
                        <div className="tr-item-sku">{item.sku}</div>
                        {item.sourceLotDetails?.length ? (
                          <div className="tr-lot-details">
                            ต้นทุนตามล็อต:
                            {item.sourceLotDetails.map((d, i) => (
                              <span key={i} className="tr-lot-chip">
                                {d.qty} × ฿{baht(d.costPerUnit)}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </td>
                      <td className="r">{item.transferQty}</td>
                      <td className="r">฿{baht(item.unitCost)}</td>
                      <td className="r">฿{baht(item.unitCost * item.transferQty)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>

        <div className="tr-modal-footer">
          <button type="button" className="tr-btn tr-btn-ghost" onClick={onClose} disabled={busy}>
            ปิด
          </button>
          <span className="tr-spacer" />
          {isCompleted && onEdit ? (
            <button type="button" className="tr-btn tr-btn-primary" onClick={onEdit} disabled={busy}>
              <i className="ti ti-edit" aria-hidden="true" /> แก้ไข
            </button>
          ) : null}
          {isCompleted && onCancelTransfer ? (
            <button
              type="button"
              className="tr-btn tr-btn-danger"
              onClick={onCancelTransfer}
              disabled={busy}
            >
              <i className="ti ti-ban" aria-hidden="true" /> ยกเลิกการโอน
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
