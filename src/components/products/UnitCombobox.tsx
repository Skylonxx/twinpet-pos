import { useMemo, useState, type RefObject } from 'react';
import { Dropdown, DropdownHeader, DropdownItem, TextInput } from '../ui';

type Props = {
  /** Selectable unit names (already includes any legacy/current value via buildUnitSelectOptions). */
  options: string[];
  /** Currently bound unit name ('' when nothing selected). */
  value: string;
  onChange: (unit: string) => void;
  /** Shown on the trigger when nothing is selected. */
  placeholder?: string;
  invalid?: boolean;
  /** Focus target for the form's focus-first-invalid-field logic (the search box). */
  inputRef?: RefObject<HTMLInputElement | null>;
};

/**
 * Searchable unit-of-measure dropdown (combobox) — the same flowbite-react
 * composition as CategoryCombobox (a <Dropdown> whose header hosts a <TextInput>
 * search box, list rendered as filtered <DropdownItem>s) but for plain unit-name
 * strings. Used for the Base UOM and Sub-UOM pickers in ProductDrawer so admins
 * can type-to-filter instead of scrolling a native <select>.
 */
export default function UnitCombobox({
  options,
  value,
  onChange,
  placeholder = 'ค้นหา / เลือกหน่วย',
  invalid,
  inputRef,
}: Props) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((u) => u.toLowerCase().includes(q));
  }, [options, query]);

  const select = (unit: string) => {
    onChange(unit);
    setQuery('');
  };

  return (
    <Dropdown
      enableTypeAhead={false}
      renderTrigger={() => (
        <button
          type="button"
          aria-invalid={invalid || undefined}
          className={`flex w-full items-center justify-between gap-2 rounded-md border-[0.5px] bg-white px-2.5 py-1.5 text-left text-xs ${
            invalid ? 'border-[var(--danger)] bg-[var(--danger-bg)]' : 'border-[var(--g200)]'
          }`}
        >
          <span className={`truncate ${value ? 'text-[var(--p900)]' : 'text-[#888780]'}`}>
            {value || placeholder}
          </span>
          <i className="ti ti-chevron-down shrink-0 text-sm text-[#888780]" aria-hidden="true" />
        </button>
      )}
    >
      <DropdownHeader className="p-2">
        <TextInput
          ref={inputRef}
          sizing="sm"
          placeholder="ค้นหาหน่วย..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
      </DropdownHeader>
      {filtered.length === 0 ? (
        <div className="px-3 py-2.5 text-center text-[11px] text-[#888780]">
          ไม่พบหน่วย{query.trim() ? ` "${query.trim()}"` : ''}
        </div>
      ) : (
        filtered.map((unit) => (
          <DropdownItem key={unit} onClick={() => select(unit)} className="justify-between gap-2">
            <span className="truncate text-xs text-[var(--p900)]">{unit}</span>
            {unit === value ? (
              <i className="ti ti-check shrink-0 text-sm text-[var(--p600)]" aria-hidden="true" />
            ) : null}
          </DropdownItem>
        ))
      )}
    </Dropdown>
  );
}
