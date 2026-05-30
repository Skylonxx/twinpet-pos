/**
 * Centralized money helpers — standard ERP satang (2-decimal) rounding.
 *
 * Every monetary amount in TwinPet is Thai Baht (฿). Because raw JavaScript
 * arithmetic uses IEEE-754 floating point, any computed money value MUST be
 * passed through {@link roundMoney} before it is compared, summed across many
 * lines, or persisted to Firestore. Otherwise artifacts such as
 * `0.1 + 0.2 === 0.30000000000000004` leak into stored totals and break
 * equality checks (e.g. paid-vs-grand-total) and change calculations.
 */

/**
 * Round a Baht amount to 2 decimal places (satang).
 * Non-finite input (NaN/Infinity) collapses to 0 so bad math never persists.
 */
export function roundMoney(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

/**
 * Format a Baht amount as a Thai-locale string with exactly 2 decimals.
 * Replaces the legacy `parseFloat(String(n || 0))` pattern.
 */
export function formatMoney(amount: number): string {
  return roundMoney(amount).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
