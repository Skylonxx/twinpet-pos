import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import './DestructiveConfirmModal.css';
import { canConfirmDestructiveAction, handlePreventEnter } from './destructiveConfirmLogic';

export type DestructiveConfirmModalProps = {
  open: boolean;
  title: string;
  description: string | React.ReactNode;
  documentSummary?: string | React.ReactNode;
  destructiveLabel?: string;
  cancelLabel?: string;
  reasonRequired?: boolean;
  reasonOptions?: string[];
  requiresPin?: boolean;
  pinLength?: number;
  loading?: boolean;
  error?: string;
  offlineNotice?: string;
  onConfirm: (payload: { reason?: string; note?: string; pin?: string }) => void | Promise<void>;
  onCancel: () => void;
};

export default function DestructiveConfirmModal({
  open,
  title,
  description,
  documentSummary,
  destructiveLabel = 'ยืนยัน',
  cancelLabel = 'ย้อนกลับ',
  reasonRequired = false,
  reasonOptions = [],
  requiresPin = false,
  pinLength = 4,
  loading = false,
  error,
  offlineNotice,
  onConfirm,
  onCancel,
}: DestructiveConfirmModalProps) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');

  // Clear state when modal opens or closes
  useEffect(() => {
    if (!open) {
      setReason('');
      setNote('');
      setPin('');
    }
  }, [open]);

  if (!open) return null;

  const canConfirm = canConfirmDestructiveAction({
    open,
    loading,
    reasonRequired,
    reason,
    requiresPin,
    pin,
    pinLength,
  });

  const handleConfirmClick = () => {
    if (canConfirm) {
      onConfirm({
        reason: reason.trim() || undefined,
        note: note.trim() || undefined,
        pin: requiresPin ? pin : undefined,
      });
    }
  };

  const handleOverlayClick = () => {
    if (!loading) {
      onCancel();
    }
  };

  return createPortal(
    <div
      className="dc-modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={handleOverlayClick}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !loading) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="dc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dc-modal-head">
          <span className="dc-modal-head-title">{title}</span>
          <span className="dc-modal-head-spacer" />
          <button
            type="button"
            className="dc-modal-close"
            onClick={onCancel}
            disabled={loading}
            aria-label="ปิด"
          >
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <div className="dc-modal-body">
          {documentSummary && (
            <div className="dc-meta-row">
              {documentSummary}
            </div>
          )}

          <div className="dc-warn-box">
            <i className="ti ti-alert-triangle dc-icon-space" aria-hidden="true" />
            {description}
          </div>

          {offlineNotice && (
            <div className="dc-offline-notice">
              <i className="ti ti-wifi-off dc-icon-space" aria-hidden="true" />
              {offlineNotice}
            </div>
          )}

          {error && (
            <div className="dc-error-box">
              <i className="ti ti-alert-circle" aria-hidden="true" />
              {error}
            </div>
          )}

          {reasonOptions.length > 0 ? (
            <div className="dc-field">
              <label htmlFor="dc-reason">
                เหตุผล {reasonRequired && '*'}
              </label>
              <select
                id="dc-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={loading}
                onKeyDown={handlePreventEnter}
              >
                <option value="">เลือกเหตุผล...</option>
                {reasonOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="dc-field">
              <label htmlFor="dc-reason">
                เหตุผล {reasonRequired && '*'}
              </label>
              <textarea
                id="dc-reason"
                rows={2}
                placeholder="ระบุเหตุผล..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={loading}
                onKeyDown={handlePreventEnter}
              />
            </div>
          )}

          <div className="dc-field">
            <label htmlFor="dc-note">หมายเหตุ (ถ้ามี)</label>
            <input
              id="dc-note"
              type="text"
              placeholder="หมายเหตุเพิ่มเติม..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={loading}
              onKeyDown={handlePreventEnter}
            />
          </div>

          {requiresPin && (
            <div className="dc-field dc-pin-field">
              <label htmlFor="dc-pin-input" className="dc-pin-label">
                รหัสผ่าน (PIN) {pinLength} หลัก *
              </label>
              <div className="dc-pin-wrapper">
                <input
                  id="dc-pin-input"
                  className="dc-pin-hidden-input"
                  type="password"
                  inputMode="numeric"
                  maxLength={pinLength}
                  value={pin}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, '');
                    setPin(val);
                  }}
                  disabled={loading}
                  onKeyDown={handlePreventEnter}
                  autoComplete="off"
                />
                <div className="dc-pin-input-container">
                  {Array.from({ length: pinLength }).map((_, i) => (
                    <div key={i} className={`dc-pin-char ${pin.length > i ? 'filled' : ''}`}>
                      {pin.length > i ? '•' : ''}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="dc-modal-footer">
          <button type="button" className="dc-btn dc-btn-ghost" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </button>
          <span className="dc-spacer" />
          <button
            type="button"
            className="dc-btn dc-btn-danger"
            onClick={handleConfirmClick}
            disabled={!canConfirm}
          >
            {loading ? (
              <>
                <i className="ti ti-loader dc-spin" aria-hidden="true" /> กำลังดำเนินการ...
              </>
            ) : (
              <>
                <i className="ti ti-ban" aria-hidden="true" /> {destructiveLabel}
              </>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
