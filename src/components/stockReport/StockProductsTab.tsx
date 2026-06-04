import { useMemo, useState } from 'react';
import FifoQueueModal from '../inventory/FifoQueueModal';
import ProductImageThumb from '../products/ProductImageThumb';
import ProductPickerDialog from '../products/ProductPickerDialog';
import {
  sortStockProducts,
  type SortDirection,
  type StockProductSortKey,
} from '../../lib/stockReport/sorting';
import {
  fmtBaht,
  fmtNum,
  stockStatus,
  type StockReportProduct,
  type StockStatus,
} from '../../lib/stockReport/types';
import { SortableTh } from './SortableTh';
import { StatusBadge } from './StatusBadge';
import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../ui';

function stockBarClass(status: StockStatus): string {
  if (status === 'ok') return 'bg-[#1d9e75]';
  if (status === 'low') return 'bg-[#ef9f27]';
  return 'bg-[#e24b4a]';
}

export default function StockProductsTab({
  productsWithCogs,
  categories,
  branchId,
  onToast,
  onExportStock,
}: {
  productsWithCogs: StockReportProduct[];
  categories: string[];
  branchId: string | null;
  onToast: (msg: string) => void;
  onExportStock: () => void;
}) {
  const [prodSearch, setProdSearch] = useState('');
  const [prodCat, setProdCat] = useState('');
  const [prodStockFilter, setProdStockFilter] = useState<'' | 'low' | 'out'>('');
  const [prodPickedIds, setProdPickedIds] = useState<Set<string>>(new Set());
  const [showProdPicker, setShowProdPicker] = useState(false);
  const [productSort, setProductSort] = useState<{ key: StockProductSortKey; direction: SortDirection }>({
    key: 'stockValue',
    direction: 'desc',
  });
  const [fifoModalProduct, setFifoModalProduct] = useState<StockReportProduct | null>(null);

  const handleProductSort = (key: StockProductSortKey) => {
    setProductSort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { key, direction: 'asc' };
    });
  };

  const filteredProducts = useMemo(() => {
    const q = prodSearch.trim().toLowerCase();
    const list = productsWithCogs.filter((p) => {
      const mq = !q || `${p.name}${p.sku}`.toLowerCase().includes(q);
      const mc = !prodCat || p.category === prodCat;
      const mp = prodPickedIds.size === 0 || prodPickedIds.has(p.id);
      const ms =
        !prodStockFilter ||
        (prodStockFilter === 'low' && p.qty > 0 && p.qty <= p.reorderPoint) ||
        (prodStockFilter === 'out' && p.qty === 0);
      return mq && mc && mp && ms;
    });
    return sortStockProducts(list, productSort.key, productSort.direction);
  }, [productsWithCogs, prodSearch, prodCat, prodStockFilter, prodPickedIds, productSort]);

  return (
    <div className="sr-panel active">
      <div className="sr-toolbar">
        <select className="sr-sel" value={prodCat} onChange={(e) => setProdCat(e.target.value)}>
          <option value="">ทุกหมวด</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <div className="sr-search-wrap">
          <i className="ti ti-search" aria-hidden="true" />
          <input
            placeholder="ค้นหาชื่อ, SKU, บาร์โค้ด..."
            value={prodSearch}
            onChange={(e) => setProdSearch(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="sr-btn sr-btn-ghost sr-btn-sm"
          onClick={() => setShowProdPicker(true)}
        >
          <i className="ti ti-list-search" aria-hidden="true" /> เลือกสินค้า
        </button>
        <div className="sr-stock-filter">
          {([
            ['', 'ทั้งหมด'],
            ['low', 'ใกล้หมด'],
            ['out', 'หมด'],
          ] as const).map(([val, lbl]) => (
            <button
              key={val || 'all'}
              type="button"
              className={`sr-sf${prodStockFilter === val ? ' sr-on' : ''}`}
              onClick={() => {
                setProdStockFilter(val);
                if (!val) setProdPickedIds(new Set());
              }}
            >
              {lbl}
            </button>
          ))}
        </div>
        <button type="button" className="sr-btn sr-btn-ghost sr-btn-sm" onClick={onExportStock}>
          <i className="ti ti-download" aria-hidden="true" /> Export
        </button>
      </div>
      <div className="sr-card">
        <div className="overflow-x-auto">
          <Table hoverable className="min-w-[600px]">
            <TableHead>
              <TableRow>
                <SortableTh
                  label="รหัส (SKU)"
                  sortKey="sku"
                  activeKey={productSort.key}
                  direction={productSort.direction}
                  onSort={(k) => handleProductSort(k as StockProductSortKey)}
                />
                <SortableTh
                  label="สินค้า"
                  sortKey="name"
                  activeKey={productSort.key}
                  direction={productSort.direction}
                  onSort={(k) => handleProductSort(k as StockProductSortKey)}
                />
                <SortableTh
                  label="หมวดหมู่"
                  sortKey="category"
                  activeKey={productSort.key}
                  direction={productSort.direction}
                  onSort={(k) => handleProductSort(k as StockProductSortKey)}
                />
                <SortableTh
                  label="คงเหลือ"
                  sortKey="qty"
                  activeKey={productSort.key}
                  direction={productSort.direction}
                  onSort={(k) => handleProductSort(k as StockProductSortKey)}
                  className="text-right"
                />
                <SortableTh
                  label="Avg Cost"
                  sortKey="avgCost"
                  activeKey={productSort.key}
                  direction={productSort.direction}
                  onSort={(k) => handleProductSort(k as StockProductSortKey)}
                  className="text-right"
                />
                <SortableTh
                  label="COGS (ช่วงที่เลือก)"
                  sortKey="cogs"
                  activeKey={productSort.key}
                  direction={productSort.direction}
                  onSort={(k) => handleProductSort(k as StockProductSortKey)}
                  className="text-right"
                />
                <SortableTh
                  label="มูลค่าสต็อก"
                  sortKey="stockValue"
                  activeKey={productSort.key}
                  direction={productSort.direction}
                  onSort={(k) => handleProductSort(k as StockProductSortKey)}
                  className="text-right"
                />
                <TableHeadCell>สถานะ</TableHeadCell>
                <TableHeadCell>
                  <span className="sr-only">การกระทำ</span>
                </TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredProducts.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="py-8 text-center text-[13px] text-[var(--text-muted)]"
                  >
                    ไม่พบสินค้า
                  </TableCell>
                </TableRow>
              ) : (
                filteredProducts.map((p) => {
                  const st = stockStatus(p.qty, p.reorderPoint);
                  const maxQty = Math.max(...filteredProducts.map((x) => x.qty), 1);
                  const pct = Math.round((p.qty / maxQty) * 100);
                  return (
                    <TableRow key={p.id}>
                      <TableCell
                        className="whitespace-nowrap text-xs text-[var(--text-secondary)]"
                        style={{ fontFamily: "'Prompt', sans-serif" }}
                      >
                        {p.sku}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <ProductImageThumb imageUrl={p.imageUrl} alt={p.name} />
                          <div className="font-medium">{p.name}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-[var(--text-secondary)]">{p.category}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 min-w-[60px] flex-1 overflow-hidden rounded-[3px] bg-[var(--g100)]">
                            <div
                              className={`h-full rounded-[3px] ${stockBarClass(st)}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="min-w-[28px] text-right text-xs font-medium">
                            {fmtNum(p.qty)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{fmtBaht(p.avgCost)}</TableCell>
                      <TableCell className="text-right text-[var(--success)]">
                        {fmtBaht(p.cogsMonth)}
                      </TableCell>
                      <TableCell className="text-right font-medium text-[var(--p600)]">
                        {fmtBaht(p.stockValue)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={st} />
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          className="sr-btn sr-btn-ghost sr-btn-sm"
                          title="ดู FIFO Lot"
                          onClick={() => setFifoModalProduct(p)}
                        >
                          <i className="ti ti-stack" aria-hidden="true" />
                        </button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <FifoQueueModal
        open={fifoModalProduct !== null}
        productName={fifoModalProduct?.name ?? ''}
        lots={fifoModalProduct?.lots}
        onClose={() => setFifoModalProduct(null)}
      />
      <ProductPickerDialog
        open={showProdPicker}
        branchId={branchId}
        onConfirm={(items) => {
          setProdPickedIds(new Set(items.map((item) => item.id)));
          setShowProdPicker(false);
          onToast(`กรองแสดง ${items.length} รายการที่เลือก`);
        }}
        onClose={() => setShowProdPicker(false)}
      />
    </div>
  );
}
