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
import { subscribePrivilegedEvidenceStore } from '../../lib/pos/offline/privilegedEvidenceStore';

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

/**
 * RC-E2-001 — the safe baseline for a freshly (re)selected concrete scope:
 * every channel and the privileged section start empty/ok, never carrying
 * over a prior scope's rows. Used both for the hook's initial state and to
 * fail closed immediately on every scope-identity change, before the new
 * scope's own read has had a chance to resolve.
 */
function neutralScopedView(scope: ActiveSyncScope, nowMs: number, isOnline: boolean): SyncCenterView {
  return {
    status: 'scoped',
    aggregate: buildSyncCenterAggregate(
      {
        scope,
        reversal: { ok: true, rows: [] },
        voidIntent: { ok: true, rows: [] },
        shiftClose: { ok: true, rows: [] },
        shiftOpen: { ok: true, rows: [] },
        saleIntent: { ok: true, rows: [] },
        privilegedEvidence: { ok: true, rows: [] },
        orchestrator: {
          lastCycle: null,
          webLocksAvailable: true,
          ch4AttemptExhaustedIds: [],
        },
        isOnline,
      },
      nowMs,
    ),
  };
}

/**
 * RC-E2-001 — the fail-closed view for a live, still-current scope whose
 * read attempt itself failed outright (rejected), as opposed to a per-channel
 * isolation failure already handled inside `readSyncCenterSources`. Every
 * channel and the privileged section report unavailable, never a stale
 * previous-scope row and never a false-clean empty state.
 */
