import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ProductCategory } from '../../lib/types';

type Props = {
  categories: ProductCategory[];
  /** Currently bound category id ('' when the stored value is a legacy/orphan name). */
  categoryId: string;
  /** Stored category name string — may be a legacy value not present in `categories`. */
  category: string;
  invalid?: boolean;
  /** Focus target used by the form's focus-first-invalid-field logic. */
  inputRef?: RefObject<HTMLInputElement | null>;
  onChange: (next: { categoryId: string; category: string }) => void;
  /** Opens the existing Category Management modal (gear button). */
  onManage: () => void;
};

/**
 * Searchable category dropdown (combobox) — replaces a plain <select>.
 *
 * Type to filter the real categories; pick one to bind both `categoryId` and the
 * canonical `category` name. Legacy/orphaned values (a stored name with no match
 * in the master list) stay graceful: the closed input shows "<name> (legacy)",
 * but opening the menu searches only the real, managed categories so the user can
 * re-bind. A gear button next to the input opens the Category Management UI.
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

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

  // Close + reset the search text on any outside click.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const openMenu = () => {
    if (open) return;
    setQuery('');
    const idx = categories.findIndex((c) => c.id === (selectedCat?.id ?? categoryId));
    setHighlight(idx >= 0 ? idx : 0);
    setOpen(true);
  };

  const select = (cat: ProductCategory) => {
    onChange({ categoryId: cat.id, category: cat.name });
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) return openMenu();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && filtered[highlight]) {
        e.preventDefault(); // don't submit the product form
        select(filtered[highlight]!);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setQuery('');
      }
    }
  };

  return (
    <div className="pc-combo" ref={rootRef}>
      <div className="pc-combo-row">
        <div className="pc-combo-control">
          <input
            ref={inputRef}
            type="text"
            className="pc-combo-input"
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-invalid={invalid || undefined}
            placeholder={displayLabel || 'ค้นหา / เลือกหมวดหมู่'}
            value={open ? query : displayLabel}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
              if (!open) setOpen(true);
            }}
            onFocus={openMenu}
            onClick={openMenu}
            onKeyDown={onKeyDown}
            onBlur={(e) => {
              // Tab-away (not an option mousedown, which keeps focus) closes it.
              if (!rootRef.current?.contains(e.relatedTarget as Node)) {
                setOpen(false);
                setQuery('');
              }
            }}
          />
          <i className="ti ti-chevron-down pc-combo-caret" aria-hidden="true" />
          {open ? (
            <div className="pc-combo-menu" role="listbox">
              {filtered.length === 0 ? (
                <div className="pc-combo-empty">ไม่พบหมวดหมู่{query.trim() ? ` "${query.trim()}"` : ''}</div>
              ) : (
                filtered.map((cat, i) => (
                  <div
                    key={cat.id}
                    role="option"
                    aria-selected={cat.id === selectedCat?.id}
                    className={[
                      'pc-combo-option',
                      i === highlight ? 'active' : '',
                      cat.id === selectedCat?.id ? 'selected' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onMouseDown={(e) => {
                      e.preventDefault(); // keep input focus; avoids blur-before-click
                      select(cat);
                    }}
                    onMouseEnter={() => setHighlight(i)}
                  >
                    <span className="pc-combo-option-name">{cat.name}</span>
                    <code className="pc-combo-option-id">{cat.id}</code>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="pc-combo-gear"
          title="จัดการหมวดหมู่"
          aria-label="จัดการหมวดหมู่"
          onClick={() => {
            setOpen(false);
            onManage();
          }}
        >
          <i className="ti ti-settings" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
