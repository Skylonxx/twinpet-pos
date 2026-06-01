import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SingleDatePicker } from '../../components/common/SingleDatePicker';
import InventoryAdjustmentConfirmDialog from '../../components/inventory/InventoryAdjustmentConfirmDialog';
import ProductPickerDialog, { productListItemToPickerItem } from '../../components/products/ProductPickerDialog';
import type { ProductPickerItem } from '../../components/products/productPickerTypes';
import { getBranchLabel } from '../../lib/branches';
import { confirmInventoryAdjustment } from '../../lib/inventory/confirmInventoryAdjustment';
import { useAuth } from '../../lib/hooks/useAuth';
import { useProductCrud } from '../../lib/productCrud/useProductCrud';
import {
  ADJUSTMENT_REASONS_BY_DIRECTION,
  computeLineImpact,
  computeTotalValueImpact,
  formatAdjustQty,
  lineFromPickerItem,
  newStock,
  type AdjustmentDirection,
  type AdjustmentLine,
  type AdjustmentReason,
} from '../../lib/inventory/types';
import './InventoryAdjustmentPage.css';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function qtyClass(qty: number): string {
  if (qty > 0) return 'inv-adj-qty-pos';
  if (qty < 0) return 'inv-adj-qty-neg';
  return 'inv-adj-qty-zero';
}

