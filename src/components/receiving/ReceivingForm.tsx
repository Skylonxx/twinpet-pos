import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import ProductPickerDialog, { productListItemToPickerItem } from '../products/ProductPickerDialog';
import SupplierPickerDialog from './SupplierPickerDialog';
import PosSupplierModal from './PosSupplierModal';
import { useActiveSuppliers } from '../../lib/pos/useSuppliers';
import { useProductCrud } from '../../lib/productCrud/useProductCrud';
import type { ProductListItem } from '../../lib/productCrud/types';
import type { Supplier } from '../../lib/types';
import {
  buildSubmitPayload,
  emptyReceivingFormValues,
  updateReceivingLine,
  type ReceivingFormSubmitPayload,
  type ReceivingFormValues,
} from '../../lib/receiving/receivingFormUtils';
import {
  CATEGORY_TYPE_TAG,
  clampMoney,
  computeNewAvgCost,
  emptyLineFromProductListItem,
  fmtMoney,
  lineCostBase,
  lineQtyBase,
  lineSubtotal,
  maxItemDiscount,
  receivingSubtotal,
  uomOptionsForProduct,
  type ReceivingLine,
} from '../../lib/receiving/types';
import type { ReceivingStatus } from '../../lib/types';
import { SingleDatePicker } from '../common/SingleDatePicker';
import './ReceivingForm.css';
import ReceivingVoidDialog from './ReceivingVoidDialog';
import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../ui';

export type ReceivingFormProps = {
  mode: 'create' | 'edit';
  branchId: string;
  branchLabel: string;
  grnId?: string;
  initialValues?: ReceivingFormValues;
  variant?: 'page' | 'drawer';
  /** For supplier detail modal actor id */
  staffId?: string;
  onSubmit: (payload: ReceivingFormSubmitPayload) => Promise<void>;
  onSaveDraft?: (payload: ReceivingFormSubmitPayload) => Promise<void>;
  /** When controlled by parent (e.g. create page keeps overlay through navigation). */
  draftSaving?: boolean;
  onCancel?: () => void;
  onVoid?: (reason: string, note: string) => Promise<void>;
  documentStatus?: ReceivingStatus;
  isCancelled?: boolean;
};

function valuesOrEmpty(initial?: ReceivingFormValues): ReceivingFormValues {
  return initial ? { ...initial, lines: [...initial.lines] } : emptyReceivingFormValues();
}

