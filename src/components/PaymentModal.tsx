import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBranchSettings } from '../lib/hooks/useBranchSettings';
import { formatMoney } from '../lib/pos/cartUtils';
import { creditAvailable } from '../lib/customers/creditService';
import { allocateDevReceiptNumber } from '../lib/pos/billId';
import type { PaymentSplit } from '../lib/pos/types';
import type { PaymentMethod } from '../lib/types';
import { toast } from './ui/use-toast';
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

// Amount shortcut buttons occupying keypad column 4. Interpreted as generic
// active-method amount shortcuts (not physical-cash-only), per UI-09-H.
const BANKNOTES = [1000, 500, 100, 50, 20] as const;
type NumpadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'C' | '⌫';

type KeypadCell = {
  id: string;
  label: string;
  row: number;
  col: number;
  colSpan?: number;
  kind: 'digit' | 'action' | 'banknote' | 'fill';
  ariaLabel?: string;
  disabled?: boolean;
  onClick: () => void;
};

function emptyAmounts(): Record<PaymentMethod, number> {
  return { cash: 0, qr: 0, kbank: 0, card: 0, credit: 0 };
}

/**
 * Display-only comma formatter. The raw entry buffer stays comma-free and is
 * the only thing any mutation path edits; this simply renders it with
 * thousands separators while preserving a trailing dot and trailing zeros so
 * decimals survive mid-typing. Never used to derive numeric state.
 */
