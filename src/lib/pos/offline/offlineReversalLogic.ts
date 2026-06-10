/**
 * Offline Reversal Queue — pure logic  [Phase 7B-3D-3]
 *
 * No I/O, no clock reads, no IndexedDB. Every function here is deterministic so
 * the orchestration layer (offlineReversalQueue.ts) can be reasoned about and
 * unit-tested in isolation — the same pure/I-O split the codebase already uses
 * for buildAsyncOrder (asyncCheckout.ts) and performResolveReversal.
 */

import type {
  CreateReversalInput,
  LocalStockDelta,
  OfflineReversalIntent,
  OriginalStockEffect,
  ReversalActorRole,
  ReversalIds,
} from './offlineReversalTypes';

/**
 * Minimal client-side mirror of the server resolver's response
 * (functions/src/resolveReversal.ts → ResolveReversalResponse). The client never
 * imports from `functions/`, so we restate only the fields the queue consumes.
 */
export type ServerReversalResponse = {
  ok: boolean;
  idempotencyKey: string;
  serverReversalId?: string;
  status: 'confirmed' | 'duplicate_confirmed' | 'rejected' | 'conflict_requires_manual_review';
  rejectCode?: string;
  message?: string;
  confirmedAtServer?: string;
};

/**
 * The classified outcome of a single sync attempt. The orchestration layer turns
 * this into a concrete queue status (and, for `rejected_rollback_eligible`, a
 * fail-closed dependency-safety proof that may downgrade it to manual review).
 */
export type SyncClassification =
  | 'accepted'
  | 'retryable'
  | 'manual_review'
  | 'rejected_rollback_eligible';

// ─── Offline actor authority (Blocker 2) ─────────────────────────────────────

/** Structured local rejection codes for create-time authority failures. */
export type OfflineReversalRejectCode = 'offline_staff_authority_unsupported';

/**
 * Thrown when an offline reversal cannot be created locally. Carries a structured
 * `code` so callers can branch / surface a precise message. Throwing (rather than
 * returning) guarantees NO stock correction and NO queue write happen.
 */
export class OfflineReversalRejectedError extends Error {
  readonly code: OfflineReversalRejectCode;
  constructor(code: OfflineReversalRejectCode, message: string) {
    super(message);
    this.name = 'OfflineReversalRejectedError';
    this.code = code;
  }
}

/**
 * Offline reversal is authority-restricted to Manager/Admin. The server resolver
 * lets Manager/Admin bypass the PIN (resolveReversal.ts) but REQUIRES a raw,
 * server-verified PIN for Staff — which an offline queue cannot safely satisfy
 * (storing a raw PIN for later sync is forbidden). So a Staff offline reversal
 * would inevitably sync as `invalid_pin`; we reject it up front instead.
 */
export function isOfflineReversalAuthoritySupported(role: ReversalActorRole): boolean {
  return role === 'admin' || role === 'manager';
}

/** Assert the actor may create an offline reversal; throws a structured rejection otherwise. */
export function assertOfflineReversalAuthority(role: ReversalActorRole): void {
  if (!isOfflineReversalAuthoritySupported(role)) {
    throw new OfflineReversalRejectedError(
      'offline_staff_authority_unsupported',
      'พนักงาน (Staff) ไม่สามารถสร้างคำสั่งย้อนกลับแบบออฟไลน์ได้ — ต้องให้ผู้จัดการ/ผู้ดูแลดำเนินการ',
    );
  }
}

// ─── Deterministic identity ──────────────────────────────────────────────────

/**
 * FNV-1a 32-bit — a tiny, dependency-free, synchronous string hash. Used only to
 * shorten the canonical idempotency key into compact local ids; it is NOT a
 * security primitive (the server independently re-hashes the key for its ledger).
 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (keeps it in uint32 range).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Derive the deterministic identity triple from the source document. Two reversal
 * attempts against the SAME (business, source doc, action) collapse to the SAME
 * ids — which is what makes both local replay AND server idempotency safe by
 * construction: a duplicate reversal of one document can never create a second
 * intent or double-correct local stock.
 */
export function deriveReversalIds(
  basis: Pick<CreateReversalInput, 'businessId' | 'sourceType' | 'sourceId' | 'action'>,
): ReversalIds {
  const idempotencyKey = `rev:${basis.businessId}:${basis.sourceType}:${basis.sourceId}:${basis.action}`;
  const h = fnv1a(idempotencyKey);
  return {
    id: `ori_${h}`,
    idempotencyKey,
    localMutationId: `lmu_${h}`,
  };
}

// ─── Stock delta ─────────────────────────────────────────────────────────────

/**
 * The reversal correction is the negation of the document's original stock effect.
 * (Receiving added +qty → reversal subtracts; transfer moved dest +/ source − →
 * reversal flips both.) Zero-quantity effects are dropped.
 */
export function computeReversalDelta(effects: readonly OriginalStockEffect[]): LocalStockDelta[] {
  const out: LocalStockDelta[] = [];
  for (const e of effects) {
    if (!e.quantity) continue;
    out.push({
      productId: e.productId,
      locationId: e.locationId,
      lotId: e.lotId ?? null,
      delta: -e.quantity,
    });
  }
  return out;
}

