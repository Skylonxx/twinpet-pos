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
import { Badge } from '../../components/ui';
import '../StockReportPage.css';
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
 * (metric cards → donut/bar charts → low-stock table)
 * by reusing the exact `sr-*` styles and chart.js components — but is fully
 * self-contained via {@link useAllBranchesStock}, never touching the
 * single-branch report.
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
    return <div className="sr-page sr-loading">กำลังโหลดภาพรวมสต็อกทุกสาขา...</div>;
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
    <div className="sr-page">
      <header className="sr-topbar">
        <div className="sr-topbar-icon">
          <i className="ti ti-building-warehouse" aria-hidden="true" />
        </div>
        <div className="sr-topbar-center">
          <div className="sr-topbar-title">ภาพรวมสต็อกบริษัท</div>
          <div className="sr-topbar-sub">Consolidated Stock — รวมทุกสาขา</div>
        </div>
        <button
          type="button"
          className="sr-btn sr-btn-ghost sr-btn-sm"
          onClick={exportCsv}
          disabled={rows.length === 0}
        >
          <i className="ti ti-download" aria-hidden="true" /> Export
        </button>
      </header>

      <div className="sr-content">
        <div className="sr-panel active">
          {error ? (
            <div className="sr-alert-bar sr-alert-danger">
              <i className="ti ti-alert-circle" aria-hidden="true" style={{ fontSize: 16 }} />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="sr-metrics-grid">
            {metrics.map((m) => (
              <div key={m.label} className="sr-metric-card">
                <div className="sr-metric-label">
                  <i className={`ti ${m.icon}`} style={{ color: m.clr, fontSize: 14 }} aria-hidden="true" />
                  {m.label}
                </div>
                <div className="sr-metric-num" style={{ color: m.clr }}>
                  {m.val}
                </div>
                <div className="sr-metric-sub">{m.sub}</div>
                {m.chip && (
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
                สัดส่วนมูลค่าสต็อก (แยกตามสาขา)
              </div>
              {totalValue === 0 ? (
                <div className="sr-chart-empty">
                  <i className="ti ti-chart-donut" aria-hidden="true" />
                  <span>ไม่มีข้อมูลมูลค่าสต็อก</span>
                </div>
              ) : (
                <>
                  <div className="sr-chart-wrap">
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
                  <div className="sr-donut-legend">
                    {branchValues.map((b, i) => {
                      const pct = totalValue > 0 ? Math.round((b.value / totalValue) * 100) : 0;
                      return (
                        <div key={b.branchId} className="sr-legend-item">
                          <div
                            className="sr-legend-dot"
                            style={{ background: CAT_COLORS[i % CAT_COLORS.length] }}
                          />
                          <span className="sr-legend-lbl">{b.branchName}</span>
                          <span className="sr-legend-val">
                            {fmtBaht(b.value)} · {pct}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            <div className="sr-chart-box">
              <div className="sr-chart-title">
                <i className="ti ti-chart-bar" style={{ color: 'var(--p600)' }} aria-hidden="true" />{' '}
                Top 8 สินค้า — มูลค่าสต็อกรวมสูงสุด
              </div>
              {totalValue === 0 ? (
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

          <div className="sr-card">
            <div className="sr-card-head">
              <i className="ti ti-alert-triangle" style={{ color: 'var(--warn)' }} aria-hidden="true" />
              สินค้าที่ต้องเติม (ต่ำกว่า Reorder — รวมทุกสาขา)
              <Badge color="warning" className="ml-1 w-fit">
                {lowStockCount}
              </Badge>
            </div>
            <div className="sr-table-scroll">
              <table className="sr-table">
                <thead>
                  <tr>
                    <th>สินค้า</th>
                    <th>รหัส (SKU)</th>
                    <th className="num">คงเหลือรวม</th>
                    <th className="num">Reorder (รวม)</th>
                    <th className="num">จำนวนสาขา</th>
                    <th className="num">มูลค่ารวม</th>
                    <th>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {lowStock.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="sr-empty">
                        ทุกรายการมีสต็อกเพียงพอทั้งบริษัท ✓
                      </td>
                    </tr>
                  ) : (
                    <>
                      {lowStock.slice(0, 10).map((p) => (
                        <tr key={p.id}>
                          <td>
                            <div style={{ fontWeight: 500 }}>{p.name}</div>
                          </td>
                          <td className="sr-col-sku">{p.sku}</td>
                          <td
                            className="num"
                            style={{
                              fontWeight: 500,
                              color: p.totalQty === 0 ? 'var(--danger)' : 'var(--warn)',
                            }}
                          >
                            {fmtNum(p.totalQty)}
                          </td>
                          <td className="num">{fmtNum(p.reorderPoint)}</td>
                          <td className="num">{fmtNum(p.branchCount)}</td>
                          <td className="num">{fmtBaht(p.totalValue)}</td>
                          <td>
                            <StatusBadge status={p.status} />
                          </td>
                        </tr>
                      ))}
                      {lowStock.length > 10 && (
                        <tr>
                          <td colSpan={7} className="sr-table-more">
                            มีอีก {lowStock.length - 10} รายการ — ดูทั้งหมดในแท็บ
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
      </div>

    </div>
  );
}
