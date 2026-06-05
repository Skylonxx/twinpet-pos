import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, getDocs, orderBy, query } from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../../lib/firebase';
import { fetchAllBranches } from '../../lib/admin/branchManagement';
import { seedBranchLabelCache } from '../../lib/branches';
import { useAuth } from '../../lib/hooks/useAuth';
import { confirmReceiving } from '../../lib/receiving/confirmReceiving';
import { fmtMoney } from '../../lib/receiving/types';
import type { ReceivingFormSubmitPayload, ReceivingFormValues } from '../../lib/receiving/receivingFormUtils';
import { parseReceivingNote } from '../../lib/receiving/receivingFormUtils';
import {
  formLinesToDraftLines,
  formLinesToEditLines,
  receivingFormValuesFromRecord,
} from '../../lib/receivingHistory/receivingFormValues';
import { saveReceivingDraft } from '../../lib/receivingHistory/saveReceivingDraft';
import { updateReceiving } from '../../lib/receivingHistory/updateReceiving';
import { cancelReceiving } from '../../lib/receivingHistory/cancelReceiving';
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
} from '../../lib/receivingHistory/types';
import { DateRangeDropdown } from '../../components/common/DateRangeDropdown';
import ReceivingForm from '../../components/receiving/ReceivingForm';
import type { Branch, Receiving, ReceivingItem, ReceivingStatus } from '../../lib/types';
import '../ReceivingHistoryPage.css';
import '../ReceivingPage.css';
import './AdminReceivingPage.css';
import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../../components/ui';

const PAGE_SIZE = 15;

const ADMIN_RECEIVING_PRESETS: ReadonlyArray<readonly [DatePreset, string]> = [
  ['today', 'วันนี้'],
  ['yesterday', 'เมื่อวาน'],
  ['7d', '7 วันล่าสุด'],
  ['30d', '30 วันล่าสุด'],
  ['month', 'เดือนนี้'],
];

// ── Firestore helpers ──────────────────────────────────────────────────────

async function fetchAdminReceivings(): Promise<Receiving[]> {
  if (!db || !isFirebaseConfigured) return [];
  try {
    const snap = await getDocs(
      query(collection(db, collections.receivings), orderBy('receivedAt', 'desc')),
    );
    return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Receiving));
  } catch {
    // Fallback without ordering if index unavailable
    const snap = await getDocs(collection(db, collections.receivings));
    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Receiving));
    return docs.sort((a, b) => {
      const ta = (a.receivedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
      const tb = (b.receivedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
      return tb - ta;
    });
  }
}

async function fetchReceivingItems(receivingId: string): Promise<ReceivingItem[]> {
  if (!db || !isFirebaseConfigured) return [];
  const snap = await getDocs(
    collection(db, collections.receivings, receivingId, collections.receivingItems),
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as ReceivingItem));
}

// ── Pagination helper ──────────────────────────────────────────────────────

function buildPaginationItems(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 1) return [1];
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const items: (number | 'ellipsis')[] = [1];
  let left = Math.max(2, current - 1);
  let right = Math.min(total - 1, current + 1);
  if (current <= 3) { left = 2; right = 4; }
  else if (current >= total - 2) { left = total - 3; right = total - 1; }
  if (left > 2) items.push('ellipsis');
  for (let i = left; i <= right; i++) items.push(i);
  if (right < total - 1) items.push('ellipsis');
  items.push(total);
  return items;
}

