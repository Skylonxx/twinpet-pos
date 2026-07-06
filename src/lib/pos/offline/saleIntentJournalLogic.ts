import type { AsyncOrder } from '../../types';
import type {
  EnqueueSaleIntentInput,
  PruneOptions,
  PruneOutcome,
  SaleIntentEntry,
  SaleIntentEventType,
  SaleIntentJournalStatus,
  SaleIntentPayloadPolicy,
  TransitionMetadata,
} from './saleIntentJournalTypes';
import {
  DEFAULT_PRUNE_MAX_AGE_DAYS,
  DEFAULT_PRUNE_MAX_ENTRIES,
  SALE_INTENT_PAYLOAD_VERSION,
} from './saleIntentJournalTypes';

const ERROR_MESSAGE_MAX = 300;

const ALLOWED_TRANSITIONS: Readonly<Record<SaleIntentJournalStatus, readonly SaleIntentJournalStatus[]>> = {
  queued: ['flushed_to_cache', 'server_acknowledged', 'rejected_by_rules', 'orphaned', 'manual_review'],
  flushed_to_cache: [
    'server_acknowledged',
    'rejected_by_rules',
    'settled_observed',
    'exception_observed',
    'orphaned',
    'manual_review',
  ],
  server_acknowledged: ['settled_observed', 'exception_observed', 'manual_review'],
  settled_observed: [],
  exception_observed: ['settled_observed', 'manual_review'],
  rejected_by_rules: ['manual_review', 'superseded'],
  orphaned: ['settled_observed', 'manual_review', 'superseded'],
  manual_review: ['settled_observed', 'superseded'],
  superseded: [],
};

const RESOLVED_TERMINAL_STATUSES: readonly SaleIntentJournalStatus[] = ['settled_observed', 'superseded'];

const PROTECTED_PRUNE_STATUSES: readonly SaleIntentJournalStatus[] = [
  'queued',
  'flushed_to_cache',
  'server_acknowledged',
  'rejected_by_rules',
  'orphaned',
  'manual_review',
  'exception_observed',
];

const PAYLOAD_STRIP_STATUSES: readonly SaleIntentJournalStatus[] = ['settled_observed', 'superseded'];

export function cloneSalePayload(order: Readonly<AsyncOrder>): Readonly<AsyncOrder> {
  return JSON.parse(JSON.stringify(order)) as AsyncOrder;
}

export function assertAliasEquality(asyncOrderId: string): void {
  if (!asyncOrderId) {
    throw new Error('asyncOrderId is required');
  }
}

export function aliasesForAsyncOrderId(asyncOrderId: string): {
  asyncOrderId: string;
  localQueueId: string;
  idempotencyKey: string;
} {
  assertAliasEquality(asyncOrderId);
  return {
    asyncOrderId,
    localQueueId: asyncOrderId,
    idempotencyKey: asyncOrderId,
  };
}

export function resolvePayloadForPolicy(
  order: Readonly<AsyncOrder>,
  policy: SaleIntentPayloadPolicy,
): Readonly<AsyncOrder> | null {
  if (policy === 'metadata_only') return null;
  if (policy === 'redacted') return redactSalePayload(order);
  return cloneSalePayload(order);
}

/**
 * Privacy-safe diagnostic snapshot: retains ids, amounts, and line structure;
 * strips customer PII (name/phone/taxId), staff name, free-text note, and payment refs.
 */
export function redactSalePayload(order: Readonly<AsyncOrder>): Readonly<AsyncOrder> {
  const cloned = cloneSalePayload(order);
  return {
    ...cloned,
    staffName: '[redacted]',
    customerSnap: cloned.customerSnap
      ? { name: '[redacted]', phone: '[redacted]', taxId: null }
      : null,
    note: cloned.note ? '[redacted]' : '',
    payments: cloned.payments.map((payment) => ({
      ...payment,
      ref: payment.ref ? '[redacted]' : payment.ref,
    })),
  };
}

