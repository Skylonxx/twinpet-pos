import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useActiveBranches } from '../../lib/branches';
import { useCategories } from '../../lib/inventory/categoryService';
import {
  emptyForm,
  fmtBaht,
  formatUomBreakdown,
  movementLabel,
  productToForm,
  sanitizeProductForm,
  validateProductForm,
  DRAWER_TABS,
  type DrawerTab,
  type ProductFormData,
  type ProductFormFieldErrors,
  type ProductListItem,
  type ProductUomFormRow,
} from '../../lib/productCrud/types';
import { buildSubUnitSelectOptions, buildUnitSelectOptions, useUomUnits } from '../../lib/settings/useUomUnits';
import { useExpiryPolicies } from '../../lib/inventory/useExpiryPolicies';
import { resizeProductImageToDataUrl } from '../../lib/productCrud/resizeProductImage';
import type { StockLot, StockMovement } from '../../lib/types';
import { RETAIL_PRICE_LEVEL_ID } from '../../lib/types';
import FifoQueueModal from '../inventory/FifoQueueModal';
import ProductSaveConfirmDialog from './ProductSaveConfirmDialog';
import TierPriceManagerDialog from './TierPriceManagerDialog';
import UnitManagerModal from './UnitManagerModal';

const RETAIL_PRICE_KEY = RETAIL_PRICE_LEVEL_ID;

type TierDialogConfig = {
  title: string;
  basePrice: number;
  initialTierPrices: Record<string, number>;
  onSave: (next: Record<string, number>) => void;
};

function TierPriceManageButton({
  customCount,
  onClick,
  label = 'จัดการราคาตามกลุ่มลูกค้า',
}: {
  customCount: number;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      className="pc-tier-manage-btn"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      🏷️ {label}
      {customCount > 0 ? <span className="pc-tier-manage-badge">{customCount} กลุ่ม</span> : null}
    </button>
  );
}

function parseDate(d: unknown): Date {
  if (d != null && typeof d === 'object' && 'toDate' in d && typeof (d as { toDate: unknown }).toDate === 'function') {
    return (d as { toDate: () => Date }).toDate();
  }
  if (d instanceof Date) return d;
  if (d != null && typeof d === 'object' && 'seconds' in d && typeof (d as { seconds: unknown }).seconds === 'number') {
    return new Date((d as { seconds: number }).seconds * 1000);
  }
  if (typeof d === 'string' || typeof d === 'number') {
    const parsed = new Date(d);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(0);
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="pc-tog">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <div className="pc-tog-track" />
      <div className="pc-tog-thumb" />
    </label>
  );
}

function BaseRetailPriceInput({
  value,
  onChange,
  label = 'ราคาขายหลัก (฿)',
  error,
  onClearError,
  inputRef,
}: {
  value: number;
  onChange: (val: number) => void;
  label?: string;
  error?: string;
  onClearError?: () => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="pc-field pc-base-price-field">
      <label>
        {label} <span className="req">*</span>
      </label>
      <input
        ref={inputRef}
        type="number"
        min={0}
        step={0.01}
        value={value || value === 0 ? value : ''}
        placeholder="0.00"
        aria-invalid={Boolean(error)}
        onChange={(e) => {
          const parsed = e.target.value === '' ? Number.NaN : Number(e.target.value);
          onChange(parsed);
          onClearError?.();
        }}
      />
      {error ? <p className="pc-field-error">{error}</p> : null}
    </div>
  );
}

