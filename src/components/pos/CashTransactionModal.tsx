import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { recordCashTransaction } from '../../lib/pos/shiftService';
import type { CashTransactionType, Shift } from '../../lib/types';
import './CashTransactionModal.css';

type CashTransactionModalProps = {
  shift: Shift;
  onClose: () => void;
  onSuccess: () => void;
};

export default function CashTransactionModal({
  shift,
  onClose,
  onSuccess,
}: CashTransactionModalProps) {
  const [type, setType] = useState<CashTransactionType>('pay_in');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    const parsedAmount = parseFloat(amount);
    if (Number.isNaN(parsedAmount) || parsedAmount <= 0) {
      setError('กรุณาระบุจำนวนเงินที่ถูกต้อง');
      return;
    }
    if (!note.trim()) {
      setError('กรุณาระบุหมายเหตุ');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await recordCashTransaction({
        shiftId: shift.id,
        branchId: shift.branchId,
        staffId: shift.staffId,
        staffName: shift.staffName,
        type,
        amount: parsedAmount,
        note: note.trim(),
      });
      window.alert(
        `จำลองการสั่งพิมพ์สลิป ${type === 'pay_in' ? 'นำเงินเข้า' : 'นำเงินออก'}`,
      );
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ');
    } finally {
      setSubmitting(false);
    }
  }, [amount, note, onSuccess, shift, type]);

  return createPortal(
    <div
      className="cash-tx-modal-bg"
      role="dialog"
      aria-modal="true"
      aria-label="นำเงินเข้า/ออก"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cash-tx-modal">
        <div className="cash-tx-modal-icon" aria-hidden="true">
          <i className="ti ti-arrows-exchange" />
        </div>
        <div>
          <h2 className="cash-tx-modal-title">นำเงินเข้า / นำเงินออก</h2>
          <p className="cash-tx-modal-sub">บันทึกการเคลื่อนไหวเงินสดในลิ้นชักระหว่างกะ</p>
        </div>

        <div className="cash-tx-type-toggle" role="radiogroup" aria-label="ประเภทรายการ">
          <button
            type="button"
            role="radio"
            aria-checked={type === 'pay_in'}
            className={`cash-tx-type-btn${type === 'pay_in' ? ' on--in' : ''}`}
            onClick={() => setType('pay_in')}
          >
            นำเงินเข้า (Pay-in)
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={type === 'pay_out'}
            className={`cash-tx-type-btn${type === 'pay_out' ? ' on--out' : ''}`}
            onClick={() => setType('pay_out')}
          >
            นำเงินออก (Pay-out)
          </button>
        </div>

        <div className="cash-tx-field">
          <label className="cash-tx-label" htmlFor="cash-tx-amount">
            จำนวนเงิน
          </label>
          <input
            id="cash-tx-amount"
            className="cash-tx-input"
            type="number"
            min={0}
            step="0.01"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
          />
        </div>

        <div className="cash-tx-field">
          <label className="cash-tx-label" htmlFor="cash-tx-note">
            หมายเหตุ <span style={{ color: '#c0392b' }}>*</span>
          </label>
          <textarea
            id="cash-tx-note"
            className="cash-tx-textarea"
            placeholder="ระบุเหตุผล เช่น ซื้อของใช้สำนักงาน"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {error && <p className="cash-tx-error">{error}</p>}

        <div className="cash-tx-actions">
          <button
            type="button"
            className="cash-tx-btn cash-tx-btn--ghost"
            disabled={submitting}
            onClick={onClose}
          >
            ยกเลิก
          </button>
          <button
            type="button"
            className="cash-tx-btn cash-tx-btn--primary"
            disabled={submitting}
            onClick={() => void handleSubmit()}
          >
            {submitting ? 'กำลังบันทึก...' : '✅ บันทึก'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
