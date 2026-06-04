import type { SortDirection } from '../../lib/stockReport/sorting';

/**
 * Sortable column header — a native <th> styled with Tailwind utilities.
 *
 * NOTE: intentionally NOT flowbite-react's <TableHeadCell>. That component calls
 * useTableContext()/useTableHeadContext() and throws ("useTableContext should be
 * used within the TableContext provider!") unless rendered inside a Flowbite
 * <Table>/<TableHead>. These headers live in native <table>s, so a plain <th>
 * is correct here until the dedicated "Native Table → Flowbite Table" batch.
 */
export function SortableTh({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  className,
}: {
  label: string;
  sortKey: string;
  activeKey: string;
  direction: SortDirection;
  onSort: (key: string) => void;
  className?: string;
}) {
  const active = activeKey === sortKey;
  const icon = !active ? 'ti-arrows-sort' : direction === 'asc' ? 'ti-arrow-up' : 'ti-arrow-down';
  return (
    <th
      className={`cursor-pointer select-none transition-colors hover:text-[var(--p600)]${
        active ? ' text-[var(--p600)]' : ''
      }${className ? ` ${className}` : ''}`}
      onClick={() => onSort(sortKey)}
      onKeyDown={(e) => e.key === 'Enter' && onSort(sortKey)}
      role="button"
      tabIndex={0}
    >
      {label}
      <i
        className={`ti ${icon} ml-1 align-[-1px] text-[11px] ${active ? 'opacity-100' : 'opacity-65'}`}
        aria-hidden="true"
      />
    </th>
  );
}

export default SortableTh;
