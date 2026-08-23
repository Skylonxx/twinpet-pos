/**
 * PK-4 Sync Center — pure authority. No I/O. No React.
 * UI gating is defence in depth; this layer refuses independently.
 */

import { getCanonicalSyncContext } from './canonicalSyncContext';
import type { UserRole } from '../../types';
import type {
  ActiveSyncScope,
  SyncCenterActionId,
  SyncCenterRow,
} from './syncCenterModel';

export type SyncCenterActorRole = UserRole;

export type SyncCenterActor = {
  role: SyncCenterActorRole;
};

export type ItemRetryRefusal =
  | 'unauthorized'
  | 'out_of_scope'
  | 'not_eligible'
  | 'offline'
  | 'terminal_read_only'
  | 'unknown_device'
  | 'stale_scope';

export type BoundedItemRetryRequest =
  | { channel: 'void_intent'; orderId: string }
  | { channel: 'offline_reversal'; intentId: string };

export type BuildItemRetryRequestResult =
  | { ok: true; request: BoundedItemRetryRequest }
  | { ok: false; error: ItemRetryRefusal };

export type BuildGlobalResweepResult =
  | { ok: true }
  | { ok: false; error: Extract<ItemRetryRefusal, 'unauthorized' | 'offline' | 'stale_scope'> };

export function canViewSyncCenter(_role: SyncCenterActorRole): boolean {
  return true;
}

export function canTriggerGlobalResweep(_role: SyncCenterActorRole): boolean {
  return true;
}

function roleMayMutateItem(role: SyncCenterActorRole): boolean {
  return role === 'manager' || role === 'admin';
}

function rowMatchesScope(row: SyncCenterRow, scope: ActiveSyncScope): boolean {
  if (row.branchId !== scope.branchId) return false;
  if (row.channel === 'offline_reversal') return true;
  if (row.channel === 'shift_intent') return row.deviceId === scope.deviceId || row.deviceId == null;
  if (row.deviceId !== scope.deviceId) return false;
  return true;
}

function canonicalMatchesScope(scope: ActiveSyncScope): boolean {
  const canonical = getCanonicalSyncContext();
  if (!canonical) return false;
  return canonical.branchId === scope.branchId && canonical.deviceId === scope.deviceId;
}

export function canActOnItem(
  role: SyncCenterActorRole,
  row: SyncCenterRow,
  scope: ActiveSyncScope,
  nowMs: number,
): boolean {
  return allowedActionsForRow(role, row, scope, nowMs).includes('item_retry_now');
}

export function allowedActionsForRow(
  role: SyncCenterActorRole,
  row: SyncCenterRow,
  scope: ActiveSyncScope,
  nowMs: number,
): SyncCenterActionId[] {
  if (row.deviceId === null && row.channel !== 'offline_reversal') return [];
  if (!rowMatchesScope(row, scope)) return [];

  const actions: SyncCenterActionId[] = [];
  const managerTier = roleMayMutateItem(role);

  if (row.channel === 'void_intent') {
    if (row.state === 'attention') return [];
    if (
      managerTier &&
      row.state === 'waiting_retry' &&
      row.nextEligibleAtMs != null &&
      row.nextEligibleAtMs > nowMs
    ) {
      actions.push('item_retry_now');
    }
    return actions;
  }

  if (row.channel === 'offline_reversal') {
    if (row.attemptCeilingReached) return [];
    if (row.state === 'attention' && row.reasonCode === 'manual_review_required') {
      if (managerTier) actions.push('open_manual_review');
      return actions;
    }
    if (
      managerTier &&
      (row.reasonCode === 'queued' || row.reasonCode === 'retryable_error') &&
      (row.state === 'pending' || row.state === 'waiting_retry')
    ) {
      actions.push('item_retry_now');
    }
    return actions;
  }

  if (row.channel === 'shift_intent') {
    if (row.state === 'attention' && managerTier) {
      actions.push('open_shift_close_review');
    }
    return actions;
  }

  return [];
}

export function buildItemRetryRequest(
  actor: SyncCenterActor,
  row: SyncCenterRow,
  scope: ActiveSyncScope,
  isOnline: boolean,
  nowMs: number,
): BuildItemRetryRequestResult {
  if (!canonicalMatchesScope(scope)) return { ok: false, error: 'stale_scope' };
  if (!isOnline) return { ok: false, error: 'offline' };
  if (!rowMatchesScope(row, scope)) return { ok: false, error: 'out_of_scope' };
  if (row.deviceId === null && row.channel !== 'offline_reversal') {
    return { ok: false, error: 'unknown_device' };
  }
  if (row.channel === 'void_intent' && row.state === 'attention') {
    return { ok: false, error: 'terminal_read_only' };
  }
  if (row.attemptCeilingReached) return { ok: false, error: 'not_eligible' };
  if (!roleMayMutateItem(actor.role)) return { ok: false, error: 'unauthorized' };
  if (!allowedActionsForRow(actor.role, row, scope, nowMs).includes('item_retry_now')) {
    return { ok: false, error: 'not_eligible' };
  }
  if (row.channel === 'void_intent') {
    return { ok: true, request: { channel: 'void_intent', orderId: row.id } };
  }
  if (row.channel === 'offline_reversal') {
    return { ok: true, request: { channel: 'offline_reversal', intentId: row.id } };
  }
  return { ok: false, error: 'not_eligible' };
}

export function buildGlobalResweepRequest(
  actor: SyncCenterActor,
  scope: ActiveSyncScope | null,
  isOnline: boolean,
): BuildGlobalResweepResult {
  if (!scope) return { ok: false, error: 'stale_scope' };
  if (!canonicalMatchesScope(scope)) return { ok: false, error: 'stale_scope' };
  if (!isOnline) return { ok: false, error: 'offline' };
  if (!canTriggerGlobalResweep(actor.role)) return { ok: false, error: 'unauthorized' };
  return { ok: true };
}

export function canOpenAdminReconciliation(role: SyncCenterActorRole): boolean {
  return role === 'admin';
}
