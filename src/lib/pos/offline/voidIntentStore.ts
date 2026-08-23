/**
 * PK-3 durable void-intent store consumer.
 *
 * Host: existing `twinpet-offline-reversal` object store `voidIntents` (DB v3).
 * This module NEVER opens a database. Callers inject a `ReversalLocalStore`.
 * No Firestore types — timestamps are epoch milliseconds.
 */

import { getCanonicalSyncContext } from './canonicalSyncContext';
import type { ReversalLocalStore } from './reversalLocalStore';

export const VOID_INTENTS_STORE = 'voidIntents' as const;
export const VOID_INTENT_SCHEMA_VERSION = 1 as const;
export const VOID_INTENT_CLAIM_LEASE_MS = 60_000;
export const UTC_PLUS_7_OFFSET_MS = 7 * 60 * 60 * 1000;

export type VoidErrorClass =
  | 'transport'
  | 'unavailable'
  | 'not_found'
  | 'permission_denied'
  | 'invalid_argument'
  | 'unknown';

export type VoidTerminalReason =
  | 'order_absent_server_side'
  | 'day_boundary_expired'
  | 'authority_refused'
  | 'order_already_terminal'
  | 'malformed_intent'
  | 'attempt_ceiling_reached'
  | 'staff_identity_mismatch';

export type VoidIntentClaimScope = {
  branchId: string;
  deviceId: string;
};

export type VoidIntentStatus = 'pending' | 'in_flight' | 'confirmed' | 'terminal';

export type VoidIntentRecord = {
  orderId: string;
  branchId: string;
  deviceId: string;
  reason: string;
  note: string | null;
  voidedBy: string;
  status: VoidIntentStatus;
  attempts: number;
  createdAtMs: number;
  updatedAtMs: number;
  nextEligibleAtMs: number;
  claimOwner: string | null;
  claimExpiresAtMs: number | null;
  lastErrorClass: VoidErrorClass | null;
  lastErrorAtMs: number | null;
  terminalReason: VoidTerminalReason | null;
  confirmedAtMs: number | null;
  observedServerCreatedAtMs: number | null;
  schemaVersion: typeof VOID_INTENT_SCHEMA_VERSION;
};

export type VoidIntentEnqueueInput = {
  branchId: string;
  deviceId: string;
  reason: string;
  note?: string | null;
  voidedBy: string;
};

export type VoidIntentEnqueueResult =
  | { kind: 'created'; record: VoidIntentRecord }
  | { kind: 'updated'; record: VoidIntentRecord }
  | { kind: 'confirmed_noop'; record: VoidIntentRecord }
  | { kind: 'terminal_noop'; record: VoidIntentRecord };

export type VoidPreflightServerOrder = {
  exists: boolean;
  serverCreatedAtMs: number | null;
  status?: string | null;
  voidRequested?: boolean | null;
};

export type VoidPreflightDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: 'not_online' }
  | { action: 'block'; reason: 'order_absent_server_side' }
  | { action: 'block'; reason: 'day_boundary_expired' }
  | { action: 'confirm'; reason: 'order_already_terminal' };

const voidIntentChangeListeners = new Set<() => void>();

function notifyVoidIntentStoreChanged(): void {
  for (const listener of [...voidIntentChangeListeners]) {
    try {
      listener();
    } catch {
      /* listener errors must not break durable writers */
    }
  }
}

/** Same-tab change notification. No BroadcastChannel and no new IndexedDB open. */
export function subscribeVoidIntentStore(listener: () => void): () => void {
  voidIntentChangeListeners.add(listener);
  return () => {
    voidIntentChangeListeners.delete(listener);
  };
}

/** @internal test-only */
export function __resetVoidIntentStoreListenersForTests(): void {
  voidIntentChangeListeners.clear();
}

