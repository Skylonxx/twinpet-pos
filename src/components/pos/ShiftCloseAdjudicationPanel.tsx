import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Label, Modal, ModalBody, ModalFooter, ModalHeader, Select, Spinner, Textarea } from 'flowbite-react';
import { ALERT_REASON_LABELS } from '../../lib/pos/shiftClose/shiftCloseReviewRows';
import type { ShiftCloseAlertSourceState, ShiftCloseCaseSourceState } from '../../lib/pos/shiftClose/useShiftCloseAlertDetail';
import type { IntegrityCaution } from '../../lib/pos/shiftClose/shiftCloseDetailProjection';
import {
  applyAdjudicationResult,
  applyApprovalResult,
  availableOutcomes,
  cancelReauth,
  checkAdjudicationLiveInvalidation,
  closeAdjudicationDialog,
  computeScopeKey,
  confirmApproverSelection,
  initialAdjudicationMachineState,
  MAX_REASON_NOTE_LENGTH,
  openAdjudicationDialog,
  retrySameAdjudicationCommand,
  returnToApproverSelection,
  scopeBoundAvailability,
  selectApprover,
  submitAdjudication,
  updateAdjudicationDraft,
  validateAdjudicationSubmit,
  type AdjudicationMachineState,
  type AdjudicationOutcome,
  type BaseAvailabilityInput,
} from '../../lib/pos/shiftClose/shiftCloseAdjudicationMachine';
import {
  callResolveShiftCloseAlert,
  type ResolveShiftCloseAlertAdapterRequest,
  type ResolveShiftCloseAlertTransport,
} from '../../lib/pos/shiftClose/resolveShiftCloseAlertAdapter';
import ManagerPinModal from './ManagerPinModal';
import {
  callRequestManagerApproval,
  type RequestManagerApprovalTransport,
} from '../../lib/auth/requestManagerApproval';
import {
  expectedProtectedAction,
  MANAGER_APPROVAL_ERROR_LABELS,
  type LiveManagerApprovalAction,
  type ProtectedAction,
} from '../../lib/auth/managerApprovalTypes';
import { useApproverRoster } from '../../lib/auth/useApproverRoster';
import type { ApproverCandidate } from '../../lib/auth/approverEligibility';
import { AuthContext } from '../../lib/auth/AuthProvider';

/**
 * Packet 5 / Client-UI-C — manager adjudication action surface. Frozen DP1-DP4
 * decisions + R2 architecture (see shiftCloseAdjudicationMachine.ts header).
 * Hidden entirely when `scopeBoundAvailability` is false — the frozen
 * `baseAvailability` conditions AND the final-RC-4 live-source-to-scope
 * binding (AGY §5 — no disabled buttons for functionally unavailable
 * states), EXCEPT while an in-flight
 * decision/receipt from a still-open dialog is being shown, so a result
 * receipt is never yanked out from under the manager the instant the live
 * listener reflects the just-completed transition.
 */
export interface ShiftCloseAdjudicationPanelProps {
  role: string | null | undefined;
  branchId: string;
  routeShiftId: string;
  alertSource: ShiftCloseAlertSourceState;
  caseSource: ShiftCloseCaseSourceState;
  integrityCautions: IntegrityCaution[];
  /** Test-only injection point — production callers omit this (default Firebase transport). */
  transport?: ResolveShiftCloseAlertTransport;
  /** Test-only injection point for the Packet 2A approval callable. */
  approvalTransport?: RequestManagerApprovalTransport;
  /** Test-only online signal; production uses navigator.onLine. */
  isOnline?: () => boolean;
  /** Test-only requester id. Production reads AuthContext.user.id. */
  requesterStaffId?: string | null;
}

