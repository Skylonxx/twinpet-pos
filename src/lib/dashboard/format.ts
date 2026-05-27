export type FmtBahtOptions = {
  /** Decimal places — dashboard KPI cards use 0; detail views may use 2 */
  decimals?: number;
};

/**
 * Format Thai Baht with ฿ prefix and locale grouping.
 * Defaults to whole-baht (0 decimals) matching dashboard card design.
 */
export function fmtBaht(n: number, options: FmtBahtOptions = {}): string {
  const decimals = options.decimals ?? 0;
  return `฿${n.toLocaleString('th-TH', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function fmtNumber(n: number): string {
  return n.toLocaleString('th-TH');
}

export function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '0.0%';
  return `${n.toFixed(1)}%`;
}

export function truncate(text: string, maxLen: number): string {
  if (maxLen <= 0) return '';
  if (text.length <= maxLen) return text;
  if (maxLen === 1) return '…';
  return `${text.slice(0, maxLen - 1)}…`;
}
