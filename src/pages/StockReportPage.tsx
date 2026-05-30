import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Tooltip,
} from 'chart.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bar, Doughnut } from 'react-chartjs-2';
import FifoQueueModal from '../components/inventory/FifoQueueModal';
import ProductImageThumb from '../components/products/ProductImageThumb';
import ProductPickerDialog from '../components/products/ProductPickerDialog';
import { formatFifoLotDate, formatFifoLotExpiry } from '../lib/inventory/fifoQueueUtils';
import { EXPIRY_ALERT_LABELS, type ExpiryAlertLevel } from '../lib/inventory/expiryPolicyTypes';
import {
  buildFifoTableRows,
  countSystemActiveLots,
  fifoHasActiveToolbarFilters,
  safeLotRemaining,
} from '../lib/inventory/fifoTableUtils';
import { useExpiryPolicies } from '../lib/inventory/useExpiryPolicies';
import { downloadCsv } from '../lib/stockReport/exportCsv';
import {
  datePresetLabel,
  getDateRange,
  type DatePreset,
} from '../lib/salesHistory/types';
import {
  applyCogsRange,
  useStockReport,
} from '../lib/stockReport/useStockReport';
import {
  CAT_COLORS,
  categoryValues,
  computeOverviewMetrics,
  fmtBaht,
  fmtNum,
  inDateRange,
  monthStartIso,
  stockStatus,
  todayIso,
  tsToDate,
  type StockReportProduct,
  type StockStatus,
  type StockTab,
} from '../lib/stockReport/types';
import { useAuth } from '../lib/hooks/useAuth';
import './StockReportPage.css';

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend);

