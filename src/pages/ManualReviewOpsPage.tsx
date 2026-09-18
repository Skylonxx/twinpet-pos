import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  buildUnreadableEvidenceDiscardRequest,
  canViewManualReviewOps,
} from '../lib/pos/offline/manualReviewOps';
import { listQueue, resolveManualReview } from '../lib/pos/offline/offlineReversalQueue';
import { createIndexedDbReversalStore } from '../lib/pos/offline/reversalLocalStore';
import { listReversalRejections } from '../lib/pos/offline/reversalRejectionLog';
import { getCanonicalSyncContext } from '../lib/pos/offline/canonicalSyncContext';
import {
  classifyRawUnreadablePrivilegedEvidence,
  discardUnreadablePrivilegedEvidenceRow,
  exportDiscardedPrivilegedEvidenceCapture,
  listDiscardedPrivilegedEvidenceCaptures,
  listRawUnreadablePrivilegedEvidence,
  type DiscardedPrivilegedEvidenceCaptureV1,
  type DiscardRefusalReason,
  type PrivilegedEvidenceRecoveryClassification,
  type RawUnreadablePrivilegedEvidenceEntry,
} from '../lib/pos/offline/privilegedEvidenceStore';
import { listTerminalVoidIntents, subscribeVoidIntentStore, type VoidIntentRecord, type VoidTerminalReason } from '../lib/pos/offline/voidIntentStore';
import type { OfflineReversalIntent } from '../lib/pos/offline/offlineReversalTypes';
import type { ReversalRejectionRecord } from '../lib/inventory/reversalRejectionRecord';

/**
 * Phase 7B-H6-F1 — read-only, display-only Thai label for an intent's `evidenceSource`
 * (how the reversal's stock effects were proven). Kept LOCAL to this page so it adds no
 * runtime helper to `src/lib/pos/offline`. It reads the existing intent field only and
 * changes no query, schema, or mutation behavior.
 */
function getVoidTerminalReasonLabel(reason: VoidTerminalReason | null): string {
  if (reason === 'order_absent_server_side') return 'บิลยังไม่ถึงเซิร์ฟเวอร์';
  if (reason === 'day_boundary_expired') return 'เลยกำหนดยกเลิกภายในวัน';
  if (reason === 'authority_refused') return 'เซิร์ฟเวอร์ปฏิเสธ';
  if (reason === 'attempt_ceiling_reached') return 'ครบจำนวนครั้งที่ลองส่ง';
  if (reason === 'malformed_intent') return 'คำขอไม่ถูกต้อง';
  if (reason === 'order_already_terminal') return 'บิลถูกยกเลิกแล้ว';
  if (reason === 'staff_identity_mismatch') return 'พนักงานผู้ขอไม่ตรงกับรอบปัจจุบัน';
  return 'ไม่ระบุ';
}

/**
 * SEC-001 N3 Phase 2 — Thai copy for a discard refusal. Every refusal the store
 * can return has an operator-visible sentence: a destructive control that fails
 * quietly is worse than one that does not exist.
 */
function getDiscardRefusalLabel(reason: DiscardRefusalReason): string {
  if (reason === 'unauthorized') return 'เฉพาะผู้จัดการ/ผู้ดูแลระบบเท่านั้นที่ดำเนินการได้';
  if (reason === 'missing_reason') return 'กรุณาระบุเหตุผล (reasonCode)';
  if (reason === 'scope_unavailable') return 'ไม่พบสาขา/อุปกรณ์ปัจจุบัน — ไม่สามารถบันทึกหลักฐานได้';
  if (reason === 'reserved_key') return 'รายการนี้เป็นคีย์ระบบ ไม่ใช่ข้อมูลรายการ — ไม่สามารถลบได้';
  if (reason === 'not_found') return 'ไม่พบรายการนี้แล้ว (อาจถูกลบไปก่อนหน้านี้) — กรุณารีเฟรช';
  if (reason === 'readable_row') return 'รายการนี้อ่านได้ตามปกติ จึงไม่อยู่ในขอบเขตการกู้คืนนี้';
  if (reason === 'server_evidence_present') {
    return 'พบร่องรอยผลตัดสินจากเซิร์ฟเวอร์ในข้อมูลดิบ — ต้องส่งให้ฝ่ายสนับสนุนตรวจสอบ ห้ามลบบนเครื่อง';
  }
  if (reason === 'capture_key_collision') return 'มีบันทึกหลักฐานรหัสเดียวกันอยู่แล้ว — ยกเลิกเพื่อไม่ทับข้อมูลเดิม';
  return 'บันทึกหลักฐานไม่สำเร็จ — ยกเลิกการลบทั้งหมด ข้อมูลเดิมยังอยู่ครบ';
}

