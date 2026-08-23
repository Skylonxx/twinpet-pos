/**
 * PK-4 Sync Center live state.
 * Resolves view scope itself. Does NOT mount canonical mutation context.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../lib/hooks/useAuth';
import { getDeviceId } from '../../lib/pos/deviceId';
import {
  allowedActionsForRow,
  type SyncCenterActor,
} from '../../lib/pos/offline/syncCenterAuthority';
import {
  retrySyncCenterItem,
  triggerSyncCenterResweep,
  type SyncCenterItemActionResult,
  type SyncCenterResweepResult,
} from '../../lib/pos/offline/syncCenterActions';
import {
  buildSyncCenterAggregate,
  resolveActiveSyncScope,
  type ActiveSyncScope,
  type SyncCenterReadResult,
  type SyncCenterRow,
  type SyncCenterView,
} from '../../lib/pos/offline/syncCenterModel';
import { readSyncCenterSources, type SyncCenterReaderDeps } from '../../lib/pos/offline/syncCenterReader';
import { createIndexedDbReversalStore, type ReversalLocalStore } from '../../lib/pos/offline/reversalLocalStore';
import {
  subscribeSyncOrchestratorState,
  type SyncOrchestratorAuthContext,
  type SyncOrchestratorDeps,
} from '../../lib/pos/offline/syncOrchestrator';
import { subscribeVoidIntentStore } from '../../lib/pos/offline/voidIntentStore';
import { subscribeShiftCloseIntentNotifier } from '../../lib/pos/offline/shiftCloseIntentStore';

export type UseSyncCenterStateOptions = {
  now?: () => number;
  read?: typeof readSyncCenterSources;
  readerDeps?: SyncCenterReaderDeps;
  reversalStore?: ReversalLocalStore;
  intervalMs?: number;
  navigatorRef?: { onLine: boolean };
  addEventListener?: (type: 'online' | 'offline', fn: () => void) => void;
  removeEventListener?: (type: 'online' | 'offline', fn: () => void) => void;
  orchestratorDeps?: SyncOrchestratorDeps;
};

export type SyncCenterHookStatus = 'pending' | 'ready';

export type UseSyncCenterStateResult = {
  view: SyncCenterView;
  status: SyncCenterHookStatus;
  refresh: () => void;
  isBusy: boolean;
  isOnline: boolean;
  scope: ActiveSyncScope | null;
  actor: SyncCenterActor;
  retryItem: (row: SyncCenterRow) => Promise<SyncCenterItemActionResult>;
  resweep: () => Promise<SyncCenterResweepResult>;
};

const POLL_MS = 5_000;

function attachRowActions(
  view: SyncCenterView,
  actor: SyncCenterActor,
  scope: ActiveSyncScope | null,
  nowMs: number,
): SyncCenterView {
  if (view.status !== 'scoped' || !scope) return view;
  return {
    status: 'scoped',
    aggregate: {
      ...view.aggregate,
      rows: view.aggregate.rows.map((row) => ({
        ...row,
        actionable: allowedActionsForRow(actor.role, row, scope, nowMs),
      })),
    },
  };
}

function stripStaleCycle(result: SyncCenterReadResult, branchChangedAtMs: number): SyncCenterReadResult {
  const last = result.orchestrator.lastCycle;
  if (last && last.startedAtMs < branchChangedAtMs) {
    return {
      ...result,
      orchestrator: { ...result.orchestrator, lastCycle: null },
    };
  }
  return result;
}

export function useSyncCenterState(opts?: UseSyncCenterStateOptions): UseSyncCenterStateResult {
  const { user, session, branchId, firebaseUser } = useAuth();
  const actor: SyncCenterActor = { role: user?.role ?? 'staff' };
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const resolved = resolveActiveSyncScope(branchId, getDeviceId());
  const scope = resolved.ok ? resolved.scope : null;
  const scopeKey = resolved.ok
    ? `${resolved.scope.branchId}::${resolved.scope.deviceId}`
    : `unavailable:${resolved.reason}`;

  const nowFn = () => (optsRef.current?.now ?? Date.now)();
  const navOnline = (): boolean => {
    const nav = optsRef.current?.navigatorRef ?? (typeof navigator !== 'undefined' ? navigator : { onLine: true });
    return nav.onLine !== false;
  };

  const [view, setView] = useState<SyncCenterView>(() =>
    resolved.ok
      ? {
          status: 'scoped',
          aggregate: buildSyncCenterAggregate(
            {
              scope: resolved.scope,
              reversal: { ok: true, rows: [] },
              voidIntent: { ok: true, rows: [] },
              shiftClose: { ok: true, rows: [] },
              shiftOpen: { ok: true, rows: [] },
              saleIntent: { ok: true, rows: [] },
              orchestrator: {
                lastCycle: null,
                webLocksAvailable: true,
                ch4AttemptExhaustedIds: [],
              },
              isOnline: navOnline(),
            },
            nowFn(),
          ),
        }
      : { status: 'scope_unavailable', reason: resolved.reason },
  );
  const [status, setStatus] = useState<SyncCenterHookStatus>(resolved.ok ? 'pending' : 'ready');
  const [isBusy, setIsBusy] = useState(false);
  const [isOnline, setIsOnline] = useState(navOnline());

  const cancelledRef = useRef(false);
  const inFlightRef = useRef(false);
  const rerunRef = useRef(false);
  const branchChangedAtMsRef = useRef(0);
  const lastBranchRef = useRef<string | null>(scope?.branchId ?? null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const actorRef = useRef(actor);
  actorRef.current = actor;
  const storeRef = useRef<ReversalLocalStore>(opts?.reversalStore ?? createIndexedDbReversalStore());
  if (opts?.reversalStore) storeRef.current = opts.reversalStore;

  const ctxRef = useRef<SyncOrchestratorAuthContext>({ session, branchId, firebaseUser });
  ctxRef.current = { session, branchId, firebaseUser };

  if (scope?.branchId !== lastBranchRef.current) {
    lastBranchRef.current = scope?.branchId ?? null;
    branchChangedAtMsRef.current = nowFn();
  }

  const applyView = useCallback((next: SyncCenterView, nowMs: number) => {
    if (cancelledRef.current) return;
    setView(attachRowActions(next, actorRef.current, scopeRef.current, nowMs));
  }, []);

  const runRead = useCallback(async () => {
    const current = scopeRef.current;
    if (!current) {
      const resolution = resolveActiveSyncScope(ctxRef.current.branchId, getDeviceId());
      applyView(
        {
          status: 'scope_unavailable',
          reason: resolution.ok ? 'no_branch' : resolution.reason,
        },
        nowFn(),
      );
      setStatus('ready');
      return;
    }
    if (inFlightRef.current) {
      rerunRef.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      do {
        rerunRef.current = false;
        const read = optsRef.current?.read ?? readSyncCenterSources;
        const raw = await read(current, {
          ...optsRef.current?.readerDeps,
          isOnline: navOnline(),
        });
        if (cancelledRef.current) return;
        const scoped = stripStaleCycle(raw, branchChangedAtMsRef.current);
        const nowMs = nowFn();
        applyView({ status: 'scoped', aggregate: buildSyncCenterAggregate(scoped, nowMs) }, nowMs);
        setStatus('ready');
      } while (rerunRef.current && !cancelledRef.current);
    } catch {
      if (!cancelledRef.current) setStatus('ready');
    } finally {
      inFlightRef.current = false;
    }
  }, [applyView]);

  const refresh = useCallback(() => {
    void runRead();
  }, [runRead]);

  useEffect(() => {
    cancelledRef.current = false;
    if (!scope) {
      const resolution = resolveActiveSyncScope(branchId, getDeviceId());
      applyView(
        { status: 'scope_unavailable', reason: resolution.ok ? 'no_branch' : resolution.reason },
        nowFn(),
      );
      setStatus('ready');
      return;
    }
    void runRead();

    const unsubVoid = subscribeVoidIntentStore(() => {
      void runRead();
    });
    const unsubOrch = subscribeSyncOrchestratorState(() => {
      void runRead();
    });
    const unsubShift = subscribeShiftCloseIntentNotifier(() => {
      void runRead();
    });

    const interval = window.setInterval(() => {
      void runRead();
    }, optsRef.current?.intervalMs ?? POLL_MS);

    const onOnline = () => {
      setIsOnline(true);
      void runRead();
    };
    const onOffline = () => {
      setIsOnline(false);
      void runRead();
    };
    const add = optsRef.current?.addEventListener ?? ((type, fn) => window.addEventListener(type, fn));
    const remove = optsRef.current?.removeEventListener ?? ((type, fn) => window.removeEventListener(type, fn));
    add('online', onOnline);
    add('offline', onOffline);

    return () => {
      cancelledRef.current = true;
      unsubVoid();
      unsubOrch();
      unsubShift();
      window.clearInterval(interval);
      remove('online', onOnline);
      remove('offline', onOffline);
    };
  }, [applyView, runRead, scopeKey, branchId]);

  const retryItem = useCallback(
    async (row: SyncCenterRow): Promise<SyncCenterItemActionResult> => {
      const current = scopeRef.current;
      if (!current) {
        return { mutation: 'noop', mutationReason: 'stale_scope', cycle: 'not_run', rowAfter: null };
      }
      setIsBusy(true);
      try {
        const result = await retrySyncCenterItem({
          actor: actorRef.current,
          row,
          scope: current,
          isOnline: navOnline(),
          nowMs: nowFn(),
          store: storeRef.current,
          ctxRef,
          orchestratorDeps: optsRef.current?.orchestratorDeps,
        });
        await runRead();
        return result;
      } finally {
        setIsBusy(false);
      }
    },
    [runRead],
  );

  const resweep = useCallback(async (): Promise<SyncCenterResweepResult> => {
    const current = scopeRef.current;
    setIsBusy(true);
    try {
      const result = await triggerSyncCenterResweep({
        actor: actorRef.current,
        scope: current,
        isOnline: navOnline(),
        ctxRef,
        orchestratorDeps: optsRef.current?.orchestratorDeps,
      });
      await runRead();
      return result;
    } finally {
      setIsBusy(false);
    }
  }, [runRead]);

  return {
    view,
    status,
    refresh,
    isBusy,
    isOnline,
    scope,
    actor,
    retryItem,
    resweep,
  };
}
