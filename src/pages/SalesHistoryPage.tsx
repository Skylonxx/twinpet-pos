import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBranchLabel } from '../lib/branches';
import { formatMoney } from '../lib/pos/cartUtils';
import {
  PAY_METHOD_META,
  PAYMENT_FILTER_OPTIONS,
  VOID_REASONS,
  computeSummary,
  customerInitials,
  datePresetLabel,
  filterSales,
  formatSaleDate,
  formatSaleDateTime,
  formatSaleTime,
  getDateRange,
  orderCreatedAt,
  saleDisplayStatus,
  type DatePreset,
  type SaleRecord,
  type SalesFilters,
  type StatusFilter,
} from '../lib/salesHistory/types';
import { useSalesHistory } from '../lib/salesHistory/useSalesHistory';
import { usePosProducts } from '../lib/pos/usePosProducts';
import { useAuth } from '../lib/hooks/useAuth';
import { isFirebaseConfigured } from '../lib/firebase';
import { voidOrderSafe } from '../lib/voidOrder';
import type { OrderItem, PaymentMethod } from '../lib/types';
import './SalesHistoryPage.css';

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
            <span key={`ellipsis-${idx}`} className="sh-pg sh-pg-ellipsis" aria-hidden="true">
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

const DEFAULT_DATE_PRESET: DatePreset = '30d';
const initialDateRange = getDateRange(DEFAULT_DATE_PRESET, '', '');