function unavailableScopedView(scope: ActiveSyncScope, nowMs: number, isOnline: boolean): SyncCenterView {
  return {
    status: 'scoped',
    aggregate: buildSyncCenterAggregate(
      {
        scope,
        reversal: { ok: false, reason: 'read_failed' },
        voidIntent: { ok: false, reason: 'read_failed' },
        shiftClose: { ok: false, reason: 'read_failed' },
        shiftOpen: { ok: false, reason: 'read_failed' },
        saleIntent: { ok: false, reason: 'read_failed' },
        privilegedEvidence: { ok: false, reason: 'read_failed' },
        orchestrator: {
          lastCycle: null,
          webLocksAvailable: false,
          ch4AttemptExhaustedIds: [],
        },
        isOnline,
      },
      nowMs,
    ),
  };
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
      ? neutralScopedView(resolved.scope, nowFn(), navOnline())
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
  const actorRef = useRef(actor);
  const storeRef = useRef<ReversalLocalStore>(opts?.reversalStore ?? createIndexedDbReversalStore());
  const ctxRef = useRef<SyncOrchestratorAuthContext>({ session, branchId, firebaseUser });
  const mountedGenerationRef = useRef(false);

  // RC-E2-001 — monotonic scope/read generation fence. `generationRef` /
  // `scopeKeyRef` / `scopeRef` / `branchChangedAtMsRef` are the sole
  // authoritative record of the last COMMITTED scope identity, and are
  // written ONLY from this committed effect below — never from the render
  // body itself. A render React discards without committing (Strict Mode's
  // dev double-invoke, an abandoned speculative/concurrent render, a
  // bailed-out re-render for a hypothetical future scope) never runs this
  // effect, so it can never corrupt the fence a still-committed scope's
  // in-flight read relies on to decide whether its own result is stale (see
  // `runRead` below) — abandoned speculative work for one scope can never
  // invalidate or redirect a still-committed different scope's reads. The
  // render body itself never mutates these refs and never calls
  // `setView`/`setStatus` — see the pure fail-closed mask below instead.
  const generationRef = useRef(0);
  const scopeKeyRef = useRef(scopeKey);

  useEffect(() => {
    if (mountedGenerationRef.current) {
      generationRef.current += 1;
    } else {
      mountedGenerationRef.current = true;
    }
    scopeKeyRef.current = scopeKey;
    scopeRef.current = scope;
    if (scope?.branchId !== lastBranchRef.current) {
      lastBranchRef.current = scope?.branchId ?? null;
      branchChangedAtMsRef.current = nowFn();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => {
    actorRef.current = actor;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor.role]);

  useEffect(() => {
    ctxRef.current = { session, branchId, firebaseUser };
  }, [session, branchId, firebaseUser]);

  useEffect(() => {
    if (opts?.reversalStore) storeRef.current = opts.reversalStore;
  }, [opts?.reversalStore]);

  // RC-E2-001 — pure, render-derived fail-closed mask. Reads only; never
  // mutates a ref and never calls setState. Compares this render's live
  // scope resolution against the scope the currently-committed `view` state
  // was actually built for, and substitutes a neutral/unavailable view and
  // 'pending'/'ready' status whenever they diverge — covering the gap
  // between a scope-changing render and the committed effect above (and the
  // read it kicks off) catching up, with no dependency on effect timing.
  const viewScopeKey =
    view.status === 'scoped' ? `${view.aggregate.scopeBranchId}::${view.aggregate.scopeDeviceId}` : null;
  const scopeIsCurrent = resolved.ok
    ? viewScopeKey === scopeKey
    : view.status === 'scope_unavailable' && view.reason === resolved.reason;
  const maskedView: SyncCenterView = scopeIsCurrent
    ? view
    : resolved.ok
      ? neutralScopedView(resolved.scope, nowFn(), navOnline())
      : { status: 'scope_unavailable', reason: resolved.reason };
  const maskedStatus: SyncCenterHookStatus = scopeIsCurrent ? status : resolved.ok ? 'pending' : 'ready';

  const applyView = useCallback((next: SyncCenterView, nowMs: number) => {
    if (cancelledRef.current) return;
    setView(attachRowActions(next, actorRef.current, scopeRef.current, nowMs));
  }, []);

  const runRead = useCallback(async () => {
    if (!scopeRef.current) {
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
        // RC-E2-001 — re-obtain the live scope on every iteration (including
        // a rerun triggered by a scope switch that arrived while the
        // previous iteration was in flight). Never reuse a scope captured
        // before an earlier await.
        const current = scopeRef.current;
        if (!current) {
          const resolution = resolveActiveSyncScope(ctxRef.current.branchId, getDeviceId());
          applyView(
            { status: 'scope_unavailable', reason: resolution.ok ? 'no_branch' : resolution.reason },
            nowFn(),
          );
          setStatus('ready');
          break;
        }
        const readGeneration = generationRef.current;
        const readScopeKey = `${current.branchId}::${current.deviceId}`;
        try {
          const read = optsRef.current?.read ?? readSyncCenterSources;
          const raw = await read(current, {
            ...optsRef.current?.readerDeps,
            isOnline: navOnline(),
          });
          if (cancelledRef.current) return;
          const stillCurrent =
            readGeneration === generationRef.current && readScopeKey === scopeKeyRef.current;
          if (!stillCurrent) {
            // Stale: the scope changed while this read was in flight. Full
            // no-op — the next loop iteration (or the switch's own runRead
            // call) picks up the live scope instead.
            continue;
          }
          const scoped = stripStaleCycle(raw, branchChangedAtMsRef.current);
          const nowMs = nowFn();
          applyView({ status: 'scoped', aggregate: buildSyncCenterAggregate(scoped, nowMs) }, nowMs);
          setStatus('ready');
        } catch {
          if (cancelledRef.current) return;
          const stillCurrent =
            readGeneration === generationRef.current && readScopeKey === scopeKeyRef.current;
          if (!stillCurrent) continue;
          // The read itself failed outright (not a per-channel isolation
          // failure) — fail closed rather than leaving a stale prior view.
          const nowMs = nowFn();
          applyView(unavailableScopedView(current, nowMs, navOnline()), nowMs);
          setStatus('ready');
        }
      } while (rerunRef.current && !cancelledRef.current);
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
    const unsubPrivileged = subscribePrivilegedEvidenceStore(() => {
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
      unsubPrivileged();
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
    view: maskedView,
    status: maskedStatus,
    refresh,
    isBusy,
    isOnline,
    scope,
    actor,
    retryItem,
    resweep,
  };
}
