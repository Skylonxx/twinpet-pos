import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProductCrud } from '../../lib/productCrud/useProductCrud';
import {
  PICKER_PAGE_SIZE,
  buildPageNumbers,
  categoryBadgeClass,
  categoryBadgeStyle,
  filterPickerProducts,
  productListItemToPickerItem,
  stockClass,
  type ProductPickerItem,
  type ProductPickerSearchType,
} from './productPickerTypes';
import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../ui';
import './ProductPickerDialog.css';

export type { ProductPickerItem } from './productPickerTypes';
export {
  posProductToPickerItem,
  productListItemToPickerItem,
} from './productPickerTypes';

type ProductPickerDialogProps = {
  open: boolean;
  products?: ProductPickerItem[];
  branchId?: string | null;
  onConfirm: (selected: ProductPickerItem[]) => void;
  onClose: () => void;
};

export default function ProductPickerDialog({
  open,
  products: productsProp,
  branchId = null,
  onConfirm,
  onClose,
}: ProductPickerDialogProps) {
  const { products: fetchedProducts, loading } = useProductCrud(branchId);

  const sourceProducts = useMemo(() => {
    if (productsProp) return productsProp;
    return fetchedProducts
      .filter((p) => p.isActive && !p.deletedAt)
      .map(productListItemToPickerItem);
  }, [productsProp, fetchedProducts]);

  const [searchType, setSearchType] = useState<ProductPickerSearchType>('name');
  const [searchDraft, setSearchDraft] = useState('');
  const [appliedSearch, setAppliedSearch] = useState<{ type: ProductPickerSearchType; q: string }>({
    type: 'name',
    q: '',
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const resetState = useCallback(() => {
    setSearchType('name');
    setSearchDraft('');
    setAppliedSearch({ type: 'name', q: '' });
    setSelected(new Set());
    setPage(1);
  }, []);

  useEffect(() => {
    if (!open) return;
    resetState();
  }, [open, resetState]);

  const filtered = useMemo(
    () => filterPickerProducts(sourceProducts, appliedSearch.type, appliedSearch.q),
    [sourceProducts, appliedSearch],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PICKER_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const pageItems = useMemo(() => {
    const start = (safePage - 1) * PICKER_PAGE_SIZE;
    return filtered.slice(start, start + PICKER_PAGE_SIZE);
  }, [filtered, safePage]);

  const pageStart = filtered.length === 0 ? 0 : (safePage - 1) * PICKER_PAGE_SIZE + 1;
  const pageEnd = Math.min(safePage * PICKER_PAGE_SIZE, filtered.length);

  const allPageSelected = pageItems.length > 0 && pageItems.every((p) => selected.has(p.id));
  const somePageSelected = pageItems.some((p) => selected.has(p.id));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = !allPageSelected && somePageSelected;
    }
  }, [allPageSelected, somePageSelected, pageItems]);

  const selectedCount = selected.size;
  const selectedProducts = useMemo(
    () => sourceProducts.filter((p) => selected.has(p.id)),
    [sourceProducts, selected],
  );

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllOnPage = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of pageItems) {
        if (checked) next.add(p.id);
        else next.delete(p.id);
      }
      return next;
    });
  };

  const doSearch = () => {
    setAppliedSearch({ type: searchType, q: searchDraft });
    setPage(1);
  };

  const doReset = () => {
    setSearchDraft('');
    setSearchType('name');
    setAppliedSearch({ type: 'name', q: '' });
    setPage(1);
  };

  const goPage = (p: number) => {
    if (p < 1 || p > totalPages) return;
    setPage(p);
  };

  const handleConfirm = () => {
    if (selectedCount === 0) return;
    onConfirm(selectedProducts);
    onClose();
  };

  if (!open) return null;

  const pageNumbers = buildPageNumbers(safePage, totalPages);

  return (
    <div
      className="pps-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pps-dialog-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dlg-head">
          <span className="dlg-title" id="pps-dialog-title">
            เลือกสินค้า
          </span>
          <div className="dlg-sel-count-hd">เลือก {selectedCount} รายการ</div>
          <button type="button" className="close-btn" aria-label="ปิด" onClick={onClose}>
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <div className="search-bar">
          <span className="search-label">ค้นหา</span>
          <select
            className="search-type"
            value={searchType}
            onChange={(e) => setSearchType(e.target.value as ProductPickerSearchType)}
          >
            <option value="name">ชื่อสินค้า</option>
            <option value="sku">รหัสสินค้า</option>
            <option value="barcode">บาร์โค้ด</option>
            <option value="cat">กลุ่มสินค้า</option>
          </select>
          <input
            className="search-input"
            placeholder="ค้นหาสินค้า..."
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') doSearch();
            }}
          />
          <button type="button" className="search-btn" onClick={doSearch}>
            ค้นหา
          </button>
          <button type="button" className="reset-btn" onClick={doReset}>
            รีเซต
          </button>
        </div>

        <div className="table-wrap">
          <Table>
            <TableHead className="sticky top-0 z-[1]">
              <TableRow>
                <TableHeadCell className="w-[38px] text-center">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    className="cb"
                    checked={allPageSelected && pageItems.length > 0}
                    onChange={(e) => toggleAllOnPage(e.target.checked)}
                    aria-label="เลือกทั้งหมดในหน้านี้"
                  />
                </TableHeadCell>
                <TableHeadCell className="w-[38px]" />
                <TableHeadCell>ชื่อสินค้า</TableHeadCell>
                <TableHeadCell className="w-[140px]">รหัสสินค้า</TableHeadCell>
                <TableHeadCell className="w-[150px]">กลุ่มสินค้า</TableHeadCell>
                <TableHeadCell className="w-[90px] text-right">คงเหลือ</TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading && !productsProp ? (
                <TableRow>
                  <TableCell colSpan={6} className="empty-msg">
                    กำลังโหลดสินค้า...
                  </TableCell>
                </TableRow>
              ) : pageItems.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="empty-msg">
                    ไม่พบสินค้า
                  </TableCell>
                </TableRow>
              ) : (
                pageItems.map((p) => {
                  const isSel = selected.has(p.id);
                  const catCls = categoryBadgeClass(p.category);
                  const catStyle = categoryBadgeStyle(p.category);
                  return (
                    <TableRow
                      key={p.id}
                      className={`cursor-pointer${isSel ? ' bg-[#f0fff8]' : ''}`}
                      onClick={() => toggleOne(p.id)}
                    >
                      <TableCell className="text-center">
                        <input
                          type="checkbox"
                          className="cb"
                          checked={isSel}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleOne(p.id)}
                          aria-label={`เลือก ${p.name}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="prod-img">{p.emoji}</div>
                      </TableCell>
                      <TableCell>
                        <div className="prod-name">{p.name}</div>
                        <div className="prod-sku">
                          {p.sku} · {p.barcode}
                        </div>
                      </TableCell>
                      <TableCell style={{ fontSize: 11, color: 'var(--g400)' }}>{p.sku}</TableCell>
                      <TableCell>
                        <span className={`cat-badge ${catCls}`} style={catStyle}>
                          {p.category}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className={stockClass(p.stock)}>{p.stock}</span>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        <div className="pag-bar">
          <div className="pag-info">
            {filtered.length > 0
              ? `แสดง ${pageStart}–${pageEnd} จาก ${filtered.length} รายการ`
              : 'ไม่มีรายการ'}
          </div>
          {totalPages > 1 ? (
            <div className="pag-btns">
              <button
                type="button"
                className={`pg${safePage === 1 ? ' dis' : ''}`}
                disabled={safePage === 1}
                onClick={() => goPage(safePage - 1)}
                aria-label="หน้าก่อน"
              >
                <i className="ti ti-chevron-left" style={{ fontSize: 11 }} aria-hidden="true" />
              </button>
              {pageNumbers.map((n, idx) =>
                n === '…' ? (
                  <div key={`ellipsis-${idx}`} className="pg dis" style={{ border: 'none' }}>
                    …
                  </div>
                ) : (
                  <button
                    key={n}
                    type="button"
                    className={`pg${n === safePage ? ' on' : ''}`}
                    onClick={() => goPage(n)}
                  >
                    {n}
                  </button>
                ),
              )}
              <button
                type="button"
                className={`pg${safePage === totalPages ? ' dis' : ''}`}
                disabled={safePage === totalPages}
                onClick={() => goPage(safePage + 1)}
                aria-label="หน้าถัดไป"
              >
                <i className="ti ti-chevron-right" style={{ fontSize: 11 }} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>

        <div className="dlg-footer">
          <div className="sel-label">
            เลือกแล้ว <strong>{selectedCount}</strong> รายการ
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="cancel-btn" onClick={onClose}>
              ยกเลิก
            </button>
            <button
              type="button"
              className="confirm-btn"
              disabled={selectedCount === 0}
              onClick={handleConfirm}
            >
              {selectedCount > 0 ? `ยืนยัน (${selectedCount})` : 'ยืนยัน'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