// Compact ฿ axis labels (e.g. ฿1.5M, ฿50k) so large valuations don't squish the chart.
function compactBahtAxis(value: number | string): string {
  const n = Number(value);
  if (n >= 1_000_000) return `฿${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `฿${Math.round(n / 1_000)}k`;
  return `฿${n}`;
}

// Date Range Picker mirroring the /sales-history dropdown: preset shortcuts on
// top + a custom range at the bottom. The parent keeps the resolved from/to ISO
// strings (which drive the existing filters); selecting a preset resolves the
// concrete range via the shared getDateRange helper.
function DateRangeDropdown({
  preset,
  from,
  to,
  onChange,
}: {
  preset: DatePreset;
  from: string;
  to: string;
  onChange: (next: { preset: DatePreset; from: string; to: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const ddRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const label =
    preset === 'custom'
      ? from && to
        ? `${from} – ${to}`
        : 'ทั้งหมด'
      : datePresetLabel(preset);

  const pickPreset = (key: DatePreset) => {
    const range = getDateRange(key, from, to);
    onChange({
      preset: key,
      from: range.start.toISOString().slice(0, 10),
      to: range.end.toISOString().slice(0, 10),
    });
    setOpen(false);
  };

  return (
    <div className="sr-date-dd" ref={ddRef}>
      <button
        type="button"
        className="sr-date-dd-btn"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <i className="ti ti-calendar" aria-hidden="true" />
        <span>{label}</span>
        <i className="ti ti-chevron-down" style={{ fontSize: 10 }} aria-hidden="true" />
      </button>
      {open && (
        <div className="sr-date-dd-menu">
          {(
            [
              ['today', 'วันนี้'],
              ['yesterday', 'เมื่อวาน'],
              ['7d', '7 วันล่าสุด'],
              ['30d', '30 วันล่าสุด'],
              ['month', 'เดือนนี้'],
            ] as const
          ).map(([key, lbl]) => (
            <button
              key={key}
              type="button"
              className={`sr-date-menu-item${preset === key ? ' on' : ''}`}
              onClick={() => pickPreset(key)}
            >
              {lbl}
            </button>
          ))}
          <div className="sr-date-custom-label">กำหนดเอง</div>
          <div className="sr-date-custom">
            <input
              type="date"
              value={from}
              onChange={(e) => onChange({ preset: 'custom', from: e.target.value, to })}
            />
            <input
              type="date"
              value={to}
              onChange={(e) => onChange({ preset: 'custom', from, to: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const MV_META = {
  in: { icon: 'ti-arrow-bar-to-down', cls: 'sr-mv-in', label: 'รับเข้า', clr: '#3B6D11' },
  out: { icon: 'ti-arrow-bar-up', cls: 'sr-mv-out', label: 'ตัดออก', clr: '#534AB7' },
  adj: { icon: 'ti-adjustments-alt', cls: 'sr-mv-adj', label: 'ปรับสต็อก', clr: '#185FA5' },
  void: { icon: 'ti-arrow-back-up', cls: 'sr-mv-void', label: 'Void คืน', clr: '#A32D2D' },
} as const;

function StatusBadge({ status }: { status: StockStatus }) {
  const map = {
    ok: ['sr-badge-ok', 'ปกติ'],
    low: ['sr-badge-low', 'ต่ำ'],
    critical: ['sr-badge-critical', 'วิกฤต'],
    oos: ['sr-badge-oos', 'หมด'],
  } as const;
  const [cls, label] = map[status];
  return <span className={`sr-badge ${cls}`}>{label}</span>;
}

function ExpiryAlertBadge({
  level,
  daysLeft,
}: {
  level: ExpiryAlertLevel;
  daysLeft: number | null;
}) {
  const map = {
    safe: 'sr-expiry-safe',
    warning: 'sr-expiry-warning',
    critical: 'sr-expiry-critical',
  } as const;
  const detail =
    daysLeft == null
      ? null
      : daysLeft < 0
        ? `หมดอายุ ${Math.abs(daysLeft)} วัน`
        : `${daysLeft} วัน`;
  return (
    <span className={`sr-expiry-badge ${map[level] ?? map.safe}`}>
      {EXPIRY_ALERT_LABELS[level] ?? EXPIRY_ALERT_LABELS.safe}
      {detail ? ` · ${detail}` : ''}
    </span>
  );
}

function stockBarClass(status: StockStatus): string {
  if (status === 'ok') return 'sr-bar-ok';
  if (status === 'low') return 'sr-bar-low';
  return 'sr-bar-critical';
}

type StockProductSortKey = 'name' | 'sku' | 'qty' | 'stockValue' | 'avgCost' | 'cogs' | 'category';
type LowStockSortKey = 'name' | 'sku' | 'qty' | 'reorderPoint' | 'avgCost' | 'stockValue';
type SortDirection = 'asc' | 'desc';

function sortStockProducts<T extends StockReportProduct>(
  list: T[],
  key: StockProductSortKey,
  direction: SortDirection,
): T[] {
  const mult = direction === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    let av: string | number;
    let bv: string | number;
    switch (key) {
      case 'name':
        av = a.name.toLowerCase();
        bv = b.name.toLowerCase();
        break;
      case 'sku':
        av = a.sku.toLowerCase();
        bv = b.sku.toLowerCase();
        break;
      case 'qty':
        av = a.qty;
        bv = b.qty;
        break;
      case 'stockValue':
        av = a.stockValue;
        bv = b.stockValue;
        break;
      case 'avgCost':
        av = a.avgCost;
        bv = b.avgCost;
        break;
      case 'cogs':
        av = a.cogsMonth;
        bv = b.cogsMonth;
        break;
      case 'category':
        av = a.category.toLowerCase();
        bv = b.category.toLowerCase();
        break;
      default:
        return 0;
    }
    if (av < bv) return -1 * mult;
    if (av > bv) return 1 * mult;
    return 0;
  });
}

function sortLowStockProducts(
  list: StockReportProduct[],
  key: LowStockSortKey,
  direction: SortDirection,
): StockReportProduct[] {
  const mult = direction === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    let av: string | number;
    let bv: string | number;
    switch (key) {
      case 'name':
        av = a.name.toLowerCase();
        bv = b.name.toLowerCase();
        break;
      case 'sku':
        av = a.sku.toLowerCase();
        bv = b.sku.toLowerCase();
        break;
      case 'qty':
        av = a.qty;
        bv = b.qty;
        break;
      case 'reorderPoint':
        av = a.reorderPoint;
        bv = b.reorderPoint;
        break;
      case 'avgCost':
        av = a.avgCost;
        bv = b.avgCost;
        break;
      case 'stockValue':
        av = a.stockValue;
        bv = b.stockValue;
        break;
      default:
        return 0;
    }
    if (av < bv) return -1 * mult;
    if (av > bv) return 1 * mult;
    return 0;
  });
}

function SortableTh({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  className,
}: {
  label: string;
  sortKey: string;
  activeKey: string;
  direction: SortDirection;
  onSort: (key: string) => void;
  className?: string;
}) {
  const active = activeKey === sortKey;
  const icon = !active ? 'ti-arrows-sort' : direction === 'asc' ? 'ti-arrow-up' : 'ti-arrow-down';
  return (
    <th
      className={`sr-sort-th${className ? ` ${className}` : ''}${active ? ' sr-sort-active' : ''}`}
      onClick={() => onSort(sortKey)}
      onKeyDown={(e) => e.key === 'Enter' && onSort(sortKey)}
      role="button"
      tabIndex={0}
    >
      {label}
      <i className={`ti ${icon} sr-sort-icon`} aria-hidden="true" />
    </th>
  );
}

export default function StockReportPage({ branchId: branchIdProp }: { branchId?: string } = {}) {
  // When embedded (e.g. Admin), a branchId prop overrides the auth branch.
  // This is the ONLY change to source — the core useStockReport logic is untouched.
  const { branchId: authBranchId } = useAuth();
  const branchId = branchIdProp ?? authBranchId;
  const { policies: expiryPolicies, defaultPolicy } = useExpiryPolicies();
  const { products, movements, categories, loading } = useStockReport(branchId);

  const [tab, setTab] = useState<StockTab>('overview');
  // Overview COGS window is fixed to the current month (the picker was removed for a cleaner UI).
  const ovFrom = monthStartIso();
  const ovTo = todayIso();
  const [prodSearch, setProdSearch] = useState('');
  const [prodCat, setProdCat] = useState('');
  const [prodStockFilter, setProdStockFilter] = useState<'' | 'low' | 'out'>('');
  const [prodPickedIds, setProdPickedIds] = useState<Set<string>>(new Set());
  const [showProdPicker, setShowProdPicker] = useState(false);
  const [productSort, setProductSort] = useState<{ key: StockProductSortKey; direction: SortDirection }>({
    key: 'stockValue',
    direction: 'desc',
  });
  const [lowStockSort, setLowStockSort] = useState<{ key: LowStockSortKey; direction: SortDirection }>({
    key: 'qty',
    direction: 'asc',
  });
  const [fifoPickedIds, setFifoPickedIds] = useState<Set<string>>(new Set());
  const [showFifoPicker, setShowFifoPicker] = useState(false);
  const [fifoSearch, setFifoSearch] = useState('');
  const [fifoCat, setFifoCat] = useState('');
  const [fifoExpiryFilter, setFifoExpiryFilter] = useState<'' | ExpiryAlertLevel>('');
  const [fifoFrom, setFifoFrom] = useState('');
  const [fifoTo, setFifoTo] = useState('');
  const [fifoDatePreset, setFifoDatePreset] = useState<DatePreset>('custom');
  const [mvSearch, setMvSearch] = useState('');
  const [mvCat, setMvCat] = useState('');
  const [mvType, setMvType] = useState('');
  const [mvFrom, setMvFrom] = useState(monthStartIso());
  const [mvTo, setMvTo] = useState(todayIso());
  const [mvDatePreset, setMvDatePreset] = useState<DatePreset>('month');
  const [fifoModalProduct, setFifoModalProduct] = useState<StockReportProduct | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const productsWithCogs = useMemo(
    () => applyCogsRange(products, movements, ovFrom, ovTo),
    [products, movements, ovFrom, ovTo],
  );

  const overviewMetrics = useMemo(() => {
    const cogs = productsWithCogs.reduce((s, p) => s + p.cogsMonth, 0);
    return computeOverviewMetrics(productsWithCogs, cogs);
  }, [productsWithCogs]);

  const lowStockProducts = useMemo(
    () =>
      productsWithCogs.filter((p) => {
        if (p.muteAlerts) return false;
        const st = stockStatus(p.qty, p.reorderPoint);
        return st !== 'ok';
      }),
    [productsWithCogs],
  );

  const handleProductSort = (key: StockProductSortKey) => {
    setProductSort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { key, direction: 'asc' };
    });
  };

  const handleLowStockSort = (key: LowStockSortKey) => {
    setLowStockSort((prev) => {
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

  const sortedLowStockProducts = useMemo(
    () => sortLowStockProducts(lowStockProducts, lowStockSort.key, lowStockSort.direction),
    [lowStockProducts, lowStockSort],
  );

  const fifoSystemActiveLotCount = useMemo(
    () => countSystemActiveLots(productsWithCogs),
    [productsWithCogs],
  );

  const fifoTableRows = useMemo(
    () =>
      buildFifoTableRows({
        products: productsWithCogs,
        policies: expiryPolicies,
        search: fifoSearch,
        category: fifoCat,
        pickedProductIds: fifoPickedIds,
        receivedFrom: fifoFrom,
        receivedTo: fifoTo,
        expiryFilter: fifoExpiryFilter,
      }),
    [
      productsWithCogs,
      expiryPolicies,
      fifoSearch,
      fifoCat,
      fifoPickedIds,
      fifoFrom,
      fifoTo,
      fifoExpiryFilter,
    ],
  );

  const fifoToolbarFiltered = useMemo(
    () =>
      fifoHasActiveToolbarFilters({
        search: fifoSearch,
        category: fifoCat,
        pickedProductIds: fifoPickedIds,
        receivedFrom: fifoFrom,
        receivedTo: fifoTo,
        expiryFilter: fifoExpiryFilter,
      }),
    [fifoSearch, fifoCat, fifoPickedIds, fifoFrom, fifoTo, fifoExpiryFilter],
  );

  const fifoMetrics = useMemo(() => {
    const lotCount = fifoTableRows.length;
    const totalQty = fifoTableRows.reduce((s, r) => s + safeLotRemaining(r.lot), 0);
    const totalValue = fifoTableRows.reduce(
      (s, r) => s + safeLotRemaining(r.lot) * (Number(r.lot.costPerUnit) || 0),
      0,
    );
    const criticalCount = fifoTableRows.filter((r) => r.alertLevel === 'critical').length;
    return { lotCount, totalQty, totalValue, criticalCount };
  }, [fifoTableRows]);

  const filteredMovements = useMemo(() => {
    const q = mvSearch.trim().toLowerCase();
    return movements.filter((m) => {
      const mq = !q || `${m.productName}${m.productSku}${m.refId}`.toLowerCase().includes(q);
      const mc = !mvCat || products.find((p) => p.id === m.productId)?.category === mvCat;
      const mt = !mvType || m.displayType === mvType;
      const md = inDateRange(tsToDate(m.createdAt), mvFrom, mvTo);
      return mq && mc && mt && md;
    });
  }, [movements, mvSearch, mvCat, mvType, mvFrom, mvTo, products]);

  const catMap = useMemo(() => categoryValues(productsWithCogs), [productsWithCogs]);
  const catLabels = Object.keys(catMap);
  const catVals = catLabels.map((k) => catMap[k]!);

  const topProducts = useMemo(
    () => [...productsWithCogs].sort((a, b) => b.stockValue - a.stockValue).slice(0, 8),
    [productsWithCogs],
  );

  const exportStockCsv = () => {
    const rows = [
      ['SKU', 'ชื่อสินค้า', 'หมวดหมู่', 'คงเหลือ', 'Avg Cost', 'COGS', 'มูลค่าสต็อก', 'สถานะ'],
      ...productsWithCogs.map((p) => [
        p.sku,
        p.name,
        p.category,
        String(p.qty),
        String(p.avgCost),
        String(p.cogsMonth),
        String(p.stockValue),
        stockStatus(p.qty, p.reorderPoint),
      ]),
    ];
    downloadCsv(rows, 'stock_report');
    setToast('Export Stock Report เรียบร้อย');
    window.setTimeout(() => setToast(null), 2600);
  };

  const exportMovementCsv = () => {
    const rows = [
      ['Date', 'Time', 'SKU', 'Product', 'Type', 'Qty', 'Cost/Unit', 'Value', 'Ref', 'By'],
      ...filteredMovements.map((m) => {
        const d = tsToDate(m.createdAt);
        return [
          d.toLocaleDateString('th-TH'),
          d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
          m.productSku,
          m.productName,
          m.displayType,
          String(m.qty),
          String(m.costPerUnit),
          String(Math.abs(m.qty) * m.costPerUnit),
          m.refId,
          m.staffName,
        ];
      }),
    ];
    downloadCsv(rows, 'stock_movement');
    setToast('Export Movement เรียบร้อย');
    window.setTimeout(() => setToast(null), 2600);
  };

  if (loading) {
    return <div className="sr-page sr-loading">กำลังโหลดรายงานสต็อก...</div>;
  }

  return (
    <div className="sr-page">
      <header className="sr-topbar">
        <div className="sr-topbar-icon">
          <i className="ti ti-package" aria-hidden="true" />
        </div>
        <div className="sr-topbar-center">
          <div className="sr-topbar-title">รายงานสต็อก &amp; FIFO</div>
          <div className="sr-topbar-sub">Stock Report &amp; FIFO Costing</div>
        </div>
        <button type="button" className="sr-btn sr-btn-ghost sr-btn-sm" onClick={exportStockCsv}>
          <i className="ti ti-download" aria-hidden="true" /> Export
        </button>
      </header>

      <nav className="sr-tabs-bar">
        {(
          [
            ['overview', 'ti-layout-dashboard', 'ภาพรวม', null],
            ['products', 'ti-list', 'รายสินค้า', filteredProducts.length],
            ['fifo', 'ti-stack', 'FIFO Queue', null],
            ['movement', 'ti-arrow-left-right', 'Stock Movement', filteredMovements.length],
          ] as const
        ).map(([key, icon, label, badge]) => (
          <button
            key={key}
            type="button"
            className={`sr-tab-btn${tab === key ? ' active' : ''}`}
            onClick={() => setTab(key)}
          >
            <i className={`ti ${icon}`} aria-hidden="true" />
            {label}
            {badge != null && <span className="sr-tab-badge">{badge}</span>}
          </button>
        ))}
      </nav>

      <div className="sr-content">
        {/* TAB 1 — Overview */}
        <div className={`sr-panel${tab === 'overview' ? ' active' : ''}`}>
          <div className="sr-metrics-grid">
            {[
              {
                label: 'มูลค่าสต็อกรวม',
                icon: 'ti-coins',
                val: fmtBaht(overviewMetrics.totalVal),
                sub: 'ต้นทุนคงเหลือ FIFO',
                clr: 'var(--p600)',
              },
              {
                label: 'COGS ช่วงที่เลือก',
                icon: 'ti-trending-up',
                val: fmtBaht(overviewMetrics.totalCogs),
                sub: 'ต้นทุนสินค้าที่ขาย',
                clr: 'var(--success)',
              },
              {
                label: 'Stock Turnover',
                icon: 'ti-refresh',
                val: `${overviewMetrics.turnover}x`,
                sub: 'รอบ/ปี (annualized)',
                clr: 'var(--info)',
              },
              {
                label: 'Low Stock Alert',
                icon: 'ti-alert-triangle',
                val: String(overviewMetrics.low),
                sub: 'รายการต่ำกว่า Reorder',
                clr: 'var(--warn)',
                chip: overviewMetrics.oos > 0 ? `${overviewMetrics.oos} หมดสต็อก` : null,
              },
              {
                label: 'จำนวน SKU',
                icon: 'ti-box',
                val: String(overviewMetrics.skuCount),
                sub: 'รายการสินค้าทั้งหมด',
                clr: 'var(--text-primary)',
              },
              {
                label: 'Avg Cost / SKU',
                icon: 'ti-calculator',
                val: fmtBaht(
                  overviewMetrics.skuCount
                    ? Math.round(overviewMetrics.totalVal / overviewMetrics.skuCount)
                    : 0,
                ),
                sub: 'มูลค่าเฉลี่ยต่อ SKU',
                clr: 'var(--text-primary)',
              },
            ].map((m) => (
              <div key={m.label} className="sr-metric-card">
                <div className="sr-metric-label">
                  <i className={`ti ${m.icon}`} style={{ color: m.clr, fontSize: 14 }} aria-hidden="true" />
                  {m.label}
                </div>
                <div className="sr-metric-num" style={{ color: m.clr }}>
                  {m.val}
                </div>
                <div className="sr-metric-sub">{m.sub}</div>
                {'chip' in m && m.chip && (
                  <span className="sr-metric-chip sr-chip-warn">
                    <i className="ti ti-alert-triangle" aria-hidden="true" /> {m.chip}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="sr-chart-grid">
            <div className="sr-chart-box">
              <div className="sr-chart-title">
                <i className="ti ti-chart-donut" style={{ color: 'var(--p600)' }} aria-hidden="true" />{' '}
                มูลค่าสินค้าตามหมวดหมู่
              </div>
              {overviewMetrics.totalVal === 0 ? (
                <div className="sr-chart-empty">
                  <i className="ti ti-chart-donut" aria-hidden="true" />
                  <span>ไม่มีข้อมูลมูลค่าสต็อก</span>
                </div>
              ) : (
                <>
                  <div className="sr-chart-wrap">
                    <Doughnut
                      data={{
                        labels: catLabels,
                        datasets: [
                          {
                            data: catVals,
                            backgroundColor: CAT_COLORS,
                            borderWidth: 0,
                          },
                        ],
                      }}
                      options={{
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: { legend: { display: false } },
                        cutout: '68%',
                      }}
                    />
                  </div>
                  <div className="sr-donut-legend">
                    {catLabels.map((l, i) => (
                      <div key={l} className="sr-legend-item">
                        <div className="sr-legend-dot" style={{ background: CAT_COLORS[i] }} />
                        <span className="sr-legend-lbl">{l}</span>
                        <span className="sr-legend-val">{fmtBaht(catVals[i] ?? 0)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="sr-chart-box">
              <div className="sr-chart-title">
                <i className="ti ti-chart-bar" style={{ color: 'var(--p600)' }} aria-hidden="true" />{' '}
                Top 8 สินค้า — มูลค่าสต็อก
              </div>
              {overviewMetrics.totalVal === 0 ? (
                <div className="sr-chart-empty">
                  <i className="ti ti-chart-bar" aria-hidden="true" />
                  <span>ไม่มีข้อมูลมูลค่าสต็อก</span>
                </div>
              ) : (
                <div className="sr-chart-wrap">
                  <Bar
                    data={{
                      labels: topProducts.map((p) =>
                        p.name.length > 18 ? `${p.name.slice(0, 16)}…` : p.name,
                      ),
                      datasets: [
                        {
                          data: topProducts.map((p) => p.stockValue),
                          backgroundColor: '#534AB7',
                          borderRadius: 4,
                        },
                      ],
                    }}
                    options={{
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: { legend: { display: false } },
                      scales: {
                        x: { ticks: { font: { size: 10 } }, grid: { display: false } },
                        y: {
                          ticks: {
                            callback: (v) => compactBahtAxis(v),
                            font: { size: 10 },
                          },
                          grid: { color: 'rgba(0,0,0,0.04)' },
                        },
                      },
                    }}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="sr-card">
            <div className="sr-card-head">
              <i className="ti ti-alert-triangle" style={{ color: 'var(--warn)' }} aria-hidden="true" />
              สินค้าที่ต้องสั่งเพิ่ม (ต่ำกว่า Reorder Point)
              <span className="sr-badge sr-badge-low">{lowStockProducts.length}</span>
            </div>
            <div className="sr-table-scroll">
              <table className="sr-table">
                <thead>
                  <tr>
                    <SortableTh
                      label="สินค้า"
                      sortKey="name"
                      activeKey={lowStockSort.key}
                      direction={lowStockSort.direction}
                      onSort={(k) => handleLowStockSort(k as LowStockSortKey)}
                    />
                    <SortableTh
                      label="รหัส (SKU)"
                      sortKey="sku"
                      activeKey={lowStockSort.key}
                      direction={lowStockSort.direction}
                      onSort={(k) => handleLowStockSort(k as LowStockSortKey)}
                    />
                    <SortableTh
                      label="คงเหลือ"
                      sortKey="qty"
                      activeKey={lowStockSort.key}
                      direction={lowStockSort.direction}
                      onSort={(k) => handleLowStockSort(k as LowStockSortKey)}
                      className="num"
                    />
                    <SortableTh
                      label="Reorder Point"
                      sortKey="reorderPoint"
                      activeKey={lowStockSort.key}
                      direction={lowStockSort.direction}
                      onSort={(k) => handleLowStockSort(k as LowStockSortKey)}
                      className="num"
                    />
                    <SortableTh
                      label="Average Cost"
                      sortKey="avgCost"
                      activeKey={lowStockSort.key}
                      direction={lowStockSort.direction}
                      onSort={(k) => handleLowStockSort(k as LowStockSortKey)}
                      className="num"
                    />
                    <SortableTh
                      label="มูลค่า"
                      sortKey="stockValue"
                      activeKey={lowStockSort.key}
                      direction={lowStockSort.direction}
                      onSort={(k) => handleLowStockSort(k as LowStockSortKey)}
                      className="num"
                    />
                    <th>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedLowStockProducts.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="sr-empty">
                        ทุกรายการมีสต็อกเพียงพอ ✓
                      </td>
                    </tr>
                  ) : (
                    <>
                      {sortedLowStockProducts.slice(0, 10).map((p) => {
                        const st = stockStatus(p.qty, p.reorderPoint);
                        return (
                          <tr key={p.id}>
                            <td>
                              <div className="sr-prod-cell">
                                <ProductImageThumb imageUrl={p.imageUrl} alt={p.name} />
                                <div style={{ fontWeight: 500 }}>{p.name}</div>
                              </div>
                            </td>
                            <td className="sr-col-sku">{p.sku}</td>
                            <td className="num" style={{ fontWeight: 500, color: p.qty === 0 ? 'var(--danger)' : 'var(--warn)' }}>
                              {fmtNum(p.qty)}
                            </td>
                            <td className="num">{fmtNum(p.reorderPoint)}</td>
                            <td className="num">{fmtBaht(p.avgCost)}</td>
                            <td className="num">{fmtBaht(p.stockValue)}</td>
                            <td>
                              <StatusBadge status={st} />
                            </td>
                          </tr>
                        );
                      })}
                      {sortedLowStockProducts.length > 10 && (
                        <tr>
                          <td colSpan={7} className="sr-table-more">
                            มีอีก {sortedLowStockProducts.length - 10} รายการ — ดูทั้งหมดในแท็บ
                            &lsquo;รายสินค้า&rsquo;
                          </td>
                        </tr>
                      )}
                    </>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* TAB 2 — Products */}
        <div className={`sr-panel${tab === 'products' ? ' active' : ''}`}>
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
            <button type="button" className="sr-btn sr-btn-ghost sr-btn-sm" onClick={exportStockCsv}>
              <i className="ti ti-download" aria-hidden="true" /> Export
            </button>
          </div>
          <div className="sr-card">
            <div className="sr-table-scroll">
              <table className="sr-table">
                <thead>
                  <tr>
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
                      className="num"
                    />
                    <SortableTh
                      label="Avg Cost"
                      sortKey="avgCost"
                      activeKey={productSort.key}
                      direction={productSort.direction}
                      onSort={(k) => handleProductSort(k as StockProductSortKey)}
                      className="num"
                    />
                    <SortableTh
                      label="COGS (ช่วงที่เลือก)"
                      sortKey="cogs"
                      activeKey={productSort.key}
                      direction={productSort.direction}
                      onSort={(k) => handleProductSort(k as StockProductSortKey)}
                      className="num"
                    />
                    <SortableTh
                      label="มูลค่าสต็อก"
                      sortKey="stockValue"
                      activeKey={productSort.key}
                      direction={productSort.direction}
                      onSort={(k) => handleProductSort(k as StockProductSortKey)}
                      className="num"
                    />
                    <th>สถานะ</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="sr-empty">
                        ไม่พบสินค้า
                      </td>
                    </tr>
                  ) : (
                    filteredProducts.map((p) => {
                      const st = stockStatus(p.qty, p.reorderPoint);
                      const maxQty = Math.max(...filteredProducts.map((x) => x.qty), 1);
                      const pct = Math.round((p.qty / maxQty) * 100);
                      return (
                        <tr key={p.id}>
                          <td className="sr-col-sku">{p.sku}</td>
                          <td>
                            <div className="sr-prod-cell">
                              <ProductImageThumb imageUrl={p.imageUrl} alt={p.name} />
                              <div style={{ fontWeight: 500 }}>{p.name}</div>
                            </div>
                          </td>
                          <td>
                            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                              {p.category}
                            </span>
                          </td>
                          <td className="num">
                            <div className="sr-stock-bar-wrap">
                              <div className="sr-stock-bar-bg">
                                <div
                                  className={`sr-stock-bar-fill ${stockBarClass(st)}`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="sr-stock-qty">{fmtNum(p.qty)}</span>
                            </div>
                          </td>
                          <td className="num">{fmtBaht(p.avgCost)}</td>
                          <td className="num" style={{ color: 'var(--success)' }}>
                            {fmtBaht(p.cogsMonth)}
                          </td>
                          <td className="num" style={{ fontWeight: 500, color: 'var(--p600)' }}>
                            {fmtBaht(p.stockValue)}
                          </td>
                          <td>
                            <StatusBadge status={st} />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="sr-btn sr-btn-ghost sr-btn-sm"
                              title="ดู FIFO Lot"
                              onClick={() => setFifoModalProduct(p)}
                            >
                              <i className="ti ti-stack" aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* TAB 3 — FIFO Queue */}
        <div className={`sr-panel${tab === 'fifo' ? ' active' : ''}`}>
          <div className="sr-toolbar">
            <select className="sr-sel" value={fifoCat} onChange={(e) => setFifoCat(e.target.value)}>
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
                placeholder="ค้นหาสินค้า..."
                value={fifoSearch}
                onChange={(e) => setFifoSearch(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="sr-btn sr-btn-ghost sr-btn-sm"
              onClick={() => setShowFifoPicker(true)}
            >
              <i className="ti ti-list-search" aria-hidden="true" /> เลือกสินค้า
              {fifoPickedIds.size > 0 ? ` (${fifoPickedIds.size})` : ''}
            </button>
            <DateRangeDropdown
              preset={fifoDatePreset}
              from={fifoFrom}
              to={fifoTo}
              onChange={({ preset, from, to }) => {
                setFifoDatePreset(preset);
                setFifoFrom(from);
                setFifoTo(to);
              }}
            />
            <div className="sr-stock-filter">
              {([
                ['', 'ทั้งหมด'],
                ['safe', 'ปลอดภัย'],
                ['warning', 'เฝ้าระวัง'],
                ['critical', 'วิกฤต'],
              ] as const).map(([val, lbl]) => (
                <button
                  key={val || 'all'}
                  type="button"
                  className={`sr-sf${fifoExpiryFilter === val ? ' sr-on' : ''}`}
                  onClick={() => setFifoExpiryFilter(val)}
                >
                  {lbl}
                </button>
              ))}
            </div>
            <span className="sr-hint">Lot เก่าสุดออกก่อน</span>
          </div>

          {fifoTableRows.length === 0 ? (
            <div className="sr-empty">
              {fifoSystemActiveLotCount > 0
                ? fifoToolbarFiltered
                  ? 'ไม่มี Lot ตรงกับตัวกรองที่เลือก'
                  : 'ไม่สามารถแสดง Lot ได้ — กดรีเฟรชหรือลองอีกครั้ง'
                : productsWithCogs.some((p) => p.qty > 0)
                  ? 'มีสต็อกในระบบแต่ยังไม่พบ Lot — รอการซิงค์หรือกดรีเฟรช'
                  : 'ยังไม่มี Lot คงเหลือในระบบ'}
            </div>
          ) : (
            <>
              <div className="sr-fifo-metrics">
                <div className="sr-metric-card">
                  <div className="sr-metric-label">
                    <i className="ti ti-stack" style={{ color: 'var(--p600)' }} aria-hidden="true" />
                    Lot ในช่วง
                  </div>
                  <div className="sr-metric-num" style={{ color: 'var(--p600)' }}>
                    {fifoMetrics.lotCount}
                  </div>
                  <div className="sr-metric-sub">นโยบายเริ่มต้น: {defaultPolicy.name}</div>
                </div>
                <div className="sr-metric-card">
                  <div className="sr-metric-label">
                    <i className="ti ti-package" style={{ color: 'var(--success)' }} aria-hidden="true" />
                    คงเหลือรวม
                  </div>
                  <div className="sr-metric-num" style={{ color: 'var(--success)' }}>
                    {fmtNum(fifoMetrics.totalQty)}
                  </div>
                  <div className="sr-metric-sub">หน่วย</div>
                </div>
                <div className="sr-metric-card">
                  <div className="sr-metric-label">
                    <i className="ti ti-calculator" style={{ color: 'var(--info)' }} aria-hidden="true" />
                    มูลค่ารวม
                  </div>
                  <div className="sr-metric-num" style={{ color: 'var(--info)' }}>
                    {fmtBaht(Math.round(fifoMetrics.totalValue))}
                  </div>
                  <div className="sr-metric-sub">จาก Lot ที่แสดง</div>
                </div>
                <div className="sr-metric-card">
                  <div className="sr-metric-label">
                    <i className="ti ti-alert-triangle" style={{ color: 'var(--danger)' }} aria-hidden="true" />
                    วิกฤต
                  </div>
                  <div className="sr-metric-num" style={{ color: 'var(--danger)' }}>
                    {fifoMetrics.criticalCount}
                  </div>
                  <div className="sr-metric-sub">Lot ใกล้/เลยหมดอายุ</div>
                </div>
              </div>
              <div className="sr-card">
                <div className="sr-table-scroll">
                  <table className="sr-table sr-fifo-table">
                    <thead>
                      <tr>
                        <th style={{ width: 44 }}>#</th>
                        <th>รหัส (SKU)</th>
                        <th>ชื่อสินค้า</th>
                        <th>Lot / GRN</th>
                        <th>วันรับเข้า</th>
                        <th>วันหมดอายุ</th>
                        <th>สถานะ</th>
                        <th className="num">คงเหลือ</th>
                        <th className="num">ต้นทุน/หน่วย</th>
                        <th className="num">มูลค่า</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fifoTableRows.map((row) => {
                        const { lot, product, fifoIndex, alertLevel, daysLeft } = row;
                        const remain = safeLotRemaining(lot);
                        const received = Number(lot.qtyReceived) || remain;
                        const pct = received > 0 ? Math.round((remain / received) * 100) : 0;
                        return (
                          <tr
                            key={lot.id}
                            className={fifoIndex === 1 ? 'sr-fifo-next-row' : undefined}
                          >
                            <td>
                              <div className={`sr-lot-num${fifoIndex === 1 ? ' next' : ''}`}>
                                {fifoIndex}
                              </div>
                            </td>
                            <td className="sr-col-sku">{product.sku}</td>
                            <td>
                              <div className="sr-prod-cell">
                                <ProductImageThumb
                                  imageUrl={product.imageUrl}
                                  alt={product.name}
                                  variant="thumb"
                                />
                                <div>
                                  <div style={{ fontWeight: 500, fontSize: 13 }}>{product.name}</div>
                                  {fifoIndex === 1 ? (
                                    <span className="sr-next-label">ตัดออกก่อน</span>
                                  ) : null}
                                </div>
                              </div>
                            </td>
                            <td style={{ fontSize: 12 }}>{lot.receivingId || lot.id}</td>
                            <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                              {formatFifoLotDate(lot.receivedAt)}
                            </td>
                            <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                              {formatFifoLotExpiry(lot.expiryDate)}
                            </td>
                            <td>
                              <ExpiryAlertBadge level={alertLevel} daysLeft={daysLeft} />
                            </td>
                            <td className="num">
                              <div style={{ fontWeight: 500 }}>{fmtNum(remain)}</div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                / {fmtNum(received)} ({pct}%)
                              </div>
                            </td>
                            <td className="num">{fmtBaht(Number(lot.costPerUnit) || 0)}</td>
                            <td className="num" style={{ fontWeight: 500, color: 'var(--success)' }}>
                              {fmtBaht(remain * (Number(lot.costPerUnit) || 0))}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>

        {/* TAB 4 — Movement */}
        <div className={`sr-panel${tab === 'movement' ? ' active' : ''}`}>
          <div className="sr-toolbar">
            <select className="sr-sel" value={mvCat} onChange={(e) => setMvCat(e.target.value)}>
              <option value="">ทั้งหมด</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <div className="sr-search-wrap">
              <i className="ti ti-search" aria-hidden="true" />
              <input
                placeholder="ค้นหาสินค้า / เลขที่..."
                value={mvSearch}
                onChange={(e) => setMvSearch(e.target.value)}
              />
            </div>
            <select className="sr-sel" value={mvType} onChange={(e) => setMvType(e.target.value)}>
              <option value="">ทุกประเภท</option>
              <option value="in">รับเข้า</option>
              <option value="out">ตัดออก (ขาย)</option>
              <option value="adj">ปรับสต็อก</option>
              <option value="void">Void คืน</option>
            </select>
            <DateRangeDropdown
              preset={mvDatePreset}
              from={mvFrom}
              to={mvTo}
              onChange={({ preset, from, to }) => {
                setMvDatePreset(preset);
                setMvFrom(from);
                setMvTo(to);
              }}
            />
            <button type="button" className="sr-btn sr-btn-ghost sr-btn-sm" onClick={exportMovementCsv}>
              <i className="ti ti-download" aria-hidden="true" /> Export
            </button>
          </div>
          <div className="sr-card">
            <div className="sr-table-scroll">
              <table className="sr-table">
                <thead>
                  <tr>
                    <th>วันที่/เวลา</th>
                    <th>รหัส (SKU)</th>
                    <th>ชื่อสินค้า</th>
                    <th>ประเภท</th>
                    <th className="num">จำนวน</th>
                    <th className="num">ต้นทุน/หน่วย</th>
                    <th className="num">มูลค่า</th>
                    <th>เอกสารอ้างอิง</th>
                    <th>โดย</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMovements.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="sr-empty">
                        ไม่พบรายการในช่วงวันที่เลือก
                      </td>
                    </tr>
                  ) : (
                    filteredMovements.map((m) => {
                      const meta = MV_META[m.displayType];
                      const d = tsToDate(m.createdAt);
                      const qSign =
                        m.displayType === 'out' || (m.displayType === 'adj' && m.qty < 0)
                          ? '-'
                          : '+';
                      const qClr =
                        m.displayType === 'out' || m.qty < 0 ? 'var(--danger)' : 'var(--success)';
                      return (
                        <tr key={m.id}>
                          <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                            <div style={{ fontWeight: 500 }}>
                              {d.toLocaleTimeString('th-TH', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </div>
                            <div style={{ color: 'var(--text-muted)' }}>
                              {d.toLocaleDateString('th-TH')}
                            </div>
                          </td>
                          <td className="sr-col-sku">{m.productSku}</td>
                          <td>
                            <div className="sr-prod-cell">
                              <ProductImageThumb
                                imageUrl={m.imageUrl}
                                alt={m.productName}
                                variant="thumb"
                              />
                              <div style={{ fontWeight: 500, fontSize: 13 }}>{m.productName}</div>
                            </div>
                          </td>
                          <td>
                            <div className="sr-mv-cell">
                              <div className={`sr-mv-icon ${meta.cls}`}>
                                <i className={`ti ${meta.icon}`} aria-hidden="true" />
                              </div>
                              <span style={{ fontSize: 12, color: meta.clr }}>{meta.label}</span>
                            </div>
                          </td>
                          <td className="num" style={{ fontWeight: 500, color: qClr }}>
                            {qSign}
                            {fmtNum(Math.abs(m.qty))}
                          </td>
                          <td className="num">{fmtBaht(m.costPerUnit)}</td>
                          <td className="num" style={{ fontWeight: 500 }}>
                            {fmtBaht(Math.abs(m.qty) * m.costPerUnit)}
                          </td>
                          <td style={{ fontSize: 12, color: 'var(--info)' }}>{m.refId}</td>
                          <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                            {m.staffName}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
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
          setToast(`กรองแสดง ${items.length} รายการที่เลือก`);
          window.setTimeout(() => setToast(null), 2600);
        }}
        onClose={() => setShowProdPicker(false)}
      />
      <ProductPickerDialog
        open={showFifoPicker}
        branchId={branchId}
        onConfirm={(items) => {
          setFifoPickedIds(new Set(items.map((item) => item.id)));
          setShowFifoPicker(false);
          setToast(`กรอง FIFO ${items.length} รายการที่เลือก`);
          window.setTimeout(() => setToast(null), 2600);
        }}
        onClose={() => setShowFifoPicker(false)}
      />
      {toast && <div className="sr-toast">{toast}</div>}
    </div>
  );
}