export function buildSaleIntentEntry(
  input: EnqueueSaleIntentInput,
  now: () => Date,
): SaleIntentEntry {
  const { order } = input;
  const policy = input.payloadPolicy ?? 'full';
  const aliases = aliasesForAsyncOrderId(order.id);
  const iso = now().toISOString();

  return {
    ...aliases,
    billId: order.billId,
    branchId: order.branchId,
    deviceId: order.deviceId,
    shiftId: order.shiftId,
    staffId: order.staffId,
    createdAtLocal: order.clientCreatedAt,
    createdAtIso: iso,
    status: 'queued',
    payloadVersion: SALE_INTENT_PAYLOAD_VERSION,
    salePayload: resolvePayloadForPolicy(order, policy),
    payloadStrippedAt: null,
    totalAmount: order.total,
    retryCount: 0,
    lastAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    rejectedAt: null,
    serverAcknowledgedAt: null,
    settledObservedAt: null,
    manualReviewReason: null,
    conflictState: null,
    supersededBy: null,
    nextEventSeq: 1,
    updatedAtLocal: iso,
  };
}

export function isTransitionAllowed(
  from: SaleIntentJournalStatus,
  to: SaleIntentJournalStatus,
): boolean {
  if (to === 'queued') return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function eventTypeForStatus(status: SaleIntentJournalStatus): SaleIntentEventType {
  if (status === 'queued') return 'enqueued';
  return status;
}

export function formatSaleIntentEventKey(asyncOrderId: string, eventSeq: number): string {
  return `${asyncOrderId}#${String(eventSeq).padStart(6, '0')}`;
}

export function parseSaleIntentEventKey(key: string): { asyncOrderId: string; eventSeq: number } | null {
  const idx = key.lastIndexOf('#');
  if (idx <= 0) return null;
  const asyncOrderId = key.slice(0, idx);
  const eventSeq = Number(key.slice(idx + 1));
  if (!Number.isFinite(eventSeq)) return null;
  return { asyncOrderId, eventSeq };
}

export function sanitizeSaleIntentErrorMessage(input: unknown): string {
  const raw =
    input instanceof Error
      ? input.message
      : typeof input === 'string'
        ? input
        : '';
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (!oneLine) return 'unknown error';
  if (oneLine.length <= ERROR_MESSAGE_MAX) return oneLine;
  return `${oneLine.slice(0, ERROR_MESSAGE_MAX - 1)}…`;
}

const EVENT_DETAIL_NON_PRIMITIVE = '[non-primitive]';

function sanitizeEventDetailPrimitive(
  value: unknown,
): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : EVENT_DETAIL_NON_PRIMITIVE;
  if (typeof value === 'string') return sanitizeSaleIntentErrorMessage(value);
  if (value instanceof Error) return sanitizeSaleIntentErrorMessage(value.message);
  if (typeof value === 'object' || typeof value === 'function' || typeof value === 'bigint' || typeof value === 'symbol') {
    return EVENT_DETAIL_NON_PRIMITIVE;
  }
  return undefined;
}