// SEC-001 Part P/A/B seam: the shared `ProtectedAction` union now also
// carries the privileged VOID_PENDING_SALE/VOID_SETTLED_SALE members. This
// panel is a shift-close-only consumer, so any value routed toward its
// acknowledge/resolve manager-approval path must be re-narrowed at this
// boundary — a VOID action must never reach that handler.
export type ShiftCloseAlertAction = LiveManagerApprovalAction;

export function isShiftCloseAlertAction(action: ProtectedAction): action is ShiftCloseAlertAction {
  return action === 'shift_close_alert_acknowledge' || action === 'shift_close_alert_resolve';
}

const REJECT_CODE_LABELS: Record<string, string> = {
  unauthorized: 'ไม่มีสิทธิ์ดำเนินการ',
  invalid_pin: 'ต้องยืนยัน PIN ใหม่ก่อนดำเนินการ',
  invalid_payload: 'ข้อมูลไม่ถูกต้องหรือไม่ครบถ้วน',
  case_not_found: 'ไม่พบเคสปิดกะนี้',
  alert_not_open: 'ไม่สามารถดำเนินการกับการแจ้งเตือนนี้ได้แล้ว',
  invalid_outcome_transition: 'ไม่สามารถเปลี่ยนสถานะได้ในขณะนี้',
  server_error: 'เกิดข้อผิดพลาดภายในระบบ',
};

