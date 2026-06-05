import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BranchTransferLineInput } from '../../lib/inventory/transferTypes';
import type { InventoryTransfer, InventoryTransferItem } from '../../lib/inventory/transferTypes';
import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../ui';
import './TransferModals.css';

type EditLine = {
  productId: string;
  name: string;
  sku: string;
  sourceStock: number;
  transferQty: number;
};

type Props = {
  open: boolean;
  transfer: InventoryTransfer | null;
  items: InventoryTransferItem[];
  saving: boolean;
  branchLabel: (id: string) => string;
  onSave: (lines: BranchTransferLineInput[], reason: string) => void;
  onClose: () => void;
};

/**
 * Admin edit of a transfer. Modify quantities / remove lines, then save.
 * Saving runs the safe "Cancel original + Create new" flow on the backend.
 */
export default function TransferEditModal({
  open,
  transfer,
  items,
  saving,
  branchLabel,
  onSave,
  onClose,
}: Props) {
  // Parent remounts via `key` when the edit target changes, so initializing
  // from props once at mount captures the loaded items correctly.
  const [lines, setLines] = useState<EditLine[]>(() =>
    items.map((it) => ({
      productId: it.productId,
      name: it.productName,
      sku: it.sku,
      sourceStock: it.sourceStock,
      transferQty: it.transferQty,
    })),
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const activeCount = useMemo(() => lines.filter((l) => l.transferQty > 0).length, [lines]);

  if (!open || !transfer) return null;

  const updateQty = (productId: string, qty: number) => {
    setLines((prev) =>
      prev.map((l) => (l.productId === productId ? { ...l, transferQty: qty } : l)),
    );
  };

  const removeLine = (productId: string) => {
    setLines((prev) => prev.filter((l) => l.productId !== productId));
  };

  const handleSave = () => {
    setError(null);
    const active = lines.filter((l) => l.transferQty > 0);
    if (active.length === 0) {
      setError('ต้องมีอย่างน้อย 1 รายการที่จำนวนมากกว่า 0');
      return;
    }
    onSave(
      active.map((l) => ({
        productId: l.productId,
        name: l.name,
        sku: l.sku,
        sourceStock: l.sourceStock,
        transferQty: l.transferQty,
      })),
      reason.trim(),
    );
  };

  return createPortal(
    <div className="tr-modal-overlay" role="dialog" aria-modal="true" onClick={() => !saving && onClose()}>
      <div className="tr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tr-modal-head">
          <span className="tr-modal-head-id">
            <i className="ti ti-edit" aria-hidden="true" /> แก้ไขการโอนย้าย — {transfer.id}
          </span>
          <span className="tr-modal-head-spacer" />
          <button
            type="button"
            className="tr-modal-close"
            onClick={onClose}
            disabled={saving}
            aria-label="ปิด"
          >
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <div className="tr-modal-body">
          <div className="tr-route">
            {branchLabel(transfer.fromBranchId)}
            <i className="ti ti-arrow-right" aria-hidden="true" />
            {branchLabel(transfer.toBranchId)}
          </div>

          <div className="tr-warn">
            <i className="ti ti-info-circle" aria-hidden="true" /> การบันทึกจะ
            <strong> ยกเลิกเอกสารเดิมและสร้างเอกสารใหม่ </strong>
            โดยคืนสต็อกตามต้นทุนเดิมก่อน แล้วโอนใหม่ตามจำนวนที่แก้ไข
          </div>

          {error ? <div className="tr-warn" style={{ background: '#fbe9e3', borderColor: '#f3c0ad', color: '#b23c17' }}>{error}</div> : null}

          <Table>
            <TableHead>
              <TableRow>
                <TableHeadCell>สินค้า</TableHeadCell>
                <TableHeadCell className="text-right">จำนวนที่โอน</TableHeadCell>
                <TableHeadCell className="text-right w-11" />
              </TableRow>
            </TableHead>
            <TableBody>
              {lines.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} style={{ textAlign: 'center', color: '#9b98b8', padding: 16 }}>
                    ไม่มีรายการ
                  </TableCell>
                </TableRow>
              ) : (
                lines.map((l) => (
                  <TableRow key={l.productId}>
                    <TableCell>
                      <div className="tr-item-name">{l.name}</div>
                      <div className="tr-item-sku">{l.sku}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <input
                        className="tr-qty-input"
                        type="number"
                        min={0}
                        step={1}
                        value={l.transferQty || ''}
                        placeholder="0"
                        onChange={(e) =>
                          updateQty(l.productId, e.target.value === '' ? 0 : Number(e.target.value))
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <button
                        type="button"
                        className="tr-del-btn"
                        onClick={() => removeLine(l.productId)}
                        aria-label="ลบรายการ"
                      >
                        <i className="ti ti-trash" aria-hidden="true" />
                      </button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          <div className="tr-cancel-field">
            <label htmlFor="tr-edit-reason">เหตุผลการแก้ไข (ไม่บังคับ)</label>
            <textarea
              id="tr-edit-reason"
              rows={2}
              placeholder="ระบุเหตุผล..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        <div className="tr-modal-footer">
          <button type="button" className="tr-btn tr-btn-ghost" onClick={onClose} disabled={saving}>
            ยกเลิก
          </button>
          <span className="tr-spacer" />
          <span style={{ alignSelf: 'center', fontSize: 12, color: '#76739a' }}>
            {activeCount} รายการ
          </span>
          <button type="button" className="tr-btn tr-btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <i className="ti ti-loader tr-spin" aria-hidden="true" /> กำลังบันทึก...
              </>
            ) : (
              <>
                <i className="ti ti-device-floppy" aria-hidden="true" /> บันทึกการแก้ไข
              </>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
