import { useEffect, useState } from 'react';
import '../../pages/CustomerPage.css';
import {
  creditAvailable,
  receiveCreditPayment,
  resolveOutstandingBalance,
} from '../../lib/customers/creditService';
import { customerFullName, fmtBaht } from '../../lib/customers/types';
import { db, isFirebaseConfigured } from '../../lib/firebase';
import { ACTIVE_SHIFT_LOOKUP_PENDING_MESSAGE, useActiveShift } from '../../lib/hooks/useActiveShift';
import { SERVER_AUTHORITATIVE_CLOSE_ENABLED } from '../../lib/pos/shiftCloseAuthoritativeClient';
import { ACTIVE_SHIFT_LOCAL_STATE_UNAVAILABLE_MESSAGE } from '../../lib/pos/shiftService';
import type { CreditAccount, Customer } from '../../lib/types';

type Props = {
  customer: Customer;
  branchId: string;
  actorId: string;
  creditAccount?: CreditAccount | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  onToast?: (msg: string, type?: 'success' | 'warn') => void;
};

function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CreditPaymentModal({
  customer,
  branchId,
  actorId,
  creditAccount = null,
  isOpen,
  onClose,
  onSuccess,
  onToast,
}: Props) {
  const outstanding = resolveOutstandingBalance(customer, creditAccount);
  const creditLimit = creditAccount?.creditLimit ?? customer.creditLimit;
  const creditRemain = creditAvailable(creditLimit, outstanding);
  const { activeShift, loading: shiftLoading, unavailable: shiftUnavailable } = useActiveShift(branchId, actorId);
  // Packet 023: gate ON, a payment may not be submitted until the lookup for the CURRENT branch/staff has settled.
  // Gate OFF keeps the legacy behavior (no wait on the lookup).
  const shiftLookupPending = SERVER_AUTHORITATIVE_CLOSE_ENABLED && shiftLoading;

  const [payAmount, setPayAmount] = useState(0);
  const [payMethod, setPayMethod] = useState<'cash' | 'transfer'>('cash');
  const [payNotes, setPayNotes] = useState('');
  const [paymentDateLocal, setPaymentDateLocal] = useState('');
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setPayAmount(outstanding);
    setPayMethod('cash');
    setPayNotes('');
    setPaymentDateLocal(toDatetimeLocalValue(new Date()));
  }, [isOpen, customer.id, outstanding]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!payAmount || payAmount <= 0) {
      onToast?.('กรุณาระบุยอดชำระ', 'warn');
      return;
    }
    if (payAmount > outstanding) {
      onToast?.('ยอดชำระเกินหนี้ค้างชำระ', 'warn');
      return;
    }
    // Packet 023: the payment lands in the active shift's drawer — never record it without knowing which shift that is.
    if (shiftLookupPending) {
      onToast?.(ACTIVE_SHIFT_LOOKUP_PENDING_MESSAGE, 'warn');
      return;
    }
    if (shiftUnavailable) {
      onToast?.(ACTIVE_SHIFT_LOCAL_STATE_UNAVAILABLE_MESSAGE, 'warn');
      return;
    }

    const paymentDate = paymentDateLocal ? new Date(paymentDateLocal) : new Date();
    if (Number.isNaN(paymentDate.getTime())) {
      onToast?.('วันที่ชำระไม่ถูกต้อง', 'warn');
      return;
    }

    setPaying(true);
    try {
      await receiveCreditPayment(
        {
          customerId: customer.id,
          branchId,
          amount: payAmount,
          paymentMethod: payMethod,
          notes: payNotes,
          createdBy: actorId,
          paymentDate,
          shiftId: activeShift?.id,
        },
        isFirebaseConfigured ? db : undefined,
      );
      onSuccess?.();
      onToast?.('รับชำระเงินเรียบร้อย');
      onClose();
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : 'ชำระหนี้ไม่สำเร็จ', 'warn');
    } finally {
      setPaying(false);
    }
  };

  return (
    <div className="cm-pay-overlay" onClick={onClose}>
      <div className="cm-pay-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="cm-pay-header">รับชำระหนี้</div>
        <div className="cm-pay-body">
          <p className="cm-pay-customer-name">{customerFullName(customer)}</p>
          <div className="cm-pay-debt">
            <div className="cm-pay-debt-lbl">หนี้ค้างชำระ</div>
            <div className="cm-pay-debt-val">{fmtBaht(outstanding)}</div>
            {creditLimit > 0 ? (
              <div className="cm-pay-debt-meta">วงเงินคงเหลือ {fmtBaht(creditRemain)}</div>
            ) : null}
          </div>
          <div className="cm-modal-field">
            <label>ยอดชำระ (บาท)</label>
            <input
              type="number"
              min={1}
              max={outstanding}
              step="any"
              value={payAmount || ''}
              onChange={(e) => setPayAmount(parseFloat(e.target.value) || 0)}
            />
          </div>
          <div className="cm-modal-field">
            <label>วันที่/เวลารับชำระ</label>
            <input
              type="datetime-local"
              value={paymentDateLocal}
              onChange={(e) => setPaymentDateLocal(e.target.value)}
            />
          </div>
          <div className="cm-modal-field">
            <label>วิธีชำระเงิน</label>
            <select
              value={payMethod}
              onChange={(e) => setPayMethod(e.target.value as 'cash' | 'transfer')}
            >
              <option value="cash">เงินสด (Cash)</option>
              <option value="transfer">โอนเงิน (Transfer)</option>
            </select>
          </div>
          <div className="cm-modal-field">
            <label>หมายเหตุ (ถ้ามี)</label>
            <input
              value={payNotes}
              onChange={(e) => setPayNotes(e.target.value)}
              placeholder="เช่น รับชำระที่เคาน์เตอร์"
            />
          </div>
        </div>
        <div className="cm-pay-footer">
          <button type="button" className="cm-modal-btn-cancel" onClick={onClose}>
            ยกเลิก
          </button>
          <button
            type="button"
            className="cm-modal-btn-save"
            disabled={paying || shiftLookupPending || payAmount <= 0 || payAmount > outstanding}
            onClick={() => void handleSubmit()}
          >
            {paying ? 'กำลังบันทึก...' : shiftLookupPending ? 'กำลังตรวจสอบกะ...' : 'ยืนยันรับชำระ'}
          </button>
        </div>
      </div>
    </div>
  );
}
