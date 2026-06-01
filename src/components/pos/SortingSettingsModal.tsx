import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  matchesCategoryFilter,
  saveCategoryBranchSetting,
  useCategories,
} from '../../lib/inventory/categoryService';
import { useActiveBranches } from '../../lib/branches';
import {
  BEST_SELLERS_KEY,
  generateAlphabeticalOrder,
  sortCategories,
  sortProductsByCustomOrder,
  type SortableProduct,
} from '../../lib/pos/categoryService';
import {
  saveProductSortOrders,
  saveProductVisibility,
  useSortableProducts,
} from '../../lib/admin/sortingStore';
import type { CategoryBranchSetting, ProductCategory } from '../../lib/types';
import '../../pages/admin/SortingSettingsPage.css';

type Tab = 'category' | 'product';

function move<T>(list: readonly T[], index: number, dir: -1 | 1): T[] {
  const target = index + dir;
  if (target < 0 || target >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
}

/**
 * The full branch-scoped sorting & visibility view (branch selector + 2-column
 * tabs). Reused both full-page (admin route) and inside the POS modal. All saves
 * are scoped to `selectedBranchId`, which initializes from `defaultBranchId`.
 */
export function SortingSettingsContent({ defaultBranchId = '' }: { defaultBranchId?: string }) {
  const [tab, setTab] = useState<Tab>('category');
  const [selectedBranchId, setSelectedBranchId] = useState<string>(defaultBranchId);
  const { branches } = useActiveBranches();
  const { categories } = useCategories();
  const { products } = useSortableProducts();

  const [status, setStatus] = useState<string | null>(null);
  const flash = useCallback((msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus(null), 2400);
  }, []);

  // ── Category ranking working copy (branch-scoped) ───────────────────────
  const [cats, setCats] = useState<ProductCategory[]>([]);
  useEffect(() => {
    setCats(sortCategories(categories, selectedBranchId));
  }, [categories, selectedBranchId]);

  /** Merge a partial setting into the selected branch's slot for a category. */
  const withCatSetting = useCallback(
    (cat: ProductCategory, patch: Partial<CategoryBranchSetting>): ProductCategory => {
      const prev = cat.branchSettings?.[selectedBranchId] ?? { displayOrder: 0, isVisibleInPos: true };
      return {
        ...cat,
        branchSettings: { ...cat.branchSettings, [selectedBranchId]: { ...prev, ...patch } },
      };
    },
    [selectedBranchId],
  );

  const persistCat = useCallback(
    (catId: string, patch: Partial<CategoryBranchSetting>) => {
      void saveCategoryBranchSetting(catId, selectedBranchId, patch).catch(() =>
        flash('บันทึกไม่สำเร็จ'),
      );
    },
    [selectedBranchId, flash],
  );

  const updateCat = (id: string, patch: Partial<CategoryBranchSetting>) => {
    setCats((prev) => prev.map((c) => (c.id === id ? withCatSetting(c, patch) : c)));
    persistCat(id, patch);
  };

  const moveCat = (index: number, dir: -1 | 1) => {
    const next = move(cats, index, dir).map((c, i) => withCatSetting(c, { displayOrder: i }));
    setCats(next);
    void Promise.all(
      next.map((c) =>
        saveCategoryBranchSetting(c.id, selectedBranchId, {
          displayOrder: c.branchSettings?.[selectedBranchId]?.displayOrder ?? 0,
        }),
      ),
    ).catch(() => flash('บันทึกไม่สำเร็จ'));
  };

  const resetCategoriesAlpha = () => {
    const order = generateAlphabeticalOrder(cats);
    const next = sortCategories(
      cats.map((c) => withCatSetting(c, { displayOrder: order[c.id] ?? 0 })),
      selectedBranchId,
    );
    setCats(next);
    void Promise.all(
      next.map((c) =>
        saveCategoryBranchSetting(c.id, selectedBranchId, {
          displayOrder: c.branchSettings?.[selectedBranchId]?.displayOrder ?? 0,
        }),
      ),
    ).catch(() => flash('บันทึกไม่สำเร็จ'));
    flash('เรียงหมวดหมู่ตามชื่อ ก-ฮ แล้ว');
  };

  // ── Product ranking working copy (branch-scoped) ────────────────────────
  const [selectedKey, setSelectedKey] = useState<string>(BEST_SELLERS_KEY);
  const [workingProducts, setWorkingProducts] = useState<SortableProduct[]>([]);

  const categoryOptions = useMemo(
    () => sortCategories(categories, selectedBranchId),
    [categories, selectedBranchId],
  );

  useEffect(() => {
    const scoped =
      selectedKey === BEST_SELLERS_KEY
        ? products
        : products.filter((p) => matchesCategoryFilter(p.category, selectedKey, categories));
    setWorkingProducts(sortProductsByCustomOrder(scoped, selectedKey, selectedBranchId));
  }, [selectedKey, products, categories, selectedBranchId]);

  const moveProduct = (index: number, dir: -1 | 1) => {
    const next = move(workingProducts, index, dir);
    setWorkingProducts(next);
    void saveProductSortOrders(selectedBranchId, selectedKey, next.map((p) => p.id)).catch(() =>
      flash('บันทึกไม่สำเร็จ'),
    );
  };

  const toggleProductVisibility = (id: string, visible: boolean) => {
    setWorkingProducts((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;
        const prevSetting = p.branchSettings?.[selectedBranchId] ?? {
          isVisibleInPos: true,
          sortOrders: {},
        };
        return {
          ...p,
          branchSettings: {
            ...p.branchSettings,
            [selectedBranchId]: { ...prevSetting, isVisibleInPos: visible },
          },
        };
      }),
    );
    void saveProductVisibility(selectedBranchId, id, visible).catch(() => flash('บันทึกไม่สำเร็จ'));
  };

  const resetProductsAlpha = () => {
    const order = generateAlphabeticalOrder(workingProducts);
    const next = [...workingProducts].sort((a, b) => (order[a.id] ?? 0) - (order[b.id] ?? 0));
    setWorkingProducts(next);
    void saveProductSortOrders(selectedBranchId, selectedKey, next.map((p) => p.id)).catch(() =>
      flash('บันทึกไม่สำเร็จ'),
    );
    flash('เรียงสินค้าตามชื่อ ก-ฮ แล้ว');
  };

  return (
    <div className="ss-page">
      <div className="ss-branchbar">
        <span>สาขา:</span>
        <select
          className="ss-select"
          value={selectedBranchId}
          onChange={(e) => setSelectedBranchId(e.target.value)}
        >
          <option value="">— เลือกสาขา —</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      {!selectedBranchId ? (
        <div className="ss-guard">กรุณาเลือกสาขาก่อนจัดการลำดับการแสดงผล</div>
      ) : (
        <div className="ss-layout">
          <aside className="ss-sidebar">
            <div className="ss-sidebar-title">การจัดเรียง</div>
            <button
              type="button"
              className={`ss-tab${tab === 'category' ? ' active' : ''}`}
              onClick={() => setTab('category')}
            >
              ลำดับหมวดหมู่
            </button>
            <button
              type="button"
              className={`ss-tab${tab === 'product' ? ' active' : ''}`}
              onClick={() => setTab('product')}
            >
              ลำดับสินค้า
            </button>
          </aside>

          <main className="ss-content">
            {status ? <div className="ss-status">{status}</div> : null}

            {tab === 'category' ? (
              <section>
                <div className="ss-head">
                  <div className="ss-head-title">ลำดับหมวดหมู่ (Category Ranking)</div>
                  <button type="button" className="ss-reset-btn" onClick={resetCategoriesAlpha}>
                    [ รีเซ็ตการจัดเรียง: เรียงตามชื่อ ก-ฮ ]
                  </button>
                </div>

                <div className="ss-rows">
                  {cats.map((cat, i) => {
                    const setting = cat.branchSettings?.[selectedBranchId];
                    return (
                      <div key={cat.id} className="ss-row">
                        <span className="ss-row-name">{cat.name}</span>

                        <label className="ss-toggle">
                          <input
                            type="checkbox"
                            checked={setting?.isVisibleInPos !== false}
                            onChange={(e) => updateCat(cat.id, { isVisibleInPos: e.target.checked })}
                          />
                          แสดงในหน้าขาย
                        </label>

                        <div className="ss-move">
                          <button
                            type="button"
                            className="ss-text-btn"
                            disabled={i === 0}
                            onClick={() => moveCat(i, -1)}
                          >
                            [ขยับขึ้น]
                          </button>
                          <button
                            type="button"
                            className="ss-text-btn"
                            disabled={i === cats.length - 1}
                            onClick={() => moveCat(i, 1)}
                          >
                            [ขยับลง]
                          </button>
                        </div>

                        <input
                          type="color"
                          className="ss-color"
                          value={setting?.backgroundColor ?? '#f8f8fc'}
                          onChange={(e) => updateCat(cat.id, { backgroundColor: e.target.value })}
                          aria-label={`สีพื้นหลัง ${cat.name}`}
                        />

                        <input
                          type="text"
                          className="ss-image"
                          placeholder="URL รูปพื้นหลัง (ถ้ามี)"
                          value={setting?.imageUrl ?? ''}
                          onChange={(e) => updateCat(cat.id, { imageUrl: e.target.value })}
                        />
                      </div>
                    );
                  })}
                  {cats.length === 0 ? <div className="ss-empty">ยังไม่มีหมวดหมู่</div> : null}
                </div>
              </section>
            ) : (
              <section>
                <div className="ss-head">
                  <div className="ss-head-title">ลำดับสินค้า (Product Ranking)</div>
                  <button type="button" className="ss-reset-btn" onClick={resetProductsAlpha}>
                    [ รีเซ็ตการจัดเรียง: เรียงตามชื่อ ก-ฮ ]
                  </button>
                </div>

                <div className="ss-select-row">
                  <span>เลือกกลุ่ม:</span>
                  <select
                    className="ss-select"
                    value={selectedKey}
                    onChange={(e) => setSelectedKey(e.target.value)}
                  >
                    <option value={BEST_SELLERS_KEY}>[⭐️ สินค้าขายดี]</option>
                    {categoryOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="ss-rows">
                  {workingProducts.map((p, i) => {
                    const setting = p.branchSettings?.[selectedBranchId];
                    return (
                      <div key={p.id} className="ss-row">
                        <span className="ss-row-rank">{i + 1}.</span>
                        <span className="ss-row-name">{p.name}</span>
                        <label className="ss-toggle">
                          <input
                            type="checkbox"
                            checked={setting?.isVisibleInPos !== false}
                            onChange={(e) => toggleProductVisibility(p.id, e.target.checked)}
                          />
                          แสดงในหน้าขาย
                        </label>
                        <div className="ss-move">
                          <button
                            type="button"
                            className="ss-text-btn"
                            disabled={i === 0}
                            onClick={() => moveProduct(i, -1)}
                          >
                            [ขยับขึ้น]
                          </button>
                          <button
                            type="button"
                            className="ss-text-btn"
                            disabled={i === workingProducts.length - 1}
                            onClick={() => moveProduct(i, 1)}
                          >
                            [ขยับลง]
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {workingProducts.length === 0 ? (
                    <div className="ss-empty">ไม่มีสินค้าในกลุ่มนี้</div>
                  ) : null}
                </div>
              </section>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

/**
 * POS-embedded modal wrapper. Mounts the content only while open, so it always
 * re-initializes the branch selector to the terminal's branch on each open.
 */
export default function SortingSettingsModal({
  isOpen,
  onClose,
  defaultBranchId,
}: {
  isOpen: boolean;
  onClose: () => void;
  defaultBranchId?: string;
}) {
  if (!isOpen) return null;
  return (
    <div className="ss-modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="ss-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ss-modal-hd">
          <span>จัดการลำดับการแสดงผลและซ่อนสินค้า</span>
          <button type="button" className="ss-modal-close" onClick={onClose}>
            ปิด
          </button>
        </div>
        <div className="ss-modal-body">
          <SortingSettingsContent defaultBranchId={defaultBranchId} />
        </div>
      </div>
    </div>
  );
}
