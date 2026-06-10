import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeadCell,
  TableRow,
  Textarea,
  TextInput,
} from 'flowbite-react';
import { useAuth } from '../lib/hooks/useAuth';
import {
  buildManualReviewResolvePayload,
  canViewManualReviewOps,
} from '../lib/pos/offline/manualReviewOps';
import { listQueue, resolveManualReview } from '../lib/pos/offline/offlineReversalQueue';
import { createIndexedDbReversalStore } from '../lib/pos/offline/reversalLocalStore';
import type { OfflineReversalIntent } from '../lib/pos/offline/offlineReversalTypes';

/**
 * Phase 7B-H3 — Manual Review Operations (LOCAL / device only).
 *
 * Route-only Manager/Admin surface to view this DEVICE's `manual_review_required`
 * offline reversal intents and execute the H2 `resolveManualReview` transition AFTER
 * the operator has reconciled Firestore stock externally. It reads only the local
 * IndexedDB queue (`listQueue`) and writes only via the H2 helper — NO Firestore
 * query, NO stock mutation, NO cross-device scan.
 */
export default function ManualReviewOpsPage() {
  const { user } = useAuth();
  // Authority gate FIRST — Manager/Admin only (delegates to the H2 rule).
  const canResolve = canViewManualReviewOps(user?.role);

  // One device-local store instance shared by the read (list) and write (resolve).
  const store = useMemo(() => createIndexedDbReversalStore(), []);

  const [intents, setIntents] = useState<OfflineReversalIntent[]>([]);
  const [loading, setLoading] = useState(canResolve);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<OfflineReversalIntent | null>(null);
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'failure' } | null>(null);

  const refresh = useCallback(async () => {
    if (!canResolve) {
      setIntents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await listQueue(store, ['manual_review_required']);
      setIntents(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIntents([]);
    } finally {
      setLoading(false);
    }
  }, [canResolve, store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const openResolve = (intent: OfflineReversalIntent) => {
    setTarget(intent);
    setReasonCode('');
    setNote('');
    setFormError(null);
  };

  const closeResolve = () => {
    if (submitting) return;
    setTarget(null);
  };

  const submitResolve = useCallback(async () => {
    if (!target) return;
    const payload = buildManualReviewResolvePayload(
      { id: user?.id, role: user?.role },
      { reasonCode, note },
    );
    if (!payload.ok) {
      setFormError(
        payload.error === 'missing_reason'
          ? 'กรุณาระบุเหตุผล (reasonCode)'
          : 'เฉพาะผู้จัดการ/ผู้ดูแลระบบเท่านั้นที่ดำเนินการได้',
      );
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await resolveManualReview(store, target.id, payload.input);
      if (result.outcome === 'resolved' || result.outcome === 'already_resolved') {
        setToast({ message: `ปิดงานตรวจสอบ ${target.sourceId} แล้ว (${result.outcome})`, type: 'success' });
      } else {
        setToast({ message: `ไม่สามารถปิดงานได้: ${result.outcome}`, type: 'failure' });
      }
      setTarget(null);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการดำเนินการ');
    } finally {
      setSubmitting(false);
    }
  }, [target, user?.id, user?.role, reasonCode, note, store, refresh]);

  if (!canResolve) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Alert color="failure">
          <span className="font-medium">ข้อผิดพลาด!</span> เฉพาะผู้จัดการ/ผู้ดูแลระบบ (Manager/Admin)
          เท่านั้นที่เข้าถึงหน้านี้ได้
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">คิวตรวจสอบด้วยตนเอง</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            (Manual Review) เฉพาะรายการบน <span className="font-medium">อุปกรณ์นี้</span> — ปิดงานหลังจาก
            กระทบยอดสต็อกใน Firestore เรียบร้อยแล้วเท่านั้น
          </p>
        </div>
        <Badge color="gray" size="sm" className="w-fit">
          {loading ? <Spinner size="sm" /> : `${intents.length} รายการ`}
        </Badge>
      </div>

      {toast && (
        <Alert color={toast.type} onDismiss={() => setToast(null)}>
          {toast.message}
        </Alert>
      )}

      {error ? (
        <Alert color="failure">
          <span className="font-medium">โหลดข้อมูลไม่สำเร็จ:</span> {error}
        </Alert>
      ) : loading ? (
        <div className="flex justify-center p-8">
          <Spinner size="xl" aria-label="Loading manual review queue" />
        </div>
      ) : intents.length === 0 ? (
        <Alert color="success">ไม่มีรายการรอตรวจสอบบนอุปกรณ์นี้ 🎉</Alert>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <Table hoverable>
              <TableHead>
                <TableHeadCell>ประเภท</TableHeadCell>
                <TableHeadCell>เอกสารอ้างอิง</TableHeadCell>
                <TableHeadCell>สาขา</TableHeadCell>
                <TableHeadCell>เหตุผลเดิม</TableHeadCell>
                <TableHeadCell>สร้างเมื่อ</TableHeadCell>
                <TableHeadCell>
                  <span className="sr-only">การกระทำ</span>
                </TableHeadCell>
              </TableHead>
              <TableBody className="divide-y">
                {intents.map((it) => (
                  <TableRow key={it.id} className="bg-white dark:border-gray-700 dark:bg-gray-800">
                    <TableCell className="whitespace-nowrap">
                      <Badge color={it.sourceType === 'receiving' ? 'info' : 'purple'} className="w-fit">
                        {it.sourceType}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">{it.sourceId}</TableCell>
                    <TableCell className="whitespace-nowrap">{it.branchId}</TableCell>
                    <TableCell className="max-w-xs truncate" title={it.rejectionCode ?? it.reasonCode}>
                      {it.rejectionCode ?? it.reasonCode}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-gray-500 dark:text-gray-400">
                      {it.createdAt}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" color="light" onClick={() => openResolve(it)}>
                        ปิดงานตรวจสอบ
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      <Modal show={target !== null} onClose={closeResolve} size="md">
        <ModalHeader>ปิดงานตรวจสอบด้วยตนเอง</ModalHeader>
        <ModalBody>
          <div className="flex flex-col gap-4">
            <Alert color="warning">
              ยืนยันว่าได้กระทบยอดสต็อกใน Firestore สำหรับเอกสาร{' '}
              <span className="font-mono">{target?.sourceId}</span> เรียบร้อยแล้ว การดำเนินการนี้จะล้าง
              overlay เฉพาะบนอุปกรณ์นี้ และไม่แก้ไขสต็อกหรือเซิร์ฟเวอร์
            </Alert>
            <div>
              <Label htmlFor="mr-reason">เหตุผล (reasonCode) *</Label>
              <TextInput
                id="mr-reason"
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value)}
                placeholder="เช่น reconciled_in_firestore"
                required
              />
            </div>
            <div>
              <Label htmlFor="mr-note">หมายเหตุ (note)</Label>
              <Textarea
                id="mr-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="ไม่บังคับ"
              />
            </div>
            {formError && <Alert color="failure">{formError}</Alert>}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button color="gray" onClick={closeResolve} disabled={submitting}>
            ยกเลิก
          </Button>
          <Button color="warning" onClick={() => void submitResolve()} disabled={submitting}>
            {submitting ? <Spinner size="sm" /> : 'ยืนยันปิดงาน'}
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
