import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import TransferConfirmDialog from '../../components/inventory/TransferConfirmDialog';
import ProductPickerDialog, { productListItemToPickerItem } from '../../components/products/ProductPickerDialog';
import type { ProductPickerItem } from '../../components/products/productPickerTypes';
import { getBranchLabel, useActiveBranches } from '../../lib/branches';
import { useAuth } from '../../lib/hooks/useAuth';
import { confirmBranchTransfer } from '../../lib/inventory/transferCrud';
import { lineFromPickerForTransfer, type TransferLine } from '../../lib/inventory/transferTypes';
import { useProductCrud } from '../../lib/productCrud/useProductCrud';
import './InventoryAdjustmentPage.css';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function BranchTransferPage() {
  const navigate = useNavigate();
  const { branchId, user } = useAuth();
  const { branches: activeBranches } = useActiveBranches();
  const { products, loading } = useProductCrud(branchId);

  const [transferDate, setTransferDate] = useState(todayIso);
  const [toBranchId, setToBranchId] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<TransferLine[]>([]);
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

  const destBranches = useMemo(
    () => activeBranches.filter((b) => b.id !== branchId),
    [activeBranches, branchId],
  );

  const linesWithQty = useMemo(
    () => lines.filter((l) => l.transferQty > 0),
    [lines],
  );

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(t);
  }, [toast]);

  const addFromPicker = useCallback(
    (items: ProductPickerItem[]) => {
      setLines((prev) => {
        const existing = new Set(prev.map((l) => l.productId));
        const next = [...prev];
        for (const item of items) {
          if (existing.has(item.id)) continue;
          const live = productMap.get(item.id);
          next.push(
            lineFromPickerForTransfer({
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

  const updateLine = (lineKey: string, patch: Partial<TransferLine>) => {
    setLines((prev) => prev.map((l) => (l.lineKey === lineKey ? { ...l, ...patch } : l)));
  };

  const removeLine = (lineKey: string) => {
    setLines((prev) => prev.filter((l) => l.lineKey !== lineKey));
  };

  const validateForm = (): boolean => {
    setValidationError(null);

    if (!branchId) {
      setValidationError('กรุณาเลือกสาขาก่อนใช้งาน');
      return false;
    }
    if (!toBranchId) {
      setValidationError('กรุณาเลือกสาขาปลายทาง');
      return false;
    }
    if (toBranchId === branchId) {
      setValidationError('สาขาปลายทางต้องไม่ซ้ำกับสาขาต้นทาง');
      return false;
    }
    if (lines.length === 0) {
      setValidationError('กรุณาเพิ่มรายการสินค้าก่อนยืนยัน');
      return false;
    }
    if (linesWithQty.length === 0) {
      setValidationError('กรุณาระบุจำนวนที่โอนอย่างน้อย 1 รายการ');
      return false;
    }

    for (const line of linesWithQty) {
      const liveStock = productMap.get(line.productId)?.stock ?? line.sourceStock;
      if (line.transferQty <= 0) {
        setValidationError(`จำนวนโอนต้องมากกว่า 0: ${line.name}`);
        return false;
      }
      if (line.transferQty > liveStock) {
        setValidationError(`จำนวนโอนเกินสต็อกต้นทาง: ${line.name} (คงเหลือ ${liveStock})`);
        return false;
      }
    }

    return true;
  };

  const handleOpenConfirm = () => {
    if (!validateForm()) return;
    setShowConfirmModal(true);
  };

  const handleSave = async () => {
    if (!branchId || !user) return;

    setSubmitting(true);
    try {
      await confirmBranchTransfer(
        {
          transferDate,
          fromBranchId: branchId,
          toBranchId,
          note,
          staffId: user.id,
          staffName: `${user.firstName} ${user.lastName}`.trim(),
        },
        linesWithQty.map((l) => ({
          productId: l.productId,
          name: l.name,
          sku: l.sku,
          sourceStock: productMap.get(l.productId)?.stock ?? l.sourceStock,
          transferQty: l.transferQty,
        })),
      );
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

  const fromLabel = getBranchLabel(branchId);
  const toLabel = toBranchId ? getBranchLabel(toBranchId) : '—';

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
        <span className="inv-adj-title">โอนย้ายสินค้าระหว่างสาขา</span>
        <span className="inv-adj-badge">TR — ร่าง</span>
      </header>

      {validationError ? <div className="inv-adj-error-banner">{validationError}</div> : null}

      <div className="inv-adj-scroll">
        <div className="inv-adj-card">
          <div className="inv-adj-card-head">ข้อมูลเบื้องต้น</div>
          <div className="inv-adj-form-grid">
            <div className="inv-adj-field">
              <label htmlFor="inv-tr-date">วันที่</label>
              <input
                id="inv-tr-date"
                type="date"
                value={transferDate}
                onChange={(e) => setTransferDate(e.target.value)}
              />
            </div>
            <div className="inv-adj-field">
              <label>สาขาต้นทาง</label>
              <input readOnly value={`TwinPet — สาขา${fromLabel}`} />
            </div>
            <div className="inv-adj-field">
              <label htmlFor="inv-tr-to">สาขาปลายทาง</label>
              <select
                id="inv-tr-to"
                value={toBranchId}
                onChange={(e) => setToBranchId(e.target.value)}
              >
                <option value="">— เลือกสาขาปลายทาง —</option>
                {destBranches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="inv-adj-field inv-adj-form-full">
              <label htmlFor="inv-tr-note">หมายเหตุ</label>
              <textarea
                id="inv-tr-note"
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
                ยังไม่มีรายการ — กด &quot;+ เลือกสินค้า&quot; เพื่อเพิ่มสินค้าที่ต้องการโอน
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
                      สต็อกต้นทาง
                    </th>
                    <th className="r" style={{ width: 120 }}>
                      จำนวนที่โอน
                    </th>
                    <th className="c" style={{ width: 48 }} />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => {
                    const liveStock = productMap.get(line.productId)?.stock ?? line.sourceStock;
                    const overStock = line.transferQty > liveStock;
                    return (
                      <tr key={line.lineKey}>
                        <td className="c">{idx + 1}</td>
                        <td>
                          <div className="inv-adj-prod-name">{line.name}</div>
                          <div className="inv-adj-prod-sku">{line.sku}</div>
                        </td>
                        <td className="r">{liveStock}</td>
                        <td className="r">
                          <input
                            className="inv-adj-qty-input"
                            type="number"
                            min={1}
                            max={liveStock}
                            step={1}
                            value={line.transferQty || ''}
                            placeholder="0"
                            onChange={(e) =>
                              updateLine(line.lineKey, {
                                transferQty: e.target.value === '' ? 0 : Number(e.target.value),
                              })
                            }
                          />
                          {overStock ? (
                            <div className="inv-adj-new-warn" style={{ marginTop: 4, fontSize: 11 }}>
                              เกินสต็อก ({liveStock})
                            </div>
                          ) : null}
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
          รายการทั้งหมด <strong>{lines.length}</strong> · โอนย้าย{' '}
          <strong>{linesWithQty.length}</strong> รายการ
        </div>
        <button
          type="button"
          className="inv-adj-confirm-btn"
          disabled={submitting || lines.length === 0}
          onClick={handleOpenConfirm}
        >
          <i className="ti ti-arrows-exchange" aria-hidden="true" />
          ยืนยันการโอนย้าย
        </button>
      </footer>

      <TransferConfirmDialog
        open={showConfirmModal}
        itemCount={linesWithQty.length}
        fromBranchLabel={`สาขา${fromLabel}`}
        toBranchLabel={toBranchId ? `สาขา${toLabel}` : '—'}
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
