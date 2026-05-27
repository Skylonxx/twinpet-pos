import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBranchSettings } from '../lib/hooks/useBranchSettings';
import { formatMoney } from '../lib/pos/cartUtils';
import { creditAvailable } from '../lib/customers/creditService';
import { allocateDevReceiptNumber } from '../lib/pos/billId';
import type { PaymentSplit } from '../lib/pos/types';
import type { PaymentMethod } from '../lib/types';
import './PaymentModal.css';

const ALL_METHODS: PaymentMethod[] = ['cash', 'qr', 'kbank', 'card', 'credit'];

const METHOD_META: Record<
  PaymentMethod,
  { label: string; icon: string; shortLabel: string }
> = {
  cash: { label: 'เงินสด', icon: 'ti-cash', shortLabel: 'เงินสด' },
  qr: { label: 'PromptPay QR', icon: 'ti-qrcode', shortLabel: 'QR' },
  kbank: { label: 'QR KBank', icon: 'ti-building-bank', shortLabel: 'KBank' },
  card: { label: 'EDC บัตร', icon: 'ti-credit-card', shortLabel: 'EDC' },
  credit: { label: 'เงินเชื่อ', icon: 'ti-clock-dollar', shortLabel: 'เชื่อ' },
};

const QUICK_BILLS = [100, 500, 1000] as const;
const NUMPAD_KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', 'C', '0', '⌫'] as const;

function emptyAmounts(): Record<PaymentMethod, number> {
  return { cash: 0, qr: 0, kbank: 0, card: 0, credit: 0 };
}

