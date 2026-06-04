import { Badge } from '../ui';
import type { StockStatus } from '../../lib/stockReport/types';

/** Stock status → flowbite Badge color + Thai label. */
const STATUS: Record<StockStatus, { color: string; label: string }> = {
  ok: { color: 'success', label: 'ปกติ' },
  low: { color: 'warning', label: 'ต่ำ' },
  critical: { color: 'failure', label: 'วิกฤต' },
  oos: { color: 'gray', label: 'หมด' },
};

export function StatusBadge({ status }: { status: StockStatus }) {
  const { color, label } = STATUS[status];
  return (
    <Badge color={color} className="w-fit">
      {label}
    </Badge>
  );
}

export default StatusBadge;
