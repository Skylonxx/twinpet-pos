import { useMemo, useState, type RefObject } from 'react';
import { Dropdown, DropdownHeader, DropdownItem, TextInput } from '../ui';
import type { ProductCategory } from '../../lib/types';

type Props = {
  categories: ProductCategory[];
  /** Currently bound category id ('' when the stored value is a legacy/orphan name). */
  categoryId: string;
  /** Stored category name string — may be a legacy value not present in `categories`. */
  category: string;
  invalid?: boolean;
  /** Focus target used by the form's focus-first-invalid-field logic (the search box). */
  inputRef?: RefObject<HTMLInputElement | null>;
  onChange: (next: { categoryId: string; category: string }) => void;
  /** Opens the existing Category Management modal (gear button). */
  onManage: () => void;
};

/**
 * Searchable category dropdown (combobox) built on flowbite-react composition:
 * a <Dropdown> whose header hosts a <TextInput> search box, with the category
 * list rendered as filtered <DropdownItem>s (typeahead). Legacy/orphaned values
 * (a stored name with no match in the master list) display as "<name> (legacy)".
 */
export default function CategoryCombobox({
  categories,
  categoryId,
  category,
  invalid,
  inputRef,
  onChange,
  onManage,
}: Props) {
  const [query, setQuery] = useState('');

  // Resolve the current selection by id first, then by name (mirrors the old
  // <select> value fallback). Legacy = a stored name that matches neither.
  const selectedCat = useMemo(
    () =>
      categories.find((c) => c.id === categoryId) ??
      (category ? categories.find((c) => c.name === category) : undefined) ??
      null,
    [categories, categoryId, category],
  );
  const isLegacy = !selectedCat && !!category;
  const displayLabel = selectedCat ? selectedCat.name : isLegacy ? `${category} (legacy)` : '';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => c.name.toLowerCase().includes(q));
  }, [categories, query]);

  const select = (cat: ProductCategory) => {
    onChange({ categoryId: cat.id, category: cat.name });
    setQuery('');
  };

  return (
    <div className="flex items-stretch gap-1.5">
      <div className="min-w-0 flex-1">
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
              <span className={`truncate ${displayLabel ? 'text-[var(--p900)]' : 'text-[#888780]'}`}>
                {displayLabel || 'ค้นหา / เลือกหมวดหมู่'}
              </span>
              <i className="ti ti-chevron-down shrink-0 text-sm text-[#888780]" aria-hidden="true" />
            </button>
          )}
        >
          <DropdownHeader className="p-2">
            <TextInput
              ref={inputRef}
              sizing="sm"
              placeholder="ค้นหาหมวดหมู่..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
          </DropdownHeader>
          {filtered.length === 0 ? (
            <div className="px-3 py-2.5 text-center text-[11px] text-[#888780]">
              ไม่พบหมวดหมู่{query.trim() ? ` "${query.trim()}"` : ''}
            </div>
          ) : (
            filtered.map((cat) => (
              <DropdownItem
                key={cat.id}
                onClick={() => select(cat)}
                className="justify-between gap-2"
              >
                <span className="truncate text-xs text-[var(--p900)]">{cat.name}</span>
                <code className="shrink-0 rounded bg-[var(--g50)] px-1.5 py-px text-[10px] text-[#888780]">
                  {cat.id}
                </code>
              </DropdownItem>
            ))
          )}
        </Dropdown>
      </div>
      <button
        type="button"
        title="จัดการหมวดหมู่"
        aria-label="จัดการหมวดหมู่"
        onClick={onManage}
        className="flex w-8 shrink-0 items-center justify-center rounded-md border-[0.5px] border-[var(--g200)] bg-[var(--g50)] text-[15px] text-[var(--p600)] hover:border-[var(--p400)] hover:bg-[var(--p50)]"
      >
        <i className="ti ti-settings" aria-hidden="true" />
      </button>
    </div>
  );
}
