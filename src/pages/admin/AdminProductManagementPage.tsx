import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../../lib/firebase';
import {
  CATEGORY_STYLE,
  fmtBaht,
  getRetailPrice,
  type ProductFormData,
  type ProductListItem,
} from '../../lib/productCrud/types';
import { useProductCrud } from '../../lib/productCrud/useProductCrud';
import { useAuth } from '../../lib/hooks/useAuth';
import {
  matchesCategoryFilter,
  resolveCategoryName,
  useCategories,
} from '../../lib/inventory/categoryService';
import ProductDrawer from '../../components/products/ProductDrawer';
import ProductPickerDialog, { productListItemToPickerItem } from '../../components/products/ProductPickerDialog';
import CategoryManagementModal from '../../components/products/CategoryManagementModal';
import ProductImageThumb from '../../components/products/ProductImageThumb';
import type { Product } from '../../lib/types';
import '../ProductCRUDPage.css';
import './AdminProductManagementPage.css';

// ── Types ──────────────────────────────────────────────────────────────────

type AdminSortKey = 'sku' | 'name' | 'category' | 'retailPrice' | 'cost';

const TABLE_COLUMNS: {
  key: AdminSortKey | 'uom' | 'status' | 'basePrice';
  label: string;
  align?: 'r';
  sortable?: boolean;
}[] = [
  { key: 'sku', label: 'รหัส (SKU)' },
  { key: 'name', label: 'สินค้า' },
  { key: 'category', label: 'หมวดหมู่' },
  { key: 'basePrice', label: 'ราคากลาง', align: 'r', sortable: false },
  { key: 'retailPrice', label: 'ราคาขาย', align: 'r' },
  { key: 'cost', label: 'ต้นทุน', align: 'r' },
  { key: 'uom', label: 'หน่วย (UOM)', sortable: false },
  { key: 'status', label: 'สถานะ', sortable: false },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function toListItem(p: Product): ProductListItem {
  return {
    ...p,
    stock: 0,
    branchReorderPoint: p.reorderPoint,
    emoji: '📦',
    retailPrice: getRetailPrice(p),
  };
}

function sortAdminProducts(
  items: Product[],
  sortConfig: { key: string; direction: 'asc' | 'desc' } | null,
): Product[] {
  if (!sortConfig) return items;
  const mult = sortConfig.direction === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    let av: string | number = '';
    let bv: string | number = '';
    switch (sortConfig.key as AdminSortKey) {
      case 'sku':
        av = (a.sku ?? '').toLowerCase();
        bv = (b.sku ?? '').toLowerCase();
        break;
      case 'name':
        av = a.name.toLowerCase();
        bv = b.name.toLowerCase();
        break;
      case 'category':
        av = a.category.toLowerCase();
        bv = b.category.toLowerCase();
        break;
      case 'retailPrice':
        av = getRetailPrice(a);
        bv = getRetailPrice(b);
        break;
      case 'cost':
        av = a.cost ?? 0;
        bv = b.cost ?? 0;
        break;
      default:
        return 0;
    }
    if (av < bv) return -1 * mult;
    if (av > bv) return 1 * mult;
    return 0;
  });
}

