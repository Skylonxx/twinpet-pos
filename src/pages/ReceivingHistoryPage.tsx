import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { DateRangeDropdown } from '../components/common/DateRangeDropdown';
import { useAuth } from '../lib/hooks/useAuth';
import { fmtMoney } from '../lib/receiving/types';
import { parseReceivingNote } from '../lib/receiving/receivingFormUtils';
import {
  RECEIVING_STATUS_LABELS,
  computeReceivingSummary,
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
import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../components/ui';
import './ReceivingHistoryPage.css';

const PAGE_SIZE = 15;

const RECEIVING_DATE_PRESETS: ReadonlyArray<readonly [DatePreset, string]> = [
  ['today', 'วันนี้'],
  ['yesterday', 'เมื่อวาน'],
  ['7d', '7 วันล่าสุด'],
  ['30d', '30 วันล่าสุด'],
  ['month', 'เดือนนี้'],
];

/** Default date filter on load: today. Resolve the concrete range so the
 *  initial data load stays in sync with the 'today' preset. */
const INITIAL_RECEIVING_RANGE = getDateRange('today', '', '');

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

function fmtIsoDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function ReceivingHistoryPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { branchId } = useAuth();
  const { records, loading, error, loadItems, refresh } = useReceivingHistory(branchId);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ReceivingStatusFilter>('all');
  const [datePreset, setDatePreset] = useState<DatePreset>('today');
  const [dateFrom, setDateFrom] = useState(INITIAL_RECEIVING_RANGE.start.toISOString().slice(0, 10));
  const [dateTo, setDateTo] = useState(INITIAL_RECEIVING_RANGE.end.toISOString().slice(0, 10));

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

  const selected = useMemo(
    () => records.find((r) => r.receiving.id === selectedId) ?? null,
    [records, selectedId],
  );

  const drawerParsedNote = useMemo(
    () => (selected ? parseReceivingNote(selected.receiving.note) : null),
    [selected],
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

          <DateRangeDropdown
            preset={datePreset}
            from={dateFrom}
            to={dateTo}
            presets={RECEIVING_DATE_PRESETS}
            resolveRange={getDateRange}
            onChange={({ preset, from, to }) => {
              setDatePreset(preset);
              setDateFrom(from);
              setDateTo(to);
            }}
          />

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
              <Table hoverable className="min-w-[720px]">
                <TableHead>
                  <TableRow>
                    <TableHeadCell>วันที่</TableHeadCell>
                    <TableHeadCell>เลขที่ GRN</TableHeadCell>
                    <TableHeadCell>ผู้จำหน่าย</TableHeadCell>
                    <TableHeadCell className="text-right">มูลค่ารวม</TableHeadCell>
                    <TableHeadCell>สถานะ</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {paged.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="sh-empty-cell">
                        ไม่พบรายการในช่วงที่เลือก
                      </TableCell>
                    </TableRow>
                  ) : (
                    paged.map((record) => (
                      <TableRow
                        key={record.receiving.id}
                        className={`cursor-pointer ${selectedId === record.receiving.id ? 'bg-[var(--p50)]' : ''}`}
                        onClick={() => void openDrawer(record)}
                      >
                        <TableCell>{formatReceivingDate(record.receiving)}</TableCell>
                        <TableCell style={{ fontWeight: 500 }}>{record.receiving.id}</TableCell>
                        <TableCell>{record.receiving.supplierName}</TableCell>
                        <TableCell className="text-right" style={{ fontWeight: 500 }}>
                          ฿{fmtMoney(record.receiving.total)}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={record.receiving.status} />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
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
                      {drawerParsedNote?.purchaseBillNo ? (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                          <span>เลขที่บิล</span>
                          <strong style={{ fontFamily: 'monospace', fontSize: 12 }}>{drawerParsedNote.purchaseBillNo}</strong>
                        </div>
                      ) : null}
                      {drawerParsedNote?.receiveDate ? (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                          <span>วันที่รับเข้า</span>
                          <strong>{fmtIsoDate(drawerParsedNote.receiveDate)}</strong>
                        </div>
                      ) : null}
                      {drawerParsedNote?.billDate ? (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                          <span>วันที่ซื้อในบิล</span>
                          <strong>{fmtIsoDate(drawerParsedNote.billDate)}</strong>
                        </div>
                      ) : null}
                      {drawerParsedNote?.freeNote ? (
                        <div className="rh-drawer-note" style={{ marginTop: 8 }}>
                          {drawerParsedNote.freeNote}
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
                      <Table className="table-fixed">
                        <TableHead>
                          <TableRow>
                            <TableHeadCell>สินค้า</TableHeadCell>
                            <TableHeadCell className="text-right">จำนวน</TableHeadCell>
                            <TableHeadCell className="text-right">ต้นทุน/หน่วย</TableHeadCell>
                            <TableHeadCell className="text-right">รวม</TableHeadCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {drawerItems.map((item) => (
                            <TableRow key={item.id}>
                              <TableCell>
                                <div className="sh-item-name">{item.productSnap.name}</div>
                                <div className="sh-item-sku">{item.productSnap.sku}</div>
                              </TableCell>
                              <TableCell className="text-right">
                                {item.qty} {item.unit}
                              </TableCell>
                              <TableCell className="text-right">฿{fmtMoney(item.costPerUnit)}</TableCell>
                              <TableCell className="text-right">฿{fmtMoney(item.lineTotal)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
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