export default function ShiftCloseAdjudicationPanel({
  role,
  branchId,
  routeShiftId,
  alertSource,
  caseSource,
  integrityCautions,
  transport,
  approvalTransport,
  isOnline,
  requesterStaffId: requesterStaffIdProp,
}: ShiftCloseAdjudicationPanelProps) {
  const authCtx = useContext(AuthContext);
  const requesterStaffId = requesterStaffIdProp ?? authCtx?.user?.id ?? null;
  const live: BaseAvailabilityInput = {
    alertSource: { status: alertSource.status, fromCache: alertSource.fromCache },
    alertRow: alertSource.row,
    caseSource: { status: caseSource.status, fromCache: caseSource.fromCache },
    caseProjection: caseSource.projection,
    integrityCautions,
  };
  const scopeKey = computeScopeKey(role, branchId, routeShiftId);
  // Final RC-4: the offer gate is the scope-BOUND availability — frozen
  // conditions 1-17 AND live alert/case identity + alert branch binding to the
  // current structured route/branch. Stale prior-scope rows (the upstream
  // hook's delimiter-colliding reset key can let them survive one render)
  // therefore can never offer, open a dialog, capture a token, mint, or call.
  const available = scopeBoundAvailability(live, scopeKey);

  const [state, setState] = useState<AdjudicationMachineState>(initialAdjudicationMachineState);
  const [pinSubmitting, setPinSubmitting] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinModalKey, setPinModalKey] = useState(0);

  const readOnline = (): boolean => {
    if (isOnline) return isOnline();
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  };

  // React-endorsed "adjusting state during render" pattern (same precedent as
  // useShiftCloseAlertDetail.ts's genKey reset) — invalidates a `confirming`
  // dialog the instant a listener update breaks freshness, and (final
  // retry-scope remediation) abandons a `retryable` chain the instant the
  // scope or live source binding changes, with zero extra render cycle /
  // effect flash — no actionable stale Retry control ever survives a
  // scope/source change.
  const checked = checkAdjudicationLiveInvalidation(state, live, scopeKey);
  if (checked !== state) {
    setState(checked);
  }
  const effectiveState = checked;

  const rosterEnabled = effectiveState.status === 'approver_selection' && role === 'staff';
  const roster = useApproverRoster({
    enabled: rosterEnabled,
    branchId,
    requesterStaffId,
  });

  // RC-4: kept race-safe via `useLayoutEffect`, NOT a passive `useEffect`.
  // A passive effect runs only after the browser paints; a transport promise
  // can resolve inside that window and would then read a stale ref still
  // pointing at the scope this component has already left. `useLayoutEffect`
  // runs synchronously right after the commit, in the same call stack — no
  // microtask (a promise `.then`) can run in between, so the ref is always
  // current by the time any pending transport promise settles.
  const scopeKeyRef = useRef(scopeKey);
  const machineStateRef = useRef(effectiveState);
  machineStateRef.current = effectiveState;
  const approvalEpochRef = useRef(0);
  const prevMachineStatusRef = useRef(effectiveState.status);
  useLayoutEffect(() => {
    scopeKeyRef.current = scopeKey;
    machineStateRef.current = effectiveState;
    if (prevMachineStatusRef.current === 'reauth_required' && effectiveState.status !== 'reauth_required') {
      approvalEpochRef.current += 1;
      setPinSubmitting(false);
      if (effectiveState.status !== 'approver_selection') {
        setPinError(null);
      }
    }
    prevMachineStatusRef.current = effectiveState.status;
  });
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const dialogTitleId = useId();
  const dialogDescId = useId();
  const noteId = useId();
  const noteHelpId = useId();
  const checkboxHelpId = useId();
  // Stable per-outcome refs (NOT a captured event target): the trigger
  // buttons unmount while the dialog is open (they live in a mutually
  // exclusive render branch), so a ref captured at click time would point at
  // a detached node once the dialog closes and the buttons remount. A stable
  // ref object re-attaches to the freshly mounted node on every render.
  const ackButtonRef = useRef<HTMLButtonElement | null>(null);
  const resolveButtonRef = useRef<HTMLButtonElement | null>(null);
  const lastOutcomeRef = useRef<AdjudicationOutcome | null>(null);
  const wasDialogOpenRef = useRef(false);

  async function runTransport(payload: ResolveShiftCloseAlertAdapterRequest) {
    const result = await callResolveShiftCloseAlert(payload, transport);
    if (!mountedRef.current) return;
    setState((prev) => applyAdjudicationResult(prev, result, scopeKeyRef.current));
  }

  const handleOpen = (outcome: AdjudicationOutcome) => {
    lastOutcomeRef.current = outcome;
    setState(openAdjudicationDialog(outcome, live, scopeKey));
  };

  const handleClose = () => {
    setPinError(null);
    setPinSubmitting(false);
    setState(closeAdjudicationDialog());
  };

  const handleSubmit = () => {
    const next = submitAdjudication(effectiveState, live, scopeKey);
    setState(next);
    setPinError(null);
  };

  const handlePinCancel = () => {
    if (pinSubmitting) return;
    setPinError(null);
    setState((prev) => cancelReauth(prev));
  };

  const handlePinSubmit = (pin: string) => {
    if (effectiveState.status !== 'reauth_required') return;
    if (pinSubmitting) return;
    if (!readOnline()) {
      setPinError(MANAGER_APPROVAL_ERROR_LABELS.offline);
      setPinModalKey((k) => k + 1);
      return;
    }
    setPinSubmitting(true);
    const frozen = effectiveState;
    const attemptCommandId = frozen.commandId;
    const attemptEpoch = approvalEpochRef.current;
    const protectedAction = expectedProtectedAction(frozen.outcome);
    if (!isShiftCloseAlertAction(protectedAction)) {
      setPinSubmitting(false);
      return;
    }
    void (async () => {
      const result = await callRequestManagerApproval(
        {
          commandId: frozen.commandId,
          protectedAction,
          targetEntityId: frozen.payload.shiftId,
          branchId: frozen.payload.branchId,
          pin,
          ...(frozen.securityModel === 'delegated' && frozen.approver
            ? { securityModel: 'delegated' as const, approverStaffId: frozen.approver.userId }
            : {}),
        },
        approvalTransport,
      );
      if (!mountedRef.current) return;
      const current = machineStateRef.current;
      const stale =
        approvalEpochRef.current !== attemptEpoch ||
        current.status !== 'reauth_required' ||
        current.commandId !== attemptCommandId;
      if (stale) {
        setPinSubmitting(false);
        return;
      }
      setPinSubmitting(false);
      if (result.kind !== 'ok') {
        setPinError(MANAGER_APPROVAL_ERROR_LABELS[result.code] ?? MANAGER_APPROVAL_ERROR_LABELS.invalid_credentials);
        setPinModalKey((k) => k + 1);
        if (result.code === 'approver_not_eligible' || result.code === 'self_approval_not_permitted') {
          setState((prev) => returnToApproverSelection(prev));
        } else if (result.code === 'invalid_target' && frozen.securityModel === 'delegated') {
          setState((prev) => cancelReauth(prev));
        }
        return;
      }
      setPinError(null);
      const submitting = applyApprovalResult(current, result.approvalId, attemptCommandId);
      setState(submitting);
      if (submitting.status === 'submitting') void runTransport(submitting.payload);
    })();
  };

  const handleRetry = () => {
    // Final retry-scope remediation: retry goes through the GUARDED machine
    // transition with the CURRENT live state and CURRENT structured scope —
    // never a direct transport from a prior `retryable` state. A scope/source
    // change abandons the chain (`idle`, dialog closes, zero transport); only
    // a valid same-scope `submitting` result may reach `runTransport`, and it
    // always carries the exact frozen commandId/payload.
    const next = retrySameAdjudicationCommand(effectiveState, live, scopeKey);
    setState(next);
    if (next.status === 'submitting') void runTransport(next.payload);
  };

  const dialogOpen =
    effectiveState.status === 'confirming' ||
    effectiveState.status === 'approver_selection' ||
    effectiveState.status === 'reauth_required' ||
    effectiveState.status === 'submitting' ||
    effectiveState.status === 'retryable';

  useEffect(() => {
    if (wasDialogOpenRef.current && !dialogOpen) {
      const ref = lastOutcomeRef.current === 'resolve' ? resolveButtonRef : ackButtonRef;
      ref.current?.focus();
    }
    wasDialogOpenRef.current = dialogOpen;
  }, [dialogOpen]);

  const showReceipt =
    effectiveState.status === 'success' ||
    effectiveState.status === 'terminal_rejected' ||
    effectiveState.status === 'stale_or_busy' ||
    effectiveState.status === 'terminal_conflict';
  const showPanel = available || dialogOpen || showReceipt;
  if (!showPanel) return null;

  const alertRow = alertSource.row;
  const reasonLabel = alertRow?.reasonCode ? ALERT_REASON_LABELS[alertRow.reasonCode] : null;
  const outcomes = available && alertRow ? availableOutcomes(alertRow.alertState) : [];

  return (
    <Card>
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">การดำเนินการของผู้จัดการ</h2>

        {reasonLabel && available && <p className="text-sm text-gray-600 dark:text-gray-300">เหตุผลจากการแจ้งเตือน: {reasonLabel}</p>}

        {effectiveState.status === 'success' && (
          <Alert color="success">
            {effectiveState.adjudicationStatus === 'duplicate_confirmed' ? (
              <>
                ทำรายการสำเร็จ
                <div className="mt-1 text-xs opacity-80">รายการนี้ได้รับการยืนยันไปแล้วก่อนหน้านี้</div>
              </>
            ) : (
              'ทำรายการสำเร็จ'
            )}
            <div className="mt-3">
              <Button size="sm" color="light" onClick={handleClose} className="min-h-11">
                ปิด
              </Button>
            </div>
          </Alert>
        )}

        {effectiveState.status === 'terminal_rejected' && (
          <Alert color="failure">
            ไม่สามารถทำรายการได้เนื่องจากข้อมูลไม่ถูกต้อง หรือไม่มีสิทธิ์
            {REJECT_CODE_LABELS[effectiveState.rejectCode] && (
              <div className="mt-1 text-xs opacity-80">{REJECT_CODE_LABELS[effectiveState.rejectCode]}</div>
            )}
            <div className="mt-3">
              <Button size="sm" color="light" onClick={handleClose} className="min-h-11">
                ปิด
              </Button>
            </div>
          </Alert>
        )}

        {effectiveState.status === 'stale_or_busy' && (
          <Alert color="warning">
            ข้อมูลมีการเปลี่ยนแปลงหรือกำลังประมวลผล โปรดตรวจสอบข้อมูลล่าสุดก่อนตัดสินใจอีกครั้ง
            <div className="mt-3">
              <Button size="sm" color="light" onClick={handleClose} className="min-h-11">
                เริ่มต้นทำรายการใหม่
              </Button>
            </div>
          </Alert>
        )}

        {effectiveState.status === 'terminal_conflict' && (
          // RC-3: a command/payload-ID collision is NOT data drift or a
          // worker lease — never reuse the stale/busy copy or offer a
          // same-command retry here; the command is discarded outright.
          <Alert color="failure">
            ไม่สามารถยืนยันคำสั่งนี้ได้ เนื่องจากรหัสคำสั่งไม่ตรงกับข้อมูลเดิม โปรดเริ่มทำรายการใหม่
            <div className="mt-3">
              <Button size="sm" color="light" onClick={handleClose} className="min-h-11">
                เริ่มต้นทำรายการใหม่
              </Button>
            </div>
          </Alert>
        )}

        {available &&
          !dialogOpen &&
          effectiveState.status !== 'success' &&
          effectiveState.status !== 'terminal_rejected' &&
          effectiveState.status !== 'stale_or_busy' &&
          effectiveState.status !== 'terminal_conflict' && (
          <div className="flex flex-col gap-2 sm:flex-row">
            {outcomes.includes('acknowledge') && (
              <Button
                ref={ackButtonRef}
                type="button"
                color="light"
                className="min-h-11 w-full sm:w-auto"
                onClick={() => handleOpen('acknowledge')}
              >
                รับทราบ
              </Button>
            )}
            {outcomes.includes('resolve') && (
              <Button
                ref={resolveButtonRef}
                type="button"
                color="yellow"
                className="min-h-11 w-full sm:w-auto"
                onClick={() => handleOpen('resolve')}
              >
                ยืนยันแก้ไข
              </Button>
            )}
          </div>
        )}
      </div>

      {dialogOpen && (
        <AdjudicationDialog
          state={effectiveState}
          titleId={dialogTitleId}
          descId={dialogDescId}
          noteId={noteId}
          noteHelpId={noteHelpId}
          checkboxHelpId={checkboxHelpId}
          onClose={handleClose}
          onNoteChange={(note) => setState((prev) => updateAdjudicationDraft(prev, { note }))}
          onCheckboxChange={(checked2) => setState((prev) => updateAdjudicationDraft(prev, { evidenceChecked: checked2 }))}
          onSubmit={handleSubmit}
          onRetry={handleRetry}
          submitGuardFailure={validateAdjudicationSubmit(effectiveState, live, scopeKey)}
          roster={roster}
          pinError={pinError}
          onSelectApprover={(id) => setState((prev) => selectApprover(prev, id))}
          onConfirmApprover={(candidate) => {
            setPinError(null);
            setState((prev) => confirmApproverSelection(prev, candidate));
          }}
        />
      )}
      {effectiveState.status === 'reauth_required' && (
        <ManagerPinModal
          key={pinModalKey}
          open
          title={
            effectiveState.approver
              ? `ยืนยันโดย ${effectiveState.approver.displayName}`
              : 'ยืนยันตัวตนก่อนดำเนินการ'
          }
          description={
            effectiveState.approver
              ? `กรุณาให้ ${effectiveState.approver.displayName} ใส่ PIN เพื่ออนุมัติรายการนี้`
              : 'กรุณาใส่ PIN ของท่านเพื่อยืนยันการดำเนินการ'
          }
          sessionDisplayName={effectiveState.approver?.displayName}
          pinLength={4}
          isSubmitting={pinSubmitting}
          errorMessage={pinError}
          onSubmitPin={handlePinSubmit}
          onCancel={handlePinCancel}
        />
      )}
    </Card>
  );
}