export default function ReceivingForm({
  mode,
  branchId,
  branchLabel: _branchLabel,
  grnId,
  initialValues,
  variant = 'page',
  onSubmit,
  onSaveDraft,
  onCancel,
  onVoid,
  staffId: _staffId,
  documentStatus,
  isCancelled = false,
  draftSaving: draftSavingProp,
}: ReceivingFormProps) {
  const { products, loading } = useProductCrud(branchId);
  const catalogSuppliers = useActiveSuppliers(branchId);

  const formKey = grnId ?? 'create';
  const [lines, setLines] = useState<ReceivingLine[]>(() => valuesOrEmpty(initialValues).lines);
  const [discType, setDiscType] = useState<'pct' | 'thb'>(() => valuesOrEmpty(initialValues).discType);
  const [discValue, setDiscValue] = useState(() => valuesOrEmpty(initialValues).discValue);
  const [vatOn, setVatOn] = useState(() => valuesOrEmpty(initialValues).vatOn);
  const [vatInc, setVatInc] = useState(() => valuesOrEmpty(initialValues).vatInc);
  const [billDate, setBillDate] = useState(() => valuesOrEmpty(initialValues).billDate);
  const [receiveDate, setReceiveDate] = useState(() => valuesOrEmpty(initialValues).receiveDate);
  const [purchaseBillNo, setPurchaseBillNo] = useState(() => valuesOrEmpty(initialValues).purchaseBillNo);
  const [supplierId, setSupplierId] = useState<string | null>(() => valuesOrEmpty(initialValues).supplierId);
  const [supplierName, setSupplierName] = useState(() => valuesOrEmpty(initialValues).supplierName);
  const [note, setNote] = useState(() => valuesOrEmpty(initialValues).note);
  const [scanValue, setScanValue] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [posSupplierModalOpen, setPosSupplierModalOpen] = useState(false);
  const [supplierAddPrefill, setSupplierAddPrefill] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [draftSavingLocal, setDraftSavingLocal] = useState(false);
  const draftSaving = draftSavingProp ?? draftSavingLocal;
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [draftToast, setDraftToast] = useState<string | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidProcessing, setVoidProcessing] = useState(false);

  useEffect(() => {
    if (!initialValues) return;
    const v = valuesOrEmpty(initialValues);
    setLines(v.lines);
    setDiscType(v.discType);
    setDiscValue(v.discValue);
    setVatOn(v.vatOn);
    setVatInc(v.vatInc);
    setBillDate(v.billDate);
    setReceiveDate(v.receiveDate);
    setPurchaseBillNo(v.purchaseBillNo);
    setSupplierId(v.supplierId);
    setSupplierName(v.supplierName);
    setNote(v.note);
    setError(null);
  }, [formKey, initialValues]);

  const bcBuf = useRef('');
  const bcTimer = useRef<number | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  /**
   * Resolved catalog entry for the currently stored supplierId.
   * null when supplierId is absent, empty, or refers to a legacy Customer ID.
   */
  const catalogMatch = useMemo(
    () => (supplierId ? (catalogSuppliers.find((s) => s.id === supplierId) ?? null) : null),
    [catalogSuppliers, supplierId],
  );

  /**
   * True when the supplier info came from free-text entry (no catalog link)
   * or when supplierId is a legacy Customer ID not present in the new catalog.
   */
  const showManualInput = !catalogMatch && (!!supplierName || (!!supplierId && !catalogMatch));

  const handleSelectSupplier = useCallback((s: Supplier) => {
    setSupplierId(s.id);
    setSupplierName(s.name);
    setError(null);
  }, []);

  const handleManualEntry = useCallback(() => {
    setSupplierId(null);
    setSupplierPickerOpen(false);
  }, []);

  const handleAddNew = useCallback((prefillName: string) => {
    setSupplierAddPrefill(prefillName);
    setPosSupplierModalOpen(true);
  }, []);

  const activeProducts = useMemo(
    () => products.filter((p) => p.isActive && !p.deletedAt),
    [products],
  );

  const pickerProducts = useMemo(
    () => activeProducts.map(productListItemToPickerItem),
    [activeProducts],
  );

  const productMap = useMemo(() => {
    const m = new Map<string, ProductListItem>();
    for (const p of activeProducts) m.set(p.id, p);
    return m;
  }, [activeProducts]);

  const addProduct = useCallback((product: ProductListItem) => {
    const line = emptyLineFromProductListItem(product);
    setLines((prev) => [...prev, line]);
    setFlashKey(line.lineKey);
    window.setTimeout(() => setFlashKey(null), 700);
  }, []);

  const findByBarcode = useCallback(
    (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) return null;
      return (
        activeProducts.find((p) => p.barcode === trimmed) ??
        activeProducts.find((p) => p.sku.toLowerCase() === trimmed.toLowerCase()) ??
        activeProducts.find((p) => p.name.toLowerCase().includes(trimmed.toLowerCase())) ??
        null
      );
    },
    [activeProducts],
  );

  const handleScanSubmit = () => {
    const p = findByBarcode(scanValue);
    if (p) {
      addProduct(p);
      setScanValue('');
      setError(null);
    } else if (scanValue.trim()) {
      setError(`ไม่พบสินค้าจากบาร์โค้ด/SKU: ${scanValue.trim()}`);
    }
    scanRef.current?.focus();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (pickerOpen || submitting) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
        return;
      }
      if (e.key === 'Enter' && bcBuf.current.length > 4) {
        const bc = bcBuf.current.trim();
        bcBuf.current = '';
        const p = findByBarcode(bc);
        if (p) {
          addProduct(p);
          setError(null);
        } else {
          setError(`ไม่พบสินค้าจากบาร์โค้ด: ${bc}`);
        }
        return;
      }
      if (e.key.length === 1) {
        bcBuf.current += e.key;
        if (bcTimer.current) window.clearTimeout(bcTimer.current);
        bcTimer.current = window.setTimeout(() => {
          bcBuf.current = '';
        }, 500);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickerOpen, submitting, findByBarcode, addProduct]);

  useEffect(() => {
    if (!successMsg) return;
    const t = window.setTimeout(() => setSuccessMsg(null), 5000);
    return () => window.clearTimeout(t);
  }, [successMsg]);

  useEffect(() => {
    if (!draftToast) return;
    const t = window.setTimeout(() => setDraftToast(null), 3000);
    return () => window.clearTimeout(t);
  }, [draftToast]);

  useEffect(() => {
    if (!vatOn) setVatInc(false);
  }, [vatOn]);

  const linesSubtotal = receivingSubtotal(lines);
  const finalDiscount = useMemo(() => {
    if (discType === 'pct') {
      return clampMoney(linesSubtotal * (discValue / 100));
    }
    return clampMoney(Math.min(discValue, linesSubtotal));
  }, [linesSubtotal, discType, discValue]);

  useEffect(() => {
    if (discType === 'thb') {
      setDiscValue((d) => Math.min(d, linesSubtotal));
    }
  }, [linesSubtotal, discType]);

  const afterDiscount = clampMoney(linesSubtotal - finalDiscount);
  const vatAmt = useMemo(() => {
    if (!vatOn) return 0;
    if (vatInc) return afterDiscount - afterDiscount / 1.07;
    return afterDiscount * 0.07;
  }, [vatOn, vatInc, afterDiscount]);
  const displayGrandTotal = useMemo(() => {
    if (!vatOn) return afterDiscount;
    if (vatInc) return afterDiscount;
    return afterDiscount + vatAmt;
  }, [vatOn, vatInc, afterDiscount, vatAmt]);

  const categoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const line of lines) {
      const cat = productMap.get(line.productId)?.category ?? 'อื่นๆ';
      m.set(cat, (m.get(cat) ?? 0) + 1);
    }
    return m;
  }, [lines, productMap]);

  const handleUnitChange = (lineKey: string, unit: string) => {
    const line = lines.find((l) => l.lineKey === lineKey);
    if (!line) return;
    const product = productMap.get(line.productId);
    if (!product) return;
    const uom = uomOptionsForProduct(product).find((o) => o.unit === unit);
    if (!uom) return;
    const costBase = line.costPerUnit / (line.unitFactor || 1);
    setLines((prev) =>
      updateReceivingLine(prev, lineKey, {
        unit: uom.unit,
        unitFactor: uom.factor,
        costPerUnit: costBase * uom.factor,
      }),
    );
  };

  const resetBill = () => {
    if (mode === 'edit' && onCancel) {
      onCancel();
      return;
    }
    const empty = emptyReceivingFormValues();
    setLines(empty.lines);
    setDiscValue(empty.discValue);
    setDiscType(empty.discType);
    setVatOn(empty.vatOn);
    setVatInc(empty.vatInc);
    setSupplierId(empty.supplierId);
    setSupplierName(empty.supplierName);
    setPurchaseBillNo(empty.purchaseBillNo);
    setBillDate(empty.billDate);
    setReceiveDate(empty.receiveDate);
    setNote(empty.note);
    setError(null);
  };

  const handleSaveDraft = async (e?: MouseEvent<HTMLButtonElement>) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!onSaveDraft) {
      setDraftToast('บันทึกแบบร่างแล้ว');
      return;
    }
    if (draftSaving || submitting) return;
    if (draftSavingProp == null) setDraftSavingLocal(true);
    setError(null);
    try {
      const payload = buildSubmitPayload({
        lines,
        supplierId,
        supplierName,
        billDate,
        receiveDate,
        purchaseBillNo,
        note,
        discType,
        discValue,
        vatOn,
        vatInc,
      });
      await onSaveDraft(payload);
    } catch (err) {
      if (draftSavingProp == null) setDraftSavingLocal(false);
      setError(err instanceof Error ? err.message : 'บันทึกแบบร่างไม่สำเร็จ');
    }
  };

  const handleVoidConfirm = async (reason: string, note: string) => {
    if (!onVoid) return;
    setVoidProcessing(true);
    setError(null);
    try {
      await onVoid(reason, note);
      setVoidOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ยกเลิกบิลไม่สำเร็จ');
    } finally {
      setVoidProcessing(false);
    }
  };

  const handleConfirm = async () => {
    if (lines.length === 0) {
      setError('กรุณาเพิ่มรายการสินค้าก่อนยืนยัน');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = buildSubmitPayload({
        lines,
        supplierId,
        supplierName,
        billDate,
        receiveDate,
        purchaseBillNo,
        note,
        discType,
        discValue,
        vatOn,
        vatInc,
      });
      await onSubmit(payload);
      if (mode === 'create') {
        setSuccessMsg('บันทึกใบรับเข้าสำเร็จ');
        resetBill();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ');
    } finally {
      setSubmitting(false);
    }
  };

  const rootClass = `rcv-form-root${variant === 'drawer' ? ' rcv-form-root--drawer' : ''}${draftSaving ? ' rcv-form-root--saving' : ''}`;
  const showTopbar = variant === 'page';
  const showPageSummary = variant === 'page';
  const idPrefix = variant === 'drawer' ? 'rcv-drawer' : 'rcv';
  const isDraftFlow = mode === 'create' || documentStatus === 'draft';
  const isCompletedEdit = mode === 'edit' && documentStatus === 'completed';

  const summaryPanel = (
    <div className={`rcv-summary-panel${showPageSummary ? ' rcv-summary-panel--page' : ''}`}>
      <div className="rcv-summary-main">
        <div className="rcv-fsec rcv-fsec--vat">
          <span className="rcv-fs-lbl">ภาษีมูลค่าเพิ่ม</span>
          <div className="rcv-tog-row">
            <label className="rcv-tog">
              <input type="checkbox" checked={vatOn} onChange={(e) => setVatOn(e.target.checked)} disabled={isCancelled} />
              <div className="rcv-tog-track" />
              <div className="rcv-tog-thumb" />
            </label>
            <span className={`rcv-tog-lbl${vatOn ? ' active' : ' inactive'}`}>มี VAT 7%</span>
          </div>
          <div className="rcv-tog-row">
            <label className="rcv-tog">
              <input
                type="checkbox"
                checked={vatInc}
                disabled={!vatOn || isCancelled}
                onChange={(e) => setVatInc(e.target.checked)}
              />
              <div className="rcv-tog-track" />
              <div className="rcv-tog-thumb" />
            </label>
            <span className={`rcv-tog-lbl${!vatOn ? ' locked' : vatInc ? ' active' : ' inactive'}`}>
              ราคารวมภาษีแล้ว
            </span>
          </div>
          <span className="rcv-vat-amt">{vatOn && vatAmt > 0 ? `VAT = ฿${fmtMoney(vatAmt)}` : ''}</span>
        </div>
        <div className="rcv-summary-block">
          <div className="summary-line">
            <span className="summary-line-label">จำนวนรายการ</span>
            <span className="summary-line-val summary-item-count">
              {lines.length}
              {Array.from(categoryCounts.entries()).map(([cat, count]) => (
                <span key={cat} className={`type-tag ${CATEGORY_TYPE_TAG[cat] ?? 'type-other'}`}>
                  {count} {cat}
                </span>
              ))}
            </span>
          </div>
        </div>
        <div className="rcv-totals-sec">
          <div className="rcv-ti">
            <span className="rcv-tl">รวมมูลค่าสินค้า</span>
            <span className="rcv-tv">฿{fmtMoney(linesSubtotal)}</span>
          </div>
          <div className="rcv-ti rcv-ti-discount">
            <span className="rcv-tl">ส่วนลด</span>
            <div className="rcv-disc-wrap rcv-disc-wrap--inline">
              <input
                className="rcv-disc-inp"
                type="number"
                min={0}
                placeholder="0"
                value={discValue || ''}
                onChange={(e) => setDiscValue(Math.max(0, Number(e.target.value) || 0))}
                disabled={isCancelled}
              />
              <button
                type="button"
                className={`rcv-disc-tog${discType === 'pct' ? ' on' : ''}`}
                onClick={() => setDiscType((t) => (t === 'pct' ? 'thb' : 'pct'))}
                disabled={isCancelled}
              >
                {discType === 'pct' ? '%' : '฿'}
              </button>
            </div>
            <span className="rcv-tv g">-฿{fmtMoney(finalDiscount)}</span>
          </div>
          <div className="rcv-ti">
            <span className="rcv-tl">{vatInc && vatOn ? 'VAT (รวมแล้ว)' : 'ภาษีมูลค่าเพิ่ม 7%'}</span>
            <span className={`rcv-tv a${vatOn ? '' : ' dim'}`}>฿{fmtMoney(vatAmt)}</span>
          </div>
          <div className="rcv-ti rcv-ti-grand">
            <span className="rcv-tl">ยอดรับเข้า</span>
            <span className="rcv-tv">฿{fmtMoney(displayGrandTotal)}</span>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className={rootClass}>
      {draftSaving && draftSavingProp == null ? (
        <div className="rcv-form-saving-overlay" aria-live="polite" aria-busy="true">
          <div className="rcv-form-saving-inner">
            <i className="ti ti-loader rcv-spin" aria-hidden="true" />
            <span>กำลังบันทึกแบบร่าง...</span>
          </div>
        </div>
      ) : null}
      {showTopbar ? (
        <header className="rcv-topbar">
          {mode === 'edit' || onCancel ? (
            <button
              type="button"
              className="rcv-back-btn rcv-back-btn--action"
              onClick={onCancel}
              aria-label="กลับ"
            >
              <i className="ti ti-arrow-left" />
            </button>
          ) : (
            <div className="rcv-back-btn" aria-hidden="true">
              <i className="ti ti-arrow-left" />
            </div>
          )}
          <span className="rcv-topbar-title">
            {mode === 'edit' && documentStatus === 'draft'
              ? 'ดำเนินการแบบร่างรับเข้า'
              : mode === 'edit'
                ? 'แก้ไขเอกสารรับสินค้าเข้า'
                : 'สร้างเอกสารรับสินค้าเข้า'}
          </span>
          <span className="rcv-ref-badge">
            {mode === 'edit' && grnId ? grnId : 'GRN — ร่าง'}
          </span>
          <div className="rcv-topbar-actions">
            {!isCancelled && isDraftFlow ? (
              <button
                type="button"
                className="rcv-top-btn-secondary"
                disabled={draftSaving || submitting || voidProcessing}
                onClick={(e) => void handleSaveDraft(e)}
              >
                {draftSaving ? 'กำลังบันทึก...' : 'บันทึกแบบร่าง'}
              </button>
            ) : null}
            {!isCancelled && isCompletedEdit && onVoid ? (
              <button
                type="button"
                className="rcv-top-btn-danger"
                disabled={submitting || voidProcessing || draftSaving}
                onClick={() => setVoidOpen(true)}
              >
                ยกเลิกบิล
              </button>
            ) : null}
            {!isCancelled ? (
              <button
                type="button"
                className="rcv-save-top-btn"
                disabled={submitting || (isDraftFlow && lines.length === 0) || voidProcessing || draftSaving}
                onClick={() => void handleConfirm()}
              >
                <i className="ti ti-check" aria-hidden="true" />
                {submitting
                  ? 'กำลังบันทึก...'
                  : isDraftFlow
                    ? 'ยืนยันรับเข้า'
                    : 'บันทึกการแก้ไข'}
              </button>
            ) : null}
          </div>
        </header>
      ) : null}

      {mode === 'edit' && grnId && variant === 'drawer' ? (
        <div className="rcv-error-banner" style={{ background: '#eeedfe', borderColor: '#cecbf6', color: '#534ab7' }}>
          แก้ไขเอกสาร {grnId}
        </div>
      ) : null}

      {isCancelled ? (
        <div className="rcv-error-banner" style={{ background: '#fcebeb', borderColor: '#f7c1c1', color: '#a32d2d' }}>
          เอกสารนี้ถูกยกเลิกแล้ว — ดูได้ในประวัติเท่านั้น
        </div>
      ) : null}

      {error ? <div className="rcv-error-banner">{error}</div> : null}

      <div className="rcv-scroll-content">
        <div className="rcv-card">
          <div className="rcv-card-head">ข้อมูลเบื้องต้น</div>
          <div className="rcv-form-grid rcv-form-grid-dates">
            <div className="rcv-field">
              <label htmlFor={`${idPrefix}-bill-date`}>วันที่ซื้อในบิล</label>
              <SingleDatePicker
                id={`${idPrefix}-bill-date`}
                value={billDate}
                onChange={setBillDate}
                disabled={isCancelled}
              />
            </div>
            <div className="rcv-field">
              <label htmlFor={`${idPrefix}-receive-date`}>วันที่รับเข้า</label>
              <SingleDatePicker
                id={`${idPrefix}-receive-date`}
                value={receiveDate}
                onChange={setReceiveDate}
                disabled={isCancelled}
              />
            </div>
            <div className="rcv-field">
              <label htmlFor={`${idPrefix}-purchase-no`}>เลขที่ในบิลซื้อ</label>
              <input
                id={`${idPrefix}-purchase-no`}
                placeholder="เลขที่บิลจาก supplier..."
                value={purchaseBillNo}
                onChange={(e) => setPurchaseBillNo(e.target.value)}
                disabled={isCancelled}
              />
            </div>
            <div className="rcv-field rcv-form-full">
              <label>ผู้จำหน่าย</label>
              <div className="rcv-supplier-trigger-row">
                <button
                  type="button"
                  className={`rcv-supplier-trigger${catalogMatch ? ' rcv-supplier-trigger--linked' : showManualInput ? ' rcv-supplier-trigger--manual' : ''}`}
                  onClick={() => !isCancelled && setSupplierPickerOpen(true)}
                  disabled={isCancelled}
                  aria-label="เลือกผู้จำหน่าย"
                >
                  {catalogMatch ? (
                    <>
                      <span className="rcv-supplier-avatar rcv-supplier-avatar--trigger">
                        {(catalogMatch.name[0] ?? 'S').toUpperCase()}
                      </span>
                      <span className="rcv-supplier-trigger-body">
                        <span className="rcv-supplier-trigger-name">{catalogMatch.name}</span>
                        <span className="rcv-supplier-trigger-sub">
                          {catalogMatch.code}
                          {catalogMatch.phone ? ` · ${catalogMatch.phone}` : ''}
                        </span>
                      </span>
                      <span className="rcv-supplier-trigger-badge">ในระบบ</span>
                    </>
                  ) : showManualInput ? (
                    <>
                      <i className="ti ti-user-edit rcv-supplier-trigger-icon" aria-hidden="true" />
                      <span className="rcv-supplier-trigger-body">
                        <span className="rcv-supplier-trigger-name">{supplierName || '…'}</span>
                        <span className="rcv-supplier-trigger-sub">ระบุเอง — คลิกเพื่อค้นหาในระบบ</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <i className="ti ti-building-store rcv-supplier-trigger-icon" aria-hidden="true" />
                      <span className="rcv-supplier-trigger-placeholder">
                        เลือก / ค้นหาผู้จำหน่าย...
                      </span>
                      <i className="ti ti-chevron-down rcv-supplier-trigger-chevron" aria-hidden="true" />
                    </>
                  )}
                </button>
                {(supplierId || supplierName) && !isCancelled ? (
                  <button
                    type="button"
                    className="rcv-supplier-clear-btn"
                    title="ล้างการเลือก"
                    aria-label="ล้างการเลือกผู้จำหน่าย"
                    onClick={() => {
                      setSupplierId(null);
                      setSupplierName('');
                    }}
                  >
                    <i className="ti ti-x" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              {showManualInput && !isCancelled ? (
                <input
                  className="rcv-supplier-manual-input"
                  placeholder="ชื่อผู้จำหน่าย (ระบุเอง)"
                  value={supplierName}
                  onChange={(e) => {
                    setSupplierName(e.target.value);
                    setSupplierId(null);
                  }}
                />
              ) : null}
            </div>
            <div className="rcv-field rcv-form-full">
              <label htmlFor={`${idPrefix}-note`}>หมายเหตุ</label>
              <textarea
                id={`${idPrefix}-note`}
                placeholder="หมายเหตุ..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={isCancelled}
              />
            </div>
          </div>
        </div>

        <div className="rcv-card">
          <div className="rcv-card-head">
            <div className="rcv-card-head-left">
              <span>รายการสินค้ารับเข้า</span>
              <span className="rcv-card-head-sub">
                เพิ่มสินค้าลงรายการรับเข้า และตั้งค่าส่วนลดของสินค้าในแต่ละชิ้น
              </span>
            </div>
            <div className="rcv-action-btns">
              <button type="button" className="rcv-a-btn rcv-a-btn--outline" disabled title="เร็วๆ นี้">
                <i className="ti ti-file-spreadsheet" aria-hidden="true" />
                นำเข้าจากเอกสาร
              </button>
              <button
                type="button"
                className="rcv-a-btn rcv-a-btn--filled rcv-a-btn--compact"
                onClick={() => setPickerOpen(true)}
                disabled={isCancelled}
              >
                <i className="ti ti-plus" aria-hidden="true" />
                เพิ่มสินค้า
              </button>
            </div>
          </div>

          <div className="rcv-header">
            <div className="rcv-scan-bar">
              <div className="rcv-scan-wrap">
                <i className="ti ti-barcode" aria-hidden="true" />
                <input
                  ref={scanRef}
                  id={`${idPrefix}-scan-input`}
                  placeholder="สแกนบาร์โค้ด หรือพิมพ์ชื่อสินค้า แล้วกด Enter..."
                  value={scanValue}
                  onChange={(e) => setScanValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleScanSubmit();
                    }
                  }}
                />
              </div>
              <div className="rcv-scan-status">
                <div className="rcv-scan-dot" />
                พร้อมสแกน
              </div>
            </div>
          </div>

          <div className="rcv-table-scroll">
            {loading ? (
              <div className="rcv-loading">
                <i className="ti ti-loader" aria-hidden="true" />
                กำลังโหลดสินค้า...
              </div>
            ) : lines.length === 0 ? (
              <div className="rcv-table-empty">
                <i className="ti ti-package" aria-hidden="true" />
                <div className="rcv-table-empty-title">ยังไม่มีรายการรับเข้า</div>
                <div className="rcv-table-empty-text">
                  สแกนบาร์โค้ด หรือกด &quot;เพิ่มสินค้า&quot; เพื่อเริ่มต้น
                </div>
                <div className="rcv-table-empty-actions">
                  <button
                    type="button"
                    className="rcv-a-btn rcv-a-btn--filled rcv-a-btn--compact rcv-table-empty-btn"
                    onClick={() => setPickerOpen(true)}
                    disabled={isCancelled}
                  >
                    <i className="ti ti-plus" aria-hidden="true" />
                    เลือกสินค้า
                  </button>
                </div>
              </div>
            ) : (
              <Table hoverable>
                <TableHead>
                  <TableRow>
                    <TableHeadCell style={{ width: 30 }}>#</TableHeadCell>
                    <TableHeadCell style={{ width: 36 }} />
                    <TableHeadCell>สินค้า</TableHeadCell>
                    <TableHeadCell style={{ width: 95 }}>หน่วย</TableHeadCell>
                    <TableHeadCell className="text-right" style={{ width: 90 }}>
                      จำนวน
                    </TableHeadCell>
                    <TableHeadCell className="text-right" style={{ width: 100 }}>
                      ต้นทุน/หน่วย (฿)
                    </TableHeadCell>
                    <TableHeadCell className="text-right" style={{ width: 65 }}>
                      ส่วนลด
                    </TableHeadCell>
                    <TableHeadCell className="text-right" style={{ width: 90 }}>
                      รวม (฿)
                    </TableHeadCell>
                    <TableHeadCell className="text-right" style={{ width: 115 }}>
                      ต้นทุนเฉลี่ยใหม่
                    </TableHeadCell>
                    <TableHeadCell style={{ width: 110 }}>หมดอายุ</TableHeadCell>
                    <TableHeadCell style={{ width: 26 }} />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {lines.map((line, index) => {
                    const product = productMap.get(line.productId);
                    const uoms = product ? uomOptionsForProduct(product) : [];
                    const qtyBase = lineQtyBase(line);
                    const costBase = lineCostBase(line);
                    const newAvg = product
                      ? computeNewAvgCost(product.stock, product.avgCost, qtyBase, costBase)
                      : costBase;
                    const baseUnit = product?.baseUnit ?? 'ชิ้น';

                    return (
                      <TableRow
                        key={line.lineKey}
                        className={flashKey === line.lineKey ? 'rcv-flash' : undefined}
                      >
                        <TableCell className="rcv-row-num">{index + 1}</TableCell>
                        <TableCell>
                          <div className="rcv-prod-emoji">{product?.emoji ?? '📦'}</div>
                        </TableCell>
                        <TableCell>
                          <div className="rcv-prod-name-row">
                            <div className="rcv-prod-name">{line.productName}</div>
                            <span className={`rcv-vat-badge${line.hasVat ? '' : ' rcv-vat-badge--no'}`}>
                              {line.hasVat ? 'มี VAT' : 'ไม่มี VAT'}
                            </span>
                          </div>
                          <div className="rcv-prod-meta">
                            SKU: {line.sku} · {line.qty} {line.unit} = {qtyBase} {baseUnit}
                          </div>
                        </TableCell>
                        <TableCell>
                          {uoms.length > 1 ? (
                            <select
                              className="rcv-uom-sel"
                              value={line.unit}
                              onChange={(e) => handleUnitChange(line.lineKey, e.target.value)}
                            >
                              {uoms.map((u) => (
                                <option key={u.unit} value={u.unit}>
                                  {u.unit}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="rcv-uom-label">{line.unit}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="rcv-qty-cell">
                            <input
                              type="number"
                              className="rcv-ii rcv-w56"
                              min={1}
                              step={1}
                              value={line.qty}
                              onChange={(e) => {
                                const qty = Math.max(1, Number(e.target.value) || 1);
                                setLines((prev) =>
                                  updateReceivingLine(prev, line.lineKey, {
                                    qty,
                                    itemDiscount: Math.min(
                                      prev.find((l) => l.lineKey === line.lineKey)?.itemDiscount ?? 0,
                                      qty * line.costPerUnit,
                                    ),
                                  }),
                                );
                              }}
                            />
                            <span className="rcv-qty-conn">{line.unit}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <input
                            type="number"
                            className="rcv-ii rcv-w72"
                            min={0}
                            step={0.01}
                            value={line.costPerUnit || ''}
                            onChange={(e) => {
                              const costPerUnit = Math.max(0, Number(e.target.value) || 0);
                              setLines((prev) =>
                                updateReceivingLine(prev, line.lineKey, {
                                  costPerUnit,
                                  itemDiscount: Math.min(
                                    prev.find((l) => l.lineKey === line.lineKey)?.itemDiscount ?? 0,
                                    line.qty * costPerUnit,
                                  ),
                                }),
                              );
                            }}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <input
                            type="number"
                            className="rcv-ii rcv-w50"
                            min={0}
                            step={0.01}
                            value={line.itemDiscount || ''}
                            placeholder="0"
                            onChange={(e) =>
                              setLines((prev) =>
                                updateReceivingLine(prev, line.lineKey, {
                                  itemDiscount: Math.min(
                                    maxItemDiscount(line),
                                    Math.max(0, Number(e.target.value) || 0),
                                  ),
                                }),
                              )
                            }
                          />
                        </TableCell>
                        <TableCell className="text-right rcv-line-total">฿{fmtMoney(lineSubtotal(line))}</TableCell>
                        <TableCell className="text-right">
                          <div className="rcv-avg-old">เดิม ฿{fmtMoney(product?.avgCost ?? 0)}</div>
                          <div className="rcv-avg-new">→ ฿{fmtMoney(newAvg)}</div>
                        </TableCell>
                        <TableCell>
                          <div className="rcv-expiry-cell">
                            <label className="rcv-expiry-toggle">
                              <input
                                type="checkbox"
                                checked={line.hasExpiry}
                                onChange={(e) =>
                                  setLines((prev) =>
                                    updateReceivingLine(prev, line.lineKey, {
                                      hasExpiry: e.target.checked,
                                      expiryDate: e.target.checked ? line.expiryDate : '',
                                    }),
                                  )
                                }
                              />
                              <span>{line.hasExpiry ? 'กำหนดวัน' : 'ไม่กำหนด'}</span>
                            </label>
                            {line.hasExpiry ? (
                              <SingleDatePicker
                                value={line.expiryDate}
                                onChange={(iso) =>
                                  setLines((prev) =>
                                    updateReceivingLine(prev, line.lineKey, { expiryDate: iso }),
                                  )
                                }
                              />
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <button
                            type="button"
                            className="rcv-del-btn"
                            aria-label="ลบรายการ"
                            onClick={() =>
                              setLines((prev) => prev.filter((l) => l.lineKey !== line.lineKey))
                            }
                          >
                            <i className="ti ti-trash" aria-hidden="true" />
                          </button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
        {showPageSummary ? summaryPanel : null}
        <div className="rcv-scroll-spacer" />
      </div>

      {!showPageSummary ? (
        <footer className="rcv-footer">
          {summaryPanel}
          <div className="rcv-footer-actions">
            <div />
            <div className="rcv-footer-btns">
              {mode === 'edit' || onCancel ? (
                <button type="button" className="rcv-btn-draft" onClick={onCancel ?? resetBill}>
                  ยกเลิก
                </button>
              ) : null}
              <button
                type="button"
                className="rcv-btn-primary"
                disabled={submitting || lines.length === 0}
                onClick={() => void handleConfirm()}
              >
                {submitting ? (
                  <>
                    <i className="ti ti-loader" aria-hidden="true" />
                    กำลังบันทึก...
                  </>
                ) : (
                  <>
                    <i className="ti ti-check" aria-hidden="true" />
                    {mode === 'edit' ? 'บันทึกการแก้ไข' : 'ยืนยันรับเข้า'}
                  </>
                )}
              </button>
            </div>
          </div>
        </footer>
      ) : null}

      <ReceivingVoidDialog
        open={voidOpen}
        grnId={grnId ?? null}
        processing={voidProcessing}
        onClose={() => setVoidOpen(false)}
        onConfirm={(reason, note) => void handleVoidConfirm(reason, note)}
      />

      <SupplierPickerDialog
        open={supplierPickerOpen}
        suppliers={catalogSuppliers}
        onSelect={handleSelectSupplier}
        onManualEntry={handleManualEntry}
        onAddNew={handleAddNew}
        onClose={() => setSupplierPickerOpen(false)}
      />

      <PosSupplierModal
        open={posSupplierModalOpen}
        branchId={branchId}
        prefillName={supplierAddPrefill}
        onSaved={(newSupplier) => {
          handleSelectSupplier(newSupplier);
        }}
        onClose={() => setPosSupplierModalOpen(false)}
      />

      <ProductPickerDialog
        open={pickerOpen}
        products={pickerProducts}
        onConfirm={(selected) => {
          for (const item of selected) {
            const product = productMap.get(item.id);
            if (product) addProduct(product);
          }
        }}
        onClose={() => setPickerOpen(false)}
      />

      {successMsg ? (
        <div className="rcv-toast" role="status">
          <i className="ti ti-circle-check" aria-hidden="true" />
          {successMsg}
        </div>
      ) : null}

      {draftToast ? (
        <div className="rcv-toast" role="status">
          <i className="ti ti-device-floppy" aria-hidden="true" />
          {draftToast}
        </div>
      ) : null}
    </div>
  );
}
