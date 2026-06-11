import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchAllBranches } from '../../lib/admin/branchManagement';
import { getBranchLabel, seedBranchLabelCache } from '../../lib/branches';
import { useAuth } from '../../lib/hooks/useAuth';
import { editBranchTransfer } from '../../lib/inventory/transferCrud';
import {
  createDefaultReversalCoordinatorDeps,
  executeTransferReversal,
  toObservedDocumentUpdatedAtIso,
} from '../../lib/inventory/reversalCoordinator';
import {
  fetchAllTransfers,
  fetchTransferItems,
} from '../../lib/inventory/useInventoryTransfers';
import type {
  BranchTransferLineInput,
  InventoryTransfer,
  InventoryTransferItem,
} from '../../lib/inventory/transferTypes';
import TransferDetailModal, {
  TransferStatusBadge,
} from '../../components/inventory/TransferDetailModal';
import TransferCancelDialog from '../../components/inventory/TransferCancelDialog';
import TransferEditModal from '../../components/inventory/TransferEditModal';
import type { Branch } from '../../lib/types';
import '../ReceivingHistoryPage.css';
import './AdminReceivingPage.css';
import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../../components/ui';

type StatusFilter = 'all' | 'completed' | 'cancelled';

function fmtDate(ts: InventoryTransfer['createdAt']): string {
  const d = ts?.toDate?.();
  if (!d) return '—';
  return d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function AdminTransferPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [records, setRecords] = useState<InventoryTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);

  const [branchFilter, setBranchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');

  const [detail, setDetail] = useState<InventoryTransfer | null>(null);
  const [detailItems, setDetailItems] = useState<InventoryTransferItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);

  const [cancelTarget, setCancelTarget] = useState<InventoryTransfer | null>(null);
  const [editTarget, setEditTarget] = useState<InventoryTransfer | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRecords(await fetchAllTransfers());
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
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const branchName = useCallback(
    (id: string) => branches.find((b) => b.id === id)?.name?.trim() || getBranchLabel(id),
    [branches],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (branchFilter && t.fromBranchId !== branchFilter && t.toBranchId !== branchFilter) return false;
      if (!q) return true;
      return (
        t.id.toLowerCase().includes(q) ||
        branchName(t.fromBranchId).toLowerCase().includes(q) ||
        branchName(t.toBranchId).toLowerCase().includes(q)
      );
    });
  }, [records, statusFilter, branchFilter, search, branchName]);

  const openDetail = useCallback(async (transfer: InventoryTransfer) => {
    setDetail(transfer);
    setItemsLoading(true);
    try {
      setDetailItems(await fetchTransferItems(transfer.id));
    } finally {
      setItemsLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setDetail(null);
    setDetailItems([]);
  }, []);

  // Phase 7B-H6-D2: the confirmed cancel routes through the QUEUE-FIRST transfer
  // reversal executor (immediate dual-branch local IndexedDB correction + durable
  // queue, synced to the H6-C server resolver when online), retiring the legacy
  // direct `cancelBranchTransfer` from this UI surface. `editBranchTransfer` keeps
  // its own internal `cancelBranchTransfer` step (cancel-then-recreate) untouched.
  // Items are fetched fresh so the executor always has complete dual-branch evidence.
  const handleCancel = useCallback(
    async (reason: string) => {
      if (!cancelTarget || !user) return;
      setBusy(true);
      try {
        const items = await fetchTransferItems(cancelTarget.id);
        const outcome = await executeTransferReversal(createDefaultReversalCoordinatorDeps(), {
          transferId: cancelTarget.id,
          fromBranchId: cancelTarget.fromBranchId,
          toBranchId: cancelTarget.toBranchId,
          actorRole: user.role,
          staffId: user.id,
          reason,
          items: items.map((it) => ({
            productId: it.productId,
            transferQty: it.transferQty,
            sourceLotDetails: it.sourceLotDetails,
          })),
          // Phase 7B-H5/H6: observed transfer `updatedAt` for the server stale-client
          // guard — omitted automatically when the loaded doc has no convertible value
          // (confirmBranchTransfer may not stamp it yet; full coverage lands in H6-E).
          observedDocumentUpdatedAt: toObservedDocumentUpdatedAtIso(cancelTarget.updatedAt),
          // Phase 7B-H6-E2-C: prefer the header `reversalEvidence` snapshot (untrusted —
          // validated fail-closed in the coordinator) for the queue-first local correction;
          // absent (legacy/pre-E2-B doc) ⇒ coordinator falls back to the fetched items.
          transferHeaderEvidence: cancelTarget.reversalEvidence,
        });
        setCancelTarget(null);
        closeDetail();
        setToast(
          outcome.manualReviewRequired
            ? 'ยกเลิกในเครื่องแล้ว — รอผู้จัดการตรวจสอบ (manual review)'
            : outcome.synced && outcome.status === 'server_accepted'
              ? 'ยกเลิกการโอนย้ายเรียบร้อย'
              : 'บันทึกการยกเลิกลงเครื่องแล้ว ระบบจะซิงก์เมื่อออนไลน์',
        );
        void load();
      } catch (err) {
        setToast(err instanceof Error ? err.message : 'ยกเลิกไม่สำเร็จ');
      } finally {
        setBusy(false);
      }
    },
    [cancelTarget, user, closeDetail, load],
  );

  const handleEditSave = useCallback(
    async (lines: BranchTransferLineInput[], reason: string) => {
      if (!editTarget || !user) return;
      setBusy(true);
      try {
        await editBranchTransfer(
          editTarget.id,
          {
            transferDate: todayIso(),
            fromBranchId: editTarget.fromBranchId,
            toBranchId: editTarget.toBranchId,
            note: editTarget.note ?? '',
            staffId: user.id,
            staffName: `${user.firstName} ${user.lastName}`.trim(),
          },
          lines,
          reason,
        );
        setEditTarget(null);
        closeDetail();
        setToast('แก้ไขการโอนย้ายเรียบร้อย (สร้างเอกสารใหม่)');
        void load();
      } catch (err) {
        setToast(err instanceof Error ? err.message : 'แก้ไขไม่สำเร็จ — เอกสารเดิมอาจถูกยกเลิกแล้ว');
      } finally {
        setBusy(false);
      }
    },
    [editTarget, user, closeDetail, load],
  );

  return (
    <div className="sh-page">
      <header className="sh-topbar">
        <div className="sh-topbar-icon">
          <i className="ti ti-arrows-exchange" aria-hidden="true" />
        </div>
        <div className="sh-topbar-center">
          <div className="sh-topbar-title">โอนย้ายสต็อก (HQ)</div>
          <div className="sh-topbar-sub">Branch Transfers — ทุกสาขา</div>
        </div>
        <button type="button" className="sh-btn sh-btn-ghost sh-btn-sm" onClick={() => void load()} disabled={loading}>
          <i className={`ti ti-refresh${loading ? ' arv-spin' : ''}`} aria-hidden="true" /> Refresh
        </button>
        <button
          type="button"
          className="arv-btn-primary sh-btn sh-btn-sm"
          onClick={() => navigate('/admin/transfers/new')}
        >
          <i className="ti ti-plus" aria-hidden="true" /> สร้างการโอนย้าย
        </button>
      </header>

      <div className="sh-content">
        {error && (
          <div className="sh-error-banner" role="alert">
            <i className="ti ti-alert-circle" aria-hidden="true" />
            <div><strong>โหลดข้อมูลไม่สำเร็จ</strong><div style={{ fontSize: 12, marginTop: 4 }}>{error}</div></div>
          </div>
        )}

        <div className="sh-toolbar">
          <select
            className="arv-branch-select"
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            aria-label="กรองตามสาขา"
          >
            <option value="">ทุกสาขา</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name?.trim() || b.id}</option>
            ))}
          </select>

          <div className="sh-search-wrap">
            <i className="ti ti-search" aria-hidden="true" />
            <input
              placeholder="ค้นหาเลขที่เอกสาร, สาขา..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="sh-stock-filter">
            {([['all', 'ทั้งหมด'], ['completed', 'สำเร็จ'], ['cancelled', 'ยกเลิก']] as const).map(
              ([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`sh-sf${statusFilter === value ? ' sh-on' : ''}`}
                  onClick={() => setStatusFilter(value)}
                >
                  {label}
                </button>
              ),
            )}
          </div>
        </div>

        <div className="sh-card">
          <div className="sh-card-head">
            <i className="ti ti-arrows-exchange" aria-hidden="true" />
            <span>รายการโอนย้าย — ทุกสาขา</span>
            <span className="sh-card-count">{loading ? '…' : `${filtered.length} รายการ`}</span>
          </div>
          <div className="sh-table-scroll">
            {loading ? (
              <div className="sh-loading">กำลังโหลด...</div>
            ) : (
              <Table hoverable className="min-w-[720px]">
                <TableHead>
                  <TableRow>
                    <TableHeadCell>วันที่</TableHeadCell>
                    <TableHeadCell>เลขที่เอกสาร</TableHeadCell>
                    <TableHeadCell>ต้นทาง</TableHeadCell>
                    <TableHeadCell>ปลายทาง</TableHeadCell>
                    <TableHeadCell className="text-right">รายการ</TableHeadCell>
                    <TableHeadCell>สถานะ</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="sh-empty-cell">ไม่พบรายการ</TableCell></TableRow>
                  ) : (
                    filtered.map((t) => (
                      <TableRow
                        key={t.id}
                        className={`cursor-pointer ${detail?.id === t.id ? 'bg-[var(--p50)]' : ''}`}
                        onClick={() => void openDetail(t)}
                      >
                        <TableCell>{fmtDate(t.createdAt)}</TableCell>
                        <TableCell style={{ fontWeight: 500 }}>{t.id}</TableCell>
                        <TableCell><span className="arv-branch-chip">{branchName(t.fromBranchId)}</span></TableCell>
                        <TableCell><span className="arv-branch-chip">{branchName(t.toBranchId)}</span></TableCell>
                        <TableCell className="text-right">{t.itemCount}</TableCell>
                        <TableCell><TransferStatusBadge status={t.status} /></TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      </div>

      <TransferDetailModal
        open={detail !== null}
        transfer={detail}
        items={detailItems}
        loading={itemsLoading}
        branchLabel={branchName}
        onClose={closeDetail}
        onCancelTransfer={detail ? () => setCancelTarget(detail) : undefined}
        onEdit={detail && !itemsLoading ? () => setEditTarget(detail) : undefined}
        busy={busy}
      />

      <TransferCancelDialog
        key={`cancel-${cancelTarget?.id ?? 'none'}`}
        open={cancelTarget !== null}
        transferId={cancelTarget?.id ?? ''}
        saving={busy}
        onConfirm={(reason) => void handleCancel(reason)}
        onClose={() => setCancelTarget(null)}
      />

      <TransferEditModal
        key={`edit-${editTarget?.id ?? 'none'}`}
        open={editTarget !== null}
        transfer={editTarget}
        items={detailItems}
        saving={busy}
        branchLabel={branchName}
        onSave={(lines, reason) => void handleEditSave(lines, reason)}
        onClose={() => setEditTarget(null)}
      />

      {toast && <div className="sh-toast">{toast}</div>}
    </div>
  );
}
