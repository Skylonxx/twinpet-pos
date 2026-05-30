import { useEffect, useRef, useState } from 'react';
import { datePresetLabel, getDateRange, type DatePreset } from '../../lib/salesHistory/types';

export type DateRangeChange = { preset: DatePreset; from: string; to: string };

export type DateRangeDropdownProps = {
  preset: DatePreset;
  from: string;
  to: string;
  onChange: (next: DateRangeChange) => void;
};

/**
 * Date Range Picker mirroring the /sales-history dropdown: preset shortcuts on
 * top + a custom range at the bottom. The parent keeps the resolved from/to ISO
 * strings (which drive the existing filters); selecting a preset resolves the
 * concrete range via the shared getDateRange helper.
 *
 * Relies on the global `sr-date-*` styles (StockReportPage.css), which the
 * consuming page imports.
 */
export function DateRangeDropdown({ preset, from, to, onChange }: DateRangeDropdownProps) {
  const [open, setOpen] = useState(false);
  const ddRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  const label =
    preset === 'custom'
      ? from && to
        ? `${from} – ${to}`
        : 'ทั้งหมด'
      : datePresetLabel(preset);

  const pickPreset = (key: DatePreset) => {
    const range = getDateRange(key, from, to);
    onChange({
      preset: key,
      from: range.start.toISOString().slice(0, 10),
      to: range.end.toISOString().slice(0, 10),
    });
    setOpen(false);
  };

  return (
    <div className="sr-date-dd" ref={ddRef}>
      <button
        type="button"
        className="sr-date-dd-btn"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <i className="ti ti-calendar" aria-hidden="true" />
        <span>{label}</span>
        <i className="ti ti-chevron-down" style={{ fontSize: 10 }} aria-hidden="true" />
      </button>
      {open && (
        <div className="sr-date-dd-menu">
          {(
            [
              ['today', 'วันนี้'],
              ['yesterday', 'เมื่อวาน'],
              ['7d', '7 วันล่าสุด'],
              ['30d', '30 วันล่าสุด'],
              ['month', 'เดือนนี้'],
            ] as const
          ).map(([key, lbl]) => (
            <button
              key={key}
              type="button"
              className={`sr-date-menu-item${preset === key ? ' on' : ''}`}
              onClick={() => pickPreset(key)}
            >
              {lbl}
            </button>
          ))}
          <div className="sr-date-custom-label">กำหนดเอง</div>
          <div className="sr-date-custom">
            <input
              type="date"
              value={from}
              onChange={(e) => onChange({ preset: 'custom', from: e.target.value, to })}
            />
            <input
              type="date"
              value={to}
              onChange={(e) => onChange({ preset: 'custom', from, to: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default DateRangeDropdown;
