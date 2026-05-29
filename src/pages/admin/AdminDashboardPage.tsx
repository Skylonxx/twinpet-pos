import { useEffect, useMemo, useState } from 'react';
import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Tooltip,
} from 'chart.js';
import { Bar, Doughnut } from 'react-chartjs-2';
import { aggregateDashboard, EMPTY_DASHBOARD_AGGREGATES, pctChange } from '../../lib/dashboard/aggregate';
import { fmtBaht, fmtNumber, fmtPct, truncate } from '../../lib/dashboard/format';
import {
  PERIOD_COMPARE_LABELS,
  PERIOD_LABELS,
} from '../../lib/dashboard/periods';
import {
  ALL_BRANCHES,
  useAdminDashboardData,
  type AdminBranchSelection,
} from '../../lib/dashboard/useAdminDashboardData';
import type { DashboardPeriod } from '../../lib/dashboard/types';
import { useBranchManagement } from '../../lib/admin/branchManagement';
import type { PaymentMethod } from '../../lib/types';
import '../DashboardPage.css';

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Tooltip,
  Legend,
);

const PAY_META: Record<
  PaymentMethod,
  { label: string; icon: string; iconBg: string; clr: string; barClr: string }
> = {
  cash: {
    label: 'เงินสด',
    icon: 'ti-cash',
    iconBg: '#EAF3DE',
    clr: '#3B6D11',
    barClr: '#1D9E75',
  },
  qr: {
    label: 'โอน PromptPay',
    icon: 'ti-qrcode',
    iconBg: '#FBE8F9',
    clr: '#7A1FA2',
    barClr: '#A93FBF',
  },
  kbank: {
    label: 'QR Kbank',
    icon: 'ti-building-bank',
    iconBg: '#E8F5E0',
    clr: '#1F6E00',
    barClr: '#4CAF50',
  },
  card: {
    label: 'EDC',
    icon: 'ti-credit-card',
    iconBg: '#EEEDFE',
    clr: '#534AB7',
    barClr: '#534AB7',
  },
  credit: {
    label: 'เชื่อ',
    icon: 'ti-clock-dollar',
    iconBg: '#FAEEDA',
    clr: '#854F0B',
    barClr: '#EF9F27',
  },
};

const RANK_CLASSES = ['dash-rb-1', 'dash-rb-2', 'dash-rb-3', 'dash-rb-n', 'dash-rb-n'];

