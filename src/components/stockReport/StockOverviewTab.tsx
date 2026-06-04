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
import ProductImageThumb from '../products/ProductImageThumb';
import {
  Badge,
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../ui';
import {
  sortLowStockProducts,
  type LowStockSortKey,
  type SortDirection,
} from '../../lib/stockReport/sorting';
import {
  CAT_COLORS,
  categoryValues,
  computeOverviewMetrics,
  fmtBaht,
  fmtNum,
  stockStatus,
  type StockReportProduct,
} from '../../lib/stockReport/types';
import { SortableTh } from './SortableTh';
import { StatusBadge } from './StatusBadge';

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend);

// Compact ฿ axis labels (e.g. ฿1.5M, ฿50k) so large valuations don't squish the chart.
function compactBahtAxis(value: number | string): string {
  const n = Number(value);
  if (n >= 1_000_000) return `฿${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `฿${Math.round(n / 1_000)}k`;
  return `฿${n}`;
}

export default function StockOverviewTab({
  productsWithCogs,
}: {
  productsWithCogs: StockReportProduct[];
}) {
  const [lowStockSort, setLowStockSort] = useState<{ key: LowStockSortKey; direction: SortDirection }>({
    key: 'qty',
    direction: 'asc',
  });

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

  const sortedLowStockProducts = useMemo(
    () => sortLowStockProducts(lowStockProducts, lowStockSort.key, lowStockSort.direction),
    [lowStockProducts, lowStockSort],
  );

  const catMap = useMemo(() => categoryValues(productsWithCogs), [productsWithCogs]);
  const catLabels = Object.keys(catMap);
  const catVals = catLabels.map((k) => catMap[k]!);

  const topProducts = useMemo(
    () => [...productsWithCogs].sort((a, b) => b.stockValue - a.stockValue).slice(0, 8),
    [productsWithCogs],
  );

  const handleLowStockSort = (key: LowStockSortKey) => {
    setLowStockSort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { key, direction: 'asc' };
    });
  };

  return (
    <div className="sr-panel active">
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
          <Badge color="warning" className="ml-1 w-fit">
            {lowStockProducts.length}
          </Badge>
        </div>
        <div className="overflow-x-auto">
          <Table hoverable className="min-w-[600px]">
            <TableHead>
              <TableRow>
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
                  className="text-right"
                />
                <SortableTh
                  label="Reorder Point"
                  sortKey="reorderPoint"
                  activeKey={lowStockSort.key}
                  direction={lowStockSort.direction}
                  onSort={(k) => handleLowStockSort(k as LowStockSortKey)}
                  className="text-right"
                />
                <SortableTh
                  label="Average Cost"
                  sortKey="avgCost"
                  activeKey={lowStockSort.key}
                  direction={lowStockSort.direction}
                  onSort={(k) => handleLowStockSort(k as LowStockSortKey)}
                  className="text-right"
                />
                <SortableTh
                  label="มูลค่า"
                  sortKey="stockValue"
                  activeKey={lowStockSort.key}
                  direction={lowStockSort.direction}
                  onSort={(k) => handleLowStockSort(k as LowStockSortKey)}
                  className="text-right"
                />
                <TableHeadCell>สถานะ</TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sortedLowStockProducts.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-[13px] text-[var(--text-muted)]"
                  >
                    ทุกรายการมีสต็อกเพียงพอ ✓
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {sortedLowStockProducts.slice(0, 10).map((p) => {
                    const st = stockStatus(p.qty, p.reorderPoint);
                    return (
                      <TableRow key={p.id}>
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <ProductImageThumb imageUrl={p.imageUrl} alt={p.name} />
                            <div className="font-medium">{p.name}</div>
                          </div>
                        </TableCell>
                        <TableCell
                          className="whitespace-nowrap text-xs text-[var(--text-secondary)]"
                          style={{ fontFamily: "'Prompt', sans-serif" }}
                        >
                          {p.sku}
                        </TableCell>
                        <TableCell
                          className="text-right font-medium"
                          style={{ color: p.qty === 0 ? 'var(--danger)' : 'var(--warn)' }}
                        >
                          {fmtNum(p.qty)}
                        </TableCell>
                        <TableCell className="text-right">{fmtNum(p.reorderPoint)}</TableCell>
                        <TableCell className="text-right">{fmtBaht(p.avgCost)}</TableCell>
                        <TableCell className="text-right">{fmtBaht(p.stockValue)}</TableCell>
                        <TableCell>
                          <StatusBadge status={st} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {sortedLowStockProducts.length > 10 && (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="py-2.5 text-center text-xs text-[var(--text-muted)]"
                      >
                        มีอีก {sortedLowStockProducts.length - 10} รายการ — ดูทั้งหมดในแท็บ
                        &lsquo;รายสินค้า&rsquo;
                      </TableCell>
                    </TableRow>
                  )}
                </>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
