/**
 * Offline Reversal Queue — orchestration  [Phase 7B-3D-3]
 *
 * The atomic, idempotent, race-safe glue between the pure logic (offlineReversalLogic.ts)
 * and the durable store (reversalLocalStore.ts). It owns four operations:
 *
 *   createOfflineReversal — create intent + IMMEDIATELY correct local stock, all in
 *                           one atomic IndexedDB transaction (the brief's 9-step order).
 *   claimForSync          — atomically lock a queue item (queued→syncing) so two
 *                           sync workers can never process the same item.
 *   applyServerResult     — fold the server resolver's reply (or a network error)
 *                           back into the queue: accept / retry / manual-review / safe-rollback.
 *   listQueue / getIntent — read helpers.
 *
 * Clock is injected (`deps.now`) so behaviour is deterministic under test, mirroring
 * the codebase's pure/I-O discipline.
 */

import {
  aggregateDeltasByCounter,
  assertManualReviewResolveInput,
  assertOfflineReversalAuthority,
  buildOfflineReversalIntent,
  buildResolvedManualReviewIntent,
  classifyServerResult,
  computeReversalDelta,
  deriveReversalIds,
  invertDeltas,
  isClaimable,
  isManualReviewResolvable,
  isRollbackSafe,
  stockCounterKey,
  type ManualReviewResolveInput,
  type ServerReversalResponse,
} from './offlineReversalLogic';
import type {
  CreateReversalInput,
  LocalMutationMarker,
  LocalStockCounter,
  LocalStockDelta,
  LocalStockLedgerRow,
  OfflineReversalIntent,
} from './offlineReversalTypes';
import type { ReversalLocalStore, ReversalTxn } from './reversalLocalStore';

export type QueueDeps = {
  /** Returns the current time as an ISO string. Injected for deterministic tests. */
  now: () => string;
};

const defaultDeps: QueueDeps = { now: () => new Date().toISOString() };

/** Default sync-lease window. A claimed item is reclaimable this long after the claim. */
export const DEFAULT_SYNC_LEASE_MS = 60_000;
/** Default claim owner when a caller does not identify itself. */
export const DEFAULT_SYNC_OWNER = 'local';

export type ClaimOptions = {
  /** Identifies the claiming worker (stored as `syncLeaseOwner`). */
  owner?: string;
  /** Lease window in ms (default {@link DEFAULT_SYNC_LEASE_MS}). */
  leaseMs?: number;
  deps?: QueueDeps;
};

/**
 * Proof that the holder owns the ACTIVE sync claim (Blocker — stale-worker race).
 * `claimForSync` returns this; `applyServerResult` re-verifies it inside the same
 * transaction. `(syncLeaseOwner, syncAttempt)` uniquely identifies one claim: any
 * reclaim of an expired lease bumps `syncAttempt`, so a stale worker's token no
 * longer matches and its result is dropped — a terminal state can never be
 * downgraded by a late, superseded worker.
 */
export type SyncClaimToken = {
  intentId: string;
  syncLeaseOwner: string;
  syncAttempt: number;
};

/** Derive the claim token from a freshly-claimed intent (returned by {@link claimForSync}). */
export function claimTokenOf(claimed: OfflineReversalIntent): SyncClaimToken {
  return {
    intentId: claimed.id,
    syncLeaseOwner: claimed.syncLeaseOwner ?? '',
    syncAttempt: claimed.syncAttempt ?? 0,
  };
}

/** Whether `token` still matches the live claim on `intent` (must be syncing + owner/attempt match). */
function tokenMatchesActiveClaim(intent: OfflineReversalIntent, token: SyncClaimToken): boolean {
  return (
    intent.status === 'syncing' &&
    (intent.syncLeaseOwner ?? '') === token.syncLeaseOwner &&
    (intent.syncAttempt ?? 0) === token.syncAttempt
  );
}

/** The outcome of one sync attempt handed to {@link applyServerResult}. */
export type SyncOutcome =
  | { kind: 'response'; response: ServerReversalResponse }
  | { kind: 'network_error'; error?: unknown };

