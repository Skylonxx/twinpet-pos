import { stockLotTimestampToDate } from './fifoQueueUtils';

export type ExpiryPolicy = {
  id: string;
  name: string;
  /** Alert when days until expiry <= this (yellow) */
  warningDays: number;
  /** Alert when days until expiry <= this (red) */
  criticalDays: number;
  isDefault?: boolean;
};

export type ExpiryAlertLevel = 'safe' | 'warning' | 'critical';

export const DEFAULT_EXPIRY_POLICIES: ExpiryPolicy[] = [
  { id: 'default', name: 'มาตรฐาน', warningDays: 30, criticalDays: 7, isDefault: true },
  { id: 'short', name: 'อายุสั้น (อาหารสด)', warningDays: 14, criticalDays: 3 },
  { id: 'long', name: 'อายุยาว (อุปกรณ์)', warningDays: 90, criticalDays: 30 },
];

export type ExpiryAlertResult = {
  level: ExpiryAlertLevel;
  daysLeft: number | null;
};

export function resolveExpiryPolicy(
  policyId: string | null | undefined,
  policies: ExpiryPolicy[],
): ExpiryPolicy {
  const list =
    Array.isArray(policies) && policies.length > 0 ? policies : DEFAULT_EXPIRY_POLICIES;
  if (policyId) {
    const found = list.find((p) => p.id === policyId);
    if (found) return found;
  }
  return list.find((p) => p.isDefault) ?? list[0] ?? DEFAULT_EXPIRY_POLICIES[0]!;
}

export function computeExpiryAlert(
  expiryValue: unknown,
  policy: ExpiryPolicy | null | undefined,
  today = new Date(),
): ExpiryAlertResult {
  const fallback = DEFAULT_EXPIRY_POLICIES[0]!;
  const p = policy ?? fallback;
  const warningDays = Number.isFinite(p.warningDays) ? Math.max(0, p.warningDays) : fallback.warningDays;
  const criticalDays = Number.isFinite(p.criticalDays) ? Math.max(0, p.criticalDays) : fallback.criticalDays;

  try {
    const expiry = stockLotTimestampToDate(expiryValue);
    if (!expiry || !Number.isFinite(expiry.getTime()) || expiry.getTime() === 0) {
      return { level: 'safe', daysLeft: null };
    }

    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startOfExpiry = new Date(expiry.getFullYear(), expiry.getMonth(), expiry.getDate());
    if (!Number.isFinite(startOfExpiry.getTime())) {
      return { level: 'safe', daysLeft: null };
    }

    const msPerDay = 86400000;
    const daysLeft = Math.round((startOfExpiry.getTime() - startOfToday.getTime()) / msPerDay);
    if (!Number.isFinite(daysLeft)) {
      return { level: 'safe', daysLeft: null };
    }

    if (daysLeft <= criticalDays) {
      return { level: 'critical', daysLeft };
    }
    if (daysLeft <= warningDays) {
      return { level: 'warning', daysLeft };
    }
    return { level: 'safe', daysLeft };
  } catch {
    return { level: 'safe', daysLeft: null };
  }
}

export const EXPIRY_ALERT_LABELS: Record<ExpiryAlertLevel, string> = {
  safe: 'ปลอดภัย',
  warning: 'เฝ้าระวัง',
  critical: 'วิกฤต',
};

export function normalizeExpiryPolicies(raw: unknown): ExpiryPolicy[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...DEFAULT_EXPIRY_POLICIES];

  const parsed: ExpiryPolicy[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? '').trim();
    const name = String(row.name ?? '').trim();
    const warningDays = Number(row.warningDays);
    const criticalDays = Number(row.criticalDays);
    if (!id || !name) continue;
    if (!Number.isFinite(warningDays) || !Number.isFinite(criticalDays)) continue;
    parsed.push({
      id,
      name,
      warningDays: Math.max(0, Math.round(warningDays)),
      criticalDays: Math.max(0, Math.round(criticalDays)),
      isDefault: row.isDefault === true,
    });
  }

  if (parsed.length === 0) return [...DEFAULT_EXPIRY_POLICIES];
  if (!parsed.some((p) => p.isDefault)) {
    parsed[0] = { ...parsed[0]!, isDefault: true };
  }
  return parsed;
}
