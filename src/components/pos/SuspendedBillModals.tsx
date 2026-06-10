import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatMoney } from '../../lib/pos/cartUtils';
import type { SuspendedBill } from '../../lib/pos/suspendedBills';
import './SuspendedBillModals.css';

type HoldNoteModalProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: (note: string) => void;
};

export function HoldBillNoteModal({ open, onClose, onConfirm }: HoldNoteModalProps) {
  const [note, setNote] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setNote('');
      return;
    }
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  const handleConfirm = useCallback(() => {
    onConfirm(note.trim() || '—');
    setNote('');
  }, [note, onConfirm]);

  if (!open) return null;

  return createPortal(
    <div
      className="pos-sb-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="พักบิล"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="pos-sb-dialog pos-sb-dialog--note">
        <div className="pos-sb-hd">
          <h2 className="pos-sb-title">พักบิล</h2>
          <button type="button" className="pos-sb-close" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>
        <p className="pos-sb-sub">บันทึกตะกร้าปัจจุบันไว้ชั่วคราว (ไม่ตัดสต็อก)</p>
        <label className="pos-sb-label" htmlFor="hold-bill-note">
          หมายเหตุ / อ้างอิงลูกค้า
        </label>
        <input
          id="hold-bill-note"
          ref={inputRef}
          className="pos-sb-input"
          type="text"
          maxLength={80}
          placeholder="เช่น ลูกค้ารอของ / โต๊ะ 3"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleConfirm();
            }
          }}
        />
        <div className="pos-sb-actions">
          <button type="button" className="pos-sb-btn pos-sb-btn--ghost" onClick={onClose}>
            ยกเลิก
          </button>
          <button type="button" className="pos-sb-btn pos-sb-btn--primary" onClick={handleConfirm}>
            ยืนยันพักบิล
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function formatHeldTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('th-TH', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type SuspendedBillsListModalProps = {
  open: boolean;
  bills: SuspendedBill[];
  onClose: () => void;
  onRestore: (bill: SuspendedBill) => void;
  onRemove?: (bill: SuspendedBill) => void;
};

export function SuspendedBillsListModal({
  open,
  bills,
  onClose,
  onRestore,
  onRemove,
}: SuspendedBillsListModalProps) {
  if (!open) return null;

  return createPortal(
    <div
      className="pos-sb-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="บิลที่พักไว้"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="pos-sb-dialog pos-sb-dialog--list">
        <div className="pos-sb-hd">
          <h2 className="pos-sb-title">บิลที่พักไว้ ({bills.length})</h2>
          <button type="button" className="pos-sb-close" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>
        <div className="pos-sb-body">
          {bills.length === 0 ? (
            <div className="pos-sb-empty">ยังไม่มีบิลที่พักไว้</div>
          ) : (
            <ul className="pos-sb-list">
              {bills.map((bill) => (
                <li key={bill.id} className="pos-sb-item">
                  <div className="pos-sb-item-main">
                    <div className="pos-sb-item-note">{bill.note}</div>
                    <div className="pos-sb-item-meta">
                      <span>{formatHeldTime(bill.createdAt)}</span>
                      <span>
                        {bill.cartItems.length} รายการ · {bill.itemCount} ชิ้น
                      </span>
                    </div>
                  </div>
                  <div className="pos-sb-item-right">
                    <div className="pos-sb-item-total">฿{formatMoney(bill.totalAmount)}</div>
                    <div className="pos-sb-item-actions">
                      {onRemove && (
                        <button
                          type="button"
                          className="pos-sb-remove-btn"
                          onClick={() => onRemove(bill)}
                        >
                          ยกเลิก
                        </button>
                      )}
                      <button
                        type="button"
                        className="pos-sb-restore-btn"
                        onClick={() => onRestore(bill)}
                      >
                        เรียกคืน
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="pos-sb-footer">
          <button type="button" className="pos-sb-btn pos-sb-btn--ghost" onClick={onClose}>
            ปิด
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
