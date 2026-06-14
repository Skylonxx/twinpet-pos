import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import './NumpadDialog.css';

const NUMPAD_KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', 'C', '0', '⌫'] as const;
// Phase 7C-D4-D: the decimal layout swaps the Clear key for a decimal point so the bill-discount
// numpad can enter fractional amounts. Backspace (⌫) still covers correction. Same 12-key 3×4
// grid → no CSS / layout change.
const NUMPAD_KEYS_DECIMAL = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫'] as const;
// Phase 7C-D4-D2: the D4-D1 in-grid Clear (13th 'C' key) is removed — it auto-flowed to a 5th
// grid row and read as a layout bug in UAT. Clearing an existing discount is now a separate
// footer ACTION (see `clearLabel`/`onClear`/`showClearAction`), so the keypad stays a clean 3×4.
type NumpadKey = (typeof NUMPAD_KEYS)[number] | (typeof NUMPAD_KEYS_DECIMAL)[number];

type NumpadDialogProps = {
  open: boolean;
  title?: string;
  initialValue: number;
  onClose: () => void;
  onConfirm: (value: number) => void;
  /**
   * Opt-in numeric mode (Phase 7C-D4-D). Defaults preserve the original quantity contract
   * (integer ≥ 1, floored `initialValue`, ≤ 0 rejected with the existing error). The bill-discount
   * numpad opts into `allowDecimal` + `allowZero` so it can enter exactly the values the discount
   * input accepts (0 and decimals, mirroring its `parseFloat(...) || 0`).
   */
  allowDecimal?: boolean;
  allowZero?: boolean;
  /** Max characters the display accepts (default 4 — the quantity contract). */
  maxLength?: number;
  /**
   * Opt-in footer Clear ACTION (Phase 7C-D4-D2, replaces the D4-D1 in-grid Clear key). Renders a
   * labelled button BELOW the keypad (no extra grid row) that calls `onClear`. The bill-discount
   * numpad uses it to wipe an existing discount (`ล้างส่วนลด` → set 0 + close). The caller gates
   * visibility via `showClearAction`, so it never appears for the quantity numpad.
   */
  clearLabel?: string;
  onClear?: () => void;
  showClearAction?: boolean;
};

export default function NumpadDialog({
  open,
  title,
  initialValue,
  onClose,
  onConfirm,
  allowDecimal = false,
  allowZero = false,
  maxLength = 4,
  clearLabel,
  onClear,
  showClearAction = false,
}: NumpadDialogProps) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Free-numeric mode (bill discount): 0 and decimals are valid, mirroring the discount input.
  // Quantity mode (default): integer ≥ 1, exactly as before.
  const freeNumeric = allowDecimal || allowZero;

  useEffect(() => {
    if (!open) return;
    // Quantity mode floors; decimal mode keeps the fractional initial value intact (no truncation).
    const seed = allowDecimal ? Math.max(0, initialValue) : Math.max(0, Math.floor(initialValue));
    setInput(String(seed));
    setError(null);
  }, [open, initialValue, allowDecimal]);

  const handleKey = useCallback(
    (key: NumpadKey) => {
      setError(null);
      if (key === 'C') {
        setInput('');
        return;
      }
      if (key === '⌫') {
        setInput((prev) => prev.slice(0, -1));
        return;
      }
      if (key === '.') {
        // Decimal mode only: at most one point; a leading "." seeds "0.".
        setInput((prev) => {
          if (prev.includes('.')) return prev;
          const next = prev === '' ? '0.' : prev + '.';
          return next.length > maxLength ? prev : next;
        });
        return;
      }
      setInput((prev) => {
        const next = prev === '0' ? key : prev + key;
        if (next.length > maxLength) return prev;
        return next;
      });
    },
    [maxLength],
  );

  const handleConfirm = useCallback(() => {
    if (freeNumeric) {
      // Mirror the discount field's `parseFloat(...) || 0`: 0 and decimals are valid, and an
      // unchanged existing decimal confirms without truncation.
      onConfirm(parseFloat(input) || 0);
      return;
    }
    const parsed = parseInt(input, 10);
    if (!input || Number.isNaN(parsed) || parsed <= 0) {
      setError('กรุณาระบุจำนวนที่มากกว่า 0');
      return;
    }
    onConfirm(parsed);
  }, [input, onConfirm, freeNumeric]);

  if (!open) return null;

  const keys = allowDecimal ? NUMPAD_KEYS_DECIMAL : NUMPAD_KEYS;

  return createPortal(
    <div
      className="npd-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title ?? 'ระบุจำนวน'}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="npd-dialog">
        <div className="npd-hd">
          <h2 className="npd-title">{title ?? 'ระบุจำนวน'}</h2>
          <button type="button" className="npd-close" onClick={onClose} aria-label="ปิด">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        <div className="npd-display" aria-live="polite">
          {input || '0'}
        </div>
        {error && <p className="npd-error">{error}</p>}

        <div className="npd-grid">
          {keys.map((key) => (
            <button
              key={key}
              type="button"
              className={`npd-key${key === 'C' || key === '⌫' ? ' npd-key--action' : ''}`}
              onClick={() => handleKey(key)}
            >
              {key === '⌫' ? <i className="ti ti-backspace" aria-hidden="true" /> : key}
            </button>
          ))}
        </div>

        {showClearAction && onClear && clearLabel && (
          <button type="button" className="npd-clear" onClick={onClear}>
            {clearLabel}
          </button>
        )}

        <button type="button" className="npd-confirm" onClick={handleConfirm}>
          ยืนยัน
        </button>
      </div>
    </div>,
    document.body,
  );
}
