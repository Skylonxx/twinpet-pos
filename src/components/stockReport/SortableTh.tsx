import { TableHeadCell } from '../ui';
import type { SortDirection } from '../../lib/stockReport/sorting';

/**
 * Sortable column header using flowbite-react's <TableHeadCell>.
 *
 * MUST be rendered inside a flowbite <Table>/<TableHead> (provides TableContext +
 * TableHeadContext). Used only by the Stock Report tabs, which are full Flowbite
 * tables as of Batch 3a — rendering this outside that context throws
 * "useTableContext should be used within the TableContext provider!".
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
    <TableHeadCell
      className={`cursor-pointer select-none whitespace-nowrap transition-colors hover:text-[var(--p600)]${
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
    </TableHeadCell>
  );
}

export default SortableTh;