async function fetchAllProducts(): Promise<Product[]> {
  if (!db || !isFirebaseConfigured) return [];
  const snap = await getDocs(
    query(
      collection(db, collections.products),
      where('deletedAt', '==', null),
      orderBy('name'),
    ),
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Product));
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function AdminProductManagementPage() {
  const { branchId } = useAuth();
  const { saveProduct, softDelete, fetchLots, fetchMovements, saving } = useProductCrud(branchId);
  const { categories } = useCategories();

  // Admin table state
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'inactive'>('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(
    null,
  );
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  // Drawer / modal state
  const [drawerMode, setDrawerMode] = useState<'new' | 'edit' | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'warn' } | null>(null);

  // Batch-selection state (mirrors POS ProductCRUDPage)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showPicker, setShowPicker] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  // ── Data loading ───────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAllProducts();
      setProducts(data);
      setLastFetched(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'โหลดข้อมูลไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(id);
  }, [toast]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [search, category, statusFilter, perPage, sortConfig]);

  const showToast = useCallback((msg: string, type: 'success' | 'warn' = 'success') => {
    setToast({ msg, type });
  }, []);

  // ── Filtering + sorting + pagination ──────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      const matchQ =
        !q ||
        p.name.toLowerCase().includes(q) ||
        (p.sku ?? '').toLowerCase().includes(q) ||
        (p.barcode ?? '').toLowerCase().includes(q) ||
        p.uomConversions.some((u) => u.barcode?.toLowerCase().includes(q));
      const matchCat = matchesCategoryFilter(p.category, category, categories);
      const matchStatus =
        !statusFilter || (statusFilter === 'active' ? p.isActive : !p.isActive);
      return matchQ && matchCat && matchStatus;
    });
  }, [products, search, category, statusFilter, categories]);

  const sorted = useMemo(() => sortAdminProducts(filtered, sortConfig), [filtered, sortConfig]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  const pageItems = useMemo(() => {
    const start = (page - 1) * perPage;
    return sorted.slice(start, start + perPage);
  }, [sorted, page, perPage]);

  const rangeStart = sorted.length === 0 ? 0 : (page - 1) * perPage + 1;
  const rangeEnd = Math.min(page * perPage, sorted.length);

  // Batch-selection derived values
  const pageIds = useMemo(() => pageItems.map((p) => p.id), [pageItems]);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const somePageSelected = pageIds.some((id) => selectedIds.has(id));

  // Products pre-converted for the picker dialog (avoids double-fetch)
  const pickerProducts = useMemo(
    () => products.filter((p) => p.isActive && !p.deletedAt).map(toListItem).map(productListItemToPickerItem),
    [products],
  );

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = somePageSelected && !allPageSelected;
    }
  }, [somePageSelected, allPageSelected]);

  const handleSort = (key: AdminSortKey) => {
    setSortConfig((prev) => {
      if (prev?.key === key) return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      return { key, direction: 'asc' };
    });
  };

  const sortIcon = (key: string) => {
    if (sortConfig?.key !== key) return 'ti-arrows-sort';
    return sortConfig.direction === 'asc' ? 'ti-arrow-up' : 'ti-arrow-down';
  };

  // ── Drawer handlers ────────────────────────────────────────────────────

  const openAdd = useCallback(() => {
    setDrawerMode('new');
    setSelectedId(null);
  }, []);

  const openEdit = useCallback((id: string) => {
    setDrawerMode('edit');
    setSelectedId(id);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerMode(null);
    setSelectedId(null);
  }, []);

  const selectedProduct = useMemo((): ProductListItem | null => {
    if (!selectedId) return null;
    const p = products.find((x) => x.id === selectedId);
    return p ? toListItem(p) : null;
  }, [products, selectedId]);

  const handleSave = useCallback(
    async (form: ProductFormData) => {
      try {
        await saveProduct(form, drawerMode === 'edit' ? (selectedId ?? undefined) : undefined);
        closeDrawer();
        void load();
        showToast('บันทึกสินค้าเรียบร้อย', 'success');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'บันทึกสินค้าไม่สำเร็จ';
        showToast(msg, 'warn');
        throw err;
      }
    },
    [saveProduct, drawerMode, selectedId, closeDrawer, load, showToast],
  );

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    await softDelete(selectedId);
    closeDrawer();
    void load();
    showToast('ลบสินค้าเรียบร้อย', 'success');
  }, [softDelete, selectedId, closeDrawer, load, showToast]);

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

  const clearSelection = () => setSelectedIds(new Set());

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`ยืนยันการลบสินค้า ${selectedIds.size} รายการหรือไม่?`)) return;
    const ids = [...selectedIds];
    for (const id of ids) {
      await softDelete(id);
    }
    setSelectedIds(new Set());
    if (selectedId && ids.includes(selectedId)) closeDrawer();
    void load();
    showToast(`ลบสินค้า ${ids.length} รายการเรียบร้อย`, 'success');
  }, [selectedIds, softDelete, selectedId, closeDrawer, load, showToast]);

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="pc-page">
      {/* ── Topbar (mirrors POS topbar exactly) ── */}
      <header className="pc-topbar">
        <div className="pc-topbar-icon">
          <i className="ti ti-box" aria-hidden="true" />
        </div>
        <div className="pc-topbar-center">
          <div className="pc-topbar-title">จัดการสินค้า (HQ)</div>
          <div className="pc-topbar-sub">Product Master Data — ข้อมูลกลาง</div>
        </div>
        <span className="pc-branch-badge">
          <i className="ti ti-building" style={{ fontSize: 12 }} aria-hidden="true" />
          HQ — ทุกสาขา
        </span>
        <button
          type="button"
          className="pc-btn pc-btn-ghost pc-btn-sm"
          onClick={() => void load()}
          disabled={loading}
        >
          <i
            className={`ti ti-refresh${loading ? ' apm-admin-spin' : ''}`}
            aria-hidden="true"
          />
          Refresh
        </button>
        <button
          type="button"
          className="pc-btn pc-btn-ghost pc-btn-sm"
          onClick={() => setCategoryModalOpen(true)}
        >
          <i className="ti ti-category" aria-hidden="true" /> จัดการหมวดหมู่
        </button>
        <button type="button" className="pc-btn pc-btn-primary" onClick={openAdd}>
          <i className="ti ti-plus" aria-hidden="true" /> เพิ่มสินค้า
        </button>
      </header>

      {/* ── Content ── */}
      <div className="pc-content">
        {error && (
          <div
            style={{
              padding: '10px 14px',
              background: '#faece7',
              color: '#993c1d',
              borderRadius: 8,
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
            role="alert"
          >
            <i className="ti ti-alert-triangle" aria-hidden="true" />
            {error}
          </div>
        )}

        {/* ── Toolbar (mirrors POS toolbar exactly) ── */}
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

          {/* Product picker trigger — opens the nice ProductPickerDialog for batch selection */}
          <button
            type="button"
            className="pc-btn pc-btn-ghost pc-btn-sm"
            onClick={() => setShowPicker(true)}
            title="เปิดตัวเลือกสินค้าเพื่อเพิ่มลงรายการที่เลือก"
          >
            <i className="ti ti-list-search" aria-hidden="true" />
            {selectedIds.size > 0 ? `เลือกแล้ว ${selectedIds.size} รายการ` : 'เลือกสินค้า'}
          </button>

          {/* Status filter chips — same pc-stock-filter / pc-sf / pc-on pattern */}
          <div className="pc-stock-filter">
            {(
              [
                ['', 'ทั้งหมด'],
                ['active', 'Active'],
                ['inactive', 'Inactive'],
              ] as const
            ).map(([val, lbl]) => (
              <button
                key={val || 'all'}
                type="button"
                className={`pc-sf${statusFilter === val ? ' pc-on' : ''}`}
                onClick={() => setStatusFilter(val)}
              >
                {lbl}
              </button>
            ))}
          </div>

          {lastFetched && (
            <span
              style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                marginLeft: 'auto',
                whiteSpace: 'nowrap',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <i className="ti ti-clock" aria-hidden="true" />
              {lastFetched.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>

        {/* ── Table card (mirrors POS pc-card exactly) ── */}
        <div className="pc-card">
          <div className="pc-table-scroll">
            <table className="pc-table">
              <thead>
                <tr>
                  <th style={{ width: 32, textAlign: 'center' }}>
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      style={{ width: 12, height: 12 }}
                      checked={allPageSelected}
                      onChange={togglePageSelect}
                      aria-label="เลือกทั้งหมดในหน้านี้"
                    />
                  </th>
                  {TABLE_COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      className={[
                        'pc-sort-th',
                        col.align === 'r' ? 'num' : '',
                        col.sortable === false ? 'pc-sort-th-static' : '',
                        sortConfig?.key === col.key ? 'pc-sort-active' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={
                        col.sortable === false
                          ? undefined
                          : () => handleSort(col.key as AdminSortKey)
                      }
                      onKeyDown={
                        col.sortable === false
                          ? undefined
                          : (e) => e.key === 'Enter' && handleSort(col.key as AdminSortKey)
                      }
                      role={col.sortable === false ? undefined : 'button'}
                      tabIndex={col.sortable === false ? undefined : 0}
                    >
                      {col.label}
                      {col.sortable === false ? null : (
                        <i
                          className={`ti ${sortIcon(col.key)} pc-sort-icon`}
                          aria-hidden="true"
                        />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading && products.length === 0 ? (
                  <tr>
                    <td colSpan={TABLE_COLUMNS.length + 1} className="pc-table-empty">
                      กำลังโหลด...
                    </td>
                  </tr>
                ) : pageItems.length === 0 ? (
                  <tr>
                    <td colSpan={TABLE_COLUMNS.length + 1} className="pc-table-empty">
                      {products.length === 0
                        ? 'ยังไม่มีสินค้าในระบบ'
                        : 'ไม่พบสินค้าที่ตรงตามเงื่อนไข'}
                    </td>
                  </tr>
                ) : (
                  pageItems.map((p) => {
                    const categoryLabel = resolveCategoryName(p.category, categories);
                    const catStyle =
                      CATEGORY_STYLE[p.category] ??
                      CATEGORY_STYLE[categoryLabel] ?? {
                        background: 'var(--g100)',
                        color: 'var(--g600)',
                      };
                    return (
                      <tr
                        key={p.id}
                        className={`${selectedId === p.id ? 'pc-selected' : ''}${selectedIds.has(p.id) ? ' pc-row-checked' : ''}`}
                        onClick={() => openEdit(p.id)}
                      >
                        <td
                          style={{ textAlign: 'center' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            style={{ width: 12, height: 12 }}
                            checked={selectedIds.has(p.id)}
                            onChange={() => toggleRowSelect(p.id)}
                            aria-label={`เลือก ${p.name}`}
                          />
                        </td>
                        <td>
                          <span className="pc-col-sku">{p.sku || '—'}</span>
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
                        <td className="num pc-col-price">฿{fmtBaht(p.basePrice ?? 0)}</td>
                        <td className="num pc-col-price">฿{fmtBaht(getRetailPrice(p))}</td>
                        <td className="num pc-col-cost">฿{fmtBaht(p.cost ?? 0)}</td>
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
                        <td>
                          <span
                            className={`pc-badge ${p.isActive ? 'pc-badge-ok' : 'pc-badge-oos'}`}
                          >
                            {p.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* ── Bottom bar (mirrors POS pc-bottom-bar exactly) ── */}
          <div className="pc-bottom-bar">
            <div className="pc-bottom-left">
              <span className="pc-bottom-info">
                แสดง {rangeStart}–{rangeEnd} จาก {sorted.length} รายการ
                {sorted.length < products.length ? ` (กรอง ${products.length})` : ''}
              </span>
              <div className="pc-per-page-wrap">
                แสดง
                <select
                  className="pc-per-page-sel"
                  value={perPage}
                  onChange={(e) => setPerPage(Number(e.target.value))}
                >
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                </select>
                รายการ/หน้า
              </div>
            </div>
            <div className="pc-pagination">
              <button
                type="button"
                className="pc-pg"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <i className="ti ti-chevron-left" style={{ fontSize: 11 }} aria-hidden="true" />
              </button>
              {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                const pg = i + 1;
                return (
                  <button
                    key={pg}
                    type="button"
                    className={`pc-pg${page === pg ? ' pc-on' : ''}`}
                    onClick={() => setPage(pg)}
                  >
                    {pg}
                  </button>
                );
              })}
              <button
                type="button"
                className="pc-pg"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                <i className="ti ti-chevron-right" style={{ fontSize: 11 }} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── ProductDrawer (HQ context — overridePrice hidden, basePrice editable) ── */}
      <ProductDrawer
        open={drawerMode !== null}
        mode={drawerMode === 'new' ? 'new' : 'edit'}
        product={selectedProduct}
        saving={saving}
        onClose={closeDrawer}
        onSave={handleSave}
        onDelete={() => void handleDelete()}
        onNotify={showToast}
        branchId={branchId}
        isHQContext={true}
        fetchLots={fetchLots}
        loadMovements={fetchMovements}
      />

      {/* ── Bulk action toolbar (appears when products are checked) ── */}
      {selectedIds.size > 0 && (
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
              <i className="ti ti-trash" aria-hidden="true" />
              {saving ? 'กำลังลบ...' : 'ลบสินค้า'}
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
      )}

      {/* ── Product Picker Dialog ── */}
      <ProductPickerDialog
        open={showPicker}
        products={pickerProducts}
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

      {/* ── Category Management Modal ── */}
      <CategoryManagementModal
        open={categoryModalOpen}
        onClose={() => setCategoryModalOpen(false)}
        onToast={showToast}
      />

      {/* ── Toast (same pc-toast pattern as POS) ── */}
      {toast && (
        <div className="pc-toast-wrap">
          <div className={`pc-toast pc-toast-${toast.type}`}>{toast.msg}</div>
        </div>
      )}
    </div>
  );
}