/**
 * FAIL-CLOSED rollback-safety proof (Blocker 3). Returns `true` ONLY when it can
 * comprehensively prove that NO later local activity depends on this intent's
 * corrected stock. Absent (the default) or any thrown/`false` result ⇒ unsafe ⇒
 * the rejected item is sent to `manual_review_required` with the correction kept.
 * No such comprehensive probe exists yet (POS/local-stock-consumer integration is
 * deferred), so callers should normally omit it and let rollback fail-close.
 */
export type RollbackSafetyProof = (args: {
  intent: OfflineReversalIntent;
  txn: ReversalTxn;
}) => boolean | Promise<boolean>;

const ledgerApplyKey = (intentId: string, counterKey: string): string =>
  `${intentId}::apply::${counterKey}`;
const ledgerReverseKey = (intentId: string, counterKey: string): string =>
  `${intentId}::reverse::${counterKey}`;

async function readCounter(
  txn: ReversalTxn,
  productId: string,
  locationId: string,
): Promise<number> {
  const rec = await txn.get<LocalStockCounter>('stock', stockCounterKey(productId, locationId));
  return rec?.quantity ?? 0;
}

/**
 * Apply a set of deltas to local counters + write ledger rows, returning the rows.
 * `direction` distinguishes the initial correction (`apply`) from a rollback (`reverse`).
 */
async function applyDeltasToStock(
  txn: ReversalTxn,
  intentId: string,
  deltas: readonly LocalStockDelta[],
  direction: 'apply' | 'reverse',
  nowIso: string,
): Promise<void> {
  for (const agg of aggregateDeltasByCounter(deltas)) {
    const before = await readCounter(txn, agg.productId, agg.locationId);
    const after = before + agg.delta;
    const counter: LocalStockCounter = {
      productId: agg.productId,
      locationId: agg.locationId,
      quantity: after,
    };
    await txn.put('stock', agg.key, counter);
    const rowKey = direction === 'apply' ? ledgerApplyKey(intentId, agg.key) : ledgerReverseKey(intentId, agg.key);
    const row: LocalStockLedgerRow = {
      id: rowKey,
      intentId,
      productId: agg.productId,
      locationId: agg.locationId,
      lotId: null,
      direction,
      delta: agg.delta,
      resultingQuantity: after,
      createdAt: nowIso,
    };
    await txn.put('ledger', rowKey, row);
  }
}

/**
 * Create an offline reversal intent AND immediately correct local stock, atomically.
 *
 * Order inside the single readwrite transaction (the brief's 9 steps):
 *   1-2. deterministic ids + computed delta (pure, before the txn)
 *   3.   open readwrite txn (intents, stock, ledger, markers)
 *   4.   assert the localMutationId marker has NOT already been applied (idempotency)
 *   5.   write the intent to the durable queue (status `queued`)
 *   6.   apply the local stock delta to counters
 *   7.   write local stock ledger rows
 *   8.   write the local mutation marker + finalise the intent (localAppliedAt, applied)
 *   9.   commit (implicit on txn drain)
 *
 * Idempotent: a replay (same source/action) finds an applied marker and returns the
 * existing intent WITHOUT re-applying stock — the same correction can never double-apply.
 *
 * Authority (Blocker 2): a Staff actor is rejected HERE, before the transaction — no
 * stock correction, no queue write. Throws {@link OfflineReversalRejectedError}
 * (`offline_staff_authority_unsupported`).
 */
export async function createOfflineReversal(
  store: ReversalLocalStore,
  input: CreateReversalInput,
  deps: QueueDeps = defaultDeps,
): Promise<OfflineReversalIntent> {
  // Blocker 2 — fail BEFORE any local mutation if the actor can't satisfy the
  // server resolver's authority contract (Staff requires a server-verified PIN).
  assertOfflineReversalAuthority(input.actorRole);

  const ids = deriveReversalIds(input);
  const delta = computeReversalDelta(input.originalEffects);

  return store.transact(['intents', 'stock', 'ledger', 'markers'], 'readwrite', async (txn) => {
    // 4. Idempotency: never apply the same local mutation twice.
    const marker = await txn.get<LocalMutationMarker>('markers', ids.localMutationId);
    if (marker?.applied) {
      const existing = await txn.get<OfflineReversalIntent>('intents', ids.id);
      if (existing) return existing; // replay → no second correction
    }

    const nowIso = deps.now();
    // 5. Durable queue write (queued, correction not yet applied).
    const queued = buildOfflineReversalIntent(ids, input, delta, nowIso);
    await txn.put('intents', queued.id, queued);

    // 6 + 7. Apply the correction to local counters and write ledger rows.
    await applyDeltasToStock(txn, queued.id, delta, 'apply', nowIso);

    // 8. Mutation marker (idempotency guard) + finalise the intent.
    const applied: OfflineReversalIntent = {
      ...queued,
      localAppliedAt: nowIso,
      localCorrection: { applied: true, reversed: false, stockDelta: delta },
    };
    await txn.put('intents', applied.id, applied);
    const newMarker: LocalMutationMarker = {
      localMutationId: ids.localMutationId,
      intentId: applied.id,
      applied: true,
      appliedAt: nowIso,
      serverConfirmed: false,
      reversed: false,
    };
    await txn.put('markers', ids.localMutationId, newMarker);

    return applied; // 9. commit
  });
}

