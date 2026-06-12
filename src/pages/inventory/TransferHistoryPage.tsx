import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getBranchLabel } from '../../lib/branches';
import { useAuth } from '../../lib/hooks/useAuth';
import {
  canBranchReverseTransfer,
  createDefaultReversalCoordinatorDeps,
  executeTransferReversal,
  getTransferReversalEvidenceMessage,
  toObservedDocumentUpdatedAtIso,
  TransferReversalEvidenceError,
} from '../../lib/inventory/reversalCoordinator';
import {
  fetchTransferItems,
  useInventoryTransfers,
} from '../../lib/inventory/useInventoryTransfers';
import type {
  InventoryTransfer,
  InventoryTransferItem,
} from '../../lib/inventory/transferTypes';
import TransferDetailModal, {
  TransferStatusBadge,
} from '../../components/inventory/TransferDetailModal';
import DestructiveConfirmModal from '../../components/common/DestructiveConfirmModal';
import {
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from '../../components/ui';
import '../ReceivingHistoryPage.css';

type StatusFilter = 'all' | 'completed' | 'cancelled';

// Phase 7B-H6-D2 (Codex blocker fix): only the ORIGIN/source branch may reverse a
// transfer from this branch-scoped feed (the queue-first executor applies a local
// correction + queue write before server sync). Shown when a destination-branch user
// attempts to cancel an incoming transfer.
const TRANSFER_REVERSAL_ORIGIN_ONLY_MESSAGE =
  'เฉพาะสาขาต้นทางเท่านั้นที่สามารถยกเลิกการโอนย้ายนี้ได้';

function fmtDate(ts: InventoryTransfer['createdAt']): string {
  const d = ts?.toDate?.();
  if (!d) return '—';
  return d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' });
}

type Props = {
  /** Hub mode: switch to the in-page create view instead of routing. */
  onCreateNew?: () => void;
  /** Hub mode: back action target (defaults to the stock hub). */
  onBack?: () => void;
};

export default function TransferHistoryPage({ onCreateNew, onBack }: Props = {}) {
  const navigate = useNavigate();
  const { branchId, user } = useAuth();

  const goBack = onBack ?? (() => navigate('/inventory'));
  const goCreate = onCreateNew ?? (() => navigate('/inventory/transfer'));
  const { transfers, loading, reload } = useInventoryTransfers(branchId);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');

  const [detail, setDetail] = useState<InventoryTransfer | null>(null);
  const [detailItems, setDetailItems] = useState<InventoryTransferItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);

  const [cancelTarget, setCancelTarget] = useState<InventoryTransfer | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(t);
  }, [toast]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return transfers.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (!q) return true;
      return (
        t.id.toLowerCase().includes(q) ||
        getBranchLabel(t.fromBranchId).toLowerCase().includes(q) ||
        getBranchLabel(t.toBranchId).toLowerCase().includes(q)
      );
    });
  }, [transfers, statusFilter, search]);

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
  // direct `cancelBranchTransfer` from this UI surface. Items are fetched fresh so
  // the executor always has complete dual-branch evidence at cancel time. A Staff
  // actor is rejected before any write (the thrown error surfaces in the modal).
  const handleCancel = useCallback(
    async (reason: string, note?: string) => {
      if (!cancelTarget || !user) return;
      // Hard origin-branch preflight (defense-in-depth — the modal entry point is also
      // gated below). A destination-only branch user must NEVER reach the queue-first
      // executor, because its local correction + queue write happen BEFORE server sync.
      if (!canBranchReverseTransfer(branchId, cancelTarget.fromBranchId)) {
        setCancelTarget(null);
        setToast(TRANSFER_REVERSAL_ORIGIN_ONLY_MESSAGE);
        return;
      }
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
          note,
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
        void reload();
      } catch (err) {
        // Phase 7B-H6-F1 (display-only): a fail-closed evidence rejection carries a
        // structured code — surface the friendly Thai reason with the raw code as
        // secondary detail. Non-evidence errors keep the existing generic fallback.
        if (err instanceof TransferReversalEvidenceError) {
          setToast(`${getTransferReversalEvidenceMessage(err.code)} (รหัส: ${err.code})`);
        } else {
          setToast(err instanceof Error ? err.message : 'ยกเลิกไม่สำเร็จ');
        }
      } finally {
        setBusy(false);
      }
    },
    [cancelTarget, user, branchId, closeDetail, reload],
  );

  const branchLabel = useCallback((id: string) => getBranchLabel(id), []);

  return (
    <div className="sh-page">
      <header className="sh-topbar">
        <button
          type="button"
          className="sh-btn sh-btn-ghost sh-btn-sm"
          onClick={() => goBack()}
          aria-label="กลับ"
        >
          <i className="ti ti-arrow-left" aria-hidden="true" />
        </button>
        <div className="sh-topbar-icon">
          <i className="ti ti-arrows-exchange" aria-hidden="true" />
        </div>
        <div className="sh-topbar-center">
          <div className="sh-topbar-title">ประวัติการโอนย้ายสต็อก</div>
          <div className="sh-topbar-sub">Branch Transfers</div>
        </div>
        <button type="button" className="sh-btn sh-btn-ghost sh-btn-sm" onClick={() => void reload()} disabled={loading}>
          <i className="ti ti-refresh" aria-hidden="true" /> รีเฟรช
        </button>
        <button type="button" className="arv-btn-primary sh-btn sh-btn-sm" onClick={() => goCreate()}>
          <i className="ti ti-plus" aria-hidden="true" /> โอนย้ายใหม่
        </button>
      </header>

      <div className="sh-content">
        <div className="sh-toolbar">
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
            <span>รายการโอนย้าย</span>
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
                    <TableHeadCell>ทิศทาง</TableHeadCell>
                    <TableHeadCell className="text-right">รายการ</TableHeadCell>
                    <TableHeadCell>สถานะ</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="sh-empty-cell">ไม่พบรายการ</TableCell>
                    </TableRow>
                  ) : (
                    filtered.map((t) => {
                      const outgoing = t.fromBranchId === branchId;
                      return (
                        <TableRow key={t.id} className="cursor-pointer" onClick={() => void openDetail(t)}>
                          <TableCell>{fmtDate(t.createdAt)}</TableCell>
                          <TableCell style={{ fontWeight: 500 }}>{t.id}</TableCell>
                          <TableCell>
                            <span style={{ color: outgoing ? '#b23c17' : '#0f6e56', fontWeight: 600, fontSize: 12 }}>
                              <i
                                className={`ti ti-arrow-${outgoing ? 'up-right' : 'down-left'}`}
                                aria-hidden="true"
                              />{' '}
                              {outgoing ? 'ส่งออก' : 'รับเข้า'}
                            </span>{' '}
                            {getBranchLabel(t.fromBranchId)} → {getBranchLabel(t.toBranchId)}
                          </TableCell>
                          <TableCell className="text-right">{t.itemCount}</TableCell>
                          <TableCell><TransferStatusBadge status={t.status} /></TableCell>
                        </TableRow>
                      );
                    })
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
        branchLabel={branchLabel}
        onClose={closeDetail}
        // Origin-branch gate (Phase 7B-H6-D2): the cancel action is only offered when
        // the active branch IS the transfer's source branch — a destination-branch user
        // viewing an incoming transfer never gets a reversal entry point.
        onCancelTransfer={
          detail && canBranchReverseTransfer(branchId, detail.fromBranchId)
            ? () => setCancelTarget(detail)
            : undefined
        }
        busy={busy}
      />

      <DestructiveConfirmModal
        open={cancelTarget !== null}
        title="ยกเลิกการโอนย้าย"
        documentSummary={cancelTarget ? `เอกสาร ${cancelTarget.id}` : undefined}
        description="การยกเลิกจะคืนสต็อกกลับสาขาต้นทาง (ตามต้นทุนเดิม) และตัดออกจากสาขาปลายทาง หากสาขาปลายทางขายสินค้าไปแล้วและสต็อกไม่พอ ระบบจะไม่อนุญาตให้ยกเลิก"
        destructiveLabel="ยืนยันการยกเลิก"
        reasonRequired
        loading={busy}
        onConfirm={({ reason, note }) => void handleCancel(reason ?? '', note)}
        onCancel={() => setCancelTarget(null)}
      />

      {toast && <div className="sh-toast">{toast}</div>}
    </div>
  );
}