/** Calendar date of (ms + 7h) in UTC — mirrors firestore.rules duration.value(7,'h').date(). */
export function utcPlus7Date(ms: number): string {
  const shifted = new Date(ms + UTC_PLUS_7_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function decideVoidPreflight(args: {
  serverOrder: VoidPreflightServerOrder | null;
  nowMs: number;
  isOnline: boolean;
}): VoidPreflightDecision {
  if (!args.isOnline) return { action: 'block', reason: 'not_online' };
  const order = args.serverOrder;
  if (!order || !order.exists || order.serverCreatedAtMs == null) {
    return { action: 'block', reason: 'order_absent_server_side' };
  }
  if (order.status === 'voided' || order.voidRequested === true) {
    return { action: 'confirm', reason: 'order_already_terminal' };
  }
  if (utcPlus7Date(order.serverCreatedAtMs) !== utcPlus7Date(args.nowMs)) {
    return { action: 'block', reason: 'day_boundary_expired' };
  }
  return { action: 'allow' };
}

function noteOf(input: VoidIntentEnqueueInput): string | null {
  const trimmed = input.note?.trim();
  return trimmed ? trimmed : null;
}

export async function enqueueVoidIntent(
  store: ReversalLocalStore,
  orderId: string,
  input: VoidIntentEnqueueInput,
  nowMs: number = Date.now(),
): Promise<VoidIntentEnqueueResult> {
  return store.transact([VOID_INTENTS_STORE], 'readwrite', async (txn) => {
    const existing = await txn.get<VoidIntentRecord>(VOID_INTENTS_STORE, orderId);
    if (!existing) {
      const record: VoidIntentRecord = {
        orderId,
        branchId: input.branchId,
        deviceId: input.deviceId,
        reason: input.reason,
        note: noteOf(input),
        voidedBy: input.voidedBy,
        status: 'pending',
        attempts: 0,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        nextEligibleAtMs: 0,
        claimOwner: null,
        claimExpiresAtMs: null,
        lastErrorClass: null,
        lastErrorAtMs: null,
        terminalReason: null,
        confirmedAtMs: null,
        observedServerCreatedAtMs: null,
        schemaVersion: VOID_INTENT_SCHEMA_VERSION,
      };
      await txn.put(VOID_INTENTS_STORE, orderId, record);
      return { kind: 'created' as const, record };
    }
    if (existing.status === 'confirmed') {
      return { kind: 'confirmed_noop' as const, record: existing };
    }
    if (existing.status === 'terminal') {
      return { kind: 'terminal_noop' as const, record: existing };
    }
    const record: VoidIntentRecord = {
      ...existing,
      reason: input.reason,
      note: noteOf(input),
      voidedBy: input.voidedBy,
      branchId: input.branchId,
      deviceId: input.deviceId,
      updatedAtMs: nowMs,
    };
    await txn.put(VOID_INTENTS_STORE, orderId, record);
    return { kind: 'updated' as const, record };
  }).then((result) => {
    if (result.kind === 'created' || result.kind === 'updated') {
      notifyVoidIntentStoreChanged();
    }
    return result;
  });
}

export async function claimVoidIntent(
  store: ReversalLocalStore,
  orderId: string,
  owner: string,
  nowMs: number,
  leaseMs: number = VOID_INTENT_CLAIM_LEASE_MS,
): Promise<VoidIntentRecord | null> {
  return store.transact([VOID_INTENTS_STORE], 'readwrite', async (txn) => {
    const rec = await txn.get<VoidIntentRecord>(VOID_INTENTS_STORE, orderId);
    if (!rec) return null;
    if (rec.status === 'confirmed' || rec.status === 'terminal') return null;
    if (
      rec.status === 'in_flight' &&
      rec.claimExpiresAtMs != null &&
      rec.claimExpiresAtMs > nowMs
    ) {
      return null;
    }
    if (rec.nextEligibleAtMs > nowMs) return null;
    const claimed: VoidIntentRecord = {
      ...rec,
      status: 'in_flight',
      claimOwner: owner,
      claimExpiresAtMs: nowMs + leaseMs,
      updatedAtMs: nowMs,
    };
    await txn.put(VOID_INTENTS_STORE, orderId, claimed);
    return claimed;
  }).then((claimed) => {
    if (claimed) notifyVoidIntentStoreChanged();
    return claimed;
  });
}

export async function markVoidIntentConfirmed(
  store: ReversalLocalStore,
  orderId: string,
  nowMs: number,
  observedServerCreatedAtMs: number | null = null,
): Promise<VoidIntentRecord | null> {
  return store.transact([VOID_INTENTS_STORE], 'readwrite', async (txn) => {
    const rec = await txn.get<VoidIntentRecord>(VOID_INTENTS_STORE, orderId);
    if (!rec) return null;
    const next: VoidIntentRecord = {
      ...rec,
      status: 'confirmed',
      confirmedAtMs: nowMs,
      updatedAtMs: nowMs,
      claimOwner: null,
      claimExpiresAtMs: null,
      terminalReason: null,
      observedServerCreatedAtMs: observedServerCreatedAtMs ?? rec.observedServerCreatedAtMs,
    };
    await txn.put(VOID_INTENTS_STORE, orderId, next);
    return next;
  }).then((next) => {
    if (next) notifyVoidIntentStoreChanged();
    return next;
  });
}

export async function markVoidIntentTerminal(
  store: ReversalLocalStore,
  orderId: string,
  reason: VoidTerminalReason,
  errorClass: VoidErrorClass,
  nowMs: number,
): Promise<VoidIntentRecord | null> {
  return store.transact([VOID_INTENTS_STORE], 'readwrite', async (txn) => {
    const rec = await txn.get<VoidIntentRecord>(VOID_INTENTS_STORE, orderId);
    if (!rec) return null;
    const next: VoidIntentRecord = {
      ...rec,
      status: 'terminal',
      terminalReason: reason,
      lastErrorClass: errorClass,
      lastErrorAtMs: nowMs,
      updatedAtMs: nowMs,
      claimOwner: null,
      claimExpiresAtMs: null,
    };
    await txn.put(VOID_INTENTS_STORE, orderId, next);
    return next;
  }).then((next) => {
    if (next) notifyVoidIntentStoreChanged();
    return next;
  });
}

export async function markVoidIntentRetryable(
  store: ReversalLocalStore,
  orderId: string,
  errorClass: VoidErrorClass,
  nextEligibleAtMs: number,
  nowMs: number,
): Promise<VoidIntentRecord | null> {
  return store.transact([VOID_INTENTS_STORE], 'readwrite', async (txn) => {
    const rec = await txn.get<VoidIntentRecord>(VOID_INTENTS_STORE, orderId);
    if (!rec) return null;
    const next: VoidIntentRecord = {
      ...rec,
      status: 'pending',
      attempts: rec.attempts + 1,
      lastErrorClass: errorClass,
      lastErrorAtMs: nowMs,
      nextEligibleAtMs,
      updatedAtMs: nowMs,
      claimOwner: null,
      claimExpiresAtMs: null,
    };
    await txn.put(VOID_INTENTS_STORE, orderId, next);
    return next;
  }).then((next) => {
    if (next) notifyVoidIntentStoreChanged();
    return next;
  });
}

/** Pre-flight block that is NOT an attempt (PF-1 wait-for-sale). */
export async function deferVoidIntentPending(
  store: ReversalLocalStore,
  orderId: string,
  nextEligibleAtMs: number,
  nowMs: number,
  observedServerCreatedAtMs: number | null = null,
): Promise<VoidIntentRecord | null> {
  return store.transact([VOID_INTENTS_STORE], 'readwrite', async (txn) => {
    const rec = await txn.get<VoidIntentRecord>(VOID_INTENTS_STORE, orderId);
    if (!rec) return null;
    const next: VoidIntentRecord = {
      ...rec,
      status: 'pending',
      nextEligibleAtMs,
      updatedAtMs: nowMs,
      claimOwner: null,
      claimExpiresAtMs: null,
      lastErrorClass: 'not_found',
      lastErrorAtMs: nowMs,
      observedServerCreatedAtMs,
    };
    await txn.put(VOID_INTENTS_STORE, orderId, next);
    return next;
  }).then((next) => {
    if (next) notifyVoidIntentStoreChanged();
    return next;
  });
}

export async function clearVoidIntentBackoff(
  store: ReversalLocalStore,
  nowMs: number,
): Promise<number> {
  return store.transact([VOID_INTENTS_STORE], 'readwrite', async (txn) => {
    const all = await txn.getAll<VoidIntentRecord>(VOID_INTENTS_STORE);
    let cleared = 0;
    for (const rec of all) {
      if (rec.status === 'confirmed' || rec.status === 'terminal') continue;
      if (rec.nextEligibleAtMs <= 0) continue;
      await txn.put(VOID_INTENTS_STORE, rec.orderId, {
        ...rec,
        nextEligibleAtMs: 0,
        updatedAtMs: nowMs,
      });
      cleared += 1;
    }
    return cleared;
  }).then((cleared) => {
    if (cleared > 0) notifyVoidIntentStoreChanged();
    return cleared;
  });
}

export async function getVoidIntent(
  store: ReversalLocalStore,
  orderId: string,
): Promise<VoidIntentRecord | undefined> {
  return store.transact([VOID_INTENTS_STORE], 'readonly', (txn) =>
    txn.get<VoidIntentRecord>(VOID_INTENTS_STORE, orderId),
  );
}

export async function listVoidIntents(store: ReversalLocalStore): Promise<VoidIntentRecord[]> {
  return store.transact([VOID_INTENTS_STORE], 'readonly', (txn) =>
    txn.getAll<VoidIntentRecord>(VOID_INTENTS_STORE),
  );
}

export async function listTerminalVoidIntents(
  store: ReversalLocalStore,
): Promise<VoidIntentRecord[]> {
  const all = await listVoidIntents(store);
  return all.filter((r) => r.status === 'terminal');
}

export async function countTerminalVoidIntents(store: ReversalLocalStore): Promise<number> {
  const rows = await listTerminalVoidIntents(store);
  return rows.length;
}

export type ClearVoidBackoffOutcome =
  | 'cleared'
  | 'already_eligible'
  | 'not_pending'
  | 'in_flight_claim_live'
  | 'confirmed'
  | 'terminal'
  | 'out_of_scope'
  | 'absent';

export async function clearVoidIntentBackoffForOrder(
  store: ReversalLocalStore,
  orderId: string,
  nowMs: number,
): Promise<{ outcome: ClearVoidBackoffOutcome; record: VoidIntentRecord | null }> {
  const early = getCanonicalSyncContext();
  if (!early) return { outcome: 'out_of_scope', record: null };

  return store
    .transact([VOID_INTENTS_STORE], 'readwrite', async (txn) => {
      const rec = await txn.get<VoidIntentRecord>(VOID_INTENTS_STORE, orderId);
      const canonical = getCanonicalSyncContext();
      if (!rec) return { outcome: 'absent' as const, record: null };
      if (
        !canonical ||
        rec.branchId !== canonical.branchId ||
        rec.deviceId !== canonical.deviceId
      ) {
        return { outcome: 'out_of_scope' as const, record: rec };
      }
      if (rec.status === 'confirmed') return { outcome: 'confirmed' as const, record: rec };
      if (rec.status === 'terminal') return { outcome: 'terminal' as const, record: rec };
      if (
        rec.status === 'in_flight' &&
        rec.claimExpiresAtMs != null &&
        rec.claimExpiresAtMs > nowMs
      ) {
        return { outcome: 'in_flight_claim_live' as const, record: rec };
      }
      if (rec.status !== 'pending') return { outcome: 'not_pending' as const, record: rec };
      if (rec.nextEligibleAtMs <= nowMs) {
        return { outcome: 'already_eligible' as const, record: rec };
      }
      const next: VoidIntentRecord = {
        ...rec,
        nextEligibleAtMs: 0,
        updatedAtMs: nowMs,
      };
      await txn.put(VOID_INTENTS_STORE, orderId, next);
      return { outcome: 'cleared' as const, record: next };
    })
    .then((result) => {
      if (result.outcome === 'cleared') notifyVoidIntentStoreChanged();
      return result;
    });
}

export async function listClaimableVoidIntents(
  store: ReversalLocalStore,
  nowMs: number,
  scope: VoidIntentClaimScope,
): Promise<VoidIntentRecord[]> {
  const all = await listVoidIntents(store);
  return all.filter((rec) => {
    if (rec.branchId !== scope.branchId) return false;
    if (rec.deviceId !== scope.deviceId) return false;
    if (rec.status === 'confirmed' || rec.status === 'terminal') return false;
    if (rec.nextEligibleAtMs > nowMs) return false;
    if (
      rec.status === 'in_flight' &&
      rec.claimExpiresAtMs != null &&
      rec.claimExpiresAtMs > nowMs
    ) {
      return false;
    }
    return true;
  });
}
