import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Tooltip,
} from 'chart.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bar, Doughnut } from 'react-chartjs-2';
import { getBranchLabel } from '../lib/branches';
import {
  PRESET_LABELS,
  aggregateFieldMap,
  billFieldMap,
  buildBarChartData,
  buildDonutData,
  buildTop5Customers,
  deriveCategories,
  deriveProducts,
  exportProfitCsv,
  filterProfitLines,
  sortLines,
} from '../lib/profitReport/aggregate';
import { getDevProfitProducts } from '../lib/profitReport/devMock';
import { useProfitReport } from '../lib/profitReport/useProfitReport';
import {
  CAT_COLORS,
  PAGE_SIZE,
  aggregateLines,
  applyDatePreset,
  computeKpi,
  fmtBaht,
  fmtNum,
  fmtPct,
  marginBarColor,
  marginClass,
  type DatePreset,
  type GroupBy,
  type ProfitAggregateRow,
  type ProfitProduct,
  type ProfitSaleLine,
  type SortField,
} from '../lib/profitReport/types';
import { useAuth } from '../lib/hooks/useAuth';
import { isFirebaseConfigured } from '../lib/firebase';
import './ProfitReportPage.css';

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend);

const PRESET_CHIPS: { id: DatePreset; label: string }[] = [
  { id: 'today', label: 'วันนี้' },
  { id: 'yesterday', label: 'เมื่อวาน' },
  { id: '7d', label: '7 วัน' },
  { id: '30d', label: '30 วัน' },
  { id: 'thismonth', label: 'เดือนนี้' },
  { id: 'lastmonth', label: 'เดือนก่อน' },
];

const TABLE_LABELS: Record<GroupBy, string> = {
  bill: 'ประวัติการขาย (รายบิล)',
  cat: 'ยอดขายจัดกลุ่มตาม หมวดหมู่',
  product: 'ยอดขายจัดกลุ่มตาม สินค้า',
  customer: 'ยอดขายจัดกลุ่มตาม ลูกค้า',
};

const PD_PAGE = 25;

function MarginCell({ margin }: { margin: number }) {
  const barW = Math.min(100, Math.max(0, (margin / 40) * 100));
  return (
    <td className="num">
      <span className={marginClass(margin)}>{fmtPct(margin)}</span>
      <span className="pr-margin-bar-bg">
        <span
          style={{
            display: 'block',
            height: '100%',
            width: `${barW}%`,
            background: marginBarColor(margin),
            borderRadius: 2,
          }}
        />
      </span>
    </td>
  );
}

function SortTh({
  label,
  field,
  isNum,
  active,
  dir,
  onSort,
}: {
  label: string;
  field: SortField;
  isNum?: boolean;
  active: boolean;
  dir: 'asc' | 'desc';
  onSort: (field: SortField) => void;
}) {
  return (
    <th
      className={[isNum ? 'num' : '', 'sortable', active ? 'sort-active' : ''].filter(Boolean).join(' ')}
      onClick={() => onSort(field)}
    >
      {label}
      <span className={`pr-sort-icon ${active ? dir : ''}`}>
        <span className="pr-arr-up" />
        <span className="pr-arr-dn" />
      </span>
    </th>
  );
}

