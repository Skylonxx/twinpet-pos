import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getBranchLabel } from '../lib/branches';
import { useAuth } from '../lib/hooks/useAuth';
import { fmtMoney } from '../lib/receiving/types';
import {
  RECEIVING_STATUS_LABELS,
  computeReceivingSummary,
  datePresetLabel,
  filterReceivings,
  formatReceivingDate,
  formatReceivingDateTime,
  getDateRange,
  type DatePreset,
  type ReceivingRecord,
  type ReceivingStatusFilter,
} from '../lib/receivingHistory/types';
import { useReceivingHistory } from '../lib/receivingHistory/useReceivingHistory';
import type { ReceivingStatus } from '../lib/types';
import './ReceivingHistoryPage.css';

const PAGE_SIZE = 15;

function buildPaginationItems(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 1) return [1];
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const items: (number | 'ellipsis')[] = [1];
  let left = Math.max(2, current - 1);
  let right = Math.min(total - 1, current + 1);
  if (current <= 3) {
    left = 2;
    right = 4;
  } else if (current >= total - 2) {
    left = total - 3;
    right = total - 1;
  }
  if (left > 2) items.push('ellipsis');
  for (let i = left; i <= right; i++) items.push(i);
  if (right < total - 1) items.push('ellipsis');
  items.push(total);
  return items;
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
  const safePage = Math.min(page, pages);
  const start = total === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const end = Math.min(safePage * PAGE_SIZE, total);
  const pageItems = buildPaginationItems(safePage, pages);

  return (
    <div className="sh-bottom-bar">
      <span className="sh-bottom-info">
        {total === 0 ? 'ไม่มีรายการ' : `แสดง ${start}–${end} จาก ${total} รายการ`}
      </span>
      <div className="sh-pagination">
        <button
          type="button"
          className="sh-pg"
          disabled={safePage <= 1}
          onClick={() => onPage(safePage - 1)}
          aria-label="หน้าก่อน"
        >
          <i className="ti ti-chevron-left" style={{ fontSize: 11 }} aria-hidden="true" />
        </button>
        {pageItems.map((item, idx) =>
          item === 'ellipsis' ? (
            <span key={`e-${idx}`} className="sh-pg sh-pg-ellipsis">
              …
            </span>
          ) : (
            <button
              key={item}
              type="button"
              className={`sh-pg${safePage === item ? ' sh-on' : ''}`}
              onClick={() => onPage(item)}
            >
              {item}
            </button>
          ),
        )}
        <button
          type="button"
          className="sh-pg"
          disabled={safePage >= pages}
          onClick={() => onPage(safePage + 1)}
          aria-label="หน้าถัดไป"
        >
          <i className="ti ti-chevron-right" style={{ fontSize: 11 }} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ReceivingStatus }) {
  const cls =
    status === 'completed'
      ? 'rh-status-completed'
      : status === 'draft'
        ? 'rh-status-draft'
        : 'rh-status-cancelled';
  return (
    <span className={`sh-status-badge ${cls}`}>
      {RECEIVING_STATUS_LABELS[status]}
    </span>
  );
}

function fmtShort(n: number): string {
  return parseFloat(String(n || 0)).toLocaleString('th-TH', { maximumFractionDigits: 0 });
}

