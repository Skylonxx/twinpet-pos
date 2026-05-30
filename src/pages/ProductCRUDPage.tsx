import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ProductImageThumb from '../components/products/ProductImageThumb';
import ProductDrawer from '../components/products/ProductDrawer';
import CategoryManagementModal from '../components/products/CategoryManagementModal';
import ProductPickerDialog from '../components/products/ProductPickerDialog';
import { useAuth } from '../lib/hooks/useAuth';
import {
  CATEGORY_STYLE,
  filterProducts,
  fmtBaht,
  stockStatus,
  type ProductFormData,
  type ProductListItem,
  type StockFilter,
} from '../lib/productCrud/types';
import { getBranchLabel } from '../lib/branches';
import { resolveCategoryName, useCategories } from '../lib/inventory/categoryService';
import { useProductCrud } from '../lib/productCrud/useProductCrud';
import './ProductCRUDPage.css';

type SortKey = 'sku' | 'name' | 'category' | 'retailPrice' | 'avgCost' | 'stock';

const TABLE_COLUMNS: { key: SortKey | 'uom' | 'basePrice'; label: string; align?: 'r'; sortable?: boolean }[] = [
  { key: 'sku', label: 'รหัส (SKU)' },
  { key: 'name', label: 'สินค้า' },
  { key: 'category', label: 'หมวดหมู่' },
  { key: 'basePrice', label: 'ราคากลาง', align: 'r', sortable: false },
  { key: 'retailPrice', label: 'ราคาของสาขา', align: 'r' },
  { key: 'avgCost', label: 'ต้นทุนเฉลี่ย', align: 'r' },
  { key: 'uom', label: 'หน่วย (UOM)', sortable: false },
  { key: 'stock', label: 'สต็อก (สาขานี้)', align: 'r' },
];

function sortProducts(
  items: ProductListItem[],
  sortConfig: { key: string; direction: 'asc' | 'desc' } | null,
) {
  if (!sortConfig) return items;

  const mult = sortConfig.direction === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    let av: string | number = '';
    let bv: string | number = '';
    switch (sortConfig.key as SortKey) {
      case 'sku':
        av = a.sku.toLowerCase();
        bv = b.sku.toLowerCase();
        break;
      case 'name':
        av = a.name.toLowerCase();
        bv = b.name.toLowerCase();
        break;
      case 'category':
        av = a.category;
        bv = b.category;
        break;
      case 'retailPrice':
        av = a.retailPrice;
        bv = b.retailPrice;
        break;
      case 'avgCost':
        av = a.avgCost;
        bv = b.avgCost;
        break;
      case 'stock':
        av = a.stock;
        bv = b.stock;
        break;
      default:
        return 0;
    }
    if (av < bv) return -1 * mult;
    if (av > bv) return 1 * mult;
    return 0;
  });
}

function ProductStockBadge({ stock, minStock }: { stock: number; minStock: number }) {
  const { lbl } = stockStatus(stock, minStock);
  const cls =
    stock === 0 ? 'pc-badge-oos' : stock <= minStock ? 'pc-badge-low' : 'pc-badge-ok';
  return <span className={`pc-badge ${cls}`}>{lbl}</span>;
}

