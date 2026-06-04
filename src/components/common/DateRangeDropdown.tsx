import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from 'react';
import {
  datePresetLabel as defaultDatePresetLabel,
  getDateRange as defaultGetDateRange,
  type DatePreset,
} from '../../lib/salesHistory/types';

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
    <div className="relative inline-flex shrink-0" ref={ddRef}>
      <button
        type="button"
        className="flex w-[232px] cursor-pointer items-center justify-between gap-1.5 rounded-md border border-[var(--border-md)] bg-white px-3 py-[7px] text-[13px] text-[var(--text-primary)] hover:border-[var(--p100)] hover:text-[var(--p600)]"
        onClick={() => setOpen((v) => !v)}
      >
        <i className="ti ti-calendar" aria-hidden="true" />
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
          {label}
        </span>
        <i className="ti ti-chevron-down" style={{ fontSize: 10 }} aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-[100] mt-1.5 min-w-[260px] overflow-hidden rounded-md border border-[var(--border)] bg-white p-1 shadow-[0_8px_24px_rgba(0,0,0,0.1)]">
          {presetList.map(([key, lbl]) => (
            <button
              key={key}
              type="button"
              className={`block w-full cursor-pointer rounded-md px-3.5 py-2 text-left text-[13px] hover:bg-[#f4f3fe] ${
                preset === key
                  ? 'bg-[var(--p50)] font-semibold text-[var(--p600)]'
                  : 'text-[var(--text-primary)]'
              }`}
              onClick={() => pickPreset(key)}
            >
              {lbl}
            </button>
          ))}
          <div className="px-3.5 pb-1 pt-2 text-[11px] font-semibold text-[var(--text-muted)]">
            กำหนดเอง
          </div>
          <div className="flex gap-1.5 px-2.5 pb-2">
            {/* Invisible-overlay hack: a visible DD/MM/YYYY layer with the real
                native <input type="date"> stretched transparently on top, so the
                user keeps the OS calendar popup but always SEES DD/MM/YYYY. */}
            <div className="relative min-w-0 flex-1">
              <span
                className={`block overflow-hidden text-ellipsis whitespace-nowrap rounded-md border border-[var(--border-md)] bg-white px-2 py-1.5 text-xs ${
                  from ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
                }`}
              >
                {from ? isoToDisplay(from) : 'DD/MM/YYYY'}
              </span>
              <input
                ref={fromInputRef}
                type="date"
                className="absolute left-0 top-0 m-0 h-full w-full cursor-pointer border-0 p-0 opacity-0"
                value={from}
                onClick={openNativePicker}
                onChange={(e) => onChange({ preset: 'custom' as P, from: e.target.value, to })}
              />
            </div>
            <div className="relative min-w-0 flex-1">
              <span
                className={`block overflow-hidden text-ellipsis whitespace-nowrap rounded-md border border-[var(--border-md)] bg-white px-2 py-1.5 text-xs ${
                  to ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
                }`}
              >
                {to ? isoToDisplay(to) : 'DD/MM/YYYY'}
              </span>
              <input
                type="date"
                className="absolute left-0 top-0 m-0 h-full w-full cursor-pointer border-0 p-0 opacity-0"
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
