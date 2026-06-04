import { type MouseEvent as ReactMouseEvent } from 'react';

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
 *
 * Styling is Tailwind utilities (migrated off SingleDatePicker.css). Behaviour,
 * the native OS popup, and the Thai DD/MM display are unchanged.
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
    <div
      className={`relative block w-full box-border rounded-md border-[0.5px] border-[var(--g200)] focus-within:border-[var(--p400)] ${
        disabled ? 'cursor-not-allowed bg-[var(--g50)]' : 'cursor-pointer bg-white'
      }`}
    >
      <span
        className={`pointer-events-none block select-none overflow-hidden text-ellipsis whitespace-nowrap px-2.5 py-[7px] text-xs leading-normal ${
          value && !disabled ? 'text-[var(--p900)]' : 'text-[#888780]'
        }`}
      >
        {value ? isoToDisplay(value) : placeholder}
      </span>
      <input
        id={id}
        type="date"
        className={`absolute inset-0 m-0 h-full w-full border-0 bg-transparent p-0 text-transparent opacity-0 ${
          disabled ? 'pointer-events-none cursor-not-allowed' : 'cursor-pointer'
        }`}
        value={value}
        disabled={disabled}
        onClick={openNativePicker}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export default SingleDatePicker;
