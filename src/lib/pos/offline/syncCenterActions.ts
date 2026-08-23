/**
 * PK-4 Sync Center — action orchestration.
 * Channel-first S4 handling: void object result vs reversal string result.
 */

import { getCanonicalSyncContext } from './canonicalSyncContext';
import {
  buildGlobalResweepRequest,
  buildItemRetryRequest,
  type SyncCenterActor,
} from './syncCenterAuthority';
import type { ActiveSyncScope, SyncCenterRow } from './syncCenterModel';
import type { ReversalLocalStore } from './reversalLocalStore';
import {
  requestSyncOrchestratorCycle,
  requestSyncOrchestratorItemRetryCycle,
  clearOfflineReversalRetryEligibility,
  type SyncOrchestratorAuthContext,
  type SyncOrchestratorDeps,
} from './syncOrchestrator';
import {
  clearVoidIntentBackoffForOrder,
  type VoidIntentRecord,
} from './voidIntentStore';

export type SyncCenterItemActionCycle = 'not_run' | 'requested';

export type SyncCenterItemActionResult = {
  mutation: 'cleared' | 'noop';
  mutationReason: string | null;
  cycle: SyncCenterItemActionCycle;
  rowAfter: VoidIntentRecord | null;
};

export type SyncCenterResweepResult = {
  accepted: boolean;
  reason: string | null;
  cycle: SyncCenterItemActionCycle;
};

function buildItemActionResult(args: {
  mutation: 'cleared' | 'noop';
  mutationReason: string | null;
  cycle: SyncCenterItemActionCycle;
  rowAfter: VoidIntentRecord | null;
}): SyncCenterItemActionResult {
  return {
    mutation: args.mutation,
    mutationReason: args.mutationReason,
    cycle: args.cycle,
    rowAfter: args.rowAfter,
  };
}

export async function retrySyncCenterItem(args: {
  actor: SyncCenterActor;
  row: SyncCenterRow;
  scope: ActiveSyncScope;
  isOnline: boolean;
  nowMs: number;
  store: ReversalLocalStore;
  ctxRef?: { current: SyncOrchestratorAuthContext };
  orchestratorDeps?: SyncOrchestratorDeps;
}): Promise<SyncCenterItemActionResult> {
  const built = buildItemRetryRequest(args.actor, args.row, args.scope, args.isOnline, args.nowMs);
  if (!built.ok) {
    return buildItemActionResult({
      mutation: 'noop',
      mutationReason: built.error,
      cycle: 'not_run',
      rowAfter: null,
    });
  }

  const request = built.request;

  if (request.channel === 'void_intent') {
    const voidResult = await clearVoidIntentBackoffForOrder(args.store, request.orderId, args.nowMs);
    if (voidResult.outcome === 'out_of_scope') {
      return buildItemActionResult({
        mutation: 'noop',
        mutationReason: voidResult.outcome,
        cycle: 'not_run',
        rowAfter: voidResult.record,
      });
    }
    const result = buildItemActionResult({
      mutation: voidResult.outcome === 'cleared' ? 'cleared' : 'noop',
      mutationReason: voidResult.outcome,
      cycle: 'requested',
      rowAfter: voidResult.record,
    });
    void requestSyncOrchestratorItemRetryCycle(args.ctxRef, args.orchestratorDeps);
    return result;
  }

  if (request.channel === 'offline_reversal') {
    const reversalResult = await clearOfflineReversalRetryEligibility(
      args.store,
      request.intentId,
      args.nowMs,
    );
    if (reversalResult === 'out_of_scope') {
      return buildItemActionResult({
        mutation: 'noop',
        mutationReason: reversalResult,
        cycle: 'not_run',
        rowAfter: null,
      });
    }
    const result = buildItemActionResult({
      mutation: reversalResult === 'cleared' ? 'cleared' : 'noop',
      mutationReason: reversalResult,
      cycle: 'requested',
      rowAfter: null,
    });
    void requestSyncOrchestratorItemRetryCycle(args.ctxRef, args.orchestratorDeps);
    return result;
  }

  const _exhaustive: never = request;
  return _exhaustive;
}

export async function triggerSyncCenterResweep(args: {
  actor: SyncCenterActor;
  scope: ActiveSyncScope | null;
  isOnline: boolean;
  ctxRef?: { current: SyncOrchestratorAuthContext };
  orchestratorDeps?: SyncOrchestratorDeps;
}): Promise<SyncCenterResweepResult> {
  const built = buildGlobalResweepRequest(args.actor, args.scope, args.isOnline);
  if (!built.ok) {
    return { accepted: false, reason: built.error, cycle: 'not_run' };
  }
  void requestSyncOrchestratorCycle(
    'operator_manual_resweep',
    args.ctxRef,
    args.orchestratorDeps,
  );
  return { accepted: true, reason: null, cycle: 'requested' };
}

export function canonicalContextIsLive(): boolean {
  return getCanonicalSyncContext() != null;
}
