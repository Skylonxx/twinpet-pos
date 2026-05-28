import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import './NumpadDialog.css';

const NUMPAD_KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', 'C', '0', '⌫'] as const;
type NumpadKey = (typeof NUMPAD_KEYS)[number];

type NumpadDialogProps = {
  open: boolean;
  title?: string;
  initialValue: number;
  onClose: () => void;
  onConfirm: (value: number) => void;
};

export default function NumpadDialog({
  open,
  title,
  initialValue,
  onClose,
  onConfirm,
}: NumpadDialogProps) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setInput(String(Math.max(0, Math.floor(initialValue))));
    setError(null);
  }, [open, initialValue]);

  const handleKey = useCallback((key: NumpadKey) => {
    setError(null);
    if (key === 'C') {
      setInput('');
      return;
    }
    if (key === '⌫') {
      setInput((prev) => prev.slice(0, -1));
      return;
    }
    setInput((prev) => {
      const next = prev === '0' ? key : prev + key;
      if (next.length > 4) return prev;
      return next;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    const parsed = parseInt(input, 10);
    if (!input || Number.isNaN(parsed) || parsed <= 0) {
      setError('กรุณาระบุจำนวนที่มากกว่า 0');
      return;
    }
    onConfirm(parsed);
  }, [input, onConfirm]);

  if (!open) return null;

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
          {NUMPAD_KEYS.map((key) => (
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

        <button type="button" className="npd-confirm" onClick={handleConfirm}>
          ยืนยัน
        </button>
      </div>
    </div>,
    document.body,
  );
}