function formatReceiptDate(d: Date): string {
  return d.toLocaleString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export type PaymentReceiptLine = {
  productName: string;
  sku: string;
  qty: number;
  unit: string;
  lineTotal: number;
};

export type PaymentModalProps = {
  open: boolean;
  branchId: string | null;
  shopName?: string;
  grandTotal: number;
  subtotal: number;
  billDiscount: number;
  fee: number;
  lines: PaymentReceiptLine[];
  customerId?: string | null;
  customerName?: string | null;
  customerCreditLimit?: number;
  customerOutstandingBalance?: number;
  processing?: boolean;
  onClose: () => void;
  onConfirm: (payments: PaymentSplit[]) => Promise<string | void>;
  onNewSale: () => void;
};

export default function PaymentModal({
  open,
  branchId,
  shopName = 'TwinPet',
  grandTotal,
  subtotal,
  billDiscount,
  fee,
  lines,
  customerId = null,
  customerName = null,
  customerCreditLimit = 0,
  customerOutstandingBalance = 0,
  processing = false,
  onConfirm,
  onClose,
  onNewSale,
}: PaymentModalProps) {
  const { paymentMethods } = useBranchSettings(branchId);

  const enabledMethods = useMemo(
    () => ALL_METHODS.filter((m) => paymentMethods[m]),
    [paymentMethods],
  );

  const [activeMethod, setActiveMethod] = useState<PaymentMethod>('cash');
  const [amounts, setAmounts] = useState(emptyAmounts);
  const [cashInput, setCashInput] = useState('');
  const [autoPrint, setAutoPrint] = useState(true);
  const [isSuccess, setIsSuccess] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [savedOrderId, setSavedOrderId] = useState('');
  const [savedChange, setSavedChange] = useState(0);
  const [savedTendered, setSavedTendered] = useState(0);
  const [savedReceiptTime, setSavedReceiptTime] = useState<Date | null>(null);
  const [printType, setPrintType] = useState<'receipt' | 'prep' | null>(null);

  const autoPrintedRef = useRef(false);

  const resetModal = useCallback(() => {
    setAmounts(emptyAmounts());
    setCashInput('');
    setIsSuccess(false);
    setConfirming(false);
    setSavedOrderId('');
    setSavedChange(0);
    setSavedTendered(0);
    setSavedReceiptTime(null);
    setPrintType(null);
    autoPrintedRef.current = false;
    const first = enabledMethods[0] ?? 'cash';
    setActiveMethod(first);
  }, [enabledMethods]);

  useEffect(() => {
    if (!open) return;
    resetModal();
  }, [open, resetModal]);

  const setMethodAmount = useCallback((method: PaymentMethod, value: number) => {
    const safe = Math.max(0, value);
    setAmounts((prev) => ({ ...prev, [method]: safe }));
    if (method === 'cash') {
      setCashInput(safe > 0 ? String(safe) : '');
    }
  }, []);

  const paidTotal = useMemo(
    () => Object.values(amounts).reduce((s, v) => s + v, 0),
    [amounts],
  );

  const creditAmt = amounts.credit;
  const remaining = Math.max(0, grandTotal - paidTotal);
  const change = Math.max(0, paidTotal - grandTotal);
  const creditRemain = creditAvailable(customerCreditLimit, customerOutstandingBalance);
  const creditOverLimit = creditAmt > 0 && customerCreditLimit > 0 && creditAmt > creditRemain;

  const summaryStatus = useMemo(() => {
    if (remaining > 0 && creditAmt === 0) {
      return { label: 'ขาดอีก', value: remaining, tone: 'warn' as const };
    }
    if (change > 0) {
      return { label: 'ทอน', value: change, tone: 'ok' as const };
    }
    return { label: 'ครบ', value: 0, tone: 'ok' as const };
  }, [remaining, creditAmt, change]);

  const canConfirm =
    (paidTotal >= grandTotal || creditAmt > 0) &&
    !(creditAmt > 0 && !customerId) &&
    !creditOverLimit;

  const activeSplits = useMemo(
    () =>
      ALL_METHODS.filter((m) => amounts[m] > 0).map((m) => ({
        method: m,
        label: METHOD_META[m].shortLabel,
        amount: amounts[m],
      })),
    [amounts],
  );

  const applyRemaining = useCallback(
    (method: PaymentMethod) => {
      if (remaining <= 0) return;
      setAmounts((prev) => {
        const nextVal = prev[method] + remaining;
        if (method === 'cash') {
          setCashInput(String(nextVal));
        }
        return { ...prev, [method]: nextVal };
      });
    },
    [remaining],
  );

  const addQuickBill = useCallback((bill: number) => {
    setAmounts((prev) => {
      const next = prev.cash + bill;
      setCashInput(String(next));
      return { ...prev, cash: next };
    });
  }, []);

  const handleNumpad = useCallback(
    (key: (typeof NUMPAD_KEYS)[number]) => {
      if (activeMethod !== 'cash') return;

      if (key === 'C') {
        setMethodAmount('cash', 0);
        return;
      }

      if (key === '⌫') {
        const trimmed = cashInput.slice(0, -1);
        const parsed = trimmed ? parseFloat(trimmed) : 0;
        setMethodAmount('cash', Number.isFinite(parsed) ? parsed : 0);
        setCashInput(trimmed);
        return;
      }

      const nextStr = cashInput === '0' ? key : cashInput + key;
      const parsed = parseFloat(nextStr);
      if (!Number.isFinite(parsed)) return;
      setCashInput(nextStr);
      setMethodAmount('cash', parsed);
    },
    [activeMethod, cashInput, setMethodAmount],
  );

  const handlePrint = useCallback((type: 'receipt' | 'prep') => {
    setPrintType(type);
    window.alert(
      `จำลองการสั่งพิมพ์ ${type === 'receipt' ? 'ใบเสร็จ' : 'ใบจัดของ'} (โหมดทดสอบจะไม่ดึงหน้าต่าง Print จริง)`,
    );
  }, []);

  const handleConfirm = async () => {
    if (!canConfirm || confirming || processing) return;

    const payments = ALL_METHODS.filter((m) => amounts[m] > 0).map((m) => ({
      method: m,
      amount: amounts[m],
    }));

    const snapshotChange = change;
    const snapshotTendered = paidTotal;

    setConfirming(true);
    try {
      const orderId = await onConfirm(payments);
      setSavedOrderId(typeof orderId === 'string' ? orderId : allocateDevReceiptNumber());
      setSavedChange(snapshotChange);
      setSavedTendered(snapshotTendered);
      setSavedReceiptTime(new Date());
      setIsSuccess(true);
    } catch {
      // Parent shows error toast
    } finally {
      setConfirming(false);
    }
  };

  const handleNewSale = () => {
    onNewSale();
  };

  const busy = confirming || processing;

  useEffect(() => {
    if (!isSuccess || !autoPrint || autoPrintedRef.current) return;
    autoPrintedRef.current = true;
    handlePrint('receipt');
  }, [isSuccess, autoPrint, handlePrint]);

  if (!open) return null;

  const thermalPortal = createPortal(
    <div
      id="thermal-print-area"
      data-print={printType ?? undefined}
      aria-hidden="true"
    >
      <div className="thermal-receipt-ticket">
        <div className="thermal-center thermal-bold thermal-lg">{shopName}</div>
        <div className="thermal-center thermal-sm">ใบเสร็จรับเงิน / Receipt</div>
        <div className="thermal-dash" />
        <div className="thermal-row">
          <span>เลขที่</span>
          <span>{savedOrderId || '—'}</span>
        </div>
        <div className="thermal-row">
          <span>วันที่</span>
          <span>{formatReceiptDate(savedReceiptTime ?? new Date())}</span>
        </div>
        {customerName ? (
          <div className="thermal-row">
            <span>ลูกค้า</span>
            <span>{customerName}</span>
          </div>
        ) : null}
        <div className="thermal-dash" />
        {lines.map((line, i) => (
          <div key={`${line.sku}-${i}`} className="thermal-item">
            <div className="thermal-item-name">{line.productName}</div>
            <div className="thermal-item-row">
              <span>
                {line.qty} {line.unit} x ฿{formatMoney(line.lineTotal / line.qty)}
              </span>
              <span>฿{formatMoney(line.lineTotal)}</span>
            </div>
          </div>
        ))}
        <div className="thermal-dash" />
        <div className="thermal-row">
          <span>รวม</span>
          <span>฿{formatMoney(subtotal)}</span>
        </div>
        <div className="thermal-row">
          <span>ส่วนลด</span>
          <span>-฿{formatMoney(billDiscount)}</span>
        </div>
        {fee > 0 ? (
          <div className="thermal-row">
            <span>ค่าธรรมเนียม</span>
            <span>฿{formatMoney(fee)}</span>
          </div>
        ) : null}
        <div className="thermal-row thermal-bold">
          <span>ยอดสุทธิ</span>
          <span>฿{formatMoney(grandTotal)}</span>
        </div>
        <div className="thermal-row">
          <span>รับเงิน</span>
          <span>฿{formatMoney(savedTendered)}</span>
        </div>
        <div className="thermal-row thermal-bold">
          <span>เงินทอน</span>
          <span>฿{formatMoney(savedChange)}</span>
        </div>
        <div className="thermal-dash" />
        <div className="thermal-center thermal-sm">ขอบคุณที่ใช้บริการ</div>
      </div>

      <div className="thermal-prep-ticket">
        <div className="thermal-center thermal-bold thermal-lg">ใบจัดของ</div>
        <div className="thermal-center thermal-sm">Prep Ticket</div>
        <div className="thermal-dash" />
        <div className="thermal-row">
          <span>เลขที่</span>
          <span>{savedOrderId || '—'}</span>
        </div>
        <div className="thermal-row">
          <span>วันที่</span>
          <span>{formatReceiptDate(savedReceiptTime ?? new Date())}</span>
        </div>
        <div className="thermal-dash" />
        {lines.map((line, i) => (
          <div key={`prep-${line.sku}-${i}`} className="thermal-prep-item">
            <span className="thermal-prep-check">[ ]</span>
            <span className="thermal-prep-body">
              <span className="thermal-prep-sku">{line.sku}</span>
              <span className="thermal-prep-name">{line.productName}</span>
              <span className="thermal-prep-qty">
                x{line.qty} {line.unit}
              </span>
            </span>
          </div>
        ))}
        <div className="thermal-dash" />
        <div className="thermal-center thermal-sm">ตรวจสอบก่อนส่งมอบ</div>
      </div>
    </div>,
    document.body,
  );

  if (isSuccess) {
    return (
      <>
        {thermalPortal}
        <div className="pay-modal-bg pay-modal-bg--success" role="dialog" aria-modal="true" aria-label="ชำระเงินสำเร็จ">
          <div className="pay-modal pay-modal--success">
            <div className="pay-success-view">
              <div className="pay-success-icon">
                <i className="ti ti-circle-check" aria-hidden="true" />
              </div>
              <h3 className="pay-success-title">บันทึกการขายสำเร็จ</h3>
              <p className="pay-success-order">เลขที่: {savedOrderId}</p>
              <div className="pay-success-change">
                เงินทอน: <strong>฿{formatMoney(savedChange)}</strong>
              </div>
              <div className="pay-success-actions">
                <button type="button" className="pay-success-btn" onClick={() => handlePrint('receipt')}>
                  🖨️ พิมพ์ใบเสร็จ
                </button>
                <button type="button" className="pay-success-btn" onClick={() => handlePrint('prep')}>
                  📦 พิมพ์ใบจัดของ
                </button>
                <button type="button" className="pay-success-btn pay-success-btn--primary" onClick={handleNewSale}>
                  ✅ ตกลง (บิลใหม่)
                </button>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {thermalPortal}
      <div className="pay-modal-bg" role="dialog" aria-modal="true" aria-label="ชำระเงิน">
        <div className="pay-modal">
          <aside className="pay-sidebar" aria-label="ช่องทางชำระเงิน">
            {enabledMethods.map((m) => {
              const paid = amounts[m] > 0;
              return (
                <button
                  key={m}
                  type="button"
                  className={`pay-side-btn${activeMethod === m ? ' on' : ''}`}
                  onClick={() => setActiveMethod(m)}
                  title={METHOD_META[m].label}
                >
                  <i className={`ti ${METHOD_META[m].icon}`} aria-hidden="true" />
                  {paid && <span className="pay-paid-dot" aria-hidden="true" />}
                </button>
              );
            })}
          </aside>

          <main className="pay-main">
            <div className="pay-main-head">
              <h3>ชำระเงิน</h3>
              <button
                type="button"
                className="pay-close-btn"
                onClick={onClose}
                disabled={busy}
                aria-label="ปิด"
              >
                <i className="ti ti-x" aria-hidden="true" />
              </button>
            </div>

            <label className="pay-auto-print">
              <input
                type="checkbox"
                checked={autoPrint}
                onChange={(e) => setAutoPrint(e.target.checked)}
              />
              <span>พิมพ์ใบเสร็จอัตโนมัติ</span>
            </label>

            <p className="pay-method-title">{METHOD_META[activeMethod].label}</p>

            {activeMethod === 'cash' && (
              <>
                <div className="pay-quick-bills">
                  {QUICK_BILLS.map((b) => (
                    <button key={b} type="button" onClick={() => addQuickBill(b)}>
                      +{b}
                    </button>
                  ))}
                </div>
                <div className="pay-amount-display" aria-live="polite">
                  ฿{formatMoney(amounts.cash)}
                </div>
                <div className="pay-numpad">
                  {NUMPAD_KEYS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={key === 'C' || key === '⌫' ? 'pay-numpad-action' : undefined}
                      onClick={() => handleNumpad(key)}
                    >
                      {key}
                    </button>
                  ))}
                </div>
                {remaining > 0 && (
                  <button
                    type="button"
                    className="pay-fill-btn"
                    onClick={() => applyRemaining('cash')}
                  >
                    ใส่ยอดที่เหลือ (฿{formatMoney(remaining)})
                  </button>
                )}
              </>
            )}

            {activeMethod === 'qr' && (
              <div className="pay-qr-panel">
                <div className="pay-qr-box">
                  <i className="ti ti-qrcode" aria-hidden="true" />
                  <span>PromptPay QR</span>
                  <span style={{ fontSize: 10 }}>placeholder</span>
                </div>
                <input
                  className="pay-amount-input"
                  type="number"
                  min={0}
                  step="any"
                  value={amounts.qr || ''}
                  onChange={(e) => setMethodAmount('qr', parseFloat(e.target.value) || 0)}
                  placeholder="จำนวนเงิน"
                />
                <button
                  type="button"
                  className="pay-fill-btn"
                  disabled={remaining <= 0}
                  onClick={() => applyRemaining('qr')}
                >
                  ใส่ยอดที่เหลือ (฿{formatMoney(remaining)})
                </button>
              </div>
            )}

            {activeMethod === 'kbank' && (
              <div className="pay-qr-panel">
                <div className="pay-qr-box kbank">
                  <i className="ti ti-building-bank" aria-hidden="true" />
                  <span>KBank QR</span>
                  <span style={{ fontSize: 10 }}>placeholder</span>
                </div>
                <input
                  className="pay-amount-input"
                  type="number"
                  min={0}
                  step="any"
                  value={amounts.kbank || ''}
                  onChange={(e) => setMethodAmount('kbank', parseFloat(e.target.value) || 0)}
                  placeholder="จำนวนเงิน"
                />
                <button
                  type="button"
                  className="pay-fill-btn"
                  disabled={remaining <= 0}
                  onClick={() => applyRemaining('kbank')}
                >
                  ใส่ยอดที่เหลือ (฿{formatMoney(remaining)})
                </button>
              </div>
            )}

            {activeMethod === 'card' && (
              <div className="pay-edc-panel">
                <div className="pay-edc-status">
                  <i className="ti ti-credit-card" aria-hidden="true" />
                  รอรูดบัตรที่เครื่อง EDC
                </div>
                <input
                  className="pay-amount-input"
                  type="number"
                  min={0}
                  step="any"
                  value={amounts.card || ''}
                  onChange={(e) => setMethodAmount('card', parseFloat(e.target.value) || 0)}
                  placeholder="จำนวนเงิน"
                />
                <button
                  type="button"
                  className="pay-fill-btn"
                  disabled={remaining <= 0}
                  onClick={() => applyRemaining('card')}
                >
                  ใส่ยอดที่เหลือ (฿{formatMoney(remaining)})
                </button>
              </div>
            )}

            {activeMethod === 'credit' && (
              <div className="pay-credit-panel">
                {customerId ? (
                  <>
                    <div className="pay-credit-note">
                      ลูกค้า: <strong>{customerName ?? customerId}</strong>
                      <br />
                      ชำระบางส่วนด้วยช่องทางอื่น แล้วบันทึกยอดค้างเป็นเชื่อได้
                    </div>
                    {customerCreditLimit > 0 ? (
                      <div className="pay-credit-stats">
                        <div className="pay-credit-stat">
                          <span className="pay-credit-stat-lbl">หนี้ค้างชำระ</span>
                          <strong className="pay-credit-stat-val debt">
                            ฿{formatMoney(customerOutstandingBalance)}
                          </strong>
                        </div>
                        <div className="pay-credit-stat">
                          <span className="pay-credit-stat-lbl">วงเงินคงเหลือ</span>
                          <strong className="pay-credit-stat-val ok">
                            ฿{formatMoney(creditRemain)}
                          </strong>
                        </div>
                      </div>
                    ) : null}
                    {creditOverLimit ? (
                      <div className="pay-credit-note warn">
                        ยอดเชื่อเกินวงเงินคงเหลือ (เหลือ ฿{formatMoney(creditRemain)})
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="pay-credit-note warn">
                    ต้องเลือกลูกค้าก่อนบันทึกเชื่อ
                  </div>
                )}
                <input
                  className="pay-amount-input"
                  type="number"
                  min={0}
                  step="any"
                  value={amounts.credit || ''}
                  disabled={!customerId}
                  onChange={(e) => setMethodAmount('credit', parseFloat(e.target.value) || 0)}
                  placeholder="ยอดเชื่อ"
                />
                <button
                  type="button"
                  className="pay-fill-btn"
                  disabled={!customerId || remaining <= 0}
                  onClick={() => applyRemaining('credit')}
                >
                  บันทึกยอดค้างชำระ (฿{formatMoney(remaining)})
                </button>
              </div>
            )}
          </main>

          <aside className="pay-summary" aria-label="สรุปยอดชำระ">
            <div className="pay-sum-row">
              <span>ยอดสุทธิ</span>
              <strong>฿{formatMoney(grandTotal)}</strong>
            </div>
            <div className="pay-sum-row">
              <span>ชำระแล้ว</span>
              <span>฿{formatMoney(paidTotal)}</span>
            </div>

            {activeSplits.length > 0 && (
              <>
                <div className="pay-sum-divider" />
                <div className="pay-split-list">
                  {activeSplits.map((s) => (
                    <div key={s.method} className="pay-split-item">
                      <span>{s.label}</span>
                      <span>฿{formatMoney(s.amount)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="pay-sum-divider" />

            <div className={`pay-sum-row ${summaryStatus.tone}`}>
              <span>{summaryStatus.label}</span>
              <strong>฿{formatMoney(summaryStatus.value)}</strong>
            </div>

            <button
              type="button"
              className="pay-confirm"
              disabled={!canConfirm || busy}
              onClick={() => void handleConfirm()}
            >
              {busy ? 'กำลังบันทึก...' : 'ยืนยันชำระเงิน'}
            </button>
          </aside>
        </div>
      </div>
    </>
  );
}
