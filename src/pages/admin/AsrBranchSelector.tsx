import { useState } from 'react';

export type AsrBranchOption = { id: string; label: string };

/**
 * Sleek branch picker styled to mirror the single-branch report's
 * `📍 สาขา: …` pill — replaces the plain HTML <select> in the Admin stock
 * report bar. The "ALL" (รวมทุกสาขา) option is rendered with a distinct icon.
 */
export default function AsrBranchSelector({
  value,
  options,
  onChange,
}: {
  value: string;
  options: AsrBranchOption[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.id === value);
  const isAll = value === 'ALL';

  return (
    <div className="asr-bsel">
      <button
        type="button"
        className={`asr-bsel-btn${isAll ? ' asr-bsel-all' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <i
          className={`ti ${isAll ? 'ti-building-community' : 'ti-map-pin'}`}
          aria-hidden="true"
          style={{ fontSize: 14 }}
        />
        <span className="asr-bsel-label">สาขา: {current?.label ?? '—'}</span>
        <i
          className={`ti ti-chevron-down asr-bsel-caret${open ? ' open' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <>
          <div
            className="asr-bsel-overlay"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="asr-bsel-menu" role="listbox">
            {options.map((o) => {
              const active = o.id === value;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`asr-bsel-opt${active ? ' active' : ''}`}
                  onClick={() => {
                    onChange(o.id);
                    setOpen(false);
                  }}
                >
                  <i
                    className={`ti ${o.id === 'ALL' ? 'ti-building-community' : 'ti-map-pin'}`}
                    aria-hidden="true"
                  />
                  <span className="asr-bsel-opt-label">{o.label}</span>
                  {active ? (
                    <i className="ti ti-check asr-bsel-check" aria-hidden="true" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
