import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from 'react';
import {
  datePresetLabel as defaultDatePresetLabel,
  getDateRange as defaultGetDateRange,
  type DatePreset,
} from '../../lib/salesHistory/types';
import './DateRangeDropdown.css';

export type DateRangeChange<P extends string = DatePreset> = {
  preset: P;
  from: string;
  to: string;
};

/** Default preset shortcuts (sales-history set, includes 'yesterday'). */
const DEFAULT_PRESETS: ReadonlyArray<readonly [DatePreset, string]> = [
  ['today', 'วันนี้'],
  ['yesterday', 'เมื่อวาน'],
  ['7d', '7 วันล่าสุด'],
  ['30d', '30 วันล่าสุด'],
  ['month', 'เดือนนี้'],
];

export type DateRangeDropdownProps<P extends string = DatePreset> = {
  preset: P;
  from: string;
  to: string;
  onChange: (next: DateRangeChange<P>) => void;
  /**
   * Preset shortcuts to display, as [key, label] tuples. Defaults to the
   * sales-history set. Pass a custom list to e.g. omit 'yesterday'.
   */
  presets?: ReadonlyArray<readonly [P, string]>;
  /**
   * Resolves a preset (or custom range) into concrete start/end dates.
   * Defaults to the sales-history getDateRange. Pass a module-specific resolver
   * so the dropdown stays the single source of truth for the parent's from/to.
   */
  resolveRange?: (preset: P, from: string, to: string) => { start: Date; end: Date };
};

/** Format a Date as a local YYYY-MM-DD string (avoids the UTC off-by-one that
 *  Date.toISOString() introduces for users east of UTC, e.g. Asia/Bangkok). */
function toLocalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Present an ISO `YYYY-MM-DD` string as `DD/MM/YYYY` for display. */
function isoToDisplay(iso: string): string {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

/**
 * Date Range Picker: preset shortcuts on top + a custom range at the bottom.
 *
 * Single source of truth: picking a preset immediately resolves the concrete
 * from/to ISO strings and hands them back via onChange, so the parent's from/to
 * never drift out of sync with the selected preset.
 */
export function DateRangeDropdown<P extends string = DatePreset>({
  preset,
  from,
  to,
  onChange,
  presets,
  resolveRange,
}: DateRangeDropdownProps<P>) {
  const [open, setOpen] = useState(false);
  const ddRef = useRef<HTMLDivElement>(null);
  const fromInputRef = useRef<HTMLInputElement>(null);

  const presetList =
    presets ?? (DEFAULT_PRESETS as unknown as ReadonlyArray<readonly [P, string]>);
  const resolve =
    resolveRange ??
    (defaultGetDateRange as unknown as (p: P, f: string, t: string) => { start: Date; end: Date });

  useEffect(() => {
    if (!open) return;
    // Use `mousedown` (fires before the toggle's `click`) so the open/close
    // toggle can't race against this listener. Only active while open.
    const onDocMouseDown = (e: MouseEvent) => {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const isCustom = (preset as string) === 'custom';

  // Auto-focus the "From" input when the menu opens in (or switches to) custom
  // mode, so the user can adjust the range without an extra click.
  useEffect(() => {
    if (open && isCustom) {
      const id = window.setTimeout(() => fromInputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open, isCustom]);

  const presetLabel = presetList.find(([key]) => key === preset)?.[1];
  const label = isCustom
    ? from && to
      ? `${isoToDisplay(from)} – ${isoToDisplay(to)}`
      : 'กำหนดเอง'
    : presetLabel ?? defaultDatePresetLabel(preset as DatePreset);

  const pickPreset = (key: P) => {
    const range = resolve(key, from, to);
    onChange({ preset: key, from: toLocalIso(range.start), to: toLocalIso(range.end) });
    setOpen(false);
  };

  // Force the native calendar to pop on any click over the transparent input
  // (clicking the bare field otherwise only focuses it in some browsers).
  const openNativePicker = (e: ReactMouseEvent<HTMLInputElement>) => {
    try {
      e.currentTarget.showPicker?.();
    } catch {
      /* showPicker can throw (e.g. cross-origin); the native click still works */
    }
  };

  return (
    <div className="drd-wrapper" ref={ddRef}>
      <button type="button" className="drd-toggle-btn" onClick={() => setOpen((v) => !v)}>
        <i className="ti ti-calendar" aria-hidden="true" />
        <span className="drd-toggle-label">{label}</span>
        <i className="ti ti-chevron-down" style={{ fontSize: 10 }} aria-hidden="true" />
      </button>
      {open && (
        <div className="drd-menu">
          {presetList.map(([key, lbl]) => (
            <button
              key={key}
              type="button"
              className={`drd-menu-item${preset === key ? ' on' : ''}`}
              onClick={() => pickPreset(key)}
            >
              {lbl}
            </button>
          ))}
          <div className="drd-custom-label">กำหนดเอง</div>
          <div className="drd-custom">
            {/* Invisible-overlay hack: a visible DD/MM/YYYY layer with the real
                native <input type="date"> stretched transparently on top, so the
                user keeps the OS calendar popup but always SEES DD/MM/YYYY. */}
            <div className="drd-date-field">
              <span className={`drd-date-display${from ? '' : ' is-placeholder'}`}>
                {from ? isoToDisplay(from) : 'DD/MM/YYYY'}
              </span>
              <input
                ref={fromInputRef}
                type="date"
                className="drd-date-native"
                value={from}
                onClick={openNativePicker}
                onChange={(e) => onChange({ preset: 'custom' as P, from: e.target.value, to })}
              />
            </div>
            <div className="drd-date-field">
              <span className={`drd-date-display${to ? '' : ' is-placeholder'}`}>
                {to ? isoToDisplay(to) : 'DD/MM/YYYY'}
              </span>
              <input
                type="date"
                className="drd-date-native"
                value={to}
                onClick={openNativePicker}
                onChange={(e) => onChange({ preset: 'custom' as P, from, to: e.target.value })}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DateRangeDropdown;
