import { afterEach, describe, expect, it } from 'vitest';
import {
  allowedActionsForRow,
  buildGlobalResweepRequest,
  buildItemRetryRequest,
  canActOnItem,
  canOpenAdminReconciliation,
  canTriggerGlobalResweep,
  canViewSyncCenter,
} from './syncCenterAuthority';
import {
  resolveActiveSyncScope,
  type ActiveSyncScope,
  type SyncCenterRow,
} from './syncCenterModel';
import {
  __resetCanonicalSyncContextForTests,
  __setCanonicalSyncContextForTests,
} from './canonicalSyncContext';

const NOW = 1_700_000_000_000;

function scopeA(): ActiveSyncScope {
  const r = resolveActiveSyncScope('A', 'X');
  if (!r.ok) throw new Error(r.reason);
  return r.scope;
}

function row(over: Partial<SyncCenterRow> & Pick<SyncCenterRow, 'channel' | 'id' | 'state'>): SyncCenterRow {
  return {
    scopeKind: 'branch_device',
    branchId: 'A',
    deviceId: 'X',
    createdAtMs: NOW,
    updatedAtMs: NOW,
    attempts: 1,
    nextEligibleAtMs: NOW + 5_000,
    reasonCode: over.reasonCode ?? over.state,
    reasonTh: 'x',
    lastErrorAtMs: null,
    isStale: false,
    attemptCeilingReached: false,
    shiftKind: null,
    actionable: [],
    ...over,
  };
}

afterEach(() => {
  __resetCanonicalSyncContextForTests();
});

describe('syncCenterAuthority', () => {
  it('N-B1 cashier may view and globally resweep', () => {
    expect(canViewSyncCenter('staff')).toBe(true);
    expect(canTriggerGlobalResweep('staff')).toBe(true);
    expect(canTriggerGlobalResweep('manager')).toBe(true);
    expect(canTriggerGlobalResweep('admin')).toBe(true);
  });

  it('N-B2 cashier never gets item_retry_now', () => {
    const s = scopeA();
    const delayed = row({
      channel: 'void_intent',
      id: 'v1',
      state: 'waiting_retry',
      nextEligibleAtMs: NOW + 9_000,
    });
    expect(allowedActionsForRow('staff', delayed, s, NOW)).not.toContain('item_retry_now');
    expect(canActOnItem('staff', delayed, s, NOW)).toBe(false);
  });

  it('N-B3 manager item retry only on eligible non-terminal void/reversal', () => {
    const s = scopeA();
    const delayed = row({
      channel: 'void_intent',
      id: 'v1',
      state: 'waiting_retry',
      nextEligibleAtMs: NOW + 9_000,
    });
    expect(allowedActionsForRow('manager', delayed, s, NOW)).toEqual(['item_retry_now']);
    expect(
      allowedActionsForRow(
        'manager',
        row({ channel: 'void_intent', id: 't', state: 'attention', reasonCode: 'terminal' }),
        s,
        NOW,
      ),
    ).toEqual([]);
    expect(
      allowedActionsForRow(
        'manager',
        row({
          channel: 'offline_reversal',
          id: 'r',
          state: 'pending',
          reasonCode: 'queued',
          deviceId: null,
          scopeKind: 'branch',
        }),
        s,
        NOW,
      ),
    ).toEqual(['item_retry_now']);
    expect(
      allowedActionsForRow(
        'manager',
        row({
          channel: 'offline_reversal',
          id: 'ex',
          state: 'attention',
          attemptCeilingReached: true,
          reasonCode: 'attempt_ceiling_reached',
        }),
        s,
        NOW,
      ),
    ).toEqual([]);
    expect(
      allowedActionsForRow(
        'manager',
        row({ channel: 'sale_intent', id: 's', state: 'pending' }),
        s,
        NOW,
      ),
    ).toEqual([]);
    expect(
      allowedActionsForRow(
        'manager',
        row({ channel: 'shift_intent', id: 'c', state: 'pending' }),
        s,
        NOW,
      ),
    ).toEqual([]);
  });

  it('N-B5 UI absence is not authority — staff request is unauthorized', () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const s = scopeA();
    const delayed = row({
      channel: 'void_intent',
      id: 'v1',
      state: 'waiting_retry',
      nextEligibleAtMs: NOW + 9_000,
    });
    expect(buildItemRetryRequest({ role: 'staff' }, delayed, s, true, NOW)).toEqual({
      ok: false,
      error: 'unauthorized',
    });
    expect(buildGlobalResweepRequest({ role: 'staff' }, s, false)).toEqual({
      ok: false,
      error: 'offline',
    });
  });

  it('null-device rows are never actionable', () => {
    const s = scopeA();
    expect(
      allowedActionsForRow(
        'admin',
        row({
          channel: 'shift_intent',
          id: 'c',
          state: 'attention',
          deviceId: null,
          scopeKind: 'branch',
        }),
        s,
        NOW,
      ),
    ).toEqual([]);
  });

  it('stale_scope when canonical does not match view scope', () => {
    __setCanonicalSyncContextForTests('B', 'X');
    const s = scopeA();
    const delayed = row({
      channel: 'void_intent',
      id: 'v1',
      state: 'waiting_retry',
      nextEligibleAtMs: NOW + 9_000,
    });
    expect(buildItemRetryRequest({ role: 'manager' }, delayed, s, true, NOW)).toEqual({
      ok: false,
      error: 'stale_scope',
    });
  });

  it('N-B4 admin gains no terminal revival; admin reconciliation is admin-only', () => {
    expect(canOpenAdminReconciliation('admin')).toBe(true);
    expect(canOpenAdminReconciliation('manager')).toBe(false);
    expect(canOpenAdminReconciliation('staff')).toBe(false);
    const s = scopeA();
    const terminal = row({ channel: 'void_intent', id: 't', state: 'attention', reasonCode: 'terminal' });
    expect(allowedActionsForRow('admin', terminal, s, NOW)).toEqual([]);
  });

  it('terminal void is terminal_read_only for every role including admin', () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const s = scopeA();
    const terminal = row({ channel: 'void_intent', id: 't', state: 'attention', reasonCode: 'terminal' });
    expect(buildItemRetryRequest({ role: 'admin' }, terminal, s, true, NOW)).toEqual({
      ok: false,
      error: 'terminal_read_only',
    });
    expect(buildItemRetryRequest({ role: 'manager' }, terminal, s, true, NOW)).toEqual({
      ok: false,
      error: 'terminal_read_only',
    });
    expect(buildItemRetryRequest({ role: 'staff' }, terminal, s, true, NOW)).toEqual({
      ok: false,
      error: 'terminal_read_only',
    });
  });
});
