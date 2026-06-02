import { useCallback, useEffect, useMemo, useState } from 'react';
import { useActiveBranches } from '../../lib/branches';
import { useSortableProducts } from '../../lib/admin/sortingStore';
import {
  createQuickMenu,
  deleteQuickMenu,
  reorderQuickMenus,
  updateQuickMenu,
  useQuickMenus,
  type QuickMenu,
} from '../../lib/admin/quickMenuStore';
import { sortByThaiName, type SortableProduct } from '../../lib/pos/categoryService';
import './SortingSettingsPage.css';
import './QuickMenuSettingsPage.css';

function move<T>(list: readonly T[], index: number, dir: -1 | 1): T[] {
  const target = index + dir;
  if (target < 0 || target >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
}

/**
 * Admin manager for Quick Menus (Virtual Categories). Branch-scoped: every menu
 * lives under the selected branch. Left column lists/reorders the menus; the
 * right pane edits the selected menu — name, active toggle, the ordered set of
 * products (move up/down), and a searchable picker to add/remove products.
 */
export default function QuickMenuSettingsPage() {
  const { branches } = useActiveBranches();
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const { menus, refresh } = useQuickMenus(selectedBranchId || null);
  const { products } = useSortableProducts();

  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const flash = useCallback((msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus(null), 2200);
  }, []);

  const selectedMenu = useMemo(
    () => menus.find((m) => m.id === selectedMenuId) ?? null,
    [menus, selectedMenuId],
  );

  // Keep a menu selected as the list loads / changes.
  useEffect(() => {
    if (selectedMenuId && menus.some((m) => m.id === selectedMenuId)) return;
    setSelectedMenuId(menus[0]?.id ?? null);
  }, [menus, selectedMenuId]);

  // Sync the editable name draft when the selection (or its persisted name) changes.
  useEffect(() => {
    setDraftName(selectedMenu?.name ?? '');
  }, [selectedMenuId, selectedMenu?.name]);

  const productById = useMemo(
    () => new Map(products.map((p) => [p.id, p])),
    [products],
  );

  // The menu's products, in productIds order, with ghost ids (deleted products) dropped.
  const selectedProducts = useMemo<SortableProduct[]>(() => {
    if (!selectedMenu) return [];
    return selectedMenu.productIds
      .map((id) => productById.get(id))
      .filter((p): p is SortableProduct => Boolean(p));
  }, [selectedMenu, productById]);

  const selectedIdSet = useMemo(
    () => new Set(selectedMenu?.productIds ?? []),
    [selectedMenu],
  );

  const pickerProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    const list = q
      ? products.filter(
          (p) => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q),
        )
      : products;
    return sortByThaiName(list);
  }, [products, productSearch]);

  // ── Mutations (all re-read via `refresh`; prod also gets the live snapshot) ──
  const afterWrite = useCallback(
    async (op: Promise<unknown>, okMsg?: string) => {
      try {
        await op;
        refresh();
        if (okMsg) flash(okMsg);
      } catch {
        flash('บันทึกไม่สำเร็จ');
      }
    },
    [refresh, flash],
  );

  const handleCreate = () => {
    if (!selectedBranchId) return;
    void (async () => {
      try {
        const id = await createQuickMenu(selectedBranchId, { name: 'เมนูด่วนใหม่' });
        refresh();
        setSelectedMenuId(id);
      } catch {
        flash('สร้างไม่สำเร็จ');
      }
    })();
  };

  const handleDelete = (id: string) => {
    if (selectedMenuId === id) setSelectedMenuId(null);
    void afterWrite(deleteQuickMenu(selectedBranchId, id), 'ลบเมนูแล้ว');
  };

  const saveName = () => {
    if (!selectedMenu) return;
    const name = draftName.trim();
    if (!name || name === selectedMenu.name) return;
    void afterWrite(updateQuickMenu(selectedBranchId, selectedMenu.id, { name }));
  };

  const toggleActive = (m: QuickMenu) => {
    void afterWrite(updateQuickMenu(selectedBranchId, m.id, { isActive: !m.isActive }));
  };

  const toggleProduct = (productId: string, checked: boolean) => {
    if (!selectedMenu) return;
    const productIds = checked
      ? [...selectedMenu.productIds, productId]
      : selectedMenu.productIds.filter((id) => id !== productId);
    void afterWrite(updateQuickMenu(selectedBranchId, selectedMenu.id, { productIds }));
  };

  const removeProduct = (productId: string) => {
    if (!selectedMenu) return;
    const productIds = selectedMenu.productIds.filter((id) => id !== productId);
    void afterWrite(updateQuickMenu(selectedBranchId, selectedMenu.id, { productIds }));
  };

  // Reorder operates on the cleaned id list, so stale ghost ids are pruned on save.
  const moveProduct = (index: number, dir: -1 | 1) => {
    if (!selectedMenu) return;
    const productIds = move(selectedProducts.map((p) => p.id), index, dir);
    void afterWrite(updateQuickMenu(selectedBranchId, selectedMenu.id, { productIds }));
  };

  const moveMenu = (index: number, dir: -1 | 1) => {
    const next = move(menus, index, dir);
    void afterWrite(reorderQuickMenus(selectedBranchId, next.map((m) => m.id)));
  };

  return (
    <div className="ss-page">
      <div className="ss-branchbar">
        <span>สาขา:</span>
        <select
          className="ss-select"
          value={selectedBranchId}
          onChange={(e) => {
            setSelectedBranchId(e.target.value);
            setSelectedMenuId(null);
          }}
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
        <div className="ss-guard">กรุณาเลือกสาขาก่อนจัดการเมนูด่วน</div>
      ) : (
        <div className="ss-layout">
          <aside className="ss-sidebar">
            <div className="ss-sidebar-title">เมนูด่วน (Quick Menus)</div>
            {menus.map((m, i) => (
              <div key={m.id} className="qm-menu-row">
                <button
                  type="button"
                  className={`ss-tab qm-menu-tab${selectedMenuId === m.id ? ' active' : ''}`}
                  onClick={() => setSelectedMenuId(m.id)}
                >
                  <span className="qm-menu-tab-label">
                    {m.icon ?? '⚡'} {m.name}
                  </span>
                  {!m.isActive ? <span className="qm-off-badge">ปิด</span> : null}
                </button>
                <div className="qm-menu-row-move">
                  <button
                    type="button"
                    className="ss-text-btn"
                    disabled={i === 0}
                    onClick={() => moveMenu(i, -1)}
                  >
                    [ ขยับขึ้น ]
                  </button>
                  <button
                    type="button"
                    className="ss-text-btn"
                    disabled={i === menus.length - 1}
                    onClick={() => moveMenu(i, 1)}
                  >
                    [ ขยับลง ]
                  </button>
                </div>
              </div>
            ))}
            {menus.length === 0 ? <div className="ss-empty">ยังไม่มีเมนูด่วน</div> : null}
            <button type="button" className="ss-reset-btn qm-create-btn" onClick={handleCreate}>
              + สร้างเมนูด่วนใหม่
            </button>
          </aside>

          <main className="ss-content">
            {status ? <div className="ss-status">{status}</div> : null}

            {!selectedMenu ? (
              <div className="ss-empty">เลือกหรือสร้างเมนูด่วนเพื่อแก้ไข</div>
            ) : (
              <>
                <div className="qm-editor-head">
                  <input
                    className="qm-name-input"
                    value={draftName}
                    placeholder="ชื่อเมนูด่วน"
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={saveName}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                  />
                  <label className="ss-toggle">
                    <input
                      type="checkbox"
                      checked={selectedMenu.isActive}
                      onChange={() => toggleActive(selectedMenu)}
                    />
                    เปิดใช้งานบนหน้าขาย
                  </label>
                  <button
                    type="button"
                    className="qm-delete-btn"
                    onClick={() => handleDelete(selectedMenu.id)}
                  >
                    ลบเมนูนี้
                  </button>
                </div>

                <div className="qm-cols">
                  <section className="qm-col">
                    <div className="ss-head-title">
                      สินค้าในเมนู ({selectedProducts.length})
                    </div>
                    <div className="ss-rows">
                      {selectedProducts.map((p, i) => (
                        <div key={p.id} className="ss-row">
                          <span className="ss-row-rank">{i + 1}.</span>
                          <span className="ss-row-name">{p.name}</span>
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
                              disabled={i === selectedProducts.length - 1}
                              onClick={() => moveProduct(i, 1)}
                            >
                              [ขยับลง]
                            </button>
                            <button
                              type="button"
                              className="ss-text-btn qm-remove-btn"
                              onClick={() => removeProduct(p.id)}
                            >
                              [นำออก]
                            </button>
                          </div>
                        </div>
                      ))}
                      {selectedProducts.length === 0 ? (
                        <div className="ss-empty">ยังไม่มีสินค้า — เลือกจากรายการด้านขวา</div>
                      ) : null}
                    </div>
                  </section>

                  <section className="qm-col">
                    <div className="ss-head-title">เพิ่ม / ค้นหาสินค้า</div>
                    <input
                      className="qm-search-input"
                      placeholder="ค้นหาชื่อสินค้า หรือหมวดหมู่..."
                      value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)}
                    />
                    <div className="ss-rows qm-picker">
                      {pickerProducts.map((p) => (
                        <label key={p.id} className="qm-pick-row">
                          <input
                            type="checkbox"
                            checked={selectedIdSet.has(p.id)}
                            onChange={(e) => toggleProduct(p.id, e.target.checked)}
                          />
                          <span className="ss-row-name">{p.name}</span>
                          <span className="qm-pick-cat">{p.category}</span>
                        </label>
                      ))}
                      {pickerProducts.length === 0 ? (
                        <div className="ss-empty">ไม่พบสินค้า</div>
                      ) : null}
                    </div>
                  </section>
                </div>
              </>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