function UomPricingCard({
  row,
  baseUnit,
  unitSelectOptions,
  customTierCount,
  priceError,
  onUpdate,
  onManageTierPrices,
  onRemove,
  onClearPriceError,
}: {
  row: ProductUomFormRow;
  baseUnit: string;
  unitSelectOptions: string[];
  customTierCount: number;
  priceError?: string;
  onUpdate: (patch: Partial<ProductUomFormRow>) => void;
  onManageTierPrices: () => void;
  onRemove?: () => void;
  onClearPriceError?: () => void;
}) {
  return (
    <div className={`pc-uom-card${row.isBase ? ' pc-uom-card-base' : ''}`}>
      <div className="pc-uom-card-top">
        <div className="pc-uom-card-top-left">
          {row.isBase ? <span className="pc-uom-card-base-badge">หน่วยฐาน</span> : null}
          <div className="pc-uom-card-title">{row.unit}</div>
          <div className="pc-uom-card-sub">
            {row.isBase ? `สต็อกเก็บเป็น ${baseUnit}` : `1 ${row.unit} = ${row.factor} ${baseUnit}`}
          </div>
        </div>
        {!row.isBase && onRemove ? (
          <button type="button" className="pc-uom-card-del" onClick={onRemove} aria-label="ลบหน่วยนับ">
            🗑️
          </button>
        ) : null}
      </div>

      <div className="pc-uom-card-grid">
        <div className="pc-field">
          <label>ชื่อหน่วย (จากระบบ)</label>
          {row.isBase ? (
            <input value={row.unit} readOnly />
          ) : (
            <select
              value={row.unit}
              onChange={(e) => onUpdate({ unit: e.target.value })}
            >
              {!row.unit ? (
                <option value="" disabled>
                  — เลือกหน่วย —
                </option>
              ) : null}
              {unitSelectOptions.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          )}
        </div>
        {!row.isBase ? (
          <div className="pc-field">
            <label>ตัวคูณสินค้านี้ (1 หน่วย = × หน่วยฐาน)</label>
            <input
              type="number"
              min={0.001}
              step={0.001}
              value={row.factor}
              onChange={(e) => onUpdate({ factor: Number(e.target.value) })}
            />
          </div>
        ) : (
          <div className="pc-field">
            <label>หน่วยฐาน</label>
            <input value={baseUnit} readOnly />
          </div>
        )}
      </div>

      <div className="pc-field">
        <label>บาร์โค้ด</label>
        <input
          value={row.barcode}
          placeholder="สแกนหรือพิมพ์บาร์โค้ด"
          onChange={(e) => onUpdate({ barcode: e.target.value })}
        />
      </div>

      <BaseRetailPriceInput
        label={`ราคาขาย (${row.unit})`}
        value={row.prices[RETAIL_PRICE_KEY] ?? 0}
        error={row.isBase ? priceError : undefined}
        onClearError={row.isBase ? onClearPriceError : undefined}
        onChange={(val) => onUpdate({ prices: { ...row.prices, [RETAIL_PRICE_KEY]: val } })}
      />

      <TierPriceManageButton customCount={customTierCount} onClick={onManageTierPrices} />
    </div>
  );
}

type Props = {
  open: boolean;
  mode: 'new' | 'edit';
  product: ProductListItem | null;
  saving: boolean;
  onClose: () => void;
  onSave: (form: ProductFormData) => Promise<void>;
  onDelete: () => void;
  onNotify?: (msg: string, type?: 'success' | 'warn') => void;
  branchId?: string | null;
  /** true = HQ/admin context: basePrice editable, overridePrice hidden.
   *  false (default) = branch context: basePrice read-only, overridePrice editable. */
  isHQContext?: boolean;
  fetchLots: (productId: string) => Promise<StockLot[]>;
  loadMovements: (productId: string) => Promise<StockMovement[]>;
};

function focusTabForErrors(
  errors: ProductFormFieldErrors,
  setTab: (tab: DrawerTab) => void,
  form: ProductFormData,
) {
  if (errors.name || errors.categoryId || errors.cost || errors.price) {
    setTab('info');
    return;
  }
  if (errors.unit) {
    setTab(form.baseUnit.trim() ? 'pricing' : 'info');
  }
}

const ERROR_FOCUS_ORDER: (keyof ProductFormFieldErrors)[] = [
  'name',
  'categoryId',
  'cost',
  'unit',
  'price',
];

export default function ProductDrawer({
  open,
  mode,
  product,
  saving,
  onClose,
  onSave,
  onDelete,
  onNotify,
  branchId,
  isHQContext = false,
  fetchLots,
  loadMovements,
}: Props) {
  const { unitNames, saving: unitsSaving, saveUnitNames } = useUomUnits();
  const { policies: expiryPolicies, defaultPolicy } = useExpiryPolicies();
  const { categories: productCategories } = useCategories();
  const { branches: allBranches } = useActiveBranches();

  const [tab, setTab] = useState<DrawerTab>('info');
  const [form, setForm] = useState<ProductFormData>(emptyForm());
  const [tierDialog, setTierDialog] = useState<TierDialogConfig | null>(null);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<ProductFormFieldErrors>({});
  const [unitMgrOpen, setUnitMgrOpen] = useState(false);
  const [fifoOpen, setFifoOpen] = useState(false);
  const [imageProcessing, setImageProcessing] = useState(false);

  const imageInputRef = useRef<HTMLInputElement>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const costRef = useRef<HTMLInputElement>(null);
  const unitRef = useRef<HTMLSelectElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);

  const fieldRefMap = useMemo(
    () =>
      ({
        name: nameRef,
        categoryId: categoryRef,
        cost: costRef,
        unit: unitRef,
        price: priceRef,
      }) as Record<keyof ProductFormFieldErrors, RefObject<HTMLElement | null>>,
    [],
  );

  useEffect(() => {
    if (!open) return;
    setTab('info');
    setConfirmOpen(false);
    setFieldErrors({});
    setUnitMgrOpen(false);
    setFifoOpen(false);
    setTierDialog(null);
    setImageProcessing(false);
    if (mode === 'edit' && product) {
      const nextForm = productToForm(product);
      const matchedCategory = productCategories.find((c) => c.name === product.category);
      setForm({ ...nextForm, categoryId: matchedCategory?.id ?? '' });
      void loadMovements(product.id).then(setMovements);
    } else {
      setForm(emptyForm());
      setMovements([]);
    }
  }, [open, mode, product, loadMovements, productCategories]);

  const displayImageUrl = form.imageUrl || null;

  const handleImageSelect = async (file: File) => {
    setImageProcessing(true);
    try {
      const dataUrl = await resizeProductImageToDataUrl(file);
      setForm((f) => ({ ...f, imageUrl: dataUrl }));
    } catch (err) {
      console.error('[ProductDrawer] image resize failed:', err);
      onNotify?.(
        err instanceof Error ? err.message : 'ประมวลผลรูปภาพไม่สำเร็จ',
        'warn',
      );
    } finally {
      setImageProcessing(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const unitOptions = useMemo(
    () => buildUnitSelectOptions(unitNames, form.baseUnit),
    [unitNames, form.baseUnit],
  );

  const defaultSubUnit = useMemo(() => {
    const used = new Set(form.uomRows.map((r) => r.unit));
    return unitNames.find((u) => u !== form.baseUnit && !used.has(u)) ?? unitNames.find((u) => u !== form.baseUnit) ?? '';
  }, [form.baseUnit, form.uomRows, unitNames]);

  const usedSubUnits = useMemo(
    () => form.uomRows.filter((r) => !r.isBase).map((r) => r.unit),
    [form.uomRows],
  );

  const uomBreakdown = useMemo(() => {
    if (!form.hasUom || !product) return null;
    return formatUomBreakdown(product.stock, form.uomRows);
  }, [form.hasUom, form.uomRows, product]);

  const set = useCallback(
    <K extends keyof ProductFormData>(key: K, val: ProductFormData[K]) => {
      setForm((f) => ({ ...f, [key]: val }));
    },
    [],
  );

  const setBaseUnit = useCallback((unit: string) => {
    setForm((f) => ({
      ...f,
      baseUnit: unit,
      uomRows: f.uomRows.map((r) => (r.isBase ? { ...r, unit } : r)),
    }));
  }, []);

  const setMainPrice = useCallback((val: number) => {
    setForm((f) => ({
      ...f,
      simplePrices: { ...f.simplePrices, [RETAIL_PRICE_KEY]: val },
      uomRows: f.uomRows.map((r) =>
        r.isBase ? { ...r, prices: { ...r.prices, [RETAIL_PRICE_KEY]: val } } : r,
      ),
    }));
  }, []);

  const openUnitManager = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setUnitMgrOpen(true);
  }, []);

  const focusFirstInvalidField = useCallback(
    (errors: ProductFormFieldErrors, currentForm: ProductFormData) => {
      focusTabForErrors(errors, setTab, currentForm);
      window.requestAnimationFrame(() => {
        for (const key of ERROR_FOCUS_ORDER) {
          if (!errors[key]) continue;
          const el = fieldRefMap[key]?.current;
          if (!el) continue;
          el.focus();
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          break;
        }
      });
    },
    [fieldRefMap],
  );

  const updateUomRow = (id: string, patch: Partial<ProductUomFormRow>) => {
    setForm((f) => ({
      ...f,
      uomRows: f.uomRows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
  };

  const addUomRow = () => {
    const id = `uom-${Date.now()}`;
    setForm((f) => ({
      ...f,
      uomRows: [
        ...f.uomRows,
        {
          id,
          unit: defaultSubUnit,
          factor: 1,
          barcode: '',
          prices: {},
          tierPrices: {},
          expanded: true,
          isBase: false,
        },
      ],
    }));
  };

  const removeUomRow = (id: string) => {
    setForm((f) => ({ ...f, uomRows: f.uomRows.filter((r) => r.id !== id || r.isBase) }));
  };

  const countCustomTierPrices = (tierPrices: Record<string, number>) =>
    Object.keys(tierPrices).filter((k) => tierPrices[k] != null && tierPrices[k] > 0).length;

  const openTierDialog = useCallback((config: TierDialogConfig) => {
    setTierDialog({
      ...config,
      initialTierPrices: { ...config.initialTierPrices },
    });
  }, []);

  const openMainTierDialog = useCallback(() => {
    openTierDialog({
      title: form.name.trim() || form.baseUnit || 'สินค้า',
      basePrice: form.simplePrices[RETAIL_PRICE_KEY] ?? 0,
      initialTierPrices: form.tierPrices,
      onSave: (next) => setForm((f) => ({ ...f, tierPrices: next })),
    });
  }, [form.baseUnit, form.name, form.simplePrices, form.tierPrices, openTierDialog]);

  const openBranchTierDialog = useCallback(() => {
    openTierDialog({
      title: form.name.trim() || form.baseUnit || 'สินค้า',
      basePrice: form.simplePrices[RETAIL_PRICE_KEY] || form.basePrice || 0,
      initialTierPrices: form.overrideTierPrices,
      onSave: (next) => setForm((f) => ({ ...f, overrideTierPrices: next })),
    });
  }, [form.baseUnit, form.name, form.simplePrices, form.basePrice, form.overrideTierPrices, openTierDialog]);

  const runValidation = useCallback(() => {
    return validateProductForm(form);
  }, [form]);

  const handleSaveClick = () => {
    const errors = runValidation();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      focusFirstInvalidField(errors, form);
      onNotify?.('กรุณากรอกข้อมูลสำคัญให้ครบถ้วน', 'warn');
      return;
    }
    setConfirmOpen(true);
  };

  const handleConfirmSave = async () => {
    const errors = runValidation();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      focusFirstInvalidField(errors, form);
      setConfirmOpen(false);
      onNotify?.('กรุณากรอกข้อมูลสำคัญให้ครบถ้วน', 'warn');
      return;
    }

    const saveForm = sanitizeProductForm(form, productCategories);
    setForm(saveForm);

    try {
      await onSave(saveForm);
      setConfirmOpen(false);
      setFieldErrors({});
    } catch (err) {
      console.error('[ProductDrawer] save failed:', err);
      const msg = err instanceof Error ? err.message : 'บันทึกสินค้าไม่สำเร็จ';
      onNotify?.(msg, 'warn');
    }
  };

  if (!open) return null;

  const activeLots = product ? product.stock : 0;
  const nextCost = product?.avgCost ?? 0;

  return createPortal(
    <>
      <div className="pc-dialog-overlay" role="dialog" aria-modal="true" onClick={onClose}>
        <div className="pc-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="pc-drawer-shell">
            <div className="pc-drawer-top">
            <span className="pc-drawer-title">{mode === 'new' ? 'เพิ่มสินค้าใหม่' : 'แก้ไขสินค้า'}</span>
            <button type="button" className="pc-drawer-close" onClick={onClose} aria-label="ปิด">
              <i className="ti ti-x" style={{ fontSize: 12 }} aria-hidden="true" />
            </button>
          </div>

          <div className="pc-drawer-tabs">
            {DRAWER_TABS.map((t) => (
              <div
                key={t.id}
                className={`pc-dtab${tab === t.id ? ' pc-on' : ''}`}
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => e.key === 'Enter' && setTab(t.id)}
                role="button"
                tabIndex={0}
              >
                {t.label}
              </div>
            ))}
          </div>

          <div className="pc-drawer-body">
            {tab === 'info' ? (
              <>
                <div className="pc-product-image-field">
                  <label className="pc-product-image-label">รูปสินค้า</label>
                  <div className="pc-product-image-row">
                    <div className="pc-product-image-preview" aria-hidden={!displayImageUrl}>
                      {imageProcessing ? (
                        <span className="pc-product-image-loading">กำลังปรับขนาด...</span>
                      ) : displayImageUrl ? (
                        <img src={displayImageUrl} alt={form.name.trim() || 'รูปสินค้า'} />
                      ) : (
                        <i className="ti ti-photo" aria-hidden="true" />
                      )}
                    </div>
                    <div className="pc-product-image-actions">
                      <button
                        type="button"
                        className="pc-product-image-btn"
                        disabled={imageProcessing || saving}
                        onClick={() => imageInputRef.current?.click()}
                      >
                        <i className="ti ti-upload" aria-hidden="true" />{' '}
                        {displayImageUrl ? 'เปลี่ยนรูป' : 'เลือกรูป'}
                      </button>
                      {displayImageUrl ? (
                        <button
                          type="button"
                          className="pc-product-image-btn pc-product-image-btn-muted"
                          disabled={imageProcessing || saving}
                          onClick={() => {
                            setForm((f) => ({ ...f, imageUrl: '' }));
                          }}
                        >
                          ลบรูป
                        </button>
                      ) : null}
                      <p className="pc-product-image-hint">
                        ปรับเป็น 400×300 px อัตโนมัติ — ไม่บังคับ
                      </p>
                    </div>
                  </div>
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    hidden
                    disabled={imageProcessing || saving}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleImageSelect(file);
                      e.target.value = '';
                    }}
                  />
                </div>

                <div className="pc-field">
                  <label>
                    ชื่อสินค้า <span className="req">*</span>
                  </label>
                  <input
                    ref={nameRef}
                    value={form.name}
                    onChange={(e) => {
                      set('name', e.target.value);
                      if (fieldErrors.name) setFieldErrors((prev) => ({ ...prev, name: undefined }));
                    }}
                    placeholder="ระบุชื่อสินค้า"
                    aria-invalid={Boolean(fieldErrors.name)}
                  />
                  {fieldErrors.name ? <p className="pc-field-error">{fieldErrors.name}</p> : null}
                </div>
                <div className="pc-fg2">
                  <div className="pc-field">
                    <label>SKU</label>
                    <input
                      value={form.sku}
                      onChange={(e) => set('sku', e.target.value)}
                      placeholder={mode === 'new' ? 'ว่างไว้เพื่อสร้างอัตโนมัติ' : ''}
                    />
                  </div>
                  <div className="pc-field">
                    <label>
                      หมวดหมู่ <span className="req">*</span>
                    </label>
                    <select
                      ref={categoryRef}
                      value={
                        form.categoryId ||
                        productCategories.find((c) => c.name === form.category)?.id ||
                        ''
                      }
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val.startsWith('legacy:')) {
                          setForm((f) => ({
                            ...f,
                            categoryId: '',
                            category: val.slice('legacy:'.length),
                          }));
                        } else {
                          const cat = productCategories.find((c) => c.id === val);
                          setForm((f) => ({
                            ...f,
                            categoryId: val,
                            category: cat?.name ?? '',
                          }));
                        }
                        if (fieldErrors.categoryId) {
                          setFieldErrors((prev) => ({ ...prev, categoryId: undefined }));
                        }
                      }}
                      aria-invalid={Boolean(fieldErrors.categoryId)}
                    >
                      <option value="" disabled>
                        ระบุหมวดหมู่
                      </option>
                      {productCategories.map((cat) => (
                        <option key={cat.id} value={cat.id}>
                          {cat.name}
                        </option>
                      ))}
                      {form.category &&
                      !productCategories.some(
                        (c) => c.id === form.categoryId || c.name === form.category,
                      ) ? (
                        <option value={`legacy:${form.category}`}>{form.category} (legacy)</option>
                      ) : null}
                    </select>
                    {fieldErrors.categoryId ? (
                      <p className="pc-field-error">{fieldErrors.categoryId}</p>
                    ) : null}
                  </div>
                </div>
                <div className="pc-field">
                  <label>บาร์โค้ด (หน่วยฐาน)</label>
                  <div className="pc-barcode-row">
                    <input value={form.barcode} onChange={(e) => set('barcode', e.target.value)} />
                    <div className="pc-scan-btn">
                      <i className="ti ti-barcode" aria-hidden="true" /> สแกน
                    </div>
                  </div>
                </div>

                <div className="pc-sec-label">ต้นทุน</div>
                <div className="pc-field">
                  <label>
                    ต้นทุน (ต่อ{form.baseUnit}) <span className="req">*</span>
                  </label>
                  <input
                    ref={costRef}
                    type="number"
                    value={form.cost || ''}
                    placeholder="0.00"
                    onChange={(e) => {
                      set('cost', Number(e.target.value));
                      if (fieldErrors.cost) {
                        setFieldErrors((prev) => ({ ...prev, cost: undefined }));
                      }
                    }}
                    aria-invalid={Boolean(fieldErrors.cost)}
                  />
                  {fieldErrors.cost ? (
                    <p className="pc-field-error">{fieldErrors.cost}</p>
                  ) : null}
                  {mode === 'edit' && product ? (
                    <p className="pc-cost-avg-hint">
                      ทุนเฉลี่ยปัจจุบัน: ฿{fmtBaht(product.avgCost)}
                    </p>
                  ) : null}
                </div>
                {mode === 'edit' && product ? (
                  <div className="pc-cost-fifo-row">
                    <div className="pc-cost-fifo-note">
                      lot ถัดไป (FIFO): <span>฿{fmtBaht(nextCost)}/{form.baseUnit}</span>
                      {activeLots > 0 ? ` · ${product.stock} ${form.baseUnit} คงเหลือ` : ''}
                    </div>
                    <button
                      type="button"
                      className="pc-view-batch-btn"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setFifoOpen(true);
                      }}
                    >
                      <i className="ti ti-stack-2" aria-hidden="true" /> ดูคิวล็อต
                    </button>
                  </div>
                ) : null}

                <div className="pc-field">
                  <label>ราคากลาง / Master Price (฿)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={form.basePrice > 0 ? form.basePrice : ''}
                    placeholder="0.00"
                    disabled={!isHQContext}
                    readOnly={!isHQContext}
                    onChange={(e) => {
                      const parsed = e.target.value === '' ? 0 : Number(e.target.value);
                      set('basePrice', parsed);
                      setMainPrice(parsed);
                    }}
                  />
                  {!isHQContext ? (
                    <p className="pc-cost-avg-hint">ราคากลาง — กำหนดโดย HQ เท่านั้น</p>
                  ) : null}
                </div>

                <div className="pc-sec-label">หน่วย & ราคาขายหลัก</div>
                <div className="pc-base-unit-row">
                  <div className="pc-field">
                    <label>
                      หน่วยนับหลัก <span className="req">*</span>
                    </label>
                    <select
                      ref={unitRef}
                      value={form.baseUnit}
                      aria-invalid={Boolean(fieldErrors.unit)}
                      onChange={(e) => {
                        setBaseUnit(e.target.value);
                        if (fieldErrors.unit) {
                          setFieldErrors((prev) => ({ ...prev, unit: undefined }));
                        }
                      }}
                    >
                      {unitOptions.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                    {fieldErrors.unit && !form.hasUom ? (
                      <p className="pc-field-error">{fieldErrors.unit}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="pc-unit-gear-btn"
                    onClick={openUnitManager}
                    title="จัดการหน่วยนับ"
                    aria-label="จัดการหน่วยนับ"
                  >
                    <i className="ti ti-settings" aria-hidden="true" />
                  </button>
                </div>

                {!isHQContext ? (
                  <BaseRetailPriceInput
                    label="ราคาของสาขา (฿)"
                    inputRef={priceRef}
                    value={form.simplePrices[RETAIL_PRICE_KEY] ?? 0}
                    error={fieldErrors.price}
                    onClearError={() => setFieldErrors((prev) => ({ ...prev, price: undefined }))}
                    onChange={setMainPrice}
                  />
                ) : null}

                {isHQContext ? (
                  <TierPriceManageButton
                    label="ราคาตามกลุ่มลูกค้า (กลาง)"
                    customCount={countCustomTierPrices(form.tierPrices)}
                    onClick={openMainTierDialog}
                  />
                ) : (
                  <TierPriceManageButton
                    label="ราคาตามกลุ่มลูกค้า (สาขานี้)"
                    customCount={countCustomTierPrices(form.overrideTierPrices)}
                    onClick={openBranchTierDialog}
                  />
                )}

                <div className="pc-tog-row">
                  <div className="pc-tog-lbl-col">
                    <span className="pc-tog-lbl">สถานะการขาย (Active/Inactive)</span>
                    <span className="pc-tog-desc">
                      สินค้าที่ปิดอยู่จะถูกซ่อนจากหน้า POS และรายงานสต็อก — เปิดกลับมาใช้งานได้ทุกเมื่อ
                    </span>
                  </div>
                  <Toggle checked={form.isActive} onChange={(v) => set('isActive', v)} />
                </div>

                <div className="pc-tog-row">
                  <div className="pc-tog-lbl-col">
                    <span className="pc-tog-lbl">ปิดการแจ้งเตือนสต็อก (Mute Alerts)</span>
                    <span className="pc-tog-desc">
                      ซ่อนสินค้านี้จากการแจ้งเตือนสต็อกต่ำ/หมด (เหมาะกับสินค้าตามฤดูกาล) — สต็อกยังนับตามปกติ
                    </span>
                  </div>
                  <Toggle checked={form.muteAlerts} onChange={(v) => set('muteAlerts', v)} />
                </div>

                <div className="pc-sec-label">สาขาที่มีจำหน่าย</div>
                <div className="pc-field">
                  {allBranches.length === 0 ? (
                    <p className="pc-cost-avg-hint">กำลังโหลดข้อมูลสาขา...</p>
                  ) : (
                    allBranches.map((b) => {
                      const isChecked =
                        form.availableBranches.length === 0 ||
                        form.availableBranches.includes(b.id);
                      return (
                        <label
                          key={b.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 7,
                            marginBottom: 5,
                            cursor: isHQContext ? 'pointer' : 'default',
                            opacity: isHQContext ? 1 : 0.7,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={!isHQContext}
                            onChange={(e) => {
                              setForm((f) => {
                                const effective =
                                  f.availableBranches.length === 0
                                    ? allBranches.map((br) => br.id)
                                    : [...f.availableBranches];
                                const next = e.target.checked
                                  ? [...new Set([...effective, b.id])]
                                  : effective.filter((id) => id !== b.id);
                                const allSelected = allBranches.every((br) =>
                                  next.includes(br.id),
                                );
                                return {
                                  ...f,
                                  availableBranches: allSelected ? [] : next,
                                };
                              });
                            }}
                          />
                          <span style={{ fontSize: 13 }}>{b.name || b.id}</span>
                        </label>
                      );
                    })
                  )}
                  <p className="pc-cost-avg-hint" style={{ marginTop: 4 }}>
                    {form.availableBranches.length === 0
                      ? 'ว่างไว้ = มีจำหน่ายทุกสาขา'
                      : `เลือก ${form.availableBranches.length} สาขา`}
                    {isHQContext && form.availableBranches.length > 0 ? (
                      <>
                        {' — '}
                        <button
                          type="button"
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            textDecoration: 'underline',
                            color: 'inherit',
                            fontSize: 'inherit',
                            padding: 0,
                          }}
                          onClick={() => set('availableBranches', [])}
                        >
                          ล้าง (= ทุกสาขา)
                        </button>
                      </>
                    ) : null}
                  </p>
                  {!isHQContext ? (
                    <p className="pc-cost-avg-hint">กำหนดโดย HQ เท่านั้น</p>
                  ) : null}
                </div>
              </>
            ) : null}

            {tab === 'pricing' ? (
              <>
                <div className="pc-tog-row">
                  <span className="pc-tog-lbl">
                    <i className="ti ti-layers-intersect" aria-hidden="true" /> มีหลายหน่วยนับ (UOM)
                  </span>
                  <Toggle
                    checked={form.hasUom}
                    onChange={(v) => {
                      setForm((f) => {
                        let uomRows = f.uomRows.map((r) =>
                          r.isBase
                            ? {
                                ...r,
                                unit: f.baseUnit,
                                prices: {
                                  ...r.prices,
                                  [RETAIL_PRICE_KEY]: f.simplePrices[RETAIL_PRICE_KEY] ?? 0,
                                },
                              }
                            : r,
                        );
                        if (v && uomRows.length <= 1) {
                          uomRows = [
                            ...uomRows,
                            {
                              id: `uom-${Date.now()}`,
                              unit: defaultSubUnit,
                              factor: 12,
                              barcode: '',
                              prices: {},
                              tierPrices: {},
                              expanded: true,
                              isBase: false,
                            },
                          ];
                        }
                        return { ...f, hasUom: v, uomRows };
                      });
                    }}
                  />
                </div>

                {!form.hasUom ? (
                  <div className="pc-drawer-hint">
                    สินค้ามาตรฐานกรอกข้อมูลในแท็บ &quot;ข้อมูลสินค้า&quot; ได้ครบแล้ว — เปิดใช้หลายหน่วยนับด้านบนหากต้องการหน่วยย่อยและราคาเพิ่มเติม
                  </div>
                ) : (
                  <>
                    <div className="pc-sec-label">หน่วยย่อย &amp; ตัวคูณ (เฉพาะสินค้านี้)</div>
                    <div className="pc-drawer-hint">
                      หน่วยฐาน: <strong>{form.baseUnit}</strong> — สต็อกเก็บเป็นหน่วยนี้เสมอ
                      <br />
                      เลือกชื่อหน่วยจากรายการระบบ แล้วกำหนดตัวคูณแปลงเป็นหน่วยฐาน (เช่น 1 กล่อง = 24 {form.baseUnit})
                    </div>

                    <div className="pc-uom-card-list">
                      {form.uomRows
                        .filter((row) => !row.isBase)
                        .map((row) => (
                          <UomPricingCard
                            key={row.id}
                            row={row}
                            baseUnit={form.baseUnit}
                            unitSelectOptions={buildSubUnitSelectOptions(
                              unitNames,
                              form.baseUnit,
                              usedSubUnits,
                              row.unit,
                            )}
                            customTierCount={countCustomTierPrices(row.tierPrices)}
                            onUpdate={(patch) => {
                              updateUomRow(row.id, patch);
                              if (fieldErrors.unit) {
                                setFieldErrors((prev) => ({ ...prev, unit: undefined }));
                              }
                            }}
                            onManageTierPrices={() =>
                              openTierDialog({
                                title: `${form.name.trim() || 'สินค้า'} — ${row.unit}`,
                                basePrice: row.prices[RETAIL_PRICE_KEY] ?? 0,
                                initialTierPrices: row.tierPrices,
                                onSave: (next) => updateUomRow(row.id, { tierPrices: next }),
                              })
                            }
                            onRemove={() => removeUomRow(row.id)}
                          />
                        ))}
                    </div>

                    <button type="button" className="pc-add-uom-card-btn" onClick={addUomRow}>
                      <i className="ti ti-plus" aria-hidden="true" /> เพิ่มหน่วยย่อย
                    </button>

                    {fieldErrors.unit && form.hasUom ? (
                      <p className="pc-field-error">{fieldErrors.unit}</p>
                    ) : null}
                  </>
                )}
              </>
            ) : null}

            {tab === 'stock' ? (
            <>
              {product ? (
                <>
              <div className="pc-stock-summary">
                <div className="pc-st-card">
                  <div className="pc-st-val" style={{ color: 'var(--p600, #534ab7)' }}>
                    {product.stock}
                  </div>
                  <div className="pc-st-lbl">สต็อก สาขานี้ ({form.baseUnit})</div>
                  {form.hasUom && uomBreakdown ? (
                    <div className="pc-stock-uom-equiv">เทียบเท่ากับ: {uomBreakdown}</div>
                  ) : null}
                </div>
                <div className="pc-st-card">
                  <div className="pc-st-val" style={{ color: 'var(--amber, #ba7517)' }}>
                    {form.reorderPoint}
                  </div>
                  <div className="pc-st-lbl">แจ้งเตือนเมื่อต่ำกว่า</div>
                </div>
                <div className="pc-st-card">
                  <div className="pc-st-val" style={{ color: 'var(--green, #1d9e75)' }}>
                    ฿{fmtBaht(product.avgCost * product.stock)}
                  </div>
                  <div className="pc-st-lbl">มูลค่าสต็อก</div>
                </div>
              </div>
                </>
              ) : null}

              <div className="pc-field">
                <label>นโยบายวันหมดอายุ</label>
                <select
                  value={form.expiryPolicyId}
                  onChange={(e) => set('expiryPolicyId', e.target.value)}
                >
                  <option value="">
                    ใช้ค่าเริ่มต้น ({defaultPolicy?.name ?? 'มาตรฐาน'})
                  </option>
                  {expiryPolicies.map((pol) => (
                    <option key={pol.id} value={pol.id}>
                      {pol.name}
                      {pol.isDefault ? ' (ค่าเริ่มต้น)' : ''}
                      {' — เฝ้าระวัง '}
                      {pol.warningDays} วัน / วิกฤต {pol.criticalDays} วัน
                    </option>
                  ))}
                </select>
                <span className="pc-tog-desc" style={{ display: 'block', marginTop: 4 }}>
                  ใช้คำนวณสถานะ Lot ใน FIFO Queue ของสต็อกรายงาน
                </span>
              </div>

              <div className="pc-tog-row">
                <div className="pc-tog-lbl-col">
                  <span className="pc-tog-lbl">อนุญาตให้สต็อกติดลบได้ (Allow Overselling)</span>
                  <span className="pc-tog-desc">ยอมให้ขายสินค้าหน้าร้านได้แม้สต็อกในระบบจะหมดแล้ว</span>
                </div>
                <Toggle
                  checked={form.allowNegativeStock}
                  onChange={(v) => set('allowNegativeStock', v)}
                />
              </div>

              {product ? (
                <>
              <div className="pc-sec-label">ปรับสต็อก (สาขานี้เท่านั้น)</div>
              <div className="pc-fg2">
                <div className="pc-field">
                  <label>ประเภท</label>
                  <select defaultValue="in">
                    <option value="in">รับเข้า (+)</option>
                    <option value="out">ตัดออก (-)</option>
                    <option value="set">ปรับยอด (=)</option>
                  </select>
                </div>
                <div className="pc-field">
                  <label>จำนวน (หน่วยฐาน)</label>
                  <input type="number" placeholder="0" />
                </div>
              </div>
              <div className="pc-field">
                <label>หมายเหตุ</label>
                <input placeholder="เหตุผล..." />
              </div>
              <div className="pc-field">
                <label>แจ้งเตือนเมื่อต่ำกว่า</label>
                <input type="number" value={form.reorderPoint} onChange={(e) => set('reorderPoint', Number(e.target.value))} />
              </div>
                </>
              ) : null}
            </>
          ) : null}

          {tab === 'history' ? (
            product ? (
              <>
                <div className="pc-drawer-hint">ประวัติเคลื่อนไหวสต็อก — สาขานี้</div>
                <table className="pc-hist-table">
                  <thead>
                    <tr>
                      <th>วันที่</th>
                      <th>ประเภท</th>
                      <th>จำนวน</th>
                      <th>คงเหลือ</th>
                      <th>โดย</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movements.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="pc-table-empty">
                          ยังไม่มีประวัติ
                        </td>
                      </tr>
                    ) : (
                      movements.map((m) => (
                        <tr key={m.id}>
                          <td>
                            {parseDate(m.createdAt).toLocaleDateString('th-TH', {
                              day: '2-digit',
                              month: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </td>
                          <td>{movementLabel(m.type)}</td>
                          <td className={m.qty > 0 ? 'pc-h-in' : 'pc-h-out'}>
                            {m.qty > 0 ? '+' : ''}
                            {m.qty}
                          </td>
                          <td style={{ fontFamily: 'Prompt, sans-serif' }}>—</td>
                          <td>{m.createdBy}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </>
            ) : (
              <div className="pc-drawer-hint">บันทึกสินค้าเพื่อดูประวัติการเคลื่อนไหวสต็อก</div>
            )
          ) : null}
          </div>

          <div className="pc-drawer-footer">
            {mode === 'edit' ? (
              <button type="button" className="pc-df-btn pc-df-del" onClick={onDelete} disabled={saving}>
                <i className="ti ti-trash" style={{ fontSize: 13, verticalAlign: -2 }} aria-hidden="true" /> ลบ
              </button>
            ) : (
              <span aria-hidden="true" />
            )}
            <div className="pc-drawer-footer-actions">
              <button type="button" className="pc-df-btn pc-df-cancel" onClick={onClose}>
                ยกเลิก
              </button>
              <button
                type="button"
                className="pc-df-btn pc-df-save"
                disabled={saving}
                onClick={handleSaveClick}
              >
                {saving ? 'กำลังบันทึก...' : 'บันทึก'}
              </button>
            </div>
          </div>
        </div>
        </div>
      </div>

      {tierDialog ? (
        <TierPriceManagerDialog
          isOpen
          title={tierDialog.title}
          basePrice={tierDialog.basePrice}
          initialTierPrices={tierDialog.initialTierPrices}
          onSave={tierDialog.onSave}
          onClose={() => setTierDialog(null)}
        />
      ) : null}

      <ProductSaveConfirmDialog
        open={confirmOpen}
        productName={form.name.trim()}
        saving={saving}
        onConfirm={() => void handleConfirmSave()}
        onCancel={() => setConfirmOpen(false)}
      />

      <UnitManagerModal
        open={unitMgrOpen}
        units={unitNames}
        saving={unitsSaving}
        onSave={saveUnitNames}
        onClose={() => setUnitMgrOpen(false)}
      />

      {product ? (
        <FifoQueueModal
          open={fifoOpen}
          stack
          productName={product.name}
          productId={product.id}
          branchId={branchId}
          fetchLots={fetchLots}
          onClose={() => setFifoOpen(false)}
        />
      ) : null}
    </>,
    document.body,
  );
}
