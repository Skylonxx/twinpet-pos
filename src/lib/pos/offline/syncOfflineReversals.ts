/**
 * Offline Reversal Queue — sync worker  [Phase 7B-3D-3]
 *
 * Drains the durable queue to the server `resolveReversal` resolver
 * (functions/src/resolveReversal.ts) when online. The network call itself is
 * INJECTABLE (`callResolveReversal`) so the worker's queue/race logic stays unit
 * testable; the default implementation wires the Firebase callable exactly like
 * retryReconcile.ts / verifyPinLogin.ts.
 *
 * Race discipline (delegated to offlineReversalQueue):
 *   - claimForSync flips queued→syncing atomically (single in-flight item).
 *   - a network/transport failure becomes `retryable_error` (NEVER a rejection) so
 *     the local correction is preserved and the item is retried on the next pass.
 *   - server accept/reject/manual-review is folded back via applyServerResult.
 *
 * This module is NOT auto-started anywhere in this phase (UI/lifecycle wiring is
 * deferred). It is a callable engine.
 */

import type { ServerReversalResponse } from './offlineReversalLogic';
import {
  applyServerResult,
  claimForSync,
  claimTokenOf,
  listClaimable,
  type ApplyServerResultOutcome,
  type QueueDeps,
  type RollbackSafetyProof,
  type SyncOutcome,
} from './offlineReversalQueue';
import type { OfflineReversalIntent } from './offlineReversalTypes';
import type { ReversalLocalStore } from './reversalLocalStore';

/** Options threaded through the sync worker into claim + result handling. */
export type SyncOptions = {
  /** Worker identity stamped on the sync lease (Blocker 1). */
  owner?: string;
  /** Lease window in ms. */
  leaseMs?: number;
  /** Fail-closed rollback-safety proof (Blocker 3). Omit to never auto-rollback. */
  proveRollbackSafe?: RollbackSafetyProof;
  deps?: QueueDeps;
};

/** The request the server resolver expects (subset — see resolveReversal.ts). */
export type ResolveReversalRequest = {
  idempotencyKey: string;
  actionType: 'receiving_reversal' | 'transfer_reversal';
  sourceDocumentId: string;
  sourceDocumentType: 'receiving' | 'transfer';
  branchId: string;
  terminalId?: string;
  reasonCode: string;
  reasonNote?: string;
  localIntentId: string;
};

/** Network transport for a single reversal request. Injected for testability. */
export type CallResolveReversal = (req: ResolveReversalRequest) => Promise<ServerReversalResponse>;

/** Map a queued intent to the server resolver's request payload. */
export function toResolveRequest(intent: OfflineReversalIntent): ResolveReversalRequest {
  return {
    idempotencyKey: intent.idempotencyKey,
    actionType: intent.sourceType === 'receiving' ? 'receiving_reversal' : 'transfer_reversal',
    sourceDocumentId: intent.sourceId,
    sourceDocumentType: intent.sourceType,
    branchId: intent.branchId,
    terminalId: intent.terminalId ?? undefined,
    reasonCode: intent.reasonCode,
    reasonNote: intent.reasonNote ?? undefined,
    localIntentId: intent.id,
  };
}

export type SyncOneResult = {
  intentId: string;
  /** `null` when the item was not claimable (already syncing/terminal). */
  intent: OfflineReversalIntent | null;
  claimed: boolean;
  /** How `applyServerResult` resolved (only set when `claimed`). `stale_noop` means a
   *  newer claim superseded this worker and its result was dropped. */
  applyOutcome?: ApplyServerResultOutcome;
};

/**
 * Sync a single intent: claim it, call the server, fold the result back. A thrown
 * transport error is captured as a `network_error` outcome (retryable) — it is never
 * allowed to escape as a rejection.
 */
export async function syncOneReversal(
  store: ReversalLocalStore,
  intentId: string,
  call: CallResolveReversal,
  options: SyncOptions = {},
): Promise<SyncOneResult> {
  const claimed = await claimForSync(store, intentId, {
    owner: options.owner,
    leaseMs: options.leaseMs,
    deps: options.deps,
  });
  if (!claimed) return { intentId, intent: null, claimed: false };

  // Capture the claim token BEFORE the (possibly slow) network call, so a stalled
  // worker carries proof of WHICH claim it held — verified inside applyServerResult.
  const token = claimTokenOf(claimed);

  let outcome: SyncOutcome;
  try {
    const response = await call(toResolveRequest(claimed));
    outcome = { kind: 'response', response };
  } catch (error) {
    outcome = { kind: 'network_error', error };
  }

  const result = await applyServerResult(store, token, outcome, {
    proveRollbackSafe: options.proveRollbackSafe,
    deps: options.deps,
  });
  return { intentId, intent: result.intent, claimed: true, applyOutcome: result.outcome };
}

/**
 * Drain every CLAIMABLE item — `queued`, `retryable_error`, and `syncing` items
 * whose lease has expired (crash/reload recovery, Blocker 1). Items are processed
 * sequentially; each claim is atomic so a concurrent drain (or a still-live lease
 * held by another worker) can never double-process. Returns the per-item results.
 */
export async function syncPendingReversals(
  store: ReversalLocalStore,
  call: CallResolveReversal,
  options: SyncOptions = {},
): Promise<SyncOneResult[]> {
  const pending = await listClaimable(store, options.deps);
  const results: SyncOneResult[] = [];
  for (const item of pending) {
    results.push(await syncOneReversal(store, item.id, call, options));
  }
  return results;
}

// ─── Default Firebase callable transport ─────────────────────────────────────
// Lazily imported so the pure engine above never pulls Firebase into unit tests.

let cachedCall: CallResolveReversal | null = null;

/**
 * The production transport — wires the Firebase `resolveReversal` callable with the
 * same region/emulator handling as retryReconcile.ts. Created lazily and cached.
 */
export async function getDefaultCallResolveReversal(): Promise<CallResolveReversal> {
  if (cachedCall) return cachedCall;
  const [{ getFunctions, httpsCallable, connectFunctionsEmulator }, { app, USE_EMULATOR }] =
    await Promise.all([import('firebase/functions'), import('../../firebase')]);
  if (!app) throw new Error('Firebase not configured');
  const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);
  if (USE_EMULATOR) {
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }
  const callable = httpsCallable<ResolveReversalRequest, ServerReversalResponse>(
    functions,
    'resolveReversal',
  );
  cachedCall = async (req) => (await callable(req)).data;
  return cachedCall;
}
