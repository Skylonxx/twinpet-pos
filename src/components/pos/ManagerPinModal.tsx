import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './ManagerPinModal.css';

// UI-11 · Manager Approval Modal Primitive (a.k.a. Manager Action Confirmation Shell).
//
// PRESENTATIONAL ONLY. This shell collects touch-entered digits into a local,
// transient, masked buffer and forwards them to the caller through
// `onSubmitPin(pin)`. It performs NO checking of the entered digits, holds NO
// PIN source, and is NOT a security boundary. It does not approve on its own
// and does not release any protected action — the caller owns all checking and
// all action execution. Digits are entered exclusively via on-screen buttons;
// there is NO editable input element, so touch/iPad hardware never raises the
// OS virtual keyboard.

export type ManagerPinModalProps = {
  open: boolean;
  title?: string;
  description?: string | React.ReactNode;
  /** Passive session context (e.g. current user's name) — display only, never a gate. */
  sessionDisplayName?: string;
  /** UI-input rule only: number of digits before Submit is enabled. */
  pinLength?: number;
  /** UI-input rule only: hard cap on buffer length (defaults to pinLength). */
  maxLength?: number;
  /** Caller-owned pending state: disables the keypad + submit and prevents duplicate submit. */
  isSubmitting?: boolean;
  /** Caller-supplied error copy (e.g. from a caller-owned checker). Rendered as-is. */
  errorMessage?: string | null;
  /** Optional whole-modal gate. */
  disabled?: boolean;
  /** Hands the raw entered digit string to the caller-owned checker. */
  onSubmitPin: (pin: string) => void;
  onCancel: () => void;
  /** Optional observer; default behaviour empties the local buffer. */
  onClear?: () => void;
  /** Optional observer; default behaviour edits the local buffer. */
  onBackspace?: () => void;
  'data-testid'?: string;
};

type KeypadCell =
  | { kind: 'digit'; value: string }
  | { kind: 'clear' }
  | { kind: 'back' };

// Familiar POS phone-PIN layout: 1-2-3 top, with Clear / 0 / Backspace on the
// bottom row. Digits are plain buttons — no editable field.
const KEYPAD: KeypadCell[] = [
  { kind: 'digit', value: '1' },
  { kind: 'digit', value: '2' },
  { kind: 'digit', value: '3' },
  { kind: 'digit', value: '4' },
  { kind: 'digit', value: '5' },
  { kind: 'digit', value: '6' },
  { kind: 'digit', value: '7' },
  { kind: 'digit', value: '8' },
  { kind: 'digit', value: '9' },
  { kind: 'clear' },
  { kind: 'digit', value: '0' },
  { kind: 'back' },
];

export default function ManagerPinModal({
  open,
  title = 'ยืนยันสิทธิ์ผู้จัดการ',
  description = 'กรุณาใส่ PIN ผู้จัดการ',
  sessionDisplayName,
  pinLength = 4,
  maxLength,
  isSubmitting = false,
  errorMessage = null,
  disabled = false,
  onSubmitPin,
  onCancel,
  onClear,
  onBackspace,
  'data-testid': dataTestId,
}: ManagerPinModalProps) {
  // Local, uncontrolled, transient buffer. Never lifted to parent/global state,
  // never persisted, never logged, never sent anywhere except through onSubmitPin.
  const [pin, setPin] = useState('');
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const cap = maxLength ?? pinLength;
  const locked = isSubmitting || disabled;
  const canSubmit = !locked && pin.length >= pinLength;

  // Clear the buffer whenever the modal is closed, so an entered value never
  // outlives the modal instance.
  useEffect(() => {
    if (!open) setPin('');
  }, [open]);

  // On open, move focus to the (non-editable) dialog container — never to an
  // editable field — so no native keyboard is invoked.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => dialogRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const pressDigit = useCallback(
    (value: string) => {
      if (locked) return;
      setPin((prev) => (prev.length >= cap ? prev : prev + value));
    },
    [locked, cap],
  );

  const pressBackspace = useCallback(() => {
    if (locked) return;
    setPin((prev) => prev.slice(0, -1));
    onBackspace?.();
  }, [locked, onBackspace]);

  const pressClear = useCallback(() => {
    if (locked) return;
    setPin('');
    onClear?.();
  }, [locked, onClear]);

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    onSubmitPin(pin);
  }, [canSubmit, onSubmitPin, pin]);

  const handleCancel = useCallback(() => {
    if (isSubmitting) return;
    onCancel();
  }, [isSubmitting, onCancel]);

  if (!open) return null;

  const slotCount = Math.max(pinLength, pin.length);

  return createPortal(
    <div
      className="mpin-overlay"
      data-testid={dataTestId}
      onPointerDown={(e) => {
        // Dismiss on a genuine outside press (pointerdown avoids the touch
        // ghost-click flash-and-close). Blocked while a submit is pending.
        if (e.target === e.currentTarget) handleCancel();
      }}
    >
      <div
        className="mpin-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="mpin-head">
          <h2 className="mpin-title">{title}</h2>
          <button
            type="button"
            className="mpin-close"
            onClick={handleCancel}
            disabled={isSubmitting}
            aria-label="ปิด"
          >
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        {description && <p className="mpin-desc">{description}</p>}

        {sessionDisplayName && (
          <p className="mpin-session">
            <i className="ti ti-user" aria-hidden="true" /> {sessionDisplayName}
          </p>
        )}

        {/* Non-editable masked display: dots only, no text field. */}
        <div className="mpin-display" data-testid="mpin-display" role="status" aria-live="polite">
          {Array.from({ length: slotCount }).map((_, i) => (
            <span
              key={i}
              className={`mpin-dot${i < pin.length ? ' mpin-dot--filled' : ''}`}
              aria-hidden="true"
            />
          ))}
        </div>

        {errorMessage && (
          <p className="mpin-error" role="alert">
            <i className="ti ti-alert-triangle" aria-hidden="true" /> {errorMessage}
          </p>
        )}

        <div className="mpin-keypad">
          {KEYPAD.map((cell) => {
            if (cell.kind === 'digit') {
              return (
                <button
                  key={cell.value}
                  type="button"
                  className="mpin-key"
                  onClick={() => pressDigit(cell.value)}
                  disabled={locked}
                >
                  {cell.value}
                </button>
              );
            }
            if (cell.kind === 'clear') {
              return (
                <button
                  key="clear"
                  type="button"
                  className="mpin-key mpin-key--action"
                  onClick={pressClear}
                  disabled={locked}
                >
                  ล้าง
                </button>
              );
            }
            return (
              <button
                key="back"
                type="button"
                className="mpin-key mpin-key--action"
                onClick={pressBackspace}
                disabled={locked}
                aria-label="ลบ"
              >
                <i className="ti ti-backspace" aria-hidden="true" />
              </button>
            );
          })}
        </div>

        <div className="mpin-footer">
          <button
            type="button"
            className="mpin-btn mpin-btn--cancel"
            onClick={handleCancel}
            disabled={isSubmitting}
          >
            ยกเลิก
          </button>
          <button
            type="button"
            className="mpin-btn mpin-btn--submit"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {isSubmitting ? 'กำลังส่งข้อมูล...' : 'ยืนยัน'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
