import type { SortDirection } from '../../lib/stockReport/sorting';

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
      className={`sr-sort-th${className ? ` ${className}` : ''}${active ? ' sr-sort-active' : ''}`}
      onClick={() => onSort(sortKey)}
      onKeyDown={(e) => e.key === 'Enter' && onSort(sortKey)}
      role="button"
      tabIndex={0}
    >
      {label}
      <i className={`ti ${icon} sr-sort-icon`} aria-hidden="true" />
    </th>
  );
}

export default SortableTh;
