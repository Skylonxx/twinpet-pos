import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ManagerPinModal from './ManagerPinModal';
import { VOID_REASONS } from '../../lib/salesHistory/types';
import { copyForFlowState, pinErrorCopy, rosterFailClosedReason } from '../../lib/pos/privilegedVoid/privilegedVoidCopy';
import type { UsePrivilegedVoidFlowResult } from '../../hooks/pos/usePrivilegedVoidFlow';
import './PrivilegedVoidModal.css';

// SEC-001 Packet E / E-1 — the privileged-only Sales History void UI.
//
// Renders every state of `usePrivilegedVoidFlow`'s flow machine. Never holds
// its own copy of the PIN — `ManagerPinModal` owns that transient buffer and
// forwards it straight to `flow.submitPin`. Manager choice is ALWAYS from
// `flow.roster.candidates` — there is no free-text manager-id input anywhere
// in this component.

export interface PrivilegedVoidModalProps {
  flow: UsePrivilegedVoidFlowResult;
  requesterDisplayName?: string;
}

function DialogShell({
  children,
  onDismiss,
  dismissible,
}: {
  children: React.ReactNode;
  onDismiss: () => void;
  dismissible: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => dialogRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (!dismissible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissible, onDismiss]);

  return createPortal(
    <div
      className="pvm-overlay"
      onPointerDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onDismiss();
      }}
    >
      <div
        className="pvm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="คำขอยกเลิกบิลแบบมีสิทธิ์พิเศษ"
        tabIndex={-1}
        ref={dialogRef}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function ReasonStep({
  onSubmit,
  onCancel,
}: {
  onSubmit: (reason: string, note: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  return (
    <div className="pvm-step">
      <h2 className="pvm-title">เหตุผลการยกเลิกบิล</h2>
      <p className="pvm-desc">ต้องได้รับการอนุมัติจากผู้จัดการก่อนจึงจะดำเนินการต่อได้</p>
      <div className="pvm-field">
        <label htmlFor="pvm-reason">
          เหตุผลการยกเลิก <span className="pvm-required">*</span>
        </label>
        <select id="pvm-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">เลือกเหตุผล</option>
          {VOID_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <div className="pvm-field">
        <label htmlFor="pvm-note">หมายเหตุเพิ่มเติม</label>
        <textarea
          id="pvm-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="ระบุรายละเอียดเพิ่มเติม..."
        />
      </div>
      <div className="pvm-actions">
        <button type="button" className="pvm-btn pvm-btn-cancel" onClick={onCancel}>
          ยกเลิก
        </button>
        <button
          type="button"
          className="pvm-btn pvm-btn-primary"
          disabled={!reason}
          onClick={() => onSubmit(reason, note)}
        >
          ถัดไป
        </button>
      </div>
    </div>
  );
}

function ManagerSelectStep({ flow, onCancel }: { flow: UsePrivilegedVoidFlowResult; onCancel: () => void }) {
  const { roster } = flow;
  const failClosedReason = rosterFailClosedReason(roster);
  const loading = roster.status === 'pending';

  return (
    <div className="pvm-step">
      <h2 className="pvm-title">เลือกผู้จัดการที่อนุมัติ</h2>
      <p className="pvm-desc">เลือกจากรายชื่อผู้จัดการ/ผู้ดูแลระบบที่มีสิทธิ์อนุมัติเท่านั้น</p>

      {loading && <div className="pvm-loading" role="status">กำลังโหลดรายชื่อผู้จัดการ...</div>}

      {!loading && failClosedReason && (
        <div className="pvm-banner pvm-banner-warning" role="alert" data-testid="pvm-roster-fail-closed">
          {failClosedReason}
        </div>
      )}

      {!loading && !failClosedReason && (
        <ul className="pvm-roster-list">
          {roster.candidates.map((c) => (
            <li key={c.userId}>
              <button type="button" className="pvm-roster-item" onClick={() => flow.chooseManager(c.userId)}>
                <span className="pvm-roster-name">{c.displayName}</span>
                <span className="pvm-roster-role">{c.role === 'admin' ? 'ผู้ดูแลระบบ' : 'ผู้จัดการ'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {roster.fromCache && !loading && (
        <p className="pvm-roster-cache-marker" data-testid="pvm-roster-from-cache">
          รายชื่อนี้มาจากแคชในเครื่อง ยังไม่ได้ยืนยันกับเซิร์ฟเวอร์
        </p>
      )}

      <div className="pvm-actions">
        <button type="button" className="pvm-btn pvm-btn-cancel" onClick={onCancel}>
          ยกเลิก
        </button>
      </div>
    </div>
  );
}

function ResultPanel({
  title,
  body,
  tone,
  requesterDisplayName: _requesterDisplayName,
  onClose,
  onRetryReconciliation,
}: {
  title: string;
  body: string;
  tone: 'pending' | 'info' | 'warning' | 'error';
  requesterDisplayName?: string;
  onClose: () => void;
  onRetryReconciliation?: () => void;
}) {
  return (
    <div className="pvm-step">
      <div className={`pvm-result-icon pvm-result-${tone}`} aria-hidden="true">
        <i
          className={`ti ${
            tone === 'pending' ? 'ti-clock' : tone === 'error' ? 'ti-alert-triangle' : tone === 'warning' ? 'ti-alert-circle' : 'ti-info-circle'
          }`}
        />
      </div>
      <h2 className="pvm-title">{title}</h2>
      <p className="pvm-desc" role="status">
        {body}
      </p>
      <div className="pvm-actions">
        {onRetryReconciliation && (
          <button type="button" className="pvm-btn pvm-btn-cancel" onClick={onRetryReconciliation}>
            ตรวจสอบอีกครั้ง
          </button>
        )}
        <button type="button" className="pvm-btn pvm-btn-primary" onClick={onClose}>
          ปิด
        </button>
      </div>
    </div>
  );
}

export default function PrivilegedVoidModal({ flow, requesterDisplayName }: PrivilegedVoidModalProps) {
  const { state } = flow;

  if (state.status === 'IDLE') return null;

  const dismissible = state.status !== 'PROJECTING' && !flow.isSubmitting;

  if (state.status === 'MANAGER_PIN_ENTRY') {
    return (
      <ManagerPinModal
        open
        title="ยืนยันสิทธิ์ผู้จัดการ"
        description="กรุณาใส่ PIN ผู้จัดการเพื่ออนุมัติคำขอยกเลิกบิล"
        sessionDisplayName={requesterDisplayName}
        pinLength={6}
        isSubmitting={flow.isSubmitting}
        errorMessage={state.pinErrorCode ? pinErrorCopy(state.pinErrorCode) : null}
        onSubmitPin={flow.submitPin}
        onCancel={flow.backToManagerSelect}
        data-testid="privileged-void-pin-modal"
      />
    );
  }

  return (
    <DialogShell onDismiss={flow.close} dismissible={dismissible}>
      {(state.status === 'PRECHECK' || state.status === 'PROJECTING') && (
        <div className="pvm-step">
          <div className="pvm-spinner" role="status" aria-live="polite">
            {state.status === 'PRECHECK' ? 'กำลังตรวจสอบสถานะ...' : 'กำลังส่งคำขอ...'}
          </div>
        </div>
      )}

      {state.status === 'VOID_REASON_ENTRY' && <ReasonStep onSubmit={flow.submitReason} onCancel={flow.close} />}

      {state.status === 'MANAGER_SELECT' && <ManagerSelectStep flow={flow} onCancel={flow.close} />}

      {(() => {
        const copy = copyForFlowState(state);
        if (!copy) return null;
        const canRetry =
          (state.status === 'RECOVERED_ACTIVE' && state.row === null) || state.status === 'LOCAL_UNCERTAIN';
        return (
          <ResultPanel
            title={copy.title}
            body={copy.body}
            tone={copy.tone}
            requesterDisplayName={requesterDisplayName}
            onClose={flow.close}
            onRetryReconciliation={canRetry ? flow.retryReconciliation : undefined}
          />
        );
      })()}
    </DialogShell>
  );
}
