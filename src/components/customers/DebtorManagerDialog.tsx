import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  creditAvailable,
  creditPaymentMethodLabel,
  formatCreditPaymentDate,
  receiveCreditPayment,
  resolveOutstandingBalance,
  useCustomerCreditPayments,
} from '../../lib/customers/creditService';
import { customerFullName, fmtBaht, fmtBahtDec } from '../../lib/customers/types';
import { db, isFirebaseConfigured } from '../../lib/firebase';
import { useActiveShift } from '../../lib/hooks/useActiveShift';
import type { CreditAccount, Customer } from '../../lib/types';
import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../ui';
import '../../pages/ReceivablesPage.css';

type DialogTab = 'payment' | 'history';

type Props = {
  customer: Customer;
  branchId: string;
  actorId: string;
  creditAccount?: CreditAccount | null;
  initialTab?: DialogTab;
  refreshKey?: number;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  onToast?: (msg: string, type?: 'success' | 'warn') => void;
};

function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function DebtorManagerDialog({
  customer,
  branchId,
  actorId,
  creditAccount = null,
  initialTab = 'payment',
  refreshKey = 0,
  isOpen,
  onClose,
  onSuccess,
  onToast,
}: Props) {
  const [tab, setTab] = useState<DialogTab>(initialTab);
  const [payAmount, setPayAmount] = useState(0);
  const [payMethod, setPayMethod] = useState<'cash' | 'transfer'>('cash');
  const [payNotes, setPayNotes] = useState('');
  const [paymentDateLocal, setPaymentDateLocal] = useState('');
  const [paying, setPaying] = useState(false);

  const outstanding = resolveOutstandingBalance(customer, creditAccount);
  const creditLimit = creditAccount?.creditLimit ?? customer.creditLimit;
  const creditRemain = creditAvailable(creditLimit, outstanding);
  const { activeShift } = useActiveShift(branchId, actorId);
  const { payments, loading: historyLoading, error: historyError } = useCustomerCreditPayments(
    customer.id,
    refreshKey,
  );

  useEffect(() => {
    if (!isOpen) return;
    setTab(initialTab);
    setPayAmount(outstanding);
    setPayMethod('cash');
    setPayNotes('');
    setPaymentDateLocal(toDatetimeLocalValue(new Date()));
  }, [isOpen, customer.id, outstanding, initialTab]);

  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

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

  return createPortal(
    <div className="ar-dlg-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ar-dlg" onClick={(e) => e.stopPropagation()}>
        <div className="ar-dlg-header">
          <span className="ar-dlg-title">{customerFullName(customer)}</span>
          <button type="button" className="ar-dlg-close" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <div className="ar-dlg-tabs">
          <button
            type="button"
            className={`ar-dlg-tab${tab === 'payment' ? ' active' : ''}`}
            onClick={() => setTab('payment')}
          >
            รับชำระหนี้
          </button>
          <button
            type="button"
            className={`ar-dlg-tab${tab === 'history' ? ' active' : ''}`}
            onClick={() => setTab('history')}
          >
            ประวัติการชำระ
          </button>
        </div>

        <div className="ar-dlg-body">
          {tab === 'payment' ? (
            <>
              <div className="ar-dlg-debt-card">
                <div className="ar-dlg-debt-lbl">หนี้ค้างชำระ</div>
                <div className="ar-dlg-debt-val">{fmtBaht(outstanding)}</div>
                {creditLimit > 0 ? (
                  <div className="ar-dlg-debt-meta">วงเงินคงเหลือ {fmtBaht(creditRemain)}</div>
                ) : null}
              </div>
              <div className="ar-dlg-field">
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
              <div className="ar-dlg-field">
                <label>วันที่/เวลารับชำระ</label>
                <input
                  type="datetime-local"
                  value={paymentDateLocal}
                  onChange={(e) => setPaymentDateLocal(e.target.value)}
                />
              </div>
              <div className="ar-dlg-field">
                <label>วิธีชำระเงิน</label>
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value as 'cash' | 'transfer')}
                >
                  <option value="cash">เงินสด (Cash)</option>
                  <option value="transfer">โอนเงิน (Transfer)</option>
                </select>
              </div>
              <div className="ar-dlg-field">
                <label>หมายเหตุ (ถ้ามี)</label>
                <input
                  value={payNotes}
                  onChange={(e) => setPayNotes(e.target.value)}
                  placeholder="เช่น รับชำระที่เคาน์เตอร์"
                />
              </div>
            </>
          ) : (
            <>
              <div className="ar-dlg-history-summary">
                <div className="ar-dlg-history-stat">
                  <span className="ar-dlg-history-lbl">หนี้ค้างชำระ</span>
                  <strong className="ar-dlg-history-val debt">{fmtBaht(outstanding)}</strong>
                </div>
                {creditLimit > 0 ? (
                  <>
                    <div className="ar-dlg-history-stat">
                      <span className="ar-dlg-history-lbl">วงเงินเชื่อ</span>
                      <strong className="ar-dlg-history-val">{fmtBaht(creditLimit)}</strong>
                    </div>
                    <div className="ar-dlg-history-stat">
                      <span className="ar-dlg-history-lbl">วงเงินคงเหลือ</span>
                      <strong className="ar-dlg-history-val ok">{fmtBaht(creditRemain)}</strong>
                    </div>
                  </>
                ) : null}
              </div>

              {historyError ? (
                <div className="ar-dlg-history-empty ar-dlg-history-error">{historyError}</div>
              ) : null}

              <div className="ar-dlg-history-table-wrap">
                <Table hoverable>
                  <TableHead>
                    <TableRow>
                      <TableHeadCell>วันที่/เวลา</TableHeadCell>
                      <TableHeadCell className="text-right">ยอดชำระ</TableHeadCell>
                      <TableHeadCell>วิธีชำระ</TableHeadCell>
                      <TableHeadCell>หมายเหตุ</TableHeadCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {historyLoading ? (
                      <TableRow>
                        <TableCell colSpan={4} className="ar-empty">
                          กำลังโหลด...
                        </TableCell>
                      </TableRow>
                    ) : payments.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="ar-empty">
                          ยังไม่มีประวัติการชำระหนี้
                        </TableCell>
                      </TableRow>
                    ) : (
                      payments.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell>{formatCreditPaymentDate(p.createdAt)}</TableCell>
                          <TableCell className="text-right">{fmtBahtDec(p.amount)}</TableCell>
                          <TableCell>{creditPaymentMethodLabel(p.paymentMethod)}</TableCell>
                          <TableCell className="ar-notes">{p.notes || '—'}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>

        <div className="ar-dlg-footer">
          {tab === 'payment' ? (
            <>
              <button type="button" className="ar-dlg-btn ar-dlg-btn-ghost" onClick={onClose}>
                ยกเลิก
              </button>
              <button
                type="button"
                className="ar-dlg-btn ar-dlg-btn-primary"
                disabled={paying || payAmount <= 0 || payAmount > outstanding}
                onClick={() => void handleSubmit()}
              >
                {paying ? 'กำลังบันทึก...' : 'บันทึกรับชำระ'}
              </button>
            </>
          ) : (
            <button type="button" className="ar-dlg-btn ar-dlg-btn-primary" onClick={onClose}>
              ปิด
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
