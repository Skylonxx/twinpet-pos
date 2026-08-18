import { useEffect, useMemo, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../firebase';
import { shouldStartExceptionsQuery } from './adminGate';
import {
  mapExceptionRow,
  mapV9FaultRow,
  mergeExceptionRows,
  V9_FAULT_LIMIT,
  V9_SCOPED_FANOUT_CAP,
  type ReconExceptionRow,
} from './exceptionRows';

export type ExceptionsState = {
  rows: ReconExceptionRow[];
  loading: boolean;
  error: string | null;
  fromCache: boolean;
  overCap: boolean;
  atLimit: boolean;
  scopedListenerCount: number;
};

type ListenerSlice = {
  ready: boolean;
  fromCache: boolean;
  error: string | null;
  rows: ReconExceptionRow[];
  atLimit: boolean;
};

type StoredSlices = {
  key: string;
  slices: Record<string, ListenerSlice>;
};

function accessibleBranches(branchIds: readonly string[] | null | undefined): {
  global: boolean;
  scoped: string[];
  overCap: boolean;
} {
  const ids = [...(branchIds ?? [])].filter((id) => typeof id === 'string' && id.length > 0);
  if (ids.includes('ALL')) return { global: true, scoped: [], overCap: false };
  const unique = [...new Set(ids)];
  if (unique.length > V9_SCOPED_FANOUT_CAP) {
    return { global: false, scoped: unique.slice(0, V9_SCOPED_FANOUT_CAP), overCap: true };
  }
  return { global: false, scoped: unique, overCap: false };
}

function emptySlice(): ListenerSlice {
  return { ready: false, fromCache: false, error: null, rows: [], atLimit: false };
}

function requestKey(enabled: boolean, access: { global: boolean; scoped: string[]; overCap: boolean }): string {
  if (!enabled) return 'off';
  if (access.global) return 'on|ALL';
  return `on|${access.scoped.join('\u001f')}|${access.overCap ? 'cap' : 'ok'}`;
}

function idleState(overCap: boolean, scopedListenerCount: number): ExceptionsState {
  return {
    rows: [],
    loading: false,
    error: null,
    fromCache: false,
    overCap,
    atLimit: false,
    scopedListenerCount,
  };
}

function aggregateState(
  slices: Record<string, ListenerSlice>,
  access: { global: boolean; scoped: string[]; overCap: boolean },
  branchIds: readonly string[] | null | undefined,
): ExceptionsState {
  const exception = slices.exception ?? emptySlice();
  const v9Ids = access.global ? ['v9:global'] : access.scoped.map((id) => `v9:${id}`);
  const v9Slices =
    !access.global && access.scoped.length === 0
      ? [{ ...emptySlice(), ready: true }]
      : v9Ids.map((id) => slices[id] ?? emptySlice());
  const required = [exception, ...v9Slices];
  const loading = required.some((s) => !s.ready);
  const error = required.map((s) => s.error).find((e): e is string => e != null && e !== '') ?? null;
  const fromCache = required.some((s) => s.ready && s.fromCache);
  const atLimit = v9Slices.some((s) => s.atLimit);
  const v9Rows = v9Slices.flatMap((s) => s.rows);
  const merged = mergeExceptionRows(exception.rows, v9Rows).filter((row) => {
    if (access.global) return true;
    return access.scoped.includes(row.branchId) || (branchIds ?? []).includes(row.branchId);
  });
  return {
    rows: merged,
    loading,
    error,
    fromCache,
    overCap: access.overCap,
    atLimit,
    scopedListenerCount: access.global ? 1 : access.scoped.length,
  };
}

/**
 * Live, read-only subscriptions:
 *  - existing exception queue (`reconcileStatus == 'exception'`)
 *  - V9 revision-fault queue (value-blind `voidRevisionFaultAt` order + limit)
 *
 * SECURITY: `enabled` is the admin-derived gate. When false, NO Firestore
 * subscription starts. This hook NEVER writes asyncOrders / reconcileStatus.
 *
 * Aggregate readiness/cache/error is derived from per-listener current state.
 * Loading cannot finish until every active listener is ready. A later success
 * from listener B cannot clear listener A's error.
 */
export function useReconciliationExceptions(
  enabled: boolean,
  branchIds?: readonly string[] | null,
): ExceptionsState {
  const branchKey = (branchIds ?? []).join('\0');
  const access = useMemo(
    () => accessibleBranches(branchKey === '' ? [] : branchKey.split('\0')),
    [branchKey],
  );
  const key = requestKey(enabled, access);
  const [stored, setStored] = useState<StoredSlices>(() => ({ key, slices: {} }));

  useEffect(() => {
    if (!shouldStartExceptionsQuery(enabled, isFirebaseConfigured, !!db)) {
      setStored({ key, slices: {} });
      return;
    }

    const unsubs: Array<() => void> = [];
    let slices: Record<string, ListenerSlice> = {};

    const publish = (next: Record<string, ListenerSlice>) => {
      slices = next;
      setStored({ key, slices: { ...next } });
    };

    const patch = (id: string, update: Partial<ListenerSlice>) => {
      const prev = slices[id] ?? emptySlice();
      publish({ ...slices, [id]: { ...prev, ...update } });
    };

    const exceptionQuery = query(collection(db!, 'asyncOrders'), where('reconcileStatus', '==', 'exception'));
    unsubs.push(
      onSnapshot(
        exceptionQuery,
        { includeMetadataChanges: true },
        (snap) => {
          patch('exception', {
            ready: true,
            fromCache: snap.metadata.fromCache === true,
            error: null,
            rows: snap.docs.map((d) => mapExceptionRow(d.id, d.data() as Record<string, unknown>)),
            atLimit: false,
          });
        },
        (err) => {
          patch('exception', {
            ready: true,
            fromCache: false,
            error: err instanceof Error ? err.message : String(err),
            rows: [],
            atLimit: false,
          });
        },
      ),
    );

    const v9Base = collection(db!, 'asyncOrders');
    if (access.global) {
      const q = query(v9Base, orderBy('voidRevisionFaultAt', 'desc'), limit(V9_FAULT_LIMIT));
      unsubs.push(
        onSnapshot(
          q,
          { includeMetadataChanges: true },
          (snap) => {
            patch('v9:global', {
              ready: true,
              fromCache: snap.metadata.fromCache === true,
              error: null,
              rows: snap.docs
                .map((d) => mapV9FaultRow(d.id, d.data() as Record<string, unknown>))
                .filter((r): r is ReconExceptionRow => r != null),
              atLimit: snap.docs.length === V9_FAULT_LIMIT,
            });
          },
          (err) => {
            patch('v9:global', {
              ready: true,
              fromCache: false,
              error: err instanceof Error ? err.message : String(err),
              rows: [],
              atLimit: false,
            });
          },
        ),
      );
    } else {
      for (const branchId of access.scoped) {
        const q = query(
          v9Base,
          where('branchId', '==', branchId),
          orderBy('voidRevisionFaultAt', 'desc'),
          limit(V9_FAULT_LIMIT),
        );
        unsubs.push(
          onSnapshot(
            q,
            { includeMetadataChanges: true },
            (snap) => {
              patch(`v9:${branchId}`, {
                ready: true,
                fromCache: snap.metadata.fromCache === true,
                error: null,
                rows: snap.docs
                  .map((d) => mapV9FaultRow(d.id, d.data() as Record<string, unknown>))
                  .filter((r): r is ReconExceptionRow => r != null),
                atLimit: snap.docs.length === V9_FAULT_LIMIT,
              });
            },
            (err) => {
              patch(`v9:${branchId}`, {
                ready: true,
                fromCache: false,
                error: err instanceof Error ? err.message : String(err),
                rows: [],
                atLimit: false,
              });
            },
          ),
        );
      }
    }

    return () => {
      for (const u of unsubs) u();
    };
  }, [enabled, key, access]);

  if (!shouldStartExceptionsQuery(enabled, isFirebaseConfigured, !!db)) {
    return idleState(false, 0);
  }

  const slices = stored.key === key ? stored.slices : {};
  return aggregateState(slices, access, branchIds);
}