function PaginationBar({
  total,
  page,
  onPage,
}: {
  total: number;
  page: number;
  onPage: (n: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;

  const start = (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(page * PAGE_SIZE, total);
  const show = new Set(
    [1, 2, pages - 1, pages, page - 2, page - 1, page, page + 1, page + 2].filter(
      (p) => p >= 1 && p <= pages,
    ),
  );
  const nums = [...show].sort((a, b) => a - b);

  return (
    <div className="pr-pagi-bar">
      <span className="pr-pagi-info">
        แสดง {start}–{end} จาก {total} รายการ
      </span>
      <div className="pr-pagi-pages">
        <button
          type="button"
          className={`pr-pagi-btn${page === 1 ? ' disabled' : ''}`}
          onClick={() => onPage(page - 1)}
          disabled={page === 1}
        >
          <i className="ti ti-chevron-left" style={{ fontSize: 12 }} aria-hidden="true" />
        </button>
        {nums.map((n, i) => {
          const prev = nums[i - 1];
          return (
            <span key={n} style={{ display: 'contents' }}>
              {prev !== undefined && n - prev > 1 ? (
                <button type="button" className="pr-pagi-btn ellipsis" tabIndex={-1}>
                  …
                </button>
              ) : null}
              <button
                type="button"
                className={`pr-pagi-btn${n === page ? ' active' : ''}`}
                onClick={() => onPage(n)}
              >
                {n}
              </button>
            </span>
          );
        })}
        <button
          type="button"
          className={`pr-pagi-btn${page === pages ? ' disabled' : ''}`}
          onClick={() => onPage(page + 1)}
          disabled={page === pages}
        >
          <i className="ti ti-chevron-right" style={{ fontSize: 12 }} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function ProductPickerModal({
  open,
  products,
  categories,
  selected,
  onClose,
  onConfirm,
}: {
  open: boolean;
  products: ProfitProduct[];
  categories: string[];
  selected: Set<string>;
  onClose: () => void;
  onConfirm: (sel: Set<string>) => void;
}) {
  const [draft, setDraft] = useState<Set<string>>(new Set(selected));
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (open) {
      setDraft(new Set(selected));
      setSearch('');
      setCat('');
      setPage(1);
    }
  }, [open, selected]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter(
      (p) =>
        (!cat || p.category === cat) &&
        (!q || `${p.name}${p.sku}`.toLowerCase().includes(q)),
    );
  }, [products, search, cat]);

  const pages = Math.max(1, Math.ceil(filtered.length / PD_PAGE));
  const pageItems = filtered.slice((page - 1) * PD_PAGE, page * PD_PAGE);

  if (!open) return null;

  const toggle = (id: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="pr-modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="pr-modal pr-pd-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pr-modal-header">
          <span className="pr-modal-title">เลือกสินค้า</span>
          <button type="button" className="pr-icon-btn" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>
        <div className="pr-pd-toolbar">
          <select className="pr-sel" value={cat} onChange={(e) => { setCat(e.target.value); setPage(1); }}>
            <option value="">ทุกหมวดหมู่</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <div className="pr-pd-search">
            <i className="ti ti-search" aria-hidden="true" />
            <input
              type="text"
              placeholder="ค้นหาชื่อ / SKU..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <span className="pr-pd-sel-info">
            เลือกแล้ว: <b>{draft.size}</b> รายการ
          </span>
        </div>
        <div className="pr-pd-grid">
          {pageItems.length === 0 ? (
            <div className="pr-pd-empty">
              <i className="ti ti-package-off" style={{ fontSize: 28, display: 'block', marginBottom: 8, opacity: 0.3 }} aria-hidden="true" />
              ไม่พบสินค้า
            </div>
          ) : (
            pageItems.map((p) => (
              <div
                key={p.id}
                className={`pr-pd-item${draft.has(p.id) ? ' selected' : ''}`}
                onClick={() => toggle(p.id)}
                onKeyDown={(e) => e.key === 'Enter' && toggle(p.id)}
                role="button"
                tabIndex={0}
              >
                <div className="pr-pd-item-icon" style={{ background: p.iconBg }}>
                  {p.emoji}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="pr-pd-item-name">{p.name}</div>
                  <div className="pr-pd-item-sku">
                    {p.sku} · {p.category}
                  </div>
                </div>
                <div className="pr-pd-check">
                  <i className="ti ti-check" aria-hidden="true" />
                </div>
              </div>
            ))
          )}
        </div>
        <div className="pr-pd-pagination">
          <span>
            {filtered.length
              ? `แสดง ${(page - 1) * PD_PAGE + 1}–${Math.min(page * PD_PAGE, filtered.length)} จาก ${filtered.length} รายการ`
              : 'ไม่พบสินค้า'}
          </span>
          <div className="pr-pd-page-btns">
            <button type="button" className="pr-pd-page-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <i className="ti ti-chevron-left" aria-hidden="true" />
            </button>
            {pages <= 7
              ? Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`pr-pd-page-btn${n === page ? ' active' : ''}`}
                    onClick={() => setPage(n)}
                  >
                    {n}
                  </button>
                ))
              : null}
            <button type="button" className="pr-pd-page-btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              <i className="ti ti-chevron-right" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="pr-modal-footer">
          <button type="button" className="pr-btn pr-btn-ghost pr-btn-sm" onClick={() => setDraft(new Set())}>
            <i className="ti ti-x" aria-hidden="true" /> ล้างทั้งหมด
          </button>
          <div className="pr-footer-spacer" />
          <button type="button" className="pr-btn pr-btn-ghost" onClick={onClose}>
            ยกเลิก
          </button>
          <button type="button" className="pr-btn pr-btn-primary" onClick={() => onConfirm(draft)}>
            <i className="ti ti-check" aria-hidden="true" /> ยืนยัน
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ProfitReportPage() {
  const { branchId } = useAuth();
  const { lines, loading, error } = useProfitReport(branchId);

  const initialRange = applyDatePreset('7d');
  const [dateFrom, setDateFrom] = useState(initialRange.from);
  const [dateTo, setDateTo] = useState(initialRange.to);
  const [activePreset, setActivePreset] = useState<DatePreset | ''>('7d');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('bill');
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tablePage, setTablePage] = useState(1);
  const [sortField, setSortField] = useState<SortField>('profit');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [sortKey, setSortKey] = useState('');
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'info' } | null>(null);
  const [clock, setClock] = useState('');

  const branchDisplay = branchId ? getBranchLabel(branchId) : '—';

  const allProducts = useMemo(() => {
    if (!isFirebaseConfigured) return getDevProfitProducts();
    return deriveProducts(lines);
  }, [lines]);

  const allCategories = useMemo(() => {
    if (!isFirebaseConfigured) {
      return [
        'อาหารสุนัข',
        'อาหารแมว',
        'ของเล่น',
        'ยาและวิตามิน',
        'อุปกรณ์',
        'ทรายแมว',
      ];
    }
    return deriveCategories(lines);
  }, [lines]);

  const filteredData = useMemo(
    () =>
      filterProfitLines(lines, {
        search,
        category,
        from: dateFrom,
        to: dateTo,
        productIds: selectedProducts,
      }),
    [lines, search, category, dateFrom, dateTo, selectedProducts],
  );

  const kpi = useMemo(() => computeKpi(filteredData), [filteredData]);
  const barData = useMemo(
    () => buildBarChartData(filteredData, dateFrom, dateTo),
    [filteredData, dateFrom, dateTo],
  );
  const donutData = useMemo(
    () => buildDonutData(filteredData, allCategories),
    [filteredData, allCategories],
  );
  const top5 = useMemo(() => buildTop5Customers(filteredData), [filteredData]);

  const aggregated = useMemo(
    () => (groupBy === 'bill' ? null : aggregateLines(filteredData, groupBy)),
    [filteredData, groupBy],
  );

  const handleSort = useCallback(
    (field: SortField) => {
      const key = `${field}${groupBy}`;
      if (sortKey === key) {
        setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
      } else {
        setSortField(field);
        setSortDir('desc');
        setSortKey(key);
        setTablePage(1);
      }
    },
    [groupBy, sortKey],
  );

  const sortedBillRows = useMemo(() => {
    const map = billFieldMap();
    const getter = map[sortField] ?? map.date!;
    return sortLines(filteredData, getter, sortDir);
  }, [filteredData, sortField, sortDir]);

  const sortedAggRows = useMemo(() => {
    if (!aggregated) return [];
    const map = aggregateFieldMap(groupBy as 'cat' | 'product' | 'customer');
    const getter = map[sortField] ?? map.profit!;
    return sortLines(aggregated, getter, sortDir);
  }, [aggregated, groupBy, sortField, sortDir]);

  const tableRows = groupBy === 'bill' ? sortedBillRows : sortedAggRows;
  const pageRows = tableRows.slice((tablePage - 1) * PAGE_SIZE, tablePage * PAGE_SIZE);

  useEffect(() => {
    setTablePage(1);
  }, [search, category, dateFrom, dateTo, groupBy, selectedProducts]);

  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleString('th-TH', {
          hour: '2-digit',
          minute: '2-digit',
          day: '2-digit',
          month: 'short',
        }),
      );
    tick();
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  const applyPreset = (preset: DatePreset) => {
    const range = applyDatePreset(preset);
    setDateFrom(range.from);
    setDateTo(range.to);
    setActivePreset(preset);
  };

  const pickerLabel = useMemo(() => {
    if (selectedProducts.size === 0) return 'ทุกสินค้า';
    if (selectedProducts.size === 1) {
      const p = allProducts.find((x) => selectedProducts.has(x.id));
      return p?.name ?? '1 รายการ';
    }
    return `${selectedProducts.size} รายการที่เลือก`;
  }, [selectedProducts, allProducts]);

  const barChartTitle =
    (activePreset && PRESET_LABELS[activePreset]) ||
    (barData.monthly ? 'ยอดขาย vs กำไร (รายเดือน)' : 'ยอดขาย vs กำไร (รายวัน)');

  const barChartJs = {
    labels: barData.labels,
    datasets: [
      {
        label: 'ยอดขาย',
        data: barData.revenue,
        backgroundColor: 'rgba(83,74,183,0.85)',
        borderRadius: 4,
        borderSkipped: false as const,
      },
      {
        label: 'กำไร',
        data: barData.profit,
        backgroundColor: 'rgba(15,110,86,0.85)',
        borderRadius: 4,
        borderSkipped: false as const,
      },
    ],
  };

  const donutChartJs = {
    labels: donutData.labels,
    datasets: [
      {
        data: donutData.values,
        backgroundColor: donutData.colors,
        borderWidth: 0,
        hoverOffset: 4,
      },
    ],
  };

  const rankCls = (i: number) =>
    ['pr-rank-1', 'pr-rank-2', 'pr-rank-3', 'pr-rank-n', 'pr-rank-n'][Math.min(i, 4)]!;

  const renderBillRow = (r: ProfitSaleLine) => (
    <tr key={r.id}>
      <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
        <div style={{ fontWeight: 500 }}>{r.time}</div>
        <div style={{ color: 'var(--text-muted)' }}>{r.date.slice(5).replace('-', '/')}</div>
      </td>
      <td style={{ fontSize: 12, color: 'var(--info)', fontFamily: "'Sarabun',sans-serif" }}>{r.bill || r.orderId}</td>
      <td style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{r.customer}</td>
      <td>
        <div className="pr-prod-cell">
          <div className="pr-prod-icon" style={{ background: r.iconBg }}>
            {r.emoji}
          </div>
          <div>
            <div style={{ fontWeight: 500, fontSize: 13 }}>{r.productName}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {r.productSku} · {r.category}
            </div>
          </div>
        </div>
      </td>
      <td className="num" style={{ fontWeight: 500 }}>
        {fmtNum(r.qty)}
      </td>
      <td className="num" style={{ color: 'var(--p600)', fontWeight: 500 }}>
        {fmtBaht(r.revenue)}
      </td>
      <td className="num" style={{ color: 'var(--warn)' }}>
        {fmtBaht(r.cogs)}
      </td>
      <td className="num" style={{ color: r.profit >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 500 }}>
        {fmtBaht(r.profit)}
      </td>
      <MarginCell margin={r.margin} />
    </tr>
  );

  const renderCatRow = (g: ProfitAggregateRow) => {
    const ci = allCategories.indexOf(g.key);
    const clr = CAT_COLORS[ci] ?? '#888';
    return (
      <tr key={g.key}>
        <td>
          <div className="pr-group-label">
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: clr, flexShrink: 0 }} />
            <span style={{ fontWeight: 500 }}>{g.key}</span>
          </div>
        </td>
        <td className="num" style={{ color: 'var(--text-muted)' }}>
          {g.count}
        </td>
        <td className="num" style={{ fontWeight: 500 }}>
          {fmtNum(g.qty)}
        </td>
        <td className="num" style={{ color: 'var(--p600)', fontWeight: 500 }}>
          {fmtBaht(g.revenue)}
        </td>
        <td className="num" style={{ color: 'var(--warn)' }}>
          {fmtBaht(g.cogs)}
        </td>
        <td className="num" style={{ color: g.profit >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 500 }}>
          {fmtBaht(g.profit)}
        </td>
        <MarginCell margin={g.margin} />
      </tr>
    );
  };

  const renderProductRow = (g: ProfitAggregateRow) => (
    <tr key={g.key}>
      <td>
        <div className="pr-prod-cell">
          <div className="pr-prod-icon" style={{ background: g.iconBg }}>
            {g.emoji}
          </div>
          <div>
            <div style={{ fontWeight: 500, fontSize: 13 }}>{g.productName}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{g.productSku}</div>
          </div>
        </div>
      </td>
      <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{g.category}</td>
      <td className="num" style={{ color: 'var(--text-muted)' }}>
        {g.count}
      </td>
      <td className="num" style={{ fontWeight: 500 }}>
        {fmtNum(g.qty)}
      </td>
      <td className="num" style={{ color: 'var(--p600)', fontWeight: 500 }}>
        {fmtBaht(g.revenue)}
      </td>
      <td className="num" style={{ color: 'var(--warn)' }}>
        {fmtBaht(g.cogs)}
      </td>
      <td className="num" style={{ color: g.profit >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 500 }}>
        {fmtBaht(g.profit)}
      </td>
      <MarginCell margin={g.margin} />
    </tr>
  );

  const renderCustomerRow = (g: ProfitAggregateRow, i: number) => {
    const globalIdx = (tablePage - 1) * PAGE_SIZE + i;
    return (
      <tr key={g.key}>
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`pr-rank-num ${rankCls(globalIdx)}`}>{globalIdx + 1}</span>
            <span style={{ fontWeight: 500, fontSize: 13 }}>{g.key}</span>
          </div>
        </td>
        <td className="num" style={{ color: 'var(--text-muted)' }}>
          {g.bills}
        </td>
        <td className="num" style={{ color: 'var(--text-muted)' }}>
          {g.count}
        </td>
        <td className="num" style={{ fontWeight: 500 }}>
          {fmtNum(g.qty)}
        </td>
        <td className="num" style={{ color: 'var(--p600)', fontWeight: 500 }}>
          {fmtBaht(g.revenue)}
        </td>
        <td className="num" style={{ color: 'var(--warn)' }}>
          {fmtBaht(g.cogs)}
        </td>
        <td className="num" style={{ color: g.profit >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 500 }}>
          {fmtBaht(g.profit)}
        </td>
        <MarginCell margin={g.margin} />
      </tr>
    );
  };

  const rowCountLabel =
    groupBy === 'bill'
      ? `(${filteredData.length} รายการ)`
      : `(${sortedAggRows.length} กลุ่ม จาก ${filteredData.length} รายการ)`;

  return (
    <div className="pr-page">
      <div className="pr-topbar">
        <div className="pr-topbar-icon">
          <i className="ti ti-chart-bar" aria-hidden="true" />
        </div>
        <div className="pr-topbar-center">
          <div className="pr-topbar-title">รายงานกำไร</div>
          <div className="pr-topbar-sub">Sales &amp; Profit Report — FIFO Costing</div>
        </div>
        <span className="pr-branch-badge">
          <i className="ti ti-map-pin" style={{ fontSize: 12 }} aria-hidden="true" />
          สาขา: {branchDisplay}
        </span>
      </div>

      <div className="pr-content">
        <div className="pr-toolbar">
          <button
            type="button"
            className={`pr-btn-picker${selectedProducts.size > 0 ? ' has-sel' : ''}`}
            onClick={() => setPickerOpen(true)}
          >
            <i className="ti ti-package" style={{ fontSize: 14 }} aria-hidden="true" />
            {pickerLabel}
          </button>
          <div className="pr-search-wrap">
            <i className="ti ti-search" aria-hidden="true" />
            <input
              type="text"
              placeholder="ค้นหาสินค้า / บิล..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select className="pr-sel" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            <option value="bill">จัดกลุ่ม: รายบิล</option>
            <option value="cat">จัดกลุ่ม: หมวดหมู่</option>
            <option value="product">จัดกลุ่ม: สินค้า</option>
            <option value="customer">จัดกลุ่ม: ลูกค้า</option>
          </select>
          <select className="pr-sel" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">ทุกหมวดหมู่</option>
            {allCategories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <div className="pr-date-range">
            <i className="ti ti-calendar" style={{ fontSize: 14 }} aria-hidden="true" />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setActivePreset('');
              }}
            />
            <span>—</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setActivePreset('');
              }}
            />
          </div>
          <div className="pr-preset-chips">
            {PRESET_CHIPS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`pr-chip${activePreset === p.id ? ' active' : ''}`}
                onClick={() => applyPreset(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="pr-btn pr-btn-ghost pr-btn-sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => {
              exportProfitCsv(filteredData);
              setToast({ msg: 'Export CSV เรียบร้อย', type: 'success' });
            }}
          >
            <i className="ti ti-download" aria-hidden="true" /> Export CSV
          </button>
        </div>

        {loading ? (
          <div className="pr-loading">กำลังโหลดข้อมูล...</div>
        ) : error ? (
          <div className="pr-loading" style={{ color: 'var(--danger)' }}>
            โหลดข้อมูลไม่สำเร็จ: {error.message}
          </div>
        ) : (
          <>
            <div className="pr-kpi-grid">
              <div className="pr-kpi-card pr-kpi-primary">
                <i className="pr-kpi-icon ti ti-coin" aria-hidden="true" />
                <div className="pr-kpi-label">
                  <i className="ti ti-coin" style={{ fontSize: 13 }} aria-hidden="true" />
                  ยอดขายรวม
                </div>
                <div className="pr-kpi-num">{fmtBaht(kpi.revenue)}</div>
                <div className="pr-kpi-sub">
                  {kpi.bills} บิล · {kpi.lineCount} รายการ
                </div>
                <span className="pr-kpi-chip pr-chip-up">
                  <i className="ti ti-arrow-up" aria-hidden="true" />
                  +12.4% vs เดือนก่อน
                </span>
              </div>
              <div className="pr-kpi-card pr-kpi-warn">
                <i className="pr-kpi-icon ti ti-box" aria-hidden="true" />
                <div className="pr-kpi-label">
                  <i className="ti ti-box" style={{ fontSize: 13 }} aria-hidden="true" />
                  ต้นทุน FIFO
                </div>
                <div className="pr-kpi-num">{fmtBaht(kpi.cogs)}</div>
                <div className="pr-kpi-sub">COGS จากการตัด Lot FIFO</div>
                <span className="pr-kpi-chip" style={{ background: 'var(--warn-bg)', color: 'var(--warn)' }}>
                  {fmtPct(kpi.revenue > 0 ? (kpi.cogs / kpi.revenue) * 100 : 0)} ของยอดขาย
                </span>
              </div>
              <div className="pr-kpi-card pr-kpi-success">
                <i className="pr-kpi-icon ti ti-trending-up" aria-hidden="true" />
                <div className="pr-kpi-label">
                  <i className="ti ti-trending-up" style={{ fontSize: 13 }} aria-hidden="true" />
                  กำไรขั้นต้น
                </div>
                <div className="pr-kpi-num">{fmtBaht(kpi.profit)}</div>
                <div className="pr-kpi-sub">Gross Profit หลังหัก COGS</div>
                <span className={`pr-kpi-chip ${kpi.profit >= 0 ? 'pr-chip-up' : 'pr-chip-dn'}`}>
                  <i className={`ti ti-arrow-${kpi.profit >= 0 ? 'up' : 'down'}`} aria-hidden="true" />
                  {kpi.profit >= 0 ? '+' : ''}
                  {fmtBaht(kpi.profit)}
                </span>
              </div>
              <div className="pr-kpi-card pr-kpi-info">
                <i className="pr-kpi-icon ti ti-percentage" aria-hidden="true" />
                <div className="pr-kpi-label">
                  <i className="ti ti-percentage" style={{ fontSize: 13 }} aria-hidden="true" />
                  Gross Margin
                </div>
                <div className="pr-kpi-num">{fmtPct(kpi.margin)}</div>
                <div className="pr-kpi-sub">กำไรขั้นต้น / ยอดขาย</div>
                <span
                  className={`pr-kpi-chip ${kpi.margin >= 20 ? 'pr-chip-up' : kpi.margin >= 10 ? '' : 'pr-chip-dn'}`}
                  style={
                    kpi.margin >= 10 && kpi.margin < 20
                      ? { background: 'var(--warn-bg)', color: 'var(--warn)' }
                      : undefined
                  }
                >
                  {kpi.margin >= 20 ? '✓ ดี' : kpi.margin >= 10 ? '⚠ ปานกลาง' : '✗ ต่ำ'}
                </span>
              </div>
            </div>

            <div className="pr-chart-grid">
              <div className="pr-chart-box">
                <div className="pr-chart-title">
                  <i className="ti ti-chart-bar" aria-hidden="true" />
                  {barChartTitle}
                </div>
                <div className="pr-chart-canvas-wrap">
                  <Bar
                    data={barChartJs}
                    options={{
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                        legend: {
                          position: 'top',
                          labels: { font: { size: 11, family: 'Prompt' }, boxWidth: 10, padding: 12 },
                        },
                        tooltip: {
                          callbacks: {
                            label: (c) => `${c.dataset.label}: ${fmtBaht(Number(c.raw))}`,
                          },
                        },
                      },
                      scales: {
                        x: {
                          ticks: { font: { size: 10 }, color: '#9CA3AF', maxRotation: 45 },
                          grid: { display: false },
                        },
                        y: {
                          ticks: {
                            callback: (v) =>
                              Number(v) >= 1000 ? `฿${(Number(v) / 1000).toFixed(0)}k` : `฿${v}`,
                            font: { size: 10 },
                            color: '#9CA3AF',
                          },
                          grid: { color: 'rgba(0,0,0,0.04)' },
                        },
                      },
                    }}
                  />
                </div>
              </div>
              <div className="pr-chart-box">
                <div className="pr-chart-title">
                  <i className="ti ti-chart-donut" aria-hidden="true" />
                  สัดส่วนกำไรตามหมวด
                </div>
                <div className="pr-chart-canvas-wrap">
                  {donutData.labels.length > 0 ? (
                    <Doughnut
                      data={donutChartJs}
                      options={{
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                          legend: { display: false },
                          tooltip: {
                            callbacks: {
                              label: (c) => `${c.label}: ${fmtBaht(Number(c.raw))}`,
                            },
                          },
                        },
                        cutout: '68%',
                      }}
                    />
                  ) : null}
                </div>
                <div className="pr-donut-legend">
                  {donutData.labels.map((l, i) => (
                    <div key={l} className="pr-legend-row">
                      <div className="pr-legend-dot" style={{ background: donutData.colors[i] }} />
                      <span className="pr-legend-lbl">{l}</span>
                      <span className="pr-legend-val">{fmtBaht(donutData.values[i]!)}</span>
                      <span className="pr-legend-pct">
                        {donutData.total > 0 ? fmtPct((donutData.values[i]! / donutData.total) * 100) : '-'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="pr-chart-box" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <div className="pr-chart-title">
                  <i className="ti ti-crown" aria-hidden="true" />
                  Top 5 ลูกค้ากำไรสูงสุด
                </div>
                <div className="pr-top5-list">
                  {top5.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>
                      ไม่มีข้อมูล
                    </div>
                  ) : (
                    top5.map((c, i) => {
                      const pct = top5[0]!.profit > 0 ? Math.max(4, (c.profit / top5[0]!.profit) * 100) : 4;
                      return (
                        <div key={c.name} className="pr-top5-item">
                          <div className="pr-top5-item-top">
                            <div className="pr-top5-item-name">
                              <span className={`pr-rank-num ${rankCls(i)}`}>{i + 1}</span>
                              <span title={c.name}>{c.name}</span>
                            </div>
                            <span className="pr-top5-item-rev">ยอดขาย: {fmtBaht(c.revenue)}</span>
                          </div>
                          <div className="pr-top5-item-bar-row">
                            <div className="pr-top5-bar-bg">
                              <div className="pr-top5-bar-fill" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="pr-top5-profit">กำไร: {fmtBaht(c.profit)}</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            <div className="pr-card">
              <div className="pr-card-head">
                <i className="ti ti-receipt" aria-hidden="true" />
                <span>{TABLE_LABELS[groupBy]}</span>
                <span style={{ marginLeft: 4, fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>
                  {rowCountLabel}
                </span>
              </div>
              <div className="pr-table-scroll">
                <table>
                  <thead>
                    {groupBy === 'bill' ? (
                      <tr>
                        <SortTh label="วันที่/เวลา" field="date" active={sortField === 'date'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="บิลอ้างอิง" field="bill" active={sortField === 'bill'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="ลูกค้า" field="customer" active={sortField === 'customer'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="สินค้า" field="product" active={sortField === 'product'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="Qty" field="qty" isNum active={sortField === 'qty'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="ยอดขาย" field="revenue" isNum active={sortField === 'revenue'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="COGS" field="cogs" isNum active={sortField === 'cogs'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="กำไร" field="profit" isNum active={sortField === 'profit'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="Margin %" field="margin" isNum active={sortField === 'margin'} dir={sortDir} onSort={handleSort} />
                      </tr>
                    ) : groupBy === 'cat' ? (
                      <tr>
                        <SortTh label="หมวดหมู่" field="cat" active={sortField === 'cat'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="รายการ" field="count" isNum active={sortField === 'count'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="Qty รวม" field="qty" isNum active={sortField === 'qty'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="ยอดขายรวม" field="revenue" isNum active={sortField === 'revenue'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="COGS รวม" field="cogs" isNum active={sortField === 'cogs'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="กำไรรวม" field="profit" isNum active={sortField === 'profit'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="Margin %" field="margin" isNum active={sortField === 'margin'} dir={sortDir} onSort={handleSort} />
                      </tr>
                    ) : groupBy === 'product' ? (
                      <tr>
                        <SortTh label="สินค้า" field="product" active={sortField === 'product'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="หมวดหมู่" field="cat" active={sortField === 'cat'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="รายการ" field="count" isNum active={sortField === 'count'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="Qty รวม" field="qty" isNum active={sortField === 'qty'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="ยอดขายรวม" field="revenue" isNum active={sortField === 'revenue'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="COGS รวม" field="cogs" isNum active={sortField === 'cogs'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="กำไรรวม" field="profit" isNum active={sortField === 'profit'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="Margin %" field="margin" isNum active={sortField === 'margin'} dir={sortDir} onSort={handleSort} />
                      </tr>
                    ) : (
                      <tr>
                        <SortTh label="ลูกค้า" field="customer" active={sortField === 'customer'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="บิล" field="bills" isNum active={sortField === 'bills'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="รายการ" field="count" isNum active={sortField === 'count'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="Qty รวม" field="qty" isNum active={sortField === 'qty'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="ยอดขายรวม" field="revenue" isNum active={sortField === 'revenue'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="COGS รวม" field="cogs" isNum active={sortField === 'cogs'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="กำไรรวม" field="profit" isNum active={sortField === 'profit'} dir={sortDir} onSort={handleSort} />
                        <SortTh label="Margin %" field="margin" isNum active={sortField === 'margin'} dir={sortDir} onSort={handleSort} />
                      </tr>
                    )}
                  </thead>
                  <tbody>
                    {filteredData.length === 0 ? (
                      <tr>
                        <td colSpan={groupBy === 'bill' ? 9 : groupBy === 'cat' ? 7 : 8}>
                          <div className="pr-empty-state">
                            <i className="ti ti-receipt-off" aria-hidden="true" />
                            <p>ไม่พบรายการในช่วงที่เลือก</p>
                          </div>
                        </td>
                      </tr>
                    ) : groupBy === 'bill' ? (
                      (pageRows as ProfitSaleLine[]).map(renderBillRow)
                    ) : groupBy === 'cat' ? (
                      (pageRows as ProfitAggregateRow[]).map(renderCatRow)
                    ) : groupBy === 'product' ? (
                      (pageRows as ProfitAggregateRow[]).map(renderProductRow)
                    ) : (
                      (pageRows as ProfitAggregateRow[]).map(renderCustomerRow)
                    )}
                  </tbody>
                </table>
              </div>
              <PaginationBar total={tableRows.length} page={tablePage} onPage={setTablePage} />
            </div>
          </>
        )}
      </div>

      <div className="pr-footer">
        <div className="pr-footer-stat">
          <span className="pr-footer-num" style={{ color: 'var(--p600)' }}>
            {kpi.bills}
          </span>
          <span className="pr-footer-lbl">จำนวนบิล</span>
        </div>
        <div className="pr-footer-stat">
          <span className="pr-footer-num">{fmtBaht(kpi.revenue)}</span>
          <span className="pr-footer-lbl">ยอดขายรวม</span>
        </div>
        <div className="pr-footer-stat">
          <span className="pr-footer-num" style={{ color: 'var(--warn)' }}>
            {fmtBaht(kpi.cogs)}
          </span>
          <span className="pr-footer-lbl">ต้นทุนรวม</span>
        </div>
        <div className="pr-footer-stat">
          <span className="pr-footer-num" style={{ color: kpi.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
            {fmtBaht(kpi.profit)}
          </span>
          <span className="pr-footer-lbl">กำไรรวม</span>
        </div>
        <div className="pr-footer-stat">
          <span className="pr-footer-num" style={{ color: 'var(--info)' }}>
            {fmtPct(kpi.margin)}
          </span>
          <span className="pr-footer-lbl">Margin เฉลี่ย</span>
        </div>
        <div className="pr-footer-spacer" />
        <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-clock" aria-hidden="true" />
          {clock}
        </span>
      </div>

      <ProductPickerModal
        open={pickerOpen}
        products={allProducts}
        categories={allCategories}
        selected={selectedProducts}
        onClose={() => setPickerOpen(false)}
        onConfirm={(sel) => {
          setSelectedProducts(sel);
          setPickerOpen(false);
          if (sel.size > 0) {
            setToast({ msg: `กรองเฉพาะ ${sel.size} สินค้าที่เลือก`, type: 'info' });
          }
        }}
      />

      {toast ? (
        <div className="pr-toast-wrap">
          <div className={`pr-toast ${toast.type}`}>
            <i className="ti ti-circle-check" aria-hidden="true" /> {toast.msg}
          </div>
        </div>
      ) : null}
    </div>
  );
}
