import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CustomerDetailModal from '../components/customers/CustomerDetailModal';
import SupplierPickerDialog from '../components/customers/SupplierPickerDialog';
import ProductPickerDialog, { productListItemToPickerItem } from '../components/products/ProductPickerDialog';
import { getBranchLabel } from '../lib/branches';
import { customerFullName, inferContactType, normalizeCustomerForm } from '../lib/customers/types';
import { useCustomers } from '../lib/customers/useCustomers';
import { useAuth } from '../lib/hooks/useAuth';
import { useProductCrud } from '../lib/productCrud/useProductCrud';
import type { ProductListItem } from '../lib/productCrud/types';
import { confirmReceiving } from '../lib/receiving/confirmReceiving';
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
} from '../lib/receiving/types';
import type { Customer } from '../lib/types';
import './ReceivingPage.css';

function updateLine(
  lines: ReceivingLine[],
  lineKey: string,
  patch: Partial<ReceivingLine>,
): ReceivingLine[] {
  return lines.map((l) => (l.lineKey === lineKey ? { ...l, ...patch } : l));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function generateFallbackBillNo(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const suffix = String(Math.floor(Math.random() * 9000) + 1000);
  return `RCV-${y}${m}${day}-${suffix}`;
}

function buildReceivingNote(parts: {
  billNo: string;
  receiveDate: string;
  billDate: string;
  note: string;
}): string {
  return [
    parts.billNo && `เลขที่บิล: ${parts.billNo}`,
    parts.receiveDate && `วันที่รับเข้า: ${parts.receiveDate}`,
    parts.billDate && `วันที่ซื้อในบิล: ${parts.billDate}`,
    parts.note.trim(),
  ]
    .filter(Boolean)
    .join(' · ');
}

export default function ReceivingPage() {
  const { branchId, user } = useAuth();
  const { products, loading } = useProductCrud(branchId);
  const { customers, priceLevels, creditMap, saveCustomer, refreshDev } = useCustomers(branchId);

  const [lines, setLines] = useState<ReceivingLine[]>([]);
  const [discType, setDiscType] = useState<'pct' | 'thb'>('thb');
  const [discValue, setDiscValue] = useState(0);
  const [vatOn, setVatOn] = useState(false);
  const [vatInc, setVatInc] = useState(false);
  const [billDate, setBillDate] = useState(todayIso);
  const [receiveDate, setReceiveDate] = useState(todayIso);
  const [purchaseBillNo, setPurchaseBillNo] = useState('');
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [supplierName, setSupplierName] = useState('');
  const [note, setNote] = useState('');
  const [scanValue, setScanValue] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [detailSupplier, setDetailSupplier] = useState<Customer | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successGrn, setSuccessGrn] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [draftToast, setDraftToast] = useState<string | null>(null);

  const bcBuf = useRef('');
  const bcTimer = useRef<number | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

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

  const suppliers = useMemo(
    () => customers.filter((c) => c.isActive && inferContactType(c) === 'supplier'),
    [customers],
  );

  const selectSupplier = useCallback((supplier: Customer) => {
    setSupplierId(supplier.id);
    setSupplierName(customerFullName(supplier));
    setError(null);
  }, []);

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
    if (!successGrn) return;
    const t = window.setTimeout(() => setSuccessGrn(null), 5000);
    return () => window.clearTimeout(t);
  }, [successGrn]);

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
      updateLine(prev, lineKey, {
        unit: uom.unit,
        unitFactor: uom.factor,
        costPerUnit: costBase * uom.factor,
      }),
    );
  };

  const resetBill = () => {
    setLines([]);
    setDiscValue(0);
    setDiscType('thb');
    setVatOn(false);
    setVatInc(false);
    setSupplierId(null);
    setSupplierName('');
    setPurchaseBillNo('');
    setBillDate(todayIso());
    setReceiveDate(todayIso());
    setNote('');
    setError(null);
  };

  const handleSaveDraft = () => {
    setDraftToast('บันทึกแบบร่างแล้ว');
  };

  const handleConfirm = async () => {
    if (!branchId || !user) return;
    if (lines.length === 0) {
      setError('กรุณาเพิ่มรายการสินค้าก่อนยืนยัน');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const billNo = purchaseBillNo.trim() || generateFallbackBillNo();
      const grnId = await confirmReceiving({
        branchId,
        staffId: user.id,
        staffName: `${user.firstName} ${user.lastName}`.trim(),
        supplierId,
        supplierName,
        note: buildReceivingNote({ billNo, receiveDate, billDate, note }),
        finalDiscount,
        lines,
      });
      setSuccessGrn(grnId);
      resetBill();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ');
    } finally {
      setSubmitting(false);
    }
  };

  if (!branchId) {
    return (
      <div className="rcv-page">
        <div className="rcv-loading">กรุณาเลือกสาขาก่อนใช้งาน</div>
      </div>
    );
  }

  const branchLabel = getBranchLabel(branchId);

  return (
    <div className="rcv-page">
      <header className="rcv-topbar">
        <div className="rcv-back-btn" aria-hidden="true">
          <i className="ti ti-arrow-left" />
        </div>
        <span className="rcv-topbar-title">สร้างเอกสารรับสินค้าเข้า</span>
        <span className="rcv-ref-badge">GRN — ร่าง</span>
        <button type="button" className="rcv-cancel-top-btn" onClick={resetBill}>
          ยกเลิก
        </button>
        <button
          type="button"
          className="rcv-save-top-btn"
          disabled={submitting || lines.length === 0}
          onClick={() => void handleConfirm()}
        >
          <i className="ti ti-check" aria-hidden="true" />
          บันทึก
        </button>
      </header>

      {error ? <div className="rcv-error-banner">{error}</div> : null}

      <div className="rcv-scroll-content">
        <div className="rcv-card">
          <div className="rcv-card-head">ข้อมูลเบื้องต้น</div>
          <div className="rcv-form-grid">
            <div className="rcv-field">
              <label htmlFor="rcv-bill-date">วันที่ซื้อในบิล</label>
              <input
                id="rcv-bill-date"
                type="date"
                value={billDate}
                onChange={(e) => setBillDate(e.target.value)}
              />
            </div>
            <div className="rcv-field">
              <label htmlFor="rcv-receive-date">วันที่รับเข้า</label>
              <input
                id="rcv-receive-date"
                type="date"
                value={receiveDate}
                onChange={(e) => setReceiveDate(e.target.value)}
              />
            </div>
            <div className="rcv-field">
              <label htmlFor="rcv-purchase-no">เลขที่ในบิลซื้อ</label>
              <input
                id="rcv-purchase-no"
                placeholder="เลขที่บิลจาก supplier..."
                value={purchaseBillNo}
                onChange={(e) => setPurchaseBillNo(e.target.value)}
              />
            </div>
            <div className="rcv-field">
              <label>ร้านค้า (สาขา)</label>
              <div className="rcv-branch-tag branch-tag">
                <i className="ti ti-building-store" aria-hidden="true" />
                TwinPet — สาขา{branchLabel}
              </div>
            </div>
            <div className="rcv-field">
              <label htmlFor="rcv-supplier">ผู้จำหน่าย</label>
              <div className="rcv-supplier-input-row">
                <input
                  id="rcv-supplier"
                  className="rcv-supplier-input"
                  placeholder="ชื่อซัพพลายเออร์"
                  value={supplierName}
                  onChange={(e) => {
                    setSupplierName(e.target.value);
                    setSupplierId(null);
                  }}
                />
                <button
                  type="button"
                  className="rcv-supplier-search-btn"
                  title="ค้นหาผู้จัดจำหน่าย"
                  aria-label="ค้นหาผู้จัดจำหน่าย"
                  onClick={() => setSupplierPickerOpen(true)}
                >
                  <i className="ti ti-search" aria-hidden="true" />
                </button>
              </div>
              {supplierId ? (
                <div className="rcv-supplier-linked">
                  <i className="ti ti-link" aria-hidden="true" />
                  เชื่อมกับรายชื่อในระบบ
                  <button
                    type="button"
                    className="rcv-supplier-view-link"
                    onClick={() => {
                      const s = suppliers.find((x) => x.id === supplierId);
                      if (s) setDetailSupplier(s);
                    }}
                  >
                    ดูรายละเอียด
                  </button>
                </div>
              ) : null}
            </div>
            <div className="rcv-field rcv-form-full">
              <label htmlFor="rcv-note">หมายเหตุ</label>
              <textarea
                id="rcv-note"
                placeholder="หมายเหตุ..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
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
                + นำเข้าจากเอกสาร
              </button>
              <button type="button" className="rcv-a-btn rcv-a-btn--filled" onClick={() => setPickerOpen(true)}>
                <i className="ti ti-plus" aria-hidden="true" />
                + เพิ่มสินค้า
              </button>
            </div>
          </div>

          <div className="rcv-toolbar">
            <div className="rcv-toolbar-left">
              <span className="rcv-toolbar-branch">
                รับเข้า: <strong>{branchLabel}</strong>
              </span>
              <button type="button" className="rcv-branch-change-btn" title="เปลี่ยนสาขาจากเมนูหลัก">
                เปลี่ยน
              </button>
            </div>
          </div>

          <div className="rcv-header">
            <div className="rcv-scan-bar">
              <div className="rcv-scan-wrap">
                <i className="ti ti-barcode" aria-hidden="true" />
                <input
                  ref={scanRef}
                  id="rcv-scan-input"
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
                  สแกนบาร์โค้ด หรือกด &quot;+ เพิ่มสินค้า&quot; เพื่อเริ่มต้น
                </div>
                <div className="rcv-table-empty-actions">
                  <button
                    type="button"
                    className="rcv-a-btn rcv-a-btn--filled rcv-table-empty-btn"
                    onClick={() => setPickerOpen(true)}
                  >
                    <i className="ti ti-plus" aria-hidden="true" />
                    + เลือกสินค้า
                  </button>
                </div>
              </div>
            ) : (
              <table className="rcv-table">
                <thead>
                  <tr>
                    <th style={{ width: 30 }}>#</th>
                    <th style={{ width: 36 }} />
                    <th>สินค้า</th>
                    <th style={{ width: 95 }}>หน่วย</th>
                    <th className="r" style={{ width: 90 }}>
                      จำนวน
                    </th>
                    <th className="r" style={{ width: 100 }}>
                      ต้นทุน/หน่วย (฿)
                    </th>
                    <th className="r" style={{ width: 65 }}>
                      ส่วนลด
                    </th>
                    <th className="r" style={{ width: 90 }}>
                      รวม (฿)
                    </th>
                    <th className="r" style={{ width: 115 }}>
                      ต้นทุนเฉลี่ยใหม่
                    </th>
                    <th style={{ width: 110 }}>หมดอายุ</th>
                    <th style={{ width: 26 }} />
                  </tr>
                </thead>
                <tbody>
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
                      <tr
                        key={line.lineKey}
                        className={flashKey === line.lineKey ? 'rcv-flash' : undefined}
                      >
                        <td className="rcv-row-num">{index + 1}</td>
                        <td>
                          <div className="rcv-prod-emoji">{product?.emoji ?? '📦'}</div>
                        </td>
                        <td>
                          <div className="rcv-prod-name-row">
                            <div className="rcv-prod-name">{line.productName}</div>
                            <span className={`rcv-vat-badge${line.hasVat ? '' : ' rcv-vat-badge--no'}`}>
                              {line.hasVat ? 'มี VAT' : 'ไม่มี VAT'}
                            </span>
                          </div>
                          <div className="rcv-prod-meta">
                            SKU: {line.sku} · {line.qty} {line.unit} = {qtyBase} {baseUnit}
                          </div>
                        </td>
                        <td>
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
                        </td>
                        <td className="r">
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
                                  updateLine(prev, line.lineKey, {
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
                        </td>
                        <td className="r">
                          <input
                            type="number"
                            className="rcv-ii rcv-w72"
                            min={0}
                            step={0.01}
                            value={line.costPerUnit || ''}
                            onChange={(e) => {
                              const costPerUnit = Math.max(0, Number(e.target.value) || 0);
                              setLines((prev) =>
                                updateLine(prev, line.lineKey, {
                                  costPerUnit,
                                  itemDiscount: Math.min(
                                    prev.find((l) => l.lineKey === line.lineKey)?.itemDiscount ?? 0,
                                    line.qty * costPerUnit,
                                  ),
                                }),
                              );
                            }}
                          />
                        </td>
                        <td className="r">
                          <input
                            type="number"
                            className="rcv-ii rcv-w50"
                            min={0}
                            step={0.01}
                            value={line.itemDiscount || ''}
                            placeholder="0"
                            onChange={(e) =>
                              setLines((prev) =>
                                updateLine(prev, line.lineKey, {
                                  itemDiscount: Math.min(
                                    maxItemDiscount(line),
                                    Math.max(0, Number(e.target.value) || 0),
                                  ),
                                }),
                              )
                            }
                          />
                        </td>
                        <td className="r rcv-line-total">฿{fmtMoney(lineSubtotal(line))}</td>
                        <td className="r">
                          <div className="rcv-avg-old">เดิม ฿{fmtMoney(product?.avgCost ?? 0)}</div>
                          <div className="rcv-avg-new">→ ฿{fmtMoney(newAvg)}</div>
                        </td>
                        <td>
                          <div className="rcv-expiry-cell">
                            <label className="rcv-expiry-toggle">
                              <input
                                type="checkbox"
                                checked={line.hasExpiry}
                                onChange={(e) =>
                                  setLines((prev) =>
                                    updateLine(prev, line.lineKey, {
                                      hasExpiry: e.target.checked,
                                      expiryDate: e.target.checked ? line.expiryDate : '',
                                    }),
                                  )
                                }
                              />
                              <span>{line.hasExpiry ? 'กำหนดวัน' : 'ไม่กำหนด'}</span>
                            </label>
                            {line.hasExpiry ? (
                              <input
                                type="date"
                                className="rcv-expiry-date"
                                value={line.expiryDate}
                                onChange={(e) =>
                                  setLines((prev) =>
                                    updateLine(prev, line.lineKey, { expiryDate: e.target.value }),
                                  )
                                }
                              />
                            ) : null}
                          </div>
                        </td>
                        <td>
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
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div className="rcv-scroll-spacer" />
      </div>

      <footer className="rcv-footer">
        <div className="rcv-footer-summary">
          <div className="rcv-fsec rcv-fsec--vat">
            <span className="rcv-fs-lbl">ภาษีมูลค่าเพิ่ม</span>
            <div className="rcv-tog-row">
              <label className="rcv-tog">
                <input type="checkbox" checked={vatOn} onChange={(e) => setVatOn(e.target.checked)} />
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
                  disabled={!vatOn}
                  onChange={(e) => setVatInc(e.target.checked)}
                />
                <div className="rcv-tog-track" />
                <div className="rcv-tog-thumb" />
              </label>
              <span
                className={`rcv-tog-lbl${!vatOn ? ' locked' : vatInc ? ' active' : ' inactive'}`}
              >
                ราคารวมภาษีแล้ว
              </span>
            </div>
            <span className="rcv-vat-amt">{vatOn && vatAmt > 0 ? `VAT = ฿${fmtMoney(vatAmt)}` : ''}</span>
          </div>
          <div className="rcv-fdiv" />
          <div className="rcv-fsec rcv-fsec--discount">
            <span className="rcv-fs-lbl">ส่วนลด</span>
            <div className="rcv-disc-wrap">
              <input
                className="rcv-disc-inp"
                type="number"
                min={0}
                placeholder="0"
                value={discValue || ''}
                onChange={(e) => setDiscValue(Math.max(0, Number(e.target.value) || 0))}
              />
              <button
                type="button"
                className={`rcv-disc-tog${discType === 'pct' ? ' on' : ''}`}
                onClick={() => setDiscType((t) => (t === 'pct' ? 'thb' : 'pct'))}
              >
                {discType === 'pct' ? '%' : '฿'}
              </button>
            </div>
            <span className="rcv-disc-lbl">
              {finalDiscount > 0 ? `-฿${fmtMoney(finalDiscount)}` : ''}
            </span>
          </div>
          <div className="rcv-fdiv" />
          <div className="summary-block">
            <div className="summary-line">
              <span className="summary-line-label">จำนวนรายการ</span>
              <span className="summary-line-val summary-item-count">
                {lines.length}
                {Array.from(categoryCounts.entries()).map(([cat, count]) => (
                  <span
                    key={cat}
                    className={`type-tag ${CATEGORY_TYPE_TAG[cat] ?? 'type-other'}`}
                  >
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
            <div className="rcv-ti">
              <span className="rcv-tl">ส่วนลด</span>
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

        <div className="rcv-footer-actions">
          <div />
          <div className="rcv-footer-btns">
            <button type="button" className="rcv-btn-draft" onClick={handleSaveDraft}>
              บันทึกแบบร่าง
            </button>
            <button type="button" className="rcv-btn-danger" onClick={resetBill}>
              ลบบิลนี้
            </button>
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
                  ยืนยันรับเข้า
                </>
              )}
            </button>
          </div>
        </div>
      </footer>

      <SupplierPickerDialog
        open={supplierPickerOpen}
        suppliers={suppliers}
        onSelect={selectSupplier}
        onViewDetail={(s) => {
          setSupplierPickerOpen(false);
          setDetailSupplier(s);
        }}
        onClose={() => setSupplierPickerOpen(false)}
      />

      {detailSupplier && branchId && user ? (
        <CustomerDetailModal
          customer={detailSupplier}
          creditAccount={creditMap.get(detailSupplier.id) ?? null}
          priceLevels={priceLevels}
          branchId={branchId}
          actorId={user.id}
          open={!!detailSupplier}
          onClose={() => setDetailSupplier(null)}
          onSave={async (form) => {
            const saved = await saveCustomer(normalizeCustomerForm(form), detailSupplier.id);
            setDetailSupplier(saved);
            if (supplierId === saved.id) {
              setSupplierName(customerFullName(saved));
            }
            refreshDev();
          }}
          onCreditPaid={refreshDev}
        />
      ) : null}

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

      {successGrn ? (
        <div className="rcv-toast" role="status">
          <i className="ti ti-circle-check" aria-hidden="true" />
          บันทึกใบรับเข้า {successGrn} สำเร็จ
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
