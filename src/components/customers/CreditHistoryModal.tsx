import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../ui';
import '../../pages/CustomerPage.css';
import {
  creditAvailable,
  creditPaymentMethodLabel,
  formatCreditPaymentDate,
  resolveOutstandingBalance,
  useCustomerCreditPayments,
} from '../../lib/customers/creditService';
import { customerFullName, fmtBaht, fmtBahtDec } from '../../lib/customers/types';
import type { CreditAccount, Customer } from '../../lib/types';

type Props = {
  customer: Customer;
  creditAccount?: CreditAccount | null;
  isOpen: boolean;
  refreshKey?: number;
  onClose: () => void;
};

export default function CreditHistoryModal({
  customer,
  creditAccount = null,
  isOpen,
  refreshKey = 0,
  onClose,
}: Props) {
  const { payments, loading, error } = useCustomerCreditPayments(customer.id, refreshKey);

  const outstanding = resolveOutstandingBalance(customer, creditAccount);
  const creditLimit = creditAccount?.creditLimit ?? customer.creditLimit;
  const creditRemain = creditAvailable(creditLimit, outstanding);

  if (!isOpen) return null;

  return (
    <div className="cm-pay-overlay" onClick={onClose}>
      <div
        className="cm-pay-dialog cm-credit-history-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="cm-pay-header">
          ประวัติเครดิต — {customerFullName(customer)}
        </div>
        <div className="cm-pay-body">
          <div className="cm-credit-history-summary">
            <div className="cm-credit-history-stat">
              <span className="cm-credit-history-lbl">หนี้ค้างชำระ</span>
              <strong className="cm-credit-history-val debt">{fmtBaht(outstanding)}</strong>
            </div>
            {creditLimit > 0 ? (
              <>
                <div className="cm-credit-history-stat">
                  <span className="cm-credit-history-lbl">วงเงินเชื่อ</span>
                  <strong className="cm-credit-history-val">{fmtBaht(creditLimit)}</strong>
                </div>
                <div className="cm-credit-history-stat">
                  <span className="cm-credit-history-lbl">วงเงินคงเหลือ</span>
                  <strong className="cm-credit-history-val ok">{fmtBaht(creditRemain)}</strong>
                </div>
              </>
            ) : null}
          </div>

          <div className="cm-credit-history-section-title">ประวัติการชำระหนี้</div>

          {error ? (
            <div className="cm-credit-history-empty cm-credit-history-error">{error}</div>
          ) : null}

          <div className="cm-credit-history-table-wrap">
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
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={4} className="cm-credit-history-cell-empty">
                      กำลังโหลด...
                    </TableCell>
                  </TableRow>
                ) : payments.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="cm-credit-history-cell-empty">
                      ยังไม่มีประวัติการชำระหนี้
                    </TableCell>
                  </TableRow>
                ) : (
                  payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>{formatCreditPaymentDate(p.createdAt)}</TableCell>
                      <TableCell className="text-right">{fmtBahtDec(p.amount)}</TableCell>
                      <TableCell>{creditPaymentMethodLabel(p.paymentMethod)}</TableCell>
                      <TableCell>{p.notes || '—'}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
        <div className="cm-pay-footer">
          <button type="button" className="cm-modal-btn-cancel" onClick={onClose}>
            ปิด
          </button>
        </div>
      </div>
    </div>
  );
}