/** Stable counter key (product × location). Lot is audit-only and not part of the key. */
export function stockCounterKey(productId: string, locationId: string): string {
  return `${productId}::${locationId}`;
}

/**
 * Aggregate signed deltas down to the product×location counter granularity (what
 * the POS grid actually reads). Returns one entry per counter, summing lot-level
 * deltas. Deterministic insertion order = first appearance.
 */
export function aggregateDeltasByCounter(
  deltas: readonly LocalStockDelta[],
): { key: string; productId: string; locationId: string; delta: number }[] {
  const byKey = new Map<string, { key: string; productId: string; locationId: string; delta: number }>();
  for (const d of deltas) {
    const key = stockCounterKey(d.productId, d.locationId);
    const cur = byKey.get(key);
    if (cur) cur.delta += d.delta;
    else byKey.set(key, { key, productId: d.productId, locationId: d.locationId, delta: d.delta });
  }
  return [...byKey.values()];
}

// ─── Intent construction ─────────────────────────────────────────────────────

/** Build the durable queue record in its initial `queued` state (correction not yet applied). */
export function buildOfflineReversalIntent(
  ids: ReversalIds,
  input: CreateReversalInput,
  stockDelta: LocalStockDelta[],
  nowIso: string,
): OfflineReversalIntent {
  return {
    id: ids.id,
    businessId: input.businessId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    action: input.action,
    branchId: input.branchId,
    reasonCode: input.reasonCode,
    reasonNote: input.reasonNote ?? null,
    terminalId: input.terminalId ?? null,
    createdAt: nowIso,
    createdByStaffId: input.createdByStaffId,
    createdByRole: input.actorRole,
    idempotencyKey: ids.idempotencyKey,
    localMutationId: ids.localMutationId,
    // Phase 7B-H1: preserve the evidence provenance on the durable intent (audit).
    ...(input.evidenceSource ? { evidenceSource: input.evidenceSource } : {}),
    status: 'queued',
    localCorrection: {
      applied: false,
      reversed: false,
      stockDelta,
    },
  };
}

// ─── Server response classification ──────────────────────────────────────────

/**
 * Classify a sync attempt. A `null` response means a NETWORK/transport failure —
 * which must NEVER be read as a server rejection (the request may or may not have
 * landed; the local correction must stay applied and we simply retry).
 *
 * Mapping:
 *  - network error / undefined response      → retryable
 *  - ok === true (confirmed | duplicate)     → accepted
 *  - status conflict_requires_manual_review  → manual_review (server asked for it)
 *  - rejectCode server_error                 → retryable (transient server fault)
 *  - any other reject                        → rejected_rollback_eligible
 */
export function classifyServerResult(
  response: ServerReversalResponse | null | undefined,
): SyncClassification {
  if (!response) return 'retryable';
  if (response.ok) return 'accepted';
  if (response.status === 'conflict_requires_manual_review') return 'manual_review';
  if (response.rejectCode === 'server_error') return 'retryable';
  return 'rejected_rollback_eligible';
}

/**
 * Rollback safety gate — FAIL-CLOSED (Blocker 3). A rejected reversal's local
 * correction may be auto-rolled-back ONLY when comprehensive dependency safety has
 * been explicitly PROVEN (`proven === true`). Missing / unknown / incomplete
 * evidence (`false`, the default) ⇒ NOT safe ⇒ the orchestration marks the item
 * `manual_review_required` and leaves the correction in place. There is currently
 * no integration with the live POS/local-stock consumers, so by design this almost
 * always fail-closes — exactly as required (CEO 3.2: no unsafe auto-rollback).
 */
export function isRollbackSafe(proven: boolean): boolean {
  return proven === true;
}

/** Negate a set of deltas to produce the rollback (reversing) correction. */
export function invertDeltas(deltas: readonly LocalStockDelta[]): LocalStockDelta[] {
  return deltas.map((d) => ({ ...d, delta: -d.delta }));
}

// ─── Recoverable sync lease (Blocker 1) ──────────────────────────────────────

/**
 * Whether a sync lease has expired (or is absent). ISO-8601 UTC strings produced
 * by `Date.toISOString()` are fixed-width and lexicographically ordered, so a
 * string comparison is a valid time comparison here. An absent expiry is treated
 * as expired (reclaimable) so a partially-written claim can never strand an item.
 */
export function isLeaseExpired(expiresAt: string | null | undefined, nowIso: string): boolean {
  if (!expiresAt) return true;
  return expiresAt <= nowIso;
}

/**
 * Whether a queue item may be claimed for syncing at `nowIso`:
 *  - `queued` / `retryable_error`            → always claimable
 *  - `syncing` with an EXPIRED lease         → reclaimable (crash/reload recovery)
 *  - `syncing` with a live lease             → NOT claimable (another worker owns it)
 *  - terminal states (accepted/rejected/manual) → never claimable
 */
export function isClaimable(
  intent: Pick<OfflineReversalIntent, 'status' | 'syncLeaseExpiresAt'>,
  nowIso: string,
): boolean {
  if (intent.status === 'queued' || intent.status === 'retryable_error') return true;
  if (intent.status === 'syncing') return isLeaseExpired(intent.syncLeaseExpiresAt, nowIso);
  return false;
}