function PaginationBar({ total, page, onPage }: { total: number; page: number; onPage: (n: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safe = Math.min(page, pages);
  const start = total === 0 ? 0 : (safe - 1) * PAGE_SIZE + 1;
  const end = Math.min(safe * PAGE_SIZE, total);
  return (
    <div className="sh-bottom-bar">
      <span className="sh-bottom-info">
        {total === 0 ? 'ไม่มีรายการ' : `แสดง ${start}–${end} จาก ${total} รายการ`}
      </span>
      <div className="sh-pagination">
        <button type="button" className="sh-pg" disabled={safe <= 1} onClick={() => onPage(safe - 1)} aria-label="หน้าก่อน">
          <i className="ti ti-chevron-left" style={{ fontSize: 11 }} aria-hidden="true" />
        </button>
        {buildPaginationItems(safe, pages).map((item, idx) =>
          item === 'ellipsis' ? (
            <span key={`e-${idx}`} className="sh-pg sh-pg-ellipsis">…</span>
          ) : (
            <button key={item} type="button" className={`sh-pg${safe === item ? ' sh-on' : ''}`} onClick={() => onPage(item)}>
              {item}
            </button>
          ),
        )}
        <button type="button" className="sh-pg" disabled={safe >= pages} onClick={() => onPage(safe + 1)} aria-label="หน้าถัดไป">
          <i className="ti ti-chevron-right" style={{ fontSize: 11 }} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// ── Status badge (same as POS) ─────────────────────────────────────────────

function StatusBadge({ status }: { status: ReceivingStatus }) {
  const cls =
    status === 'completed' ? 'rh-status-completed'
    : status === 'draft' ? 'rh-status-draft'
    : 'rh-status-cancelled';
  return <span className={`sh-status-badge ${cls}`}>{RECEIVING_STATUS_LABELS[status]}</span>;
}

// ── Branch picker dialog ───────────────────────────────────────────────────

function BranchPickerDialog({
  open,
  branches,
  onSelect,
  onClose,
}: {
  open: boolean;
  branches: Branch[];
  onSelect: (branch: Branch) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  const active = branches.filter((b) => b.isActive !== false);
  return (
    <div className="arv-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="arv-picker" onClick={(e) => e.stopPropagation()}>
        <div className="arv-picker-head">
          <span className="arv-picker-title">
            <i className="ti ti-building-store" aria-hidden="true" />
            เลือกสาขาที่รับสินค้าเข้า
          </span>
          <button type="button" className="arv-picker-close" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>
        {active.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
            ไม่พบสาขาที่ใช้งานได้
          </div>
        ) : (
          <div className="arv-picker-list">
            {active.map((b) => (
              <button key={b.id} type="button" className="arv-picker-item" onClick={() => onSelect(b)}>
                <div>
                  <div className="arv-picker-item-name">{b.name?.trim() || b.id}</div>
                  <div className="arv-picker-item-id">{b.id}</div>
                </div>
                <i className="ti ti-chevron-right" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function fmtIsoDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Edit overlay state type ────────────────────────────────────────────────

type EditOverlayState = {
  branchId: string;
  branchLabel: string;
  grnId: string;
  initialValues: ReceivingFormValues;
  documentStatus: ReceivingStatus;
  isCancelled: boolean;
  existingItemIds: Set<string>;
};

// ── Main Page ──────────────────────────────────────────────────────────────

export default function AdminReceivingPage() {
  const { user } = useAuth();

  // ── Admin data ───────────────────────────────────────────────────────
  const [records, setRecords] = useState<Receiving[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const [branches, setBranches] = useState<Branch[]>([]);

  // ── Filters ──────────────────────────────────────────────────────────
  const [branchFilter, setBranchFilter] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ReceivingStatusFilter>('all');
  const [datePreset, setDatePreset] = useState<DatePreset>('30d');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);

  // ── Detail drawer ─────────────────────────────────────────────────────
  const [drawerRecord, setDrawerRecord] = useState<ReceivingRecord | null>(null);
  const [drawerItems, setDrawerItems] = useState<ReceivingItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const itemsCacheRef = useRef<Map<string, ReceivingItem[]>>(new Map());

  // ── New receiving form ────────────────────────────────────────────────
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [activeFormBranch, setActiveFormBranch] = useState<Branch | null>(null);
  const [isDraftSaving, setIsDraftSaving] = useState(false);

  // ── Edit existing receiving ───────────────────────────────────────────
  const [editOverlay, setEditOverlay] = useState<EditOverlayState | null>(null);

  // ── Toast ─────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<string | null>(null);

  // ── Load data ─────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdminReceivings();
      setRecords(data);
      setLastFetched(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'โหลดข้อมูลไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void fetchAllBranches().then((list) => {
      setBranches(list);
      seedBranchLabelCache(list);
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  // ESC closes drawer
  useEffect(() => {
    if (!drawerRecord) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDrawer(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [drawerRecord]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Filtering + pagination ─────────────────────────────────────────

  const dateRange = useMemo(() => getDateRange(datePreset, dateFrom, dateTo), [datePreset, dateFrom, dateTo]);

  const filtered = useMemo(() => {
    const preFiltered = branchFilter
      ? records.filter((r) => r.branchId === branchFilter)
      : records;

    const asRecords: ReceivingRecord[] = preFiltered.map((r) => ({
      receiving: r,
      items: itemsCacheRef.current.get(r.id) ?? [],
    }));

    return filterReceivings(asRecords, {
      search,
      dateFrom: dateRange.start,
      dateTo: dateRange.end,
      status: statusFilter,
    });
  }, [records, branchFilter, search, dateRange, statusFilter]);

  const summary = useMemo(() => computeReceivingSummary(filtered), [filtered]);

  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  useEffect(() => { setPage(1); }, [search, statusFilter, branchFilter, datePreset, dateFrom, dateTo]);

  // ── Branch name helper ────────────────────────────────────────────────

  const branchName = useCallback(
    (id: string) => branches.find((b) => b.id === id)?.name?.trim() || id,
    [branches],
  );

  const drawerParsedNote = useMemo(
    () => (drawerRecord ? parseReceivingNote(drawerRecord.receiving.note) : null),
    [drawerRecord],
  );

  // ── Drawer handlers ────────────────────────────────────────────────────

  const openDrawer = useCallback(async (record: ReceivingRecord) => {
    setDrawerRecord(record);
    const cached = itemsCacheRef.current.get(record.receiving.id);
    if (cached) { setDrawerItems(cached); return; }
    setItemsLoading(true);
    try {
      const items = await fetchReceivingItems(record.receiving.id);
      itemsCacheRef.current.set(record.receiving.id, items);
      setDrawerItems(items);
    } finally {
      setItemsLoading(false);
    }
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerRecord(null);
    setDrawerItems([]);
  }, []);

  // ── New receiving handlers ─────────────────────────────────────────────

  const handleBranchSelect = (branch: Branch) => {
    setBranchPickerOpen(false);
    setActiveFormBranch(branch);
  };

  const closeForm = useCallback(() => {
    setActiveFormBranch(null);
    setIsDraftSaving(false);
  }, []);

  // ── Edit overlay handlers ──────────────────────────────────────────────

  const closeEditOverlay = useCallback(() => {
    setEditOverlay(null);
    setIsDraftSaving(false);
  }, []);

  /** Open the edit/continue overlay for the record currently shown in the drawer. */
  const openEdit = useCallback(() => {
    if (!drawerRecord) return;
    const { receiving } = drawerRecord;
    // Capture items before closeDrawer clears drawerItems state
    const capturedItems = drawerItems;
    const initialValues = receivingFormValuesFromRecord(receiving, capturedItems);
    const existingItemIds = new Set(capturedItems.map((item) => item.id));
    setEditOverlay({
      branchId: receiving.branchId,
      branchLabel: branchName(receiving.branchId),
      grnId: receiving.id,
      initialValues,
      documentStatus: receiving.status,
      isCancelled: receiving.status === 'cancelled',
      existingItemIds,
    });
    closeDrawer();
  }, [drawerRecord, drawerItems, branchName, closeDrawer]);

  const handleEditSubmit = useCallback(
    async (payload: ReceivingFormSubmitPayload) => {
      if (!user || !editOverlay) return;
      if (editOverlay.documentStatus === 'draft') {
        await confirmReceiving({
          receivingId: editOverlay.grnId,
          branchId: editOverlay.branchId,
          staffId: user.id,
          staffName: `${user.firstName} ${user.lastName}`.trim(),
          supplierId: payload.supplierId,
          supplierName: payload.supplierName,
          note: payload.composedNote,
          finalDiscount: payload.finalDiscount,
          lines: payload.lines,
        });
        closeEditOverlay();
        void load();
        setToast('ยืนยันรับเข้าและอัปเดตสต็อกเรียบร้อย');
        return;
      }
      await updateReceiving({
        receivingId: editOverlay.grnId,
        branchId: editOverlay.branchId,
        staffId: user.id,
        supplierId: payload.supplierId,
        supplierName: payload.supplierName,
        note: payload.composedNote,
        finalDiscount: payload.finalDiscount,
        lines: formLinesToEditLines(payload.lines, editOverlay.existingItemIds),
      });
      closeEditOverlay();
      void load();
      setToast('บันทึกการแก้ไขเรียบร้อย');
    },
    [user, editOverlay, closeEditOverlay, load],
  );

  const handleEditSaveDraft = useCallback(
    async (payload: ReceivingFormSubmitPayload) => {
      if (!user || !editOverlay) return;
      setIsDraftSaving(true);
      try {
        await saveReceivingDraft({
          receivingId: editOverlay.grnId,
          branchId: editOverlay.branchId,
          staffId: user.id,
          supplierId: payload.supplierId,
          supplierName: payload.supplierName,
          note: payload.composedNote,
          finalDiscount: payload.finalDiscount,
          lines: formLinesToDraftLines(payload.lines, editOverlay.existingItemIds),
        });
        closeEditOverlay();
        void load();
        setToast('บันทึกแบบร่างเรียบร้อย');
      } catch (err) {
        setIsDraftSaving(false);
        throw err;
      }
    },
    [user, editOverlay, closeEditOverlay, load],
  );

  const handleEditVoid = useCallback(
    async (reason: string, voidNote: string) => {
      if (!user || !editOverlay) return;
      await cancelReceiving({
        receivingId: editOverlay.grnId,
        branchId: editOverlay.branchId,
        staffId: user.id,
        reason,
        note: voidNote,
      });
      closeEditOverlay();
      void load();
      setToast('ยกเลิกเอกสารรับเข้าเรียบร้อย');
    },
    [user, editOverlay, closeEditOverlay, load],
  );

  const handleFormSubmit = useCallback(async (payload: ReceivingFormSubmitPayload) => {
    if (!user || !activeFormBranch) return;
    await confirmReceiving({
      branchId: activeFormBranch.id,
      staffId: user.id,
      staffName: `${user.firstName} ${user.lastName}`.trim(),
      supplierId: payload.supplierId,
      supplierName: payload.supplierName,
      note: payload.composedNote,
      finalDiscount: payload.finalDiscount,
      lines: payload.lines,
    });
    // resetBill() inside ReceivingForm (create mode) only clears state — no navigation
    closeForm();
    void load();
    setToast('บันทึกรับเข้าเรียบร้อย');
  }, [user, activeFormBranch, closeForm, load]);

  const handleFormSaveDraft = useCallback(async (payload: ReceivingFormSubmitPayload) => {
    if (!user || !activeFormBranch) return;
    setIsDraftSaving(true);
    try {
      await saveReceivingDraft({
        branchId: activeFormBranch.id,
        staffId: user.id,
        supplierId: payload.supplierId,
        supplierName: payload.supplierName,
        note: payload.composedNote,
        finalDiscount: payload.finalDiscount,
        lines: payload.lines,
      });
      closeForm();
      void load();
      setToast('บันทึกแบบร่างเรียบร้อย');
    } catch (err) {
      setIsDraftSaving(false);
      throw err;
    }
  }, [user, activeFormBranch, closeForm, load]);

  function fmtShort(n: number) {
    return parseFloat(String(n || 0)).toLocaleString('th-TH', { maximumFractionDigits: 0 });
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="sh-page">
      {/* ── Topbar ── */}
      <header className="sh-topbar">
        <div className="sh-topbar-icon">
          <i className="ti ti-truck-delivery" aria-hidden="true" />
        </div>
        <div className="sh-topbar-center">
          <div className="sh-topbar-title">รับเข้าสต็อก (HQ)</div>
          <div className="sh-topbar-sub">Inbound Receiving — ทุกสาขา</div>
        </div>
        <button type="button" className="sh-btn sh-btn-ghost sh-btn-sm" onClick={() => void load()} disabled={loading}>
          <i className={`ti ti-refresh${loading ? ' arv-spin' : ''}`} aria-hidden="true" />
          Refresh
        </button>
        <button
          type="button"
          className="arv-btn-primary sh-btn sh-btn-sm"
          onClick={() => setBranchPickerOpen(true)}
        >
          <i className="ti ti-plus" aria-hidden="true" />
          บันทึกรับเข้า
        </button>
      </header>

      {/* ── Content ── */}
      <div className="sh-content">
        {error && (
          <div className="sh-error-banner" role="alert">
            <i className="ti ti-alert-circle" aria-hidden="true" />
            <div>
              <strong>โหลดข้อมูลไม่สำเร็จ</strong>
              <div style={{ fontSize: 12, marginTop: 4 }}>{error}</div>
            </div>
          </div>
        )}

        {/* ── Metrics (same as POS) ── */}
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
            <span className="sh-metric-num" style={{ color: '#0f6e56' }}>{summary.lineCount}</span>
            <span className="sh-metric-sub">บรรทัดรับเข้า</span>
          </div>
          {lastFetched && (
            <div className="sh-metric-card" style={{ justifyContent: 'center' }}>
              <span className="sh-metric-label">อัปเดตล่าสุด</span>
              <span className="sh-metric-num" style={{ fontSize: 13 }}>
                {lastFetched.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>
          )}
        </div>

        {/* ── Toolbar (mirrors POS + branch filter) ── */}
        <div className="sh-toolbar">
          {/* HQ: Branch filter */}
          <select
            className="arv-branch-select"
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            aria-label="กรองตามสาขา"
          >
            <option value="">ทุกสาขา</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name?.trim() || b.id}
              </option>
            ))}
          </select>

          <div className="sh-search-wrap">
            <i className="ti ti-search" aria-hidden="true" />
            <input
              placeholder="ค้นหา GRN, ผู้จำหน่าย..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <DateRangeDropdown
            preset={datePreset}
            from={dateFrom}
            to={dateTo}
            presets={ADMIN_RECEIVING_PRESETS}
            resolveRange={getDateRange}
            onChange={({ preset, from, to }) => {
              setDatePreset(preset);
              setDateFrom(from);
              setDateTo(to);
            }}
          />

          <div className="sh-stock-filter">
            {([['all', 'ทั้งหมด'], ['completed', 'สำเร็จ'], ['draft', 'แบบร่าง'], ['cancelled', 'ยกเลิก']] as const).map(
              ([value, label]) => (
                <button key={value} type="button" className={`sh-sf${statusFilter === value ? ' sh-on' : ''}`} onClick={() => setStatusFilter(value)}>
                  {label}
                </button>
              ),
            )}
          </div>
        </div>

        {/* ── Table card (same structure as POS + Branch column) ── */}
        <div className="sh-card">
          <div className="sh-card-head">
            <i className="ti ti-truck-delivery" aria-hidden="true" />
            <span>รายการรับเข้า — ทุกสาขา</span>
            <span className="sh-card-count">{loading ? '…' : `${filtered.length} รายการ`}</span>
          </div>
          <div className="sh-table-scroll">
            {loading ? (
              <div className="sh-loading">กำลังโหลดข้อมูลรับเข้า...</div>
            ) : (
              <Table hoverable className="min-w-[720px]">
                <TableHead>
                  <TableRow>
                    <TableHeadCell>วันที่</TableHeadCell>
                    <TableHeadCell>เลขที่ GRN</TableHeadCell>
                    <TableHeadCell>สาขา</TableHeadCell>
                    <TableHeadCell>ผู้จำหน่าย</TableHeadCell>
                    <TableHeadCell className="text-right">มูลค่ารวม</TableHeadCell>
                    <TableHeadCell>สถานะ</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {paged.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="sh-empty-cell">
                        ไม่พบรายการในช่วงที่เลือก
                      </TableCell>
                    </TableRow>
                  ) : (
                    paged.map(({ receiving: r }) => (
                      <TableRow
                        key={r.id}
                        className={`cursor-pointer ${drawerRecord?.receiving.id === r.id ? 'bg-[var(--p50)]' : ''}`}
                        onClick={() => void openDrawer({ receiving: r, items: itemsCacheRef.current.get(r.id) ?? [] })}
                      >
                        <TableCell>{formatReceivingDate(r)}</TableCell>
                        <TableCell style={{ fontWeight: 500 }}>{r.id}</TableCell>
                        <TableCell>
                          <span className="arv-branch-chip">{branchName(r.branchId)}</span>
                        </TableCell>
                        <TableCell>{r.supplierName}</TableCell>
                        <TableCell className="text-right" style={{ fontWeight: 500 }}>฿{fmtMoney(r.total)}</TableCell>
                        <TableCell><StatusBadge status={r.status} /></TableCell>
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

      {/* ── Detail drawer (same structure as POS) ── */}
      {drawerRecord && (
        <div className="sh-drawer-root">
          <button type="button" className="sh-drawer-backdrop" aria-label="ปิดรายละเอียด" onClick={closeDrawer} />
          <aside className="sh-drawer open" role="dialog" aria-modal="true">
            <div className="sh-drawer-top">
              <div className="sh-drawer-top-left">
                <span className="sh-drawer-bill-no">{drawerRecord.receiving.id}</span>
                <span className="sh-drawer-time">{formatReceivingDateTime(drawerRecord.receiving)}</span>
              </div>
              <div className="sh-drawer-top-right">
                <StatusBadge status={drawerRecord.receiving.status} />
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
                    <span>สาขา</span>
                    <strong className="arv-branch-chip" style={{ fontSize: 12 }}>
                      {branchName(drawerRecord.receiving.branchId)}
                    </strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span>ผู้จำหน่าย</span>
                    <strong>{drawerRecord.receiving.supplierName}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span>มูลค่ารวม</span>
                    <strong>฿{fmtMoney(drawerRecord.receiving.total)}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span>ส่วนลดท้ายบิล</span>
                    <strong>฿{fmtMoney(drawerRecord.receiving.discountAmt)}</strong>
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
                        {drawerItems.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={4} style={{ padding: '16px', textAlign: 'center', color: '#9ca3af', fontSize: 12 }}>
                              ไม่มีรายการสินค้า
                            </TableCell>
                          </TableRow>
                        ) : (
                          drawerItems.map((item) => (
                            <TableRow key={item.id}>
                              <TableCell>
                                <div className="sh-item-name">{item.productSnap.name}</div>
                                <div className="sh-item-sku">{item.productSnap.sku}</div>
                              </TableCell>
                              <TableCell className="text-right">{item.qty} {item.unit}</TableCell>
                              <TableCell className="text-right">฿{fmtMoney(item.costPerUnit)}</TableCell>
                              <TableCell className="text-right">฿{fmtMoney(item.lineTotal)}</TableCell>
                            </TableRow>
                          ))
                        )}
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
              {drawerRecord.receiving.status !== 'cancelled' && (
                <button
                  type="button"
                  className="sh-df-btn sh-df-print"
                  onClick={openEdit}
                  disabled={itemsLoading}
                >
                  <i className="ti ti-edit" aria-hidden="true" />
                  {drawerRecord.receiving.status === 'draft' ? 'ดำเนินการต่อ' : 'แก้ไข'}
                </button>
              )}
            </footer>
          </aside>
        </div>
      )}

      {/* ── Branch picker dialog ── */}
      <BranchPickerDialog
        open={branchPickerOpen}
        branches={branches}
        onSelect={handleBranchSelect}
        onClose={() => setBranchPickerOpen(false)}
      />

      {/* ── Edit / continue receiving overlay ── */}
      {editOverlay && (
        <div className="arv-form-overlay">
          <div className="arv-overlay-bar">
            <span className="arv-overlay-bar-label">
              <i className="ti ti-edit" aria-hidden="true" />
              {editOverlay.documentStatus === 'draft' ? 'ดำเนินการต่อ' : 'แก้ไขรับเข้า'} — {editOverlay.grnId}
              <span className="arv-branch-chip" style={{ marginLeft: 6 }}>
                {editOverlay.branchLabel}
              </span>
            </span>
            <button
              type="button"
              className="arv-overlay-bar-close"
              onClick={closeEditOverlay}
              disabled={isDraftSaving}
              aria-label="ปิดฟอร์มแก้ไข"
            >
              <i className="ti ti-x" aria-hidden="true" />
              ปิด
            </button>
          </div>
          <div className={`rcv-page${isDraftSaving ? ' rcv-page--saving' : ''}`}>
            {isDraftSaving && (
              <div className="rcv-page-saving-overlay" aria-live="polite" aria-busy="true">
                <div className="rcv-page-saving-inner">
                  <i className="ti ti-loader rcv-spin" aria-hidden="true" />
                  <span>กำลังบันทึก...</span>
                </div>
              </div>
            )}
            <ReceivingForm
              mode="edit"
              variant="page"
              branchId={editOverlay.branchId}
              branchLabel={editOverlay.branchLabel}
              grnId={editOverlay.grnId}
              initialValues={editOverlay.initialValues}
              staffId={user?.id}
              documentStatus={editOverlay.documentStatus}
              isCancelled={editOverlay.isCancelled}
              onSubmit={handleEditSubmit}
              onSaveDraft={editOverlay.documentStatus === 'draft' ? handleEditSaveDraft : undefined}
              onCancel={closeEditOverlay}
              onVoid={
                !editOverlay.isCancelled && editOverlay.documentStatus !== 'draft'
                  ? handleEditVoid
                  : undefined
              }
              draftSaving={isDraftSaving}
            />
          </div>
        </div>
      )}

      {/* ── New receiving form overlay ── */}
      {activeFormBranch && (
        <div className="arv-form-overlay">
          {/* Fail-safe close bar — always visible even when the form scrolls */}
          <div className="arv-overlay-bar">
            <span className="arv-overlay-bar-label">
              <i className="ti ti-building-store" aria-hidden="true" />
              รับสินค้าเข้า — {activeFormBranch.name?.trim() || activeFormBranch.id}
            </span>
            <button
              type="button"
              className="arv-overlay-bar-close"
              onClick={closeForm}
              disabled={isDraftSaving}
              aria-label="ปิดฟอร์มรับเข้า"
            >
              <i className="ti ti-x" aria-hidden="true" />
              ปิด
            </button>
          </div>
          <div className={`rcv-page${isDraftSaving ? ' rcv-page--saving' : ''}`}>
            {isDraftSaving && (
              <div className="rcv-page-saving-overlay" aria-live="polite" aria-busy="true">
                <div className="rcv-page-saving-inner">
                  <i className="ti ti-loader rcv-spin" aria-hidden="true" />
                  <span>กำลังบันทึก...</span>
                </div>
              </div>
            )}
            <ReceivingForm
              mode="create"
              variant="page"
              branchId={activeFormBranch.id}
              branchLabel={activeFormBranch.name?.trim() || activeFormBranch.id}
              staffId={user?.id}
              onSubmit={handleFormSubmit}
              onSaveDraft={handleFormSaveDraft}
              onCancel={closeForm}
              draftSaving={isDraftSaving}
            />
          </div>
        </div>
      )}

      {/* ── Toast ── */}
      {toast && <div className="sh-toast">{toast}</div>}
    </div>
  );
}
