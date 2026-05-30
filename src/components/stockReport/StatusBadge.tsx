import type { StockStatus } from '../../lib/stockReport/types';

export function StatusBadge({ status }: { status: StockStatus }) {
  const map = {
    ok: ['sr-badge-ok', 'ปกติ'],
    low: ['sr-badge-low', 'ต่ำ'],
    critical: ['sr-badge-critical', 'วิกฤต'],
    oos: ['sr-badge-oos', 'หมด'],
  } as const;
  const [cls, label] = map[status];
  return <span className={`sr-badge ${cls}`}>{label}</span>;
}

export default StatusBadge;