/**
 * The device's canonical acting scope, guarded. Returns `null` when no branch is
 * mounted or an Admin is viewing all branches — the discard is then refused
 * rather than recorded against a guessed branch.
 */
function readCanonicalScope(): { branchId: string; deviceId: string } | null {
  try {
    return getCanonicalSyncContext();
  } catch {
    return null;
  }
}

/**
 * Short, non-throwing preview of an UNTRUSTED raw value, for support triage only.
 * Never parsed, never reconstructed — a serialization failure shows a label
 * instead of breaking the panel.
 */
function previewRawValue(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    return '(แสดงตัวอย่างข้อมูลดิบไม่ได้)';
  }
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** Advisory badge copy. Never an identity or authority claim. */
function getRecoveryClassificationLabel(
  classification: PrivilegedEvidenceRecoveryClassification,
): string {
  return classification === 'server_evidence_present'
    ? 'พบร่องรอยผลตัดสินจากเซิร์ฟเวอร์'
    : 'ไม่พบร่องรอยผลตัดสินจากเซิร์ฟเวอร์';
}

function getEvidenceSourceLabel(source: unknown): string {
  if (source === 'header_snapshot') return 'หลักฐานจากหัวเอกสาร';
  if (source === 'legacy_subcollection') return 'รายการย่อยเดิม';
  return 'ไม่ระบุ';
}

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

  // Phase 7B-H7-G — durable rejection log panel state (READ-ONLY, device-local forensic).
  // Independent from the manual-review queue state above so the existing queue load/resolve
  // behavior is left entirely unchanged. Shares the same memoized `store`.
  const [rejections, setRejections] = useState<ReversalRejectionRecord[]>([]);
  const [rejectionsLoading, setRejectionsLoading] = useState(canResolve);
  const [rejectionsError, setRejectionsError] = useState<string | null>(null);
  const [voidTerminals, setVoidTerminals] = useState<VoidIntentRecord[]>([]);
  const [voidTerminalsLoading, setVoidTerminalsLoading] = useState(canResolve);
  const [voidTerminalsError, setVoidTerminalsError] = useState<string | null>(null);
  const voidTerminalsMountedRef = useRef(true);

  // SEC-001 N3 Phase 2 — unreadable privileged-evidence recovery state. Device-local,
  // Manager/Admin only, one row per explicit confirmation. Nothing here runs by itself.
  const [unreadableRows, setUnreadableRows] = useState<RawUnreadablePrivilegedEvidenceEntry[]>([]);
  const [unreadableLoading, setUnreadableLoading] = useState(canResolve);
  const [unreadableError, setUnreadableError] = useState<string | null>(null);
  const [captures, setCaptures] = useState<DiscardedPrivilegedEvidenceCaptureV1[]>([]);
  const [capturesError, setCapturesError] = useState<string | null>(null);
  const [discardTarget, setDiscardTarget] = useState<RawUnreadablePrivilegedEvidenceEntry | null>(
    null,
  );
  const [discardReasonCode, setDiscardReasonCode] = useState('');
  const [discardNote, setDiscardNote] = useState('');
  const [discardSubmitting, setDiscardSubmitting] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

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

  // Phase 7B-H7-G — read-only load of THIS device's durable rejection log. Uses the shared
  // store and ONLY `listReversalRejections` (a read API): no write/resolve/delete is reachable
  // from this panel. Behind the same Manager/Admin gate as the queue.
  const refreshRejections = useCallback(async () => {
    if (!canResolve) {
      setRejections([]);
      setRejectionsLoading(false);
      return;
    }
    setRejectionsLoading(true);
    try {
      const rows = await listReversalRejections(store);
      setRejections(rows);
      setRejectionsError(null);
    } catch (err) {
      setRejectionsError(err instanceof Error ? err.message : String(err));
      setRejections([]);
    } finally {
      setRejectionsLoading(false);
    }
  }, [canResolve, store]);

  useEffect(() => {
    void refreshRejections();
  }, [refreshRejections]);

  const refreshVoidTerminals = useCallback(async (opts?: { silent?: boolean }) => {
    if (!canResolve) {
      if (!voidTerminalsMountedRef.current) return;
      setVoidTerminals([]);
      setVoidTerminalsLoading(false);
      return;
    }
    if (!opts?.silent) setVoidTerminalsLoading(true);
    try {
      const rows = await listTerminalVoidIntents(store);
      if (!voidTerminalsMountedRef.current) return;
      setVoidTerminals(rows);
      setVoidTerminalsError(null);
    } catch (err) {
      if (!voidTerminalsMountedRef.current) return;
      setVoidTerminalsError(err instanceof Error ? err.message : String(err));
      setVoidTerminals([]);
    } finally {
      if (!voidTerminalsMountedRef.current) return;
      if (!opts?.silent) setVoidTerminalsLoading(false);
    }
  }, [canResolve, store]);

  useEffect(() => {
    voidTerminalsMountedRef.current = true;
    void refreshVoidTerminals();
    const unsubscribe = subscribeVoidIntentStore(() => {
      void refreshVoidTerminals({ silent: true });
    });
    return () => {
      voidTerminalsMountedRef.current = false;
      unsubscribe();
    };
  }, [refreshVoidTerminals]);

  // SEC-001 N3 Phase 2 — read-only load of this device's unreadable privileged-evidence
  // rows (landed Phase 1 diagnostic) plus the durable recovery captures. Both are reads;
  // neither unblocks anything on its own. Behind the same Manager/Admin gate.
  // Every state write below happens AFTER an await, so mounting this panel never
  // cascades a synchronous re-render; `unreadableLoading` starts true for an
  // authorized actor and is cleared once the first read settles.
  const refreshUnreadable = useCallback(async () => {
    if (!canResolve) return;
    try {
      setUnreadableRows(await listRawUnreadablePrivilegedEvidence(store));
      setUnreadableError(null);
    } catch (err) {
      setUnreadableError(err instanceof Error ? err.message : String(err));
      setUnreadableRows([]);
    } finally {
      setUnreadableLoading(false);
    }
    try {
      setCaptures(await listDiscardedPrivilegedEvidenceCaptures(store));
      setCapturesError(null);
    } catch (err) {
      setCapturesError(err instanceof Error ? err.message : String(err));
      setCaptures([]);
    }
  }, [canResolve, store]);

  useEffect(() => {
    if (!canResolve) return;
    void (async () => {
      await refreshUnreadable();
    })();
  }, [canResolve, refreshUnreadable]);

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

  // SEC-001 N3 Phase 2 — destructive discard flow. Opened only by an explicit click on
  // one row; nothing here is reachable from a sweep, boot, or subscription.
  const openDiscard = (entry: RawUnreadablePrivilegedEvidenceEntry) => {
    setDiscardTarget(entry);
    setDiscardReasonCode('');
    setDiscardNote('');
    setDiscardError(null);
  };

  const closeDiscard = () => {
    if (discardSubmitting) return;
    setDiscardTarget(null);
  };

  const submitDiscard = async () => {
    if (!discardTarget) return;
    const built = buildUnreadableEvidenceDiscardRequest(
      { id: user?.id, role: user?.role },
      { key: discardTarget.key },
      readCanonicalScope(),
      { reasonCode: discardReasonCode, note: discardNote },
      Date.now(),
    );
    if (!built.ok) {
      setDiscardError(getDiscardRefusalLabel(built.error));
      return;
    }
    setDiscardSubmitting(true);
    setDiscardError(null);
    try {
      const outcome = await discardUnreadablePrivilegedEvidenceRow(store, built.input);
      if (outcome.kind === 'refused') {
        setDiscardError(getDiscardRefusalLabel(outcome.reason));
        return;
      }
      setToast({
        message: `ลบข้อมูลที่อ่านไม่ได้แล้ว และเก็บหลักฐานดิบไว้เรียบร้อย (${outcome.captureRecordId})`,
        type: 'success',
      });
      setDiscardTarget(null);
      await refreshUnreadable();
    } catch (err) {
      setDiscardError(err instanceof Error ? err.message : 'เกิดข้อผิดพลาดในการดำเนินการ');
    } finally {
      setDiscardSubmitting(false);
    }
  };

  const exportCapture = async (captureRecordId: string) => {
    setExportError(null);
    try {
      const outcome = await exportDiscardedPrivilegedEvidenceCapture(store, captureRecordId);
      if (outcome === 'not_found') {
        setExportError('ไม่พบบันทึกหลักฐานนี้แล้ว — กรุณารีเฟรชหน้านี้');
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    }
  };

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
                <TableHeadCell>แหล่งหลักฐาน</TableHeadCell>
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
                      {getEvidenceSourceLabel(it.evidenceSource)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-gray-500 dark:text-gray-400">
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

      {/*
        SEC-001 N3 Phase 2 — operator-mediated recovery of unreadable privileged-evidence
        rows (LOCAL / device only). Rows the canonical parser rejects block every NEW
        privileged void on this device, store-wide, with no other in-app remedy. This
        panel makes them visible and — for rows with no detected server adjudication —
        removable by a Manager/Admin, one row per explicit confirmation, with the exact
        raw bytes captured durably first. It never repairs a row, never re-submits
        anything, and never changes any server-side outcome.
      */}
      <div className="mt-8 flex flex-col gap-4 border-t-2 border-gray-200 pt-8 dark:border-gray-700">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                ข้อมูลอนุมัติยกเลิกบิลที่อ่านไม่ได้ (อุปกรณ์นี้)
              </h2>
              <Badge color="failure" size="sm" className="w-fit">
                ต้องให้ผู้จัดการดำเนินการ
              </Badge>
            </div>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              ข้อมูลเหล่านี้ทำให้เครื่องนี้สร้างรายการยกเลิกบิลแบบมีลายเซ็นผู้จัดการใหม่ไม่ได้ —
              ลบออกได้ทีละรายการหลังเก็บหลักฐานดิบไว้แล้วเท่านั้น
            </p>
          </div>
          <Badge color="gray" size="sm" className="w-fit">
            {unreadableLoading ? <Spinner size="sm" /> : `${unreadableRows.length} รายการ`}
          </Badge>
        </div>

        <Alert color="warning">
          การลบที่นี่เป็นการลบข้อมูลถาวรบนเครื่องนี้ ไม่ใช่การซ่อมข้อมูล ไม่ใช่การส่งซ้ำ
          และไม่เปลี่ยนผลการยกเลิกบิลบนเซิร์ฟเวอร์แต่อย่างใด ระบบจะบันทึกคีย์และข้อมูลดิบทั้งหมดไว้ก่อนลบเสมอ
        </Alert>

        {unreadableError ? (
          <Alert color="failure">
            <span className="font-medium">โหลดรายการที่อ่านไม่ได้ไม่สำเร็จ:</span> {unreadableError}
          </Alert>
        ) : unreadableLoading ? (
          <div className="flex justify-center p-8">
            <Spinner size="xl" aria-label="Loading unreadable privileged evidence" />
          </div>
        ) : unreadableRows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
            ไม่มีข้อมูลอนุมัติยกเลิกบิลที่อ่านไม่ได้บนอุปกรณ์นี้
          </div>
        ) : (
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHead>
                  <TableHeadCell>คีย์ (ข้อมูลดิบ — ไม่ยืนยันตัวตน)</TableHeadCell>
                  <TableHeadCell>ผลตรวจเบื้องต้น</TableHeadCell>
                  <TableHeadCell>ตัวอย่างข้อมูลดิบ</TableHeadCell>
                  <TableHeadCell>
                    <span className="sr-only">การกระทำ</span>
                  </TableHeadCell>
                </TableHead>
                <TableBody className="divide-y">
                  {unreadableRows.map((entry) => {
                    const classification = classifyRawUnreadablePrivilegedEvidence(entry.rawValue);
                    const serverEvidence = classification === 'server_evidence_present';
                    return (
                      <TableRow
                        key={entry.key}
                        className="bg-white dark:border-gray-700 dark:bg-gray-800"
                      >
                        <TableCell className="font-mono text-xs break-all" title={entry.key}>
                          {entry.key}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <Badge color={serverEvidence ? 'failure' : 'warning'} className="w-fit">
                            {getRecoveryClassificationLabel(classification)}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-xs truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                          {previewRawValue(entry.rawValue)}
                        </TableCell>
                        <TableCell className="text-right">
                          {serverEvidence ? (
                            <span className="text-xs text-red-600 dark:text-red-400">
                              ส่งให้ฝ่ายสนับสนุนตรวจสอบ — ไม่มีการลบบนเครื่องนี้
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              color="failure"
                              onClick={() => openDiscard(entry)}
                              disabled={discardSubmitting}
                            >
                              ลบรายการนี้
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            หลักฐานดิบที่เก็บไว้ก่อนลบ (อุปกรณ์นี้)
          </h3>
          <Badge color="gray" size="sm" className="w-fit">
            {`${captures.length} รายการ`}
          </Badge>
        </div>

        {capturesError && (
          <Alert color="failure">
            <span className="font-medium">โหลดบันทึกหลักฐานไม่สำเร็จ:</span> {capturesError}
          </Alert>
        )}
        {exportError && <Alert color="failure">{exportError}</Alert>}

        {captures.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
            ยังไม่มีการลบข้อมูลที่อ่านไม่ได้บนอุปกรณ์นี้
          </div>
        ) : (
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHead>
                  <TableHeadCell>เวลา</TableHeadCell>
                  <TableHeadCell>คีย์เดิม</TableHeadCell>
                  <TableHeadCell>เหตุผล</TableHeadCell>
                  <TableHeadCell>ผู้ทำรายการ</TableHeadCell>
                  <TableHeadCell>
                    <span className="sr-only">ส่งออก</span>
                  </TableHeadCell>
                </TableHead>
                <TableBody className="divide-y">
                  {captures.map((cap) => (
                    <TableRow
                      key={cap.captureRecordId}
                      className="bg-white dark:border-gray-700 dark:bg-gray-800"
                    >
                      <TableCell className="whitespace-nowrap font-mono text-xs text-gray-500 dark:text-gray-400">
                        {new Date(cap.discardedAtMs).toISOString()}
                      </TableCell>
                      <TableCell className="font-mono text-xs break-all" title={cap.rawKey}>
                        {cap.rawKey}
                      </TableCell>
                      <TableCell className="max-w-xs truncate" title={cap.reasonCode}>
                        {cap.reasonCode}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-gray-500 dark:text-gray-400">
                        {cap.actorStaffId}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          color="light"
                          onClick={() => void exportCapture(cap.captureRecordId)}
                        >
                          ส่งออกหลักฐาน
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}
      </div>

      {/*
        Phase 7B-H7-G — Durable rejection log (LOCAL / device only, READ-ONLY forensic).
        A visibility-only panel of pre-queue fail-closed evidence rejections recorded on THIS
        device. It is NOT a manual-review queue, NOT a central audit log, and carries NO
        resolve/delete/retry/sync/export action — it reads `listReversalRejections` and nothing
        else. Behind the same Manager/Admin gate as the queue above.
      */}
      <div className="mt-8 flex flex-col gap-4 border-t-2 border-gray-200 pt-8 dark:border-gray-700">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                บันทึกการปฏิเสธหลักฐาน (อุปกรณ์นี้)
              </h2>
              <Badge color="gray" size="sm" className="w-fit">
                อ่านอย่างเดียว
              </Badge>
            </div>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              บันทึกหลักฐานการปฏิเสธการยกเลิก (รับเข้า/โอน) ที่ถูกปฏิเสธแบบ fail-closed
            </p>
          </div>
          <Badge color="gray" size="sm" className="w-fit">
            {rejectionsLoading ? <Spinner size="sm" /> : `${rejections.length} รายการ`}
          </Badge>
        </div>

        <Alert color="info">
          รายการนี้เป็นบันทึกหลักฐานเฉพาะเครื่องนี้เท่านั้น ไม่ได้ซิงก์ขึ้นเซิร์ฟเวอร์ ไม่ใช่ audit log
          กลาง และไม่ต้องปิดงานจากรายการนี้ (อ่านอย่างเดียว)
        </Alert>

        {rejectionsError ? (
          <Alert color="failure">
            <span className="font-medium">โหลดบันทึกไม่สำเร็จ:</span> {rejectionsError}
          </Alert>
        ) : rejectionsLoading ? (
          <div className="flex justify-center p-8">
            <Spinner size="xl" aria-label="Loading rejection log" />
          </div>
        ) : rejections.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
            ยังไม่มีบันทึกการปฏิเสธหลักฐานบนอุปกรณ์นี้
          </div>
        ) : (
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHead>
                  <TableHeadCell>เวลา</TableHeadCell>
                  <TableHeadCell>ประเภท</TableHeadCell>
                  <TableHeadCell>เอกสาร</TableHeadCell>
                  <TableHeadCell>สาขา</TableHeadCell>
                  <TableHeadCell>รหัส</TableHeadCell>
                  <TableHeadCell>เหตุผล</TableHeadCell>
                  <TableHeadCell>ผู้ทำรายการ</TableHeadCell>
                </TableHead>
                <TableBody className="divide-y">
                  {rejections.map((r) => (
                    <TableRow
                      key={r.recordId}
                      className="bg-white dark:border-gray-700 dark:bg-gray-800"
                    >
                      <TableCell className="whitespace-nowrap font-mono text-xs text-gray-500 dark:text-gray-400">
                        {r.createdAt}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Badge color={r.sourceType === 'receiving' ? 'info' : 'purple'} className="w-fit">
                          {r.sourceType}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs whitespace-nowrap">{r.sourceId}</TableCell>
                      <TableCell className="whitespace-nowrap">{r.branchId}</TableCell>
                      <TableCell className="font-mono text-xs whitespace-nowrap">{r.evidenceCode}</TableCell>
                      <TableCell className="max-w-xs truncate" title={r.evidenceMessage}>
                        {r.evidenceMessage}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-gray-500 dark:text-gray-400">
                        {r.staffId ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}
      </div>

      <div className="mt-8 flex flex-col gap-4 border-t-2 border-gray-200 pt-8 dark:border-gray-700">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                คำขอยกเลิกบิลที่ไม่ถูกส่ง (อุปกรณ์นี้)
              </h2>
              <Badge color="gray" size="sm" className="w-fit">
                อ่านอย่างเดียว
              </Badge>
            </div>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              คำขอยกเลิกบิลที่หยุดส่งแล้ว และต้องให้ผู้จัดการตรวจสอบ — ไม่มีปุ่มซิงก์ในหน้านี้
            </p>
          </div>
          <Badge color="gray" size="sm" className="w-fit">
            {voidTerminalsLoading ? <Spinner size="sm" /> : `${voidTerminals.length} รายการ`}
          </Badge>
        </div>

        <Alert color="info">
          รายการนี้เป็นสถานะเฉพาะเครื่องนี้ อ่านอย่างเดียว ไม่ใช่ศูนย์ซิงก์ และไม่มีปุ่มส่งซ้ำในขั้นตอนนี้
        </Alert>

        {voidTerminalsError ? (
          <Alert color="failure">
            <span className="font-medium">โหลดคำขอยกเลิกไม่สำเร็จ:</span> {voidTerminalsError}
          </Alert>
        ) : voidTerminalsLoading ? (
          <div className="flex justify-center p-8">
            <Spinner size="xl" aria-label="Loading terminal void intents" />
          </div>
        ) : voidTerminals.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
            ไม่มีคำขอยกเลิกบิลที่หยุดส่งบนอุปกรณ์นี้
          </div>
        ) : (
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHead>
                  <TableHeadCell>เลขบิล</TableHeadCell>
                  <TableHeadCell>สาขา</TableHeadCell>
                  <TableHeadCell>เหตุผล</TableHeadCell>
                  <TableHeadCell>ผู้ขอ</TableHeadCell>
                  <TableHeadCell>สถานะ</TableHeadCell>
                </TableHead>
                <TableBody className="divide-y">
                  {voidTerminals.map((row) => (
                    <TableRow
                      key={row.orderId}
                      className="bg-white dark:border-gray-700 dark:bg-gray-800"
                    >
                      <TableCell className="font-mono text-xs whitespace-nowrap">{row.orderId}</TableCell>
                      <TableCell className="whitespace-nowrap">{row.branchId}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {getVoidTerminalReasonLabel(row.terminalReason)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-gray-500 dark:text-gray-400">
                        {row.voidedBy}
                      </TableCell>
                      <TableCell>
                        <Badge color="failure" size="sm" className="w-fit">
                          ไม่ได้ส่ง
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}
      </div>

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

      {/*
        SEC-001 N3 Phase 2 — destructive confirmation. One row at a time, reason required,
        and the copy states plainly what is destroyed and what the absence of detected
        server evidence does NOT prove. Cancel closes without calling anything.
      */}
      <Modal show={discardTarget !== null} onClose={closeDiscard} size="md">
        <ModalHeader>ลบข้อมูลอนุมัติยกเลิกบิลที่อ่านไม่ได้</ModalHeader>
        <ModalBody>
          <div className="flex flex-col gap-4">
            <Alert color="failure">
              การลบนี้ถาวรและย้อนกลับไม่ได้ — ข้อมูลดิบของคีย์{' '}
              <span className="font-mono break-all">{discardTarget?.key}</span>{' '}
              จะถูกเก็บเป็นหลักฐานไว้บนเครื่องนี้ก่อน แล้วจึงลบออกจากคลังข้อมูลอนุมัติ
            </Alert>
            <Alert color="warning">
              ระบบไม่พบร่องรอยผลตัดสินจากเซิร์ฟเวอร์ในข้อมูลดิบนี้
              แต่<span className="font-semibold">ไม่ได้พิสูจน์ว่าไม่เคยมีการส่งหรือไม่มีผลบนเซิร์ฟเวอร์</span>{' '}
              ข้อมูลอาจเสียหายจนหายไปได้ หากไม่แน่ใจ ให้ส่งเรื่องให้ฝ่ายสนับสนุนก่อน
            </Alert>
            <div>
              <Label htmlFor="ue-reason">เหตุผล (reasonCode) *</Label>
              <TextInput
                id="ue-reason"
                value={discardReasonCode}
                onChange={(e) => setDiscardReasonCode(e.target.value)}
                placeholder="เช่น unreadable_row_support_cleared"
                required
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="ue-note">หมายเหตุ (note)</Label>
              <Textarea
                id="ue-note"
                value={discardNote}
                onChange={(e) => setDiscardNote(e.target.value)}
                rows={3}
                placeholder="ไม่บังคับ"
              />
            </div>
            {discardError && <Alert color="failure">{discardError}</Alert>}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button color="gray" onClick={closeDiscard} disabled={discardSubmitting}>
            ยกเลิก
          </Button>
          <Button
            color="failure"
            onClick={() => void submitDiscard()}
            disabled={discardSubmitting}
          >
            {discardSubmitting ? <Spinner size="sm" /> : 'ยืนยันลบถาวร'}
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
