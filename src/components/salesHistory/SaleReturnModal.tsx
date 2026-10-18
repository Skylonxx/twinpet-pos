import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Alert, Badge, Button, Label, Select, TextInput, Textarea } from '../ui';
import ManagerPinModal from '../pos/ManagerPinModal';
import { formatMoney } from '../../lib/pos/cartUtils';
import { useAuth } from '../../lib/hooks/useAuth';
import { useApproverRoster } from '../../lib/auth/useApproverRoster';
import { getActiveShift } from '../../lib/pos/shiftService';
import {
  REFUND_METHOD_LABEL,
  RETURN_REASONS,
  SALE_RETURN_ACTION_LABEL,
  SALE_RETURN_ERROR_COPY,
  SALE_RETURN_OFFLINE_COPY,
  SALE_RETURN_UNKNOWN_OUTCOME_COPY,
  checkReturnDraft,
  classificationCopy,
  minorToBaht,
  previewLineRefundMinor,
  qtyToMilli,
  type SaleReturnContextView,
  type SaleReturnRefundMethod,
} from '../../lib/saleReturn/saleReturnTypes';
import {
  fetchSaleReturnContext,
  newReturnAttemptId,
  refreshShiftFromServer,
  submitSaleReturnRequest,
  type SaleReturnContextResult,
  type SubmitSaleReturnInput,
} from '../../lib/saleReturn/saleReturnService';

// Return/Refund V1 (D-RET-8) — sale-linked partial return from Sales History.
// Online-only. Distinct from the whole-bill Void: it never cancels the sale.
// The server computes everything; this modal only previews and submits.

export type SaleReturnTarget = { orderId: string; branchId: string; billLabel: string; saleDateLabel: string };

type Phase =
  | { kind: 'loading' }
  | { kind: 'blocked'; message: string }
  | { kind: 'form' }
  | { kind: 'pin' }
  | { kind: 'submitting' }
  | { kind: 'unknown' }
  | { kind: 'success'; returnNo: string; refundAmount: number; refundMethod: SaleReturnRefundMethod };

export interface SaleReturnModalProps {
  target: SaleReturnTarget | null;
  onClose: () => void;
  /** Called once after the server confirms a committed return. */
  onCompleted?: (returnNo: string) => void;
}

export default function SaleReturnModal({ target, onClose, onCompleted }: SaleReturnModalProps) {
  if (!target) return null;
  return <SaleReturnDialog key={target.orderId} target={target} onClose={onClose} onCompleted={onCompleted} />;
}