/**
 * Atomically claim a queue item for syncing with a RECOVERABLE LEASE (Blocker 1).
 * Claimable when `queued` / `retryable_error`, OR `syncing` with an EXPIRED lease
 * (so a worker that crashed mid-sync no longer strands the item). A `syncing` item
 * with a LIVE lease is NOT claimable — that is how a second concurrent worker is
 * prevented from processing it. The claim atomically stamps owner / expiry / attempt.
 * Returns the claimed intent, or `null` if not claimable.
 */
export async function claimForSync(
  store: ReversalLocalStore,
  intentId: string,
  options: ClaimOptions = {},
): Promise<OfflineReversalIntent | null> {
  const deps = options.deps ?? defaultDeps;
  const owner = options.owner ?? DEFAULT_SYNC_OWNER;
  const leaseMs = options.leaseMs ?? DEFAULT_SYNC_LEASE_MS;
  return store.transact(['intents'], 'readwrite', async (txn) => {
    const intent = await txn.get<OfflineReversalIntent>('intents', intentId);
    if (!intent) return null;
    const nowIso = deps.now();
    if (!isClaimable(intent, nowIso)) return null; // live lease / terminal → cannot grab
    const expiresAt = new Date(Date.parse(nowIso) + leaseMs).toISOString();
    const claimed: OfflineReversalIntent = {
      ...intent,
      status: 'syncing',
      syncLeaseOwner: owner,
      syncLeaseExpiresAt: expiresAt,
      syncAttempt: (intent.syncAttempt ?? 0) + 1,
      lastSyncAttemptAt: nowIso,
      lastSyncedAt: nowIso,
    };
    await txn.put('intents', intentId, claimed);
    return claimed;
  });
}

/** Result of {@link applyServerResult}: `applied` mutated the item; `stale_noop`
 *  left it untouched because the caller no longer holds the active claim. */
export type ApplyServerResultOutcome = 'applied' | 'stale_noop' | 'not_found';
export type ApplyServerResult = {
  outcome: ApplyServerResultOutcome;
  /** Current intent (post-mutation if applied; unchanged if stale/terminal). */
  intent: OfflineReversalIntent | null;
};

/**
 * Fold a sync attempt's outcome back into the queue. MUST be called with the claim
 * token returned by {@link claimForSync}. The token is RE-VERIFIED inside the same
 * transaction: if the item is no longer `syncing` (already terminal/reclaimed) or
 * the lease owner/attempt no longer matches, the result is a `stale_noop` and the
 * item is left untouched — so a stalled, superseded worker can never downgrade a
 * newer terminal state (e.g. `server_accepted → retryable_error`). Outcome rules:
 *
 *  - accepted   → status `server_accepted`; marker `serverConfirmed`; stock NOT re-applied.
 *  - retryable  → status `retryable_error`; local correction stays applied.
 *  - manual     → status `manual_review_required`; rejection preserved; no rollback.
 *  - rejected   → safe rollback (reverse delta + ledger) → `server_rejected`,
 *                 OR if dependency safety is not proven → `manual_review_required`.
 */
