import type { StockLot } from '../types';
import { normalizeStockLot } from './stockLotQueries';

export function stockLotTimestampToDate(value: unknown): Date | null {
  if (value == null) return null;
  if (
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  if (
    typeof value === 'object' &&
    'seconds' in value &&
    typeof (value as { seconds: unknown }).seconds === 'number'
  ) {
    return new Date((value as { seconds: number }).seconds * 1000);
  }
  if (value instanceof Date) return value;
  return null;
}

/** Format lot dates as DD/MM/YY (Thai locale). */
export function formatFifoLotDate(value: unknown): string {
  const d = stockLotTimestampToDate(value);
  if (!d || d.getTime() === 0) return '—';
  return d.toLocaleDateString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
}

export function formatFifoLotExpiry(value: unknown): string {
  if (value == null) return 'ไม่มี';
  const formatted = formatFifoLotDate(value);
  return formatted === '—' ? 'ไม่มี' : formatted;
}

export function getActiveFifoLots(lots: StockLot[]): StockLot[] {
  return lots
    .map((lot) => normalizeStockLot(lot.id, lot as unknown as Record<string, unknown>))
    .filter((lot) => lot.qtyRemaining > 0 && !lot.isDepleted)
    .sort((a, b) => {
      const aMs = stockLotTimestampToDate(a.receivedAt)?.getTime() ?? 0;
      const bMs = stockLotTimestampToDate(b.receivedAt)?.getTime() ?? 0;
      return aMs - bMs;
    });
}