export default function ProductCRUDPage() {
  const { branchId } = useAuth();
  const { categories } = useCategories();
  const { products, loading, saving, saveProduct, softDelete, fetchLots, fetchMovements, reload } =
    useProductCrud(branchId);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [stockFilter, setStockFilter] = useState<StockFilter>('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerMode, setDrawerMode] = useState<'new' | 'edit' | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showPicker, setShowPicker] = useState(false);
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'warn' } | null>(null);
  const bcBuf = useRef('');
  const bcTimer = useRef<number | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () => filterProducts(products, search, category, stockFilter, categories),
    [products, search, category, stockFilter, categories],
  );

  const sorted = useMemo(
    () => sortProducts(filtered, sortConfig),
    [filtered, sortConfig],
  );

  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  const pageItems = useMemo(() => {
    const start = (page - 1) * perPage;
    return sorted.slice(start, start + perPage);
  }, [sorted, page, perPage]);

  const pageIds = useMemo(() => pageItems.map((p) => p.id), [pageItems]);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const somePageSelected = pageIds.some((id) => selectedIds.has(id));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = somePageSelected && !allPageSelected;
    }
  }, [somePageSelected, allPageSelected]);

  useEffect(() => {
    setPage(1);
  }, [search, category, stockFilter, perPage, sortConfig]);

  const handleSort = (key: SortKey) => {
    setSortConfig((prev) => {
      if (prev?.key === key) {
        return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { key, direction: 'asc' };
    });
  };

  const sortIcon = (key: SortKey) => {
    if (sortConfig?.key !== key) return 'ti-arrows-sort';
    return sortConfig.direction === 'asc' ? 'ti-arrow-up' : 'ti-arrow-down';
  };

  const togglePageSelect = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        pageIds.forEach((id) => next.delete(id));
      } else {
        pageIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const toggleRowSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedProduct = useMemo(
    () => (selectedId ? products.find((p) => p.id === selectedId) ?? null : null),
    [products, selectedId],
  );

  const openDrawer = useCallback((mode: 'new' | 'edit', id?: string) => {
    setDrawerMode(mode);
    if (id) setSelectedId(id);
    else setSelectedId(null);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerMode(null);
    setSelectedId(null);
  }, []);

  const handleSave = async (form: ProductFormData) => {
    try {
      await saveProduct(form, drawerMode === 'edit' ? selectedId ?? undefined : undefined);
      closeDrawer();
      void reload();
      showToast('บันทึกสินค้าเรียบร้อย');
    } catch (err) {
      console.error('[ProductCRUDPage] handleSave failed:', err);
      const msg = err instanceof Error ? err.message : 'บันทึกสินค้าไม่สำเร็จ';
      showToast(msg, 'warn');
      throw err;
    }
  };

  const handleDelete = async () => {
    if (!selectedId || !window.confirm('ยืนยันการลบสินค้านี้?')) return;
    await softDelete(selectedId);
    closeDrawer();
  };

  const clearSelection = () => setSelectedIds(new Set());

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!window.confirm('ยืนยันการลบสินค้าที่เลือกหรือไม่?')) return;

    const ids = [...selectedIds];
    for (const id of ids) {
      await softDelete(id);
    }

    setSelectedIds(new Set());
    if (selectedId && ids.includes(selectedId)) closeDrawer();
    void reload();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (drawerMode || showPicker) return;
      if (e.key === 'Enter' && bcBuf.current.length > 4) {
        const bc = bcBuf.current.trim();
        bcBuf.current = '';
        const p = products.find(
          (x) =>
            x.barcode === bc ||
            x.uomConversions.some((uom) => uom.barcode === bc),
        );
        if (p) {
          setFlashId(p.id);
          window.setTimeout(() => setFlashId(null), 700);
          openDrawer('edit', p.id);
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
  }, [products, drawerMode, showPicker, openDrawer]);

  const branchDisplay = branchId ? getBranchLabel(branchId) : '—';
  const rangeStart = sorted.length === 0 ? 0 : (page - 1) * perPage + 1;
  const rangeEnd = Math.min(page * perPage, sorted.length);

  const showToast = (msg: string, type: 'success' | 'warn' = 'success') => {
    setToast({ msg, type });
    window.setTimeout(() => setToast(null), 2800);
  };

  return (
    <div className="pc-page">
      <header className="pc-topbar">
        <div className="pc-topbar-icon">
          <i className="ti ti-box" aria-hidden="true" />
        </div>
        <div className="pc-topbar-center">
          <div className="pc-topbar-title">จัดการสินค้า</div>
          <div className="pc-topbar-sub">Product Management</div>
        </div>
        <span className="pc-branch-badge">
          <i className="ti ti-map-pin" style={{ fontSize: 12 }} aria-hidden="true" />
          สาขา: {branchDisplay}
        </span>
        <button type="button" className="pc-btn pc-btn-ghost pc-btn-sm" title="Import">
          <i className="ti ti-upload" aria-hidden="true" /> Import
        </button>
        <button type="button" className="pc-btn pc-btn-ghost pc-btn-sm" title="Export">
          <i className="ti ti-download" aria-hidden="true" /> Export
        </button>
        <button
          type="button"
          className="pc-btn pc-btn-ghost pc-btn-sm"
          onClick={() => setCategoryModalOpen(true)}
        >
          <i className="ti ti-category" aria-hidden="true" /> จัดการหมวดหมู่
        </button>
        <button type="button" className="pc-btn pc-btn-primary" onClick={() => openDrawer('new')}>
          <i className="ti ti-plus" aria-hidden="true" /> เพิ่มสินค้า
        </button>
      </header>

      <div className="pc-content">
        <div className="pc-toolbar">
          <select
            className="pc-sel"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="หมวดหมู่"
          >
            <option value="">ทุกหมวด</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </select>
          <div className="pc-search-wrap">
            <i className="ti ti-search" aria-hidden="true" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหาชื่อ, SKU, บาร์โค้ด..."
            />
          </div>
          <button type="button" className="pc-btn pc-btn-ghost pc-btn-sm" onClick={() => setShowPicker(true)}>
            <i className="ti ti-list-search" aria-hidden="true" /> เลือกสินค้า
          </button>
          <div className="pc-stock-filter">
            {([
              ['', 'ทั้งหมด'],
              ['low', 'ใกล้หมด'],
              ['out', 'หมด'],
            ] as const).map(([val, lbl]) => (
              <button
                key={val || 'all'}
                type="button"
                className={`pc-sf${stockFilter === val ? ' pc-on' : ''}`}
                onClick={() => setStockFilter(val)}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div className="pc-card">
          <div className="pc-table-scroll">
            <table className="pc-table">
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      style={{ width: 11, height: 11 }}
                      checked={allPageSelected}
                      onChange={togglePageSelect}
                      aria-label="เลือกทั้งหมดในหน้านี้"
                    />
                  </th>
                  {TABLE_COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      className={`pc-sort-th${col.align === 'r' ? ' num' : ''}${col.sortable === false ? ' pc-sort-th-static' : ''}${sortConfig?.key === col.key ? ' pc-sort-active' : ''}`}
                      onClick={col.sortable === false ? undefined : () => handleSort(col.key as SortKey)}
                      onKeyDown={
                        col.sortable === false
                          ? undefined
                          : (e) => e.key === 'Enter' && handleSort(col.key as SortKey)
                      }
                      role={col.sortable === false ? undefined : 'button'}
                      tabIndex={col.sortable === false ? undefined : 0}
                    >
                      {col.label}
                      {col.sortable === false ? null : (
                        <i className={`ti ${sortIcon(col.key as SortKey)} pc-sort-icon`} aria-hidden="true" />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={8} className="pc-table-empty">
                      กำลังโหลด...
                    </td>
                  </tr>
                ) : pageItems.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="pc-table-empty">
                      ไม่พบสินค้า
                    </td>
                  </tr>
                ) : (
                  pageItems.map((p) => {
                    const categoryLabel = resolveCategoryName(p.category, categories);
                    const catStyle = CATEGORY_STYLE[p.category] ?? CATEGORY_STYLE[categoryLabel] ?? { background: 'var(--g100)', color: 'var(--g600)' };
                    return (
                      <tr
                        key={p.id}
                        id={`row-${p.id}`}
                        className={`${selectedId === p.id ? 'pc-selected' : ''}${selectedIds.has(p.id) ? ' pc-row-checked' : ''}${flashId === p.id ? ' pc-flash' : ''}`}
                        onClick={() => openDrawer('edit', p.id)}
                      >
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            style={{ width: 11, height: 11 }}
                            checked={selectedIds.has(p.id)}
                            onChange={() => toggleRowSelect(p.id)}
                            aria-label={`เลือก ${p.name}`}
                          />
                        </td>
                        <td>
                          <span className="pc-col-sku">{p.sku}</span>
                        </td>
                        <td>
                          <div className="pc-prod-cell">
                            <ProductImageThumb imageUrl={p.imageUrl} alt={p.name} />
                            <div className="pc-prod-name">{p.name}</div>
                          </div>
                        </td>
                        <td>
                          <span className="pc-cat-badge" style={catStyle}>
                            {categoryLabel}
                          </span>
                        </td>
                        <td className="num pc-col-price">
                          ฿{fmtBaht(p.basePrice ?? 0)}
                        </td>
                        <td className="num pc-col-price">
                          ฿{fmtBaht(p.retailPrice)}
                        </td>
                        <td className="num pc-col-cost">
                          ฿{fmtBaht(p.avgCost)}
                        </td>
                        <td>
                          <div className="pc-col-uom">
                            <div className="pc-uom-base">
                              {p.baseUnit}
                              {p.barcode ? (
                                <span className="pc-uom-barcode-inline">({p.barcode})</span>
                              ) : null}
                            </div>
                            {p.uomConversions.map((u) => (
                              <div key={u.unit} className="pc-uom-sub">
                                ↳ {u.unit} (x{u.factor})
                                {u.barcode ? (
                                  <span className="pc-uom-barcode-tag">🏷️ {u.barcode}</span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </td>
                        <td className="num pc-col-stock">
                          <ProductStockBadge stock={p.stock} minStock={p.branchReorderPoint} />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="pc-bottom-bar">
            <div className="pc-bottom-left">
              <span className="pc-bottom-info">
                แสดง {rangeStart}–{rangeEnd} จาก {sorted.length} รายการ
              </span>
              <div className="pc-per-page-wrap">
                แสดง
                <select className="pc-per-page-sel" value={perPage} onChange={(e) => setPerPage(Number(e.target.value))}>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                </select>
                รายการ/หน้า
              </div>
            </div>
            <div className="pc-pagination">
              <button type="button" className="pc-pg" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <i className="ti ti-chevron-left" style={{ fontSize: 11 }} aria-hidden="true" />
              </button>
              {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                const pg = i + 1;
                return (
                  <button key={pg} type="button" className={`pc-pg${page === pg ? ' pc-on' : ''}`} onClick={() => setPage(pg)}>
                    {pg}
                  </button>
                );
              })}
              <button type="button" className="pc-pg" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                <i className="ti ti-chevron-right" style={{ fontSize: 11 }} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <ProductDrawer
        open={drawerMode !== null}
        mode={drawerMode === 'new' ? 'new' : 'edit'}
        product={drawerMode === 'edit' ? selectedProduct : null}
        saving={saving}
        onClose={closeDrawer}
        onSave={handleSave}
        onNotify={showToast}
        branchId={branchId}
        isHQContext={false}
        onDelete={() => void handleDelete()}
        fetchLots={fetchLots}
        loadMovements={fetchMovements}
      />

      <ProductPickerDialog
        open={showPicker}
        branchId={branchId}
        onConfirm={(items) => {
          setSelectedIds((prev) => {
            const next = new Set(prev);
            items.forEach((item) => next.add(item.id));
            return next;
          });
          setShowPicker(false);
        }}
        onClose={() => setShowPicker(false)}
      />

      {selectedIds.size > 0 ? (
        <div className="pc-bulk-toolbar" role="toolbar" aria-label="การดำเนินการแบบกลุ่ม">
          <span className="pc-bulk-count">เลือกแล้ว {selectedIds.size} รายการ</span>
          <div className="pc-bulk-divider" aria-hidden="true" />
          <div className="pc-bulk-actions">
            <button
              type="button"
              className="pc-bulk-btn"
              disabled={saving}
              onClick={() => alert('กำลังพัฒนา: ระบบพิมพ์บาร์โค้ด')}
            >
              <i className="ti ti-barcode" aria-hidden="true" /> พิมพ์บาร์โค้ด
            </button>
            <button
              type="button"
              className="pc-bulk-btn"
              disabled={saving}
              onClick={() => alert('กำลังพัฒนา: เปลี่ยนหมวดหมู่แบบกลุ่ม')}
            >
              <i className="ti ti-tags" aria-hidden="true" /> เปลี่ยนหมวดหมู่
            </button>
            <button
              type="button"
              className="pc-bulk-btn"
              disabled={saving}
              onClick={() => alert('ส่งออก Excel (รอโครงสร้างข้อมูลนิ่งก่อน)')}
            >
              <i className="ti ti-file-spreadsheet" aria-hidden="true" /> ส่งออก Excel
            </button>
            <button
              type="button"
              className="pc-bulk-btn pc-bulk-btn-danger"
              disabled={saving}
              onClick={() => void handleBulkDelete()}
            >
              <i className="ti ti-trash" aria-hidden="true" /> {saving ? 'กำลังลบ...' : 'ลบสินค้า'}
            </button>
            <button
              type="button"
              className="pc-bulk-btn pc-bulk-btn-cancel"
              disabled={saving}
              onClick={clearSelection}
            >
              <i className="ti ti-x" aria-hidden="true" /> ยกเลิก
            </button>
          </div>
        </div>
      ) : null}

      <CategoryManagementModal
        open={categoryModalOpen}
        onClose={() => setCategoryModalOpen(false)}
        onToast={showToast}
      />

      {toast ? (
        <div className="pc-toast-wrap">
          <div className={`pc-toast pc-toast-${toast.type}`}>{toast.msg}</div>
        </div>
      ) : null}
    </div>
  );
}
