import { useMemo, useState } from 'react';
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
import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../../components/ui';
import './AdminDashboardPage.css';

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

const RANK_CLASSES = ['adash-rb-1', 'adash-rb-2', 'adash-rb-3', 'adash-rb-n', 'adash-rb-n'];

function CompareBadge({ pct }: { pct: number }) {
  if (Math.abs(pct) < 0.5) {
    return <span className="adash-kpi-badge adash-badge-flat">— ทรงตัว</span>;
  }
  const up = pct > 0;
  return (
    <span className={`adash-kpi-badge ${up ? 'adash-badge-up' : 'adash-badge-dn'}`}>
      <i className={`ti ti-arrow-${up ? 'up' : 'down'}`} aria-hidden="true" />
      {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

export default function AdminDashboardPage() {
  const [period, setPeriod] = useState<DashboardPeriod>('today');
  const [selectedBranch, setSelectedBranch] = useState<AdminBranchSelection>(ALL_BRANCHES);
  const { branches } = useBranchManagement();

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
    <div className="adash-page">
      <header className="adash-toolbar">
        <div>
          <div className="adash-toolbar-title">Admin Dashboard</div>
          <div className="adash-toolbar-sub">ภาพรวมธุรกิจ TwinPet — {scopeLabel}</div>
        </div>
        <div className="adash-toolbar-center" />
        <select
          className="adash-branch-select"
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
        <div className="adash-period-tabs" role="tablist">
          {(['today', 'week', 'month'] as DashboardPeriod[]).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={period === p}
              className={`adash-period-tab${period === p ? ' active' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
        <div className="adash-live-dot" title="Live data" />
      </header>

      <div className="adash-content">
        {loading && <div className="adash-loading">กำลังโหลดข้อมูล...</div>}
        {error && (
          <div className="adash-loading" style={{ color: 'var(--danger)' }}>
            {error.message}
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="adash-kpi-grid">
              <div className="adash-kpi-card adash-kc-rev">
                <i className="adash-kpi-icon-bg ti ti-coin" aria-hidden="true" />
                <div className="adash-kpi-label">
                  <i className="ti ti-coin" style={{ fontSize: 12 }} aria-hidden="true" />
                  ยอดขายรวม
                </div>
                <div className="adash-kpi-num">{fmtBaht(kpi.revenue)}</div>
                <div className="adash-kpi-compare">
                  <CompareBadge pct={revPct} />
                  <span className="adash-kpi-vs">{vsLabel}</span>
                </div>
              </div>

              <div className="adash-kpi-card adash-kc-profit">
                <i className="adash-kpi-icon-bg ti ti-trending-up" aria-hidden="true" />
                <div className="adash-kpi-label">
                  <i className="ti ti-trending-up" style={{ fontSize: 12 }} aria-hidden="true" />
                  กำไรขั้นต้น
                </div>
                <div className="adash-kpi-num">{fmtBaht(kpi.profit)}</div>
                <div className="adash-kpi-compare">
                  <CompareBadge pct={profPct} />
                  <span className="adash-kpi-vs">{vsLabel}</span>
                </div>
              </div>

              <div className="adash-kpi-card adash-kc-orders">
                <i className="adash-kpi-icon-bg ti ti-receipt" aria-hidden="true" />
                <div className="adash-kpi-label">
                  <i className="ti ti-receipt" style={{ fontSize: 12 }} aria-hidden="true" />
                  จำนวนบิล
                </div>
                <div className="adash-kpi-num">{fmtNumber(kpi.bills)}</div>
                <div className="adash-kpi-compare">
                  <CompareBadge pct={billPct} />
                  <span className="adash-kpi-vs">{vsLabel}</span>
                </div>
              </div>

              <div className="adash-kpi-card adash-kc-stock">
                <i className="adash-kpi-icon-bg ti ti-percentage" aria-hidden="true" />
                <div className="adash-kpi-label">
                  <i className="ti ti-percentage" style={{ fontSize: 12 }} aria-hidden="true" />
                  Gross Margin
                </div>
                <div className="adash-kpi-num">{fmtPct(kpi.margin)}</div>
                <div className="adash-kpi-compare">
                  <span
                    className={`adash-kpi-badge ${
                      kpi.margin >= 20
                        ? 'adash-badge-up'
                        : kpi.margin >= 10
                          ? 'adash-badge-flat'
                          : 'adash-badge-dn'
                    }`}
                  >
                    {kpi.margin >= 20 ? '✓ ดี' : kpi.margin >= 10 ? '⚠ ปานกลาง' : '✗ ต่ำ'}
                  </span>
                </div>
              </div>
            </div>

            <div className="adash-chart-row">
              <div className="adash-chart-box">
                <div className="adash-chart-head">
                  <div className="adash-chart-title">
                    <i className="ti ti-chart-bar" aria-hidden="true" />
                    {data.trendTitle}
                  </div>
                  <div className="adash-chart-legend">
                    <div className="adash-legend-item">
                      <div className="adash-legend-dot" style={{ background: 'var(--p600)' }} />
                      ยอดขาย
                    </div>
                    <div className="adash-legend-item">
                      <div className="adash-legend-dot" style={{ background: 'var(--success)' }} />
                      กำไร
                    </div>
                  </div>
                </div>
                <div className="adash-chart-canvas-wrap">
                  <Bar data={trendChartData} options={chartOptions} />
                </div>
              </div>

              <div className="adash-chart-box">
                <div className="adash-chart-head">
                  <div className="adash-chart-title">
                    <i className="ti ti-chart-donut" aria-hidden="true" />
                    ยอดขายตามหมวดหมู่
                  </div>
                </div>
                {data.categories.length > 0 ? (
                  <div className="adash-donut-wrap">
                    <div className="adash-donut-canvas">
                      <Doughnut data={donutChartData} options={donutOptions} />
                    </div>
                    <div className="adash-donut-legend">
                      {data.categories.map((c) => (
                        <div key={c.category} className="adash-dl-row">
                          <div className="adash-dl-dot" style={{ background: c.color }} />
                          <span className="adash-dl-lbl">{c.category}</span>
                          <span className="adash-dl-val">{fmtBaht(c.revenue)}</span>
                          <span className="adash-dl-pct">
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

            <section className="adash-pay-section">
              <div className="adash-chart-head" style={{ marginBottom: 0 }}>
                <div className="adash-chart-title">
                  <i className="ti ti-credit-card" aria-hidden="true" />
                  ช่องทางการชำระเงิน
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {PERIOD_LABELS[period]}
                </span>
              </div>
              <div className="adash-pay-scroll">
                <div className="adash-pay-grid">
                  {data.payments.map((row) => {
                    const m = PAY_META[row.method];
                    return (
                      <div key={row.method} className="adash-pay-card">
                        <div
                          className="adash-pay-icon"
                          style={{ background: m.iconBg, color: m.clr }}
                        >
                          <i className={`ti ${m.icon}`} aria-hidden="true" />
                        </div>
                        <div className="adash-pay-info">
                          <div className="adash-pay-name">{m.label}</div>
                          <div className="adash-pay-rev" style={{ color: m.clr }}>
                            {fmtBaht(row.revenue)}
                          </div>
                          <div className="adash-pay-meta">
                            <span className="adash-pay-bills">{row.bills} บิล</span>
                            <span
                              className="adash-pay-pct-pill"
                              style={{ background: m.iconBg, color: m.clr }}
                            >
                              {row.pct.toFixed(1)}%
                            </span>
                          </div>
                          <div className="adash-pay-bar-bg">
                            <div
                              className="adash-pay-bar-fill"
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

            <div className="adash-bottom-row">
              <div className="adash-table-card">
                <div className="adash-tc-head">
                  <i className="ti ti-medal" aria-hidden="true" />
                  Top สินค้าขายดี
                  <span className="adash-badge-count">{data.topProducts.length}</span>
                </div>
                <div className="adash-tc-body">
                  <Table>
                    <TableHead>
                      <TableRow>
                        <TableHeadCell>#</TableHeadCell>
                        <TableHeadCell>สินค้า</TableHeadCell>
                        <TableHeadCell className="text-right">ยอดขาย</TableHeadCell>
                        <TableHeadCell className="text-right">กำไร</TableHeadCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {data.topProducts.map((row, i) => {
                        const pct = (row.revenue / maxProdRev) * 100;
                        return (
                          <TableRow key={row.productId}>
                            <TableCell>
                              <span className={`adash-rank-ball ${RANK_CLASSES[i]}`}>
                                {i + 1}
                              </span>
                            </TableCell>
                            <TableCell>
                              <div style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.2 }}>
                                {truncate(row.name, 22)}
                              </div>
                              <div className="adash-bar-inline" style={{ width: 70 }}>
                                <div
                                  className="adash-bar-fill-p"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </TableCell>
                            <TableCell className="text-right" style={{ color: 'var(--p600)', fontWeight: 500 }}>
                              {fmtBaht(row.revenue)}
                            </TableCell>
                            <TableCell className="text-right" style={{ color: 'var(--success)' }}>
                              {fmtBaht(row.profit)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>

              <div className="adash-table-card">
                <div className="adash-tc-head">
                  <i className="ti ti-crown" aria-hidden="true" />
                  Top ลูกค้า
                  <span className="adash-badge-count">{data.topCustomers.length}</span>
                </div>
                <div className="adash-tc-body">
                  <Table>
                    <TableHead>
                      <TableRow>
                        <TableHeadCell>#</TableHeadCell>
                        <TableHeadCell>ลูกค้า</TableHeadCell>
                        <TableHeadCell className="text-right">ยอดขาย</TableHeadCell>
                        <TableHeadCell className="text-right">บิล</TableHeadCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {data.topCustomers.map((row, i) => {
                        const pct = (row.revenue / maxCustRev) * 100;
                        return (
                          <TableRow key={row.name}>
                            <TableCell>
                              <span className={`adash-rank-ball ${RANK_CLASSES[i]}`}>
                                {i + 1}
                              </span>
                            </TableCell>
                            <TableCell>
                              <div style={{ fontSize: 12, fontWeight: 500 }}>
                                {truncate(row.name, 16)}
                              </div>
                              <div className="adash-bar-inline" style={{ width: 80 }}>
                                <div
                                  className="adash-bar-fill-g"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </TableCell>
                            <TableCell className="text-right" style={{ color: 'var(--p600)', fontWeight: 500 }}>
                              {fmtBaht(row.revenue)}
                            </TableCell>
                            <TableCell className="text-right" style={{ color: 'var(--text-muted)' }}>
                              {row.bills}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>

              <div className="adash-table-card">
                <div className="adash-tc-head">
                  <i className="ti ti-alert-triangle" aria-hidden="true" />
                  แจ้งเตือนสต็อก
                  <span className="adash-badge-count">{data.stockAlerts.length}</span>
                </div>
                <div className="adash-tc-body">
                  <Table>
                    <TableHead>
                      <TableRow>
                        <TableHeadCell>สินค้า</TableHeadCell>
                        <TableHeadCell className="text-right">คงเหลือ</TableHeadCell>
                        <TableHeadCell className="text-right">Reorder</TableHeadCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {data.stockAlerts.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={3} style={{ color: 'var(--text-muted)' }}>
                            สต็อกปกติทุกรายการ
                          </TableCell>
                        </TableRow>
                      ) : (
                        data.stockAlerts.map((row) => (
                          <TableRow key={row.productId}>
                            <TableCell style={{ fontSize: 12, fontWeight: 500 }}>
                              {truncate(row.name, 18)}
                            </TableCell>
                            <TableCell className="text-right">
                              <span
                                className={
                                  row.qty === 0 || row.critical
                                    ? 'adash-stock-num-crit'
                                    : 'adash-stock-num-low'
                                }
                              >
                                {row.qty === 0 ? 'หมด' : row.qty}
                              </span>
                            </TableCell>
                            <TableCell className="text-right" style={{ color: 'var(--text-muted)' }}>
                              {row.reorderPoint}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