/** Flatten caller event details to sanitized primitive fields only. */
export function sanitizeSaleIntentEventDetails(
  input: Readonly<Record<string, unknown>> | undefined | null,
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  if (!input) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input)) {
    const sanitized = sanitizeEventDetailPrimitive(value);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function isResolvedTerminalStatus(status: SaleIntentJournalStatus): boolean {
  return RESOLVED_TERMINAL_STATUSES.includes(status);
}

export function isProtectedPruneStatus(status: SaleIntentJournalStatus): boolean {
  return PROTECTED_PRUNE_STATUSES.includes(status);
}

export function shouldStripPayloadOnTransition(to: SaleIntentJournalStatus): boolean {
  return PAYLOAD_STRIP_STATUSES.includes(to);
}

export function stripEntryPayload(entry: SaleIntentEntry, now: () => Date): SaleIntentEntry {
  const iso = now().toISOString();
  return {
    ...entry,
    salePayload: null,
    payloadStrippedAt: iso,
    updatedAtLocal: iso,
  };
}

export function applyTransitionPatch(
  entry: SaleIntentEntry,
  to: SaleIntentJournalStatus,
  metadata: TransitionMetadata | undefined,
  now: () => Date,
): SaleIntentEntry {
  const iso = now().toISOString();
  const next: SaleIntentEntry = {
    ...entry,
    status: to,
    updatedAtLocal: iso,
    lastAttemptAt: iso,
  };

  if (metadata?.incrementRetry) {
    next.retryCount = entry.retryCount + 1;
  }
  if (metadata?.lastErrorCode !== undefined) next.lastErrorCode = metadata.lastErrorCode;
  if (metadata?.lastErrorMessage !== undefined) {
    next.lastErrorMessage =
      metadata.lastErrorMessage == null
        ? null
        : sanitizeSaleIntentErrorMessage(metadata.lastErrorMessage);
  }
  if (metadata?.conflictState !== undefined) next.conflictState = metadata.conflictState;
  if (metadata?.supersededBy !== undefined) next.supersededBy = metadata.supersededBy;
  if (metadata?.manualReviewReason !== undefined) next.manualReviewReason = metadata.manualReviewReason;

  switch (to) {
    case 'rejected_by_rules':
      if (!next.rejectedAt) next.rejectedAt = iso;
      break;
    case 'server_acknowledged':
      if (!next.serverAcknowledgedAt) next.serverAcknowledgedAt = iso;
      break;
    case 'settled_observed':
      if (!next.settledObservedAt) next.settledObservedAt = iso;
      break;
    default:
      break;
  }

  if (shouldStripPayloadOnTransition(to) && next.salePayload != null) {
    return stripEntryPayload(next, now);
  }

  return next;
}

export type PrunePlan = {
  stripIds: string[];
  deleteIds: string[];
};

export function selectPrunePlan(
  entries: readonly SaleIntentEntry[],
  options?: PruneOptions,
): PrunePlan {
  const now = options?.now ?? (() => new Date());
  const maxAgeDays = options?.maxAgeDays ?? DEFAULT_PRUNE_MAX_AGE_DAYS;
  const maxEntries = options?.maxEntries ?? DEFAULT_PRUNE_MAX_ENTRIES;
  const cutoffMs = now().getTime() - maxAgeDays * 24 * 60 * 60 * 1000;

  const stripIds: string[] = [];
  const deleteIds: string[] = [];

  for (const entry of entries) {
    if (isResolvedTerminalStatus(entry.status) && entry.salePayload != null) {
      stripIds.push(entry.asyncOrderId);
    }
  }

  for (const entry of entries) {
    if (!isResolvedTerminalStatus(entry.status)) continue;
    if (entry.createdAtLocal < cutoffMs) {
      deleteIds.push(entry.asyncOrderId);
    }
  }

  const prunable = entries
    .filter((e) => isResolvedTerminalStatus(e.status))
    .sort((a, b) => a.createdAtLocal - b.createdAtLocal || a.asyncOrderId.localeCompare(b.asyncOrderId));

  if (entries.length > maxEntries) {
    const overflow = entries.length - maxEntries;
    let removed = 0;
    for (const entry of prunable) {
      if (removed >= overflow) break;
      if (!deleteIds.includes(entry.asyncOrderId)) {
        deleteIds.push(entry.asyncOrderId);
        removed += 1;
      }
    }
  }

  return {
    stripIds: [...new Set(stripIds)],
    deleteIds: [...new Set(deleteIds)],
  };
}

export function emptyPruneOutcome(): PruneOutcome {
  return { scanned: 0, strippedPayloads: 0, deletedEntries: 0 };
}

export const TRANSITION_MATRIX = ALLOWED_TRANSITIONS;