function AdjudicationDialog({
  state,
  titleId,
  descId,
  noteId,
  noteHelpId,
  checkboxHelpId,
  onClose,
  onNoteChange,
  onCheckboxChange,
  onSubmit,
  onRetry,
  submitGuardFailure,
  roster,
  pinError,
  onSelectApprover,
  onConfirmApprover,
}: {
  state: Extract<
    AdjudicationMachineState,
    { status: 'confirming' | 'approver_selection' | 'reauth_required' | 'submitting' | 'retryable' }
  >;
  titleId: string;
  descId: string;
  noteId: string;
  noteHelpId: string;
  checkboxHelpId: string;
  onClose: () => void;
  onNoteChange: (note: string) => void;
  onCheckboxChange: (checked: boolean) => void;
  onSubmit: () => void;
  onRetry: () => void;
  submitGuardFailure: ReturnType<typeof validateAdjudicationSubmit>;
  roster: ReturnType<typeof useApproverRoster>;
  pinError: string | null;
  onSelectApprover: (id: string) => void;
  onConfirmApprover: (candidate: ApproverCandidate) => void;
}) {
  const isResolve = state.outcome === 'resolve';
  const note =
    state.status === 'confirming' || state.status === 'reauth_required' || state.status === 'approver_selection'
      ? state.note
      : state.payload.reasonNote ?? '';
  const evidenceChecked =
    state.status === 'confirming' || state.status === 'reauth_required' || state.status === 'approver_selection'
      ? state.evidenceChecked
      : true;
  const reasonLabel = ALERT_REASON_LABELS[state.token.alertReasonCode];
  const fieldsReadOnly = state.status !== 'confirming';
  const isBusy = state.status === 'submitting';
  const isRetryable = state.status === 'retryable';
  const noteLength = note.length;
  const overLimit = noteLength > MAX_REASON_NOTE_LENGTH;

  // RC-5: deterministic initial focus, never the Flowbite header Close
  // control. Resolve always focuses the evidence checkbox (the Gemini
  // frozen boundary); acknowledge focuses the note field while it is
  // enabled, falling back to the confirm button otherwise.
  const noteFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const evidenceCheckboxRef = useRef<HTMLInputElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const initialFocus = isResolve ? evidenceCheckboxRef : !fieldsReadOnly ? noteFieldRef : confirmButtonRef;

  return (
    <Modal
      show
      dismissible={!isBusy}
      onClose={onClose}
      size="md"
      initialFocus={initialFocus}
      aria-labelledby={titleId}
      aria-describedby={descId}
    >
      <ModalHeader>
        <span id={titleId}>{isResolve ? 'ยืนยันการแก้ไขการแจ้งเตือน' : 'ยืนยันการรับทราบการแจ้งเตือน'}</span>
      </ModalHeader>
      <ModalBody>
        <div id={descId} className="flex flex-col gap-4">
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-white">เหตุผลที่ใช้ในการตัดสินใจ: {reasonLabel}</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              การกดยืนยันหมายถึงท่านรับรองการใช้เหตุผลนี้ ไม่สามารถเปลี่ยนเหตุผลหลักได้ หากมีข้อคิดเห็นเพิ่มเติม โปรดระบุในหมายเหตุ
            </p>
          </div>

          {!isResolve && (
            <p className="text-sm text-gray-600 dark:text-gray-300">
              การรับทราบไม่ได้เป็นการยืนยันยอดสุดท้าย และระบบไม่แสดงตัวเลขเงินสดในหน้านี้
            </p>
          )}

          {isResolve && (
            <>
              {/*
                L-1: checkbox block immediately followed by the cash-figures
                warning so both land in the initial viewport together — the
                dialog's `initialFocus` targets the checkbox (frozen RC-5
                contract), and the browser's focus-scroll brings this
                adjacent pair into view as a unit instead of stranding the
                warning above the fold.
              */}
              <label
                htmlFor="adjudication-evidence-checkbox"
                className="flex min-h-11 w-full cursor-pointer items-start gap-2 py-1"
              >
                <Checkbox
                  ref={evidenceCheckboxRef}
                  id="adjudication-evidence-checkbox"
                  checked={evidenceChecked}
                  disabled={fieldsReadOnly}
                  aria-describedby={checkboxHelpId}
                  onChange={(e) => onCheckboxChange(e.target.checked)}
                  className="mt-1 h-5 w-5 shrink-0"
                />
                <span>
                  <span className="block text-sm text-gray-900 dark:text-white">ข้าพเจ้าได้ตรวจสอบหลักฐานภายนอกและยืนยันการแก้ไขนี้</span>
                  <span id={checkboxHelpId} className="block text-xs text-gray-500 dark:text-gray-400">
                    จำเป็นต้องยืนยันการตรวจสอบหลักฐานก่อนดำเนินการ
                  </span>
                </span>
              </label>
              <Alert color="warning">คำเตือน: ระบบไม่แสดงตัวเลขเงินสดในหน้านี้</Alert>
            </>
          )}

          <div>
            <Label htmlFor={noteId}>หมายเหตุ (ทางเลือก)</Label>
            <Textarea
              ref={noteFieldRef}
              id={noteId}
              rows={3}
              value={note}
              disabled={fieldsReadOnly}
              maxLength={MAX_REASON_NOTE_LENGTH}
              placeholder="เพิ่มคำอธิบายเพิ่มเติมที่นี่..."
              aria-describedby={`${noteHelpId} ${noteId}-counter`}
              onChange={(e) => onNoteChange(e.target.value)}
            />
            <p id={noteHelpId} className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              คำเตือน: ห้ามระบุหมายเลข PIN, หมายเลขบัตร, หรือข้อมูลส่วนบุคคล
            </p>
            <p id={`${noteId}-counter`} className={`mt-1 text-right text-xs ${overLimit ? 'text-red-600 dark:text-red-400' : 'text-gray-400'}`}>
              {noteLength.toLocaleString('en-US')}/1,000
            </p>
          </div>

          {(isRetryable || isBusy) && (
            <RetryAmbiguitySection state={state} onRetry={onRetry} onAbandon={onClose} />
          )}

          {state.status === 'approver_selection' && (
            <ApproverPicker
              roster={roster}
              selectedApproverId={state.selectedApproverId}
              pinError={pinError}
              onSelect={onSelectApprover}
            />
          )}
        </div>
      </ModalBody>
      {/*
        RC-6: DOM order is Confirm-then-Cancel, matching the required mobile
        visual stacking order with NO CSS `order-*` reversal, so DOM,
        visual, and keyboard-tab order never contradict each other. `flex-col`
        stacks full-width at mobile; `sm:flex-row` returns to inline at `sm`+.
      */}
      <ModalFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
        {state.status === 'confirming' && (
          <Button
            ref={confirmButtonRef}
            color={isResolve ? 'yellow' : 'light'}
            onClick={onSubmit}
            disabled={submitGuardFailure !== null}
            className="min-h-11 w-full sm:w-auto"
          >
            {isResolve ? 'ยืนยันการแก้ไข' : 'รับทราบ'}
          </Button>
        )}
        {state.status === 'approver_selection' && (
          <Button
            color={isResolve ? 'yellow' : 'light'}
            className="min-h-11 w-full sm:w-auto"
            disabled={
              roster.status !== 'ready' ||
              roster.fromCache ||
              roster.candidates.length === 0 ||
              !state.selectedApproverId
            }
            onClick={() => {
              const chosen = roster.candidates.find((c) => c.userId === state.selectedApproverId);
              if (chosen) onConfirmApprover(chosen);
            }}
          >
            ดำเนินการต่อ
          </Button>
        )}
        {isBusy && (
          <Button color={isResolve ? 'yellow' : 'light'} disabled className="min-h-11 w-full sm:w-auto">
            <Spinner size="sm" />
          </Button>
        )}
        <Button color="gray" onClick={onClose} disabled={isBusy} className="min-h-11 w-full sm:w-auto">
          ยกเลิก
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function ApproverPicker({
  roster,
  selectedApproverId,
  pinError,
  onSelect,
}: {
  roster: ReturnType<typeof useApproverRoster>;
  selectedApproverId: string | null;
  pinError: string | null;
  onSelect: (id: string) => void;
}) {
  const errorAlert = pinError ? <Alert color="failure">{pinError}</Alert> : null;
  if (roster.status === 'pending' || (roster.status === 'ready' && roster.fromCache && roster.candidates.length === 0)) {
    return (
      <div className="flex flex-col gap-2">
        {errorAlert}
        <Alert color="gray">
          กำลังยืนยันรายชื่อผู้อนุมัติกับเซิร์ฟเวอร์ ยังไม่สามารถดำเนินการได้
        </Alert>
      </div>
    );
  }
  if (roster.status === 'error') {
    return (
      <div className="flex flex-col gap-2">
        {errorAlert}
        <Alert color="failure">ไม่สามารถโหลดรายชื่อผู้อนุมัติได้</Alert>
      </div>
    );
  }
  if (roster.status === 'ready' && !roster.fromCache && roster.candidates.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {errorAlert}
        <Alert color="failure">{MANAGER_APPROVAL_ERROR_LABELS.no_eligible_approver}</Alert>
      </div>
    );
  }
  if (roster.status !== 'ready' || roster.candidates.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {errorAlert}
        <Alert color="gray">
          กำลังยืนยันรายชื่อผู้อนุมัติกับเซิร์ฟเวอร์ ยังไม่สามารถดำเนินการได้
        </Alert>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {errorAlert}
      <Label htmlFor="approver-select">เลือกผู้อนุมัติ</Label>
      <Select
        id="approver-select"
        value={selectedApproverId ?? ''}
        onChange={(e) => onSelect(e.target.value)}
        className="min-h-11"
      >
        <option value="">เลือกผู้อนุมัติ</option>
        {roster.candidates.map((c) => (
          <option key={c.userId} value={c.userId}>
            {c.displayName} ({c.username}) · {c.role}
          </option>
        ))}
      </Select>
      {selectedApproverId && (
        <p className="text-sm text-gray-700 dark:text-gray-300">
          ผู้อนุมัติที่เลือก: {roster.candidates.find((c) => c.userId === selectedApproverId)?.displayName}
        </p>
      )}
    </div>
  );
}

function RetryAmbiguitySection({
  state,
  onRetry,
  onAbandon,
}: {
  state: Extract<AdjudicationMachineState, { status: 'submitting' | 'retryable' }>;
  onRetry: () => void;
  onAbandon: () => void;
}) {
  if (state.status === 'submitting') {
    return (
      <Alert color="gray">
        <div className="flex items-center gap-2">
          <Spinner size="sm" /> กำลังส่งข้อมูล...
        </div>
      </Alert>
    );
  }
  return (
    <Alert color="warning">
      ไม่ได้รับการตอบกลับจากเซิร์ฟเวอร์ คำสั่งอาจสำเร็จหรือไม่สำเร็จ โปรดตรวจสอบสถานะอีกครั้ง
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Button size="sm" color="yellow" onClick={onRetry} className="min-h-11">
          ลองส่งข้อมูลเดิมอีกครั้ง
        </Button>
        <Button size="sm" color="gray" onClick={onAbandon} className="min-h-11">
          ยกเลิกคำสั่งนี้
        </Button>
      </div>
    </Alert>
  );
}
