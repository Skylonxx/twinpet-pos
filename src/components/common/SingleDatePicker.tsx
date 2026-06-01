import { type MouseEvent as ReactMouseEvent } from 'react';
import './SingleDatePicker.css';

export type SingleDatePickerProps = {
  value: string;
  onChange: (iso: string) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
};

function isoToDisplay(iso: string): string {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

/**
 * Single-date field using the invisible-overlay hack: a DD/MM/YYYY display
 * layer with a transparent native <input type="date"> on top, so the user
 * always sees the Thai date format but gets the OS calendar popup.
 */
export function SingleDatePicker({
  value,
  onChange,
  placeholder = 'DD/MM/YYYY',
  disabled = false,
  id,
}: SingleDatePickerProps) {
  const openNativePicker = (e: ReactMouseEvent<HTMLInputElement>) => {
    if (disabled) return;
    try {
      e.currentTarget.showPicker?.();
    } catch {
      /* showPicker can throw in some environments; the native click still works */
    }
  };

  return (
    <div className={`sdp-field${disabled ? ' sdp-disabled' : ''}`}>
      <span className={`sdp-display${value ? '' : ' sdp-placeholder'}`}>
        {value ? isoToDisplay(value) : placeholder}
      </span>
      <input
        id={id}
        type="date"
        className="sdp-native"
        value={value}
        disabled={disabled}
        onClick={openNativePicker}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export default SingleDatePicker;