export async function applyServerResult(
  store: ReversalLocalStore,
  token: SyncClaimToken,
  outcome: SyncOutcome,
  options: { proveRollbackSafe?: RollbackSafetyProof; deps?: QueueDeps } = {},
): Promise<ApplyServerResult> {
  const deps = options.deps ?? defaultDeps;
  const proveRollbackSafe = options.proveRollbackSafe;
  const response = outcome.kind === 'response' ? outcome.response : null;
  const classification = classifyServerResult(response);
  const intentId = token.intentId;

  return store.transact(['intents', 'stock', 'ledger', 'markers'], 'readwrite', async (txn) => {
    const intent = await txn.get<OfflineReversalIntent>('intents', intentId);
    if (!intent) return { outcome: 'not_found', intent: null };
    // Stale-worker guard: only the holder of the ACTIVE claim may mutate. This
    // protects every terminal status from a late, superseded worker's result.
    if (!tokenMatchesActiveClaim(intent, token)) {
      return { outcome: 'stale_noop', intent };
    }
    const nowIso = deps.now();
    // The sync attempt has concluded — release the lease in every outcome (a
    // `retryable_error` thus becomes immediately re-claimable on the next pass).
    const base: OfflineReversalIntent = {
      ...intent,
      serverResult: response ?? intent.serverResult,
      lastSyncedAt: nowIso,
      syncLeaseOwner: null,
      syncLeaseExpiresAt: null,
    };

    if (classification === 'accepted') {
      const accepted: OfflineReversalIntent = { ...base, status: 'server_accepted' };
      await txn.put('intents', intentId, accepted);
      const marker = await txn.get<LocalMutationMarker>('markers', intent.localMutationId);
      if (marker) {
        await txn.put('markers', intent.localMutationId, { ...marker, serverConfirmed: true });
      }
      // stock already corrected locally; server is authoritative — do NOT re-apply
      return { outcome: 'applied', intent: accepted };
    }

    if (classification === 'retryable') {
      const retry: OfflineReversalIntent = {
        ...base,
        status: 'retryable_error',
        errorMessage: response?.message ?? (outcome.kind === 'network_error' ? 'network_error' : undefined),
      };
      await txn.put('intents', intentId, retry);
      return { outcome: 'applied', intent: retry }; // local correction stays applied
    }

    if (classification === 'manual_review') {
      const manual: OfflineReversalIntent = {
        ...base,
        status: 'manual_review_required',
        rejectionCode: response?.rejectCode,
        errorMessage: response?.message,
      };
      await txn.put('intents', intentId, manual);
      return { outcome: 'applied', intent: manual }; // server asked for manual reconciliation
    }

    // rejected_rollback_eligible — FAIL-CLOSED gate (Blocker 3). Auto-rollback only
    // if a proof AFFIRMATIVELY proves dependency safety. No proof / unknown / a
    // throwing proof ⇒ unsafe ⇒ manual review with the correction preserved.
    let proven = false;
    if (proveRollbackSafe) {
      try {
        proven = await proveRollbackSafe({ intent, txn });
      } catch {
        proven = false; // unknown/incomplete evidence → fail closed
      }
    }
    if (!isRollbackSafe(proven)) {
      const manual: OfflineReversalIntent = {
        ...base,
        status: 'manual_review_required',
        rejectionCode: response?.rejectCode,
        errorMessage: response?.message,
      };
      await txn.put('intents', intentId, manual);
      return { outcome: 'applied', intent: manual }; // not proven → manual review, correction preserved
    }

    // Safe rollback: reverse the local correction.
    if (intent.localCorrection.applied && !intent.localCorrection.reversed) {
      await applyDeltasToStock(txn, intentId, invertDeltas(intent.localCorrection.stockDelta), 'reverse', nowIso);
    }
    const rolledBack: OfflineReversalIntent = {
      ...base,
      status: 'server_rejected',
      rejectionCode: response?.rejectCode,
      errorMessage: response?.message,
      localCorrection: { ...intent.localCorrection, reversed: true },
    };
    await txn.put('intents', intentId, rolledBack);
    const marker = await txn.get<LocalMutationMarker>('markers', intent.localMutationId);
    if (marker) {
      await txn.put('markers', intent.localMutationId, { ...marker, reversed: true });
    }
    return { outcome: 'applied', intent: rolledBack };
  });
}

// ─── Manual-review resolution (Phase 7B-H2) ──────────────────────────────────

