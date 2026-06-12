/**
 * Phase 7B-H7-A — Pure latent model for a durable local reversal-rejection record.
 *
 * WHY THIS EXISTS
 * ---------------
 * A fail-closed transfer/receiving evidence rejection is thrown
 * (`TransferReversalEvidenceError` / `ReceivingReversalEvidenceError`) BEFORE any
 * offline reversal intent is created — so it leaves NO durable forensic trail. Phase
 * 7B-H6-F1 / H6-G1 made the rejection reason *visible* to the operator at that moment
 * (a banner/toast), but that visibility is ephemeral: once the dialog closes there is
 * no record of what was blocked, when, on which document, or why.
 *
 * This file defines the record SHAPE and the pure builder/serializer/id helpers a future
 * (separately authorized) slice can use to persist such rejections. It is 100% LATENT:
 *
 *   - No IndexedDB / localStorage / Firestore / network / queue writes.
 *   - No imports from `src/lib/pos/offline` (the protected offline-queue layer) or from
 *     any runtime store module — the model is fully self-contained and decoupled.
 *   - No live runtime behavior changes. Nothing in production references it yet.
 *
 * DESIGN NOTES
 * ------------
 * - `evidenceCode` / `evidenceMessage` are plain strings. The caller (a future catch-site
 *   slice) passes the raw `err.code` and the already-computed friendly message from the
 *   existing display helpers, so this module never imports the evolving code unions and
 *   handles an unknown/newer code safely (no union over-rejection).
 * - `createdAt` is an INPUT, never read from the clock here, so every helper is pure and
 *   deterministic (same inputs → byte-identical output, suitable for tests and dedupe).
 * - Deliberately MINIMAL: no raw evidence payloads, no item/lot/qty/cost lines, no
 *   reason/note free-text, no device fingerprint, no actor role. Only the identity + code
 *   needed to audit "what was refused" — avoiding over-collection of sensitive data.
 */

/** The two reversal domains that can raise a fail-closed evidence rejection. */
export type ReversalRejectionSourceType = 'transfer' | 'receiving';

/**
 * A durable-friendly record of a single pre-queue fail-closed reversal-evidence
 * rejection. Plain-data only — safe to serialize and persist later as-is.
 */
export interface ReversalRejectionRecord {
  /** Deterministic, content-derived id (stable for identical inputs). */
  readonly recordId: string;
  /** Which reversal domain raised the rejection. */
  readonly sourceType: ReversalRejectionSourceType;
  /** The source document id (transfer id / receiving id) that was being reversed. */
  readonly sourceId: string;
  /** Branch context of the rejection (transfer origin / receiving branch). */
  readonly branchId: string;
  /** The raw structured rejection code (e.g. `header_total_qty_mismatch`). */
  readonly evidenceCode: string;
  /** The operator-facing message already computed by the existing display helper. */
  readonly evidenceMessage: string;
  /** Which evidence the reversal was proven from, when known at rejection time. */
  readonly evidenceSource?: string;
  /** The acting Manager/Admin id, when available. */
  readonly staffId?: string;
  /** Client-observed source-document `updatedAt` (ISO 8601), when available. */
  readonly observedDocumentUpdatedAt?: string;
  /** When the rejection was recorded (ISO 8601) — supplied by the caller. */
  readonly createdAt: string;
}

/**
 * Caller-supplied input for building a rejection record. Optional fields may be
 * omitted, `null`, `undefined`, or empty/whitespace — they are normalized away.
 */
export interface ReversalRejectionRecordInput {
  sourceType: ReversalRejectionSourceType;
  sourceId: string;
  branchId: string;
  evidenceCode: string;
  evidenceMessage: string;
  createdAt: string;
  evidenceSource?: string | null;
  staffId?: string | null;
  observedDocumentUpdatedAt?: string | null;
}

/** Thrown when a rejection record cannot be built from the given input. */
export class ReversalRejectionRecordError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'ReversalRejectionRecordError';
    this.field = field;
  }
}

/**
 * Stable field order used for BOTH the canonical serialization and the id hash, so the
 * output is independent of input property order. `recordId` is intentionally excluded
 * from the id-hash projection (a content hash cannot depend on itself).
 */