export default function InventoryAdjustmentPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { branchId, user } = useAuth();
  const { products, loading } = useProductCrud(branchId);

  // Direction is chosen on the previous screen and passed via `?mode=in|out`,
  // so this page is a dedicated In or Out flow (no in-form toggle). Read once
  // on mount; defaults to "out" for any missing/invalid value.
  const initialDirection: AdjustmentDirection =
    searchParams.get('mode') === 'in' ? 'in' : 'out';

  const [adjustDate, setAdjustDate] = useState(todayIso);
  const [direction] = useState<AdjustmentDirection>(initialDirection);
  const [reason, setReason] = useState<AdjustmentReason>(
    ADJUSTMENT_REASONS_BY_DIRECTION[initialDirection][0],
  );
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<AdjustmentLine[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const activeProducts = useMemo(
    () => products.filter((p) => p.isActive && !p.deletedAt),
    [products],
  );

  const pickerProducts = useMemo(
    () => activeProducts.map(productListItemToPickerItem),
    [activeProducts],
  );

  const productMap = useMemo(() => {
    const m = new Map<string, (typeof activeProducts)[number]>();
    for (const p of activeProducts) m.set(p.id, p);
    return m;
  }, [activeProducts]);

  const addFromPicker = useCallback(
    (items: ProductPickerItem[]) => {
      setLines((prev) => {
        const existing = new Set(prev.map((l) => l.productId));
        const next = [...prev];
        for (const item of items) {
          if (existing.has(item.id)) continue;
          const live = productMap.get(item.id);
          next.push(
            lineFromPickerItem({
              ...item,
              stock: live?.stock ?? item.stock,
            }),
          );
          existing.add(item.id);
        }
        return next;
      });
      setPickerOpen(false);
    },
    [productMap],
  );

  const updateLine = (lineKey: string, patch: Partial<AdjustmentLine>) => {
    setLines((prev) => prev.map((l) => (l.lineKey === lineKey ? { ...l, ...patch } : l)));
  };

  const removeLine = (lineKey: string) => {
    setLines((prev) => prev.filter((l) => l.lineKey !== lineKey));
  };

  const reasonOptions = ADJUSTMENT_REASONS_BY_DIRECTION[direction];
  const dirLabel = direction === 'in' ? 'รับเข้า' : 'จ่ายออก';

  // The user types a positive magnitude; the sign comes from the direction.
  const signedQty = (mag: number) => (direction === 'out' ? -Math.abs(mag) : Math.abs(mag));

  const linesWithAdjust = lines.filter((l) => l.adjustQty !== 0);

  const totalValueImpact = useMemo(() => {
    const items = linesWithAdjust.map((line) => {
      const avgCost = productMap.get(line.productId)?.avgCost ?? 0;
      return computeLineImpact(line.adjustQty, avgCost);
    });
    return computeTotalValueImpact(items);
  }, [linesWithAdjust, productMap]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(t);
  }, [toast]);

  const handleOpenConfirm = () => {
    setValidationError(null);
    if (lines.length === 0) {
      setValidationError('กรุณาเพิ่มรายการสินค้าก่อนยืนยัน');
      return;
    }
    if (linesWithAdjust.length === 0) {
      setValidationError('กรุณาระบุยอดที่ปรับปรุง (+/-) อย่างน้อย 1 รายการ');
      return;
    }
    if (lines.some((l) => newStock(l) < 0)) {
      setValidationError('ยอดคงเหลือใหม่ต้องไม่ติดลบ — กรุณาตรวจสอบจำนวนที่ปรับปรุง');
      return;
    }
    setShowConfirmModal(true);
  };

  const handleSave = async () => {
    if (!branchId || !user) return;

    setSubmitting(true);
    try {
      await confirmInventoryAdjustment({
        branchId,
        staffId: user.id,
        staffName: `${user.firstName} ${user.lastName}`.trim(),
        adjustDate,
        reason,
        note,
        lines: linesWithAdjust.map((l) => ({
          productId: l.productId,
          name: l.name,
          sku: l.sku,
          currentStock: l.currentStock,
          adjustQty: l.adjustQty,
        })),
      });
      setShowConfirmModal(false);
      setToast('บันทึกสำเร็จ');
      window.setTimeout(() => navigate('/inventory'), 400);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ');
      setShowConfirmModal(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (!branchId) {
    return (
      <div className="inv-adj-page">
        <div className="inv-adj-empty">กรุณาเลือกสาขาก่อนใช้งาน</div>
      </div>
    );
  }

  const branchLabel = getBranchLabel(branchId);

  return (
    <div className="inv-adj-page">
      <header className="inv-adj-topbar">
        <button
          type="button"
          className="inv-adj-back"
          onClick={() => navigate('/inventory')}
          aria-label="กลับ"
        >
          <i className="ti ti-arrow-left" aria-hidden="true" />
        </button>
        <span className="inv-adj-title">ปรับปรุงยอดสต็อก — {dirLabel}</span>
        <span className={`inv-adj-badge inv-adj-badge-${direction}`}>
          <i
            className={`ti ti-arrow-${direction === 'in' ? 'down-left' : 'up-right'}`}
            aria-hidden="true"
          />{' '}
          {direction === 'in' ? 'รับเข้า (Adjust In)' : 'จ่ายออก (Adjust Out)'}
        </span>
      </header>

      {validationError ? <div className="inv-adj-error-banner">{validationError}</div> : null}

      <div className="inv-adj-scroll">
        <div className="inv-adj-card">
          <div className="inv-adj-card-head">ข้อมูลเบื้องต้น</div>
          <div className="inv-adj-form-grid">
            <div className="inv-adj-field">
              <label htmlFor="inv-adj-date">วันที่</label>
              <SingleDatePicker
                id="inv-adj-date"
                value={adjustDate}
                onChange={setAdjustDate}
              />
            </div>
            <div className="inv-adj-field">
              <label htmlFor="inv-adj-reason">สาเหตุ</label>
              <select
                id="inv-adj-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value as AdjustmentReason)}
              >
                {reasonOptions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="inv-adj-field">
              <label>สาขา</label>
              <input readOnly value={`TwinPet — สาขา${branchLabel}`} />
            </div>
            <div className="inv-adj-field inv-adj-form-full">
              <label htmlFor="inv-adj-note">หมายเหตุ</label>
              <textarea
                id="inv-adj-note"
                placeholder="รายละเอียดเพิ่มเติม (ถ้ามี)..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="inv-adj-card">
          <div className="inv-adj-card-head">
            <span>รายการสินค้า</span>
            <button type="button" className="inv-adj-pick-btn" onClick={() => setPickerOpen(true)}>
              <i className="ti ti-plus" aria-hidden="true" /> เลือกสินค้า
            </button>
          </div>

          <div className="inv-adj-table-wrap">
            {loading ? (
              <div className="inv-adj-empty">กำลังโหลดสินค้า...</div>
            ) : lines.length === 0 ? (
              <div className="inv-adj-empty">
                ยังไม่มีรายการ — กด &quot;+ เลือกสินค้า&quot; เพื่อเพิ่มสินค้าที่ต้องการปรับยอด
              </div>
            ) : (
              <table className="inv-adj-table">
                <thead>
                  <tr>
                    <th className="c" style={{ width: 36 }}>
                      #
                    </th>
                    <th>สินค้า</th>
                    <th className="r" style={{ width: 100 }}>
                      คงเหลือปัจจุบัน
                    </th>
                    <th className="r" style={{ width: 120 }}>
                      จำนวนที่{dirLabel}
                    </th>
                    <th className="r" style={{ width: 110 }}>
                      ยอดคงเหลือใหม่
                    </th>
                    <th className="c" style={{ width: 48 }} />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => {
                    const next = newStock(line);
                    const nextWarn = next < 0;
                    return (
                      <tr key={line.lineKey}>
                        <td className="c">{idx + 1}</td>
                        <td>
                          <div className="inv-adj-prod-name">{line.name}</div>
                          <div className="inv-adj-prod-sku">{line.sku}</div>
                        </td>
                        <td className="r">{line.currentStock}</td>
                        <td className="r">
                          <input
                            className="inv-adj-qty-input"
                            type="number"
                            min={0}
                            step={1}
                            value={Math.abs(line.adjustQty) || ''}
                            placeholder="0"
                            onChange={(e) =>
                              updateLine(line.lineKey, {
                                adjustQty:
                                  e.target.value === '' ? 0 : signedQty(Number(e.target.value)),
                              })
                            }
                          />
                          <div className={qtyClass(line.adjustQty)} style={{ marginTop: 4, fontSize: 11 }}>
                            {formatAdjustQty(line.adjustQty)}
                          </div>
                        </td>
                        <td className="r">
                          <span className={`inv-adj-new-stock${nextWarn ? ' inv-adj-new-warn' : ''}`}>
                            {next}
                          </span>
                        </td>
                        <td className="c">
                          <button
                            type="button"
                            className="inv-adj-del-btn"
                            onClick={() => removeLine(line.lineKey)}
                            aria-label="ลบรายการ"
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
      </div>

      <footer className="inv-adj-footer">
        <div className="inv-adj-footer-summary">
          รายการทั้งหมด <strong>{lines.length}</strong> · ปรับปรุง{' '}
          <strong>{linesWithAdjust.length}</strong> รายการ
        </div>
        <button
          type="button"
          className="inv-adj-confirm-btn"
          disabled={submitting || lines.length === 0}
          onClick={handleOpenConfirm}
        >
          <i className="ti ti-check" aria-hidden="true" />
          ยืนยันการปรับปรุง
        </button>
      </footer>

      <InventoryAdjustmentConfirmDialog
        open={showConfirmModal}
        itemCount={linesWithAdjust.length}
        totalValueImpact={totalValueImpact}
        saving={submitting}
        onConfirm={() => void handleSave()}
        onCancel={() => !submitting && setShowConfirmModal(false)}
      />

      <ProductPickerDialog
        open={pickerOpen}
        products={pickerProducts}
        onConfirm={addFromPicker}
        onClose={() => setPickerOpen(false)}
      />

      {toast ? (
        <div className="inv-adj-toast" role="status">
          <i className="ti ti-circle-check" aria-hidden="true" />
          {toast}
        </div>
      ) : null}
    </div>
  );
}
