import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import ReceivingForm from '../components/receiving/ReceivingForm';
import { getBranchLabel } from '../lib/branches';
import { useAuth } from '../lib/hooks/useAuth';
import { confirmReceiving } from '../lib/receiving/confirmReceiving';
import type { ReceivingFormSubmitPayload, ReceivingFormValues } from '../lib/receiving/receivingFormUtils';
import {
  createDefaultReversalCoordinatorDeps,
  executeReceivingReversal,
} from '../lib/inventory/reversalCoordinator';
import {
  formLinesToDraftLines,
  formLinesToEditLines,
  receivingFormValuesFromRecord,
} from '../lib/receivingHistory/receivingFormValues';
import { saveReceivingDraft } from '../lib/receivingHistory/saveReceivingDraft';
import {
  loadReceivingWithRetry,
  type ReceivingEditNavState,
} from '../lib/receivingHistory/types';
import { updateReceiving } from '../lib/receivingHistory/updateReceiving';
import { useReceivingHistory } from '../lib/receivingHistory/useReceivingHistory';
import type { Receiving, ReceivingItem } from '../lib/types';
import './ReceivingPage.css';

type LoadPhase = 'loading' | 'ready' | 'missing';

function ReceivingEditLoadingShell({
  grnId,
  isDraft,
}: {
  grnId?: string;
  isDraft?: boolean;
}) {
  return (
    <div className="rcv-page rcv-page--loading">
      <header className="rcv-topbar">
        <div className="rcv-back-btn" aria-hidden="true">
          <i className="ti ti-arrow-left" />
        </div>
        <span className="rcv-topbar-title">
          {isDraft ? 'ดำเนินการแบบร่างรับเข้า' : 'แก้ไขเอกสารรับสินค้าเข้า'}
        </span>
        <span className="rcv-ref-badge">{grnId ?? 'GRN —'}</span>
        <div className="rcv-topbar-actions" aria-hidden="true">
          <span className="rcv-top-btn-secondary rcv-skeleton-btn" />
          <span className="rcv-save-top-btn rcv-skeleton-btn rcv-skeleton-btn--primary" />
        </div>
      </header>
      <div className="rcv-edit-loading-body">
        <div className="rcv-edit-loading-card">
          <i className="ti ti-loader rcv-spin" aria-hidden="true" />
          <span>กำลังโหลดเอกสารรับเข้า...</span>
        </div>
      </div>
    </div>
  );
}