function fmtShort(n: number): string {
  return parseFloat(String(n || 0)).toLocaleString('th-TH', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function StatusBadge({ status }: { status: ReturnType<typeof saleDisplayStatus> }) {
  if (status === 'paid') {
    return (
      <span className="sh-status-badge sh-st-paid">
        <i className="ti ti-circle-check" style={{ fontSize: 10 }} aria-hidden="true" /> สำเร็จ
      </span>
    );
  }
  if (status === 'credit') {
    return (
      <span className="sh-status-badge sh-st-credit">
        <i className="ti ti-clock" style={{ fontSize: 10 }} aria-hidden="true" /> เงินเชื่อ
      </span>
    );
  }
  return (
    <span className="sh-status-badge sh-st-void">
      <i className="ti ti-ban" style={{ fontSize: 10 }} aria-hidden="true" /> ยกเลิก
    </span>
  );
}

function PayChip({ record }: { record: SaleRecord }) {
  const { payments } = record;
  if (payments.length === 0) {
    return <span className="sh-guest">—</span>;
  }
  if (payments.length > 1) {
    return <span className="sh-pay-chip sh-pay-multi">หลายช่องทาง</span>;
  }
  const method = payments[0]!.method;
  const meta = PAY_METHOD_META[method];
  return <span className={`sh-pay-chip ${meta.chipClass}`}>{meta.label}</span>;
}

function VoidModal({
  billLabel,
  open,
  processing,
  onClose,
  onConfirm,
}: {
  billLabel: string | null;
  open: boolean;
  processing: boolean;
  onClose: () => void;
  onConfirm: (reason: string, note: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) {
      setReason('');
      setNote('');
    }
  }, [open]);

  if (!open || !billLabel) return null;

  return (
    <div className="sh-modal-overlay" role="dialog" aria-modal="true">
      <div className="sh-void-modal">
        <div className="sh-void-modal-icon">
          <i className="ti ti-ban" aria-hidden="true" />
        </div>
        <div className="sh-void-modal-title">ยืนยันการยกเลิกบิล</div>
        <div className="sh-void-modal-sub">
          บิล {billLabel} จะถูกยกเลิกและ
          <br />
          ไม่สามารถกู้คืนได้
        </div>
        <div className="sh-void-field">
          <label>
            เหตุผลการยกเลิก <span style={{ color: '#e24b4a' }}>*</span>
          </label>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">เลือกเหตุผล</option>
            {VOID_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="sh-void-field">
          <label>หมายเหตุเพิ่มเติม</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="ระบุรายละเอียดเพิ่มเติม..."
          />
        </div>
        <div className="sh-void-actions">
          <button type="button" className="sh-v-cancel" onClick={onClose} disabled={processing}>
            ยกเลิก
          </button>
          <button
            type="button"
            className="sh-v-confirm"
            disabled={!reason || processing}
            onClick={() => onConfirm(reason, note)}
          >
            {processing ? 'กำลังยกเลิก...' : 'ยืนยันยกเลิกบิล'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SalesHistoryPage() {
  const { user, branchId } = useAuth();
  const { records, loading, error, loadItems, refresh, syncDevRecords } = useSalesHistory(branchId);
  // Source of UOM-specific barcodes — order line items don't persist a barcode,
  // so we resolve it from each product's uomOptions by the sold unit.
  const { products } = usePosProducts(branchId);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [paymentFilter, setPaymentFilter] = useState<PaymentMethod | 'all'>('all');
  const [datePreset, setDatePreset] = useState<DatePreset>(DEFAULT_DATE_PRESET);
  const [dateFrom, setDateFrom] = useState(initialDateRange.start.toISOString().slice(0, 10));
  const [dateTo, setDateTo] = useState(initialDateRange.end.toISOString().slice(0, 10));
  const [dateMenuOpen, setDateMenuOpen] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawerItems, setDrawerItems] = useState<SaleRecord['items']>([]);
  const [itemsLoading, setItemsLoading] = useState(false);

  const [voidOpen, setVoidOpen] = useState(false);
  const [voidProcessing, setVoidProcessing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [tablePage, setTablePage] = useState(1);

  const dateDdRef = useRef<HTMLDivElement>(null);
  const tableCardRef = useRef<HTMLDivElement>(null);

  const branchDisplay = branchId ? getBranchLabel(branchId) : '—';

  const productById = useMemo(() => {
    const map = new Map<string, (typeof products)[number]>();
    for (const p of products) map.set(p.id, p);
    return map;
  }, [products]);

  /**
   * Resolve the barcode to show for an order line. The line item stores no
   * barcode, only the sold `unit` (e.g. "ลัง"). We match that unit against the
   * product's uomOptions (which includes the base unit) to get the UOM-specific
   * barcode, falling back to the product's base barcode when that unit has none.
   */
  const resolveItemBarcode = useCallback(
    (it: OrderItem): string | null => {
      const product = productById.get(it.productId);
      if (!product) return null;
      const uom = product.uomOptions.find((u) => u.unit === it.unit);
      return (uom?.barcode || product.barcode) ?? null;
    },
    [productById],
  );

  const canVoid = Boolean(
    user?.permissions.canVoidOrder || user?.role === 'admin' || user?.role === 'manager',
  );

  const filters: SalesFilters = useMemo(
    () => ({
      search,
      status: statusFilter,
      paymentMethod: paymentFilter,
      datePreset,
      dateFrom,
      dateTo,
    }),
    [search, statusFilter, paymentFilter, datePreset, dateFrom, dateTo],
  );

  const filtered = useMemo(() => filterSales(records, filters), [records, filters]);
  const summary = useMemo(() => computeSummary(filtered), [filtered]);
  const pageRows = useMemo(
    () => filtered.slice((tablePage - 1) * PAGE_SIZE, tablePage * PAGE_SIZE),
    [filtered, tablePage],
  );

  const handleTablePageChange = useCallback((nextPage: number) => {
    setTablePage(nextPage);
    tableCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const selected = useMemo(
    () => filtered.find((r) => r.order.id === selectedId) ?? null,
    [filtered, selectedId],
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  const openDrawer = useCallback(
    async (record: SaleRecord) => {
      setSelectedId(record.order.id);
      if (record.items.length) {
        setDrawerItems(record.items);
        return;
      }
      setItemsLoading(true);
      try {
        const items = await loadItems(record.order.id);
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

  const handleVoidConfirm = useCallback(
    async (reason: string, note: string) => {
      if (!selected || !user || !branchId) return;
      setVoidProcessing(true);
      try {
        await voidOrderSafe({
          orderId: selected.order.id,
          branchId,
          reason,
          note,
          voidedBy: user.id,
          voidedByName: `${user.firstName} ${user.lastName}`,
        });
        setVoidOpen(false);
        showToast('ยกเลิกบิลสำเร็จ — คืนสต็อกแล้ว');
        if (!isFirebaseConfigured) {
          syncDevRecords();
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'ยกเลิกบิลไม่สำเร็จ');
      } finally {
        setVoidProcessing(false);
      }
    },
    [selected, user, branchId, showToast, syncDevRecords],
  );

  useEffect(() => {
    setTablePage(1);
  }, [search, statusFilter, paymentFilter, datePreset, dateFrom, dateTo]);

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (tablePage > maxPage) setTablePage(maxPage);
  }, [filtered.length, tablePage]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (dateDdRef.current && !dateDdRef.current.contains(e.target as Node)) {
        setDateMenuOpen(false);
      }
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  useEffect(() => {
    if (selected && selected.items.length) {
      setDrawerItems(selected.items);
    }
  }, [selected]);

  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !voidOpen) closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, voidOpen, closeDrawer]);

  useEffect(() => {
    if (!selectedId) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [selectedId]);

  const dateLabel =
    datePreset === 'custom'
      ? `${dateFrom} – ${dateTo}`
      : datePresetLabel(datePreset);

  const itemsSubtotal =
    drawerItems.reduce((s, i) => s + i.unitPrice * i.qty, 0) ||
    selected?.order.subtotal ||
    0;

  return (
    <div className="sh-page">
      <header className="sh-topbar">
        <div className="sh-topbar-icon">
          <i className="ti ti-receipt" aria-hidden="true" />
        </div>
        <div className="sh-topbar-center">
          <div className="sh-topbar-title">ประวัติการขาย</div>
          <div className="sh-topbar-sub">Sales History</div>
        </div>
        <span className="sh-branch-badge">
          <i className="ti ti-map-pin" style={{ fontSize: 12 }} aria-hidden="true" />
          สาขา: {branchDisplay}
        </span>
        <button
          type="button"
          className="sh-btn sh-btn-ghost sh-btn-sm"
          title="รีเฟรช"
          onClick={() => refresh()}
        >
          <i className="ti ti-refresh" aria-hidden="true" /> Refresh
        </button>
        <button type="button" className="sh-btn sh-btn-ghost sh-btn-sm">
          <i className="ti ti-download" aria-hidden="true" /> Export
        </button>
      </header>

      <div className="sh-content">
        {error ? (
          <div className="sh-error-banner" role="alert">
            <i className="ti ti-alert-circle" aria-hidden="true" />
            <div>
              <strong>โหลดประวัติการขายไม่สำเร็จ</strong>
              <div style={{ fontSize: 12, marginTop: 4 }}>{error.message}</div>
              <div style={{ fontSize: 11, marginTop: 4, opacity: 0.85 }}>
                ตรวจสอบ Console (F12) สำหรับรายละเอียด — อาจต้องสร้าง Firestore Index
              </div>
            </div>
          </div>
        ) : null}

        <div className="sh-metrics-grid">
          <div className="sh-metric-card">
            <span className="sh-metric-label">ยอดขายรวม</span>
            <span className="sh-metric-num" style={{ color: 'var(--p600, #534ab7)' }}>
              ฿{fmtShort(summary.totalAmt)}
            </span>
            <span className="sh-metric-sub">{summary.billCount} บิล</span>
          </div>
          <div className="sh-metric-card">
            <span className="sh-metric-label">บิลสำเร็จ</span>
            <span className="sh-metric-num" style={{ color: '#0f6e56' }}>
              {summary.paidCount}
            </span>
            <span className="sh-metric-sub">฿{fmtShort(summary.paidAmt)}</span>
          </div>
          <div className="sh-metric-card">
            <span className="sh-metric-label">บิลเงินเชื่อ</span>
            <span className="sh-metric-num" style={{ color: '#854f0b' }}>
              {summary.creditCount}
            </span>
            <span className="sh-metric-sub">฿{fmtShort(summary.creditAmt)}</span>
          </div>
          <div className="sh-metric-card">
            <span className="sh-metric-label">บิลยกเลิก</span>
            <span className="sh-metric-num" style={{ color: '#a32d2d' }}>
              {summary.voidCount}
            </span>
            <span className="sh-metric-sub">{summary.voidCount} บิล</span>
          </div>
          <div className="sh-metric-card">
            <span className="sh-metric-label">เงินสด</span>
            <span className="sh-metric-num">฿{fmtShort(summary.cashAmt)}</span>
            <span className="sh-metric-sub">ช่องทางหลัก</span>
          </div>
        </div>

        <div className="sh-toolbar">
          <div className="sh-search-wrap">
            <i className="ti ti-search" aria-hidden="true" />
            <input
              placeholder="ค้นหาเลขที่บิล, ชื่อลูกค้า, เบอร์โทร..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="sh-date-dd" ref={dateDdRef}>
            <button
              type="button"
              className="sh-date-dd-btn"
              onClick={(e) => {
                e.stopPropagation();
                setDateMenuOpen((v) => !v);
              }}
            >
              <i className="ti ti-calendar" aria-hidden="true" />
              <span>{dateLabel}</span>
              <i className="ti ti-chevron-down" style={{ fontSize: 10 }} aria-hidden="true" />
            </button>
            {dateMenuOpen && (
              <div className="sh-date-dd-menu">
                {(
                  [
                    ['today', 'วันนี้'],
                    ['yesterday', 'เมื่อวาน'],
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
            )}
          </div>

          <select
            className="sh-sel"
            value={paymentFilter}
            onChange={(e) => setPaymentFilter(e.target.value as PaymentMethod | 'all')}
          >
            {PAYMENT_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <div className="sh-stock-filter">
            {(
              [
                ['all', 'ทั้งหมด'],
                ['paid', 'สำเร็จ'],
                ['credit', 'เงินเชื่อ'],
                ['void', 'ยกเลิก'],
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

        <div className="sh-body-row">
          <div className="sh-card" ref={tableCardRef}>
            <div className="sh-card-head">
              <i className="ti ti-list" aria-hidden="true" />
              <span>รายการขาย</span>
              <span className="sh-card-count">
                {loading ? '…' : `${filtered.length} รายการ`}
              </span>
            </div>
            <div className="sh-table-scroll">
              {loading ? (
                <div className="sh-loading">กำลังโหลดประวัติการขาย...</div>
              ) : (
                <table className="sh-table">
                  <thead>
                    <tr>
                      <th style={{ width: 70 }}>เวลา</th>
                      <th style={{ width: 120 }}>เลขที่บิล</th>
                      <th>ลูกค้า</th>
                      <th style={{ width: 110 }}>ช่องทางชำระ</th>
                      <th style={{ width: 100 }}>พนักงาน</th>
                      <th className="num" style={{ width: 100 }}>
                        ยอดสุทธิ
                      </th>
                      <th style={{ width: 90, textAlign: 'center' }}>สถานะ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr className="sh-empty-row">
                        <td colSpan={7}>ไม่พบรายการขายในช่วงเวลาที่เลือก</td>
                      </tr>
                    ) : (
                      pageRows.map((record) => {
                        const { order } = record;
                        const created = orderCreatedAt(order);
                        const status = saleDisplayStatus(order);
                        const isVoid = status === 'void';
                        return (
                          <tr
                            key={order.id}
                            className={selectedId === order.id ? 'selected' : undefined}
                            onClick={() => void openDrawer(record)}
                          >
                            <td className="sh-col-time">{formatSaleTime(created)}</td>
                            <td>
                              <span className="sh-bill-no">{order.billId || order.id}</span>
                            </td>
                            <td>
                              {order.customerSnap ? (
                                <div className="sh-cust-cell">
                                  <div className="sh-cust-name-td">{order.customerSnap.name}</div>
                                  <div className="sh-cust-phone">{order.customerSnap.phone}</div>
                                </div>
                              ) : (
                                <span className="sh-guest">— Guest —</span>
                              )}
                            </td>
                            <td>
                              <PayChip record={record} />
                            </td>
                            <td>
                              <span className="sh-staff-name">{order.staffName}</span>
                            </td>
                            <td className="num">
                              <span className={`sh-total-amt${isVoid ? ' void' : ''}`}>
                                ฿{formatMoney(order.total)}
                              </span>
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <StatusBadge status={status} />
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              )}
            </div>
            <PaginationBar total={filtered.length} page={tablePage} onPage={handleTablePageChange} />
          </div>
        </div>
      </div>

      {selected ? (
        <div className="sh-drawer-root">
          <button
            type="button"
            className="sh-drawer-backdrop"
            aria-label="ปิดรายละเอียดบิล"
            onClick={closeDrawer}
          />
          <aside className="sh-drawer open" role="dialog" aria-modal="true" aria-label="รายละเอียดบิล">
              <div className="sh-drawer-top">
                <div className="sh-drawer-top-left">
                  <span className="sh-drawer-bill-no">{selected.order.billId || selected.order.id}</span>
                  <span className="sh-drawer-time">
                    {formatSaleDateTime(orderCreatedAt(selected.order))}
                  </span>
                </div>
                <div className="sh-drawer-top-right">
                  <StatusBadge status={saleDisplayStatus(selected.order)} />
                  <button
                    type="button"
                    className="sh-drawer-close"
                    onClick={closeDrawer}
                    aria-label="ปิด"
                  >
                    <i className="ti ti-x" style={{ fontSize: 12 }} aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="sh-drawer-body">
                {saleDisplayStatus(selected.order) === 'void' && (
                  <div className="sh-void-banner">
                    <i className="ti ti-ban" aria-hidden="true" />
                    <div>
                      <div className="sh-void-reason">บิลถูกยกเลิกแล้ว</div>
                      <div style={{ fontSize: 10, marginTop: 2 }}>
                        เหตุผล: {selected.order.voidReason ?? 'ไม่ระบุ'}
                      </div>
                    </div>
                  </div>
                )}

                <div className="sh-d-sec">
                  <div className="sh-d-sec-head">
                    <i className="ti ti-user" aria-hidden="true" /> ลูกค้า
                  </div>
                  <div className="sh-d-sec-body">
                    {selected.order.customerSnap ? (
                      <div className="sh-cust-info-row">
                        <div className="sh-cust-avatar">
                          {customerInitials(selected.order.customerSnap.name)}
                        </div>
                        <div className="sh-cust-detail">
                          <div className="sh-cust-dname">{selected.order.customerSnap.name}</div>
                          <div className="sh-cust-dmeta">
                            <span>{selected.order.customerSnap.phone}</span>
                            {selected.order.priceLevelId && (
                              <span className="sh-tier-badge">{selected.order.priceLevelId}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--g400)' }}>
                        ลูกค้าทั่วไป (ไม่ระบุ)
                      </div>
                    )}
                  </div>
                </div>

                <div className="sh-d-sec">
                  <div className="sh-d-sec-head">
                    <i className="ti ti-shopping-cart" aria-hidden="true" /> รายการสินค้า
                  </div>
                  <div className="sh-d-sec-body" style={{ padding: 0 }}>
                    {itemsLoading ? (
                      <div className="sh-loading">กำลังโหลดรายการ...</div>
                    ) : (
                      <table className="sh-item-table">
                        <thead>
                          <tr>
                            <th>สินค้า</th>
                            <th className="r" style={{ width: 70 }}>
                              จำนวน
                            </th>
                            <th className="r" style={{ width: 110 }}>
                              ราคา
                            </th>
                            <th className="r" style={{ width: 120 }}>
                              รวม
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {drawerItems.map((it) => {
                            const barcode = resolveItemBarcode(it);
                            return (
                              <tr key={it.id}>
                                <td>
                                  <div className="sh-item-name">
                                    {it.productSnap.name}
                                    {it.unit ? (
                                      <span className="sh-item-unit">({it.unit})</span>
                                    ) : null}
                                  </div>
                                  <div className="sh-item-sku">
                                    {it.productSnap.sku}
                                    {it.discountAmt > 0 && (
                                      <>
                                        {' '}
                                        <span className="sh-item-disc">
                                          ลด ฿{formatMoney(it.discountAmt)}
                                        </span>
                                      </>
                                    )}
                                  </div>
                                  {barcode ? (
                                    <div className="sh-item-barcode">
                                      <i className="ti ti-barcode" aria-hidden="true" />
                                      {barcode}
                                    </div>
                                  ) : null}
                                </td>
                                <td className="r">{it.qty}</td>
                                <td className="r">฿{formatMoney(it.unitPrice)}</td>
                                <td className="r">฿{formatMoney(it.lineTotal)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>

                <div className="sh-d-sec">
                  <div className="sh-d-sec-head">
                    <i className="ti ti-receipt" aria-hidden="true" /> สรุปการชำระ
                  </div>
                  <div className="sh-d-sec-body">
                    <div className="sh-pay-row">
                      <span className="sh-pay-row-lbl">ราคาสินค้ารวม</span>
                      <span className="sh-pay-row-val">
                        ฿{formatMoney(itemsSubtotal)}
                      </span>
                    </div>
                    {selected.order.billDiscount > 0 && (
                      <div className="sh-pay-row">
                        <span className="sh-pay-row-lbl">ส่วนลดท้ายบิล</span>
                        <span className="sh-pay-row-val green">
                          -฿{formatMoney(selected.order.billDiscount)}
                        </span>
                      </div>
                    )}
                    {selected.order.surcharge > 0 && (
                      <div className="sh-pay-row">
                        <span className="sh-pay-row-lbl">ค่าธรรมเนียม</span>
                        <span className="sh-pay-row-val amber">
                          +฿{formatMoney(selected.order.surcharge)}
                        </span>
                      </div>
                    )}
                    <hr className="sh-pay-divider" />
                    <div className="sh-pay-total-row">
                      <span className="sh-pay-total-lbl">รวมสุทธิ</span>
                      <span className="sh-pay-total-val">฿{formatMoney(selected.order.total)}</span>
                    </div>
                    <hr className="sh-pay-divider" style={{ marginTop: 8 }} />
                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 10,
                        color: 'var(--g400)',
                        fontWeight: 500,
                        marginBottom: 5,
                      }}
                    >
                      ช่องทางชำระ
                    </div>
                    {selected.payments.map((p) => {
                      const meta = PAY_METHOD_META[p.method];
                      return (
                        <div key={p.id} className="sh-pay-method-row">
                          <span className="sh-pay-method-name">
                            <i className={`ti ${meta.icon}`} aria-hidden="true" />
                            {meta.label}
                          </span>
                          <span className="sh-pay-method-amt">฿{formatMoney(p.amount)}</span>
                        </div>
                      );
                    })}
                    {selected.order.changeAmt > 0 && (
                      <div className="sh-pay-row" style={{ marginTop: 4 }}>
                        <span className="sh-pay-row-lbl">เงินทอน</span>
                        <span className="sh-pay-row-val green">
                          ฿{formatMoney(selected.order.changeAmt)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="sh-d-sec">
                  <div className="sh-d-sec-head">
                    <i className="ti ti-info-circle" aria-hidden="true" /> ข้อมูลเพิ่มเติม
                  </div>
                  <div className="sh-d-sec-body">
                    <div className="sh-meta-grid">
                      <div className="sh-meta-item">
                        <span className="sh-meta-lbl">วันที่</span>
                        <span className="sh-meta-val">
                          {formatSaleDate(orderCreatedAt(selected.order))}
                        </span>
                      </div>
                      <div className="sh-meta-item">
                        <span className="sh-meta-lbl">เวลา</span>
                        <span className="sh-meta-val">
                          {formatSaleTime(orderCreatedAt(selected.order))} น.
                        </span>
                      </div>
                      <div className="sh-meta-item">
                        <span className="sh-meta-lbl">พนักงานขาย</span>
                        <span className="sh-meta-val">{selected.order.staffName}</span>
                      </div>
                      <div className="sh-meta-item">
                        <span className="sh-meta-lbl">สาขา</span>
                        <span className="sh-meta-val">{branchDisplay}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <footer className="sh-drawer-footer">
                {saleDisplayStatus(selected.order) === 'void' ? (
                  <button type="button" className="sh-df-btn sh-df-disabled" disabled>
                    <i className="ti ti-printer" aria-hidden="true" /> พิมพ์ใบยกเลิก
                  </button>
                ) : (
                  <>
                    <button type="button" className="sh-df-btn sh-df-print">
                      <i className="ti ti-printer" aria-hidden="true" /> พิมพ์ใบเสร็จ
                    </button>
                    {canVoid && (
                      <button
                        type="button"
                        className="sh-df-btn sh-df-void"
                        onClick={() => setVoidOpen(true)}
                      >
                        <i className="ti ti-ban" aria-hidden="true" /> ยกเลิกบิล
                      </button>
                    )}
                  </>
                )}
              </footer>
          </aside>
        </div>
      ) : null}

      <VoidModal
        open={voidOpen}
        billLabel={selected ? selected.order.billId || selected.order.id : null}
        processing={voidProcessing}
        onClose={() => !voidProcessing && setVoidOpen(false)}
        onConfirm={handleVoidConfirm}
      />

      {toast && <div className="sh-toast">{toast}</div>}
    </div>
  );
}
