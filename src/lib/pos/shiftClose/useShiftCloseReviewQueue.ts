import { useState, useEffect } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../../firebase';
import { shouldStartShiftCloseReviewQuery } from './shiftCloseReviewGate';
import {
  filterActionableRows,
  filterMalformedRows,
  mapShiftCloseReviewRow,
  sortShiftCloseReviewRows,
  type ShiftCloseReviewRow,
} from './shiftCloseReviewRows';

export type ShiftCloseReviewErrorKind = 'permission-denied' | 'generic' | null;

/**
 * RC-1: an explicit discriminant so "no snapshot has arrived yet" can never be
 * mistaken for "the server confirmed zero rows".
 * - `disabled` — the gate is false; no subscription is (or will be) active.
 * - `pending`  — the gate is true but no snapshot/error callback has fired yet.
 *                MUST render as loading — never as a confirmed-empty result.
 * - `ready`    — a snapshot callback delivered rows (cache or server-confirmed).
 * - `error`    — the snapshot's error callback fired.
 */
export type ShiftCloseReviewQueueStatus = 'disabled' | 'pending' | 'ready' | 'error';

export type ShiftCloseReviewQueueState = {
  status: ShiftCloseReviewQueueStatus;
  /** All rows from the unfiltered branch-scoped snapshot, sorted. */
  rows: ShiftCloseReviewRow[];
  /** `rows` narrowed to the default `{ open, acknowledged }` filter. */
  actionableRows: ShiftCloseReviewRow[];
  /**
   * RC-2 (R2 remediation): rows with an unrecognized `alertState` OR a
   * present-but-unrecognized `reasonCode` — never silently dropped, and the
   * page must never render a clean-success state while this is non-empty.
   */
  malformedRows: ShiftCloseReviewRow[];
  /** Unfiltered count — the "จากทั้งหมด [N] รายการ" figure. */
  totalCount: number;
  /** Convenience alias for `status === 'pending'`. */
  loading: boolean;
  error: ShiftCloseReviewErrorKind;
  /** True when the current snapshot came from local cache (not confirmed by the server). */
  fromCache: boolean;
  /** Local wall-clock time (ms) the current snapshot was RECEIVED — see `ShiftCloseReviewPage`'s honest labeling of this value (it is not a data-freshness timestamp). */
  lastSnapshotAtMs: number | null;
};

function makeInitialState(enabled: boolean): ShiftCloseReviewQueueState {
  return {
    status: enabled ? 'pending' : 'disabled',
    rows: [],
    actionableRows: [],
    malformedRows: [],
    totalCount: 0,
    loading: enabled,
    error: null,
    fromCache: false,
    lastSnapshotAtMs: null,
  };
}

/**
 * Live, read-only subscription to `shiftCloseAlerts` for the active branch
 * (UI-A, Packet 5). EQUALITY-ONLY query (single `where`, no `orderBy`) →
 * mirrors the frozen firestore.rules branch-scoped read grant and needs no
 * composite index. Display ordering is done in-memory (`sortShiftCloseReviewRows`).
 *
 * SECURITY: `role`/`branchId` feed `shouldStartShiftCloseReviewQuery` (the
 * gate). When the gate is false, the effect never subscribes — this hook
 * never writes.
 *
 * RC-1/RC-4: state resets for a gate/branch change are done DURING RENDER
 * (React's documented "adjusting state when a prop changes" pattern), not via
 * a synchronous `setState` inside the effect body — this both (a) guarantees
 * an eligible query starts life as `pending` from its very first paint,
 * closing the pre-snapshot "looks server-confirmed-empty" gap, and (b) avoids
 * the `react-hooks/set-state-in-effect` violation the previous revision had.
 * The effect itself only calls `setState` from the async `onSnapshot`
 * next/error callbacks, which is the standard, lint-clean subscription shape.
 */
export function useShiftCloseReviewQueue(
  role: string | null | undefined,
  branchId: string | null | undefined,
): ShiftCloseReviewQueueState {
  const enabled = shouldStartShiftCloseReviewQuery(role, isFirebaseConfigured, !!db, branchId);
  // Mirrors the effect's own dependency array below — a reset must fire in the
  // exact same render as any change that will cause the effect to (re)run.
  const resetKey = `${enabled ? '1' : '0'}::${branchId ?? ''}`;

  const [state, setState] = useState<ShiftCloseReviewQueueState>(() => makeInitialState(enabled));
  const [trackedResetKey, setTrackedResetKey] = useState(resetKey);

  if (resetKey !== trackedResetKey) {
    setTrackedResetKey(resetKey);
    setState(makeInitialState(enabled));
  }

  useEffect(() => {
    if (!enabled) return;

    const q = query(collection(db!, 'shiftCloseAlerts'), where('branchId', '==', branchId));
    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        const allRows = sortShiftCloseReviewRows(
          snap.docs.map((d) => mapShiftCloseReviewRow(d.id, d.data() as Record<string, unknown>)),
        );
        setState({
          status: 'ready',
          rows: allRows,
          actionableRows: filterActionableRows(allRows),
          malformedRows: filterMalformedRows(allRows),
          totalCount: allRows.length,
          loading: false,
          error: null,
          fromCache: snap.metadata.fromCache,
          lastSnapshotAtMs: Date.now(),
        });
      },
      (err) => {
        const code = (err as { code?: string }).code;
        setState({
          status: 'error',
          rows: [],
          actionableRows: [],
          malformedRows: [],
          totalCount: 0,
          loading: false,
          error: code === 'permission-denied' ? 'permission-denied' : 'generic',
          fromCache: false,
          lastSnapshotAtMs: null,
        });
      },
    );

    return unsubscribe;
  }, [enabled, branchId]);

  return state;
}