export default function ReceivingEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const navState = location.state as ReceivingEditNavState | null;
  const draftSeed =
    navState?.draftSeed && navState.draftSeed.receivingId === id
      ? navState.draftSeed
      : undefined;

  const { user, branchId } = useAuth();
  const { loadItems, loadReceiving } = useReceivingHistory(branchId);

  const [receiving, setReceiving] = useState<Receiving | null>(null);
  const [items, setItems] = useState<ReceivingItem[]>([]);
  const [loadPhase, setLoadPhase] = useState<LoadPhase>(() =>
    draftSeed ? 'ready' : 'loading',
  );

  const initialValuesRef = useRef<ReceivingFormValues | undefined>(
    draftSeed?.formValues,
  );

  useEffect(() => {
    if (!id) return;
    const receivingId = id;
    let cancelled = false;

    async function load() {
      if (!draftSeed) {
        setLoadPhase('loading');
      }

      const doc = await loadReceivingWithRetry(loadReceiving, receivingId);
      if (cancelled) return;

      if (!doc) {
        if (draftSeed) {
          setLoadPhase('ready');
          return;
        }
        setLoadPhase('missing');
        return;
      }

      setReceiving(doc);
      const loadedItems = await loadItems(receivingId);
      if (cancelled) return;

      setItems(loadedItems);
      if (!initialValuesRef.current) {
        initialValuesRef.current = receivingFormValuesFromRecord(doc, loadedItems);
      }
      setLoadPhase('ready');
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [id, draftSeed, loadItems, loadReceiving]);

  useEffect(() => {
    if (loadPhase !== 'missing') return;
    navigate('/receiving/history', { replace: true });
  }, [loadPhase, navigate]);

  const initialValues = initialValuesRef.current;

  const existingItemIds = useMemo(() => new Set(items.map((item) => item.id)), [items]);

  const documentStatus = receiving?.status ?? (draftSeed ? 'draft' : undefined);

  const goBack = () => {
    navigate('/receiving/history');
  };

  const handleSaveDraft = async (payload: ReceivingFormSubmitPayload) => {
    if (!id || !branchId || !user) return;
    await saveReceivingDraft({
      receivingId: id,
      branchId,
      staffId: user.id,
      supplierId: payload.supplierId,
      supplierName: payload.supplierName,
      note: payload.composedNote,
      finalDiscount: payload.finalDiscount,
      lines: formLinesToDraftLines(payload.lines, existingItemIds),
    });
    navigate('/receiving/history', { state: { toast: 'บันทึกแบบร่างแล้ว' } });
  };

  const handleSubmit = async (payload: ReceivingFormSubmitPayload) => {
    if (!id || !branchId || !user) return;

    const status = receiving?.status ?? documentStatus;
    if (status === 'draft') {
      await confirmReceiving({
        receivingId: id,
        branchId,
        staffId: user.id,
        staffName: `${user.firstName} ${user.lastName}`.trim(),
        supplierId: payload.supplierId,
        supplierName: payload.supplierName,
        note: payload.composedNote,
        finalDiscount: payload.finalDiscount,
        lines: payload.lines,
      });
      navigate('/receiving/history', { state: { toast: 'ยืนยันรับเข้าและอัปเดตสต็อกเรียบร้อย' } });
      return;
    }

    if (!receiving) return;

    await updateReceiving({
      receivingId: id,
      branchId,
      staffId: user.id,
      supplierId: payload.supplierId,
      supplierName: payload.supplierName,
      note: payload.composedNote,
      finalDiscount: payload.finalDiscount,
      lines: formLinesToEditLines(payload.lines, existingItemIds),
    });
    navigate('/receiving/history', { state: { toast: 'บันทึกการแก้ไขรับเข้าเรียบร้อย' } });
  };

  // Queue-first receiving reversal (Track A): the confirmed void routes through the
  // offline reversal queue — immediate local IndexedDB correction + durable queue,
  // synced to the server resolver when online. Supersedes the legacy direct
  // `cancelReceiving`. A Staff actor is rejected before any write (the thrown error
  // surfaces in the existing ReceivingVoidDialog, which stays open). TODO: a later
  // UI-standardization pass replaces ReceivingVoidDialog with DestructiveConfirmModal.
  const handleVoid = async (reason: string, note: string) => {
    if (!id || !branchId || !user) return;
    const outcome = await executeReceivingReversal(createDefaultReversalCoordinatorDeps(), {
      receivingId: id,
      branchId,
      actorRole: user.role,
      staffId: user.id,
      reason,
      note,
      items: items.map((it) => ({ productId: it.productId, qtyBase: it.qtyBase, lotId: it.lotId })),
    });
    const toast = outcome.manualReviewRequired
      ? 'ยกเลิกในเครื่องแล้ว — รอผู้จัดการตรวจสอบ (manual review)'
      : outcome.synced && outcome.status === 'server_accepted'
        ? 'ยกเลิกเอกสารรับเข้าเรียบร้อย'
        : 'บันทึกการยกเลิกลงเครื่องแล้ว ระบบจะซิงก์เมื่อออนไลน์';
    navigate('/receiving/history', { state: { toast } });
  };

  if (!branchId) {
    return (
      <div className="rcv-page">
        <div className="rcv-loading">กรุณาเลือกสาขาก่อนใช้งาน</div>
      </div>
    );
  }

  if (loadPhase === 'loading' || !initialValues || !id) {
    return (
      <ReceivingEditLoadingShell
        grnId={id}
        isDraft={Boolean(draftSeed) || documentStatus === 'draft'}
      />
    );
  }

  const isCancelled = receiving?.status === 'cancelled';
  const isDraft = documentStatus === 'draft';

  return (
    <div className="rcv-page">
      <ReceivingForm
        mode="edit"
        variant="page"
        branchId={branchId}
        branchLabel={getBranchLabel(branchId)}
        grnId={id}
        initialValues={initialValues}
        staffId={user?.id}
        documentStatus={documentStatus}
        isCancelled={isCancelled}
        onSubmit={handleSubmit}
        onSaveDraft={isDraft ? handleSaveDraft : undefined}
        onCancel={goBack}
        onVoid={!isCancelled && !isDraft ? handleVoid : undefined}
      />
    </div>
  );
}