function formatEntry(raw: string): string {
  if (!raw) return '';
  const dotIdx = raw.indexOf('.');
  if (dotIdx === -1) {
    return raw === '' ? '' : Number(raw).toLocaleString('en-US');
  }
  const intPart = raw.slice(0, dotIdx);
  const fracPart = raw.slice(dotIdx + 1);
  const intDisplay = intPart === '' ? '0' : Number(intPart).toLocaleString('en-US');
  return `${intDisplay}.${fracPart}`;
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
  // Raw, comma-free in-progress buffer for the *active* method's amount entry.
  const [entry, setEntry] = useState('');
  const autoPrint = true;
  const [isSuccess, setIsSuccess] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [savedOrderId, setSavedOrderId] = useState('');
  const [savedChange, setSavedChange] = useState(0);
  const [savedTendered, setSavedTendered] = useState(0);
  const [savedReceiptTime, setSavedReceiptTime] = useState<Date | null>(null);
  const [printType, setPrintType] = useState<'receipt' | 'prep' | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const autoPrintedRef = useRef(false);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const newSaleBtnRef = useRef<HTMLButtonElement | null>(null);

  const resetModal = useCallback(() => {
    setAmounts(emptyAmounts());
    setEntry('');
    setIsSuccess(false);
    setConfirming(false);
    setSavedOrderId('');
    setSavedChange(0);
    setSavedTendered(0);
    setSavedReceiptTime(null);
    setPrintType(null);
    setConfirmError(null);
    autoPrintedRef.current = false;
    const first = enabledMethods[0] ?? 'cash';
    setActiveMethod(first);
  }, [enabledMethods]);

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      if (isSuccess) {
        newSaleBtnRef.current?.focus();
      } else {
        closeBtnRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, isSuccess]);

  useEffect(() => {
    if (!open) return;
    resetModal();
  }, [open, resetModal]);

  /**
   * Single write path for any method amount. When the target is the active
   * method, the raw display buffer is kept in sync. `rawOverride` lets typing
   * paths preserve exactly what was typed (trailing dot / trailing zeros)
   * instead of a lossy String(number) round-trip.
   */
  const setMethodAmount = useCallback(
    (method: PaymentMethod, value: number, rawOverride?: string) => {
      const safe = Math.max(0, value);
      setAmounts((prev) => ({ ...prev, [method]: safe }));
      if (method === activeMethod) {
        setEntry(rawOverride !== undefined ? rawOverride : safe > 0 ? String(safe) : '');
      }
    },
    [activeMethod],
  );

  // Switch method and seed the raw buffer from that method's committed amount so
  // each method shows its own value; one method's in-progress typing never leaks
  // into another.
  const selectMethod = useCallback(
    (method: PaymentMethod) => {
      setActiveMethod(method);
      const val = amounts[method];
      setEntry(val > 0 ? String(val) : '');
    },
    [amounts],
  );

  const paidTotal = useMemo(
    () => Object.values(amounts).reduce((s, v) => s + v, 0),
    [amounts],
  );

  const creditAmt = amounts.credit;
  const remaining = Math.max(0, grandTotal - paidTotal);
  const change = Math.max(0, paidTotal - grandTotal);
  const creditRemain = creditAvailable(customerCreditLimit, customerOutstandingBalance);
  const creditOverLimit = creditAmt > 0 && customerCreditLimit > 0 && creditAmt > creditRemain;

  // Credit requires a selected customer before any amount entry is allowed.
  const entryEnabled = !(activeMethod === 'credit' && !customerId);

  const summaryStatus = useMemo(() => {
    if (remaining > 0 && creditAmt === 0) {
      return { label: 'ขาดอีก', value: remaining, tone: 'warn' as const };
    }
    if (change > 0) {
      return { label: 'เงินทอน', value: change, tone: 'ok' as const };
    }
    return { label: 'ครบพอดี', value: 0, tone: 'ok' as const };
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

  // Fill the remaining balance into the active method.
  const applyRemaining = useCallback(
    (method: PaymentMethod) => {
      if (remaining <= 0) return;
      const next = amounts[method] + remaining;
      setMethodAmount(method, next, method === activeMethod ? String(next) : undefined);
    },
    [remaining, amounts, activeMethod, setMethodAmount],
  );

  // Amount shortcut (formerly banknote) — additive against the ACTIVE method,
  // routed through the single setMethodAmount write path.
  const addShortcut = useCallback(
    (amount: number) => {
      if (!entryEnabled) return;
      const next = amounts[activeMethod] + amount;
      setMethodAmount(activeMethod, next, String(next));
    },
    [entryEnabled, amounts, activeMethod, setMethodAmount],
  );

  const handleNumpad = useCallback(
    (key: NumpadKey) => {
      if (!entryEnabled) return;

      if (key === 'C') {
        setMethodAmount(activeMethod, 0);
        return;
      }

      if (key === '⌫') {
        const trimmed = entry.slice(0, -1);
        const parsed = trimmed ? parseFloat(trimmed) : 0;
        setMethodAmount(activeMethod, Number.isFinite(parsed) ? parsed : 0, trimmed);
        return;
      }

      if (key === '.') {
        if (entry.includes('.')) return;
        const nextRaw = entry === '' || entry === '0' ? '0.' : entry + '.';
        const parsed = parseFloat(nextRaw);
        setMethodAmount(activeMethod, Number.isFinite(parsed) ? parsed : 0, nextRaw);
        return;
      }

      const nextRaw = entry === '0' ? key : entry + key;
      const parsed = parseFloat(nextRaw);
      if (!Number.isFinite(parsed)) return;
      setMethodAmount(activeMethod, parsed, nextRaw);
    },
    [entryEnabled, activeMethod, entry, setMethodAmount],
  );

  const handlePrint = useCallback((type: 'receipt' | 'prep') => {
    setPrintType(type);
    toast({
      title: `จำลองการสั่งพิมพ์${type === 'receipt' ? 'ใบเสร็จ' : 'ใบจัดของ'}`,
      description: 'โหมดทดสอบจะไม่ดึงหน้าต่าง Print จริง',
      variant: 'default',
    });
  }, []);

  const handleEntryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!entryEnabled) return;
      let raw = e.target.value.replace(/[^0-9.]/g, '');
      // Collapse to a single decimal point (keep the first).
      const firstDot = raw.indexOf('.');
      if (firstDot !== -1) {
        raw = raw.slice(0, firstDot + 1) + raw.slice(firstDot + 1).replace(/\./g, '');
      }
      const parsed = raw ? parseFloat(raw) : 0;
      setMethodAmount(activeMethod, Number.isFinite(parsed) ? parsed : 0, raw);
    },
    [entryEnabled, activeMethod, setMethodAmount],
  );

  const keypadCells: KeypadCell[] = useMemo(() => {
    const digitsAndActions: KeypadCell[] = [
      { id: '1', label: '1', row: 1, col: 1, kind: 'digit', disabled: !entryEnabled, onClick: () => handleNumpad('1') },
      { id: '2', label: '2', row: 1, col: 2, kind: 'digit', disabled: !entryEnabled, onClick: () => handleNumpad('2') },
      { id: '3', label: '3', row: 1, col: 3, kind: 'digit', disabled: !entryEnabled, onClick: () => handleNumpad('3') },
      { id: '4', label: '4', row: 2, col: 1, kind: 'digit', disabled: !entryEnabled, onClick: () => handleNumpad('4') },
      { id: '5', label: '5', row: 2, col: 2, kind: 'digit', disabled: !entryEnabled, onClick: () => handleNumpad('5') },
      { id: '6', label: '6', row: 2, col: 3, kind: 'digit', disabled: !entryEnabled, onClick: () => handleNumpad('6') },
      { id: '7', label: '7', row: 3, col: 1, kind: 'digit', disabled: !entryEnabled, onClick: () => handleNumpad('7') },
      { id: '8', label: '8', row: 3, col: 2, kind: 'digit', disabled: !entryEnabled, onClick: () => handleNumpad('8') },
      { id: '9', label: '9', row: 3, col: 3, kind: 'digit', disabled: !entryEnabled, onClick: () => handleNumpad('9') },
      { id: 'dot', label: '.', row: 4, col: 1, kind: 'digit', disabled: !entryEnabled, onClick: () => handleNumpad('.') },
      { id: '0', label: '0', row: 4, col: 2, kind: 'digit', disabled: !entryEnabled, onClick: () => handleNumpad('0') },
      {
        id: 'backspace',
        label: '⌫',
        row: 4,
        col: 3,
        kind: 'action',
        ariaLabel: 'ลบตัวเลขล่าสุด',
        disabled: !entryEnabled,
        onClick: () => handleNumpad('⌫'),
      },
      {
        id: 'fill-remaining',
        label: remaining > 0 ? `ใส่ยอดที่เหลือ (฿${formatMoney(remaining)})` : 'ใส่ยอดที่เหลือ',
        row: 5,
        col: 1,
        colSpan: 2,
        kind: 'fill',
        disabled: remaining <= 0 || !entryEnabled,
        ariaLabel: 'ใส่ยอดที่เหลือทั้งหมด',
        onClick: () => applyRemaining(activeMethod),
      },
      {
        id: 'clear',
        label: 'C',
        row: 5,
        col: 3,
        kind: 'action',
        ariaLabel: 'ล้างจำนวนเงิน',
        disabled: !entryEnabled,
        onClick: () => handleNumpad('C'),
      },
    ];
    const shortcuts: KeypadCell[] = BANKNOTES.map((bill, i) => ({
      id: `bn-${bill}`,
      label: `฿${bill.toLocaleString()}`,
      row: i + 1,
      col: 4,
      kind: 'banknote',
      ariaLabel: `เพิ่มยอด ${bill} บาท`,
      disabled: !entryEnabled,
      onClick: () => addShortcut(bill),
    }));
    return [...digitsAndActions, ...shortcuts];
  }, [handleNumpad, addShortcut, applyRemaining, remaining, entryEnabled, activeMethod]);

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
      setConfirmError(null);
    } catch (err: any) {
      console.error('Payment confirmation error:', err);
      setConfirmError('ไม่สามารถบันทึกรายการได้ กรุณาตรวจสอบการเชื่อมต่อหรือแจ้งผู้ดูแล');
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
    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
    return (
      <>
        {thermalPortal}
        <div
          className="pay-modal-bg pay-modal-bg--success"
          role="dialog"
          aria-modal="true"
          aria-label="รับรายการขายแล้ว"
        >
          <div className="pay-modal pay-modal--success">
            <div className="pay-success-view">
              <div className="pay-success-icon">
                <i className={isOffline ? "ti ti-cloud-upload" : "ti ti-circle-check"} aria-hidden="true" />
              </div>
              <h3 className="pay-success-title">
                {isOffline ? 'บันทึกรายการลงเครื่องแล้ว' : 'รับรายการขายแล้ว'}
              </h3>
              <p className="pay-success-status-text">
                {isOffline ? 'ระบบกำลังรอซิงก์' : 'รอระบบประมวลผล'}
              </p>
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
                <button
                  type="button"
                  className="pay-success-btn pay-success-btn--primary"
                  onClick={handleNewSale}
                  ref={newSaleBtnRef}
                >
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
      <div
        className="pay-modal-bg"
        role="dialog"
        aria-modal="true"
        aria-label="ชำระเงิน"
      >
        <div className="pay-modal">
          <div className="pay-modal-header" data-gesture="swipe-down-close-zone">
            <span className="pay-drag-handle" aria-hidden="true" />
            <h3>ชำระเงิน</h3>
            <button
              type="button"
              className="pay-close-btn"
              onClick={onClose}
              disabled={busy}
              aria-label="ปิด"
              ref={closeBtnRef}
            >
              <i className="ti ti-x" aria-hidden="true" />
            </button>
          </div>

          <aside className="pay-sidebar" aria-label="ช่องทางชำระเงิน">
            {enabledMethods.map((m) => {
              const paid = amounts[m] > 0;
              return (
                <button
                  key={m}
                  type="button"
                  className={`pay-side-btn${activeMethod === m ? ' on' : ''}`}
                  onClick={() => selectMethod(m)}
                  title={METHOD_META[m].label}
                  aria-pressed={activeMethod === m}
                  aria-label={METHOD_META[m].label}
                >
                  <i className={`ti ${METHOD_META[m].icon}`} aria-hidden="true" />
                  <span className="pay-side-label">{METHOD_META[m].shortLabel}</span>
                  {paid && <span className="pay-paid-dot" aria-hidden="true" />}
                </button>
              );
            })}
          </aside>

          <main className="pay-main">
            {/* 1. Compact method context — fixed height so the numpad never shifts.
                 Category subtitle upscaled to a professional text-base header. */}
            <div className="pay-method-context" aria-live="polite">
              {activeMethod === 'cash' && (
                <>
                  <span className="pay-context-title">
                    <i className="ti ti-cash" aria-hidden="true" /> รับเงินสด
                  </span>
                  <span className="pay-context-sub">กดจำนวนหรือปุ่มลัดยอด</span>
                </>
              )}
              {activeMethod === 'qr' && (
                <>
                  <span className="pay-context-title">
                    <i className="ti ti-qrcode" aria-hidden="true" /> PromptPay QR
                  </span>
                  <span className="pay-context-sub">สแกนจ่ายผ่านแอปธนาคาร</span>
                </>
              )}
              {activeMethod === 'kbank' && (
                <>
                  <span className="pay-context-title pay-context-title--kbank">
                    <i className="ti ti-building-bank" aria-hidden="true" /> KBank QR
                  </span>
                  <span className="pay-context-sub">สแกนจ่ายผ่าน K PLUS</span>
                </>
              )}
              {activeMethod === 'card' && (
                <>
                  <span className="pay-context-title pay-context-title--edc">
                    <i className="ti ti-credit-card" aria-hidden="true" /> EDC บัตร
                  </span>
                  <span className="pay-context-sub">รอรูดบัตรที่เครื่อง EDC</span>
                </>
              )}
              {activeMethod === 'credit' &&
                (customerId ? (
                  <>
                    <span className="pay-context-title">
                      <i className="ti ti-clock-dollar" aria-hidden="true" /> เงินเชื่อ · {customerName ?? customerId}
                    </span>
                    {customerCreditLimit > 0 && (
                      <span className="pay-context-sub pay-context-credit-stats">
                        <span>
                          ค้าง <strong className="debt">฿{formatMoney(customerOutstandingBalance)}</strong>
                        </span>
                        <span>
                          วงเงิน <strong className="ok">฿{formatMoney(creditRemain)}</strong>
                        </span>
                      </span>
                    )}
                    {creditOverLimit && (
                      <span className="pay-context-warn">
                        ยอดเชื่อเกินวงเงินคงเหลือ (เหลือ ฿{formatMoney(creditRemain)})
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="pay-context-title">
                      <i className="ti ti-clock-dollar" aria-hidden="true" /> เงินเชื่อ
                    </span>
                    <span className="pay-context-warn">ต้องเลือกลูกค้าก่อนบันทึกเชื่อ</span>
                  </>
                ))}
            </div>

            {/* 2. Active-method amount display (live comma formatting). */}
            <input
              className="pay-cash-currency-input"
              type="text"
              inputMode="decimal"
              value={formatEntry(entry)}
              onChange={handleEntryChange}
              disabled={!entryEnabled}
              placeholder="0"
              aria-label={`จำนวนเงิน (${METHOD_META[activeMethod].label})`}
            />

            {/* 3. Static 4×5 keypad grid — always mounted for every method. */}
            <div className="pay-keypad-grid">
              {keypadCells.map((cell) => (
                <button
                  key={cell.id}
                  type="button"
                  className={`pay-keypad-btn${cell.kind === 'action' ? ' pay-keypad-btn--action' : ''}${cell.kind === 'banknote' ? ' pay-keypad-btn--banknote' : ''}${cell.kind === 'fill' ? ' pay-keypad-btn--fill' : ''}`}
                  style={{
                    gridRow: cell.row,
                    gridColumn: cell.colSpan ? `${cell.col} / span ${cell.colSpan}` : cell.col,
                  }}
                  onClick={cell.onClick}
                  disabled={cell.disabled}
                  aria-label={cell.ariaLabel}
                >
                  {cell.label}
                </button>
              ))}
            </div>
          </main>

          <aside className="pay-summary" aria-label="สรุปยอดชำระ">
            {/* TOP: active payment breakdown lines (touch-friendly, stable heights). */}
            <div className="pay-breakdown">
              {activeSplits.length > 0 ? (
                activeSplits.map((s) => (
                  <div key={s.method} className="pay-sum-line pay-sum-line--split">
                    <span className="pay-sum-label">{s.label}</span>
                    <span className="pay-sum-amount">฿{formatMoney(s.amount)}</span>
                    <button
                      type="button"
                      className="pay-split-dismiss"
                      aria-label={`ล้างยอดชำระ ${s.label}`}
                      onClick={() => setMethodAmount(s.method, 0)}
                    >
                      <i className="ti ti-x" aria-hidden="true" />
                    </button>
                  </div>
                ))
              ) : (
                <div className="pay-breakdown-empty">ยังไม่มีการชำระ</div>
              )}
            </div>

            {/* CENTER: flexible spacer keeps the ledger anchored to the bottom. */}
            <div className="pay-summary-spacer" />

            {/* BOTTOM: ledger totals + confirm. Totals live in a frame whose box
                model (12px padding + 1px border) matches the breakdown card's
                horizontal insets for balanced receipt-style padding. Ledger
                rows use a flush-right 2-column layout (label / amount) — they
                are intentionally released from the breakdown card's 40px
                dismiss-action track, so amounts are not vertically locked to
                the breakdown card's amount column. */}
            <div className="pay-ledger">
              <div className="pay-ledger-totals">
                <div className="pay-ledger-line pay-ledger-line--gross">
                  <span className="pay-ledger-label">ยอดสุทธิ</span>
                  <strong className="pay-ledger-amount">฿{formatMoney(grandTotal)}</strong>
                </div>
                <div className="pay-ledger-line pay-ledger-line--paid">
                  <span className="pay-ledger-label">ชำระแล้ว</span>
                  <span className="pay-ledger-amount">฿{formatMoney(paidTotal)}</span>
                </div>
                <div className={`pay-ledger-line pay-ledger-line--status ${summaryStatus.tone}`}>
                  <span className="pay-ledger-label">{summaryStatus.label}</span>
                  <strong className="pay-ledger-amount">฿{formatMoney(summaryStatus.value)}</strong>
                </div>
              </div>

              {confirmError && (
                <div className="pay-confirm-error" role="alert">
                  <i className="ti ti-alert-triangle" aria-hidden="true" /> {confirmError}
                </div>
              )}

              <button
                type="button"
                className="pay-confirm"
                disabled={!canConfirm || busy}
                onClick={() => void handleConfirm()}
              >
                {busy ? 'กำลังบันทึกคำสั่งซื้อ...' : 'ยืนยันชำระเงิน'}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