function CompareBadge({ pct }: { pct: number }) {
  if (Math.abs(pct) < 0.5) {
    return <span className="dash-kpi-badge dash-badge-flat">— ทรงตัว</span>;
  }
  const up = pct > 0;
  return (
    <span className={`dash-kpi-badge ${up ? 'dash-badge-up' : 'dash-badge-dn'}`}>
      <i className={`ti ti-arrow-${up ? 'up' : 'down'}`} aria-hidden="true" />
      {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

export default function AdminDashboardPage() {
  const [period, setPeriod] = useState<DashboardPeriod>('today');
  const [selectedBranch, setSelectedBranch] = useState<AdminBranchSelection>(ALL_BRANCHES);
  const { branches } = useBranchManagement();
  const [clock, setClock] = useState(() =>
    new Date().toLocaleString('th-TH', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
  );

  const { saleLines, paymentRecords, stockMap, loading, error, now, bounds } =
    useAdminDashboardData(selectedBranch, period);

  const activeBranches = useMemo(
    () => branches.filter((b) => b.isActive !== false),
    [branches],
  );

  const data = useMemo(
    () =>
      bounds
        ? aggregateDashboard(period, saleLines, paymentRecords, stockMap, now, bounds)
        : EMPTY_DASHBOARD_AGGREGATES,
    [period, saleLines, paymentRecords, stockMap, now, bounds],
  );

  const { kpi } = data;
  const revPct = pctChange(kpi.revenue, kpi.prevRevenue);
  const profPct = pctChange(kpi.profit, kpi.prevProfit);
  const billPct = pctChange(kpi.bills, kpi.prevBills);
  const vsLabel = PERIOD_COMPARE_LABELS[period];

  const trendChartData = useMemo(
    () => ({
      labels: data.trend.map((t) => t.label),
      datasets: [
        {
          label: 'ยอดขาย',
          data: data.trend.map((t) => t.revenue),
          backgroundColor: 'rgba(83,74,183,0.82)',
          borderRadius: 4,
          borderSkipped: false,
          order: 2,
        },
        {
          label: 'กำไร',
          data: data.trend.map((t) => t.profit),
          backgroundColor: 'rgba(15,110,86,0.82)',
          borderRadius: 4,
          borderSkipped: false,
          order: 1,
        },
      ],
    }),
    [data.trend],
  );

  const donutChartData = useMemo(
    () => ({
      labels: data.categories.map((c) => c.category),
      datasets: [
        {
          data: data.categories.map((c) => c.revenue),
          backgroundColor: data.categories.map((c) => c.color),
          borderWidth: 0,
          hoverOffset: 4,
        },
      ],
    }),
    [data.categories],
  );

  const categoryTotal = useMemo(
    () => data.categories.reduce((a, c) => a + c.revenue, 0),
    [data.categories],
  );

  const maxProdRev = data.topProducts[0]?.revenue ?? 1;
  const maxCustRev = data.topCustomers[0]?.revenue ?? 1;

  useEffect(() => {
    const id = window.setInterval(() => {
      setClock(
        new Date().toLocaleString('th-TH', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      );
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const chartOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx: { dataset: { label?: string }; raw: unknown }) =>
              `${ctx.dataset.label}: ${fmtBaht(Number(ctx.raw))}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { font: { size: 10 }, color: '#9CA3AF', maxRotation: 0 },
          grid: { display: false },
        },
        y: {
          ticks: {
            callback: (v: string | number) => {
              const n = Number(v);
              return n >= 1000 ? `฿${(n / 1000).toFixed(0)}k` : `฿${n}`;
            },
            font: { size: 10 },
            color: '#9CA3AF',
          },
          grid: { color: 'rgba(0,0,0,0.04)' },
        },
      },
    }),
    [],
  );

  const donutOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx: { label?: string; raw: unknown }) =>
              `${ctx.label}: ${fmtBaht(Number(ctx.raw))}`,
          },
        },
      },
      cutout: '65%',
    }),
    [],
  );

  const scopeLabel =
    selectedBranch === ALL_BRANCHES
      ? 'รวมทุกสาขา'
      : activeBranches.find((b) => b.id === selectedBranch)?.name?.trim() || selectedBranch;

  return (
    <div className="dashboard-page">
      <header className="dash-toolbar">
        <div>
          <div className="dash-toolbar-title">Admin Dashboard</div>
          <div className="dash-toolbar-sub">ภาพรวมธุรกิจ TwinPet — {scopeLabel}</div>
        </div>
        <div className="dash-toolbar-center" />
        <select
          className="dash-branch-select"
          value={selectedBranch}
          onChange={(e) => setSelectedBranch(e.target.value)}
          aria-label="เลือกสาขา"
        >
          <option value={ALL_BRANCHES}>รวมทุกสาขา</option>
          {activeBranches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name?.trim() || b.id}
            </option>
          ))}
        </select>
        <div className="dash-period-tabs" role="tablist">
          {(['today', 'week', 'month'] as DashboardPeriod[]).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={period === p}
              className={`dash-period-tab${period === p ? ' active' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
        <div className="dash-live-dot" title="Live data" />
      </header>

      <div className="dash-content">
        {loading && <div className="dash-loading">กำลังโหลดข้อมูล...</div>}
        {error && (
          <div className="dash-loading" style={{ color: 'var(--danger)' }}>
            {error.message}
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="dash-kpi-grid">
              <div className="dash-kpi-card dash-kc-rev">
                <i className="dash-kpi-icon-bg ti ti-coin" aria-hidden="true" />
                <div className="dash-kpi-label">
                  <i className="ti ti-coin" style={{ fontSize: 12 }} aria-hidden="true" />
                  ยอดขายรวม
                </div>
                <div className="dash-kpi-num">{fmtBaht(kpi.revenue)}</div>
                <div className="dash-kpi-compare">
                  <CompareBadge pct={revPct} />
                  <span className="dash-kpi-vs">{vsLabel}</span>
                </div>
              </div>

              <div className="dash-kpi-card dash-kc-profit">
                <i className="dash-kpi-icon-bg ti ti-trending-up" aria-hidden="true" />
                <div className="dash-kpi-label">
                  <i className="ti ti-trending-up" style={{ fontSize: 12 }} aria-hidden="true" />
                  กำไรขั้นต้น
                </div>
                <div className="dash-kpi-num">{fmtBaht(kpi.profit)}</div>
                <div className="dash-kpi-compare">
                  <CompareBadge pct={profPct} />
                  <span className="dash-kpi-vs">{vsLabel}</span>
                </div>
              </div>

              <div className="dash-kpi-card dash-kc-orders">
                <i className="dash-kpi-icon-bg ti ti-receipt" aria-hidden="true" />
                <div className="dash-kpi-label">
                  <i className="ti ti-receipt" style={{ fontSize: 12 }} aria-hidden="true" />
                  จำนวนบิล
                </div>
                <div className="dash-kpi-num">{fmtNumber(kpi.bills)}</div>
                <div className="dash-kpi-compare">
                  <CompareBadge pct={billPct} />
                  <span className="dash-kpi-vs">{vsLabel}</span>
                </div>
              </div>

              <div className="dash-kpi-card dash-kc-stock">
                <i className="dash-kpi-icon-bg ti ti-percentage" aria-hidden="true" />
                <div className="dash-kpi-label">
                  <i className="ti ti-percentage" style={{ fontSize: 12 }} aria-hidden="true" />
                  Gross Margin
                </div>
                <div className="dash-kpi-num">{fmtPct(kpi.margin)}</div>
                <div className="dash-kpi-compare">
                  <span
                    className={`dash-kpi-badge ${
                      kpi.margin >= 20
                        ? 'dash-badge-up'
                        : kpi.margin >= 10
                          ? 'dash-badge-flat'
                          : 'dash-badge-dn'
                    }`}
                  >
                    {kpi.margin >= 20 ? '✓ ดี' : kpi.margin >= 10 ? '⚠ ปานกลาง' : '✗ ต่ำ'}
                  </span>
                </div>
              </div>
            </div>

            <div className="dash-chart-row">
              <div className="dash-chart-box">
                <div className="dash-chart-head">
                  <div className="dash-chart-title">
                    <i className="ti ti-chart-bar" aria-hidden="true" />
                    {data.trendTitle}
                  </div>
                  <div className="dash-chart-legend">
                    <div className="dash-legend-item">
                      <div className="dash-legend-dot" style={{ background: 'var(--p600)' }} />
                      ยอดขาย
                    </div>
                    <div className="dash-legend-item">
                      <div className="dash-legend-dot" style={{ background: 'var(--success)' }} />
                      กำไร
                    </div>
                  </div>
                </div>
                <div className="dash-chart-canvas-wrap">
                  <Bar data={trendChartData} options={chartOptions} />
                </div>
              </div>

              <div className="dash-chart-box">
                <div className="dash-chart-head">
                  <div className="dash-chart-title">
                    <i className="ti ti-chart-donut" aria-hidden="true" />
                    ยอดขายตามหมวดหมู่
                  </div>
                </div>
                {data.categories.length > 0 ? (
                  <div className="dash-donut-wrap">
                    <div className="dash-donut-canvas">
                      <Doughnut data={donutChartData} options={donutOptions} />
                    </div>
                    <div className="dash-donut-legend">
                      {data.categories.map((c) => (
                        <div key={c.category} className="dash-dl-row">
                          <div className="dash-dl-dot" style={{ background: c.color }} />
                          <span className="dash-dl-lbl">{c.category}</span>
                          <span className="dash-dl-val">{fmtBaht(c.revenue)}</span>
                          <span className="dash-dl-pct">
                            {categoryTotal > 0
                              ? fmtPct((c.revenue / categoryTotal) * 100)
                              : '-'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', padding: '24px 0' }}>
                    ไม่มีข้อมูลในช่วงเวลานี้
                  </p>
                )}
              </div>
            </div>

            <section className="dash-pay-section">
              <div className="dash-chart-head" style={{ marginBottom: 0 }}>
                <div className="dash-chart-title">
                  <i className="ti ti-credit-card" aria-hidden="true" />
                  ช่องทางการชำระเงิน
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {PERIOD_LABELS[period]}
                </span>
              </div>
              <div className="dash-pay-scroll">
                <div className="dash-pay-grid">
                  {data.payments.map((row) => {
                    const m = PAY_META[row.method];
                    return (
                      <div key={row.method} className="dash-pay-card">
                        <div
                          className="dash-pay-icon"
                          style={{ background: m.iconBg, color: m.clr }}
                        >
                          <i className={`ti ${m.icon}`} aria-hidden="true" />
                        </div>
                        <div className="dash-pay-info">
                          <div className="dash-pay-name">{m.label}</div>
                          <div className="dash-pay-rev" style={{ color: m.clr }}>
                            {fmtBaht(row.revenue)}
                          </div>
                          <div className="dash-pay-meta">
                            <span className="dash-pay-bills">{row.bills} บิล</span>
                            <span
                              className="dash-pay-pct-pill"
                              style={{ background: m.iconBg, color: m.clr }}
                            >
                              {row.pct.toFixed(1)}%
                            </span>
                          </div>
                          <div className="dash-pay-bar-bg">
                            <div
                              className="dash-pay-bar-fill"
                              style={{ width: `${row.barWidth}%`, background: m.barClr }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>

            <div className="dash-bottom-row">
              <div className="dash-table-card">
                <div className="dash-tc-head">
                  <i className="ti ti-medal" aria-hidden="true" />
                  Top สินค้าขายดี
                  <span className="dash-badge-count">{data.topProducts.length}</span>
                </div>
                <div className="dash-tc-body">
                  <table className="dash-mini">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>สินค้า</th>
                        <th className="r">ยอดขาย</th>
                        <th className="r">กำไร</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topProducts.map((row, i) => {
                        const pct = (row.revenue / maxProdRev) * 100;
                        return (
                          <tr key={row.productId}>
                            <td>
                              <span className={`dash-rank-ball ${RANK_CLASSES[i]}`}>
                                {i + 1}
                              </span>
                            </td>
                            <td>
                              <div style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.2 }}>
                                {truncate(row.name, 22)}
                              </div>
                              <div className="dash-bar-inline" style={{ width: 70 }}>
                                <div
                                  className="dash-bar-fill-p"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </td>
                            <td className="r" style={{ color: 'var(--p600)', fontWeight: 500 }}>
                              {fmtBaht(row.revenue)}
                            </td>
                            <td className="r" style={{ color: 'var(--success)' }}>
                              {fmtBaht(row.profit)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="dash-table-card">
                <div className="dash-tc-head">
                  <i className="ti ti-crown" aria-hidden="true" />
                  Top ลูกค้า
                  <span className="dash-badge-count">{data.topCustomers.length}</span>
                </div>
                <div className="dash-tc-body">
                  <table className="dash-mini">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>ลูกค้า</th>
                        <th className="r">ยอดขาย</th>
                        <th className="r">บิล</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topCustomers.map((row, i) => {
                        const pct = (row.revenue / maxCustRev) * 100;
                        return (
                          <tr key={row.name}>
                            <td>
                              <span className={`dash-rank-ball ${RANK_CLASSES[i]}`}>
                                {i + 1}
                              </span>
                            </td>
                            <td>
                              <div style={{ fontSize: 12, fontWeight: 500 }}>
                                {truncate(row.name, 16)}
                              </div>
                              <div className="dash-bar-inline" style={{ width: 80 }}>
                                <div
                                  className="dash-bar-fill-g"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </td>
                            <td className="r" style={{ color: 'var(--p600)', fontWeight: 500 }}>
                              {fmtBaht(row.revenue)}
                            </td>
                            <td className="r" style={{ color: 'var(--text-muted)' }}>
                              {row.bills}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="dash-table-card">
                <div className="dash-tc-head">
                  <i className="ti ti-alert-triangle" aria-hidden="true" />
                  แจ้งเตือนสต็อก
                  <span className="dash-badge-count">{data.stockAlerts.length}</span>
                </div>
                <div className="dash-tc-body">
                  <table className="dash-mini">
                    <thead>
                      <tr>
                        <th>สินค้า</th>
                        <th className="r">คงเหลือ</th>
                        <th className="r">Reorder</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.stockAlerts.length === 0 ? (
                        <tr>
                          <td colSpan={3} style={{ color: 'var(--text-muted)' }}>
                            สต็อกปกติทุกรายการ
                          </td>
                        </tr>
                      ) : (
                        data.stockAlerts.map((row) => (
                          <tr key={row.productId}>
                            <td style={{ fontSize: 12, fontWeight: 500 }}>
                              {truncate(row.name, 18)}
                            </td>
                            <td className="r">
                              <span
                                className={
                                  row.qty === 0 || row.critical
                                    ? 'dash-stock-num-crit'
                                    : 'dash-stock-num-low'
                                }
                              >
                                {row.qty === 0 ? 'หมด' : row.qty}
                              </span>
                            </td>
                            <td className="r" style={{ color: 'var(--text-muted)' }}>
                              {row.reorderPoint}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <footer className="dash-footer">
        <div className="dash-footer-stat">
          <span className="dash-footer-num" style={{ color: 'var(--p600)' }}>
            {fmtBaht(kpi.revenue)}
          </span>
          <span className="dash-footer-lbl">ยอดขาย</span>
        </div>
        <div className="dash-footer-stat">
          <span className="dash-footer-num" style={{ color: 'var(--success)' }}>
            {fmtBaht(kpi.profit)}
          </span>
          <span className="dash-footer-lbl">กำไร</span>
        </div>
        <div className="dash-footer-stat">
          <span className="dash-footer-num" style={{ color: 'var(--info)' }}>
            {fmtNumber(kpi.bills)}
          </span>
          <span className="dash-footer-lbl">บิล</span>
        </div>
        <div className="dash-footer-stat">
          <span className="dash-footer-num" style={{ color: 'var(--text-secondary)' }}>
            {fmtPct(kpi.margin)}
          </span>
          <span className="dash-footer-lbl">Margin</span>
        </div>
        <div className="dash-footer-spacer" />
        <div className="dash-footer-clock">
          <i className="ti ti-clock" aria-hidden="true" />
          {clock}
        </div>
      </footer>
    </div>
  );
}
