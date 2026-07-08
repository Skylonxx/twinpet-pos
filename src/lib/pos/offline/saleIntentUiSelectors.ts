import type { SaleIntentEntry, SaleIntentJournalStatus } from './saleIntentJournalTypes';
import type { SaleIntentJournal } from './saleIntentJournal';

/**
 * Read-only UI selectors over the Sale Intent Journal (Packet 6). These derive
 * presentation state only — they never call any journal mutation (`transitionStatus`,
 * `markManualReview`, etc.) and are safe to poll on an interval.
 */

/** In-flight statuses: enqueued locally and not yet settled or flagged. */
export const DEVICE_PENDING_STATUSES: readonly SaleIntentJournalStatus[] = [
  'queued',
  'flushed_to_cache',
  'server_acknowledged',
];

/** Statuses the cashier/manager should look at — never auto-resolved by this UI. */
export const DEVICE_ATTENTION_STATUSES: readonly SaleIntentJournalStatus[] = [
  'rejected_by_rules',
  'orphaned',
  'manual_review',
];

const ALL_TRACKED_STATUSES: SaleIntentJournalStatus[] = [
  ...DEVICE_PENDING_STATUSES,
  ...DEVICE_ATTENTION_STATUSES,
];

/** A pending entry older than this is called out with escalation copy, not blocked. */
export const OLD_PENDING_AGE_MS = 10 * 60 * 1000;

export type DevicePendingSummary = {
  count: number;
  oldestAgeMs: number | null;
  isStale: boolean;
};

export function selectDevicePendingSummary(
  entries: readonly SaleIntentEntry[],
  deviceId: string,
  nowMs: number,
): DevicePendingSummary {
  const mine = entries.filter(
    (entry) => entry.deviceId === deviceId && DEVICE_PENDING_STATUSES.includes(entry.status),
  );
  if (mine.length === 0) return { count: 0, oldestAgeMs: null, isStale: false };
  const oldestCreatedAt = Math.min(...mine.map((entry) => entry.createdAtLocal));
  const oldestAgeMs = Math.max(0, nowMs - oldestCreatedAt);
  return { count: mine.length, oldestAgeMs, isStale: oldestAgeMs >= OLD_PENDING_AGE_MS };
}

export type SaleIntentAttentionRow = {
  asyncOrderId: string;
  billId: string;
  createdAtIso: string;
  totalAmount: number;
  status: SaleIntentJournalStatus;
  reason: string;
};

function reasonForEntry(entry: SaleIntentEntry): string {
  if (entry.status === 'manual_review' && entry.manualReviewReason) return entry.manualReviewReason;
  if (entry.lastErrorMessage) return entry.lastErrorMessage;
  if (entry.status === 'orphaned') return 'ไม่พบการยืนยันจากเซิร์ฟเวอร์ภายในเวลาที่กำหนด';
  if (entry.status === 'rejected_by_rules') return 'เซิร์ฟเวอร์ปฏิเสธรายการนี้';
  return 'ต้องตรวจสอบด้วยตนเอง';
}

export function selectDeviceAttentionRows(
  entries: readonly SaleIntentEntry[],
  deviceId: string,
): SaleIntentAttentionRow[] {
  return entries
    .filter((entry) => entry.deviceId === deviceId && DEVICE_ATTENTION_STATUSES.includes(entry.status))
    .sort((a, b) => a.createdAtLocal - b.createdAtLocal || a.asyncOrderId.localeCompare(b.asyncOrderId))
    .map((entry) => ({
      asyncOrderId: entry.asyncOrderId,
      billId: entry.billId || entry.asyncOrderId,
      createdAtIso: entry.createdAtIso,
      totalAmount: entry.totalAmount,
      status: entry.status,
      reason: reasonForEntry(entry),
    }));
}

/**
 * Fetches every entry this UI cares about in one round-trip. Fails open (empty
 * array) on any journal read failure — a broken/unavailable journal must never
 * surface as an error state on the POS screen.
 */
export async function readDeviceSaleIntentEntries(
  journal: Pick<SaleIntentJournal, 'listSaleIntentsByStatus'>,
): Promise<SaleIntentEntry[]> {
  try {
    const result = await journal.listSaleIntentsByStatus(ALL_TRACKED_STATUSES);
    return result.ok ? result.value : [];
  } catch {
    return [];
  }
}
