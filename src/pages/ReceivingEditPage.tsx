import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ReceivingForm from '../components/receiving/ReceivingForm';
import { getBranchLabel } from '../lib/branches';
import { useAuth } from '../lib/hooks/useAuth';
import { confirmReceiving } from '../lib/receiving/confirmReceiving';
import type { ReceivingFormSubmitPayload } from '../lib/receiving/receivingFormUtils';
import { cancelReceiving } from '../lib/receivingHistory/cancelReceiving';
import {
  formLinesToDraftLines,
  formLinesToEditLines,
  receivingFormValuesFromRecord,
} from '../lib/receivingHistory/receivingFormValues';
import { saveReceivingDraft } from '../lib/receivingHistory/saveReceivingDraft';
import { updateReceiving } from '../lib/receivingHistory/updateReceiving';
import { useReceivingHistory } from '../lib/receivingHistory/useReceivingHistory';
import type { Receiving, ReceivingItem } from '../lib/types';
import './ReceivingPage.css';

export default function ReceivingEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, branchId } = useAuth();
  const { loadItems, loadReceiving } = useReceivingHistory(branchId);

  const [receiving, setReceiving] = useState<Receiving | null>(null);
  const [items, setItems] = useState<ReceivingItem[]>([]);
  const [docLoading, setDocLoading] = useState(true);
  const [itemsLoading, setItemsLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    const receivingId = id;
    let cancelled = false;

    async function load() {
      setDocLoading(true);
      setItemsLoading(true);
      try {
        const doc = await loadReceiving(receivingId);
        if (cancelled) return;
        setReceiving(doc);
        if (doc) {
          const loadedItems = await loadItems(receivingId);
          if (!cancelled) setItems(loadedItems);
        }
      } finally {
        if (!cancelled) {
          setDocLoading(false);
          setItemsLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [id, loadItems, loadReceiving]);

  useEffect(() => {
    if (docLoading || itemsLoading || !id) return;
    if (!receiving) {
      navigate('/receiving/history', { replace: true });
    }
  }, [docLoading, itemsLoading, id, receiving, navigate]);

  const initialValues = useMemo(() => {
    if (!receiving) return undefined;
    return receivingFormValuesFromRecord(receiving, items);
  }, [receiving, items]);

  const existingItemIds = useMemo(() => new Set(items.map((item) => item.id)), [items]);

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
    if (!id || !branchId || !user || !receiving) return;

    if (receiving.status === 'draft') {
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

  const handleVoid = async (reason: string, note: string) => {
    if (!id || !branchId || !user) return;
    await cancelReceiving({
      receivingId: id,
      branchId,
      staffId: user.id,
      reason,
      note,
    });
    navigate('/receiving/history', { state: { toast: 'ยกเลิกเอกสารรับเข้าเรียบร้อย' } });
  };

  if (!branchId) {
    return (
      <div className="rcv-page">
        <div className="rcv-loading">กรุณาเลือกสาขาก่อนใช้งาน</div>
      </div>
    );
  }

  if (docLoading || itemsLoading || !receiving || !initialValues || !id) {
    return (
      <div className="rcv-page">
        <div className="rcv-loading">กำลังโหลดเอกสารรับเข้า...</div>
      </div>
    );
  }

  const isCancelled = receiving.status === 'cancelled';
  const isDraft = receiving.status === 'draft';

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
        documentStatus={receiving.status}
        isCancelled={isCancelled}
        onSubmit={handleSubmit}
        onSaveDraft={isDraft ? handleSaveDraft : undefined}
        onCancel={goBack}
        onVoid={!isCancelled && !isDraft ? handleVoid : undefined}
      />
    </div>
  );
}
