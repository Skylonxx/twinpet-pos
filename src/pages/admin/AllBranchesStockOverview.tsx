import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Tooltip,
} from 'chart.js';
import { useMemo } from 'react';
import { Bar, Doughnut } from 'react-chartjs-2';
import { downloadCsv } from '../../lib/stockReport/exportCsv';
import {
  CAT_COLORS,
  fmtBaht,
  fmtNum,
} from '../../lib/stockReport/types';
import { useAllBranchesStock } from '../../lib/stockReport/useAllBranchesStock';
import StatusBadge from '../../components/stockReport/StatusBadge';
import {
  Badge,
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../../components/ui';
import './AllBranchesStockOverview.css';

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend);

// Compact ฿ axis labels (e.g. ฿1.5M, ฿50k) so large valuations don't squish the chart.
function compactBahtAxis(value: number | string): string {
  const n = Number(value);
  if (n >= 1_000_000) return `฿${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `฿${Math.round(n / 1_000)}k`;
  return `฿${n}`;
}

/**
 * Executive, cross-branch stock dashboard rendered when the Admin picks
 * "รวมทุกสาขา" (ALL). It mirrors the single-branch report's Overview tab
 * (metric cards → donut/bar charts → low-stock table). Phase 7C-C3 forked its
 * styles into a self-contained `absr-*` namespace (copied 1:1 from the report's
 * `sr-*` styles) so the rollup and the single-branch report no longer share a
 * CSS namespace. It remains fully self-contained via {@link useAllBranchesStock},
 * never touching the single-branch report.
 */
export default function AllBranchesStockOverview() {
  const {
    rows,
    branchValues,
    lowStock,
    totalQty,
    totalValue,
    productCount,
    branchCount,
    lowStockCount,
    oosCount,
    loading,
    error,
  } = useAllBranchesStock();

  const topProducts = useMemo(() => rows.slice(0, 8), [rows]);
  const avgPerBranch = branchCount > 0 ? Math.round(totalValue / branchCount) : 0;

  const exportCsv = () => {
    const csv = [
      ['SKU', 'ชื่อสินค้า', 'หมวดหมู่', 'คงเหลือรวม', 'จำนวนสาขา', 'Avg Cost', 'Reorder', 'มูลค่ารวม', 'สถานะ'],
      ...rows.map((r) => [
        r.sku,
        r.name,
        r.category,
        String(r.totalQty),
        String(r.branchCount),
        String(r.avgCost),
        String(r.reorderPoint),
        String(r.totalValue),
        r.status,
      ]),
    ];
    downloadCsv(csv, 'stock_report_all_branches');
  };

  if (loading) {
    return <div className="absr-page absr-loading">กำลังโหลดภาพรวมสต็อกทุกสาขา...</div>;
  }

  const metrics = [
    {
      label: 'มูลค่าสต็อกรวม',
      icon: 'ti-coins',
      val: fmtBaht(totalValue),
      sub: 'รวมทุกสาขา (FIFO/avg cost)',
      clr: 'var(--p600)',
      chip: null as string | null,
    },
    {
      label: 'จำนวนสาขา',
      icon: 'ti-building-community',
      val: String(branchCount),
      sub: 'สาขาที่มีสต็อก',
      clr: 'var(--info)',
      chip: null,
    },
    {
      label: 'มูลค่าเฉลี่ย/สาขา',
      icon: 'ti-scale',
      val: fmtBaht(avgPerBranch),
      sub: 'เฉลี่ยต่อสาขา',
      clr: 'var(--success)',
      chip: null,
    },
    {
      label: 'Low Stock Alert',
      icon: 'ti-alert-triangle',
      val: String(lowStockCount),
      sub: 'ต่ำกว่า Reorder (บริษัท)',
      clr: 'var(--warn)',
      chip: oosCount > 0 ? `${oosCount} หมดสต็อก` : null,
    },
    {
      label: 'จำนวน SKU',
      icon: 'ti-box',
      val: String(productCount),
      sub: 'รายการสินค้าทั้งหมด',
      clr: 'var(--text-primary)',
      chip: null,
    },
    {
      label: 'จำนวนรวม (หน่วย)',
      icon: 'ti-package',
      val: fmtNum(totalQty),
      sub: 'หน่วยคงเหลือรวมทุกสาขา',
      clr: 'var(--text-primary)',
      chip: null,
    },
  ];

  return (
    <div className="absr-page">
      <header className="absr-topbar">
        <div className="absr-topbar-icon">
          <i className="ti ti-building-warehouse" aria-hidden="true" />
        </div>
        <div className="absr-topbar-center">
          <div className="absr-topbar-title">ภาพรวมสต็อกบริษัท</div>
          <div className="absr-topbar-sub">Consolidated Stock — รวมทุกสาขา</div>
        </div>
        <button
          type="button"
          className="absr-btn absr-btn-ghost absr-btn-sm"
          onClick={exportCsv}
          disabled={rows.length === 0}
        >
          <i className="ti ti-download" aria-hidden="true" /> Export
        </button>
      </header>

      <div className="absr-content">
        <div className="absr-panel active">
          {error ? (
            <div className="absr-alert-bar absr-alert-danger">
              <i className="ti ti-alert-circle" aria-hidden="true" style={{ fontSize: 16 }} />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="absr-metrics-grid">
            {metrics.map((m) => (
              <div key={m.label} className="absr-metric-card">
                <div className="absr-metric-label">
                  <i className={`ti ${m.icon}`} style={{ color: m.clr, fontSize: 14 }} aria-hidden="true" />
                  {m.label}
                </div>
                <div className="absr-metric-num" style={{ color: m.clr }}>
                  {m.val}
                </div>
                <div className="absr-metric-sub">{m.sub}</div>
                {m.chip && (
                  <span className="absr-metric-chip absr-chip-warn">
                    <i className="ti ti-alert-triangle" aria-hidden="true" /> {m.chip}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="absr-chart-grid">
            <div className="absr-chart-box">
              <div className="absr-chart-title">
                <i className="ti ti-chart-donut" style={{ color: 'var(--p600)' }} aria-hidden="true" />{' '}
                สัดส่วนมูลค่าสต็อก (แยกตามสาขา)
              </div>
              {totalValue === 0 ? (
                <div className="absr-chart-empty">
                  <i className="ti ti-chart-donut" aria-hidden="true" />
                  <span>ไม่มีข้อมูลมูลค่าสต็อก</span>
                </div>
              ) : (
                <>
                  <div className="absr-chart-wrap">
                    <Doughnut
                      data={{
                        labels: branchValues.map((b) => b.branchName),
                        datasets: [
                          {
                            data: branchValues.map((b) => b.value),
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
                  <div className="absr-donut-legend">
                    {branchValues.map((b, i) => {
                      const pct = totalValue > 0 ? Math.round((b.value / totalValue) * 100) : 0;
                      return (
                        <div key={b.branchId} className="absr-legend-item">
                          <div
                            className="absr-legend-dot"
                            style={{ background: CAT_COLORS[i % CAT_COLORS.length] }}
                          />
                          <span className="absr-legend-lbl">{b.branchName}</span>
                          <span className="absr-legend-val">
                            {fmtBaht(b.value)} · {pct}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            <div className="absr-chart-box">
              <div className="absr-chart-title">
                <i className="ti ti-chart-bar" style={{ color: 'var(--p600)' }} aria-hidden="true" />{' '}
                Top 8 สินค้า — มูลค่าสต็อกรวมสูงสุด
              </div>
              {totalValue === 0 ? (
                <div className="absr-chart-empty">
                  <i className="ti ti-chart-bar" aria-hidden="true" />
                  <span>ไม่มีข้อมูลมูลค่าสต็อก</span>
                </div>
              ) : (
                <div className="absr-chart-wrap">
                  <Bar
                    data={{
                      labels: topProducts.map((p) =>
                        p.name.length > 18 ? `${p.name.slice(0, 16)}…` : p.name,
                      ),
                      datasets: [
                        {
                          data: topProducts.map((p) => p.totalValue),
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

          <div className="absr-card">
            <div className="absr-card-head">
              <i className="ti ti-alert-triangle" style={{ color: 'var(--warn)' }} aria-hidden="true" />
              สินค้าที่ต้องเติม (ต่ำกว่า Reorder — รวมทุกสาขา)
              <Badge color="warning" className="ml-1 w-fit">
                {lowStockCount}
              </Badge>
            </div>
            <div className="overflow-x-auto">
              <Table hoverable className="min-w-[600px]">
                <TableHead>
                  <TableRow>
                    <TableHeadCell>สินค้า</TableHeadCell>
                    <TableHeadCell>รหัส (SKU)</TableHeadCell>
                    <TableHeadCell className="text-right">คงเหลือรวม</TableHeadCell>
                    <TableHeadCell className="text-right">Reorder (รวม)</TableHeadCell>
                    <TableHeadCell className="text-right">จำนวนสาขา</TableHeadCell>
                    <TableHeadCell className="text-right">มูลค่ารวม</TableHeadCell>
                    <TableHeadCell>สถานะ</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {lowStock.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="py-8 text-center text-[13px] text-[var(--text-muted)]"
                      >
                        ทุกรายการมีสต็อกเพียงพอทั้งบริษัท ✓
                      </TableCell>
                    </TableRow>
                  ) : (
                    <>
                      {lowStock.slice(0, 10).map((p) => (
                        <TableRow key={p.id}>
                          <TableCell>
                            <div className="font-medium">{p.name}</div>
                          </TableCell>
                          <TableCell
                            className="whitespace-nowrap text-xs text-[var(--text-secondary)]"
                            style={{ fontFamily: "'Prompt', sans-serif" }}
                          >
                            {p.sku}
                          </TableCell>
                          <TableCell
                            className="text-right font-medium"
                            style={{ color: p.totalQty === 0 ? 'var(--danger)' : 'var(--warn)' }}
                          >
                            {fmtNum(p.totalQty)}
                          </TableCell>
                          <TableCell className="text-right">{fmtNum(p.reorderPoint)}</TableCell>
                          <TableCell className="text-right">{fmtNum(p.branchCount)}</TableCell>
                          <TableCell className="text-right">{fmtBaht(p.totalValue)}</TableCell>
                          <TableCell>
                            <StatusBadge status={p.status} />
                          </TableCell>
                        </TableRow>
                      ))}
                      {lowStock.length > 10 && (
                        <TableRow>
                          <TableCell
                            colSpan={7}
                            className="py-2.5 text-center text-xs italic text-[var(--text-muted)]"
                          >
                            มีอีก {lowStock.length - 10} รายการ — ดูทั้งหมดในแท็บ
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
      </div>

    </div>
  );
}