export default function ReceivingHistoryPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { branchId } = useAuth();
  const { records, loading, error, loadItems, refresh } = useReceivingHistory(branchId);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ReceivingStatusFilter>('all');
  const [datePreset, setDatePreset] = useState<DatePreset>('30d');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [dateMenuOpen, setDateMenuOpen] = useState(false);
  const dateDdRef = useRef<HTMLDivElement>(null);

  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerItems, setDrawerItems] = useState<ReceivingRecord['items']>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const msg = (location.state as { toast?: string } | null)?.toast;
    if (!msg) return;
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);

  const branchDisplay = branchId ? getBranchLabel(branchId) : '—';

  const dateRange = useMemo(
    () => getDateRange(datePreset, dateFrom, dateTo),
    [datePreset, dateFrom, dateTo],
  );

  const filtered = useMemo(
    () =>
      filterReceivings(records, {
        search,
        dateFrom: dateRange.start,
        dateTo: dateRange.end,
        status: statusFilter,
      }),
    [records, search, dateRange, statusFilter],
  );

  const summary = useMemo(() => computeReceivingSummary(filtered), [filtered]);

  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, datePreset, dateFrom, dateTo]);

  useEffect(() => {
    if (!dateMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (dateDdRef.current && !dateDdRef.current.contains(e.target as Node)) {
        setDateMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [dateMenuOpen]);

  const selected = useMemo(
    () => records.find((r) => r.receiving.id === selectedId) ?? null,
    [records, selectedId],
  );

  const openDrawer = useCallback(
    async (record: ReceivingRecord) => {
      setSelectedId(record.receiving.id);
      setItemsLoading(true);
      try {
        const items = record.items.length ? record.items : await loadItems(record.receiving.id);
        setDrawerItems(items);
      } finally {
        setItemsLoading(false);
      }
    },
    [loadItems],
  );

  const closeDrawer = useCallback(() => {
    setSelectedId(null);
    setDrawerItems([]);
  }, []);

  const goToEdit = () => {
    if (!selected) return;
    closeDrawer();
    navigate(`/receiving/history/edit/${selected.receiving.id}`);
  };

  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [selectedId, closeDrawer]);

  const dateLabel = datePresetLabel(datePreset, dateFrom, dateTo);

  return (
    <div className="sh-page">
      <header className="sh-topbar">
        <div className="sh-topbar-icon">
          <i className="ti ti-history" aria-hidden="true" />
        </div>
        <div className="sh-topbar-center">
          <div className="sh-topbar-title">ประวัติการรับเข้า</div>
          <div className="sh-topbar-sub">Inbound History</div>
        </div>
        <span className="sh-branch-badge">
          <i className="ti ti-map-pin" style={{ fontSize: 12 }} aria-hidden="true" />
          สาขา: {branchDisplay}
        </span>
        <button type="button" className="sh-btn sh-btn-ghost sh-btn-sm" onClick={() => refresh()}>
          <i className="ti ti-refresh" aria-hidden="true" /> Refresh
        </button>
      </header>

      <div className="sh-content">
        {error ? (
          <div className="sh-error-banner" role="alert">
            <i className="ti ti-alert-circle" aria-hidden="true" />
            <div>
              <strong>โหลดประวัติรับเข้าไม่สำเร็จ</strong>
              <div style={{ fontSize: 12, marginTop: 4 }}>{error.message}</div>
            </div>
          </div>
        ) : null}

        <div className="sh-metrics-grid">
          <div className="sh-metric-card">
            <span className="sh-metric-label">มูลค่ารับเข้ารวม</span>
            <span className="sh-metric-num" style={{ color: 'var(--p600, #534ab7)' }}>
              ฿{fmtShort(summary.totalAmt)}
            </span>
            <span className="sh-metric-sub">{summary.grnCount} GRN</span>
          </div>
          <div className="sh-metric-card">
            <span className="sh-metric-label">เอกสารรับเข้า</span>
            <span className="sh-metric-num">{summary.grnCount}</span>
            <span className="sh-metric-sub">รายการในช่วง</span>
          </div>
          <div className="sh-metric-card">
            <span className="sh-metric-label">รายการสินค้า</span>
            <span className="sh-metric-num" style={{ color: '#0f6e56' }}>
              {summary.lineCount}
            </span>
            <span className="sh-metric-sub">บรรทัดรับเข้า</span>
          </div>
        </div>

        <div className="sh-toolbar">
          <div className="sh-search-wrap">
            <i className="ti ti-search" aria-hidden="true" />
            <input
              placeholder="ค้นหา GRN, ผู้จำหน่าย, SKU..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="sh-date-dd" ref={dateDdRef}>
            <button
              type="button"
              className="sh-date-dd-btn"
              onClick={() => setDateMenuOpen((v) => !v)}
            >
              <i className="ti ti-calendar" aria-hidden="true" />
              <span>{dateLabel}</span>
              <i className="ti ti-chevron-down" style={{ fontSize: 10 }} aria-hidden="true" />
            </button>
            {dateMenuOpen ? (
              <div className="sh-date-dd-menu">
                {(
                  [
                    ['today', 'วันนี้'],
                    ['7d', '7 วันล่าสุด'],
                    ['30d', '30 วันล่าสุด'],
                    ['month', 'เดือนนี้'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={`sh-date-menu-item${datePreset === key ? ' on' : ''}`}
                    onClick={() => {
                      setDatePreset(key);
                      setDateMenuOpen(false);
                    }}
                  >
                    {label}
                  </button>
                ))}
                <div className="sh-date-custom-label">กำหนดเอง</div>
                <div className="sh-date-custom">
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => {
                      setDateFrom(e.target.value);
                      setDatePreset('custom');
                    }}
                  />
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => {
                      setDateTo(e.target.value);
                      setDatePreset('custom');
                    }}
                  />
                </div>
              </div>
            ) : null}
          </div>

          <div className="sh-stock-filter">
            {(
              [
                ['all', 'ทั้งหมด'],
                ['completed', 'สำเร็จ'],
                ['draft', 'แบบร่าง'],
                ['cancelled', 'ยกเลิก'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`sh-sf${statusFilter === value ? ' sh-on' : ''}`}
                onClick={() => setStatusFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="sh-card">
          <div className="sh-card-head">
            <i className="ti ti-truck-delivery" aria-hidden="true" />
            <span>รายการรับเข้า</span>
            <span className="sh-card-count">{loading ? '…' : `${filtered.length} รายการ`}</span>
          </div>
          <div className="sh-table-scroll">
            {loading ? (
              <div className="sh-loading">กำลังโหลดประวัติรับเข้า...</div>
            ) : (
              <table className="sh-table">
                <thead>
                  <tr>
                    <th>วันที่</th>
                    <th>เลขที่ GRN</th>
                    <th>ผู้จำหน่าย</th>
                    <th className="num">มูลค่ารวม</th>
                    <th>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="sh-empty-cell">
                        ไม่พบรายการในช่วงที่เลือก
                      </td>
                    </tr>
                  ) : (
                    paged.map((record) => (
                      <tr
                        key={record.receiving.id}
                        className={selectedId === record.receiving.id ? 'selected' : undefined}
                        onClick={() => void openDrawer(record)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td>{formatReceivingDate(record.receiving)}</td>
                        <td style={{ fontWeight: 500 }}>{record.receiving.id}</td>
                        <td>{record.receiving.supplierName}</td>
                        <td className="num" style={{ fontWeight: 500 }}>
                          ฿{fmtMoney(record.receiving.total)}
                        </td>
                        <td>
                          <StatusBadge status={record.receiving.status} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
          <PaginationBar total={filtered.length} page={page} onPage={setPage} />
        </div>
      </div>

      {selected ? (
        <div className="sh-drawer-root">
          <button
            type="button"
            className="sh-drawer-backdrop"
            aria-label="ปิดรายละเอียด"
            onClick={closeDrawer}
          />
          <aside className="sh-drawer open" role="dialog" aria-modal="true">
            <div className="sh-drawer-top">
              <div className="sh-drawer-top-left">
                <span className="sh-drawer-bill-no">{selected.receiving.id}</span>
                <span className="sh-drawer-time">
                  {formatReceivingDateTime(selected.receiving)}
                </span>
              </div>
              <div className="sh-drawer-top-right">
                <StatusBadge status={selected.receiving.status} />
                <button type="button" className="sh-drawer-close" onClick={closeDrawer} aria-label="ปิด">
                  <i className="ti ti-x" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="sh-drawer-body">
              <div className="sh-d-sec">
                    <div className="sh-d-sec-head">
                      <i className="ti ti-file-text" aria-hidden="true" /> ข้อมูลเอกสาร
                    </div>
                    <div className="sh-d-sec-body">
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span>ผู้จำหน่าย</span>
                        <strong>{selected.receiving.supplierName}</strong>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span>มูลค่ารวม</span>
                        <strong>฿{fmtMoney(selected.receiving.total)}</strong>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span>ส่วนลดท้ายบิล</span>
                        <strong>฿{fmtMoney(selected.receiving.discountAmt)}</strong>
                      </div>
                    {selected.receiving.note ? (
                      <div className="rh-drawer-note" style={{ marginTop: 8 }}>
                        {selected.receiving.note}
                      </div>
                    ) : null}
                    </div>
                  </div>
                  <div className="sh-d-sec">
                    <div className="sh-d-sec-head">
                      <i className="ti ti-package" aria-hidden="true" /> รายการที่รับเข้า
                    </div>
                    <div className="sh-d-sec-body" style={{ padding: 0 }}>
                    {itemsLoading ? (
                      <div className="sh-loading">กำลังโหลดรายการ...</div>
                    ) : (
                      <table className="sh-item-table">
                        <thead>
                          <tr>
                            <th>สินค้า</th>
                            <th className="r">จำนวน</th>
                            <th className="r">ต้นทุน/หน่วย</th>
                            <th className="r">รวม</th>
                          </tr>
                        </thead>
                        <tbody>
                          {drawerItems.map((item) => (
                            <tr key={item.id}>
                              <td>
                                <div className="sh-item-name">{item.productSnap.name}</div>
                                <div className="sh-item-sku">{item.productSnap.sku}</div>
                              </td>
                              <td className="r">
                                {item.qty} {item.unit}
                              </td>
                              <td className="r">฿{fmtMoney(item.costPerUnit)}</td>
                              <td className="r">฿{fmtMoney(item.lineTotal)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    </div>
                  </div>
            </div>

            <footer className="sh-drawer-footer">
              <button type="button" className="sh-df-btn sh-df-disabled" onClick={closeDrawer}>
                ปิด
              </button>
              <button
                type="button"
                className="sh-df-btn sh-df-print"
                onClick={goToEdit}
                disabled={selected.receiving.status === 'cancelled'}
              >
                <i className="ti ti-edit" aria-hidden="true" />
                {selected.receiving.status === 'draft' ? 'ดำเนินการต่อ' : 'แก้ไข'}
              </button>
            </footer>
          </aside>
        </div>
      ) : null}

      {toast ? <div className="sh-toast">{toast}</div> : null}
    </div>
  );
}