function SaleReturnDialog({
  target,
  onClose,
  onCompleted,
}: {
  target: SaleReturnTarget;
  onClose: () => void;
  onCompleted?: (returnNo: string) => void;
}) {
  const { user } = useAuth();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [context, setContext] = useState<SaleReturnContextView | null>(null);
  const [qtyInputs, setQtyInputs] = useState<Record<number, string>>({});
  const [refundMethod, setRefundMethod] = useState<SaleReturnRefundMethod | ''>('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [approverId, setApproverId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [activeShiftId, setActiveShiftId] = useState<string | null>(null);
  const [shiftChecked, setShiftChecked] = useState(false);
  // Frozen request (without PIN) once approval is requested; a retry after an
  // unknown outcome re-sends EXACTLY this payload under the same attemptId.
  const [locked, setLocked] = useState<Omit<SubmitSaleReturnInput, 'pin'> | null>(null);

  const roster = useApproverRoster({
    enabled: phase.kind !== 'loading' && phase.kind !== 'blocked',
    branchId: target.branchId,
    requesterStaffId: user?.id ?? null,
  });

  const applyContextResult = useCallback((res: SaleReturnContextResult) => {
    if (res.kind === 'offline') return setPhase({ kind: 'blocked', message: SALE_RETURN_OFFLINE_COPY });
    if (res.kind === 'unavailable') {
      return setPhase({ kind: 'blocked', message: 'โหลดข้อมูลการคืนสินค้าไม่สำเร็จ — กรุณาลองใหม่' });
    }
    if (res.kind === 'error') return setPhase({ kind: 'blocked', message: SALE_RETURN_ERROR_COPY[res.code] });
    setContext(res.context);
    if (res.classification !== 'RETURN_ELIGIBLE' || !res.context) {
      return setPhase({ kind: 'blocked', message: classificationCopy(res.classification, res.reason) });
    }
    setPhase({ kind: 'form' });
  }, []);

  const reload = useCallback(async () => {
    setPhase({ kind: 'loading' });
    applyContextResult(await fetchSaleReturnContext(target.orderId, target.branchId));
  }, [applyContextResult, target.orderId, target.branchId]);

  // Initial phase is already `loading`.
  useEffect(() => {
    let cancelled = false;
    void fetchSaleReturnContext(target.orderId, target.branchId).then((res) => {
      if (!cancelled) applyContextResult(res);
    });
    return () => {
      cancelled = true;
    };
  }, [applyContextResult, target.orderId, target.branchId]);

  // Cash refunds leave the requester's own open shift drawer.
  useEffect(() => {
    if (!user || !context || shiftChecked) return;
    if (!context.refundMethods.some((m) => m.method === 'cash')) return;
    let cancelled = false;
    void getActiveShift(target.branchId, user.id)
      .then((shift) => {
        if (!cancelled) setActiveShiftId(shift?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setActiveShiftId(null);
      })
      .finally(() => {
        if (!cancelled) setShiftChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user, context, shiftChecked, target.branchId]);

  const draft = useMemo(() => {
    if (!context) return null;
    return checkReturnDraft(
      context,
      context.lines.map((l) => ({ lineIndex: l.lineIndex, qty: Number(qtyInputs[l.lineIndex] ?? '') || 0 })),
    );
  }, [context, qtyInputs]);

  const refundMinor = draft && draft.ok ? draft.refundMinor : 0;
  const effectiveMethod: SaleReturnRefundMethod | '' = refundMinor === 0 && draft?.ok ? 'none' : refundMethod;
  const approver = roster.candidates.find((c) => c.userId === approverId) ?? null;
  const busy = phase.kind === 'submitting';

  const requestApproval = () => {
    setFormError(null);
    if (!context || !user) return;
    if (!draft || !draft.ok) return setFormError(draft && !draft.ok ? draft.message : 'กรุณาระบุจำนวนที่คืน');
    if (!reason) return setFormError('กรุณาเลือกเหตุผลการคืนสินค้า');
    if (reason === 'อื่นๆ' && !note.trim()) return setFormError('กรุณาระบุรายละเอียดเหตุผล');
    if (!effectiveMethod) return setFormError('กรุณาเลือกช่องทางคืนเงิน');
    if (effectiveMethod !== 'none') {
      const tender = context.refundMethods.find((m) => m.method === effectiveMethod);
      if (!tender) return setFormError(SALE_RETURN_ERROR_COPY.refund_method_not_allowed);
      if (Math.round(tender.remaining * 100) < refundMinor) return setFormError(SALE_RETURN_ERROR_COPY.refund_cap_exceeded);
      if (effectiveMethod !== 'cash' && !reference.trim()) return setFormError(SALE_RETURN_ERROR_COPY.reference_required);
      if (effectiveMethod === 'cash' && !activeShiftId) return setFormError(SALE_RETURN_ERROR_COPY.shift_required);
    }
    if (!approver) return setFormError('กรุณาเลือกผู้จัดการที่อนุมัติ');
    setLocked({
      attemptId: newReturnAttemptId(),
      orderId: context.orderId,
      branchId: target.branchId,
      lines: draft.lines,
      refundMethod: effectiveMethod,
      refundReference: reference.trim(),
      reason: reason === 'อื่นๆ' ? `อื่นๆ: ${note.trim()}` : reason,
      note: note.trim(),
      expectedRefundAmount: minorToBaht(refundMinor),
      shiftId: effectiveMethod === 'cash' ? activeShiftId : null,
      approverStaffId: approver.userId,
    });
    setPinError(null);
    setPhase({ kind: 'pin' });
  };

  const submitWithPin = async (pin: string) => {
    if (!locked) return;
    setPhase({ kind: 'submitting' });
    const res = await submitSaleReturnRequest({ ...locked, pin });
    if (res.kind === 'ok') {
      setLocked(null);
      if (locked.refundMethod === 'cash' && locked.shiftId) void refreshShiftFromServer(locked.shiftId);
      setPhase({ kind: 'success', returnNo: res.returnNo, refundAmount: res.refundAmount, refundMethod: res.refundMethod });
      onCompleted?.(res.returnNo);
      return;
    }
    if (res.kind === 'unknown') return setPhase({ kind: 'unknown' });
    if (res.kind === 'offline') {
      // Detected before sending: nothing reached the server, nothing is queued.
      setLocked(null);
      setFormError(SALE_RETURN_OFFLINE_COPY);
      return setPhase({ kind: 'form' });
    }
    if (res.code === 'invalid_credentials' || res.code === 'locked') {
      setPinError(SALE_RETURN_ERROR_COPY[res.code]);
      return setPhase({ kind: 'pin' });
    }
    // Definitive rejection: nothing committed. Start a fresh attempt on retry.
    setLocked(null);
    setFormError(SALE_RETURN_ERROR_COPY[res.code]);
    if (res.code === 'over_return' || res.code === 'refund_mismatch' || res.code === 'return_not_eligible') {
      await reload();
      return;
    }
    setPhase({ kind: 'form' });
  };

  if (phase.kind === 'pin' || phase.kind === 'submitting') {
    return (
      <ManagerPinModal
        open
        title="อนุมัติการคืนสินค้า / คืนเงิน"
        description={
          <>
            <span data-testid="sale-return-approver">ผู้อนุมัติ: {approver?.displayName ?? '—'}</span>
            <br />
            <span>
              บิล {target.billLabel} · คืนเงิน ฿{formatMoney(locked?.expectedRefundAmount ?? 0)} ·{' '}
              {locked ? REFUND_METHOD_LABEL[locked.refundMethod] : ''}
            </span>
            <br />
            <span>ให้ผู้อนุมัติใส่ PIN ของตนเอง</span>
          </>
        }
        pinLength={4}
        isSubmitting={phase.kind === 'submitting'}
        errorMessage={pinError}
        onSubmitPin={(pin) => void submitWithPin(pin)}
        onCancel={() => {
          setLocked(null);
          setPhase({ kind: 'form' });
        }}
        data-testid="sale-return-pin-modal"
      />
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={SALE_RETURN_ACTION_LABEL}
    >
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-4 shadow-xl sm:p-6" data-testid="sale-return-modal">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{SALE_RETURN_ACTION_LABEL}</h2>
            <p className="text-sm text-gray-600">
              บิล {target.billLabel} · {target.saleDateLabel}
              {context?.customerName ? ` · ${context.customerName}` : ''}
            </p>
          </div>
          <Button color="light" size="sm" onClick={onClose} disabled={busy}>
            ปิด
          </Button>
        </div>

        {phase.kind === 'loading' && (
          <p className="py-6 text-center text-sm text-gray-600" role="status">
            กำลังโหลดข้อมูลบิล...
          </p>
        )}

        {phase.kind === 'blocked' && (
          <Alert color="failure" data-testid="sale-return-blocked">
            {phase.message}
          </Alert>
        )}

        {phase.kind === 'unknown' && (
          <div className="space-y-3">
            <Alert color="warning" data-testid="sale-return-unknown">
              {SALE_RETURN_UNKNOWN_OUTCOME_COPY}
            </Alert>
            <div className="flex flex-wrap justify-end gap-2">
              <Button color="light" onClick={onClose}>
                ปิด
              </Button>
              <Button
                onClick={() => {
                  setPinError(null);
                  setPhase({ kind: 'pin' });
                }}
              >
                ส่งอีกครั้ง
              </Button>
            </div>
          </div>
        )}

        {phase.kind === 'success' && (
          <div className="space-y-3" data-testid="sale-return-success">
            <Alert color="success">
              <div className="font-semibold">บันทึกการคืนสินค้าแล้ว — เลขที่ {phase.returnNo}</div>
              <div>
                คืนเงิน ฿{formatMoney(phase.refundAmount)} · {REFUND_METHOD_LABEL[phase.refundMethod]}
              </div>
              {phase.refundMethod === 'cash' && <div>หักเงินสดออกจากลิ้นชักกะปัจจุบันแล้ว</div>}
              {phase.refundMethod !== 'cash' && phase.refundMethod !== 'none' && (
                <div>บันทึกรายการคืนเงินแล้ว — ผู้ทำรายการต้องโอน/คืนเงินให้ลูกค้าเอง ระบบไม่ได้ยืนยันกับผู้ให้บริการชำระเงิน</div>
              )}
            </Alert>
            <div className="flex justify-end">
              <Button onClick={onClose}>เสร็จสิ้น</Button>
            </div>
          </div>
        )}

        {phase.kind === 'form' && context && (
          <div className="space-y-4">
            {formError && (
              <Alert color="failure" data-testid="sale-return-error">
                {formError}
              </Alert>
            )}

            <ul className="space-y-2" data-testid="sale-return-lines">
              {context.lines.map((l) => {
                const raw = qtyInputs[l.lineIndex] ?? '';
                const milli = qtyToMilli(Number(raw) || 0) ?? 0;
                const preview = milli > 0 && l.returnedQtyMilli + milli <= l.soldQtyMilli ? previewLineRefundMinor(l, milli) : 0;
                const exhausted = l.returnableQty <= 0;
                return (
                  <li key={l.lineIndex} className="rounded-md border border-gray-200 p-3" data-testid={`sale-return-line-${l.lineIndex}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900">
                          {l.productName} <span className="text-sm text-gray-600">({l.unit})</span>
                        </div>
                        <div className="text-xs text-gray-600">
                          ราคา ฿{formatMoney(l.unitPrice)}
                          {l.lineDiscount > 0 ? ` · ลด ฿${formatMoney(l.lineDiscount)}` : ''}
                          {l.billDiscountAlloc > 0 ? ` · ส่วนลดท้ายบิล ฿${formatMoney(l.billDiscountAlloc)}` : ''}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1 text-xs">
                        <Badge color="gray">ขาย {l.soldQty}</Badge>
                        <Badge color="warning">คืนแล้ว {l.returnedQty}</Badge>
                        <Badge color={exhausted ? 'failure' : 'success'}>คืนได้ {l.returnableQty}</Badge>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Label htmlFor={`ret-qty-${l.lineIndex}`} className="text-sm">
                        จำนวนคืน
                      </Label>
                      <TextInput
                        id={`ret-qty-${l.lineIndex}`}
                        type="number"
                        inputMode="decimal"
                        min={0}
                        max={l.returnableQty}
                        step="any"
                        className="w-28"
                        sizing="lg"
                        disabled={exhausted}
                        value={raw}
                        onChange={(e) => setQtyInputs((cur) => ({ ...cur, [l.lineIndex]: e.target.value }))}
                      />
                      <Button
                        color="light"
                        size="sm"
                        disabled={exhausted}
                        onClick={() => setQtyInputs((cur) => ({ ...cur, [l.lineIndex]: String(l.returnableQty) }))}
                      >
                        คืนทั้งหมด
                      </Button>
                      <span className="ml-auto text-sm text-gray-700">คืนเงิน ฿{formatMoney(minorToBaht(preview))}</span>
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="flex items-center justify-between rounded-md bg-gray-50 p-3">
              <span className="text-sm text-gray-700">ยอดคืนเงินรวม (ตามราคาและส่วนลดเดิมของบิล)</span>
              <span className="text-xl font-semibold text-gray-900" data-testid="sale-return-total">
                ฿{formatMoney(minorToBaht(refundMinor))}
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="ret-method">ช่องทางคืนเงิน *</Label>
                {refundMinor === 0 && draft?.ok ? (
                  <p className="mt-2 text-sm text-gray-700">{REFUND_METHOD_LABEL.none}</p>
                ) : (
                  <Select
                    id="ret-method"
                    sizing="lg"
                    value={refundMethod}
                    onChange={(e) => setRefundMethod(e.target.value as SaleReturnRefundMethod | '')}
                  >
                    <option value="">เลือกช่องทาง</option>
                    {context.refundMethods.map((m) => (
                      <option key={m.method} value={m.method} disabled={m.method === 'cash' && shiftChecked && !activeShiftId}>
                        {REFUND_METHOD_LABEL[m.method]} · คืนได้ ฿{formatMoney(m.remaining)}
                        {m.method === 'cash' && shiftChecked && !activeShiftId ? ' (ต้องเปิดกะ)' : ''}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
              {effectiveMethod && effectiveMethod !== 'cash' && effectiveMethod !== 'none' && (
                <div>
                  <Label htmlFor="ret-ref">เลขอ้างอิงการคืนเงิน *</Label>
                  <TextInput
                    id="ret-ref"
                    sizing="lg"
                    maxLength={120}
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="เช่น เลขรายการโอน / slip"
                  />
                </div>
              )}
              <div>
                <Label htmlFor="ret-reason">เหตุผลการคืน *</Label>
                <Select id="ret-reason" sizing="lg" value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="">เลือกเหตุผล</option>
                  {RETURN_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="ret-approver">ผู้จัดการที่อนุมัติ *</Label>
                <Select id="ret-approver" sizing="lg" value={approverId} onChange={(e) => setApproverId(e.target.value)}>
                  <option value="">{roster.status === 'pending' ? 'กำลังโหลด...' : 'เลือกผู้อนุมัติ'}</option>
                  {roster.candidates.map((c) => (
                    <option key={c.userId} value={c.userId}>
                      {c.displayName} ({c.role === 'admin' ? 'ผู้ดูแลระบบ' : 'ผู้จัดการ'})
                    </option>
                  ))}
                </Select>
                {roster.status === 'error' && <p className="mt-1 text-xs text-red-700">โหลดรายชื่อผู้อนุมัติไม่สำเร็จ</p>}
              </div>
            </div>
            <div>
              <Label htmlFor="ret-note">หมายเหตุ{reason === 'อื่นๆ' ? ' *' : ''}</Label>
              <Textarea id="ret-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button color="light" size="lg" onClick={onClose}>
                ยกเลิก
              </Button>
              <Button size="lg" onClick={requestApproval} data-testid="sale-return-request-approval">
                ขออนุมัติคืนสินค้า
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