const RECORD_KEY_ORDER: readonly (keyof ReversalRejectionRecord)[] = [
  'recordId',
  'sourceType',
  'sourceId',
  'branchId',
  'evidenceCode',
  'evidenceMessage',
  'evidenceSource',
  'staffId',
  'observedDocumentUpdatedAt',
  'createdAt',
];

/** Trim a string-ish value; return `undefined` for null/undefined/empty-after-trim. */
function optionalTrimmed(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Trim a required string; throw a typed error when missing/empty after trim. */
function requireTrimmed(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ReversalRejectionRecordError(field, `Missing required field: ${field}`);
  }
  return value.trim();
}

/**
 * Build the normalized field set (everything except `recordId`). Validates the required
 * identity fields fail-closed and omits absent optionals so a persisted record never
 * carries `''` / `null` placeholders.
 */
function normalize(input: ReversalRejectionRecordInput): Omit<ReversalRejectionRecord, 'recordId'> {
  if (input == null || typeof input !== 'object') {
    throw new ReversalRejectionRecordError('input', 'Rejection record input must be an object');
  }
  if (input.sourceType !== 'transfer' && input.sourceType !== 'receiving') {
    throw new ReversalRejectionRecordError('sourceType', "sourceType must be 'transfer' or 'receiving'");
  }

  const base: Omit<ReversalRejectionRecord, 'recordId'> = {
    sourceType: input.sourceType,
    sourceId: requireTrimmed(input.sourceId, 'sourceId'),
    branchId: requireTrimmed(input.branchId, 'branchId'),
    evidenceCode: requireTrimmed(input.evidenceCode, 'evidenceCode'),
    evidenceMessage: requireTrimmed(input.evidenceMessage, 'evidenceMessage'),
    createdAt: requireTrimmed(input.createdAt, 'createdAt'),
  };

  const evidenceSource = optionalTrimmed(input.evidenceSource);
  const staffId = optionalTrimmed(input.staffId);
  const observedDocumentUpdatedAt = optionalTrimmed(input.observedDocumentUpdatedAt);

  return {
    ...base,
    ...(evidenceSource !== undefined ? { evidenceSource } : {}),
    ...(staffId !== undefined ? { staffId } : {}),
    ...(observedDocumentUpdatedAt !== undefined ? { observedDocumentUpdatedAt } : {}),
  };
}

/**
 * Canonical, stable serialization of a (full or id-less) record: keys are emitted in a
 * fixed order and absent fields are skipped, so the string is byte-identical regardless
 * of property insertion order. The output is plain JSON, safe for durable storage.
 */
function canonicalize(record: Partial<ReversalRejectionRecord>): string {
  const ordered: Record<string, string> = {};
  for (const key of RECORD_KEY_ORDER) {
    const value = record[key];
    if (typeof value === 'string') {
      ordered[key] = value;
    }
  }
  return JSON.stringify(ordered);
}

/**
 * Pure FNV-1a-style 64-bit-ish content hash (two 32-bit lanes) over a string, rendered
 * as 16 lowercase hex chars. No crypto/network — deterministic and dependency-free.
 */
function hash16(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xc59d1c81;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca77);
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h1) + hex(h2);
}

/**
 * Deterministic content-addressed id for a rejection record: a hash over the normalized
 * identity fields (excluding `recordId` itself). Identical input → identical id, so a
 * future store can dedupe naturally; any meaningful field difference yields a new id.
 */
export function createReversalRejectionRecordId(input: ReversalRejectionRecordInput): string {
  const normalized = normalize(input);
  return `rej_${hash16(canonicalize(normalized))}`;
}

/**
 * Build a normalized, deterministic {@link ReversalRejectionRecord} from caller input.
 * Pure: no I/O, no clock read (`createdAt` is supplied). Required identity fields are
 * validated fail-closed (throws {@link ReversalRejectionRecordError}); optional fields
 * are omitted when absent. The `recordId` is derived from the normalized content.
 */
export function buildReversalRejectionRecord(input: ReversalRejectionRecordInput): ReversalRejectionRecord {
  const normalized = normalize(input);
  const recordId = `rej_${hash16(canonicalize(normalized))}`;
  return { recordId, ...normalized };
}

/**
 * Stable serialization of a built record, suitable for durable persistence later.
 * Deterministic regardless of property order; absent optional fields are omitted.
 */
export function serializeReversalRejectionRecord(record: ReversalRejectionRecord): string {
  return canonicalize(record);
}
