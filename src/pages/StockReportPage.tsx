import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Tooltip,
} from 'chart.js';
import { useMemo, useState } from 'react';
import { Bar, Doughnut } from 'react-chartjs-2';
import { getBranchLabel } from '../lib/branches';
import { downloadCsv } from '../lib/stockReport/exportCsv';
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
import type { StockLot } from '../lib/types';
import { useAuth } from '../lib/hooks/useAuth';
import './StockReportPage.css';

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend);

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
    let av: string | number = 0;
    let bv: string | number = 0;
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
    let av: string | number = 0;
    let bv: string | number = 0;
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

function formatLotDate(ts: StockLot['receivedAt']): string {
  return tsToDate(ts).toLocaleDateString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
}

function FifoModal({
  product,
  onClose,
}: {
  product: StockReportProduct | null;
  onClose: () => void;
}) {
  if (!product) return null;
  const lots = product.lots.filter((l) => l.qtyRemaining > 0);
  const totalRemain = lots.reduce((s, l) => s + l.qtyRemaining, 0);

  return (
    <div className="sr-modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="sr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sr-modal-header">
          <span className="sr-modal-title">FIFO Queue: {product.name}</span>
          <button type="button" className="sr-icon-btn" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>
        <div className="sr-modal-body">
          {lots.length === 0 ? (
            <p style={{ color: 'var(--text-muted)' }}>ไม่มีข้อมูล Lot</p>
          ) : (
            <>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
                คงเหลือรวม <b>{fmtNum(totalRemain)}</b> หน่วย จาก <b>{lots.length}</b> Lot
              </p>
              {lots.map((lot, i) => (
                <div key={lot.id} className={`sr-lot-modal-item${i === 0 ? ' next' : ''}`}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: 6,
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ fontWeight: 500, fontSize: 13 }}>{lot.receivingId || lot.id}</span>
                    {i === 0 && <span className="sr-next-label">ตัดออกก่อน</span>}
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr 1fr',
                      gap: '6px 12px',
                      fontSize: 12,
                    }}
                  >
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>รับเข้า</span>
                      <br />
                      <b>{formatLotDate(lot.receivedAt)}</b>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>คงเหลือ</span>
                      <br />
                      <b>
                        {fmtNum(lot.qtyRemaining)}/{fmtNum(lot.qtyReceived)}
                      </b>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>ต้นทุน</span>
                      <br />
                      <b style={{ color: 'var(--p600)' }}>{fmtBaht(lot.costPerUnit)}</b>
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
        <div className="sr-modal-footer">
          <button type="button" className="sr-btn sr-btn-ghost sr-btn-sm" onClick={onClose}>
            ปิด
          </button>
        </div>
      </div>
    </div>
  );
}

export default function StockReportPage() {
  const { branchId } = useAuth();
  const { products, movements, categories, loading, lastUpdated, refresh } =
    useStockReport(branchId);

  const [tab, setTab] = useState<StockTab>('overview');
  const [ovFrom, setOvFrom] = useState(monthStartIso());
  const [ovTo, setOvTo] = useState(todayIso());
  const [prodSearch, setProdSearch] = useState('');
  const [prodCat, setProdCat] = useState('');
  const [prodStatus, setProdStatus] = useState('');
  const [productSort, setProductSort] = useState<{ key: StockProductSortKey; direction: SortDirection }>({
    key: 'stockValue',
    direction: 'desc',
  });
  const [lowStockSort, setLowStockSort] = useState<{ key: LowStockSortKey; direction: SortDirection }>({
    key: 'qty',
    direction: 'asc',
  });
  const [fifoProductId, setFifoProductId] = useState('');
  const [fifoSearch, setFifoSearch] = useState('');
  const [fifoCat, setFifoCat] = useState('');
  const [fifoFrom, setFifoFrom] = useState(monthStartIso());
  const [fifoTo, setFifoTo] = useState(todayIso());
  const [mvSearch, setMvSearch] = useState('');
  const [mvCat, setMvCat] = useState('');
  const [mvType, setMvType] = useState('');
  const [mvFrom, setMvFrom] = useState(monthStartIso());
  const [mvTo, setMvTo] = useState(todayIso());
  const [fifoModalProduct, setFifoModalProduct] = useState<StockReportProduct | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const branchDisplay = branchId ? getBranchLabel(branchId) : '—';

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
        const st = stockStatus(p.qty, p.reorderPoint);
        return st !== 'ok';
      }),
    [productsWithCogs],
  );

  const alertOos = useMemo(
    () => productsWithCogs.filter((p) => p.qty <= 0),
    [productsWithCogs],
  );
  const alertCritical = useMemo(
    () =>
      productsWithCogs.filter((p) => stockStatus(p.qty, p.reorderPoint) === 'critical'),
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
      const st = stockStatus(p.qty, p.reorderPoint);
      const ms = !prodStatus || st === prodStatus;
      return mq && mc && ms;
    });
    return sortStockProducts(list, productSort.key, productSort.direction);
  }, [productsWithCogs, prodSearch, prodCat, prodStatus, productSort]);

  const sortedLowStockProducts = useMemo(
    () => sortLowStockProducts(lowStockProducts, lowStockSort.key, lowStockSort.direction),
    [lowStockProducts, lowStockSort],
  );

  const fifoProduct = useMemo(() => {
    const withLots = productsWithCogs.filter((p) => p.lots.some((l) => l.qtyRemaining > 0));
    let list = withLots.filter((p) => {
      const q = fifoSearch.trim().toLowerCase();
      const mq = !q || `${p.name}${p.sku}`.toLowerCase().includes(q);
      const mc = !fifoCat || p.category === fifoCat;
      return mq && mc;
    });
    if (fifoProductId) {
      const picked = list.find((p) => p.id === fifoProductId);
      if (picked) return picked;
    }
    return list[0] ?? null;
  }, [productsWithCogs, fifoSearch, fifoCat, fifoProductId]);

  const fifoLots = useMemo(() => {
    if (!fifoProduct) return [];
    return fifoProduct.lots.filter((l) => {
      if (l.qtyRemaining <= 0) return false;
      const d = tsToDate(l.receivedAt).toISOString().slice(0, 10);
      return (!fifoFrom || d >= fifoFrom) && (!fifoTo || d <= fifoTo);
    });
  }, [fifoProduct, fifoFrom, fifoTo]);

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
        <span className="sr-branch-badge">
          <i className="ti ti-map-pin" style={{ fontSize: 12 }} aria-hidden="true" />
          สาขา: {branchDisplay}
        </span>
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
          <div className="sr-toolbar">
            <div className="sr-date-range">
              <i className="ti ti-calendar" aria-hidden="true" style={{ fontSize: 14 }} />
              <input type="date" value={ovFrom} onChange={(e) => setOvFrom(e.target.value)} />
              <span>—</span>
              <input type="date" value={ovTo} onChange={(e) => setOvTo(e.target.value)} />
            </div>
            <span className="sr-hint">แสดงข้อมูลสต็อก ณ สิ้นช่วงวันที่เลือก</span>
          </div>

          {(alertOos.length > 0 || alertCritical.length > 0) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {alertOos.length > 0 && (
                <div className="sr-alert-bar sr-alert-danger">
                  <i className="ti ti-alert-circle" aria-hidden="true" style={{ fontSize: 16 }} />
                  <span>
                    <b>หมดสต็อก {alertOos.length} รายการ:</b>{' '}
                    {alertOos.map((p) => p.name).join(', ')}
                  </span>
                </div>
              )}
              {alertCritical.length > 0 && (
                <div className="sr-alert-bar sr-alert-warn">
                  <i className="ti ti-alert-triangle" aria-hidden="true" style={{ fontSize: 16 }} />
                  <span>
                    <b>สต็อกวิกฤต {alertCritical.length} รายการ:</b>{' '}
                    {alertCritical.map((p) => p.name).join(', ')}
                  </span>
                </div>
              )}
            </div>
          )}

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
            </div>
            <div className="sr-chart-box">
              <div className="sr-chart-title">
                <i className="ti ti-chart-bar" style={{ color: 'var(--p600)' }} aria-hidden="true" />{' '}
                Top 8 สินค้า — มูลค่าสต็อก
              </div>
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
                          callback: (v) =>
                            Number(v) >= 1000 ? `฿${Number(v) / 1000}k` : `฿${v}`,
                          font: { size: 10 },
                        },
                        grid: { color: 'rgba(0,0,0,0.04)' },
                      },
                    },
                  }}
                />
              </div>
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
                    sortedLowStockProducts.map((p) => {
                      const st = stockStatus(p.qty, p.reorderPoint);
                      return (
                        <tr key={p.id}>
                          <td>
                            <div className="sr-prod-cell">
                              <div className="sr-prod-icon" style={{ background: p.iconBg }}>
                                {p.emoji}
                              </div>
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
                    })
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
                placeholder="ค้นหาสินค้า..."
                value={prodSearch}
                onChange={(e) => setProdSearch(e.target.value)}
              />
            </div>
            <select
              className="sr-sel"
              value={prodStatus}
              onChange={(e) => setProdStatus(e.target.value)}
            >
              <option value="">ทุกสถานะ</option>
              <option value="ok">ปกติ</option>
              <option value="low">ต่ำ</option>
              <option value="critical">วิกฤต</option>
              <option value="oos">หมด</option>
            </select>
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
                              <div className="sr-prod-icon" style={{ background: p.iconBg }}>
                                {p.emoji}
                              </div>
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
                placeholder="ค้นหาสินค้า..."
                value={fifoSearch}
                onChange={(e) => setFifoSearch(e.target.value)}
              />
            </div>
            <select
              className="sr-sel"
              value={fifoProductId}
              onChange={(e) => setFifoProductId(e.target.value)}
            >
              <option value="">สินค้าแรกที่มี Lot</option>
              {productsWithCogs
                .filter((p) => p.lots.some((l) => l.qtyRemaining > 0))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <div className="sr-date-range">
              <i className="ti ti-calendar" aria-hidden="true" style={{ fontSize: 14 }} />
              <input type="date" value={fifoFrom} onChange={(e) => setFifoFrom(e.target.value)} />
              <span>—</span>
              <input type="date" value={fifoTo} onChange={(e) => setFifoTo(e.target.value)} />
            </div>
            <span className="sr-hint">Lot เก่าสุดออกก่อน</span>
          </div>

          {!fifoProduct ? (
            <div className="sr-empty">เลือกสินค้าเพื่อดู FIFO Lot Queue</div>
          ) : fifoLots.length === 0 ? (
            <div className="sr-empty">ไม่มี Lot ในช่วงวันที่เลือก</div>
          ) : (
            <>
              <div className="sr-fifo-metrics">
                <div className="sr-metric-card">
                  <div className="sr-metric-label">
                    <i className="ti ti-stack" style={{ color: 'var(--p600)' }} aria-hidden="true" />
                    Lot ในช่วง
                  </div>
                  <div className="sr-metric-num" style={{ color: 'var(--p600)' }}>
                    {fifoLots.length}
                  </div>
                  <div className="sr-metric-sub">จาก {fifoProduct.lots.filter((l) => l.qtyRemaining > 0).length} Lot</div>
                </div>
                <div className="sr-metric-card">
                  <div className="sr-metric-label">
                    <i className="ti ti-package" style={{ color: 'var(--success)' }} aria-hidden="true" />
                    คงเหลือรวม
                  </div>
                  <div className="sr-metric-num" style={{ color: 'var(--success)' }}>
                    {fmtNum(fifoLots.reduce((s, l) => s + l.qtyRemaining, 0))}
                  </div>
                  <div className="sr-metric-sub">หน่วย</div>
                </div>
                <div className="sr-metric-card">
                  <div className="sr-metric-label">
                    <i className="ti ti-calculator" style={{ color: 'var(--info)' }} aria-hidden="true" />
                    Weighted Avg Cost
                  </div>
                  <div className="sr-metric-num" style={{ color: 'var(--info)' }}>
                    {fmtBaht(
                      Math.round(
                        fifoLots.reduce((s, l) => s + l.qtyRemaining * l.costPerUnit, 0) /
                          Math.max(
                            1,
                            fifoLots.reduce((s, l) => s + l.qtyRemaining, 0),
                          ),
                      ),
                    )}
                  </div>
                  <div className="sr-metric-sub">ต้นทุนเฉลี่ยถ่วงน้ำหนัก</div>
                </div>
              </div>
              <div className="sr-fifo-stack">
                {fifoLots.map((lot, i) => {
                  const pct = Math.round((lot.qtyRemaining / lot.qtyReceived) * 100);
                  const pctCls = pct > 60 ? 'full' : pct > 30 ? 'mid' : 'low';
                  const barClr = pct > 60 ? 'var(--p600)' : pct > 30 ? '#ba7517' : '#a32d2d';
                  return (
                    <div key={lot.id} className={`sr-lot-card${i === 0 ? ' next' : ''}`}>
                      <div>
                        <div className={`sr-lot-num${i === 0 ? ' next' : ''}`}>{i + 1}</div>
                        {i === 0 && (
                          <div
                            style={{
                              fontSize: 9,
                              color: 'var(--p600)',
                              textAlign: 'center',
                              marginTop: 3,
                              fontWeight: 500,
                            }}
                          >
                            NEXT
                          </div>
                        )}
                      </div>
                      <div>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            marginBottom: 8,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          {lot.receivingId || lot.id}
                          {i === 0 && <span className="sr-next-label">ตัดออกก่อน</span>}
                        </div>
                        <div className="sr-lot-detail-grid">
                          <div className="sr-lot-kv">
                            <label>วันรับเข้า</label>
                            <span>{formatLotDate(lot.receivedAt)}</span>
                          </div>
                          <div className="sr-lot-kv">
                            <label>ต้นทุน/หน่วย</label>
                            <span style={{ color: 'var(--p600)' }}>{fmtBaht(lot.costPerUnit)}</span>
                          </div>
                          <div className="sr-lot-kv">
                            <label>หมดอายุ</label>
                            <span>
                              {lot.expiryDate ? formatLotDate(lot.expiryDate) : '—'}
                            </span>
                          </div>
                          <div className="sr-lot-kv">
                            <label>รับเข้าทั้งหมด</label>
                            <span>{fmtNum(lot.qtyReceived)} หน่วย</span>
                          </div>
                          <div className="sr-lot-kv">
                            <label>คงเหลือ</label>
                            <span>{fmtNum(lot.qtyRemaining)} หน่วย</span>
                          </div>
                          <div className="sr-lot-kv">
                            <label>มูลค่า Lot</label>
                            <span style={{ color: 'var(--success)' }}>
                              {fmtBaht(lot.qtyRemaining * lot.costPerUnit)}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="sr-lot-remain-bar">
                        <span className={`sr-lot-pct ${pctCls}`}>{pct}%</span>
                        <div
                          style={{
                            width: 80,
                            height: 8,
                            borderRadius: 4,
                            background: 'var(--g100)',
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              height: '100%',
                              width: `${pct}%`,
                              background: barClr,
                              borderRadius: 4,
                            }}
                          />
                        </div>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>คงเหลือ</span>
                      </div>
                    </div>
                  );
                })}
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
            <div className="sr-date-range">
              <i className="ti ti-calendar" aria-hidden="true" style={{ fontSize: 14 }} />
              <input type="date" value={mvFrom} onChange={(e) => setMvFrom(e.target.value)} />
              <span>—</span>
              <input type="date" value={mvTo} onChange={(e) => setMvTo(e.target.value)} />
            </div>
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
                    <th>สินค้า</th>
                    <th>รหัส (SKU)</th>
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
                          <td>
                            <div className="sr-prod-cell">
                              <div className="sr-prod-icon" style={{ background: m.iconBg, fontSize: 14 }}>
                                {m.emoji}
                              </div>
                              <div style={{ fontWeight: 500, fontSize: 13 }}>{m.productName}</div>
                            </div>
                          </td>
                          <td className="sr-col-sku">{m.productSku}</td>
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

      <footer className="sr-footer">
        <div className="sr-footer-stat">
          <span className="sr-footer-num">{overviewMetrics.skuCount}</span>
          <span className="sr-footer-lbl">SKU ทั้งหมด</span>
        </div>
        <div className="sr-footer-stat">
          <span className="sr-footer-num" style={{ color: 'var(--p600)' }}>
            {fmtBaht(overviewMetrics.totalVal)}
          </span>
          <span className="sr-footer-lbl">มูลค่าสต็อกรวม</span>
        </div>
        <div className="sr-footer-stat">
          <span className="sr-footer-num" style={{ color: 'var(--success)' }}>
            {fmtBaht(overviewMetrics.totalCogs)}
          </span>
          <span className="sr-footer-lbl">COGS ช่วงที่เลือก</span>
        </div>
        <div className="sr-footer-stat">
          <span
            className="sr-footer-num"
            style={{ color: overviewMetrics.low > 0 ? 'var(--warn)' : 'var(--text-muted)' }}
          >
            {overviewMetrics.low}
          </span>
          <span className="sr-footer-lbl">Low Stock</span>
        </div>
        <div className="sr-footer-stat">
          <span
            className="sr-footer-num"
            style={{ color: overviewMetrics.oos > 0 ? 'var(--danger)' : 'var(--text-muted)' }}
          >
            {overviewMetrics.oos}
          </span>
          <span className="sr-footer-lbl">หมดสต็อก</span>
        </div>
        <div className="sr-footer-spacer" />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          อัปเดตล่าสุด:{' '}
          {lastUpdated.toLocaleString('th-TH', {
            hour: '2-digit',
            minute: '2-digit',
            day: '2-digit',
            month: 'short',
          })}
        </span>
        <button
          type="button"
          className="sr-btn sr-btn-ghost sr-btn-sm"
          style={{ marginLeft: 8 }}
          onClick={() => refresh()}
          title="รีเฟรช"
        >
          <i className="ti ti-refresh" aria-hidden="true" />
        </button>
      </footer>

      <FifoModal product={fifoModalProduct} onClose={() => setFifoModalProduct(null)} />
      {toast && <div className="sr-toast">{toast}</div>}
    </div>
  );
}