/** Discriminated outcome of {@link resolveManualReview} (state cases — never thrown). */
export type ResolveManualReviewOutcome = 'resolved' | 'already_resolved' | 'not_found' | 'not_eligible';

export type ResolveManualReviewResult = {
  outcome: ResolveManualReviewOutcome;
  /** The intent post-transition (`resolved`), unchanged (`already_resolved`/`not_eligible`), or null (`not_found`). */
  intent: OfflineReversalIntent | null;
};

/**
 * Operationally clear a `manual_review_required` intent (Phase 7B-H2). After a
 * Manager/Admin reconciles the authoritative store, this transitions the LOCAL intent
 * to `manual_review_resolved` (terminal, overlay-excluded) so the POS overlay drops the
 * pending delta and returns to the plain Firestore snapshot for that product.
 *
 * It does NOT roll back or invert the local stock correction (the POS overlay reads
 * intents, not the internal counter; the counter is left untouched by design) and does
 * NOT change any server/resolver state. The whole read-check-write runs in ONE atomic
 * transaction so concurrent calls cannot both transition.
 *
 * Authority + required-field guards (Staff actor, missing actor id, missing reason) throw
 * {@link ManualReviewResolveError} BEFORE any read/write. State cases are returned:
 *  - `resolved`         — transitioned + metadata stamped.
 *  - `already_resolved` — idempotent no-op; original metadata preserved (NOT overwritten).
 *  - `not_eligible`     — any other status / unapplied / already-reversed; no mutation.
 *  - `not_found`        — no such intent.
 */
export async function resolveManualReview(
  store: ReversalLocalStore,
  intentId: string,
  input: ManualReviewResolveInput,
  deps: QueueDeps = defaultDeps,
): Promise<ResolveManualReviewResult> {
  // Contract guards FIRST — throw before touching the store on misuse.
  assertManualReviewResolveInput(input);

  return store.transact(['intents'], 'readwrite', async (txn) => {
    const intent = await txn.get<OfflineReversalIntent>('intents', intentId);
    if (!intent) return { outcome: 'not_found', intent: null };
    // Idempotent: an already-resolved intent is returned untouched (metadata preserved).
    if (intent.status === 'manual_review_resolved') {
      return { outcome: 'already_resolved', intent };
    }
    if (!isManualReviewResolvable(intent)) {
      return { outcome: 'not_eligible', intent };
    }
    const resolved = buildResolvedManualReviewIntent(intent, input, deps.now());
    await txn.put('intents', intentId, resolved);
    return { outcome: 'resolved', intent: resolved };
  });
}

/** Read one intent by id. */
export async function getIntent(
  store: ReversalLocalStore,
  intentId: string,
): Promise<OfflineReversalIntent | null> {
  return store.transact(['intents'], 'readonly', async (txn) => {
    return (await txn.get<OfflineReversalIntent>('intents', intentId)) ?? null;
  });
}

/** List all queued intents, optionally filtered by status. */
export async function listQueue(
  store: ReversalLocalStore,
  statusFilter?: OfflineReversalIntent['status'][],
): Promise<OfflineReversalIntent[]> {
  return store.transact(['intents'], 'readonly', async (txn) => {
    const all = await txn.getAll<OfflineReversalIntent>('intents');
    const filtered = statusFilter ? all.filter((i) => statusFilter.includes(i.status)) : all;
    return filtered.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  });
}

/**
 * List every item a sync worker may claim right now (Blocker 1) — `queued`,
 * `retryable_error`, AND `syncing` items whose lease has expired (crash recovery).
 * Evaluated against `deps.now()`, ordered oldest-first.
 */
export async function listClaimable(
  store: ReversalLocalStore,
  deps: QueueDeps = defaultDeps,
): Promise<OfflineReversalIntent[]> {
  const nowIso = deps.now();
  return store.transact(['intents'], 'readonly', async (txn) => {
    const all = await txn.getAll<OfflineReversalIntent>('intents');
    return all
      .filter((i) => isClaimable(i, nowIso))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  });
}

/** Read a local stock counter (product × location). Returns 0 if unset. */
export async function readLocalStock(
  store: ReversalLocalStore,
  productId: string,
  locationId: string,
): Promise<number> {
  return store.transact(['stock'], 'readonly', async (txn) => readCounter(txn, productId, locationId));
}
