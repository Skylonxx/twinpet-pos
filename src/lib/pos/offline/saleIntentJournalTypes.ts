import type { AsyncOrder } from '../../types';

/** Lifecycle statuses for the sale intent journal sidecar. */
export type SaleIntentJournalStatus =
  | 'queued'
  | 'flushed_to_cache'
  | 'rejected_by_rules'
  | 'server_acknowledged'
  | 'settled_observed'
  | 'exception_observed'
  | 'orphaned'
  | 'manual_review'
  | 'superseded';

export type SaleIntentEventType =
  | 'enqueued'
  | 'flushed_to_cache'
  | 'server_acknowledged'
  | 'rejected_by_rules'
  | 'settled_observed'
  | 'exception_observed'
  | 'orphaned'
  | 'manual_review'
  | 'superseded'
  | 'payload_stripped'
  | 'pruned_notice';

export type SaleIntentPayloadPolicy =
  | 'full'
  | 'metadata_only'
  /** Privacy-safe snapshot: ids/amounts/lines retained; customer PII and refs redacted. */
  | 'redacted';

export type SaleIntentConflictState = 'doc-exists' | null;

export type SaleIntentEntry = {
  asyncOrderId: string;
  localQueueId: string;
  idempotencyKey: string;
  billId: string;
  branchId: string;
  deviceId: string;
  shiftId: string;
  staffId: string;
  createdAtLocal: number;
  createdAtIso: string;
  status: SaleIntentJournalStatus;
  payloadVersion: number;
  salePayload: Readonly<AsyncOrder> | null;
  payloadStrippedAt: string | null;
  totalAmount: number;
  retryCount: number;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  rejectedAt: string | null;
  serverAcknowledgedAt: string | null;
  settledObservedAt: string | null;
  manualReviewReason: string | null;
  conflictState: SaleIntentConflictState;
  supersededBy: string | null;
  nextEventSeq: number;
  updatedAtLocal: string;
};

export type SaleIntentEvent = {
  asyncOrderId: string;
  eventSeq: number;
  timestamp: string;
  eventType: SaleIntentEventType;
  details?: Readonly<Record<string, string | number | boolean | null>>;
};

export type SaleIntentJournalMeta = {
  schemaVersion: number;
  deviceId: string | null;
  lastPruneAt: string | null;
  lastPruneOutcome: PruneOutcome | null;
};

export type PruneOutcome = {
  scanned: number;
  strippedPayloads: number;
  deletedEntries: number;
};

export type PruneOptions = {
  maxAgeDays?: number;
  maxEntries?: number;
  now?: () => Date;
};

export type JournalErrorCode =
  | 'unavailable'
  | 'quota'
  | 'not_found'
  | 'duplicate'
  | 'illegal_transition'
  | 'invalid_input'
  | 'tx_failed';

export type JournalResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: JournalErrorCode; message?: string; from?: SaleIntentJournalStatus; to?: SaleIntentJournalStatus };

export type TransitionMetadata = {
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  conflictState?: SaleIntentConflictState;
  supersededBy?: string | null;
  manualReviewReason?: string | null;
  incrementRetry?: boolean;
};

export type EnqueueSaleIntentInput = {
  order: Readonly<AsyncOrder>;
  payloadPolicy?: SaleIntentPayloadPolicy;
};

export const SALE_INTENT_PAYLOAD_VERSION = 1;
export const SALE_INTENT_META_KEY = 'meta';
export const DEFAULT_PRUNE_MAX_AGE_DAYS = 14;
export const DEFAULT_PRUNE_MAX_ENTRIES = 500;
